/**
 * runtime-worker resume 완료 tx 좌초 → R20(failed_system) failsafe (하드닝 break-it 재검증 #2). 실 PostgreSQL.
 *
 * txA(resume_requested→resuming, R17)가 커밋된 뒤 완료 전이(R18/R19/R20) tx 가 영속 인프라 오류로 throw 하면 run 은
 * 'resuming' 에서 좌초한다 — graphile 재시도도 같은 오류면 무한(좀비). suspending 측 R12 failsafe 와 대칭으로
 * handleRunResume 이 terminalizeStuckRunAsSystemFailure(resuming→R20)로 종결해야 한다.
 *
 * 주입: R18(restore_ok)이 방출하는 run.resumed outbox 키(`<run>:run_resume:<issuedAt>:run.resumed`)와 동일한 행을
 * 미리 INSERT → 완료 tx 의 emit 이 UNIQUE(tenant_id, idempotency_key) 위반으로 throw(비재시도성=영속 오류의 결정형 대역).
 *
 * 실행: node scripts/db-temp-postgres-gate.mjs -- npx tsx app/test/runtime-worker-resume-completion-failsafe.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CorrelationId, RunId, TenantId } from "../../ts/security-middleware-contract";
import type { ResumeTokenEnvelope, SessionRestoreResult, SessionRestorer } from "../../ts/runtime-contract";
import { compileScenario } from "../src/api/compile-pipeline";
import { createPool, withTenantTx } from "../src/db/pool";
import { TestFakeBrowserSessionProvider } from "../src/executor/browser-session-provider";
import { PgRuntimeWorker, type BrowserLeasePlanResolver } from "../src/worker/runtime-worker";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_runtime_resume_failsafe_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKER = "9c000000-0000-0000-0000-00000000fb01";
const SITE = "40000000-0000-0000-0000-000000005001";
const IDENTITY = "40000000-0000-0000-0000-000000005002";
const NETWORK_POLICY = "40000000-0000-0000-0000-000000005003";
const SCEN = "70000000-0000-0000-0000-000000005001";
const SVER = "70000000-0000-0000-0000-000000005002";
const RUN_RF = "71000000-0000-0000-0000-000000005001";
const CORRELATION = "20000000-0000-0000-0000-000000005001";
const ISSUED_AT = "2026-06-16T00:00:00.000Z";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}
async function caught(p: Promise<unknown>): Promise<unknown> { try { await p; return undefined; } catch (e) { return e; } }

const planResolver: BrowserLeasePlanResolver = async () => ({ siteProfileId: SITE, browserIdentityId: IDENTITY, networkPolicyId: NETWORK_POLICY });
// restore 성공 → 완료 tx 가 R18(running)을 선택, run.resumed 를 방출(여기서 키 충돌로 throw).
const restorer: SessionRestorer = { async restoreSession(input): Promise<SessionRestoreResult> { return { kind: "restored", pageStateRef: input.expectedPageStateRef }; } };
function token(runId: string): ResumeTokenEnvelope {
  return { runId: runId as RunId, resumeNodeId: "open", pageStateRef: "page-state://rf", issuedAt: ISSUED_AT as ResumeTokenEnvelope["issuedAt"], expiresAt: "2026-06-17T00:00:00.000Z" as ResumeTokenEnvelope["expiresAt"], kid: "kms://t/k", hmac: "sig" };
}
const scenarioIr = { meta: { name: "rf-test", version: 1 }, start: "open", nodes: { open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "done" }, done: { terminal: "success" } } };

async function runStatus(pool: ReturnType<typeof createPool>): Promise<string | null> {
  return withTenantTx(pool, TENANT, async (c) => (await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [RUN_RF])).rows[0]?.status ?? null);
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
      await setup.query(`INSERT INTO workers (id, kind, status, circuit_state, consecutive_init_failures) VALUES ($1::uuid,'browser','active','closed',0)`, [WORKER]);
    } finally { setup.release(); }

    const compiled = compileScenario(scenarioIr, {});
    if (!compiled.ok) throw new Error("scenario did not compile");
    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, page_state_selectors) VALUES ($1,$2,'ok','https://ok.example/*','green',true,'{"flags":{}}'::jsonb)`, [SITE, TENANT]);
      await c.query(`INSERT INTO browser_identities (id, tenant_id, site_profile_id, label) VALUES ($1,$2,$3,'ok')`, [IDENTITY, TENANT, SITE]);
      await c.query(`INSERT INTO network_policies (id, tenant_id, allowed_domains) VALUES ($1,$2,ARRAY['ok.example'])`, [NETWORK_POLICY, TENANT]);
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'rf')`, [SCEN, TENANT]);
      await c.query(`INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast) VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`, [SVER, TENANT, SCEN, JSON.stringify(compiled.ir), compiled.compiledAst]);
      await c.query(`INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, resume_token, params) VALUES ($1,$2,$3,'resume_requested',$4,$5::jsonb,'{"entry_url":"https://ok.example/landing"}'::jsonb)`, [RUN_RF, TENANT, SVER, CORRELATION, JSON.stringify(token(RUN_RF))]);
      // 완료 tx R18 이 방출할 run.resumed 키를 선점 → emit UNIQUE 위반으로 완료 tx throw(영속 인프라 오류 모사).
      await c.query(
        `INSERT INTO events_outbox (event_id, event_type, event_version, tenant_id, run_id, correlation_id, occurred_at, idempotency_key, payload_schema_ref, payload, retention_until)
         VALUES (gen_random_uuid(), 'run.resumed', 1, $1::uuid, $2::uuid, $3::uuid, now(), $4, 'events/run.resumed@1', '{}'::jsonb, now() + interval '1 day')`,
        [TENANT, RUN_RF, CORRELATION, `${RUN_RF}:run_resume:${ISSUED_AT}:run.resumed`],
      );
    });

    const worker = new PgRuntimeWorker(pool, {
      workerId: WORKER, browserLeasePlanResolver: planResolver,
      browserSessionProvider: new TestFakeBrowserSessionProvider(), allowTestBrowserSessionProvider: true,
      sessionRestorer: restorer,
    });

    check("초기 run resume_requested", await runStatus(pool) === "resume_requested", String(await runStatus(pool)));

    // run_resume: txA R17(resuming) → restore 성공 → 완료 tx R18 emit run.resumed → UNIQUE 위반 throw → failsafe R20.
    const result = await caught(worker.handle({ kind: "run_resume", tenantId: TENANT as TenantId, runId: RUN_RF as RunId, correlationId: CORRELATION as CorrelationId }));
    check("완료 tx 좌초 → failsafe 가 throw 흡수(job 정상 종료, 좀비 재시도 루프 아님)", result === undefined, String(result));
    check("완료 tx 좌초 → run failed_system 종결(R20, 'resuming' 좌초 아님)", await runStatus(pool) === "failed_system", String(await runStatus(pool)));
  } finally { await pool.end(); }

  if (failures > 0) { console.error(`\nFAIL: ${failures} check(s) failed`); process.exit(1); }
  console.log("\nPASS: runtime-worker resume 완료 tx 좌초 → R20 failsafe(#2)");
  process.exit(0);
}
main().catch((e) => { console.error("runtime-worker-resume-completion-failsafe int fatal:", e); process.exit(1); });
