/**
 * runtime-worker 같은 노드 재suspend 멱등키 (하드닝 break-it 재검증 #3). 실 PostgreSQL.
 *
 * suspend→resume→**같은 노드** 재진입→재suspend 시, suspend-side outbox 키(R4/R5·human_task.created·R11)가
 * 인터프리터 ctx.attempt(매 드라이브 0)로 스코프되면 1·2 사이클이 동일 키 → events_outbox UNIQUE 충돌로 2번째
 * suspend tx 가 abort → driveScenario throw → 폴백 종결(failed_system). 정당한 재suspend 가 죽는다.
 *
 * 수정: suspend-side 키를 run_steps 의 (run,step)별 단조 attempt(기록 executor MAX+1, per-cycle 고유+재시도 안정)로
 * 스코프(resolveSuspendKeyAttempt). 기존 multicycle 테스트는 서로 다른 노드라 이 충돌을 못 잡았다.
 *
 * 실행: node scripts/db-temp-postgres-gate.mjs -- npx tsx app/test/runtime-worker-same-node-resuspend.int.ts
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
const SCHEMA = "rpa_runtime_resuspend_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKER = "9c000000-0000-0000-0000-0000000000c1";
const SITE = "40000000-0000-0000-0000-000000000f01";
const IDENTITY = "40000000-0000-0000-0000-000000000f02";
const NETWORK_POLICY = "40000000-0000-0000-0000-000000000f03";
const SCEN = "70000000-0000-0000-0000-000000000f01";
const SVER = "70000000-0000-0000-0000-000000000f02";
const RUN_RS = "71000000-0000-0000-0000-000000000f01";
const CORRELATION = "20000000-0000-0000-0000-000000000f01";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

const planResolver: BrowserLeasePlanResolver = async () => ({ siteProfileId: SITE, browserIdentityId: IDENTITY, networkPolicyId: NETWORK_POLICY });

// "open" 은 매 방문 suspend(지속 challenge) — 같은 노드 재suspend 재현. pageStateAfter 는 방문별 고유.
let openVisits = 0;
const persistentChallengeExecutor: ExecutorPlugin = {
  capabilities: () => ({ dom: false, vision: false, utility: true }),
  async execute(stepId) {
    const now = "2026-06-16T00:00:00.000Z";
    openVisits += 1;
    return {
      stepId, action: "navigate", status: "suspended",
      challenge: { type: "captcha", detectedBy: "dom", confidence: 1 },
      pageStateBefore: "ref", pageStateAfter: `ps_visit_${openVisits}`,
      artifacts: [], cache: { mode: "bypass" }, timings: { startedAt: now, endedAt: now, durationMs: 0 },
    };
  },
  async verify() { throw new Error("verify not used"); },
};

const fakeSecretStore: SecretStore = { resolve: async () => JSON.stringify({ kid: "kid-test", key: "resuspend-signing-key" }) as unknown as PlainSecret };
const suspensionPort = new PgChallengeSuspensionPort();
const resumeTokenCodec = new HmacResumeTokenCodec(fakeSecretStore, "secret://test/resume_token_hmac" as unknown as SecretRef);
const restorer: SessionRestorer = { async restoreSession(input): Promise<SessionRestoreResult> { return { kind: "restored", pageStateRef: input.expectedPageStateRef }; } };

const scenarioIr = { meta: { name: "resuspend-test", version: 1 }, start: "open", nodes: { open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "done" }, done: { terminal: "success" } } };

async function runStatus(pool: ReturnType<typeof createPool>): Promise<string | null> {
  return withTenantTx(pool, TENANT, async (c) => (await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [RUN_RS])).rows[0]?.status ?? null);
}
async function counts(pool: ReturnType<typeof createPool>): Promise<{ humanTasks: number; openAttempts: number[]; humanTaskCreated: number }> {
  return withTenantTx(pool, TENANT, async (c) => {
    const ht = await c.query<{ n: string }>(`SELECT count(*) AS n FROM human_tasks WHERE run_id=$1::uuid`, [RUN_RS]);
    const st = await c.query<{ attempt: number }>(`SELECT attempt FROM run_steps WHERE run_id=$1::uuid ORDER BY attempt`, [RUN_RS]);
    const ev = await c.query<{ n: string }>(`SELECT count(*) AS n FROM events_outbox WHERE run_id=$1::uuid AND event_type='human_task.created'`, [RUN_RS]);
    return { humanTasks: Number(ht.rows[0]?.n ?? "0"), openAttempts: st.rows.map((r) => r.attempt), humanTaskCreated: Number(ev.rows[0]?.n ?? "0") };
  });
}
async function setResumeRequested(pool: ReturnType<typeof createPool>): Promise<void> {
  await withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query(`UPDATE runs SET status='resume_requested', updated_at=now() WHERE id=$1::uuid AND status='suspended'`, [RUN_RS]);
    if (r.rowCount !== 1) throw new Error(`setResumeRequested: expected suspended run, affected ${r.rowCount ?? 0}`);
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
    } finally { setup.release(); }

    const compiled = compileScenario(scenarioIr, {});
    if (!compiled.ok) throw new Error("scenario did not compile");
    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, page_state_selectors) VALUES ($1,$2,'ok','https://ok.example/*','green',true,'{"flags":{}}'::jsonb)`, [SITE, TENANT]);
      await c.query(`INSERT INTO browser_identities (id, tenant_id, site_profile_id, label) VALUES ($1,$2,$3,'ok')`, [IDENTITY, TENANT, SITE]);
      await c.query(`INSERT INTO network_policies (id, tenant_id, allowed_domains) VALUES ($1,$2,ARRAY['ok.example'])`, [NETWORK_POLICY, TENANT]);
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'resuspend')`, [SCEN, TENANT]);
      await c.query(`INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast) VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`, [SVER, TENANT, SCEN, JSON.stringify(compiled.ir), compiled.compiledAst]);
      await c.query(`INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, params) VALUES ($1,$2,$3,'queued',$4,'{"entry_url":"https://ok.example/landing"}'::jsonb)`, [RUN_RS, TENANT, SVER, CORRELATION]);
    });

    const worker = new PgRuntimeWorker(pool, {
      workerId: WORKER, browserLeasePlanResolver: planResolver,
      browserSessionProvider: new TestFakeBrowserSessionProvider(), allowTestBrowserSessionProvider: true,
      sessionRestorer: restorer, executorFactory: () => persistentChallengeExecutor, suspensionPort, resumeTokenCodec,
    });

    // 사이클 1: claim → open suspend(#1). run_steps open attempt=0, 키 ...:open:0:...
    const c1 = await worker.handle({ kind: "run_claim", tenantId: TENANT as TenantId, runId: RUN_RS as RunId, correlationId: CORRELATION as CorrelationId });
    check("cycle1 claim → job completed", c1.kind === "completed", JSON.stringify(c1));
    check("cycle1 → run suspended(@open #1)", (await runStatus(pool)) === "suspended", String(await runStatus(pool)));

    // 사이클 2: resume → 같은 노드 open 재진입 → 재suspend(#2). run_steps open attempt=1, 키 ...:open:1:...
    //   수정 전엔 인터프리터 ctx.attempt=0 이라 1·2 사이클 키 동일 → R4 emit UNIQUE 충돌 → 종결(failed_system).
    await setResumeRequested(pool);
    const c2 = await worker.handle({ kind: "run_resume", tenantId: TENANT as TenantId, runId: RUN_RS as RunId, correlationId: CORRELATION as CorrelationId });
    check("cycle2 resume → job completed", c2.kind === "completed", JSON.stringify(c2));
    check("cycle2 → run 재suspend 성공(@open #2, failed_system 좌초 아님)", (await runStatus(pool)) === "suspended", String(await runStatus(pool)));

    const cnt = await counts(pool);
    check("같은 노드 2회 실행 → run_steps open attempt [0,1]", cnt.openAttempts.length === 2 && cnt.openAttempts[0] === 0 && cnt.openAttempts[1] === 1, JSON.stringify(cnt.openAttempts));
    check("재suspend → human_task 2건(2번째 port INSERT 커밋됨)", cnt.humanTasks === 2, JSON.stringify(cnt));
    check("outbox: human_task.created 2건(per-cycle 고유키)", cnt.humanTaskCreated === 2, JSON.stringify(cnt));
  } finally { await pool.end(); }

  if (failures > 0) { console.error(`\nFAIL: ${failures} check(s) failed`); process.exit(1); }
  console.log("\nPASS: runtime-worker 같은 노드 재suspend — per-cycle 키로 좌초 방지(#3)");
  process.exit(0);
}
main().catch((e) => { console.error("runtime-worker-same-node-resuspend int fatal:", e); process.exit(1); });
