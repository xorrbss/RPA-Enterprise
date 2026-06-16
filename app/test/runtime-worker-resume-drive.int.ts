/**
 * runtime-worker resume-drive 통합 (A.1 resume step4b). 실 PostgreSQL.
 *
 * handleRunResume 이 browserSessionProvider 주입 시 resume_requested run 을 R17→restore→R18(→running) 후
 * driveResumedRun 으로 resumeNodeId 부터 재진입해 completed 까지 가는지 검증한다. test_fake BrowserSessionProvider
 * (무-Chrome)로 실 UtilityExecutor + SitePageStateResolver 를 빌드 → preamble→step2→done 시나리오를 resumeNodeId=
 * "step2" 로 재진입(preamble 건너뜀: gotoCalls===1). provider 미주입 시 R18(running)까지만(Phase C 게이트 off — 회귀).
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/runtime-worker-resume-drive.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CorrelationId, RunId, TenantId } from "../../ts/security-middleware-contract";
import type { ResumeTokenEnvelope, SessionRestoreResult, SessionRestorer } from "../../ts/runtime-contract";
import { compileScenario } from "../src/api/compile-pipeline";
import { createPool, withTenantTx } from "../src/db/pool";
import { FakeCdpSession, TestFakeBrowserSessionProvider } from "../src/executor/browser-session-provider";
import { PgRuntimeWorker, type BrowserLeasePlanResolver } from "../src/worker/runtime-worker";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_runtime_resume_drive_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKER = "9b000000-0000-0000-0000-0000000000a1";
const SITE = "40000000-0000-0000-0000-0000000000f1";
const IDENTITY = "40000000-0000-0000-0000-0000000000f2";
const NETWORK_POLICY = "40000000-0000-0000-0000-0000000000f3";
// 회귀 run(미구동)은 별도 site/identity — drive run 의 lease 와 충돌(SESSION_LOCKED) 방지.
const SITE2 = "40000000-0000-0000-0000-0000000000f4";
const IDENTITY2 = "40000000-0000-0000-0000-0000000000f5";
const SCEN = "70000000-0000-0000-0000-0000000000f1";
const SVER = "70000000-0000-0000-0000-0000000000f2";
const RUN_DRIVE = "71000000-0000-0000-0000-0000000000f1";
const RUN_NODRIVE = "71000000-0000-0000-0000-0000000000f2";
const CORRELATION = "20000000-0000-0000-0000-0000000000f1";
// resume 재진입 노드 — scenario.start("preamble")가 아닌 중간 노드. driveResumedRun 이 startNode 로 사용.
const RESUME_NODE = "step2";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const planResolver: BrowserLeasePlanResolver = async (_client, input) =>
  input.runId === RUN_NODRIVE
    ? { siteProfileId: SITE2, browserIdentityId: IDENTITY2, networkPolicyId: NETWORK_POLICY }
    : { siteProfileId: SITE, browserIdentityId: IDENTITY, networkPolicyId: NETWORK_POLICY };

// preamble → step2 → done(success). 모두 navigate(on[]/observe 없음 → FakeCdpSession no-op goto 로 충분).
// resumeNodeId="step2" 면 preamble 을 건너뛰고 step2→done 만 실행(goto 1회).
const scenarioIr = {
  meta: { name: "resume-drive-test", version: 1 },
  start: "preamble",
  nodes: {
    preamble: { what: [{ action: "navigate", url_ref: "pre_url" }], next: "step2" },
    step2: { what: [{ action: "navigate", url_ref: "step2_url" }], next: "done" },
    done: { terminal: "success" },
  },
};

function token(runId: string, pageStateRef: string, resumeNodeId: string): ResumeTokenEnvelope {
  return {
    runId: runId as RunId,
    resumeNodeId,
    pageStateRef,
    issuedAt: "2026-06-15T00:00:00.000Z" as ResumeTokenEnvelope["issuedAt"],
    expiresAt: "2026-06-16T00:00:00.000Z" as ResumeTokenEnvelope["expiresAt"],
    kid: "kms://tenant-a/resume-token-key",
    hmac: "signed-envelope-hmac",
  };
}

// restore 는 항상 성공(pageStateRef 일치) → restore_ok → R18(→running). HMAC 검증은 codec/restorer 책임(여기선 무관).
const restorer: SessionRestorer = {
  async restoreSession(input): Promise<SessionRestoreResult> {
    return { kind: "restored", pageStateRef: input.expectedPageStateRef };
  },
};

async function runStatus(pool: ReturnType<typeof createPool>, runId: string): Promise<string | null> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [runId]);
    return r.rows[0]?.status ?? null;
  });
}

async function eventCount(pool: ReturnType<typeof createPool>, runId: string, eventType: string): Promise<number> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events_outbox WHERE run_id=$1::uuid AND event_type=$2`,
      [runId, eventType],
    );
    return r.rows[0]?.n ?? -1;
  });
}

async function seedRun(pool: ReturnType<typeof createPool>, runId: string): Promise<void> {
  await withTenantTx(pool, TENANT, async (c) => {
    await c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, resume_token, correlation_id, params)
       VALUES ($1,$2,$3,'resume_requested',$4::jsonb,$5,
               '{"pre_url":"https://ok.example/pre","step2_url":"https://ok.example/step2"}'::jsonb)`,
      [runId, TENANT, SVER, JSON.stringify(token(runId, "page-state://resume-drive", RESUME_NODE)), CORRELATION],
    );
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
      await setup.query(
        `INSERT INTO workers (id, kind, status, circuit_state) VALUES ($1::uuid,'browser','active','closed')`,
        [WORKER],
      );
    } finally {
      setup.release();
    }

    const compiled = compileScenario(scenarioIr, {});
    check("scenario compiles (ajv→IREL→V1–V11)", compiled.ok, compiled.ok ? "" : JSON.stringify(compiled.details));
    if (!compiled.ok) throw new Error("scenario did not compile");

    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(
        `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, page_state_selectors)
         VALUES ($1,$2,'ok','https://ok.example/*','green',true,'{"flags":{}}'::jsonb),
                ($3,$2,'ok2','https://ok2.example/*','green',true,'{"flags":{}}'::jsonb)`,
        [SITE, TENANT, SITE2],
      );
      await c.query(
        `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label)
         VALUES ($1,$2,$3,'ok'), ($4,$2,$5,'ok2')`,
        [IDENTITY, TENANT, SITE, IDENTITY2, SITE2],
      );
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'resume-drive')`, [SCEN, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [SVER, TENANT, SCEN, JSON.stringify(compiled.ir), compiled.compiledAst],
      );
    });
    await seedRun(pool, RUN_DRIVE);
    await seedRun(pool, RUN_NODRIVE);

    // 1) provider 주입 → resume R17→restore→R18 후 driveResumedRun(resumeNodeId="step2")로 completed.
    let driveSession: FakeCdpSession | null = null;
    const sessionProvider = new TestFakeBrowserSessionProvider({
      makeSession: (downloadDir) => {
        driveSession = new FakeCdpSession(downloadDir);
        return driveSession;
      },
    });
    const driving = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      browserSessionProvider: sessionProvider,
      allowTestBrowserSessionProvider: true,
      sessionRestorer: restorer,
    });
    const driven = await driving.handle({
      kind: "run_resume",
      tenantId: TENANT as TenantId,
      runId: RUN_DRIVE as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_resume+drive → job completed", driven.kind === "completed", JSON.stringify(driven));
    check("DB runs.status = completed (resumeNodeId 부터 재진입 구동)", (await runStatus(pool, RUN_DRIVE)) === "completed", String(await runStatus(pool, RUN_DRIVE)));
    check("run.resumed 발행(R18)", (await eventCount(pool, RUN_DRIVE, "run.resumed")) === 1);
    check("run.completed 발행(R21)", (await eventCount(pool, RUN_DRIVE, "run.completed")) === 1);
    check(
      "resume 재진입이 preamble 건너뜀(gotoCalls===1: step2 만 navigate)",
      driveSession !== null && (driveSession as FakeCdpSession).gotoCalls === 1,
      `gotoCalls=${driveSession === null ? "no-session" : (driveSession as FakeCdpSession).gotoCalls}`,
    );
    check("세션 release(close) 호출됨", driveSession !== null && (driveSession as FakeCdpSession).closeCalls === 1, `closeCalls=${driveSession === null ? "no-session" : (driveSession as FakeCdpSession).closeCalls}`);

    // 2) provider 미주입 → R18(running)까지만(Phase C 게이트 off — 회귀: 기존 동작 보존, 구동 안 함).
    const resumeOnly = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      sessionRestorer: restorer,
    });
    const resumed = await resumeOnly.handle({
      kind: "run_resume",
      tenantId: TENANT as TenantId,
      runId: RUN_NODRIVE as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_resume (provider 미주입) → job completed", resumed.kind === "completed", JSON.stringify(resumed));
    check("DB runs.status = running (미구동, 기존 동작)", (await runStatus(pool, RUN_NODRIVE)) === "running", String(await runStatus(pool, RUN_NODRIVE)));
    check("미구동 → run.completed 없음", (await eventCount(pool, RUN_NODRIVE, "run.completed")) === 0);
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: runtime-worker resume-drive — resume_requested→(R17→restore→R18)→driveResumedRun→completed (A.1 resume step4b)");
  process.exit(0);
}

main().catch((e) => {
  console.error("runtime-worker-resume-drive int fatal:", e);
  process.exit(1);
});
