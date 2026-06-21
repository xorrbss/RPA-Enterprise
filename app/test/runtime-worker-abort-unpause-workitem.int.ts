/**
 * runtime-worker abort-while-suspended → linked workitem un-pause (하드닝 break-it 후속, #7 회귀 보수). 실 PostgreSQL.
 *
 * #7(W9/W11)이 suspend 시 workitem checkout timer 를 pause(checkout_paused_at)하는데, suspended run 이 resume 대신
 * ABORT 되면 W11(resume→running)이 안 와 workitem 이 영구 paused(processing) 잔류 → checkout sweeper 의 paused 가드가
 * 영영 스킵 = 누수(#7 회귀). 보수: finalizeRunAbort 가 abort 종결 tx 에서 un-pause + 즉시만료 → sweeper(W6/W7) 자가회수.
 *
 * 실행: node scripts/db-temp-postgres-gate.mjs -- npx tsx app/test/runtime-worker-abort-unpause-workitem.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CorrelationId, RunId, TenantId } from "../../ts/security-middleware-contract";
import type { ExecutorPlugin, PlainSecret, SecretRef, SecretStore } from "../../ts/core-types";
import type { RunAbortDrainResult, RunAbortDrainer } from "../../ts/runtime-contract";
import { compileScenario } from "../src/api/compile-pipeline";
import { createPool, withTenantTx } from "../src/db/pool";
import { TestFakeBrowserSessionProvider } from "../src/executor/browser-session-provider";
import { PgChallengeSuspensionPort } from "../src/runtime/challenge-suspension-port";
import { HmacResumeTokenCodec } from "../src/runtime/resume-token-codec";
import { PgRuntimeWorker, type BrowserLeasePlanResolver } from "../src/worker/runtime-worker";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_runtime_abort_unpause_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKER = "9c000000-0000-0000-0000-0000000000f9";
const SITE = "40000000-0000-0000-0000-000000003001";
const IDENTITY = "40000000-0000-0000-0000-000000003002";
const NETWORK_POLICY = "40000000-0000-0000-0000-000000003003";
const SCEN = "70000000-0000-0000-0000-000000003001";
const SVER = "70000000-0000-0000-0000-000000003002";
const RUN_AB = "71000000-0000-0000-0000-000000003001";
const WI_AB = "72000000-0000-0000-0000-000000003001";
const CORRELATION = "20000000-0000-0000-0000-000000003001";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

const planResolver: BrowserLeasePlanResolver = async () => ({ siteProfileId: SITE, browserIdentityId: IDENTITY, networkPolicyId: NETWORK_POLICY });
const suspendingExecutor: ExecutorPlugin = {
  capabilities: () => ({ dom: false, vision: false, utility: true }),
  async execute(stepId) {
    const now = "2026-06-16T00:00:00.000Z";
    return { stepId, action: "navigate", status: "suspended", challenge: { type: "captcha", detectedBy: "dom", confidence: 1 }, pageStateBefore: "ref", pageStateAfter: "ps", artifacts: [], cache: { mode: "bypass" }, timings: { startedAt: now, endedAt: now, durationMs: 0 } };
  },
  async verify() { throw new Error("verify not used"); },
};
const fakeSecretStore: SecretStore = { resolve: async () => JSON.stringify({ kid: "kid-test", key: "abort-unpause-key" }) as unknown as PlainSecret };
const suspensionPort = new PgChallengeSuspensionPort();
const resumeTokenCodec = new HmacResumeTokenCodec(fakeSecretStore, "secret://test/resume_token_hmac" as unknown as SecretRef);
// suspended run abort 는 drainer 가 필요 없으나(drain_ok 즉시), 주입 시그니처용 no-op drainer.
const drainer: RunAbortDrainer = { async drainAbort(): Promise<RunAbortDrainResult> { return { kind: "drained" }; } };

const scenarioIr = { meta: { name: "abort-unpause-test", version: 1 }, start: "open", nodes: { open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "done" }, done: { terminal: "success" } } };

async function wi(pool: ReturnType<typeof createPool>): Promise<{ status: string; paused: Date | null; expires: Date | null }> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ status: string; checkout_paused_at: Date | null; checkout_expires_at: Date | null }>(
      `SELECT status, checkout_paused_at, checkout_expires_at FROM workitems WHERE id=$1::uuid`, [WI_AB]);
    const row = r.rows[0];
    return { status: row?.status ?? "missing", paused: row?.checkout_paused_at ?? null, expires: row?.checkout_expires_at ?? null };
  });
}
async function runStatus(pool: ReturnType<typeof createPool>): Promise<string | null> {
  return withTenantTx(pool, TENANT, async (c) => (await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [RUN_AB])).rows[0]?.status ?? null);
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
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'abort-unpause')`, [SCEN, TENANT]);
      await c.query(`INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast) VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`, [SVER, TENANT, SCEN, JSON.stringify(compiled.ir), compiled.compiledAst]);
      await c.query(`INSERT INTO workitems (id, tenant_id, connector_id, unique_reference, status, attempts, checked_out_by, checkout_expires_at) VALUES ($1,$2,'sw','ab-ref','processing',0,$3::uuid, now() + interval '1 hour')`, [WI_AB, TENANT, WORKER]);
      await c.query(`INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, workitem_id, params) VALUES ($1,$2,$3,'queued',$4,$5::uuid,'{"entry_url":"https://ok.example/landing"}'::jsonb)`, [RUN_AB, TENANT, SVER, CORRELATION, WI_AB]);
    });

    const worker = new PgRuntimeWorker(pool, {
      workerId: WORKER, browserLeasePlanResolver: planResolver,
      browserSessionProvider: new TestFakeBrowserSessionProvider(), allowTestBrowserSessionProvider: true,
      executorFactory: () => suspendingExecutor, suspensionPort, resumeTokenCodec, runAbortDrainer: drainer,
    });

    // 1) claim → suspend → W9 pause.
    await worker.handle({ kind: "run_claim", tenantId: TENANT as TenantId, runId: RUN_AB as RunId, correlationId: CORRELATION as CorrelationId });
    check("suspend → run suspended", await runStatus(pool) === "suspended", String(await runStatus(pool)));
    check("W9: workitem checkout_paused_at 설정됨", (await wi(pool)).paused !== null, JSON.stringify(await wi(pool)));
    const beforeAbortExpires = (await wi(pool)).expires; // seed = now()+1h(미래). abort un-pause 가 앞당기는지 비교 기준.

    // 2) 제어평면 abort(R16 suspended→aborting) 모사: status=aborting, abort_source_status=suspended. suspended run 의
    //    Phase A lease 는 반납 상태(R16 전제: "Phase A는 R11에서 lease 반납")라 drain 즉시 완료 경로로 finalizeRunAbort
    //    도달 — lease 만료로 그 전제를 맞춘다.
    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`UPDATE browser_leases SET state='expired' WHERE tenant_id=$1::uuid AND run_id=$2::uuid`, [TENANT, RUN_AB]);
      await c.query(`UPDATE runs SET status='aborting', abort_source_status='suspended', updated_at=now() WHERE id=$1::uuid AND status='suspended'`, [RUN_AB]);
    });

    // 3) run_abort → finalizeRunAbort(R23 aborting→cancelled) + un-pause workitem(#7 회귀 보수).
    const aborted = await worker.handle({ kind: "run_abort", tenantId: TENANT as TenantId, runId: RUN_AB as RunId, correlationId: CORRELATION as CorrelationId });
    check("run_abort → completed", aborted.kind === "completed", JSON.stringify(aborted));
    check("run cancelled", await runStatus(pool) === "cancelled", String(await runStatus(pool)));
    const abHt = await withTenantTx(pool, TENANT, async (c) => (await c.query<{ state: string }>(`SELECT state FROM human_tasks WHERE run_id=$1::uuid`, [RUN_AB])).rows);
    check("abort: 연결 human_task 가 cancel 됨(orphan open 아님, #1 보수)", abHt.length === 1 && abHt[0]?.state === "cancelled", JSON.stringify(abHt));
    let w = await wi(pool);
    check("abort: workitem checkout_paused_at 해제됨(누수 아님, #7 보수)", w.paused === null, JSON.stringify(w));
    check(
      "abort: workitem 만료가 앞당겨짐(now()로 — sweeper 즉시 회수 대상)",
      w.expires !== null && beforeAbortExpires !== null && w.expires.getTime() < beforeAbortExpires.getTime(),
      `before=${String(beforeAbortExpires)} after=${String(w.expires)}`,
    );

    // 4) sweeper → un-paused+만료 workitem 회수(W6 retry, attempts<max). 누수였다면 paused 라 영영 스킵됐을 것.
    await worker.handle({ kind: "workitem_checkout_sweeper", tenantId: TENANT as TenantId, correlationId: CORRELATION as CorrelationId });
    w = await wi(pool);
    check("sweeper: un-paused workitem 회수됨(processing 아님 = 누수 아님)", w.status !== "processing", JSON.stringify(w));
  } finally { await pool.end(); }

  if (failures > 0) { console.error(`\nFAIL: ${failures} check(s) failed`); process.exit(1); }
  console.log("\nPASS: runtime-worker abort-while-suspended → workitem un-pause(#7 회귀 보수)");
  process.exit(0);
}
main().catch((e) => { console.error("runtime-worker-abort-unpause-workitem int fatal:", e); process.exit(1); });
