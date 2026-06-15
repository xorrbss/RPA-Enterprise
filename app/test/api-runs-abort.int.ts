/**
 * D4.5 integration test for POST /v1/runs/{run_id}/abort.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-runs-abort.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueueInput, RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import { createPool, withTenantTx } from "../src/db/pool";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_abort_int";

const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const SCENARIO_A = "30000000-0000-0000-0000-0000000000a3";
const SVER_A = "30000000-0000-0000-0000-0000000000a4";
const SCENARIO_B = "30000000-0000-0000-0000-0000000000b3";
const SVER_B = "30000000-0000-0000-0000-0000000000b4";
const ABSENT_RUN = "30000000-0000-0000-0000-0000000000ff";

const RUN_RUNNING = "31000000-0000-0000-0000-000000000001";
const RUN_QUEUED = "31000000-0000-0000-0000-000000000002";
const RUN_CLAIMED = "31000000-0000-0000-0000-000000000003";
const RUN_SUSPENDED = "31000000-0000-0000-0000-000000000004";
const RUN_RESUME_REQ = "31000000-0000-0000-0000-000000000005";
const RUN_RESUMING = "31000000-0000-0000-0000-000000000006";
const RUN_COMPLETING = "31000000-0000-0000-0000-000000000007";
const RUN_COMPLETED = "31000000-0000-0000-0000-000000000008";
const RUN_SUSPENDING = "31000000-0000-0000-0000-000000000009";
const RUN_ABORTING = "31000000-0000-0000-0000-00000000000a";
const RUN_IDEM = "31000000-0000-0000-0000-00000000000b";
const RUN_VIEWER = "31000000-0000-0000-0000-00000000000c";
const RUN_CLAIMED_MULTI = "31000000-0000-0000-0000-00000000000d";
const RUN_ABORTING_MALFORMED = "31000000-0000-0000-0000-00000000000e";
const RUN_B_RUNNING = "32000000-0000-0000-0000-000000000001";

const CLAIMED_WORKER = "33000000-0000-0000-0000-000000000001";
const CLAIMED_SITE = "33000000-0000-0000-0000-000000000002";
const CLAIMED_IDENTITY = "33000000-0000-0000-0000-000000000003";
const CLAIMED_LEASE = "33000000-0000-0000-0000-000000000004";
const RUNNING_LEASE = "33000000-0000-0000-0000-000000000005";
const RESUMING_LEASE = "33000000-0000-0000-0000-000000000006";
const CLAIMED_MULTI_LEASE_A = "33000000-0000-0000-0000-000000000007";
const CLAIMED_MULTI_LEASE_B = "33000000-0000-0000-0000-000000000008";

const SECRET = new TextEncoder().encode("d45-int-test-secret-do-not-use-in-prod-0123456789");
const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return { kind: "available", snapshot: { sourceRef: "secret://staging/registry" as SecretRef, commands: [] } };
  },
};

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function mint(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m").sign(SECRET);
}

type Pool = ReturnType<typeof createPool>;

async function seedScenario(pool: Pool, tenant: string, scenario: string, sver: string): Promise<void> {
  await withTenantTx(pool, tenant, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'d45')`, [scenario, tenant]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'draft','{"nodes":[]}'::jsonb)`,
      [sver, tenant, scenario],
    );
  });
}

async function seedRun(
  pool: Pool,
  tenant: string,
  sver: string,
  run: string,
  status: string,
  workerId?: string,
  abortSourceStatus?: "running" | "suspended" | "resume_requested" | "resuming" | null,
): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, worker_id, abort_source_status, correlation_id, attempts, as_of)
       VALUES ($1,$2,$3,$4,$5::uuid,$6,$1,1,'2026-06-15T00:00:00Z')`,
      [run, tenant, sver, status, workerId ?? null, abortSourceStatus ?? null],
    ),
  );
}

async function seedClaimedLease(pool: Pool): Promise<void> {
  await withTenantTx(pool, TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO workers (id, kind, status, circuit_state)
       VALUES ($1::uuid,'browser','active','closed')`,
      [CLAIMED_WORKER],
    );
    await c.query(
      `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved)
       VALUES ($1,$2,'abort-claimed','https://abort-claimed.example/*','green',false)`,
      [CLAIMED_SITE, TENANT_A],
    );
    await c.query(
      `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label)
       VALUES ($1,$2,$3,'abort-claimed')`,
      [CLAIMED_IDENTITY, TENANT_A, CLAIMED_SITE],
    );
    await c.query(
      `INSERT INTO browser_leases (
         id, tenant_id, site_profile_id, browser_identity_id, run_id, owner_worker_id,
         isolation, state, cleanup_policy, download_dir_ref, expires_at
       )
       VALUES
         ($1,$5,$6,$7,$10,$8,'context','active','clear_all','lease://abort-claimed', now() + interval '5 minutes'),
         ($2,$5,$6,$7,$11,$8,'context','active','clear_all','lease://abort-running', now() + interval '5 minutes'),
         ($3,$5,$6,$7,$12,$8,'context','active','clear_all','lease://abort-resuming', now() + interval '5 minutes'),
         ($4,$5,$6,$7,$13,$8,'context','active','clear_all','lease://abort-claimed-multi-a', now() + interval '5 minutes'),
         ($9,$5,$6,$7,$13,$8,'context','active','clear_all','lease://abort-claimed-multi-b', now() + interval '5 minutes')`,
      [
        CLAIMED_LEASE,
        RUNNING_LEASE,
        RESUMING_LEASE,
        CLAIMED_MULTI_LEASE_A,
        TENANT_A,
        CLAIMED_SITE,
        CLAIMED_IDENTITY,
        CLAIMED_WORKER,
        CLAIMED_MULTI_LEASE_B,
        RUN_CLAIMED,
        RUN_RUNNING,
        RUN_RESUMING,
        RUN_CLAIMED_MULTI,
      ],
    );
  });
}

async function statusOf(pool: Pool, tenant: string, run: string): Promise<string | null> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [run]);
    return r.rows[0]?.status ?? null;
  });
}

async function forceRunStatus(pool: Pool, tenant: string, run: string, status: string): Promise<void> {
  await withTenantTx(pool, tenant, async (c) => {
    await c.query(`UPDATE runs SET status=$3, updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid`, [
      tenant,
      run,
      status,
    ]);
  });
}

async function cancelledOutboxCount(pool: Pool, tenant: string, run: string): Promise<number> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events_outbox WHERE run_id=$1::uuid AND event_type='run.cancelled'`,
      [run],
    );
    return r.rows[0]?.n ?? 0;
  });
}

async function leaseState(pool: Pool, tenant: string, leaseId: string): Promise<string | null> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ state: string }>(`SELECT state FROM browser_leases WHERE id=$1::uuid`, [leaseId]);
    return r.rows[0]?.state ?? null;
  });
}

async function abortSourceStatusOf(pool: Pool, tenant: string, run: string): Promise<string | null> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ abort_source_status: string | null }>(
      `SELECT abort_source_status FROM runs WHERE id=$1::uuid`,
      [run],
    );
    return r.rows[0]?.abort_source_status ?? null;
  });
}

async function idemRowCount(pool: Pool, tenant: string, key: string): Promise<number> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM control_plane_idempotency_keys WHERE endpoint='abortRun' AND idempotency_key=$1`,
      [key],
    );
    return r.rows[0]?.n ?? 0;
  });
}

function enqueueCount(enqueued: readonly RunEnqueueInput[], runId: string): number {
  return enqueued.filter((item) => item.runId === runId).length;
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

    await seedScenario(pool, TENANT_A, SCENARIO_A, SVER_A);
    await seedScenario(pool, TENANT_B, SCENARIO_B, SVER_B);
    const seeds: Array<[string, string]> = [
      [RUN_RUNNING, "running"],
      [RUN_QUEUED, "queued"],
      [RUN_CLAIMED, "claimed"],
      [RUN_SUSPENDED, "suspended"],
      [RUN_RESUME_REQ, "resume_requested"],
      [RUN_RESUMING, "resuming"],
      [RUN_COMPLETING, "completing"],
      [RUN_COMPLETED, "completed"],
      [RUN_SUSPENDING, "suspending"],
      [RUN_ABORTING, "aborting"],
      [RUN_IDEM, "suspended"],
      [RUN_VIEWER, "running"],
      [RUN_CLAIMED_MULTI, "claimed"],
    ];
    for (const [run, status] of seeds) {
      await seedRun(
        pool,
        TENANT_A,
        SVER_A,
        run,
        status,
        run === RUN_CLAIMED || run === RUN_RUNNING || run === RUN_RESUMING || run === RUN_CLAIMED_MULTI
          ? CLAIMED_WORKER
          : undefined,
        run === RUN_ABORTING ? "running" : null,
      );
    }
    await seedRun(pool, TENANT_A, SVER_A, RUN_ABORTING_MALFORMED, "aborting", undefined, null);
    await seedClaimedLease(pool);
    await seedRun(pool, TENANT_B, SVER_B, RUN_B_RUNNING, "running");
    console.log("seeded runs across states");

    const abortEnqueued: RunEnqueueInput[] = [];
    const noopEnqueuer: RunEnqueuer = {
      async enqueueRunClaim() {},
      async enqueueRunAbort(_client, input) {
        abortEnqueued.push(input);
      },
    };
    const app = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer: noopEnqueuer,
      signedCommandRegistry,
    });
    await app.ready();
    try {
      const op = await mint({ sub: "op", tenant_id: TENANT_A, roles: ["operator"] });
      const viewer = await mint({ sub: "vi", tenant_id: TENANT_A, roles: ["viewer"] });

      const abort = (run: string, key: string, token = op, payload?: unknown) =>
        app.inject({
          method: "POST",
          url: `/v1/runs/${run}/abort`,
          headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
          payload: payload as object | undefined,
        });

      const noKey = await app.inject({
        method: "POST",
        url: `/v1/runs/${RUN_RUNNING}/abort`,
        headers: { authorization: `Bearer ${op}` },
      });
      check("missing Idempotency-Key -> 422", noKey.statusCode === 422, noKey.body);
      check("missing key -> IR_SCHEMA_INVALID", noKey.json().code === "IR_SCHEMA_INVALID", noKey.body);

      const badBody = await abort(RUN_RUNNING, "abort-badbody", op, { foo: 1 });
      check("unknown body field -> 422", badBody.statusCode === 422, badBody.body);
      check("unknown body -> IR_SCHEMA_INVALID", badBody.json().code === "IR_SCHEMA_INVALID", badBody.body);

      const runningAbort = await abort(RUN_RUNNING, "abort-running", op, { reason: "operator stop" });
      check("running abort -> 202 aborting", runningAbort.statusCode === 202 && runningAbort.json().status === "aborting", runningAbort.body);
      check("running -> DB aborting", (await statusOf(pool, TENANT_A, RUN_RUNNING)) === "aborting");
      check("running abort records source", (await abortSourceStatusOf(pool, TENANT_A, RUN_RUNNING)) === "running");
      check("running abort enqueues run_abort once", enqueueCount(abortEnqueued, RUN_RUNNING) === 1);
      check("running abort emits no run.cancelled yet", (await cancelledOutboxCount(pool, TENANT_A, RUN_RUNNING)) === 0);
      await forceRunStatus(pool, TENANT_A, RUN_RUNNING, "cancelled");
      const runningReplayAfterCancelled = await abort(RUN_RUNNING, "abort-running", op, { reason: "operator stop" });
      check(
        "running abort same-key replay after cancelled -> original 202 aborting",
        runningReplayAfterCancelled.statusCode === 202 && runningReplayAfterCancelled.json().status === "aborting",
        runningReplayAfterCancelled.body,
      );
      check("running replay after cancelled does not enqueue again", enqueueCount(abortEnqueued, RUN_RUNNING) === 1);

      const queuedAbort = await abort(RUN_QUEUED, "abort-queued");
      check("queued abort -> 202", queuedAbort.statusCode === 202, queuedAbort.body);
      check("queued abort body.status=cancelled", queuedAbort.json().status === "cancelled", queuedAbort.body);
      check("queued -> DB cancelled", (await statusOf(pool, TENANT_A, RUN_QUEUED)) === "cancelled");
      check("queued abort emits run.cancelled once", (await cancelledOutboxCount(pool, TENANT_A, RUN_QUEUED)) === 1);
      const queuedReplayAfterCancelled = await abort(RUN_QUEUED, "abort-queued");
      check(
        "queued abort same-key replay after cancelled -> 202 cancelled",
        queuedReplayAfterCancelled.statusCode === 202 && queuedReplayAfterCancelled.json().status === "cancelled",
        queuedReplayAfterCancelled.body,
      );
      check("queued replay after cancelled emits no duplicate", (await cancelledOutboxCount(pool, TENANT_A, RUN_QUEUED)) === 1);

      const claimedAbort = await abort(RUN_CLAIMED, "abort-claimed");
      check("claimed abort -> 202 cancelled", claimedAbort.statusCode === 202 && claimedAbort.json().status === "cancelled", claimedAbort.body);
      check("claimed -> DB cancelled", (await statusOf(pool, TENANT_A, RUN_CLAIMED)) === "cancelled");
      check("claimed abort emits run.cancelled once", (await cancelledOutboxCount(pool, TENANT_A, RUN_CLAIMED)) === 1);
      check("claimed abort expires browser lease", (await leaseState(pool, TENANT_A, CLAIMED_LEASE)) === "expired");
      const claimedReplayAfterCancelled = await abort(RUN_CLAIMED, "abort-claimed");
      check(
        "claimed abort same-key replay after cancelled -> 202 cancelled",
        claimedReplayAfterCancelled.statusCode === 202 && claimedReplayAfterCancelled.json().status === "cancelled",
        claimedReplayAfterCancelled.body,
      );
      check("claimed replay after cancelled emits no duplicate", (await cancelledOutboxCount(pool, TENANT_A, RUN_CLAIMED)) === 1);

      const claimedMultiAbort = await abort(RUN_CLAIMED_MULTI, "abort-claimed-multi");
      check("claimed abort with multiple leases -> 500", claimedMultiAbort.statusCode === 500, claimedMultiAbort.body);
      check("claimed multi -> DB claimed rollback", (await statusOf(pool, TENANT_A, RUN_CLAIMED_MULTI)) === "claimed");
      check("claimed multi keeps first lease active", (await leaseState(pool, TENANT_A, CLAIMED_MULTI_LEASE_A)) === "active");
      check("claimed multi keeps second lease active", (await leaseState(pool, TENANT_A, CLAIMED_MULTI_LEASE_B)) === "active");

      for (const [run, key] of [
        [RUN_SUSPENDED, "abort-suspended"],
        [RUN_RESUME_REQ, "abort-resumereq"],
      ] as const) {
        const res = await abort(run, key);
        check(`${key} -> 202 aborting`, res.statusCode === 202 && res.json().status === "aborting", res.body);
        check(`${key} -> DB aborting`, (await statusOf(pool, TENANT_A, run)) === "aborting");
        check(`${key} records source`, (await abortSourceStatusOf(pool, TENANT_A, run)) === (run === RUN_SUSPENDED ? "suspended" : "resume_requested"));
      }
      const resumingAbort = await abort(RUN_RESUMING, "abort-resuming");
      check("resuming abort -> 202 aborting", resumingAbort.statusCode === 202 && resumingAbort.json().status === "aborting", resumingAbort.body);
      check("resuming -> DB aborting", (await statusOf(pool, TENANT_A, RUN_RESUMING)) === "aborting");
      check("resuming abort records source", (await abortSourceStatusOf(pool, TENANT_A, RUN_RESUMING)) === "resuming");
      check("resuming abort enqueues run_abort once", enqueueCount(abortEnqueued, RUN_RESUMING) === 1);

      const alreadyAborting = await abort(RUN_ABORTING, "abort-aborting");
      check("aborting abort -> 202 aborting", alreadyAborting.statusCode === 202 && alreadyAborting.json().status === "aborting", alreadyAborting.body);
      check("aborting abort enqueues run_abort once", enqueueCount(abortEnqueued, RUN_ABORTING) === 1);

      const malformedAborting = await abort(RUN_ABORTING_MALFORMED, "abort-aborting-malformed");
      check("aborting missing source fails closed", malformedAborting.statusCode === 500, malformedAborting.body);
      check(
        "aborting missing source -> CONTROL_PLANE_INTERNAL_ERROR",
        malformedAborting.json().code === "CONTROL_PLANE_INTERNAL_ERROR",
        malformedAborting.body,
      );
      check("aborting missing source does not enqueue", enqueueCount(abortEnqueued, RUN_ABORTING_MALFORMED) === 0);

      const completingAbort = await abort(RUN_COMPLETING, "abort-completing");
      check("completing abort -> 409", completingAbort.statusCode === 409, completingAbort.body);
      check("completing -> RUN_ALREADY_TERMINAL", completingAbort.json().code === "RUN_ALREADY_TERMINAL", completingAbort.body);
      check("completing reject did not reserve key", (await idemRowCount(pool, TENANT_A, "abort-completing")) === 0);
      check("completing unchanged", (await statusOf(pool, TENANT_A, RUN_COMPLETING)) === "completing");

      const terminalAbort = await abort(RUN_COMPLETED, "abort-completed");
      check("completed abort -> 409 RUN_ALREADY_TERMINAL", terminalAbort.statusCode === 409 && terminalAbort.json().code === "RUN_ALREADY_TERMINAL", terminalAbort.body);

      const suspendingAbort = await abort(RUN_SUSPENDING, "abort-suspending");
      check("suspending abort -> 409", suspendingAbort.statusCode === 409, suspendingAbort.body);
      check("suspending -> WORKITEM_CHECKOUT_CONFLICT", suspendingAbort.json().code === "WORKITEM_CHECKOUT_CONFLICT", suspendingAbort.body);
      check("suspending reject did not reserve key", (await idemRowCount(pool, TENANT_A, "abort-suspending")) === 0);
      check("suspending unchanged", (await statusOf(pool, TENANT_A, RUN_SUSPENDING)) === "suspending");
      await forceRunStatus(pool, TENANT_A, RUN_SUSPENDING, "suspended");
      const suspendingRetry = await abort(RUN_SUSPENDING, "abort-suspending");
      check("suspending same-key retry after suspended -> 202 aborting", suspendingRetry.statusCode === 202 && suspendingRetry.json().status === "aborting", suspendingRetry.body);
      check("suspending retry records suspended source", (await abortSourceStatusOf(pool, TENANT_A, RUN_SUSPENDING)) === "suspended");

      const absentAbort = await abort(ABSENT_RUN, "abort-absent");
      check("absent run abort -> 404 RUN_NOT_FOUND", absentAbort.statusCode === 404 && absentAbort.json().code === "RUN_NOT_FOUND", absentAbort.body);

      const crossTenant = await abort(RUN_B_RUNNING, "abort-cross");
      check("cross-tenant abort -> 404 RUN_NOT_FOUND", crossTenant.statusCode === 404 && crossTenant.json().code === "RUN_NOT_FOUND", crossTenant.body);
      check("tenant B run untouched", (await statusOf(pool, TENANT_B, RUN_B_RUNNING)) === "running");
      check("cross-tenant abort key unused", (await idemRowCount(pool, TENANT_A, "abort-cross")) === 0);

      const viewerAbort = await abort(RUN_VIEWER, "abort-viewer", viewer);
      check("viewer abort -> 403", viewerAbort.statusCode === 403, viewerAbort.body);
      check("viewer abort -> AUTHZ_FORBIDDEN", viewerAbort.json().code === "AUTHZ_FORBIDDEN", viewerAbort.body);
      check("viewer deny did not reserve key", (await idemRowCount(pool, TENANT_A, "abort-viewer")) === 0);
      check("viewer run unchanged", (await statusOf(pool, TENANT_A, RUN_VIEWER)) === "running");

      const idem1 = await abort(RUN_IDEM, "abort-idem");
      check("idem first abort -> 202 aborting", idem1.statusCode === 202 && idem1.json().status === "aborting", idem1.body);
      const idem2 = await abort(RUN_IDEM, "abort-idem");
      check("idem replay -> 202 aborting (same response)", idem2.statusCode === 202 && idem2.json().status === "aborting", idem2.body);
      check("idem replay no extra run.cancelled", (await cancelledOutboxCount(pool, TENANT_A, RUN_IDEM)) === 0);
      check("idem replay does not enqueue again", enqueueCount(abortEnqueued, RUN_IDEM) === 1);

      const idemMismatch = await abort(RUN_IDEM, "abort-idem", op, { reason: "different" });
      check("idem same key diff body -> 412", idemMismatch.statusCode === 412, idemMismatch.body);
      check("idem mismatch -> SCENARIO_VERSION_CONFLICT", idemMismatch.json().code === "SCENARIO_VERSION_CONFLICT", idemMismatch.body);
    } finally {
      await app.close();
    }
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D4.5 run abort endpoint integration green");
}

main().catch((err) => {
  console.error("FAIL: integration test threw:", err);
  process.exit(1);
});
