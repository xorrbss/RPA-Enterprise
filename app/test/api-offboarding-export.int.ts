/**
 * Integration test for /v1/offboarding/export.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-offboarding-export.int.ts
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
const SCHEMA = "rpa_offboarding_export_int";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const SCEN_A = "10000000-0000-4000-8000-0000000000a1";
const SVER_A = "11000000-0000-4000-8000-0000000000a1";
const RUN_A = "12000000-0000-4000-8000-0000000000a1";
const RUN_OLD = "12000000-0000-4000-8000-0000000000a2";
const TASK_A = "13000000-0000-4000-8000-0000000000a1";
const TASK_OLD = "13000000-0000-4000-8000-0000000000a2";
const ART_VISIBLE = "14000000-0000-4000-8000-0000000000a1";
const ART_PENDING = "14000000-0000-4000-8000-0000000000a2";
const ART_QUARANTINED = "14000000-0000-4000-8000-0000000000a3";
const ART_DELETED = "14000000-0000-4000-8000-0000000000a4";
const ART_OLD = "14000000-0000-4000-8000-0000000000a5";
const SCEN_B = "10000000-0000-4000-8000-0000000000b1";
const SVER_B = "11000000-0000-4000-8000-0000000000b1";
const RUN_B = "12000000-0000-4000-8000-0000000000b1";
const TASK_B = "13000000-0000-4000-8000-0000000000b1";
const ART_B = "14000000-0000-4000-8000-0000000000b1";

const SECRET = new TextEncoder().encode("offboarding-export-int-secret-do-not-use-in-prod");
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

function mint(roles: string[], tenant = TENANT_A, sub = "admin-a"): Promise<string> {
  return new SignJWT({ sub, tenant_id: tenant, roles })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(SECRET);
}

type Pool = ReturnType<typeof createPool>;

async function seedTenant(pool: Pool, tenant: string, scen: string, sver: string, run: string, task: string, artifact: string): Promise<void> {
  await withTenantTx(pool, tenant, async (client) => {
    await client.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,$3)`, [scen, tenant, `offboarding-${tenant.slice(-2)}`]);
    await client.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'prod','{"nodes":[]}'::jsonb)`,
      [sver, tenant, scen],
    );
    await client.query(
      `INSERT INTO runs
         (id, tenant_id, scenario_version_id, status, priority, params, failure_reason, correlation_id, attempts, as_of, started_at, ended_at, created_at, updated_at)
       VALUES
         ($1,$2,$3,'completed','high',$4::jsonb,$5::jsonb,$1,2,'2026-06-15T08:00:00Z','2026-06-15T08:00:01Z','2026-06-15T08:01:00Z','2026-06-15T08:00:00Z','2026-06-15T08:01:00Z')`,
      [
        run,
        tenant,
        sver,
        JSON.stringify({ api_token: `PARAMS-SECRET-${tenant}`, customer_id: tenant }),
        JSON.stringify({ code: "EXPORT_OK", message: `FAILURE-MESSAGE-SECRET-${tenant}` }),
      ],
    );
    await client.query(
      `INSERT INTO human_tasks
         (id, tenant_id, run_id, kind, state, assignee, assignee_role, payload, result, artifact_refs, created_at, resolved_at, updated_at, resolved_by)
       VALUES
         ($1,$2,$3,'validation','resolved',$4,'reviewer',$5::jsonb,$6::jsonb,$7::jsonb,'2026-06-15T08:02:00Z','2026-06-15T08:03:00Z','2026-06-15T08:03:00Z','reviewer-1')`,
      [
        task,
        tenant,
        run,
        `=csv-assignee-${tenant}`,
        JSON.stringify({ secret: `PAYLOAD-SECRET-${tenant}` }),
        JSON.stringify({ decision: "approve", secret: `RESULT-SECRET-${tenant}` }),
        JSON.stringify([artifact]),
      ],
    );
    await client.query(
      `INSERT INTO run_steps
         (id, tenant_id, run_id, step_id, node_id, attempt, action, status, cache_mode, created_at)
       VALUES
         ($1,$2,$3,'extract','extract',0,'extract','success','bypass','2026-06-15T08:03:30Z')`,
      [artifact, tenant, run],
    );
    await client.query(
      `INSERT INTO artifacts
         (id, tenant_id, run_id, step_id, attempt, type, media_type, filename, byte_size, duration_ms,
          redaction_status, sha256, object_ref, retention_until, created_at)
       VALUES
         ($1,$2,$3,'extract',0,'screenshot','image/png','visible.png',123,456,
          'redacted',$4,$5,'2026-09-15T00:00:00Z','2026-06-15T08:04:00Z')`,
      [artifact, tenant, run, `SHA-SECRET-${tenant}`, `obj://OBJECT-SECRET-${tenant}`],
    );
  });
}

async function seedTenantAEdgeRows(pool: Pool): Promise<void> {
  await withTenantTx(pool, TENANT_A, async (client) => {
    await client.query(
      `INSERT INTO runs
         (id, tenant_id, scenario_version_id, status, priority, params, correlation_id, attempts, created_at, updated_at)
       VALUES ($1,$2,$3,'completed','medium','{"secret":"OLD-PARAMS-SECRET"}'::jsonb,$1,1,'2026-06-01T00:00:00Z','2026-06-01T00:01:00Z')`,
      [RUN_OLD, TENANT_A, SVER_A],
    );
    await client.query(
      `INSERT INTO human_tasks
         (id, tenant_id, run_id, kind, state, payload, created_at, updated_at)
       VALUES ($1,$2,$3,'validation','open','{"secret":"OLD-PAYLOAD-SECRET"}'::jsonb,'2026-06-01T00:02:00Z','2026-06-01T00:02:00Z')`,
      [TASK_OLD, TENANT_A, RUN_OLD],
    );
    await client.query(
      `INSERT INTO artifacts
         (id, tenant_id, run_id, type, redaction_status, sha256, object_ref, retention_until, created_at, quarantine, deleted_at)
       VALUES
         ($1,$2,$3,'screenshot','pending','SHA-SECRET-PENDING','obj://OBJECT-SECRET-PENDING','2026-09-15T00:00:00Z','2026-06-15T08:05:00Z',false,NULL),
         ($4,$2,$3,'screenshot','redacted','SHA-SECRET-QUARANTINED','obj://OBJECT-SECRET-QUARANTINED','2026-09-15T00:00:00Z','2026-06-15T08:06:00Z',true,NULL),
         ($5,$2,$3,'screenshot','redacted','SHA-SECRET-DELETED','obj://OBJECT-SECRET-DELETED','2026-09-15T00:00:00Z','2026-06-15T08:07:00Z',false,'2026-06-16T00:00:00Z'),
         ($6,$2,$7,'screenshot','redacted','SHA-SECRET-OLD','obj://OBJECT-SECRET-OLD','2026-09-15T00:00:00Z','2026-06-01T00:03:00Z',false,NULL)`,
      [ART_PENDING, TENANT_A, RUN_A, ART_QUARANTINED, ART_DELETED, ART_OLD, RUN_OLD],
    );
  });
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
    await seedTenant(pool, TENANT_A, SCEN_A, SVER_A, RUN_A, TASK_A, ART_VISIBLE);
    await seedTenantAEdgeRows(pool);
    await seedTenant(pool, TENANT_B, SCEN_B, SVER_B, RUN_B, TASK_B, ART_B);
    console.log("seeded offboarding export rows across tenants");

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
    await app.ready();
    try {
      const admin = await mint(["admin"]);
      const viewer = await mint(["viewer"], TENANT_A, "viewer-a");
      const adminB = await mint(["admin"], TENANT_B, "admin-b");

      const exported = await app.inject({
        method: "GET",
        url: "/v1/offboarding/export?created_at_from=2026-06-15T00%3A00%3A00.000Z&created_at_to=2026-06-15T23%3A59%3A59.999Z",
        headers: { authorization: `Bearer ${admin}` },
      });
      check("admin offboarding export -> 200 csv", exported.statusCode === 200 && String(exported.headers["content-type"] ?? "").includes("text/csv"), exported.body);
      check("offboarding export starts with UTF-8 BOM", exported.body.startsWith(String.fromCharCode(0xfeff)), JSON.stringify(exported.body.slice(0, 12)));
      check("offboarding export content-disposition filename", String(exported.headers["content-disposition"] ?? "").includes("offboarding-export-"), JSON.stringify(exported.headers));
      check("offboarding export includes all metadata sections", ["manifest", "runs", "human_tasks", "artifacts"].every((section) => exported.body.includes(`\"section\",\"${section}\"`)), exported.body);
      check("offboarding export includes in-range tenant A rows", exported.body.includes(RUN_A) && exported.body.includes(TASK_A) && exported.body.includes(ART_VISIBLE), exported.body);
      check("offboarding export applies date range", !exported.body.includes(RUN_OLD) && !exported.body.includes(TASK_OLD) && !exported.body.includes(ART_OLD), exported.body);
      check("offboarding export hides cross-tenant rows", !exported.body.includes(RUN_B) && !exported.body.includes(TASK_B) && !exported.body.includes(ART_B), exported.body);
      check("offboarding export hides non-visible artifacts", !exported.body.includes(ART_PENDING) && !exported.body.includes(ART_QUARANTINED) && !exported.body.includes(ART_DELETED), exported.body);
      for (const secret of [
        "PARAMS-SECRET",
        "PAYLOAD-SECRET",
        "RESULT-SECRET",
        "FAILURE-MESSAGE-SECRET",
        "OBJECT-SECRET",
        "SHA-SECRET",
      ]) {
        check(`offboarding export omits ${secret}`, !exported.body.includes(secret), exported.body);
      }
      check("offboarding export neutralizes spreadsheet formula cells", exported.body.includes("\"'=csv-assignee-"), exported.body);

      const invalidFormat = await app.inject({
        method: "GET",
        url: "/v1/offboarding/export?format=json",
        headers: { authorization: `Bearer ${admin}` },
      });
      check("invalid offboarding export format -> 422", invalidFormat.statusCode === 422 && invalidFormat.json().code === "IR_SCHEMA_INVALID", invalidFormat.body);

      const invalidRange = await app.inject({
        method: "GET",
        url: "/v1/offboarding/export?created_at_from=2026-06-16T00%3A00%3A00.000Z&created_at_to=2026-06-15T00%3A00%3A00.000Z",
        headers: { authorization: `Bearer ${admin}` },
      });
      check("invalid offboarding export date range -> 422", invalidRange.statusCode === 422 && invalidRange.json().code === "IR_SCHEMA_INVALID", invalidRange.body);

      const denied = await app.inject({
        method: "GET",
        url: "/v1/offboarding/export",
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("viewer offboarding export denied -> 403", denied.statusCode === 403 && denied.json().code === "AUTHZ_FORBIDDEN", denied.body);

      const tenantB = await app.inject({
        method: "GET",
        url: "/v1/offboarding/export",
        headers: { authorization: `Bearer ${adminB}` },
      });
      check("tenant B export sees tenant B only", tenantB.statusCode === 200 && tenantB.body.includes(RUN_B) && !tenantB.body.includes(RUN_A), tenantB.body);
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
  console.log("\nPASS: offboarding export API integration green");
}

main().catch((err) => {
  console.error("FAIL: offboarding export int threw:", err);
  process.exit(1);
});
