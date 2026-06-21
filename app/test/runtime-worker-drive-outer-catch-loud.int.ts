/**
 * runtime-worker driveScenario 외곽 catch loud (하드닝 break-it 재검증 #4). 실 PostgreSQL.
 *
 * driveScenario 의 안쪽 catch(인터프리터 예외)는 로그하지만, video 시작·아티팩트 append 를 감싸는 **외곽 catch** 는
 * 무로그로 systemFailureOutcome 으로 흡수했다(조용한 false/unknown 금지 위반 — system 은 loud 채널). 운영자·디버거가
 * 신호를 잃는다. 수정: 외곽 catch 도 error 바인딩 + console.error.
 *
 * 주입: meta.evidence.video='always' 시나리오 + startRunVideo 가 throw 하는 video recorder → 외곽 catch 가 결정형
 * 발화(runScenario 전). run 은 failed_system(흡수)으로 동일하나, 로그 발화 여부만 달라진다.
 *
 * 실행: node scripts/db-temp-postgres-gate.mjs -- npx tsx app/test/runtime-worker-drive-outer-catch-loud.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CorrelationId, RunId, TenantId } from "../../ts/security-middleware-contract";
import type { ExecutorPlugin } from "../../ts/core-types";
import type { RunVideoRecording, VisualEvidenceVideoRecorder } from "../../ts/runtime-contract";
import { compileScenario } from "../src/api/compile-pipeline";
import { createPool, withTenantTx } from "../src/db/pool";
import { TestFakeBrowserSessionProvider } from "../src/executor/browser-session-provider";
import { PgRuntimeWorker, type BrowserLeasePlanResolver } from "../src/worker/runtime-worker";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_runtime_outer_catch_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKER = "9c000000-0000-0000-0000-0000000000d1";
const SITE = "40000000-0000-0000-0000-000000001001";
const IDENTITY = "40000000-0000-0000-0000-000000001002";
const NETWORK_POLICY = "40000000-0000-0000-0000-000000001003";
const SCEN = "70000000-0000-0000-0000-000000001001";
const SVER = "70000000-0000-0000-0000-000000001002";
const RUN_OC = "71000000-0000-0000-0000-000000001001";
const CORRELATION = "20000000-0000-0000-0000-000000001001";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

const planResolver: BrowserLeasePlanResolver = async () => ({ siteProfileId: SITE, browserIdentityId: IDENTITY, networkPolicyId: NETWORK_POLICY });
const okExecutor: ExecutorPlugin = {
  capabilities: () => ({ dom: false, vision: false, utility: true }),
  async execute(stepId) {
    const now = "2026-06-16T00:00:00.000Z";
    return { stepId, action: "navigate", status: "success", pageStateBefore: "ref", pageStateAfter: "ps", artifacts: [], cache: { mode: "bypass" }, timings: { startedAt: now, endedAt: now, durationMs: 0 } };
  },
  async verify() { throw new Error("verify not used"); },
};
// startRunVideo 가 throw → driveScenario 외곽 catch 결정형 발화(runScenario 도달 전).
const throwingVideoRecorder: VisualEvidenceVideoRecorder = {
  async startRunVideo(): Promise<RunVideoRecording> { throw new Error("simulated video start failure (driveScenario outer)"); },
};
// video 시나리오는 아티팩트 lifecycle enqueue 가 필요(없으면 driveScenario 가 외곽 catch 전에 fail) — no-op enqueuer.
const noopEnqueuer = { async enqueueRuntimeJob(): Promise<void> {} };
// video='always' → videoPolicyFromIr 가 정책 산출 → startRunVideo 호출 경로 활성.
const scenarioIr = { meta: { name: "outer-catch-test", version: 1, evidence: { screenshot: "never", video: "always" } }, start: "open", nodes: { open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "done" }, done: { terminal: "success" } } };

async function runStatus(pool: ReturnType<typeof createPool>): Promise<string | null> {
  return withTenantTx(pool, TENANT, async (c) => (await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [RUN_OC])).rows[0]?.status ?? null);
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  // console.error 캡처(외곽 catch 로그 발화 검증). pass-through 유지.
  const captured: string[] = [];
  const origError = console.error.bind(console);
  console.error = (...args: unknown[]): void => { captured.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")); origError(...args); };
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
    if (!compiled.ok) throw new Error(`scenario did not compile: ${JSON.stringify(compiled.details)}`);
    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, page_state_selectors) VALUES ($1,$2,'ok','https://ok.example/*','green',true,'{"flags":{}}'::jsonb)`, [SITE, TENANT]);
      await c.query(`INSERT INTO browser_identities (id, tenant_id, site_profile_id, label) VALUES ($1,$2,$3,'ok')`, [IDENTITY, TENANT, SITE]);
      await c.query(`INSERT INTO network_policies (id, tenant_id, allowed_domains) VALUES ($1,$2,ARRAY['ok.example'])`, [NETWORK_POLICY, TENANT]);
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'outer-catch')`, [SCEN, TENANT]);
      await c.query(`INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast) VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`, [SVER, TENANT, SCEN, JSON.stringify(compiled.ir), compiled.compiledAst]);
      await c.query(`INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, params) VALUES ($1,$2,$3,'queued',$4,'{"entry_url":"https://ok.example/landing"}'::jsonb)`, [RUN_OC, TENANT, SVER, CORRELATION]);
    });

    const worker = new PgRuntimeWorker(pool, {
      workerId: WORKER, browserLeasePlanResolver: planResolver,
      browserSessionProvider: new TestFakeBrowserSessionProvider(), allowTestBrowserSessionProvider: true,
      executorFactory: () => okExecutor, visualEvidenceVideoRecorderFactory: () => throwingVideoRecorder,
      runtimeJobEnqueuer: noopEnqueuer,
    });

    const result = await worker.handle({ kind: "run_claim", tenantId: TENANT as TenantId, runId: RUN_OC as RunId, correlationId: CORRELATION as CorrelationId });
    check("claim → job completed", result.kind === "completed", JSON.stringify(result));
    check("외곽 실패 → run failed_system 흡수", (await runStatus(pool)) === "failed_system", String(await runStatus(pool)));
    const outerLog = captured.some((m) => m.includes("drive 외곽(video/artifact)"));
    check("driveScenario 외곽 catch 가 loud(조용한 false 금지) — 외곽 실패 로그 발화", outerLog, `captured=${captured.length}`);
  } finally {
    console.error = origError;
    await pool.end();
  }

  if (failures > 0) { console.error(`\nFAIL: ${failures} check(s) failed`); process.exit(1); }
  console.log("\nPASS: runtime-worker driveScenario 외곽 catch loud(#4)");
  process.exit(0);
}
main().catch((e) => { console.error("runtime-worker-drive-outer-catch-loud int fatal:", e); process.exit(1); });
