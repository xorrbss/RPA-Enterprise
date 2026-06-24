/**
 * Integration test for /v1/audit-log.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-audit-log.int.ts
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
const SCHEMA = "rpa_audit_log_int";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const AUDIT_A_NEW = "81000000-0000-4000-8000-0000000000a1";
const AUDIT_A_OLD = "81000000-0000-4000-8000-0000000000a2";
const AUDIT_B = "81000000-0000-4000-8000-0000000000b1";
const CORR_A_NEW = "82000000-0000-4000-8000-0000000000a1";
const CORR_A_OLD = "82000000-0000-4000-8000-0000000000a2";
const CORR_B = "82000000-0000-4000-8000-0000000000b1";
const HASH_A_OLD = "sha256:audit-old";
const HASH_A_NEW = "sha256:audit-new";
const HASH_B = "sha256:audit-b";

const SECRET = new TextEncoder().encode("audit-log-int-secret-do-not-use-in-prod-0123456789");
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

async function seedAuditLog(pool: Pool): Promise<void> {
  await withTenantTx(pool, TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO audit_log
         (id, tenant_id, sequence_no, actor, action, outcome, reason, correlation_id,
          idempotency_key, occurred_at, payload, payload_schema_ref, retention_until,
          previous_hash, hash, created_at)
       VALUES
         ($1,$2,1,$3::jsonb,'artifact.read','deny','redaction pending',$4,
          'audit-old','2026-06-22T09:00:00Z',$5::jsonb,'audit/security-boundary-decision@1',
          '2026-09-22T09:00:00Z',NULL,$6,'2026-06-22T09:00:01Z'),
         ($7,$2,2,$8::jsonb,'artifact.read','allow','artifact disclosed',$9,
          'audit-new','2026-06-23T09:00:00Z',$10::jsonb,'audit/security-boundary-decision@1',
          '2026-09-23T09:00:00Z',$6,$11,'2026-06-23T09:00:01Z')`,
      [
        AUDIT_A_OLD,
        TENANT_A,
        JSON.stringify({ subjectId: "viewer-a", roles: ["viewer"] }),
        CORR_A_OLD,
        JSON.stringify({ secret: "must-not-leak-old", resource: "artifact-old" }),
        HASH_A_OLD,
        AUDIT_A_NEW,
        JSON.stringify({ subjectId: "viewer-a", roles: ["viewer"] }),
        CORR_A_NEW,
        JSON.stringify({ secret: "must-not-leak-new", resource: "artifact-new" }),
        HASH_A_NEW,
      ],
    );
  });
  await withTenantTx(pool, TENANT_B, async (c) => {
    await c.query(
      `INSERT INTO audit_log
         (id, tenant_id, sequence_no, actor, action, outcome, reason, correlation_id,
          idempotency_key, occurred_at, payload, payload_schema_ref, retention_until,
          previous_hash, hash, created_at)
       VALUES
         ($1,$2,1,$3::jsonb,'secret.resolve','allow','tenant b row',$4,
          'audit-b','2026-06-23T10:00:00Z',$5::jsonb,'audit/security-boundary-decision@1',
          '2026-09-23T10:00:00Z',NULL,$6,'2026-06-23T10:00:01Z')`,
      [
        AUDIT_B,
        TENANT_B,
        JSON.stringify({ subjectId: "viewer-b", roles: ["viewer"] }),
        CORR_B,
        JSON.stringify({ secret: "must-not-leak-b" }),
        HASH_B,
      ],
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
    await seedAuditLog(pool);
    console.log("seeded audit_log across tenants");

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
      const viewer = await mint(["viewer"]);
      const noRoles = await mint([], TENANT_A, "no-role-a");
      const viewerB = await mint(["viewer"], TENANT_B, "viewer-b");

      const page1 = await app.inject({
        method: "GET",
        url: "/v1/audit-log?limit=1",
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("viewer list audit log -> 200", page1.statusCode === 200, page1.body);
      const first = page1.json();
      check("newest audit row first", first.items?.[0]?.audit_id === AUDIT_A_NEW, page1.body);
      check("audit payload omitted", first.items?.[0]?.payload === undefined && !page1.body.includes("must-not-leak"), page1.body);
      check("hash chain fields exposed", first.items?.[0]?.previous_hash === HASH_A_OLD && first.items?.[0]?.hash === HASH_A_NEW, page1.body);
      check("cursor emitted", typeof first.next_cursor === "string", page1.body);

      const page2 = await app.inject({
        method: "GET",
        url: `/v1/audit-log?limit=1&cursor=${encodeURIComponent(String(first.next_cursor))}`,
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("cursor returns older audit row", page2.statusCode === 200 && page2.json().items?.[0]?.audit_id === AUDIT_A_OLD, page2.body);

      const filtered = await app.inject({
        method: "GET",
        url: `/v1/audit-log?action=artifact.read&outcome=allow&actor=viewer-a&correlation_id=${CORR_A_NEW}`,
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("action/outcome/actor/correlation filters match one row", filtered.statusCode === 200 && filtered.json().items?.length === 1 && filtered.json().items?.[0]?.audit_id === AUDIT_A_NEW, filtered.body);

      const exported = await app.inject({
        method: "GET",
        url: "/v1/audit-log/export?action=artifact.read&outcome=allow&limit=10",
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("audit export -> 200 csv", exported.statusCode === 200 && String(exported.headers["content-type"] ?? "").includes("text/csv"), exported.body);
      check("audit export includes bounded summary fields", exported.body.includes("audit_id") && exported.body.includes(AUDIT_A_NEW) && exported.body.includes("artifact.read"), exported.body);
      check("audit export omits payload and other tenants", !exported.body.includes("must-not-leak") && !exported.body.includes(AUDIT_B), exported.body);
      check("audit export content-disposition filename", String(exported.headers["content-disposition"] ?? "").includes("audit-log-"), JSON.stringify(exported.headers));

      const invalidExport = await app.inject({
        method: "GET",
        url: "/v1/audit-log/export?format=json",
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("invalid audit export format -> 422", invalidExport.statusCode === 422 && invalidExport.json().code === "IR_SCHEMA_INVALID", invalidExport.body);

      const invalidOutcome = await app.inject({
        method: "GET",
        url: "/v1/audit-log?outcome=maybe",
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("invalid outcome -> 422", invalidOutcome.statusCode === 422 && invalidOutcome.json().code === "IR_SCHEMA_INVALID", invalidOutcome.body);

      const denied = await app.inject({
        method: "GET",
        url: "/v1/audit-log",
        headers: { authorization: `Bearer ${noRoles}` },
      });
      check("no-role audit read denied -> 403", denied.statusCode === 403 && denied.json().code === "AUTHZ_FORBIDDEN", denied.body);

      const tenantB = await app.inject({
        method: "GET",
        url: "/v1/audit-log",
        headers: { authorization: `Bearer ${viewerB}` },
      });
      check("tenant B sees only tenant B audit row", tenantB.statusCode === 200 && tenantB.json().items?.length === 1 && tenantB.json().items?.[0]?.audit_id === AUDIT_B, tenantB.body);
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
  console.log("\nPASS: audit log API integration green");
}

main().catch((err) => {
  console.error("FAIL: api-audit-log integration threw:", err);
  process.exit(1);
});
