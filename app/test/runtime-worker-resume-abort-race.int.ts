/**
 * runtime-worker resume INIT-failure under abort-race → worker-circuit 미증가 (하드닝 break-it 후속, #5/#6 회귀 보수). 실 PostgreSQL.
 *
 * #5/#6 의 resume Phase C INIT 실패 처리가 terminalize() 반환값을 무시하고 recordWorkerInitFailure 를 무조건 호출했다.
 * abort race(resume 중 run 이 aborting 으로 전이)면 terminalize 가 false(취소·경합 패배=이 워커 INIT 실패 아님) 반환하는데도
 * worker-circuit 을 증가시켜 spurious open(과잉격리)→무관 run 의 claim/resume 차단. claim 경로(if outcome!==null)와 대칭으로
 * terminalize=true 일 때만 기록하도록 보수. 본 테스트: bind 실패 직전 run 을 aborting 으로 만들어 terminalize=false →
 * consecutive_init_failures 미증가 검증.
 *
 * 실행: node scripts/db-temp-postgres-gate.mjs -- npx tsx app/test/runtime-worker-resume-abort-race.int.ts
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
const SCHEMA = "rpa_runtime_resume_abortrace_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKER = "9c000000-0000-0000-0000-00000000fa01";
const SITE = "40000000-0000-0000-0000-000000004001";
const IDENTITY = "40000000-0000-0000-0000-000000004002";
const NETWORK_POLICY = "40000000-0000-0000-0000-000000004003";
const SCEN = "70000000-0000-0000-0000-000000004001";
const SVER = "70000000-0000-0000-0000-000000004002";
const RUN_AR = "71000000-0000-0000-0000-000000004001";
const CORRELATION = "20000000-0000-0000-0000-000000004001";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}
async function caught(p: Promise<unknown>): Promise<unknown> { try { await p; return undefined; } catch (e) { return e; } }

const planResolver: BrowserLeasePlanResolver = async () => ({ siteProfileId: SITE, browserIdentityId: IDENTITY, networkPolicyId: NETWORK_POLICY });
const restorer: SessionRestorer = { async restoreSession(input): Promise<SessionRestoreResult> { return { kind: "restored", pageStateRef: input.expectedPageStateRef }; } };
function token(runId: string): ResumeTokenEnvelope {
  return { runId: runId as RunId, resumeNodeId: "open", pageStateRef: "page-state://ar", issuedAt: "2026-06-16T00:00:00.000Z" as ResumeTokenEnvelope["issuedAt"], expiresAt: "2026-06-17T00:00:00.000Z" as ResumeTokenEnvelope["expiresAt"], kid: "kms://t/k", hmac: "sig" };
}
const scenarioIr = { meta: { name: "ar-test", version: 1 }, start: "open", nodes: { open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "done" }, done: { terminal: "success" } } };

async function circuitFailures(pool: ReturnType<typeof createPool>): Promise<number> {
  return withTenantTx(pool, TENANT, async (c) => (await c.query<{ n: number }>(`SELECT consecutive_init_failures AS n FROM workers WHERE id=$1::uuid`, [WORKER])).rows[0]?.n ?? -1);
}
async function runStatus(pool: ReturnType<typeof createPool>): Promise<string | null> {
  return withTenantTx(pool, TENANT, async (c) => (await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [RUN_AR])).rows[0]?.status ?? null);
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  // bind 실패 직전 run 을 aborting 으로(동시 abort 모사). terminalize 는 aborting 을 종결하지 않아 false 반환.
  const abortRacingBindProvider: BrowserSessionProvider = {
    binding: { kind: "test_fake" } as const,
    async bind() {
      // 동시 abort 모사: bind 실패 직전 run 을 aborting 으로(R6 효과). withTenantTx 로 테넌트 컨텍스트(audit 트리거) 설정.
      await withTenantTx(pool, TENANT, async (c) => {
        await c.query(`UPDATE runs SET status='aborting' WHERE id=$1::uuid AND status='running'`, [RUN_AR]);
      });
      throw new Error("simulated bind failure during concurrent abort");
    },
  };
  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
      await setup.query(`INSERT INTO workers (id, kind, status, circuit_state, consecutive_init_failures) VALUES ($1::uuid,'browser','active','closed',0)`, [WORKER]);
    } finally { setup.release(); }

    const compiled = compileScenario(scenarioIr, {});
    if (!compiled.ok) throw new Error("scenario did not compile");
    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, page_state_selectors) VALUES ($1,$2,'ok','https://ok.example/*','green',true,'{"flags":{}}'::jsonb)`, [SITE, TENANT]);
      await c.query(`INSERT INTO browser_identities (id, tenant_id, site_profile_id, label) VALUES ($1,$2,$3,'ok')`, [IDENTITY, TENANT, SITE]);
      await c.query(`INSERT INTO network_policies (id, tenant_id, allowed_domains) VALUES ($1,$2,ARRAY['ok.example'])`, [NETWORK_POLICY, TENANT]);
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'ar')`, [SCEN, TENANT]);
      await c.query(`INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast) VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`, [SVER, TENANT, SCEN, JSON.stringify(compiled.ir), compiled.compiledAst]);
      await c.query(`INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, resume_token, params) VALUES ($1,$2,$3,'resume_requested',$4,$5::jsonb,'{"entry_url":"https://ok.example/landing"}'::jsonb)`, [RUN_AR, TENANT, SVER, CORRELATION, JSON.stringify(token(RUN_AR))]);
    });

    const worker = new PgRuntimeWorker(pool, {
      workerId: WORKER, browserLeasePlanResolver: planResolver,
      browserSessionProvider: abortRacingBindProvider, allowTestBrowserSessionProvider: true,
      sessionRestorer: restorer,
    });

    check("초기 worker consecutive_init_failures = 0", await circuitFailures(pool) === 0, String(await circuitFailures(pool)));
    // run_resume → R18(running) → Phase C bind → run aborting + throw → terminalize=false → recordWorkerInitFailure 미호출.
    const err = await caught(worker.handle({ kind: "run_resume", tenantId: TENANT as TenantId, runId: RUN_AR as RunId, correlationId: CORRELATION as CorrelationId }));
    check("resume INIT abort-race → 폴백이 throw 흡수(job 정상 종료)", err === undefined, String(err));
    check("abort-race → run aborting 유지(terminalize 가 abort 소유권 침범 안 함)", await runStatus(pool) === "aborting", String(await runStatus(pool)));
    check(
      "abort-race(terminalize=false) → worker-circuit 미증가(spurious open 방지, #5/#6 보수)",
      await circuitFailures(pool) === 0,
      String(await circuitFailures(pool)),
    );
  } finally { await pool.end(); }

  if (failures > 0) { console.error(`\nFAIL: ${failures} check(s) failed`); process.exit(1); }
  console.log("\nPASS: runtime-worker resume INIT abort-race → worker-circuit 미증가(#5/#6 회귀 보수)");
  process.exit(0);
}
main().catch((e) => { console.error("runtime-worker-resume-abort-race int fatal:", e); process.exit(1); });
