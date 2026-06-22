/**
 * zombie-run 회수 sweeper 통합 (상태머신 감사 클러스터 B). 실 PostgreSQL.
 *
 * 결함: 워커 프로세스 크래시/wedge 시 비종결 run(claimed/running/completing/suspending/resuming)이 영구 좌초.
 * in-process failsafe(terminalizeStuckRunAsSystemFailure)는 라이브 워커의 catch 에서만 호출되고, lease_sweeper 는
 * browser_leases 만 만료시켜 runs.status 는 건드리지 않았다. 수정(클러스터 A heartbeat 배선 후): 살아있는 워커는
 * lease 를 갱신하므로 'expired lease = dead worker' 신호가 신뢰 가능 → lease_sweeper 가 만료 lease 의 연결 비종결
 * run 을 failed_system 으로 종결(cross-worker, idempotent CAS). + terminalize 가 claimed(R3b)까지 커버.
 *
 * 검증:
 *  - claimed/running/completing/suspending/resuming + 만료 lease → failed_system 종결.
 *  - running + 미래(future) lease → 회수 안 함(non-expired=살아있는 워커, false-positive 가드).
 *  - completed(terminal) + 만료 lease → 불변(CAS no-op).
 *  - 연결 workitem(processing) → run 종결 시 system 정산(W4 retry).
 *  - 2회 sweep 멱등(이미 종결/만료된 것 재처리 안 함).
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/runtime-worker-zombie-sweeper.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { TenantId } from "../../ts/security-middleware-contract";
import { createPool, withTenantTx } from "../src/db/pool";
import { PgRuntimeWorker } from "../src/worker/runtime-worker";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_zombie_sweeper_int";
const TENANT = "00000000-0000-0000-0000-0000000000e1";
const WORKER = "9a000000-0000-0000-0000-0000000000e1";
const OTHER_WORKER = "9a000000-0000-0000-0000-0000000000e2";
const CORRELATION = "20000000-0000-0000-0000-0000000000e1";
const SITE = "5c000000-0000-0000-0000-0000000000e1";
const IDENTITY = "b1000000-0000-0000-0000-0000000000e1";
const SCENARIO = "5ce00000-0000-0000-0000-0000000000e1";
const SCENARIO_VERSION = "5ce00000-0000-0000-0000-0000000000e2";
const WORKITEM = "71000000-0000-0000-0000-0000000000e1";

// run id ↔ 시드 상태. 마지막 글자로 식별.
const RUN_CLAIMED = "30000000-0000-0000-0000-0000000000a1";
const RUN_RUNNING = "30000000-0000-0000-0000-0000000000a2";
const RUN_COMPLETING = "30000000-0000-0000-0000-0000000000a3";
const RUN_SUSPENDING = "30000000-0000-0000-0000-0000000000a4";
const RUN_RESUMING = "30000000-0000-0000-0000-0000000000a5";
const RUN_FUTURE = "30000000-0000-0000-0000-0000000000a6"; // running + 미래 lease (control)
const RUN_TERMINAL = "30000000-0000-0000-0000-0000000000a7"; // completed + 만료 lease (control)
const RUN_WI = "30000000-0000-0000-0000-0000000000a8"; // running + 만료 lease + 연결 workitem

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function runStatus(pool: ReturnType<typeof createPool>, runId: string): Promise<string> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [runId]);
    return r.rows[0]?.status ?? "missing";
  });
}
async function wiStatus(pool: ReturnType<typeof createPool>, id: string): Promise<string> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ status: string }>(`SELECT status FROM workitems WHERE id=$1::uuid`, [id]);
    return r.rows[0]?.status ?? "missing";
  });
}

async function seedRunWithLease(
  pool: ReturnType<typeof createPool>,
  runId: string,
  runStatusVal: string,
  leaseId: string,
  opts: { expired: boolean; ownerWorker?: string; workitemId?: string },
): Promise<void> {
  await withTenantTx(pool, TENANT, async (c) => {
    await c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, workitem_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [runId, TENANT, SCENARIO_VERSION, runStatusVal, CORRELATION, opts.workitemId ?? null],
    );
    await c.query(
      `INSERT INTO browser_leases (
         id, tenant_id, site_profile_id, browser_identity_id, run_id, owner_worker_id,
         isolation, state, cleanup_policy, download_dir_ref, expires_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,'context','active','clear_all','lease://zombie',
               now() + ($7::int * interval '1 minute'))`,
      [leaseId, TENANT, SITE, IDENTITY, runId, opts.ownerWorker ?? WORKER, opts.expired ? -5 : 5],
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
        `INSERT INTO workers (id, kind, status, circuit_state) VALUES
         ($1::uuid,'browser','active','closed'), ($2::uuid,'browser','active','closed')`,
        [WORKER, OTHER_WORKER],
      );
    } finally {
      setup.release();
    }

    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved) VALUES ($1,$2,'z','https://z.example/*','green',true)`, [SITE, TENANT]);
      await c.query(`INSERT INTO browser_identities (id, tenant_id, site_profile_id, label) VALUES ($1,$2,$3,'z')`, [IDENTITY, TENANT, SITE]);
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'z')`, [SCENARIO, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
         VALUES ($1,$2,$3,1,'draft','{"nodes":[]}'::jsonb)`,
        [SCENARIO_VERSION, TENANT, SCENARIO],
      );
      await c.query(
        `INSERT INTO workitems (id, tenant_id, connector_id, unique_reference, status, attempts) VALUES ($1,$2,'z','wi-zombie','processing',0)`,
        [WORKITEM, TENANT],
      );
    });

    // 만료 lease + 비종결 run(전 5상태) → 종결 대상. RESUMING/RUNNING 등은 OTHER_WORKER 소유로도(cross-worker 회수 증명).
    await seedRunWithLease(pool, RUN_CLAIMED, "claimed", "1ea50000-0000-0000-0000-0000000000a1", { expired: true });
    await seedRunWithLease(pool, RUN_RUNNING, "running", "1ea50000-0000-0000-0000-0000000000a2", { expired: true, ownerWorker: OTHER_WORKER });
    await seedRunWithLease(pool, RUN_COMPLETING, "completing", "1ea50000-0000-0000-0000-0000000000a3", { expired: true });
    await seedRunWithLease(pool, RUN_SUSPENDING, "suspending", "1ea50000-0000-0000-0000-0000000000a4", { expired: true });
    await seedRunWithLease(pool, RUN_RESUMING, "resuming", "1ea50000-0000-0000-0000-0000000000a5", { expired: true, ownerWorker: OTHER_WORKER });
    // control: 미래 lease(살아있는 워커) → 회수 안 함.
    await seedRunWithLease(pool, RUN_FUTURE, "running", "1ea50000-0000-0000-0000-0000000000a6", { expired: false });
    // control: 이미 terminal → CAS no-op.
    await seedRunWithLease(pool, RUN_TERMINAL, "completed", "1ea50000-0000-0000-0000-0000000000a7", { expired: true });
    // 연결 workitem(processing) → run 종결 시 system 정산.
    await seedRunWithLease(pool, RUN_WI, "running", "1ea50000-0000-0000-0000-0000000000a8", { expired: true, workitemId: WORKITEM });

    const worker = new PgRuntimeWorker(pool, { workerId: WORKER });
    const sweep = await worker.handle({ kind: "lease_sweeper", tenantId: TENANT as TenantId });
    check("lease_sweeper completes", sweep.kind === "completed", JSON.stringify(sweep));

    for (const [label, runId] of [
      ["claimed", RUN_CLAIMED], ["running", RUN_RUNNING], ["completing", RUN_COMPLETING],
      ["suspending", RUN_SUSPENDING], ["resuming", RUN_RESUMING],
    ] as const) {
      check(`만료 lease 의 ${label} zombie run → failed_system`, (await runStatus(pool, runId)) === "failed_system", await runStatus(pool, runId));
    }
    check("미래 lease(살아있는 워커) run 은 회수 안 함(running 유지)", (await runStatus(pool, RUN_FUTURE)) === "running", await runStatus(pool, RUN_FUTURE));
    check("이미 terminal(completed) run 은 불변(CAS no-op)", (await runStatus(pool, RUN_TERMINAL)) === "completed", await runStatus(pool, RUN_TERMINAL));
    check("workitem 연결 run → failed_system", (await runStatus(pool, RUN_WI)) === "failed_system", await runStatus(pool, RUN_WI));
    check("연결 workitem 은 system 정산(W4 retry)", (await wiStatus(pool, WORKITEM)) === "retry", await wiStatus(pool, WORKITEM));

    // 멱등: 2회차 sweep 은 이미 expired lease(reserved/active 아님)를 재처리 안 함 → 변화 없음·오류 없음.
    const sweep2 = await worker.handle({ kind: "lease_sweeper", tenantId: TENANT as TenantId });
    check("2회차 lease_sweeper 멱등 completes", sweep2.kind === "completed", JSON.stringify(sweep2));
    check("멱등: claimed zombie 는 failed_system 유지", (await runStatus(pool, RUN_CLAIMED)) === "failed_system", await runStatus(pool, RUN_CLAIMED));
    check("멱등: future run 은 여전히 running", (await runStatus(pool, RUN_FUTURE)) === "running", await runStatus(pool, RUN_FUTURE));
  } finally {
    await pool.end();
  }

  if (failures > 0) { console.error(`\nFAIL: ${failures} check(s) failed`); process.exit(1); }
  console.log("\nPASS: zombie-run 회수 sweeper — 상태머신 감사 클러스터 B");
  process.exit(0);
}

void main();
