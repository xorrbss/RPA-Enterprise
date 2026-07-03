/**
 * Integration test for /v1/ai-governance/evidence.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-ai-governance-evidence.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/runtime/run-queue";
import { buildServer } from "../src/api/server";
import { PgDurableSecurityAuditDecisionWriter } from "../src/api/security-audit";
import { createPool } from "../src/db/pool";
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
const SCHEMA = "rpa_ai_governance_evidence_int";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1" as TenantId;
const TENANT_B = "00000000-0000-4000-8000-0000000000b2" as TenantId;
const SUBJECT_A = "admin-a" as PrincipalId;
const CORR_MODEL = "85000000-0000-4000-8000-0000000000a1" as CorrelationId;
const CORR_OVERRIDE = "85000000-0000-4000-8000-0000000000a2" as CorrelationId;
const CORR_UNKNOWN = "85000000-0000-4000-8000-0000000000ff";

const SECRET = new TextEncoder().encode("ai-governance-evidence-int-secret-do-not-use-in-prod-0123456789");

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

function auditInput(correlationId: CorrelationId, idempotencyKey: string, reason: string): SecurityAuditDecisionAppendInput {
  const now = new Date(Date.now() - 60_000).toISOString() as IsoDateTime;
  const retentionUntil = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString() as IsoDateTime;
  return {
    tenantId: TENANT_A,
    actor: { subjectId: SUBJECT_A, roles: ["admin"] },
    action: "ai_governance.manage",
    outcome: "allow",
    resource: { kind: "ai_governance_evidence", id: "ai-governance-evidence" },
    reason,
    correlationId,
    idempotencyKey: idempotencyKey as IdempotencyKey,
    occurredAt: now,
    retentionUntil,
    payloadSchemaRef: SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
    payload: { decision_kind: "ai_governance.manage", evidence_registry: "ai_governance_evidence" },
    failClosed: true,
  };
}

type Pool = ReturnType<typeof createPool>;

async function seedAudit(pool: Pool): Promise<void> {
  const writer = new PgDurableSecurityAuditDecisionWriter(pool);
  await writer.recordDecision(auditInput(CORR_MODEL, "ai-gov-audit-model-1", "model registry approval evidence"), { kind: "allow" });
  await writer.recordDecision(auditInput(CORR_OVERRIDE, "ai-gov-audit-override-1", "human override evidence"), { kind: "allow" });
}

function validModelEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  return {
    evidence_type: "model_registry",
    subject_ref: "model:codex-prod-primary",
    status: "valid",
    evidence_at: now,
    expires_at: expiresAt,
    summary: "Model registry approval for tenant-safe RPA AI usage.",
    evidence_ref: "artifact:ai-gov-model-registry-2026-06",
    policy_decision_ref: "policy-decision:ai-model-approval-2026-06",
    audit_correlation_id: CORR_MODEL,
    metadata: {
      provider_alias: "openai-approved",
      model_alias: "codex-prod-primary",
      model_version: "2026-06-approved",
      risk_tier: "medium",
      data_retention_policy_ref: "policy:data-retention-standard",
      tenant_allowlist_ref: "allowlist:tenant-a-ai",
      approved_at: now,
    },
    ...overrides,
  };
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

    await seedAudit(pool);
    await app.ready();

    const viewer = await mint(["viewer"]);
    const admin = await mint(["admin"], TENANT_A, "admin-a");
    const viewerB = await mint(["viewer"], TENANT_B, "viewer-b");

    const missingPolicy = await app.inject({
      method: "GET",
      url: "/v1/ai-governance/runtime-policy",
      headers: { authorization: `Bearer ${viewer}` },
    });
    check("viewer reads missing AI runtime policy envelope",
      missingPolicy.statusCode === 200 && missingPolicy.json().configured === false,
      missingPolicy.body);

    const deniedPolicyPut = await app.inject({
      method: "PUT",
      url: "/v1/ai-governance/runtime-policy",
      headers: { authorization: `Bearer ${viewer}`, "idempotency-key": "ai-runtime-policy-viewer-denied" },
      payload: {
        mode: "block",
        subject_mapping_ref: "policy:ai-subject-map",
        emergency_override_owner_ref: "group:ai-override-owners",
        policy_decision_ref: "policy-decision:ai-runtime-prod",
      },
    });
    check("viewer cannot upsert AI runtime policy",
      deniedPolicyPut.statusCode === 403 && deniedPolicyPut.json().code === "AUTHZ_FORBIDDEN",
      deniedPolicyPut.body);

    const runtimePolicyPayload = {
      mode: "block",
      subject_mapping_ref: "policy:ai-subject-map-2026-06",
      grace_until: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      emergency_override_owner_ref: "group:ai-override-owners",
      policy_decision_ref: "policy-decision:ai-runtime-prod-2026-06",
      evidence_ref: "artifact:ai-runtime-policy-2026-06",
    };
    const createdPolicy = await app.inject({
      method: "PUT",
      url: "/v1/ai-governance/runtime-policy",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "ai-runtime-policy-1" },
      payload: runtimePolicyPayload,
    });
    const createdPolicyBody = createdPolicy.json() as { policy_id: string; mode: string; audit_action: string };
    check("admin upserts AI runtime policy",
      createdPolicy.statusCode === 201 &&
        createdPolicyBody.mode === "block" &&
        createdPolicyBody.audit_action === "ai_governance.enforce",
      createdPolicy.body);

    const replayPolicy = await app.inject({
      method: "PUT",
      url: "/v1/ai-governance/runtime-policy",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "ai-runtime-policy-1" },
      payload: runtimePolicyPayload,
    });
    check("AI runtime policy upsert idempotency replays first response",
      replayPolicy.statusCode === 201 && (replayPolicy.json() as { policy_id: string }).policy_id === createdPolicyBody.policy_id,
      replayPolicy.body);

    const configuredPolicy = await app.inject({
      method: "GET",
      url: "/v1/ai-governance/runtime-policy",
      headers: { authorization: `Bearer ${viewer}` },
    });
    check("viewer reads configured AI runtime policy",
      configuredPolicy.statusCode === 200 &&
        configuredPolicy.json().configured === true &&
        configuredPolicy.json().policy.policy_id === createdPolicyBody.policy_id,
      configuredPolicy.body);

    const unsafePolicyRef = await app.inject({
      method: "PUT",
      url: "/v1/ai-governance/runtime-policy",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "ai-runtime-policy-unsafe-ref" },
      payload: {
        ...runtimePolicyPayload,
        policy_decision_ref: "https://example.invalid/raw-policy-decision",
      },
    });
    check("AI runtime policy rejects raw URL references",
      unsafePolicyRef.statusCode === 422 && unsafePolicyRef.json().code === "IR_SCHEMA_INVALID",
      unsafePolicyRef.body);

    const empty = await app.inject({
      method: "GET",
      url: "/v1/ai-governance/evidence",
      headers: { authorization: `Bearer ${viewer}` },
    });
    check("viewer lists empty AI governance evidence", empty.statusCode === 200 && (empty.json() as { items: unknown[] }).items.length === 0, empty.body);

    const deniedPost = await app.inject({
      method: "POST",
      url: "/v1/ai-governance/evidence",
      headers: { authorization: `Bearer ${viewer}`, "idempotency-key": "ai-gov-viewer-denied" },
      payload: validModelEvidence(),
    });
    check("viewer cannot record AI governance evidence", deniedPost.statusCode === 403 && deniedPost.json().code === "AUTHZ_FORBIDDEN", deniedPost.body);

    const modelPayload = validModelEvidence();
    const modelEvidence = await app.inject({
      method: "POST",
      url: "/v1/ai-governance/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "ai-gov-model-1" },
      payload: modelPayload,
    });
    const modelBody = modelEvidence.json() as { evidence_id: string; evidence_type: string; audit_correlation_id: string; metadata: { model_alias?: string } };
    check("admin records valid model registry evidence with audit linkage",
      modelEvidence.statusCode === 201 &&
        modelBody.evidence_type === "model_registry" &&
        modelBody.audit_correlation_id === CORR_MODEL &&
        modelBody.metadata.model_alias === "codex-prod-primary",
      modelEvidence.body);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/ai-governance/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "ai-gov-model-1" },
      payload: modelPayload,
    });
    check("AI governance evidence idempotency replays recorded item",
      replay.statusCode === 201 && (replay.json() as { evidence_id: string }).evidence_id === modelBody.evidence_id,
      replay.body);

    const filtered = await app.inject({
      method: "GET",
      url: "/v1/ai-governance/evidence?evidence_type=model_registry&status=valid&subject_ref=model:codex-prod-primary",
      headers: { authorization: `Bearer ${viewer}` },
    });
    check("list filters by type/status/subject",
      filtered.statusCode === 200 && (filtered.json() as { items: unknown[] }).items.length === 1,
      filtered.body);

    const tenantBList = await app.inject({
      method: "GET",
      url: "/v1/ai-governance/evidence",
      headers: { authorization: `Bearer ${viewerB}` },
    });
    check("AI governance evidence is tenant scoped",
      tenantBList.statusCode === 200 && (tenantBList.json() as { items: unknown[] }).items.length === 0,
      tenantBList.body);

    const missingAudit = await app.inject({
      method: "POST",
      url: "/v1/ai-governance/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "ai-gov-missing-audit" },
      payload: validModelEvidence({ audit_correlation_id: undefined }),
    });
    check("valid evidence requires audit correlation id",
      missingAudit.statusCode === 422 && missingAudit.json().code === "IR_SCHEMA_INVALID",
      missingAudit.body);

    const unknownAudit = await app.inject({
      method: "POST",
      url: "/v1/ai-governance/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "ai-gov-unknown-audit" },
      payload: validModelEvidence({ audit_correlation_id: CORR_UNKNOWN }),
    });
    check("valid evidence requires existing audit correlation",
      unknownAudit.statusCode === 422 && unknownAudit.json().code === "IR_SCHEMA_INVALID",
      unknownAudit.body);

    const unsafeMetadata = await app.inject({
      method: "POST",
      url: "/v1/ai-governance/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "ai-gov-unsafe-metadata" },
      payload: validModelEvidence({
        metadata: {
          provider_alias: "openai-approved",
          model_alias: "codex-prod-primary",
          model_version: "2026-06-approved",
          risk_tier: "medium",
          data_retention_policy_ref: "policy:data-retention-standard",
          tenant_allowlist_ref: "allowlist:tenant-a-ai",
          approved_at: new Date(Date.now() - 60_000).toISOString(),
          raw_prompt: "Copy this unredacted prompt.",
        },
      }),
    });
    check("AI governance metadata rejects raw prompt/output keys",
      unsafeMetadata.statusCode === 422 && unsafeMetadata.json().code === "IR_SCHEMA_INVALID",
      unsafeMetadata.body);

    const unsafeApiKey = await app.inject({
      method: "POST",
      url: "/v1/ai-governance/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "ai-gov-unsafe-api-key" },
      payload: validModelEvidence({
        metadata: {
          provider_alias: "openai-approved",
          model_alias: "codex-prod-primary",
          model_version: "2026-06-approved",
          risk_tier: "medium",
          data_retention_policy_ref: "policy:data-retention-standard",
          tenant_allowlist_ref: "allowlist:tenant-a-ai",
          approved_at: new Date(Date.now() - 60_000).toISOString(),
          api_key: "sk-do-not-store-this",
        },
      }),
    });
    check("AI governance metadata rejects API key fields",
      unsafeApiKey.statusCode === 422 && unsafeApiKey.json().code === "IR_SCHEMA_INVALID",
      unsafeApiKey.body);

    const unsafeSummary = await app.inject({
      method: "POST",
      url: "/v1/ai-governance/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "ai-gov-unsafe-summary" },
      payload: validModelEvidence({ summary: "Do not store https://example.invalid/callback?token=plain" }),
    });
    check("AI governance summary rejects raw endpoint/secret-bearing values",
      unsafeSummary.statusCode === 422 && unsafeSummary.json().code === "IR_SCHEMA_INVALID",
      unsafeSummary.body);

    const unsafeAuthorization = await app.inject({
      method: "POST",
      url: "/v1/ai-governance/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "ai-gov-unsafe-authorization" },
      payload: validModelEvidence({ summary: "authorization: Basic abcdefghijklmnop must not be stored" }),
    });
    check("AI governance summary rejects authorization material",
      unsafeAuthorization.statusCode === 422 && unsafeAuthorization.json().code === "IR_SCHEMA_INVALID",
      unsafeAuthorization.body);

    const failedEval = await app.inject({
      method: "POST",
      url: "/v1/ai-governance/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "ai-gov-eval-failed-check" },
      payload: {
        evidence_type: "eval_result",
        subject_ref: "prompt:invoice-extract:v12",
        status: "valid",
        evidence_at: new Date(Date.now() - 60_000).toISOString(),
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        summary: "Eval should fail because a required safety check did not pass.",
        evidence_ref: "artifact:eval-suite-2026-06",
        policy_decision_ref: "policy-decision:prompt-v12-eval",
        audit_correlation_id: CORR_MODEL,
        metadata: {
          eval_suite_ref: "eval-suite:prompt-safety",
          dataset_ref: "dataset:redacted-invoice-fixtures",
          sampled_at: new Date(Date.now() - 60_000).toISOString(),
          pass_rate: 0.98,
          prompt_injection_passed: false,
          data_leakage_passed: true,
          hallucination_passed: true,
          policy_block_passed: true,
        },
      },
    });
    check("valid eval evidence requires all safety checks to pass",
      failedEval.statusCode === 422 && failedEval.json().code === "IR_SCHEMA_INVALID",
      failedEval.body);

    const humanOverride = await app.inject({
      method: "POST",
      url: "/v1/ai-governance/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "ai-gov-human-override-1" },
      payload: {
        evidence_type: "human_override",
        subject_ref: "run:85000000-0000-4000-8000-000000000321:step:extract",
        status: "valid",
        evidence_at: new Date(Date.now() - 60_000).toISOString(),
        summary: "Reviewer rejected AI output and routed the case to manual validation.",
        evidence_ref: "audit:override-evt-2026-06-29-001",
        policy_decision_ref: "policy-decision:override-required",
        audit_correlation_id: CORR_OVERRIDE,
        metadata: {
          override_actor_ref: "principal:reviewer-a",
          override_action: "rejected_ai_output",
          reason_code: "ai_output_incomplete",
          audit_event_ref: "audit-log:2",
          occurred_at: new Date(Date.now() - 60_000).toISOString(),
        },
      },
    });
    check("human override evidence can be valid without expiry but with audit linkage",
      humanOverride.statusCode === 201 &&
        (humanOverride.json() as { evidence_type: string; expires_at: string | null }).evidence_type === "human_override" &&
        (humanOverride.json() as { expires_at: string | null }).expires_at === null,
      humanOverride.body);

    if (failures > 0) {
      console.error(`\nFAIL: ${failures} AI governance evidence check(s) failed`);
      process.exit(1);
    }
    console.log("\nPASS: AI governance evidence integration green");
  } finally {
    await app.close();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("FAIL: api-ai-governance-evidence integration threw:", err);
  process.exit(1);
});
