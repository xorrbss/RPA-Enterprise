/**
 * Integration test for audit hash-chain verifier operational surface.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-audit-verification.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { FastifyRequest } from "fastify";
import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { appendGovernanceAudit } from "../src/api/role-assignments";
import { PgDurableSecurityAuditDecisionWriter } from "../src/api/security-audit";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/runtime/run-queue";
import { buildServer } from "../src/api/server";
import { createPool, withTenantTx } from "../src/db/pool";
import type { SecretRef } from "../../ts/core-types";
import {
  SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
  type CorrelationId,
  type IdempotencyKey,
  type IsoDateTime,
  type PrincipalId,
  type SecurityAuditDecisionAppendInput,
  type SignedCommandRegistry,
  type TenantId,
} from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_audit_verification_api_int";
const TENANT_A = "00000000-0000-4000-8000-0000000000a1" as TenantId;
const TENANT_B = "00000000-0000-4000-8000-0000000000b2" as TenantId;
const SUBJECT_A = "admin-a" as PrincipalId;
const CORR_A = "82000000-0000-4000-8000-0000000000a1" as CorrelationId;
const CORR_GOV = "82000000-0000-4000-8000-0000000000a2";

const SECRET = new TextEncoder().encode("audit-verification-int-secret-do-not-use-in-prod-0123456789");
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

function auditInput(key: string): SecurityAuditDecisionAppendInput {
  return {
    tenantId: TENANT_A,
    actor: { subjectId: SUBJECT_A, roles: ["admin"] },
    action: "artifact.read",
    outcome: "allow",
    resource: { kind: "artifact", id: "artifact-verification-int" },
    reason: "artifact disclosed",
    correlationId: CORR_A,
    idempotencyKey: key as IdempotencyKey,
    occurredAt: "2026-06-29T00:00:00Z" as IsoDateTime,
    retentionUntil: "2026-09-29T00:00:00Z" as IsoDateTime,
    payloadSchemaRef: SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
    payload: { decision_kind: "artifact.read", artifact_id: "artifact-verification-int" },
    failClosed: true,
  };
}

function governanceRequest(): FastifyRequest {
  return {
    principal: {
      subjectId: SUBJECT_A,
      tenantId: TENANT_A,
      roles: ["admin"],
      source: "jwt",
      claims: {},
    },
    headers: { "idempotency-key": "governance-audit-1" },
    correlationId: CORR_GOV,
  } as unknown as FastifyRequest;
}

type Pool = ReturnType<typeof createPool>;

async function seedValidMixedAuditChain(pool: Pool): Promise<void> {
  const writer = new PgDurableSecurityAuditDecisionWriter(pool);
  await writer.recordDecision(auditInput("audit-verification-1"), { kind: "allow" });
  await withTenantTx(pool, TENANT_A, async (client) => {
    await appendGovernanceAudit(client, governanceRequest(), "rbac.grant", "allow", "role_assignment_granted", {
      principal_sub: "reviewer-a",
      role: "reviewer",
    });
  });
}

async function appendTamperedAuditRow(pool: Pool): Promise<void> {
  await withTenantTx(pool, TENANT_A, async (client) => {
    const last = await client.query<{ hash: string; sequence_no: string }>(
      `SELECT sequence_no, hash FROM audit_log WHERE tenant_id=$1::uuid ORDER BY sequence_no DESC LIMIT 1`,
      [TENANT_A],
    );
    await client.query(
      `INSERT INTO audit_log (id, tenant_id, sequence_no, actor, action, outcome, reason, correlation_id,
          idempotency_key, occurred_at, payload, payload_schema_ref, retention_until, previous_hash, hash)
       VALUES (gen_random_uuid(),$1::uuid,$2::bigint,$3::jsonb,'artifact.read','deny','tampered',$4::uuid,
          'audit-verification-tamper','2026-06-29T00:10:00Z',$5::jsonb,$6,'2026-09-29T00:00:00Z',$7,'sha256:TAMPERED')`,
      [
        TENANT_A,
        Number(last.rows[0]!.sequence_no) + 1,
        JSON.stringify({ subjectId: SUBJECT_A, roles: ["admin"] }),
        CORR_A,
        JSON.stringify({ decision_kind: "artifact.read" }),
        SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
        last.rows[0]!.hash,
      ],
    );
  });
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

    await seedValidMixedAuditChain(pool);

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
      const admin = await mint(["admin"], TENANT_A, "admin-a");
      const viewer = await mint(["viewer"], TENANT_A, "viewer-a");
      const noRole = await mint([], TENANT_A, "no-role-a");
      const viewerB = await mint(["viewer"], TENANT_B, "viewer-b");

      const verifyOk = await app.inject({
        method: "POST",
        url: "/v1/audit-log/verification-runs/verify",
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "verify-valid-1" },
        payload: {},
      });
      check("admin can run audit verification -> 201", verifyOk.statusCode === 201, verifyOk.body);
      const okBody = verifyOk.json();
      check("mixed security/governance chain is valid", okBody.status === "valid", verifyOk.body);
      check("valid run checks two rows", okBody.rows_checked === 2, verifyOk.body);
      check("valid run has no violations", okBody.violation_count === 0 && okBody.violations.length === 0, verifyOk.body);
      check("manual trigger metadata exposed", okBody.trigger_kind === "manual_api" && okBody.triggered_by.subject_id === "admin-a", verifyOk.body);

      const replay = await app.inject({
        method: "POST",
        url: "/v1/audit-log/verification-runs/verify",
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "verify-valid-1" },
        payload: {},
      });
      check("verification command is idempotent", replay.statusCode === 201 && replay.json().verification_run_id === okBody.verification_run_id, replay.body);

      const listed = await app.inject({
        method: "GET",
        url: "/v1/audit-log/verification-runs?limit=5",
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("viewer can list verifier evidence", listed.statusCode === 200 && listed.json().items?.[0]?.verification_run_id === okBody.verification_run_id, listed.body);
      check("verifier list has no audit payload body", !listed.body.includes("artifact-verification-int"), listed.body);

      const viewerPost = await app.inject({
        method: "POST",
        url: "/v1/audit-log/verification-runs/verify",
        headers: { authorization: `Bearer ${viewer}`, "idempotency-key": "verify-viewer-denied" },
        payload: {},
      });
      check("viewer cannot run verifier", viewerPost.statusCode === 403 && viewerPost.json().code === "AUTHZ_FORBIDDEN", viewerPost.body);

      const deniedList = await app.inject({
        method: "GET",
        url: "/v1/audit-log/verification-runs",
        headers: { authorization: `Bearer ${noRole}` },
      });
      check("no-role verifier list denied", deniedList.statusCode === 403 && deniedList.json().code === "AUTHZ_FORBIDDEN", deniedList.body);

      const tenantB = await app.inject({
        method: "GET",
        url: "/v1/audit-log/verification-runs",
        headers: { authorization: `Bearer ${viewerB}` },
      });
      check("tenant B sees no tenant A verifier runs", tenantB.statusCode === 200 && tenantB.json().items?.length === 0, tenantB.body);

      await appendTamperedAuditRow(pool);
      const verifyBad = await app.inject({
        method: "POST",
        url: "/v1/audit-log/verification-runs/verify",
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": "verify-invalid-1" },
        payload: { legal_hold: true },
      });
      check("tampered chain verifier run still records evidence", verifyBad.statusCode === 201, verifyBad.body);
      const badBody = verifyBad.json();
      check("tampered chain status invalid", badBody.status === "invalid", verifyBad.body);
      check("hash mismatch violation exposed as metadata", badBody.violations.some((v: { kind?: string }) => v.kind === "hash_mismatch"), verifyBad.body);
      check("legal hold request preserved", badBody.legal_hold === true, verifyBad.body);

      const invalidOnly = await app.inject({
        method: "GET",
        url: "/v1/audit-log/verification-runs?status=invalid",
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("status filter returns invalid run", invalidOnly.statusCode === 200 && invalidOnly.json().items?.[0]?.verification_run_id === badBody.verification_run_id, invalidOnly.body);

      const invalidStatus = await app.inject({
        method: "GET",
        url: "/v1/audit-log/verification-runs?status=maybe",
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("invalid verifier status filter -> 422", invalidStatus.statusCode === 422 && invalidStatus.json().code === "IR_SCHEMA_INVALID", invalidStatus.body);
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
  console.log("\nPASS: audit verifier API operational surface green");
}

main().catch((err) => {
  console.error("FAIL: api-audit-verification integration threw:", err);
  process.exit(1);
});
