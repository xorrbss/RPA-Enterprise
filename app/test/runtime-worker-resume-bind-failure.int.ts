/**
 * runtime-worker resume Phase C INIT 실패 하드닝 (하드닝 #5/#6). 실 PostgreSQL.
 *
 * resume 는 R18(resuming→running) 후 Phase C 에서 siteConfig 적재 + session bind 로 executor 를 구성한다. 종전엔
 * 이 bind 가 try 밖이라, bind throw 시 run 이 'running'(R18)에 영구 좌초했다(claim Phase B 는 handleClaimedInitFailure
 * 로 보호하나 resume 엔 대응 없음 — #5). 또 resume INIT 는 worker-circuit 성공/실패를 기록하지 않았다(claim 과 비대칭 — #6).
 * 수정: Phase C INIT 를 try/catch 로 감싸 bind 실패 시 terminalizeStuckRunAsSystemFailure(R8: running→failed_system)로
 * 종결 + 세션 해제 + recordWorkerInitFailure(claim 과 대칭). 성공 시 recordWorkerInitSuccess.
 *
 * 실행: node scripts/db-temp-postgres-gate.mjs -- npx tsx app/test/runtime-worker-resume-bind-failure.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CorrelationId, RunId, TenantId } from "../../ts/security-middleware-contract";
import type { ResumeTokenEnvelope, SessionRestoreResult, SessionRestorer } from "../../ts/runtime-contract";
import type { BrowserSessionProvider } from "../src/executor/browser-session-provider";
import { compileScenario } from "../src/api/compile-pipeline";
import { createPool, withTenantTx } from "../src/db/pool";
import { PgRuntimeWorker, type BrowserLeasePlanResolver } from "../src/worker/runtime-worker";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_runtime_resume_bindfail_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKER = "9c000000-0000-0000-0000-0000000000c1";
const SITE = "40000000-0000-0000-0000-000000000f01";
const IDENTITY = "40000000-0000-0000-0000-000000000f02";
const NETWORK_POLICY = "40000000-0000-0000-0000-000000000f03";
const SCEN = "70000000-0000-0000-0000-000000000f01";
const SVER = "70000000-0000-0000-0000-000000000f02";
const RUN_BF = "71000000-0000-0000-0000-000000000f01";
const CORRELATION = "20000000-0000-0000-0000-000000000f01";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

const planResolver: BrowserLeasePlanResolver = async () => ({ siteProfileId: SITE, browserIdentityId: IDENTITY, networkPolicyId: NETWORK_POLICY });
const restorer: SessionRestorer = {
  async restoreSession(input): Promise<SessionRestoreResult> {
    return { kind: "restored", pageStateRef: input.expectedPageStateRef };
  },
};
// bind 가 throw 하는 test_fake provider — resume Phase C INIT 실패 모사.
const throwingBindProvider: BrowserSessionProvider = {
  binding: { kind: "test_fake" } as const,
  async bind() {
    throw new Error("simulated session bind failure (resume Phase C INIT)");
  },
};

function token(runId: string): ResumeTokenEnvelope {
  return {
    runId: runId as RunId,
    resumeNodeId: "open",
    pageStateRef: "page-state://bindfail",
    issuedAt: "2026-06-16T00:00:00.000Z" as ResumeTokenEnvelope["issuedAt"],
    expiresAt: "2026-06-17T00:00:00.000Z" as ResumeTokenEnvelope["expiresAt"],
    kid: "kms://tenant-a/resume-token-key",
    hmac: "signed-envelope-hmac",
  };
}

const scenarioIr = {
  meta: { name: "resume-bindfail-test", version: 1 },
  start: "open",
  nodes: { open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "done" }, done: { terminal: "success" } },
};

async function runStatus(pool: ReturnType<typeof createPool>, runId: string): Promise<string | null> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [runId]);
    return r.rows[0]?.status ?? null;
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
      await setup.query(`INSERT INTO workers (id, kind, status, circuit_state) VALUES ($1::uuid,'browser','active','closed')`, [WORKER]);
    } finally {
      setup.release();
    }

    const compiled = compileScenario(scenarioIr, {});
    if (!compiled.ok) throw new Error("scenario did not compile");

    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(
        `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, page_state_selectors)
         VALUES ($1,$2,'ok','https://ok.example/*','green',true,'{"flags":{}}'::jsonb)`,
        [SITE, TENANT],
      );
      await c.query(`INSERT INTO browser_identities (id, tenant_id, site_profile_id, label) VALUES ($1,$2,$3,'ok')`, [IDENTITY, TENANT, SITE]);
      await c.query(`INSERT INTO network_policies (id, tenant_id, allowed_domains) VALUES ($1,$2,ARRAY['ok.example'])`, [NETWORK_POLICY, TENANT]);
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'bindfail')`, [SCEN, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [SVER, TENANT, SCEN, JSON.stringify(compiled.ir), compiled.compiledAst],
      );
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, resume_token, params)
         VALUES ($1,$2,$3,'resume_requested',$4,$5::jsonb,'{"entry_url":"https://ok.example/landing"}'::jsonb)`,
        [RUN_BF, TENANT, SVER, CORRELATION, JSON.stringify(token(RUN_BF))],
      );
    });

    const worker = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      browserSessionProvider: throwingBindProvider,
      allowTestBrowserSessionProvider: true,
      sessionRestorer: restorer,
    });

    // run_resume → R17→restore→R18(running) → Phase C bind throw → terminalize R8(running→failed_system).
    const err = await caught(worker.handle({ kind: "run_resume", tenantId: TENANT as TenantId, runId: RUN_BF as RunId, correlationId: CORRELATION as CorrelationId }));
    check("resume bind 실패 → 폴백이 throw 흡수(job 정상 종료)", err === undefined, String(err));
    check(
      "resume bind 실패 → run failed_system 종결(running 좌초=좀비 아님, #5)",
      (await runStatus(pool, RUN_BF)) === "failed_system",
      String(await runStatus(pool, RUN_BF)),
    );
    // #6: resume INIT 실패가 worker-circuit 에 per-worker 기록됨(claim 과 대칭).
    const wc = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ consecutive_init_failures: number }>(`SELECT consecutive_init_failures FROM workers WHERE id=$1::uuid`, [WORKER]);
      return r.rows[0]?.consecutive_init_failures ?? -1;
    });
    check("resume INIT 실패 → worker-circuit consecutive_init_failures 증가 (#6)", wc === 1, `consecutive_init_failures=${wc}`);
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: runtime-worker resume bind-failure — Phase C INIT 실패 시 R8 종결 + worker-circuit 기록 (#5/#6)");
  process.exit(0);
}

main().catch((e) => {
  console.error("runtime-worker-resume-bind-failure int fatal:", e);
  process.exit(1);
});
