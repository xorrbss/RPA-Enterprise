/**
 * D4.5 runtime-worker abort finalization integration gate.
 *
 * This proves RuntimeWorker owns abort drain completion: non-DB drain work runs
 * through an injected port, then R23/R24 finalization is persisted by tenant CAS.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type {
  RunAbortDrainInput,
  RunAbortDrainResult,
  RunAbortDrainer,
} from "../../ts/runtime-contract";
import type { CorrelationId, RunId, TenantId } from "../../ts/security-middleware-contract";
import { createPool, withTenantTx } from "../src/db/pool";
import { PgRuntimeWorker } from "../src/worker/runtime-worker";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_runtime_abort_int";

const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const WORKER = "10000000-0000-0000-0000-0000000000a1";
const OTHER_WORKER = "10000000-0000-0000-0000-0000000000b1";
const CORRELATION = "20000000-0000-0000-0000-0000000000a1";

const SCENARIO = "30000000-0000-0000-0000-0000000000a1";
const SCENARIO_VERSION = "30000000-0000-0000-0000-0000000000a2";
const SCENARIO_B = "30000000-0000-0000-0000-0000000000b1";
const SCENARIO_VERSION_B = "30000000-0000-0000-0000-0000000000b2";
const RUN_DRAIN = "31000000-0000-0000-0000-000000000001";
const RUN_TIMEOUT = "31000000-0000-0000-0000-000000000002";
const RUN_NO_LEASE = "31000000-0000-0000-0000-000000000003";
const RUN_TRANSIENT = "31000000-0000-0000-0000-000000000004";
const RUN_CANCELLED = "31000000-0000-0000-0000-000000000005";
const RUN_WRONG_WORKER = "31000000-0000-0000-0000-000000000006";
const RUN_MISSING_PORT = "31000000-0000-0000-0000-000000000007";
const RUN_MULTI_LEASE = "31000000-0000-0000-0000-000000000008";
const RUN_DUPLICATE = "31000000-0000-0000-0000-000000000009";
const RUN_EXPIRED_LEASE = "31000000-0000-0000-0000-00000000000a";
const RUN_MISSING_WORKER = "31000000-0000-0000-0000-00000000000b";
const RUN_NO_LEASE_RETAINED_WORKER = "31000000-0000-0000-0000-00000000000c";
const RUN_NO_DRAIN_ACTIVE_LEASE = "31000000-0000-0000-0000-00000000000d";
const RUN_B = "32000000-0000-0000-0000-000000000001";

const SITE = "40000000-0000-0000-0000-000000000001";
const IDENTITY = "40000000-0000-0000-0000-000000000002";
const LEASE_DRAIN = "50000000-0000-0000-0000-000000000001";
const LEASE_TIMEOUT = "50000000-0000-0000-0000-000000000002";
const LEASE_TRANSIENT = "50000000-0000-0000-0000-000000000003";
const LEASE_WRONG_WORKER = "50000000-0000-0000-0000-000000000004";
const LEASE_MISSING_PORT = "50000000-0000-0000-0000-000000000005";
const LEASE_MULTI_A = "50000000-0000-0000-0000-000000000006";
const LEASE_MULTI_B = "50000000-0000-0000-0000-000000000007";
const LEASE_DUPLICATE = "50000000-0000-0000-0000-000000000008";
const LEASE_EXPIRED = "50000000-0000-0000-0000-000000000009";
const LEASE_NO_DRAIN_ACTIVE = "50000000-0000-0000-0000-00000000000a";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

async function seedTenant(pool: ReturnType<typeof createPool>, tenantId: string): Promise<void> {
  const scenarioId = tenantId === TENANT_B ? SCENARIO_B : SCENARIO;
  const scenarioVersionId = tenantId === TENANT_B ? SCENARIO_VERSION_B : SCENARIO_VERSION;
  await withTenantTx(pool, tenantId, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,$3)`, [
      scenarioId,
      tenantId,
      `runtime-abort-${tenantId}`,
    ]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'draft','{"nodes":[]}'::jsonb)`,
      [scenarioVersionId, tenantId, scenarioId],
    );
  });
}

async function seedSitesAndWorkers(pool: ReturnType<typeof createPool>): Promise<void> {
  const setup = await pool.connect();
  try {
    await setup.query(
      `INSERT INTO workers (id, kind, status, circuit_state) VALUES
       ($1::uuid,'browser','active','closed'),
       ($2::uuid,'browser','active','closed')`,
      [WORKER, OTHER_WORKER],
    );
  } finally {
    setup.release();
  }

  await withTenantTx(pool, TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved)
       VALUES ($1,$2,'abort-finalize','https://abort-finalize.example/*','green',false)`,
      [SITE, TENANT_A],
    );
    await c.query(
      `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label)
       VALUES ($1,$2,$3,'abort-finalize')`,
      [IDENTITY, TENANT_A, SITE],
    );
  });
}

async function seedRun(
  pool: ReturnType<typeof createPool>,
  runId: string,
  status: "aborting" | "cancelled",
  workerId: string | null,
  abortSourceStatus: "running" | "suspended" | "resume_requested" | "resuming" | null,
  tenantId = TENANT_A,
): Promise<void> {
  const scenarioVersionId = tenantId === TENANT_B ? SCENARIO_VERSION_B : SCENARIO_VERSION;
  await withTenantTx(pool, tenantId, async (c) => {
    await c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, worker_id, abort_source_status, status, correlation_id)
       VALUES ($1,$2,$3,$4::uuid,$5,$6,$7)`,
      [runId, tenantId, scenarioVersionId, workerId, abortSourceStatus, status, CORRELATION],
    );
  });
}

async function seedLease(
  pool: ReturnType<typeof createPool>,
  leaseId: string,
  runId: string,
  workerId = WORKER,
  state: "active" | "reserved" | "draining" | "expired" = "active",
): Promise<void> {
  await withTenantTx(pool, TENANT_A, async (c) => {
    const expiresAt = state === "expired" ? "now() - interval '1 second'" : "now() + interval '5 minutes'";
    await c.query(
      `INSERT INTO browser_leases (
         id, tenant_id, site_profile_id, browser_identity_id, run_id, owner_worker_id,
         isolation, state, cleanup_policy, download_dir_ref, expires_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,'context',$7,'clear_all','lease://abort-finalize',${expiresAt})`,
      [leaseId, TENANT_A, SITE, IDENTITY, runId, workerId, state],
    );
  });
}

async function runStatus(pool: ReturnType<typeof createPool>, runId: string): Promise<string | null> {
  return withTenantTx(pool, TENANT_A, async (c) => {
    const row = await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [runId]);
    return row.rows[0]?.status ?? null;
  });
}

async function eventCount(pool: ReturnType<typeof createPool>, runId: string): Promise<number> {
  return withTenantTx(pool, TENANT_A, async (c) => {
    const row = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events_outbox WHERE run_id=$1::uuid AND event_type='run.cancelled'`,
      [runId],
    );
    return row.rows[0]?.n ?? -1;
  });
}

async function leaseState(pool: ReturnType<typeof createPool>, leaseId: string): Promise<string | null> {
  return withTenantTx(pool, TENANT_A, async (c) => {
    const row = await c.query<{ state: string }>(`SELECT state FROM browser_leases WHERE id=$1::uuid`, [leaseId]);
    return row.rows[0]?.state ?? null;
  });
}

function drainCallCount(calls: readonly RunAbortDrainInput[], runId: string): number {
  return calls.filter((call) => call.runId === (runId as RunId)).length;
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const drainCalls: RunAbortDrainInput[] = [];
  let duplicateDrainStarted: (() => void) | undefined;
  let finishDuplicateDrain: ((result: RunAbortDrainResult) => void) | undefined;
  const duplicateDrainStartedPromise = new Promise<void>((resolve) => {
    duplicateDrainStarted = resolve;
  });
  const drainer: RunAbortDrainer = {
    async drainAbort(input): Promise<RunAbortDrainResult> {
      drainCalls.push(input);
      if (input.runId === (RUN_DRAIN as RunId)) return { kind: "drained" };
      if (input.runId === (RUN_TIMEOUT as RunId)) return { kind: "timeout" };
      if (input.runId === (RUN_WRONG_WORKER as RunId)) return { kind: "drained" };
      if (input.runId === (RUN_DUPLICATE as RunId)) {
        duplicateDrainStarted?.();
        return new Promise<RunAbortDrainResult>((resolve) => {
          finishDuplicateDrain = resolve;
        });
      }
      if (input.runId === (RUN_TRANSIENT as RunId)) {
        return { kind: "transient_failed", retryAfterMs: 1234, reason: "browser still closing" };
      }
      return { kind: "terminal_failed", reason: `unexpected run ${input.runId}` };
    },
  };

  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
    } finally {
      setup.release();
    }
    await seedTenant(pool, TENANT_A);
    await seedTenant(pool, TENANT_B);
    await seedSitesAndWorkers(pool);
    await seedRun(pool, RUN_DRAIN, "aborting", WORKER, "running");
    await seedRun(pool, RUN_TIMEOUT, "aborting", WORKER, "running");
    await seedRun(pool, RUN_NO_LEASE, "aborting", null, "suspended");
    await seedRun(pool, RUN_TRANSIENT, "aborting", WORKER, "running");
    await seedRun(pool, RUN_CANCELLED, "cancelled", WORKER, "running");
    await seedRun(pool, RUN_WRONG_WORKER, "aborting", OTHER_WORKER, "running");
    await seedRun(pool, RUN_MISSING_PORT, "aborting", WORKER, "running");
    await seedRun(pool, RUN_MULTI_LEASE, "aborting", WORKER, "running");
    await seedRun(pool, RUN_DUPLICATE, "aborting", WORKER, "running");
    await seedRun(pool, RUN_EXPIRED_LEASE, "aborting", WORKER, "running");
    await seedRun(pool, RUN_MISSING_WORKER, "aborting", null, "running");
    await seedRun(pool, RUN_NO_LEASE_RETAINED_WORKER, "aborting", WORKER, "suspended");
    await seedRun(pool, RUN_NO_DRAIN_ACTIVE_LEASE, "aborting", WORKER, "resume_requested");
    await seedRun(pool, RUN_B, "aborting", WORKER, "running", TENANT_B);
    await seedLease(pool, LEASE_DRAIN, RUN_DRAIN);
    await seedLease(pool, LEASE_TIMEOUT, RUN_TIMEOUT);
    await seedLease(pool, LEASE_TRANSIENT, RUN_TRANSIENT);
    await seedLease(pool, LEASE_WRONG_WORKER, RUN_WRONG_WORKER, OTHER_WORKER);
    await seedLease(pool, LEASE_MISSING_PORT, RUN_MISSING_PORT);
    await seedLease(pool, LEASE_MULTI_A, RUN_MULTI_LEASE);
    await seedLease(pool, LEASE_MULTI_B, RUN_MULTI_LEASE);
    await seedLease(pool, LEASE_DUPLICATE, RUN_DUPLICATE);
    await seedLease(pool, LEASE_EXPIRED, RUN_EXPIRED_LEASE, WORKER, "expired");
    await seedLease(pool, LEASE_NO_DRAIN_ACTIVE, RUN_NO_DRAIN_ACTIVE_LEASE);
    console.log("seeded runtime abort finalization fixtures");

    const worker = new PgRuntimeWorker(pool, { workerId: WORKER, runAbortDrainer: drainer, runAbortTimeoutMs: 4321 });

    const drained = await worker.handle({
      kind: "run_abort",
      tenantId: TENANT_A as TenantId,
      runId: RUN_DRAIN as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_abort drained completes", drained.kind === "completed", JSON.stringify(drained));
    check("run_abort drained -> cancelled", (await runStatus(pool, RUN_DRAIN)) === "cancelled");
    check("run_abort drained emits run.cancelled once", (await eventCount(pool, RUN_DRAIN)) === 1);
    check("run_abort drained expires lease", (await leaseState(pool, LEASE_DRAIN)) === "expired");
    check("run_abort drainer sees timeout", drainCalls[0]?.timeoutMs === 4321, JSON.stringify(drainCalls[0]));

    const repeat = await worker.handle({
      kind: "run_abort",
      tenantId: TENANT_A as TenantId,
      runId: RUN_DRAIN as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_abort cancelled replay completes", repeat.kind === "completed", JSON.stringify(repeat));
    check("run_abort cancelled replay emits no duplicate", (await eventCount(pool, RUN_DRAIN)) === 1);

    const timedOut = await worker.handle({
      kind: "run_abort",
      tenantId: TENANT_A as TenantId,
      runId: RUN_TIMEOUT as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_abort timeout completes", timedOut.kind === "completed", JSON.stringify(timedOut));
    check("run_abort timeout -> cancelled", (await runStatus(pool, RUN_TIMEOUT)) === "cancelled");
    check("run_abort timeout emits run.cancelled once", (await eventCount(pool, RUN_TIMEOUT)) === 1);
    check("run_abort timeout expires lease", (await leaseState(pool, LEASE_TIMEOUT)) === "expired");

    const noLease = await worker.handle({
      kind: "run_abort",
      tenantId: TENANT_A as TenantId,
      runId: RUN_NO_LEASE as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_abort no-lease finalizes without port", noLease.kind === "completed", JSON.stringify(noLease));
    check("run_abort no-lease -> cancelled", (await runStatus(pool, RUN_NO_LEASE)) === "cancelled");
    check("run_abort no-lease emits run.cancelled once", (await eventCount(pool, RUN_NO_LEASE)) === 1);

    const retainedWorkerNoLease = await worker.handle({
      kind: "run_abort",
      tenantId: TENANT_A as TenantId,
      runId: RUN_NO_LEASE_RETAINED_WORKER as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_abort retained worker without lease completes", retainedWorkerNoLease.kind === "completed", JSON.stringify(retainedWorkerNoLease));
    check("run_abort retained worker without lease -> cancelled", (await runStatus(pool, RUN_NO_LEASE_RETAINED_WORKER)) === "cancelled");
    check("run_abort retained worker without lease emits once", (await eventCount(pool, RUN_NO_LEASE_RETAINED_WORKER)) === 1);
    check("run_abort retained worker without lease does not call drainer", drainCallCount(drainCalls, RUN_NO_LEASE_RETAINED_WORKER) === 0);

    const noDrainOpenLease = await worker.handle({
      kind: "run_abort",
      tenantId: TENANT_A as TenantId,
      runId: RUN_NO_DRAIN_ACTIVE_LEASE as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_abort no-drain source with open lease fails closed", noDrainOpenLease.kind === "failed", JSON.stringify(noDrainOpenLease));
    check("run_abort no-drain source with open lease stays aborting", (await runStatus(pool, RUN_NO_DRAIN_ACTIVE_LEASE)) === "aborting");
    check("run_abort no-drain source keeps active lease", (await leaseState(pool, LEASE_NO_DRAIN_ACTIVE)) === "active");
    check("run_abort no-drain source with open lease emits no event", (await eventCount(pool, RUN_NO_DRAIN_ACTIVE_LEASE)) === 0);

    const transient = await worker.handle({
      kind: "run_abort",
      tenantId: TENANT_A as TenantId,
      runId: RUN_TRANSIENT as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check(
      "run_abort transient defers",
      transient.kind === "deferred" && transient.retryAfterMs === 1234,
      JSON.stringify(transient),
    );
    check("run_abort transient leaves aborting", (await runStatus(pool, RUN_TRANSIENT)) === "aborting");
    check("run_abort transient keeps lease active", (await leaseState(pool, LEASE_TRANSIENT)) === "active");
    check("run_abort transient emits no run.cancelled", (await eventCount(pool, RUN_TRANSIENT)) === 0);
    check("run_abort transient releases drain claim", drainCallCount(drainCalls, RUN_TRANSIENT) === 1);

    const duplicateFirstPromise = worker.handle({
      kind: "run_abort",
      tenantId: TENANT_A as TenantId,
      runId: RUN_DUPLICATE as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    await duplicateDrainStartedPromise;
    const duplicateSecond = await worker.handle({
      kind: "run_abort",
      tenantId: TENANT_A as TenantId,
      runId: RUN_DUPLICATE as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check(
      "run_abort duplicate job defers while lease draining",
      duplicateSecond.kind === "deferred",
      JSON.stringify(duplicateSecond),
    );
    check("run_abort duplicate calls drainer once while in-flight", drainCallCount(drainCalls, RUN_DUPLICATE) === 1);
    check("run_abort duplicate leaves lease draining until first drain returns", (await leaseState(pool, LEASE_DUPLICATE)) === "draining");
    finishDuplicateDrain?.({ kind: "drained" });
    const duplicateFirst = await duplicateFirstPromise;
    check("run_abort first duplicate drain completes", duplicateFirst.kind === "completed", JSON.stringify(duplicateFirst));
    check("run_abort duplicate finalizes cancelled", (await runStatus(pool, RUN_DUPLICATE)) === "cancelled");
    check("run_abort duplicate expires lease", (await leaseState(pool, LEASE_DUPLICATE)) === "expired");
    check("run_abort duplicate emits once", (await eventCount(pool, RUN_DUPLICATE)) === 1);

    const wrongWorker = await worker.handle({
      kind: "run_abort",
      tenantId: TENANT_A as TenantId,
      runId: RUN_WRONG_WORKER as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_abort non-owner consumer completes via stored owner", wrongWorker.kind === "completed", JSON.stringify(wrongWorker));
    check("run_abort non-owner consumer -> cancelled", (await runStatus(pool, RUN_WRONG_WORKER)) === "cancelled");
    check("run_abort non-owner consumer expires owner lease", (await leaseState(pool, LEASE_WRONG_WORKER)) === "expired");

    const multiLease = await worker.handle({
      kind: "run_abort",
      tenantId: TENANT_A as TenantId,
      runId: RUN_MULTI_LEASE as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_abort multi-lease fails closed", multiLease.kind === "failed", JSON.stringify(multiLease));
    check("run_abort multi-lease leaves aborting", (await runStatus(pool, RUN_MULTI_LEASE)) === "aborting");
    check("run_abort multi-lease keeps first lease active", (await leaseState(pool, LEASE_MULTI_A)) === "active");
    check("run_abort multi-lease keeps second lease active", (await leaseState(pool, LEASE_MULTI_B)) === "active");

    const expiredLease = await worker.handle({
      kind: "run_abort",
      tenantId: TENANT_A as TenantId,
      runId: RUN_EXPIRED_LEASE as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_abort expired lease completes via timeout", expiredLease.kind === "completed", JSON.stringify(expiredLease));
    check("run_abort expired lease -> cancelled", (await runStatus(pool, RUN_EXPIRED_LEASE)) === "cancelled");
    check("run_abort expired lease emits run.cancelled once", (await eventCount(pool, RUN_EXPIRED_LEASE)) === 1);
    check("run_abort expired lease does not call drainer", drainCallCount(drainCalls, RUN_EXPIRED_LEASE) === 0);

    const missingWorker = await worker.handle({
      kind: "run_abort",
      tenantId: TENANT_A as TenantId,
      runId: RUN_MISSING_WORKER as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_abort running-source missing worker fails closed", missingWorker.kind === "failed", JSON.stringify(missingWorker));
    check("run_abort running-source missing worker leaves aborting", (await runStatus(pool, RUN_MISSING_WORKER)) === "aborting");
    check("run_abort running-source missing worker emits no event", (await eventCount(pool, RUN_MISSING_WORKER)) === 0);

    const crossTenant = await worker.handle({
      kind: "run_abort",
      tenantId: TENANT_B as TenantId,
      runId: RUN_DRAIN as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_abort cross-tenant run fails not found", crossTenant.kind === "failed" && crossTenant.code === "RUN_NOT_FOUND", JSON.stringify(crossTenant));
    check("run_abort cross-tenant leaves tenant A cancelled", (await runStatus(pool, RUN_DRAIN)) === "cancelled");

    try {
      await new PgRuntimeWorker(pool, { workerId: WORKER }).handle({
        kind: "run_abort",
        tenantId: TENANT_A as TenantId,
        runId: RUN_MISSING_PORT as RunId,
        correlationId: CORRELATION as CorrelationId,
      });
      check("run_abort missing drainer throws", false, "expected throw");
    } catch (err) {
      check("run_abort missing drainer throws", String(err).includes("RunAbortDrainer"), String(err));
    }
    check("run_abort missing drainer leaves aborting", (await runStatus(pool, RUN_MISSING_PORT)) === "aborting");
    check("run_abort missing drainer keeps lease active", (await leaseState(pool, LEASE_MISSING_PORT)) === "active");
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D4.5 runtime abort finalization integration green");
}

main().catch((err) => {
  console.error("FAIL: runtime abort finalization integration threw:", err);
  process.exit(1);
});
