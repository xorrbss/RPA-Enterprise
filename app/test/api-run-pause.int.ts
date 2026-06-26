/**
 * Integration test for POST /v1/runs/{run_id}/pause.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-run-pause.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import { createPool, withTenantTx } from "../src/db/pool";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_run_pause_int";
const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const SCENARIO_A = "15000000-0000-4000-8000-000000000001";
const SVER_A = "15000000-0000-4000-8000-000000000002";
const RUN_RUNNING = "15000000-0000-4000-8000-000000000003";
const RUN_RUNNING_OPEN = "15000000-0000-4000-8000-000000000004";
const RUN_SUSP_OPERATOR = "15000000-0000-4000-8000-000000000005";
const RUN_SUSP_HUMAN = "15000000-0000-4000-8000-000000000006";
const RUN_COMPLETED = "15000000-0000-4000-8000-000000000007";
const RUN_BAD_BODY = "15000000-0000-4000-8000-000000000008";
const PAUSE_OPEN = "15000000-0000-4000-8000-000000000009";
const PAUSE_BOOKMARK = "15000000-0000-4000-8000-00000000000a";
const SCENARIO_B = "25000000-0000-4000-8000-000000000001";
const SVER_B = "25000000-0000-4000-8000-000000000002";
const RUN_B = "25000000-0000-4000-8000-000000000003";
const SECRET = new TextEncoder().encode("run-pause-int-secret-do-not-use-in-prod-0123456789");

const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return { kind: "available", snapshot: { sourceRef: "secret://staging/registry" as SecretRef, commands: [] } };
  },
};

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

type Pool = ReturnType<typeof createPool>;

function mint(roles: string[], tenant = TENANT_A, sub = "operator-a"): Promise<string> {
  return new SignJWT({ sub, tenant_id: tenant, roles })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(SECRET);
}

async function seedTenant(pool: Pool, tenant: string, scenarioId: string, versionId: string): Promise<void> {
  await withTenantTx(pool, tenant, async (client) => {
    await client.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1::uuid, $2::uuid, 'pause scenario')`, [
      scenarioId,
      tenant,
    ]);
    await client.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'prod', $4::jsonb)`,
      [
        versionId,
        tenant,
        scenarioId,
        JSON.stringify({
          target: {
            site_profile_id: "site-profile-a",
            browser_identity_id: "browser-identity-a",
            network_policy_id: "network-policy-a",
          },
          nodes: [],
        }),
      ],
    );
  });
}

async function runStatus(pool: Pool, runId: string): Promise<string | null> {
  return withTenantTx(pool, TENANT_A, async (client) => {
    const result = await client.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1::uuid`, [runId]);
    return result.rows[0]?.status ?? null;
  });
}

async function pauseRequestRows(pool: Pool, runId: string): Promise<readonly { id: string; status: string; requested_by: string; reason: string | null }[]> {
  return withTenantTx(pool, TENANT_A, async (client) => {
    const result = await client.query<{ id: string; status: string; requested_by: string; reason: string | null }>(
      `SELECT id::text, status, requested_by, reason
         FROM run_pause_requests
        WHERE run_id = $1::uuid
        ORDER BY created_at`,
      [runId],
    );
    return result.rows;
  });
}

async function auditReasonCount(pool: Pool, reason: string): Promise<number> {
  return withTenantTx(pool, TENANT_A, async (client) => {
    const result = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'run.pause' AND reason = $1`,
      [reason],
    );
    return result.rows[0]?.n ?? 0;
  });
}

async function idemRowCount(pool: Pool, key: string): Promise<number> {
  return withTenantTx(pool, TENANT_A, async (client) => {
    const result = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM control_plane_idempotency_keys
        WHERE endpoint = 'pauseRun'
          AND idempotency_key = $1`,
      [key],
    );
    return result.rows[0]?.n ?? 0;
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const noopEnqueuer: RunEnqueuer = {
    async enqueueRunClaim() {},
    async enqueueRunAbort() {},
    async enqueueSinkDeliver() {},
  };
  const app = buildServer({
    pool,
    auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
    rbac: new RoleMatrixRbacMiddleware(),
    idempotency: new PgControlPlaneIdempotencyStore(pool),
    enqueuer: noopEnqueuer,
    signedCommandRegistry,
  });

  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(`CREATE TABLE tenants (id uuid PRIMARY KEY)`);
      await setup.query(`INSERT INTO tenants (id) VALUES ($1::uuid), ($2::uuid)`, [TENANT_A, TENANT_B]);
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
    } finally {
      setup.release();
    }
    await app.ready();

    await seedTenant(pool, TENANT_A, SCENARIO_A, SVER_A);
    await seedTenant(pool, TENANT_B, SCENARIO_B, SVER_B);
    await withTenantTx(pool, TENANT_A, async (client) => {
      await client.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, params, as_of, correlation_id, bookmark)
         VALUES
           ($1::uuid, $2::uuid, $3::uuid, 'running', '{}'::jsonb, '2026-06-25T01:02:03Z', $1::uuid, NULL),
           ($4::uuid, $2::uuid, $3::uuid, 'running', '{}'::jsonb, '2026-06-25T01:02:03Z', $4::uuid, NULL),
           ($5::uuid, $2::uuid, $3::uuid, 'suspended', '{}'::jsonb, '2026-06-25T01:02:03Z', $5::uuid, $6::jsonb),
           ($7::uuid, $2::uuid, $3::uuid, 'suspended', '{}'::jsonb, '2026-06-25T01:02:03Z', $7::uuid, $8::jsonb),
           ($9::uuid, $2::uuid, $3::uuid, 'completed', '{}'::jsonb, '2026-06-25T01:02:03Z', $9::uuid, NULL),
           ($10::uuid, $2::uuid, $3::uuid, 'running', '{}'::jsonb, '2026-06-25T01:02:03Z', $10::uuid, NULL)`,
        [
          RUN_RUNNING,
          TENANT_A,
          SVER_A,
          RUN_RUNNING_OPEN,
          RUN_SUSP_OPERATOR,
          JSON.stringify({ reason: "operator_pause", pauseRequestId: PAUSE_BOOKMARK }),
          RUN_SUSP_HUMAN,
          JSON.stringify({ reason: "human_task" }),
          RUN_COMPLETED,
          RUN_BAD_BODY,
        ],
      );
      await client.query(
        `INSERT INTO run_pause_requests (id, tenant_id, run_id, requested_by, reason)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'operator-existing', 'already requested')`,
        [PAUSE_OPEN, TENANT_A, RUN_RUNNING_OPEN],
      );
    });
    await withTenantTx(pool, TENANT_B, async (client) => {
      await client.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, params, as_of, correlation_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'running', '{}'::jsonb, now(), $1::uuid)`,
        [RUN_B, TENANT_B, SVER_B],
      );
    });

    const operator = await mint(["operator"]);
    const viewer = await mint(["viewer"]);
    const operatorB = await mint(["operator"], TENANT_B, "operator-b");

    const postPause = (token: string, runId: string, key: string, body: Record<string, unknown> = {}) =>
      app.inject({
        method: "POST",
        url: `/v1/runs/${runId}/pause`,
        headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
        payload: body,
      });

    const noKey = await app.inject({
      method: "POST",
      url: `/v1/runs/${RUN_RUNNING}/pause`,
      headers: { authorization: `Bearer ${operator}` },
      payload: {},
    });
    check("missing Idempotency-Key -> 422", noKey.statusCode === 422 && noKey.json().code === "IR_SCHEMA_INVALID", noKey.body);

    const badBody = await postPause(operator, RUN_BAD_BODY, "pause-bad-body", { unexpected: true });
    check("unknown body field -> 422", badBody.statusCode === 422 && badBody.json().code === "IR_SCHEMA_INVALID", badBody.body);
    check("bad body does not reserve key", (await idemRowCount(pool, "pause-bad-body")) === 0);

    const emptyReason = await postPause(operator, RUN_BAD_BODY, "pause-empty-reason", { reason: "   " });
    check("empty reason -> 422", emptyReason.statusCode === 422 && emptyReason.json().details?.reason === "invalid_reason", emptyReason.body);
    check("empty reason does not reserve key", (await idemRowCount(pool, "pause-empty-reason")) === 0);

    const paused = await postPause(operator, RUN_RUNNING, "pause-running", { reason: "operator inspection" });
    const pausedBody = paused.json() as { pause_request_id?: string; status?: string; previous_status?: string };
    check("running pause -> 202 pause_requested", paused.statusCode === 202 && pausedBody.status === "pause_requested", paused.body);
    check("pause response includes previous running", pausedBody.previous_status === "running", paused.body);
    check("run remains running until worker accepts pause", (await runStatus(pool, RUN_RUNNING)) === "running");
    const rows = await pauseRequestRows(pool, RUN_RUNNING);
    check(
      "pause request row persisted",
      rows.length === 1 &&
        rows[0]?.id === pausedBody.pause_request_id &&
        rows[0]?.status === "requested" &&
        rows[0]?.requested_by === "operator-a" &&
        rows[0]?.reason === "operator inspection",
      JSON.stringify(rows),
    );
    check("run.pause_requested audit appended", (await auditReasonCount(pool, "run_pause_requested")) === 1);

    const replay = await postPause(operator, RUN_RUNNING, "pause-running", { reason: "operator inspection" });
    check("same idempotency key replays first response", replay.statusCode === 202 && replay.json().pause_request_id === pausedBody.pause_request_id, replay.body);
    check("replay does not duplicate request rows", (await pauseRequestRows(pool, RUN_RUNNING)).length === 1);
    check("replay does not append a second audit row", (await auditReasonCount(pool, "run_pause_requested")) === 1);

    const existing = await postPause(operator, RUN_RUNNING_OPEN, "pause-existing", { reason: "second operator" });
    check(
      "open pause request returns existing request -> 202",
      existing.statusCode === 202 && existing.json().pause_request_id === PAUSE_OPEN && existing.json().previous_status === "running",
      existing.body,
    );
    check("existing open request not duplicated", (await pauseRequestRows(pool, RUN_RUNNING_OPEN)).length === 1);
    check("run.pause replay audit appended", (await auditReasonCount(pool, "run_pause_replayed")) === 1);

    const alreadyOperatorPaused = await postPause(operator, RUN_SUSP_OPERATOR, "pause-already-operator");
    check(
      "operator-paused suspended run -> 200 suspended",
      alreadyOperatorPaused.statusCode === 200 && alreadyOperatorPaused.json().status === "suspended",
      alreadyOperatorPaused.body,
    );
    check("already operator-paused creates no pause request", (await pauseRequestRows(pool, RUN_SUSP_OPERATOR)).length === 0);
    check("already operator-paused audit appended", (await auditReasonCount(pool, "run_already_operator_paused")) === 1);

    const suspendedHuman = await postPause(operator, RUN_SUSP_HUMAN, "pause-suspended-human");
    check(
      "non-operator suspended pause rejected -> 409",
      suspendedHuman.statusCode === 409 && suspendedHuman.json().details?.reason === "run_pause_requires_running",
      suspendedHuman.body,
    );

    const terminal = await postPause(operator, RUN_COMPLETED, "pause-completed");
    check("completed pause rejected -> 409", terminal.statusCode === 409 && terminal.json().code === "RUN_ALREADY_TERMINAL", terminal.body);

    const denied = await postPause(viewer, RUN_RUNNING, "pause-viewer");
    check("viewer pause denied -> 403", denied.statusCode === 403 && denied.json().code === "AUTHZ_FORBIDDEN", denied.body);
    check("viewer deny does not reserve key", (await idemRowCount(pool, "pause-viewer")) === 0);

    const crossTenant = await postPause(operatorB, RUN_RUNNING, "pause-cross");
    check("cross-tenant run hidden -> 404", crossTenant.statusCode === 404 && crossTenant.json().code === "RUN_NOT_FOUND", crossTenant.body);
    check("tenant B operator cannot create tenant A pause row", (await pauseRequestRows(pool, RUN_RUNNING)).length === 1);

    const tenantBOwnRun = await postPause(operatorB, RUN_B, "pause-tenant-b-own");
    check("tenant B own running pause -> 202", tenantBOwnRun.statusCode === 202 && tenantBOwnRun.json().status === "pause_requested", tenantBOwnRun.body);
  } finally {
    await app.close();
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} run pause check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: /v1/runs/{run_id}/pause integration green");
}

main().catch((err) => {
  console.error("api-run-pause integration fatal:", err);
  process.exit(1);
});
