/**
 * Integration test for worker-side due run trigger processing.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/run-trigger-scheduler.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { type RunEnqueueInput, type RunEnqueuer } from "../src/api/run-queue";
import { createPool, withTenantTx } from "../src/db/pool";
import { PgRuntimeWorker } from "../src/worker/runtime-worker";
import { processDueRunTriggers, processRunTriggerFireJob } from "../src/worker/run-trigger-scheduler";
import type { RuntimeWorkerJob } from "../../ts/runtime-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_trigger_scheduler_int";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const SCENARIO_OK = "51000000-0000-4000-8000-0000000000a1";
const SVER_OK = "51000000-0000-4000-8000-0000000000a2";
const SCENARIO_BAD = "51000000-0000-4000-8000-0000000000a3";
const SVER_BAD = "51000000-0000-4000-8000-0000000000a4";
const SCENARIO_B = "51000000-0000-4000-8000-0000000000b1";
const SVER_B = "51000000-0000-4000-8000-0000000000b2";
const TRIGGER_DUE = "52000000-0000-4000-8000-0000000000a1";
const TRIGGER_CONCURRENT = "52000000-0000-4000-8000-0000000000a2";
const TRIGGER_BAD = "52000000-0000-4000-8000-0000000000a3";
const TRIGGER_B = "52000000-0000-4000-8000-0000000000b1";
const TRIGGER_CATCHUP = "52000000-0000-4000-8000-0000000000a4";
const TRIGGER_JOB = "52000000-0000-4000-8000-0000000000a5";
const TRIGGER_WORKER_JOB = "52000000-0000-4000-8000-0000000000a6";
const TRIGGER_IMPOSSIBLE = "52000000-0000-4000-8000-0000000000a7";
const RUN_ACTIVE = "53000000-0000-4000-8000-0000000000a1";
const FIRE_ACTIVE = "54000000-0000-4000-8000-0000000000a1";
const CORR_ACTIVE = "55000000-0000-4000-8000-0000000000a1";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

type Pool = ReturnType<typeof createPool>;

interface FireRow {
  trigger_id: string;
  status: string;
  run_id: string | null;
  fire_key: string;
  failure_reason: Record<string, unknown> | null;
}

interface RunRow {
  id: string;
  status: string;
  params: Record<string, unknown> | null;
  as_of: Date | null;
  correlation_id: string;
}

async function seedScenario(
  pool: Pool,
  tenant: string,
  scenario: string,
  sver: string,
  withTarget: boolean,
): Promise<void> {
  await withTenantTx(pool, tenant, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,$3)`, [
      scenario,
      tenant,
      `trigger-scheduler-int-${scenario.slice(-2)}`,
    ]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'draft',$4::jsonb)`,
      [
        sver,
        tenant,
        scenario,
        JSON.stringify(
          withTarget
            ? {
                nodes: [],
                target: {
                  site_profile_id: "00000000-0000-4000-8000-0000000000f1",
                  browser_identity_id: "00000000-0000-4000-8000-0000000000f2",
                  network_policy_id: "00000000-0000-4000-8000-0000000000f3",
                },
              }
            : { nodes: [] },
        ),
      ],
    );
  });
}

async function seedTriggers(pool: Pool): Promise<void> {
  await withTenantTx(pool, TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO run_triggers
         (id, tenant_id, scenario_version_id, status, cron_expression, timezone, params,
          catchup_policy, max_concurrent_runs, next_fire_at, created_by)
       VALUES
         ($1,$2,$3,'enabled','0 8 * * *','Asia/Seoul',$4::jsonb,'skip_missed',1,'2026-06-23T08:00:00Z','seed'),
         ($5,$2,$3,'enabled','5 8 * * *','Asia/Seoul',$6::jsonb,'skip_missed',1,'2026-06-23T08:05:00Z','seed'),
         ($7,$2,$8,'enabled','10 8 * * *','Asia/Seoul',$9::jsonb,'skip_missed',1,'2026-06-23T08:10:00Z','seed')`,
      [
        TRIGGER_DUE,
        TENANT_A,
        SVER_OK,
        JSON.stringify({ source: "due" }),
        TRIGGER_CONCURRENT,
        JSON.stringify({ source: "concurrent" }),
        TRIGGER_BAD,
        SVER_BAD,
        JSON.stringify({ source: "bad" }),
      ],
    );
    await c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, params, correlation_id, attempts, as_of)
       VALUES ($1,$2,$3,'running',$4::jsonb,$5,1,'2026-06-23T07:30:00Z')`,
      [RUN_ACTIVE, TENANT_A, SVER_OK, JSON.stringify({ source: "active" }), CORR_ACTIVE],
    );
    await c.query(
      `INSERT INTO run_trigger_fires
         (id, tenant_id, trigger_id, fire_key, status, scheduled_for, run_id, correlation_id)
       VALUES ($1,$2,$3,'2026-06-23T07:30:00.000Z','queued','2026-06-23T07:30:00Z',$4,$5)`,
      [FIRE_ACTIVE, TENANT_A, TRIGGER_CONCURRENT, RUN_ACTIVE, CORR_ACTIVE],
    );
  });
  await withTenantTx(pool, TENANT_B, (c) =>
    c.query(
      `INSERT INTO run_triggers
         (id, tenant_id, scenario_version_id, status, cron_expression, timezone, params,
          catchup_policy, max_concurrent_runs, next_fire_at, created_by)
       VALUES ($1,$2,$3,'enabled','0 8 * * *','Asia/Seoul','{}'::jsonb,'skip_missed',1,'2026-06-23T08:00:00Z','seed')`,
      [TRIGGER_B, TENANT_B, SVER_B],
    ),
  );
}

async function fires(pool: Pool, tenant: string): Promise<FireRow[]> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<FireRow>(
      `SELECT trigger_id::text, status, run_id::text, fire_key, failure_reason
         FROM run_trigger_fires
        ORDER BY scheduled_for, id`,
    );
    return r.rows;
  });
}

async function runsForSource(pool: Pool, source: string): Promise<RunRow[]> {
  return withTenantTx(pool, TENANT_A, async (c) => {
    const r = await c.query<RunRow>(
      `SELECT id::text, status, params, as_of, correlation_id::text
         FROM runs
        WHERE params ->> 'source' = $1
        ORDER BY created_at`,
      [source],
    );
    return r.rows;
  });
}

async function nextFireAt(pool: Pool, tenant: string, triggerId: string): Promise<string | null> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ next_fire_at: Date | null }>(
      `SELECT next_fire_at FROM run_triggers WHERE id=$1::uuid`,
      [triggerId],
    );
    return r.rows[0]?.next_fire_at?.toISOString() ?? null;
  });
}

async function triggerStatus(pool: Pool, tenant: string, triggerId: string): Promise<string | null> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ status: string }>(
      `SELECT status FROM run_triggers WHERE id=$1::uuid`,
      [triggerId],
    );
    return r.rows[0]?.status ?? null;
  });
}

async function seedFireOnceCatchupTrigger(pool: Pool): Promise<void> {
  await withTenantTx(pool, TENANT_A, (c) =>
    c.query(
      `INSERT INTO run_triggers
         (id, tenant_id, scenario_version_id, status, cron_expression, timezone, params,
          catchup_policy, max_concurrent_runs, next_fire_at, created_by)
       VALUES ($1,$2,$3,'enabled','0 8 * * *','Asia/Seoul',$4::jsonb,'fire_once',2,'2026-06-21T23:00:00Z','seed')`,
      [TRIGGER_CATCHUP, TENANT_A, SVER_OK, JSON.stringify({ source: "catchup" })],
    ),
  );
}

async function seedSingleCronTrigger(pool: Pool, triggerId: string, source: string, scheduledFor: string): Promise<void> {
  await withTenantTx(pool, TENANT_A, (c) =>
    c.query(
      `INSERT INTO run_triggers
         (id, tenant_id, scenario_version_id, status, cron_expression, timezone, params,
          catchup_policy, max_concurrent_runs, next_fire_at, created_by)
       VALUES ($1,$2,$3,'enabled','20 8 * * *','Asia/Seoul',$4::jsonb,'skip_missed',2,$5::timestamptz,'seed')`,
      [triggerId, TENANT_A, SVER_OK, JSON.stringify({ source }), scheduledFor],
    ),
  );
}

async function seedImpossibleCronTrigger(pool: Pool): Promise<void> {
  await withTenantTx(pool, TENANT_A, (c) =>
    c.query(
      `INSERT INTO run_triggers
         (id, tenant_id, scenario_version_id, status, cron_expression, timezone, params,
          catchup_policy, max_concurrent_runs, next_fire_at, created_by)
       VALUES ($1,$2,$3,'enabled','0 0 30 2 *','Asia/Seoul',$4::jsonb,'skip_missed',2,'2026-06-23T08:30:00Z','legacy-seed')`,
      [TRIGGER_IMPOSSIBLE, TENANT_A, SVER_OK, JSON.stringify({ source: "impossible_cron" })],
    ),
  );
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  try {
    const concurrencySql = readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8");
    const coreSql = readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8");
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(concurrencySql);
      await setup.query(coreSql);
    } finally {
      setup.release();
    }
    console.log("migrations applied (concurrency -> core)");

    await seedScenario(pool, TENANT_A, SCENARIO_OK, SVER_OK, true);
    await seedScenario(pool, TENANT_A, SCENARIO_BAD, SVER_BAD, false);
    await seedScenario(pool, TENANT_B, SCENARIO_B, SVER_B, true);
    await seedTriggers(pool);
    console.log("seeded due triggers");

    const enqueued: RunEnqueueInput[] = [];
    const enqueuer: RunEnqueuer = {
      async enqueueRunClaim(_client, input) {
        enqueued.push(input);
      },
      async enqueueRunAbort() {},
      async enqueueSinkDeliver() {},
    };
    let seq = 0;
    const stats = await processDueRunTriggers(pool, {
      tenantIds: [TENANT_A],
      enqueuer,
      now: () => new Date("2026-06-23T09:00:00Z"),
      correlationId: () => `55000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    });

    check("stats: one tenant scanned", stats.tenantsScanned === 1, JSON.stringify(stats));
    check("stats: three due triggers claimed", stats.triggersClaimed === 3, JSON.stringify(stats));
    check("stats: three fire ledgers created", stats.fireLedgersCreated === 3, JSON.stringify(stats));
    check("stats: one run queued", stats.runsQueued === 1, JSON.stringify(stats));
    check("stats: one skipped", stats.firesSkipped === 1, JSON.stringify(stats));
    check("stats: one failed", stats.firesFailed === 1, JSON.stringify(stats));

    const dueRuns = await runsForSource(pool, "due");
    check("due trigger creates one queued run", dueRuns.length === 1 && dueRuns[0]?.status === "queued", JSON.stringify(dueRuns));
    check(
      "due run freezes as_of to scheduled fire time",
      dueRuns[0]?.as_of?.toISOString() === "2026-06-23T08:00:00.000Z",
      JSON.stringify(dueRuns[0]),
    );
    check("due run_claim enqueued once", enqueued.length === 1 && enqueued[0]?.runId === dueRuns[0]?.id, JSON.stringify(enqueued));

    const fireRows = await fires(pool, TENANT_A);
    const dueFire = fireRows.find((row) => row.trigger_id === TRIGGER_DUE);
    const skippedFire = fireRows.find((row) => row.trigger_id === TRIGGER_CONCURRENT && row.run_id === null);
    const failedFire = fireRows.find((row) => row.trigger_id === TRIGGER_BAD);
    check("due fire ledger points at queued run", dueFire?.status === "queued" && dueFire.run_id === dueRuns[0]?.id, JSON.stringify(fireRows));
    check(
      "concurrency fire skipped without creating run",
      skippedFire?.status === "skipped" && skippedFire.failure_reason?.code === "MAX_CONCURRENCY_REACHED",
      JSON.stringify(fireRows),
    );
    check(
      "invalid scenario target fire recorded failed",
      failedFire?.status === "failed" && failedFire.failure_reason?.code === "IR_SCHEMA_INVALID",
      JSON.stringify(fireRows),
    );
    check("processed trigger advances next_fire_at", (await nextFireAt(pool, TENANT_A, TRIGGER_DUE)) === "2026-06-23T23:00:00.000Z");
    check("skipped trigger advances next_fire_at", (await nextFireAt(pool, TENANT_A, TRIGGER_CONCURRENT)) === "2026-06-23T23:05:00.000Z");
    check("failed trigger advances next_fire_at", (await nextFireAt(pool, TENANT_A, TRIGGER_BAD)) === "2026-06-23T23:10:00.000Z");
    check("unscanned tenant trigger remains due", (await nextFireAt(pool, TENANT_B, TRIGGER_B)) === "2026-06-23T08:00:00.000Z");

    const second = await processDueRunTriggers(pool, {
      tenantIds: [TENANT_A],
      enqueuer,
      now: () => new Date("2026-06-23T09:00:00Z"),
      correlationId: () => `55000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    });
    check("second poll finds no already-consumed fires", second.triggersClaimed === 0, JSON.stringify(second));
    check("second poll does not enqueue again", enqueued.length === 1, JSON.stringify(enqueued));

    await seedImpossibleCronTrigger(pool);
    const impossibleStats = await processDueRunTriggers(pool, {
      tenantIds: [TENANT_A],
      enqueuer,
      now: () => new Date("2026-06-23T09:00:00Z"),
      correlationId: () => `55000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    });
    const impossibleFire = (await fires(pool, TENANT_A)).find((row) => row.trigger_id === TRIGGER_IMPOSSIBLE);
    check("impossible cron creates failed fire ledger", impossibleStats.triggersClaimed === 1 && impossibleStats.firesFailed === 1 && impossibleFire?.status === "failed", JSON.stringify({ impossibleStats, impossibleFire }));
    check("impossible cron failure reason is loud", impossibleFire?.failure_reason?.code === "SCHEDULER_INVALID_CRON_EXPRESSION", JSON.stringify(impossibleFire));
    check("impossible cron pauses trigger instead of silent next_fire_at null", (await triggerStatus(pool, TENANT_A, TRIGGER_IMPOSSIBLE)) === "paused" && (await nextFireAt(pool, TENANT_A, TRIGGER_IMPOSSIBLE)) === null);
    check("impossible cron does not create run", (await runsForSource(pool, "impossible_cron")).length === 0);

    await seedSingleCronTrigger(pool, TRIGGER_JOB, "job", "2026-06-23T08:20:00Z");
    const beforeJobEnqueue = enqueued.length;
    const jobStats = await processRunTriggerFireJob(pool, {
      tenantId: TENANT_A,
      triggerId: TRIGGER_JOB,
      scheduledFor: "2026-06-23T08:20:00.000Z",
      enqueuer,
      now: () => new Date("2026-06-23T09:00:00Z"),
      correlationId: () => `55000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    });
    check("trigger_fire job claims one trigger", jobStats.triggersClaimed === 1 && jobStats.runsQueued === 1, JSON.stringify(jobStats));
    const jobRuns = await runsForSource(pool, "job");
    check("trigger_fire job creates queued run", jobRuns.length === 1 && jobRuns[0]?.status === "queued", JSON.stringify(jobRuns));
    check(
      "trigger_fire job freezes as_of to scheduled fire time",
      jobRuns[0]?.as_of?.toISOString() === "2026-06-23T08:20:00.000Z",
      JSON.stringify(jobRuns[0]),
    );
    check("trigger_fire job enqueues run_claim", enqueued.length === beforeJobEnqueue + 1 && enqueued[enqueued.length - 1]?.runId === jobRuns[0]?.id, JSON.stringify(enqueued));
    check("trigger_fire job advances next_fire_at", (await nextFireAt(pool, TENANT_A, TRIGGER_JOB)) === "2026-06-23T23:20:00.000Z");

    const staleJobStats = await processRunTriggerFireJob(pool, {
      tenantId: TENANT_A,
      triggerId: TRIGGER_JOB,
      scheduledFor: "2026-06-23T08:20:00.000Z",
      enqueuer,
      now: () => new Date("2026-06-23T09:00:00Z"),
      correlationId: () => `55000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    });
    check("stale trigger_fire job completes without duplicate run", staleJobStats.triggersClaimed === 0 && staleJobStats.runsQueued === 0, JSON.stringify(staleJobStats));
    check("stale trigger_fire job does not enqueue again", enqueued.length === beforeJobEnqueue + 1, JSON.stringify(enqueued));

    await seedSingleCronTrigger(pool, TRIGGER_WORKER_JOB, "worker_job", "2026-06-23T08:20:00Z");
    const runtimeJobs: RuntimeWorkerJob[] = [];
    const worker = new PgRuntimeWorker(pool, {
      runtimeJobEnqueuer: {
        async enqueueRuntimeJob(_client, job) {
          runtimeJobs.push(job);
        },
      },
    });
    const workerResult = await worker.handle({
      kind: "trigger_fire",
      tenantId: TENANT_A as RuntimeWorkerJob["tenantId"],
      triggerId: TRIGGER_WORKER_JOB,
      scheduledFor: "2026-06-23T08:20:00.000Z" as RuntimeWorkerJob["scheduledFor"],
      correlationId: "55000000-0000-4000-8000-000000000099" as RuntimeWorkerJob["correlationId"],
    });
    const workerRuns = await runsForSource(pool, "worker_job");
    check("RuntimeWorker trigger_fire completes", workerResult.kind === "completed", JSON.stringify(workerResult));
    check("RuntimeWorker trigger_fire creates queued run", workerRuns.length === 1 && workerRuns[0]?.status === "queued", JSON.stringify(workerRuns));
    check(
      "RuntimeWorker trigger_fire enqueues run_claim via runtimeJobEnqueuer",
      runtimeJobs.length === 1 && runtimeJobs[0]?.kind === "run_claim" && runtimeJobs[0]?.runId === workerRuns[0]?.id,
      JSON.stringify(runtimeJobs),
    );

    await seedFireOnceCatchupTrigger(pool);
    const catchupOne = await processDueRunTriggers(pool, {
      tenantIds: [TENANT_A],
      enqueuer,
      now: () => new Date("2026-06-23T09:00:00Z"),
      correlationId: () => `55000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    });
    check("fire_once catchup claims one missed fire", catchupOne.triggersClaimed === 1 && catchupOne.runsQueued === 1, JSON.stringify(catchupOne));
    check("fire_once advances to next missed occurrence", (await nextFireAt(pool, TENANT_A, TRIGGER_CATCHUP)) === "2026-06-22T23:00:00.000Z");

    const catchupTwo = await processDueRunTriggers(pool, {
      tenantIds: [TENANT_A],
      enqueuer,
      now: () => new Date("2026-06-23T09:00:00Z"),
      correlationId: () => `55000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    });
    check("fire_once catches up one additional missed fire per poll", catchupTwo.triggersClaimed === 1 && catchupTwo.runsQueued === 1, JSON.stringify(catchupTwo));
    check("fire_once stops catchup at next future occurrence", (await nextFireAt(pool, TENANT_A, TRIGGER_CATCHUP)) === "2026-06-23T23:00:00.000Z");
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: run trigger scheduler integration green");
}

main().catch((err) => {
  console.error("FAIL: run-trigger-scheduler integration threw:", err);
  process.exit(1);
});
