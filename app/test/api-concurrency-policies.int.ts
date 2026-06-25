/**
 * Integration test for /v1/credentials/concurrency (D5 동시성 정책 가시화).
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-concurrency-policies.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";
import type { Pool } from "pg";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import { createPool, withTenantTx } from "../src/db/pool";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_concurrency_int";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const SCEN_A = "9a000000-0000-4000-8000-000000000001";
const SVER_A = "9a000000-0000-4000-8000-000000000002";
const RUN_A = "9a100000-0000-4000-8000-000000000001";
const SITE_A = "9a400000-0000-4000-8000-000000000001";
const SCEN_B = "9b000000-0000-4000-8000-000000000001";
const SVER_B = "9b000000-0000-4000-8000-000000000002";
const SITE_B = "9b400000-0000-4000-8000-000000000001";

const SECRET = new TextEncoder().encode("concurrency-int-secret-do-not-use-in-prod-0123456789");

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
  return new SignJWT({ roles, tenant_id: tenant })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(SECRET);
}

async function seedScenario(pool: Pool, tenant: string, scenarioId: string, versionId: string): Promise<void> {
  await withTenantTx(pool, tenant, async (client) => {
    await client.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'concurrency')`, [scenarioId, tenant]);
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

  await withTenantTx(pool, TENANT_A, async (client) => {
    await client.query(`INSERT INTO site_profiles (id, tenant_id, name, url_pattern) VALUES ($1,$2,'급여시스템','https://hr.example/*')`, [SITE_A, TENANT_A]);
    await client.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, created_at, updated_at)
       VALUES ($1,$2,$3,'running',$1,now(),now())`,
      [RUN_A, TENANT_A, SVER_A],
    );
    // 정책 2건: cred-x(max 3, 리스 보유), cred-y(max 2, 리스 없음).
    await client.query(
      `INSERT INTO credential_concurrency_policies (tenant_id, credential_ref, site_profile_id, max_concurrency)
       VALUES ($1,'cred-x',$2,3), ($1,'cred-y',$2,2)`,
      [TENANT_A, SITE_A],
    );
    // cred-x 리스: slot0 active+미만료(집계), slot1 active+만료(제외), slot2 released(제외).
    await client.query(
      `INSERT INTO credential_leases (tenant_id, credential_ref, site_profile_id, slot_no, run_id, status, locked_until)
       VALUES
         ($1,'cred-x',$2,0,$3,'active',now() + interval '5 minutes'),
         ($1,'cred-x',$2,1,$3,'active',now() - interval '5 minutes'),
         ($1,'cred-x',$2,2,$3,'released',now() + interval '5 minutes')`,
      [TENANT_A, SITE_A, RUN_A],
    );
  });

  await withTenantTx(pool, TENANT_B, async (client) => {
    await client.query(`INSERT INTO site_profiles (id, tenant_id, name, url_pattern) VALUES ($1,$2,'b-site','https://b.example/*')`, [SITE_B, TENANT_B]);
    await client.query(
      `INSERT INTO credential_concurrency_policies (tenant_id, credential_ref, site_profile_id, max_concurrency)
       VALUES ($1,'cred-z',$2,1)`,
      [TENANT_B, SITE_B],
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

    const viewerA = await mint(["viewer"]);
    const viewerB = await mint(["viewer"], TENANT_B, "viewer-b");
    const noRole = await mint([]);

    const resA = await app.inject({ method: "GET", url: "/v1/credentials/concurrency", headers: { authorization: `Bearer ${viewerA}` } });
    check("viewer A → 200", resA.statusCode === 200, resA.body);
    const itemsA = resA.json().items as Array<{ credential_ref: string; max_concurrency: number; active_leases: number; site_name: string | null }>;
    check("정책 2건(cred-x, cred-y)", itemsA.length === 2, JSON.stringify(itemsA));
    const credX = itemsA.find((i) => i.credential_ref === "cred-x");
    const credY = itemsA.find((i) => i.credential_ref === "cred-y");
    check("cred-x max_concurrency=3", credX?.max_concurrency === 3, JSON.stringify(credX));
    check("cred-x active_leases=1(만료·released 제외)", credX?.active_leases === 1, JSON.stringify(credX));
    check("cred-x site_name=급여시스템", credX?.site_name === "급여시스템", JSON.stringify(credX));
    check("cred-y active_leases=0(리스 없음)", credY?.active_leases === 0, JSON.stringify(credY));
    check("RLS: tenant B 정책(cred-z) 미노출", !itemsA.some((i) => i.credential_ref === "cred-z"), JSON.stringify(itemsA));

    const resB = await app.inject({ method: "GET", url: "/v1/credentials/concurrency", headers: { authorization: `Bearer ${viewerB}` } });
    const itemsB = resB.json().items as Array<{ credential_ref: string }>;
    check("RLS: tenant B → 자기 정책(cred-z)만", itemsB.length === 1 && itemsB[0]?.credential_ref === "cred-z", resB.body);

    const resNoRole = await app.inject({ method: "GET", url: "/v1/credentials/concurrency", headers: { authorization: `Bearer ${noRole}` } });
    check("권한 없음 → 403", resNoRole.statusCode === 403, resNoRole.body);

    if (failures > 0) {
      console.error(`\nFAIL: ${failures} check(s) failed`);
      process.exit(1);
    }
    console.log("\nPASS: D5 concurrency policy read integration green");
  } finally {
    await app.close();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("FAIL: concurrency integration threw:", err);
  process.exit(1);
});
