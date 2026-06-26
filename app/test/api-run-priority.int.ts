/**
 * Integration test for POST /v1/runs/{run_id}/priority.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-run-priority.int.ts
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
const SCHEMA = "rpa_run_priority_int";
const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const SCENARIO_A = "13000000-0000-4000-8000-000000000001";
const SVER_A = "13000000-0000-4000-8000-000000000002";
const RUN_QUEUED = "13000000-0000-4000-8000-000000000003";
const RUN_RUNNING = "13000000-0000-4000-8000-000000000004";
const SCENARIO_B = "23000000-0000-4000-8000-000000000001";
const SVER_B = "23000000-0000-4000-8000-000000000002";
const RUN_B = "23000000-0000-4000-8000-000000000003";
const CORR_A = "33000000-0000-4000-8000-000000000031";
const CORR_B = "33000000-0000-4000-8000-000000000032";
const SECRET = new TextEncoder().encode("run-priority-int-secret-do-not-use-in-prod-0123456789");

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

function mint(roles: string[], tenant = TENANT_A, sub = "operator-a"): Promise<string> {
  return new SignJWT({ sub, tenant_id: tenant, roles })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(SECRET);
}

async function seedTenant(pool: ReturnType<typeof createPool>, tenant: string, scenarioId: string, versionId: string): Promise<void> {
  await withTenantTx(pool, tenant, async (client) => {
    await client.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1::uuid, $2::uuid, 'priority scenario')`, [
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

async function runPriority(pool: ReturnType<typeof createPool>, runId: string): Promise<string | null> {
  return withTenantTx(pool, TENANT_A, async (client) => {
    const result = await client.query<{ priority: string }>(`SELECT priority FROM runs WHERE id = $1::uuid`, [runId]);
    return result.rows[0]?.priority ?? null;
  });
}

async function auditReasonCount(pool: ReturnType<typeof createPool>, reason: string): Promise<number> {
  return withTenantTx(pool, TENANT_A, async (client) => {
    const row = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'run.prioritize' AND reason = $1`,
      [reason],
    );
    return row.rows[0]?.n ?? 0;
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const enqueued: RunEnqueueInput[] = [];
  const enqueuer: RunEnqueuer = {
    async enqueueRunClaim(_client, input) {
      enqueued.push(input);
    },
    async enqueueRunAbort() {},
    async enqueueSinkDeliver() {},
  };
  const app = buildServer({
    pool,
    auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
    rbac: new RoleMatrixRbacMiddleware(),
    idempotency: new PgControlPlaneIdempotencyStore(pool),
    enqueuer,
    signedCommandRegistry,
  });
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
    await app.ready();

    await seedTenant(pool, TENANT_A, SCENARIO_A, SVER_A);
    await seedTenant(pool, TENANT_B, SCENARIO_B, SVER_B);
    await withTenantTx(pool, TENANT_A, async (client) => {
      await client.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, priority, params, as_of, correlation_id)
         VALUES
           ($1::uuid, $2::uuid, $3::uuid, 'queued', 'medium', '{}'::jsonb, '2026-06-25T01:02:03Z', $4::uuid),
           ($5::uuid, $2::uuid, $3::uuid, 'running', 'medium', '{}'::jsonb, '2026-06-25T01:02:03Z', $6::uuid)`,
        [RUN_QUEUED, TENANT_A, SVER_A, CORR_A, RUN_RUNNING, CORR_B],
      );
    });
    await withTenantTx(pool, TENANT_B, async (client) => {
      await client.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, priority, params, as_of, correlation_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'queued', 'medium', '{}'::jsonb, now(), $1::uuid)`,
        [RUN_B, TENANT_B, SVER_B],
      );
    });

    const operator = await mint(["operator"]);
    const viewer = await mint(["viewer"]);
    const operatorB = await mint(["operator"], TENANT_B, "operator-b");

    const postPriority = (token: string, runId: string, key: string, body: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: `/v1/runs/${runId}/priority`,
        headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
        payload: body,
      });

    const promoted = await postPriority(operator, RUN_QUEUED, "priority-high", {
      priority: "high",
      reason: "customer deadline",
    });
    check("queued run priority -> 200", promoted.statusCode === 200 && promoted.json().priority === "high", promoted.body);
    check("run priority persisted", (await runPriority(pool, RUN_QUEUED)) === "high");
    check("priority change enqueues new run_claim with priority", enqueued.length === 1 && enqueued[0]?.priority === "high", JSON.stringify(enqueued));
    check("priority change audit appended", (await auditReasonCount(pool, "run_priority_changed")) === 1);

    const replay = await postPriority(operator, RUN_QUEUED, "priority-high", {
      priority: "high",
      reason: "customer deadline",
    });
    check("same idempotency key replays", replay.statusCode === 200 && replay.json().previous_priority === "medium", replay.body);
    check("replay does not enqueue again", enqueued.length === 1, JSON.stringify(enqueued));

    const unchanged = await postPriority(operator, RUN_QUEUED, "priority-same", { priority: "high" });
    check("same priority is accepted as audited no-op", unchanged.statusCode === 200 && unchanged.json().previous_priority === "high", unchanged.body);
    check("same priority does not enqueue duplicate", enqueued.length === 1, JSON.stringify(enqueued));
    check("same priority audit reason", (await auditReasonCount(pool, "run_priority_unchanged")) === 1);

    const badPriority = await postPriority(operator, RUN_QUEUED, "priority-bad", { priority: "urgent" });
    check("invalid priority -> 422", badPriority.statusCode === 422 && badPriority.json().details?.reason === "invalid_run_priority", badPriority.body);

    const running = await postPriority(operator, RUN_RUNNING, "priority-running", { priority: "critical" });
    check("running priority rejected -> 409", running.statusCode === 409 && running.json().details?.reason === "run_priority_requires_queued_status", running.body);

    const denied = await postPriority(viewer, RUN_QUEUED, "priority-viewer", { priority: "critical" });
    check("viewer priority denied -> 403", denied.statusCode === 403 && denied.json().code === "AUTHZ_FORBIDDEN", denied.body);

    const crossTenant = await postPriority(operatorB, RUN_QUEUED, "priority-cross", { priority: "critical" });
    check("cross-tenant run hidden -> 404", crossTenant.statusCode === 404 && crossTenant.json().code === "RUN_NOT_FOUND", crossTenant.body);
  } finally {
    await app.close();
    await pool.end();
  }
  if (failures > 0) {
    console.error(`\nFAIL: ${failures} run priority check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: /v1/runs/{run_id}/priority integration green");
}

main().catch((err) => {
  console.error("api-run-priority integration fatal:", err);
  process.exit(1);
});
