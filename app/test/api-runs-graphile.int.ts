/**
 * D4.3 integration test - POST /v1/runs uses the real Graphile enqueuer.
 *
 * This verifies enqueue evidence and the obsolete run_claim path after a
 * queued run is aborted before Graphile consumes the job.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runMigrations } from "graphile-worker";
import { SignJWT } from "jose";

import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";
import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import { PgGraphileRunEnqueuer, type RunEnqueueInput, type RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import { createPool, withTenantTx } from "../src/db/pool";
import { RUNTIME_JOB_TASK, runOnceRuntimeWorker } from "../src/worker/graphile-runner";
import type { BrowserLeasePlanResolver } from "../src/worker/runtime-worker";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_api_graphile_int";
const TENANT = "00000000-0000-0000-0000-0000000000d4";
const SCENARIO = "10000000-0000-0000-0000-0000000000d3";
const SVER = "10000000-0000-0000-0000-0000000000d4";
const WORKER = "10000000-0000-0000-0000-0000000000d5";
const SECRET = new TextEncoder().encode("d43-graphile-test-secret-do-not-use-in-prod");

const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return {
      kind: "available",
      snapshot: {
        sourceRef: "secret://staging/signed-command-registry" as SecretRef,
        commands: [],
      },
    };
  },
};

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function connectionString(): string {
  const host = process.env.PGHOST ?? "127.0.0.1";
  const port = process.env.PGPORT ?? "5432";
  const user = process.env.PGUSER ?? "postgres";
  const db = process.env.PGDATABASE ?? "postgres";
  return `postgres://${user}@${host}:${port}/${db}`;
}

function mint(): Promise<string> {
  return new SignJWT({ sub: "op", tenant_id: TENANT, roles: ["operator"] })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(SECRET);
}

async function seedScenario(pool: ReturnType<typeof createPool>): Promise<void> {
  await withTenantTx(pool, TENANT, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'graphile-run-create')`, [SCENARIO, TENANT]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'draft','{"nodes":[]}'::jsonb)`,
      [SVER, TENANT, SCENARIO],
    );
  });
}

async function graphilePayloadForRun(pool: ReturnType<typeof createPool>, runId: string): Promise<Record<string, unknown> | null> {
  const row = await pool.query<{ payload: unknown }>(
    `SELECT j.payload
       FROM graphile_worker._private_jobs j
       JOIN graphile_worker._private_tasks t ON t.id = j.task_id
      WHERE t.identifier = $1
        AND j.payload->>'runId' = $2`,
    [RUNTIME_JOB_TASK, runId],
  );
  return (row.rows[0]?.payload as Record<string, unknown> | undefined) ?? null;
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
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
    await runMigrations({ connectionString: connectionString() });
    await seedScenario(pool);
    console.log("migrations applied (app schema + graphile_worker)");

    const token = await mint();
    let staleRunClaimResolverCalls = 0;
    const staleRunClaimPlan: BrowserLeasePlanResolver = async () => {
      staleRunClaimResolverCalls += 1;
      throw new Error("obsolete run_claim must not resolve a browser lease plan");
    };
    const realEnqueuer = new PgGraphileRunEnqueuer();
    const app = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer: realEnqueuer,
      signedCommandRegistry,
    });
    await app.ready();
    let committedRunId = "";
    try {
      const created = await app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { authorization: `Bearer ${token}`, "idempotency-key": "graphile-run-create-ok" },
        payload: { scenario_version_id: SVER, params: { as_of: "2026-06-14T09:30:00Z" } },
      });
      check("POST /runs with PgGraphileRunEnqueuer -> 201", created.statusCode === 201, created.body);
      committedRunId = String(created.json().run_id);
      const payload = await graphilePayloadForRun(pool, committedRunId);
      check("Graphile run_claim job inserted", payload !== null, JSON.stringify(payload));
      check("Graphile payload kind", payload?.kind === "run_claim", JSON.stringify(payload));
      check("Graphile payload tenantId", payload?.tenantId === TENANT, JSON.stringify(payload));
      check("Graphile payload runId", payload?.runId === committedRunId, JSON.stringify(payload));
      check("Graphile payload correlationId", typeof payload?.correlationId === "string", JSON.stringify(payload));
      await withTenantTx(pool, TENANT, async (c) => {
        const rows = await c.query<{ runs: number; events: number }>(
          `SELECT
             (SELECT count(*)::int FROM runs WHERE id=$1::uuid) AS runs,
             (SELECT count(*)::int FROM events_outbox WHERE run_id=$1::uuid AND event_type='run.created') AS events`,
          [committedRunId],
        );
        check("run row committed", rows.rows[0]?.runs === 1, JSON.stringify(rows.rows[0]));
        check("run.created outbox committed", rows.rows[0]?.events === 1, JSON.stringify(rows.rows[0]));
      });
      const aborted = await app.inject({
        method: "POST",
        url: `/v1/runs/${committedRunId}/abort`,
        headers: { authorization: `Bearer ${token}`, "idempotency-key": "graphile-run-abort-before-worker" },
      });
      check("queued graphile run aborts before worker -> 202", aborted.statusCode === 202, aborted.body);
      check("queued graphile run abort body.status=cancelled", aborted.json().status === "cancelled", aborted.body);
    } finally {
      await app.close();
    }

    await runOnceRuntimeWorker(connectionString(), pool, {
      workerId: WORKER,
      browserLeasePlanResolver: staleRunClaimPlan,
    });
    check("obsolete run_claim does not invoke lease resolver", staleRunClaimResolverCalls === 0);
    check("obsolete run_claim job consumed", (await graphilePayloadForRun(pool, committedRunId)) === null);

    let attemptedRollbackRunId: string | null = null;
    const rollbackEnqueuer: RunEnqueuer = {
      async enqueueRunClaim(client, input: RunEnqueueInput) {
        attemptedRollbackRunId = input.runId;
        await realEnqueuer.enqueueRunClaim(client, input);
        throw new Error("test rollback after graphile enqueue");
      },
      async enqueueRunAbort(client, input: RunEnqueueInput) {
        await realEnqueuer.enqueueRunAbort(client, input);
      },
    };
    const rollbackApp = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer: rollbackEnqueuer,
      signedCommandRegistry,
    });
    await rollbackApp.ready();
    try {
      const failed = await rollbackApp.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { authorization: `Bearer ${token}`, "idempotency-key": "graphile-run-create-rollback" },
        payload: { scenario_version_id: SVER, params: { as_of: "2026-06-14T09:31:00Z" } },
      });
      check("forced enqueue failure -> 500", failed.statusCode === 500, failed.body);
    } finally {
      await rollbackApp.close();
    }

    check("rollback captured attempted run id", attemptedRollbackRunId !== null);
    if (attemptedRollbackRunId !== null) {
      const payload = await graphilePayloadForRun(pool, attemptedRollbackRunId);
      check("Graphile job rolled back with API tx", payload === null, JSON.stringify(payload));
      await withTenantTx(pool, TENANT, async (c) => {
        const rows = await c.query<{ runs: number; events: number }>(
          `SELECT
             (SELECT count(*)::int FROM runs WHERE id=$1::uuid) AS runs,
             (SELECT count(*)::int FROM events_outbox WHERE run_id=$1::uuid) AS events`,
          [attemptedRollbackRunId],
        );
        check("run row rolled back", rows.rows[0]?.runs === 0, JSON.stringify(rows.rows[0]));
        check("outbox row rolled back", rows.rows[0]?.events === 0, JSON.stringify(rows.rows[0]));
      });
    }
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D4.3 API run create Graphile enqueue integration green");
}

main().catch((err) => {
  console.error("FAIL: api-runs-graphile integration threw:", err);
  process.exit(1);
});
