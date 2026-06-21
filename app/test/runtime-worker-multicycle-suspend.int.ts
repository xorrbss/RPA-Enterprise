/**
 * runtime-worker 다중-사이클 suspend/resume 멱등키 회귀 (하드닝 #2/#3). 실 PostgreSQL.
 *
 * run 이 suspend→resume→(다른 노드)suspend→resume 를 코드로 반복할 때, R11(run.suspended)·R18/R19(run.resumed)
 * outbox 멱등키가 run 수명 동안 상수면 events_outbox UNIQUE(tenant_id, idempotency_key) 충돌로 두 번째 사이클의
 * tx 가 abort 돼 run 이 좌초한다(#2 suspending, #3 resuming). 수정: R11 은 R4/R5 와 동일하게 stepId:attempt 로,
 * resume(R17/완료)는 재개 대상 토큰 issuedAt(suspend 사이클당 1회 발행 = per-cycle 결정형)으로 스코프.
 *
 * stateful executor: 각 노드 첫 방문 → suspended(challenge), 재방문(resume 재진입) → success → 다음 노드 진행.
 * open(suspend#1) → resume → open 성공 → step2(suspend#2) → resume → step2 성공 → done(completed).
 * suspend 노드가 서로 달라(open vs step2) R4/R5 키는 자연히 구분 — 상수였던 R11/R18 키만 충돌했음을 격리 검증.
 *
 * 실행: node scripts/db-temp-postgres-gate.mjs -- npx tsx app/test/runtime-worker-multicycle-suspend.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CorrelationId, RunId, TenantId } from "../../ts/security-middleware-contract";
import type { ExecutorPlugin, PlainSecret, SecretRef, SecretStore } from "../../ts/core-types";
import type { SessionRestoreResult, SessionRestorer } from "../../ts/runtime-contract";
import { compileScenario } from "../src/api/compile-pipeline";
import { createPool, withTenantTx } from "../src/db/pool";
import { TestFakeBrowserSessionProvider } from "../src/executor/browser-session-provider";
import { PgChallengeSuspensionPort } from "../src/runtime/challenge-suspension-port";
import { HmacResumeTokenCodec } from "../src/runtime/resume-token-codec";
import { PgRuntimeWorker, type BrowserLeasePlanResolver } from "../src/worker/runtime-worker";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_runtime_multicycle_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKER = "9c000000-0000-0000-0000-0000000000b1";
const SITE = "40000000-0000-0000-0000-000000000e01";
const IDENTITY = "40000000-0000-0000-0000-000000000e02";
const NETWORK_POLICY = "40000000-0000-0000-0000-000000000e03";
const SCEN = "70000000-0000-0000-0000-000000000e01";
const SVER = "70000000-0000-0000-0000-000000000e02";
const RUN_MC = "71000000-0000-0000-0000-000000000e01";
const CORRELATION = "20000000-0000-0000-0000-000000000e01";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const planResolver: BrowserLeasePlanResolver = async () => ({
  siteProfileId: SITE,
  browserIdentityId: IDENTITY,
  networkPolicyId: NETWORK_POLICY,
});

// stateful: 노드 첫 방문 → suspended, 재방문 → success(다음 노드 진행).
const visited = new Set<string>();
const multiExecutor: ExecutorPlugin = {
  capabilities: () => ({ dom: false, vision: false, utility: true }),
  async execute(stepId) {
    const now = "2026-06-16T00:00:00.000Z";
    const base = {
      stepId,
      action: "navigate" as const,
      pageStateBefore: "ref",
      artifacts: [],
      cache: { mode: "bypass" as const },
      timings: { startedAt: now, endedAt: now, durationMs: 0 },
    };
    if (!visited.has(stepId)) {
      visited.add(stepId);
      return { ...base, status: "suspended", challenge: { type: "captcha", detectedBy: "dom", confidence: 1 }, pageStateAfter: `ps_suspend_${stepId}` };
    }
    return { ...base, status: "success", pageStateAfter: `ps_ok_${stepId}` };
  },
  async verify() {
    throw new Error("verify not used in multicycle int");
  },
};

const fakeSecretStore: SecretStore = {
  resolve: async () => JSON.stringify({ kid: "kid-test", key: "multicycle-signing-key" }) as unknown as PlainSecret,
};
const suspensionPort = new PgChallengeSuspensionPort();
const resumeTokenCodec = new HmacResumeTokenCodec(fakeSecretStore, "secret://test/resume_token_hmac" as unknown as SecretRef);
const restorer: SessionRestorer = {
  async restoreSession(input): Promise<SessionRestoreResult> {
    return { kind: "restored", pageStateRef: input.expectedPageStateRef };
  },
};

const scenarioIr = {
  meta: { name: "multicycle-suspend-test", version: 1 },
  start: "open",
  nodes: {
    open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "step2" },
    step2: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "done" },
    done: { terminal: "success" },
  },
};

async function runStatus(pool: ReturnType<typeof createPool>, runId: string): Promise<string | null> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [runId]);
    return r.rows[0]?.status ?? null;
  });
}

// 운영자 resume 모사: suspended → resume_requested (driveSuspend 가 저장한 현 resume_token 유지).
async function setResumeRequested(pool: ReturnType<typeof createPool>, runId: string): Promise<void> {
  await withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query(
      `UPDATE runs SET status='resume_requested', updated_at=now() WHERE id=$1::uuid AND status='suspended'`,
      [runId],
    );
    if (r.rowCount !== 1) throw new Error(`setResumeRequested: expected suspended run, affected ${r.rowCount ?? 0}`);
  });
}

async function eventTypes(pool: ReturnType<typeof createPool>): Promise<string[]> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ event_type: string }>(`SELECT event_type FROM events_outbox WHERE correlation_id=$1::uuid`, [CORRELATION]);
    return r.rows.map((x) => x.event_type);
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
    check("scenario compiles", compiled.ok, compiled.ok ? "" : JSON.stringify(compiled.details));
    if (!compiled.ok) throw new Error("scenario did not compile");

    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(
        `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, page_state_selectors)
         VALUES ($1,$2,'ok','https://ok.example/*','green',true,'{"flags":{}}'::jsonb)`,
        [SITE, TENANT],
      );
      await c.query(`INSERT INTO browser_identities (id, tenant_id, site_profile_id, label) VALUES ($1,$2,$3,'ok')`, [IDENTITY, TENANT, SITE]);
      await c.query(`INSERT INTO network_policies (id, tenant_id, allowed_domains) VALUES ($1,$2,ARRAY['ok.example'])`, [NETWORK_POLICY, TENANT]);
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'multicycle')`, [SCEN, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [SVER, TENANT, SCEN, JSON.stringify(compiled.ir), compiled.compiledAst],
      );
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, params)
         VALUES ($1,$2,$3,'queued',$4,'{"entry_url":"https://ok.example/landing"}'::jsonb)`,
        [RUN_MC, TENANT, SVER, CORRELATION],
      );
    });

    const worker = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      browserSessionProvider: new TestFakeBrowserSessionProvider(),
      allowTestBrowserSessionProvider: true,
      sessionRestorer: restorer,
      executorFactory: () => multiExecutor,
      suspensionPort,
      resumeTokenCodec,
    });

    // 사이클 1: claim → drive → open suspend.
    const c1 = await worker.handle({ kind: "run_claim", tenantId: TENANT as TenantId, runId: RUN_MC as RunId, correlationId: CORRELATION as CorrelationId });
    check("cycle1 claim → job completed", c1.kind === "completed", JSON.stringify(c1));
    check("cycle1 → run suspended (@open)", (await runStatus(pool, RUN_MC)) === "suspended", String(await runStatus(pool, RUN_MC)));

    // 사이클 2: resume → open 성공 → step2 suspend. (#2: 두 번째 R11 = 상수키였으면 충돌)
    await setResumeRequested(pool, RUN_MC);
    const c2 = await worker.handle({ kind: "run_resume", tenantId: TENANT as TenantId, runId: RUN_MC as RunId, correlationId: CORRELATION as CorrelationId });
    check("cycle2 resume → job completed", c2.kind === "completed", JSON.stringify(c2));
    check(
      "cycle2 → run suspended (@step2) — 두 번째 R11 멱등키 충돌 없음 (#2)",
      (await runStatus(pool, RUN_MC)) === "suspended",
      String(await runStatus(pool, RUN_MC)),
    );

    // 사이클 3: resume(2회차) → step2 성공 → done completed. (#3: 두 번째 R18 = 상수키였으면 충돌)
    await setResumeRequested(pool, RUN_MC);
    const c3 = await worker.handle({ kind: "run_resume", tenantId: TENANT as TenantId, runId: RUN_MC as RunId, correlationId: CORRELATION as CorrelationId });
    check("cycle3 resume → job completed", c3.kind === "completed", JSON.stringify(c3));
    check(
      "cycle3 → run completed — 두 번째 R18 멱등키 충돌 없음 (#3)",
      (await runStatus(pool, RUN_MC)) === "completed",
      String(await runStatus(pool, RUN_MC)),
    );

    // outbox: run.suspended 2건 + run.resumed 2건 (per-cycle 키라 모두 영속).
    const evs = await eventTypes(pool);
    const suspendedCount = evs.filter((e) => e === "run.suspended").length;
    const resumedCount = evs.filter((e) => e === "run.resumed").length;
    check("outbox: run.suspended 2건 (사이클별 고유키)", suspendedCount === 2, `count=${suspendedCount}: ${evs.join(",")}`);
    check("outbox: run.resumed 2건 (사이클별 고유키)", resumedCount === 2, `count=${resumedCount}: ${evs.join(",")}`);
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: runtime-worker multicycle suspend/resume — per-cycle 멱등키로 반복 suspend/resume 좌초 방지 (#2/#3)");
  process.exit(0);
}

main().catch((e) => {
  console.error("runtime-worker-multicycle-suspend int fatal:", e);
  process.exit(1);
});
