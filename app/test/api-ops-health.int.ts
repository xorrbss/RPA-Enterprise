/**
 * Integration test for /v1/ops/health.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-ops-health.int.ts
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
const SCHEMA = "rpa_ops_health_int";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const SCEN_A = "9a000000-0000-4000-8000-000000000001";
const SVER_A = "9a000000-0000-4000-8000-000000000002";
const SCEN_B = "9b000000-0000-4000-8000-000000000001";
const SVER_B = "9b000000-0000-4000-8000-000000000002";
const RUN_STALE = "9a100000-0000-4000-8000-000000000001";
const RUN_FRESH = "9a100000-0000-4000-8000-000000000002";
const RUN_B = "9b100000-0000-4000-8000-000000000001";
const LEASE_ACTIVE_EXPIRED = "9a200000-0000-4000-8000-000000000001";
const LEASE_RESERVED = "9a200000-0000-4000-8000-000000000002";
const LEASE_B = "9b200000-0000-4000-8000-000000000001";
const WORKER_A = "9a300000-0000-4000-8000-000000000001";
const SITE_A = "9a400000-0000-4000-8000-000000000001";
const IDENTITY_A = "9a500000-0000-4000-8000-000000000001";
const SITE_B = "9b400000-0000-4000-8000-000000000001";
const IDENTITY_B = "9b500000-0000-4000-8000-000000000001";

const SECRET = new TextEncoder().encode("ops-health-int-secret-do-not-use-in-prod-0123456789");

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
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function mint(roles: string[], tenant = TENANT_A, sub = "viewer-a"): Promise<string> {
  return new SignJWT({ sub, tenant_id: tenant, roles })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(SECRET);
}

type Pool = ReturnType<typeof createPool>;

async function seedScenario(pool: Pool, tenant: string, scenarioId: string, versionId: string): Promise<void> {
  await withTenantTx(pool, tenant, async (client) => {
    await client.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'ops health')`, [scenarioId, tenant]);
    await client.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'prod','{"nodes":[],"target":{"site_profile_id":"00000000-0000-4000-8000-000000000001","browser_identity_id":"00000000-0000-4000-8000-000000000002","network_policy_id":"00000000-0000-4000-8000-000000000003"}}'::jsonb)`,
      [versionId, tenant, scenarioId],
    );
  });
}

async function seedHealth(pool: Pool): Promise<void> {
  await seedScenario(pool, TENANT_A, SCEN_A, SVER_A);
  await seedScenario(pool, TENANT_B, SCEN_B, SVER_B);

  await withTenantTx(pool, TENANT_A, async (client) => {
    await client.query(`INSERT INTO site_profiles (id, tenant_id, name, url_pattern) VALUES ($1,$2,'health-a','https://health-a.example/*')`, [SITE_A, TENANT_A]);
    await client.query(`INSERT INTO browser_identities (id, tenant_id, site_profile_id, label) VALUES ($1,$2,$3,'health-a')`, [IDENTITY_A, TENANT_A, SITE_A]);
    await client.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, created_at, updated_at)
       VALUES ($1,$2,$3,'running',$1,now() - interval '45 minutes',now() - interval '30 minutes'),
              ($4,$2,$3,'queued',$4,now() - interval '2 minutes',now() - interval '2 minutes')`,
      [RUN_STALE, TENANT_A, SVER_A, RUN_FRESH],
    );
    await client.query(
      `INSERT INTO browser_leases
         (id, tenant_id, site_profile_id, browser_identity_id, run_id, owner_worker_id, isolation, state, cleanup_policy, expires_at)
       VALUES
         ($1,$2,$3,$4,$5,$6,'context','active','preserve_session',now() - interval '5 minutes'),
         ($7,$2,$3,$4,null,$6,'context','reserved','clear_all',now() + interval '20 minutes')`,
      [LEASE_ACTIVE_EXPIRED, TENANT_A, SITE_A, IDENTITY_A, RUN_STALE, WORKER_A, LEASE_RESERVED],
    );
  });

  await withTenantTx(pool, TENANT_B, async (client) => {
    await client.query(`INSERT INTO site_profiles (id, tenant_id, name, url_pattern) VALUES ($1,$2,'health-b','https://health-b.example/*')`, [SITE_B, TENANT_B]);
    await client.query(`INSERT INTO browser_identities (id, tenant_id, site_profile_id, label) VALUES ($1,$2,$3,'health-b')`, [IDENTITY_B, TENANT_B, SITE_B]);
    await client.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, created_at, updated_at)
       VALUES ($1,$2,$3,'running',$1,now(),now())`,
      [RUN_B, TENANT_B, SVER_B],
    );
    await client.query(
      `INSERT INTO browser_leases
         (id, tenant_id, site_profile_id, browser_identity_id, run_id, owner_worker_id, isolation, state, cleanup_policy, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'context','active','preserve_session',now() + interval '20 minutes')`,
      [LEASE_B, TENANT_B, SITE_B, IDENTITY_B, RUN_B, WORKER_A],
    );
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const app = buildServer({
    pool,
    auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
    rbac: new RoleMatrixRbacMiddleware(),
    idempotency: new PgControlPlaneIdempotencyStore(pool),
    enqueuer: { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} } as RunEnqueuer,
    signedCommandRegistry,
  });
  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(`CREATE TABLE tenants (id uuid PRIMARY KEY)`);
      await setup.query(`INSERT INTO tenants (id) VALUES ($1::uuid), ($2::uuid)`, [TENANT_A, TENANT_B]);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
    } finally {
      setup.release();
    }
    await seedHealth(pool);
    await app.ready();

    const viewer = await mint(["viewer"]);
    const viewerB = await mint(["viewer"], TENANT_B, "viewer-b");
    const noRole = await mint([]);

    const health = await app.inject({ method: "GET", url: "/v1/ops/health", headers: { authorization: `Bearer ${viewer}` } });
    const body = health.json() as {
      status: string;
      queue: { available: boolean; pending_jobs: number | null };
      browser_leases: { active: number; reserved: number; expired_open: number };
      stale_runs: { nonterminal_over_15m: number; oldest_updated_at: string | null };
    };
    check("viewer ops health -> 200", health.statusCode === 200, health.body);
    check("expired active browser lease raises critical", body.status === "critical" && body.browser_leases.expired_open === 1, health.body);
    check("lease counts are tenant scoped", body.browser_leases.active === 1 && body.browser_leases.reserved === 1, health.body);
    check("stale nonterminal runs counted", body.stale_runs.nonterminal_over_15m === 1 && body.stale_runs.oldest_updated_at !== null, health.body);
    check("missing graphile schema is explicit", body.queue.available === false && body.queue.pending_jobs === null, health.body);

    const tenantB = await app.inject({ method: "GET", url: "/v1/ops/health", headers: { authorization: `Bearer ${viewerB}` } });
    const tenantBBody = tenantB.json() as { status: string; browser_leases: { active: number; expired_open: number }; stale_runs: { nonterminal_over_15m: number } };
    check("tenant B sees only tenant B health", tenantB.statusCode === 200 && tenantBBody.status === "ok" && tenantBBody.browser_leases.active === 1 && tenantBBody.browser_leases.expired_open === 0 && tenantBBody.stale_runs.nonterminal_over_15m === 0, tenantB.body);

    const denied = await app.inject({ method: "GET", url: "/v1/ops/health", headers: { authorization: `Bearer ${noRole}` } });
    check("no-role ops health denied -> 403", denied.statusCode === 403 && denied.json().code === "AUTHZ_FORBIDDEN", denied.body);
  } finally {
    await app.close();
    await pool.end();
  }
  if (failures > 0) {
    console.error(`FAIL: ${failures} ops health API check(s) failed`);
    process.exit(1);
  }
  console.log("PASS: ops health API integration green");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
