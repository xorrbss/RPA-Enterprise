/**
 * Integration test for /v1/bot-pools.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-bot-pools.int.ts
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
const SCHEMA = "rpa_bot_pools_int";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const SCEN_A = "8a000000-0000-4000-8000-000000000001";
const SVER_A = "8a000000-0000-4000-8000-000000000002";
const SCEN_B = "8b000000-0000-4000-8000-000000000001";
const SVER_B = "8b000000-0000-4000-8000-000000000002";
const RUN_PENDING = "8a100000-0000-4000-8000-000000000001";
const RUN_B = "8b100000-0000-4000-8000-000000000001";
const TRIGGER_DUE = "8a600000-0000-4000-8000-000000000001";
const LEASE_A_EXPIRED = "8a200000-0000-4000-8000-000000000001";
const LEASE_A_RESERVED = "8a200000-0000-4000-8000-000000000002";
const LEASE_B = "8b200000-0000-4000-8000-000000000001";
const WORKER_ACTIVE = "8a300000-0000-4000-8000-000000000001";
const WORKER_STALE = "8a300000-0000-4000-8000-000000000002";
const SITE_A = "8a400000-0000-4000-8000-000000000001";
const IDENTITY_A = "8a500000-0000-4000-8000-000000000001";
const SITE_B = "8b400000-0000-4000-8000-000000000001";
const IDENTITY_B = "8b500000-0000-4000-8000-000000000001";

const SECRET = new TextEncoder().encode("bot-pools-int-secret-do-not-use-in-prod-0123456789");

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
    await client.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'bot pool')`, [scenarioId, tenant]);
    await client.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'prod','{"nodes":[]}'::jsonb)`,
      [versionId, tenant, scenarioId],
    );
  });
}

async function seed(pool: Pool): Promise<void> {
  await seedScenario(pool, TENANT_A, SCEN_A, SVER_A);
  await seedScenario(pool, TENANT_B, SCEN_B, SVER_B);

  const direct = await pool.connect();
  try {
    await direct.query(`SET search_path = ${SCHEMA}, public`);
    await direct.query(
      `INSERT INTO workers (id, kind, status, heartbeat_at, circuit_state)
       VALUES
         ($1,'browser','active',now(),'closed'),
         ($2,'browser','active',now() - interval '5 minutes','closed')`,
      [WORKER_ACTIVE, WORKER_STALE],
    );
  } finally {
    direct.release();
  }

  await withTenantTx(pool, TENANT_A, async (client) => {
    await client.query(`INSERT INTO site_profiles (id, tenant_id, name, url_pattern) VALUES ($1,$2,'pool-a','https://pool-a.example/*')`, [SITE_A, TENANT_A]);
    await client.query(`INSERT INTO browser_identities (id, tenant_id, site_profile_id, label) VALUES ($1,$2,$3,'pool-a')`, [IDENTITY_A, TENANT_A, SITE_A]);
    await client.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, created_at, updated_at)
       VALUES ($1,$2,$3,'queued',$1,now(),now())`,
      [RUN_PENDING, TENANT_A, SVER_A],
    );
    await client.query(
      `INSERT INTO run_triggers
         (id, tenant_id, scenario_version_id, trigger_type, status, cron_expression, timezone, params, next_fire_at, created_by)
       VALUES ($1,$2,$3,'cron','enabled','0 9 * * *','Asia/Seoul','{}'::jsonb,now() - interval '1 minute','operator')`,
      [TRIGGER_DUE, TENANT_A, SVER_A],
    );
    await client.query(
      `INSERT INTO browser_leases
         (id, tenant_id, site_profile_id, browser_identity_id, run_id, owner_worker_id, isolation, state, cleanup_policy, expires_at)
       VALUES
         ($1,$2,$3,$4,$5,$6,'context','active','preserve_session',now() - interval '5 minutes'),
         ($7,$2,$3,$4,null,$6,'context','reserved','clear_all',now() + interval '20 minutes')`,
      [LEASE_A_EXPIRED, TENANT_A, SITE_A, IDENTITY_A, RUN_PENDING, WORKER_ACTIVE, LEASE_A_RESERVED],
    );
  });

  await withTenantTx(pool, TENANT_B, async (client) => {
    await client.query(`INSERT INTO site_profiles (id, tenant_id, name, url_pattern) VALUES ($1,$2,'pool-b','https://pool-b.example/*')`, [SITE_B, TENANT_B]);
    await client.query(`INSERT INTO browser_identities (id, tenant_id, site_profile_id, label) VALUES ($1,$2,$3,'pool-b')`, [IDENTITY_B, TENANT_B, SITE_B]);
    await client.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, created_at, updated_at)
       VALUES ($1,$2,$3,'running',$1,now(),now())`,
      [RUN_B, TENANT_B, SVER_B],
    );
    await client.query(
      `INSERT INTO browser_leases
         (id, tenant_id, site_profile_id, browser_identity_id, run_id, owner_worker_id, isolation, state, cleanup_policy, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'context','active','preserve_session',now() + interval '20 minutes')`,
      [LEASE_B, TENANT_B, SITE_B, IDENTITY_B, RUN_B, WORKER_ACTIVE],
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
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
    } finally {
      setup.release();
    }
    await seed(pool);
    await app.ready();

    const viewer = await mint(["viewer"]);
    const viewerB = await mint(["viewer"], TENANT_B, "viewer-b");
    const noRole = await mint([]);

    const pools = await app.inject({ method: "GET", url: "/v1/bot-pools", headers: { authorization: `Bearer ${viewer}` } });
    const body = pools.json() as { items: Array<{ health: string; capacity_slots: number; workers: { active: number; stale: number }; leases: { active: number; reserved: number; expired_open: number }; queue: { pending_runs: number; due_triggers: number } }> };
    const poolItem = body.items[0];
    check("viewer bot pools -> 200", pools.statusCode === 200 && body.items.length === 1, pools.body);
    check("capacity excludes stale browser workers", poolItem?.capacity_slots === 1 && poolItem.workers.stale === 1, pools.body);
    check("tenant A lease and queue counts", poolItem?.leases.active === 1 && poolItem.leases.reserved === 1 && poolItem.queue.pending_runs === 1 && poolItem.queue.due_triggers === 1, pools.body);
    check("expired active lease raises critical", poolItem?.health === "critical" && poolItem.leases.expired_open === 1, pools.body);

    const poolsB = await app.inject({ method: "GET", url: "/v1/bot-pools", headers: { authorization: `Bearer ${viewerB}` } });
    const bodyB = poolsB.json() as { items: Array<{ leases: { active: number; expired_open: number }; queue: { pending_runs: number; due_triggers: number } }> };
    const poolB = bodyB.items[0];
    check("tenant B sees tenant-scoped leases/queue", poolsB.statusCode === 200 && poolB?.leases.active === 1 && poolB.leases.expired_open === 0 && poolB.queue.pending_runs === 0 && poolB.queue.due_triggers === 0, poolsB.body);

    const denied = await app.inject({ method: "GET", url: "/v1/bot-pools", headers: { authorization: `Bearer ${noRole}` } });
    check("no-role bot pools denied -> 403", denied.statusCode === 403 && denied.json().code === "AUTHZ_FORBIDDEN", denied.body);
  } finally {
    await app.close();
    await pool.end();
  }
  if (failures > 0) {
    console.error(`FAIL: ${failures} bot pool API check(s) failed`);
    process.exit(1);
  }
  console.log("PASS: bot pools API integration green");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
