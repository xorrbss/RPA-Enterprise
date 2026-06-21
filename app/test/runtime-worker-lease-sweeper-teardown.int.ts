/**
 * runtime-worker lease_sweeper 세션 teardown (감사 XRT-1). 실 PostgreSQL.
 *
 * 종전 handleLeaseSweeper 는 만료 browser_lease 를 DB state='expired' 로만 마킹하고 migration #7 sweeper 계약의
 * "반환 row 프로세스 kill + cleanup(idempotent)" 부작용(라이브 Chrome teardown + 격리 다운로드 디렉토리 제거)을
 * 수행하지 않아 OS 자원이 누수됐다. 수정: RETURNING 으로 만료행 수집 → tx 밖에서 **자기 워커가 bind 한** 세션을
 * drainAbort 로 teardown(leaseId 미바운드/타 워커 소유=no-op). 죽은 타 워커 프로세스는 그 컨테이너가 회수.
 *
 * 실행: node scripts/db-temp-postgres-gate.mjs -- npx tsx app/test/runtime-worker-lease-sweeper-teardown.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CorrelationId, TenantId } from "../../ts/security-middleware-contract";
import type { RunAbortDrainInput, RunAbortDrainResult, RunAbortDrainer } from "../../ts/runtime-contract";
import { compileScenario } from "../src/api/compile-pipeline";
import { createPool, withTenantTx } from "../src/db/pool";
import { PgRuntimeWorker } from "../src/worker/runtime-worker";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_runtime_sweeper_teardown_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKER = "9c000000-0000-0000-0000-00000000ab01";
const OTHER_WORKER = "9c000000-0000-0000-0000-00000000ab02";
const SITE = "40000000-0000-0000-0000-000000006001";
const IDENTITY = "40000000-0000-0000-0000-000000006002";
const L_OWN_ACTIVE = "73000000-0000-0000-0000-000000006001";
const L_OTHER_ACTIVE = "73000000-0000-0000-0000-000000006002";
const L_OWN_RESERVED = "73000000-0000-0000-0000-000000006003";
const RUN1 = "71000000-0000-0000-0000-000000006001";
const RUN2 = "71000000-0000-0000-0000-000000006002";
const SCEN = "70000000-0000-0000-0000-000000006001";
const SVER = "70000000-0000-0000-0000-000000006002";
const CORRELATION = "20000000-0000-0000-0000-000000006001";

const scenarioIr = { meta: { name: "sweeper-teardown-test", version: 1 }, start: "open", nodes: { open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "done" }, done: { terminal: "success" } } };

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

const drainCalls: string[] = [];
const recordingDrainer: RunAbortDrainer = {
  async drainAbort(input: RunAbortDrainInput): Promise<RunAbortDrainResult> {
    drainCalls.push(input.leaseId);
    return { kind: "drained" };
  },
};

async function leaseState(pool: ReturnType<typeof createPool>, id: string): Promise<string | null> {
  return withTenantTx(pool, TENANT, async (c) => (await c.query<{ state: string }>(`SELECT state FROM browser_leases WHERE id=$1::uuid`, [id])).rows[0]?.state ?? null);
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
      // browser_leases.run_id 는 runs FK(fk_browserlease_run) → 최소 run 2개 시드.
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'sweeper-teardown')`, [SCEN, TENANT]);
      await c.query(`INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast) VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`, [SVER, TENANT, SCEN, JSON.stringify(compiled.ir), compiled.compiledAst]);
      for (const rid of [RUN1, RUN2]) {
        await c.query(`INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, params) VALUES ($1,$2,$3,'running',$4,'{"entry_url":"https://ok.example/landing"}'::jsonb)`, [rid, TENANT, SVER, CORRELATION]);
      }
      // 3개 만료 lease(expires_at 과거): 자기워커-active(teardown 대상)·타워커-active(skip)·자기워커-reserved(run_id NULL=skip).
      const ins = `INSERT INTO browser_leases (id, tenant_id, site_profile_id, browser_identity_id, run_id, owner_worker_id, isolation, state, cleanup_policy, download_dir_ref, expires_at)
                   VALUES ($1,$2,$3,$4,$5,$6,'context',$7,'clear_all',$8, now() - interval '1 minute')`;
      await c.query(ins, [L_OWN_ACTIVE, TENANT, SITE, IDENTITY, RUN1, WORKER, "active", "lease://own-active"]);
      await c.query(ins, [L_OTHER_ACTIVE, TENANT, SITE, IDENTITY, RUN2, OTHER_WORKER, "active", "lease://other-active"]);
      await c.query(`INSERT INTO browser_leases (id, tenant_id, site_profile_id, browser_identity_id, run_id, owner_worker_id, isolation, state, cleanup_policy, download_dir_ref, expires_at)
                     VALUES ($1,$2,$3,$4,NULL,$5,'context','reserved','clear_all',$6, now() - interval '1 minute')`,
        [L_OWN_RESERVED, TENANT, SITE, IDENTITY, WORKER, "lease://own-reserved"]);
    });

    const worker = new PgRuntimeWorker(pool, { workerId: WORKER, runAbortDrainer: recordingDrainer });

    const result = await worker.handle({ kind: "lease_sweeper", tenantId: TENANT as TenantId, correlationId: CORRELATION as CorrelationId });
    check("lease_sweeper → job completed", result.kind === "completed", JSON.stringify(result));

    // DB 만료: 3개 모두 expired(기존 동작 보존).
    check("자기워커-active lease expired", (await leaseState(pool, L_OWN_ACTIVE)) === "expired", String(await leaseState(pool, L_OWN_ACTIVE)));
    check("타워커-active lease expired", (await leaseState(pool, L_OTHER_ACTIVE)) === "expired", String(await leaseState(pool, L_OTHER_ACTIVE)));
    check("자기워커-reserved lease expired", (await leaseState(pool, L_OWN_RESERVED)) === "expired", String(await leaseState(pool, L_OWN_RESERVED)));

    // teardown 스코핑(XRT-1): 자기 워커 + run 연결(active) lease 만 drainAbort. 타워커·reserved 는 skip.
    check("teardown = 자기워커-active 1건만(타워커·reserved skip)", drainCalls.length === 1 && drainCalls[0] === L_OWN_ACTIVE, JSON.stringify(drainCalls));
  } finally { await pool.end(); }

  if (failures > 0) { console.error(`\nFAIL: ${failures} check(s) failed`); process.exit(1); }
  console.log("\nPASS: runtime-worker lease_sweeper 세션 teardown(XRT-1)");
  process.exit(0);
}
main().catch((e) => { console.error("runtime-worker-lease-sweeper-teardown int fatal:", e); process.exit(1); });
