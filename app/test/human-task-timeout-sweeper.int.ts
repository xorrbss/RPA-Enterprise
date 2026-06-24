/**
 * Human task timeout sweeper integration.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/human-task-timeout-sweeper.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CorrelationId, TenantId } from "../../ts/security-middleware-contract";
import { createPool, withTenantTx } from "../src/db/pool";
import { PgRuntimeWorker } from "../src/worker/runtime-worker";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_human_task_timeout_int";
const TENANT = "00000000-0000-0000-0000-00000000e001";
const SCENARIO = "10000000-0000-0000-0000-00000000e001";
const SVER = "10000000-0000-0000-0000-00000000e002";
const CORRELATION = "20000000-0000-0000-0000-00000000e001";

const RUN_FAIL = "30000000-0000-0000-0000-00000000e001";
const RUN_ESCALATE = "30000000-0000-0000-0000-00000000e002";
const RUN_ESCALATED_EXPIRE = "30000000-0000-0000-0000-00000000e003";
const RUN_FRESH = "30000000-0000-0000-0000-00000000e004";
const RUN_RUNNING = "30000000-0000-0000-0000-00000000e005";

const WI_FAIL = "40000000-0000-0000-0000-00000000e001";
const WI_ESCALATED_EXPIRE = "40000000-0000-0000-0000-00000000e003";

const HT_FAIL = "50000000-0000-0000-0000-00000000e001";
const HT_ESCALATE = "50000000-0000-0000-0000-00000000e002";
const HT_ESCALATED_EXPIRE = "50000000-0000-0000-0000-00000000e003";
const HT_FRESH = "50000000-0000-0000-0000-00000000e004";
const HT_RUNNING = "50000000-0000-0000-0000-00000000e005";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

type Pool = ReturnType<typeof createPool>;

async function taskState(pool: Pool, id: string): Promise<{ state: string; expires_at: Date | null }> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ state: string; expires_at: Date | null }>(
      `SELECT state, expires_at FROM human_tasks WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [TENANT, id],
    );
    const row = r.rows[0];
    return { state: row?.state ?? "missing", expires_at: row?.expires_at ?? null };
  });
}

async function runStatus(pool: Pool, id: string): Promise<string> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ status: string }>(`SELECT status FROM runs WHERE tenant_id=$1::uuid AND id=$2::uuid`, [TENANT, id]);
    return r.rows[0]?.status ?? "missing";
  });
}

async function workitemStatus(pool: Pool, id: string): Promise<string> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ status: string }>(`SELECT status FROM workitems WHERE tenant_id=$1::uuid AND id=$2::uuid`, [TENANT, id]);
    return r.rows[0]?.status ?? "missing";
  });
}

async function outboxCount(pool: Pool, runId: string, eventType: string): Promise<number> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events_outbox WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND event_type=$3`,
      [TENANT, runId, eventType],
    );
    return r.rows[0]?.n ?? 0;
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
    } finally {
      setup.release();
    }

    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'human-task-timeout')`, [SCENARIO, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
         VALUES ($1,$2,$3,1,'prod','{"nodes":[]}'::jsonb)`,
        [SVER, TENANT, SCENARIO],
      );
      await c.query(
        `INSERT INTO workitems (id, tenant_id, connector_id, unique_reference, status, attempts)
         VALUES ($1,$2,'rpa','wi-timeout-fail','processing',0),
                ($3,$2,'rpa','wi-timeout-escalated-expire','processing',0)`,
        [WI_FAIL, TENANT, WI_ESCALATED_EXPIRE],
      );
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, workitem_id, status, correlation_id)
         VALUES ($1,$2,$3,$4,'suspended',$10),
                ($5,$2,$3,NULL,'suspended',$10),
                ($6,$2,$3,$7,'suspended',$10),
                ($8,$2,$3,NULL,'suspended',$10),
                ($9,$2,$3,NULL,'running',$10)`,
        [
          RUN_FAIL,
          TENANT,
          SVER,
          WI_FAIL,
          RUN_ESCALATE,
          RUN_ESCALATED_EXPIRE,
          WI_ESCALATED_EXPIRE,
          RUN_FRESH,
          RUN_RUNNING,
          CORRELATION,
        ],
      );
      await c.query(
        `INSERT INTO human_tasks (id, tenant_id, run_id, kind, state, on_timeout, expires_at)
         VALUES ($1,$2,$3,'approval','open','fail',now() - interval '1 minute'),
                ($4,$2,$5,'approval','assigned','escalate',now() - interval '1 minute'),
                ($6,$2,$7,'approval','escalated','escalate',now() - interval '1 minute'),
                ($8,$2,$9,'approval','open','fail',now() + interval '1 hour'),
                ($10,$2,$11,'approval','open','fail',now() - interval '1 minute')`,
        [
          HT_FAIL,
          TENANT,
          RUN_FAIL,
          HT_ESCALATE,
          RUN_ESCALATE,
          HT_ESCALATED_EXPIRE,
          RUN_ESCALATED_EXPIRE,
          HT_FRESH,
          RUN_FRESH,
          HT_RUNNING,
          RUN_RUNNING,
        ],
      );
    });

    const worker = new PgRuntimeWorker(pool);
    const result = await worker.handle({
      kind: "human_task_timeout_sweeper",
      tenantId: TENANT as TenantId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("human_task_timeout_sweeper completed", result.kind === "completed", JSON.stringify(result));

    check("on_timeout=fail task expired", (await taskState(pool, HT_FAIL)).state === "expired");
    check("on_timeout=fail run failed_business", (await runStatus(pool, RUN_FAIL)) === "failed_business");
    check("linked workitem settled as failed_business", (await workitemStatus(pool, WI_FAIL)) === "failed_business");
    check("fail path emits human_task.expired", (await outboxCount(pool, RUN_FAIL, "human_task.expired")) === 1);
    check("fail path emits run.failed_business", (await outboxCount(pool, RUN_FAIL, "run.failed_business")) === 1);

    const escalated = await taskState(pool, HT_ESCALATE);
    check("on_timeout=escalate task escalated", escalated.state === "escalated", JSON.stringify(escalated));
    check("on_timeout=escalate extends deadline", escalated.expires_at !== null && escalated.expires_at.getTime() > Date.now(), String(escalated.expires_at));
    check("on_timeout=escalate leaves run suspended", (await runStatus(pool, RUN_ESCALATE)) === "suspended");
    check("escalate path emits human_task.escalated", (await outboxCount(pool, RUN_ESCALATE, "human_task.escalated")) === 1);

    check("escalated re-timeout expires task", (await taskState(pool, HT_ESCALATED_EXPIRE)).state === "expired");
    check("escalated re-timeout fails run", (await runStatus(pool, RUN_ESCALATED_EXPIRE)) === "failed_business");
    check("escalated re-timeout settles workitem", (await workitemStatus(pool, WI_ESCALATED_EXPIRE)) === "failed_business");

    check("future timeout task remains open", (await taskState(pool, HT_FRESH)).state === "open");
    check("non-suspended linked run remains running", (await runStatus(pool, RUN_RUNNING)) === "running");
    check("non-suspended linked task still expires", (await taskState(pool, HT_RUNNING)).state === "expired");

    const second = await worker.handle({
      kind: "human_task_timeout_sweeper",
      tenantId: TENANT as TenantId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("second sweep idempotent", second.kind === "completed" && (await taskState(pool, HT_ESCALATE)).state === "escalated", JSON.stringify(second));
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: human task timeout sweeper H4a/H4b/H8 integration green");
  process.exit(0);
}

main().catch((err) => {
  console.error("human-task-timeout-sweeper int fatal:", err);
  process.exit(1);
});
