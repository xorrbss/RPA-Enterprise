import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import { PgPrincipalRoleAssignmentResolver } from "../src/api/role-assignments";
import type { RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import { createPool, withTenantTx } from "../src/db/pool";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_role_assignments_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const SECRET = new TextEncoder().encode("role-assignments-int-secret-do-not-use-in-prod-0123456789");

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function mint(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m").sign(SECRET);
}

const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return { kind: "available", snapshot: { sourceRef: "secret://staging/registry" as SecretRef, commands: [] } };
  },
};

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
    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(
        `INSERT INTO principals (id, tenant_id, sub, display_name, email, source)
         VALUES
         ('a1000000-0000-0000-0000-000000000001',$1::uuid,'auth0|target','대상',NULL,'manual'),
         ('a1000000-0000-0000-0000-000000000002',$1::uuid,'auth0|admin','관리자',NULL,'manual')`,
        [TENANT],
      );
    });

    const enqueuer: RunEnqueuer = { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} };
    const app = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer,
      signedCommandRegistry,
      roleAssignments: new PgPrincipalRoleAssignmentResolver(pool),
    });
    await app.ready();
    try {
      const admin = await mint({ sub: "auth0|admin", tenant_id: TENANT, roles: ["admin"] });
      const targetNoRole = await mint({ sub: "auth0|target", tenant_id: TENANT, roles: [] });

      const deniedBefore = await app.inject({ method: "GET", url: "/v1/principals", headers: { authorization: `Bearer ${targetNoRole}` } });
      check("target before assignment → 403", deniedBefore.statusCode === 403 && deniedBefore.json().code === "AUTHZ_FORBIDDEN", deniedBefore.body);

      const grant = await app.inject({
        method: "POST",
        url: "/v1/principals/a1000000-0000-0000-0000-000000000001/role-assignments",
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "grant-target-admin" },
        payload: { role: "admin", reason: "pilot owner" },
      });
      check("grant admin to target → 201", grant.statusCode === 201 && grant.json().role === "admin", grant.body);
      const assignmentId = grant.json().assignment_id as string;

      const allowedAfter = await app.inject({ method: "GET", url: "/v1/principals", headers: { authorization: `Bearer ${targetNoRole}` } });
      check("target after manual admin assignment → 200", allowedAfter.statusCode === 200, allowedAfter.body);

      const selfAdminGrant = await app.inject({
        method: "POST",
        url: "/v1/principals/a1000000-0000-0000-0000-000000000001/role-assignments",
        headers: { authorization: `Bearer ${targetNoRole}`, "idempotency-key": "self-admin-deny" },
        payload: { role: "admin", reason: "self escalation" },
      });
      check("self admin grant denied", selfAdminGrant.statusCode === 403 && selfAdminGrant.json().code === "AUTHZ_FORBIDDEN", selfAdminGrant.body);

      const selfRevoke = await app.inject({
        method: "POST",
        url: `/v1/role-assignments/${assignmentId}/revoke`,
        headers: { authorization: `Bearer ${targetNoRole}`, "idempotency-key": "self-revoke-deny" },
        payload: { reason: "remove myself" },
      });
      check("self last rbac.grant revoke denied", selfRevoke.statusCode === 403 && selfRevoke.json().code === "AUTHZ_FORBIDDEN", selfRevoke.body);

      const revoke = await app.inject({
        method: "POST",
        url: `/v1/role-assignments/${assignmentId}/revoke`,
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "admin-revoke-target" },
        payload: { reason: "pilot ended" },
      });
      check("admin revoke → 200 revoked", revoke.statusCode === 200 && revoke.json().status === "revoked", revoke.body);

      const deniedAfterRevoke = await app.inject({ method: "GET", url: "/v1/principals", headers: { authorization: `Bearer ${targetNoRole}` } });
      check("target after revoke → 403", deniedAfterRevoke.statusCode === 403, deniedAfterRevoke.body);

      const audit = await withTenantTx(pool, TENANT, async (c) => {
        const r = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit_log WHERE action IN ('rbac.grant','rbac.revoke')`,
        );
        return r.rows[0]?.n ?? 0;
      });
      check("grant/revoke audit rows appended", audit === 2, String(audit));
    } finally {
      await app.close();
    }
  } finally {
    await pool.end();
  }
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
