/**
 * Integration test for /v1/ops/production-readiness.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-production-readiness.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { insertAuditVerificationRun } from "../src/runtime/audit-verification-runs";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import { PgGraphileRunEnqueuer, type RunEnqueuer } from "../src/runtime/run-queue";
import { buildServer } from "../src/api/server";
import { PgDurableSecurityAuditDecisionWriter } from "../src/api/security-audit";
import { createPool, withTenantTx } from "../src/db/pool";
import { installGraphileSchema } from "./graphile-schema";
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
const SCHEMA = "rpa_production_readiness_int";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1" as TenantId;
const TENANT_B = "00000000-0000-4000-8000-0000000000b2" as TenantId;
const SUBJECT_A = "admin-a" as PrincipalId;
const CORR_A = "83000000-0000-4000-8000-0000000000a1" as CorrelationId;
const RUN_A = "83000000-0000-4000-8000-000000000301";
const WORKER_A = "83000000-0000-4000-8000-000000000101";
const WORKER_B = "83000000-0000-4000-8000-000000000102";
const DELIVERY_FAIL_A = "83000000-0000-4000-8000-000000000201";
const DELIVERY_OK_A = "83000000-0000-4000-8000-000000000202";
const DELIVERY_SENT_A = "83000000-0000-4000-8000-000000000203";

const SECRET = new TextEncoder().encode("production-readiness-int-secret-do-not-use-in-prod-0123456789");
const SSO_READY = {
  mode: "jwks",
  configurationSource: "deployment_config",
  jwksUrl: "https://idp.example.com/.well-known/jwks.json",
  issuer: "https://idp.example.com/",
  audience: "rpa-control-plane",
} as const;

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

function auditInput(): SecurityAuditDecisionAppendInput {
  return {
    tenantId: TENANT_A,
    actor: { subjectId: SUBJECT_A, roles: ["admin"] },
    action: "artifact.read",
    outcome: "allow",
    resource: { kind: "artifact", id: "production-readiness-evidence" },
    reason: "production readiness evidence baseline",
    correlationId: CORR_A,
    idempotencyKey: "production-readiness-audit-1" as IdempotencyKey,
    occurredAt: "2026-06-29T00:00:00Z" as IsoDateTime,
    retentionUntil: "2026-09-29T00:00:00Z" as IsoDateTime,
    payloadSchemaRef: SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
    payload: { decision_kind: "artifact.read", artifact_id: "production-readiness-evidence" },
    failClosed: true,
  };
}

type Pool = ReturnType<typeof createPool>;

async function seedDeploymentEvidence(pool: Pool): Promise<void> {
  const direct = await pool.connect();
  try {
    await direct.query(`SET search_path = ${SCHEMA}, public`);
    await direct.query(`CREATE TABLE schema_migrations (version text PRIMARY KEY, status text NOT NULL)`);
    await direct.query(
      `INSERT INTO schema_migrations (version, status) VALUES ('0001','applied'), ('0002','applied')`,
    );
    await direct.query(
      `INSERT INTO workers (id, kind, status, heartbeat_at, circuit_state)
       VALUES
         ($1,'browser','active',now(),'closed'),
         ($2,'browser','active',now(),'closed')`,
      [WORKER_A, WORKER_B],
    );
    await direct.query(
      `INSERT INTO worker_pools (pool_key, description, max_concurrency, priority)
       VALUES ('finance-prod', 'production readiness pool', 2, 'high')`,
    );
    await direct.query(
      `INSERT INTO worker_pool_memberships (worker_id, pool_key, assigned_by)
       VALUES ($1, 'finance-prod', 'admin-a'), ($2, 'finance-prod', 'admin-a')`,
      [WORKER_A, WORKER_B],
    );
  } finally {
    direct.release();
  }

  await withTenantTx(pool, TENANT_A, async (client) => {
    await client.query(
      `INSERT INTO worker_pool_assignments (tenant_id, pool_key)
       VALUES ($1::uuid, 'finance-prod')`,
      [TENANT_A],
    );
  });

  // 큐 표면은 실 graphile 스키마 + 실 인큐 경로로만 만든다. 가짜 jobs 테이블을 세우면 0.16 의 실제 뷰
  // 모양(payload 없음)과 어긋나 graphile_queue 게이트 결함을 가린다.
  await installGraphileSchema();
  await withTenantTx(pool, TENANT_A, async (client) => {
    await new PgGraphileRunEnqueuer().enqueueRunClaim(client, {
      tenantId: TENANT_A,
      runId: RUN_A,
      correlationId: CORR_A,
    });
  });

  const writer = new PgDurableSecurityAuditDecisionWriter(pool);
  await writer.recordDecision(auditInput(), { kind: "allow" });
  await withTenantTx(pool, TENANT_A, async (client) => {
    await insertAuditVerificationRun(client, {
      result: {
        tenantId: TENANT_A,
        valid: true,
        rowsChecked: 1,
        violations: [],
        checkedFromSequence: 1,
        checkedToSequence: 1,
      },
      startedAt: new Date(),
      completedAt: new Date(),
      correlationId: CORR_A,
      triggeredBy: { subjectId: SUBJECT_A, roles: ["admin"] },
      triggerKind: "manual_api",
      legalHold: false,
      tenantId: TENANT_A,
    });
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
    authReadiness: SSO_READY,
  });
  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`DROP SCHEMA IF EXISTS graphile_worker CASCADE`);
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(`CREATE TABLE tenants (id uuid PRIMARY KEY)`);
      await setup.query(`INSERT INTO tenants (id) VALUES ($1::uuid), ($2::uuid)`, [TENANT_A, TENANT_B]);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
    } finally {
      setup.release();
    }

    await seedDeploymentEvidence(pool);
    await app.ready();

    const viewer = await mint(["viewer"]);
    const admin = await mint(["admin"], TENANT_A, "admin-a");
    const viewerB = await mint(["viewer"], TENANT_B, "viewer-b");
    const noRole = await mint([]);

    const ready = await app.inject({
      method: "GET",
      url: "/v1/ops/production-readiness",
      headers: { authorization: `Bearer ${viewer}` },
    });
    const body = ready.json() as {
      status: string;
      summary: { blocker_count: number; warning_count: number; deferred_count: number; controlled_prod_ready: boolean };
      gates: Array<{ gate_id: string; status: string; reason_code: string | null; evidence: string[] }>;
      signals: { bot_pool: { capacity_slots: number; workers: { active: number } }; audit_verifier: { latest_status: string | null } };
    };
    const gate = (id: string) => body.gates.find((item) => item.gate_id === id);
    check("viewer production readiness -> 200", ready.statusCode === 200, ready.body);
    // 실 graphile 스키마 + 실 인큐 1건 → 게이트가 pass 이면서 카운트도 테넌트 스코프여야 한다.
    // (가짜 jobs 테이블 시절에는 pass 만 보고 카운트 정확성은 아무도 검증하지 않았다.)
    check("graphile queue gate reports the tenant-scoped pending count",
      gate("graphile_queue")?.evidence.includes("pending_jobs=1") === true,
      JSON.stringify(gate("graphile_queue")?.evidence));
    check("runtime gates pass while external evidence remains deferred",
      body.status === "warning" &&
        body.summary.blocker_count === 0 &&
        body.summary.deferred_count === 5 &&
        body.summary.controlled_prod_ready === false,
      ready.body);
    check("database/queue/browser/audit/auth gates pass",
      gate("database_migrations")?.status === "pass" &&
        gate("graphile_queue")?.status === "pass" &&
        gate("browser_pool_ha")?.status === "pass" &&
        gate("audit_chain_evidence")?.status === "pass" &&
        gate("auth_sso_readiness")?.status === "pass" &&
        gate("ai_governance_runtime")?.status === "pass",
      ready.body);
    check("browser pool and audit evidence are returned as metadata",
      body.signals.bot_pool.capacity_slots === 2 &&
        body.signals.bot_pool.workers.active === 2 &&
        body.signals.audit_verifier.latest_status === "valid",
      ready.body);

    const missingAudienceApp = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer: { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} } as RunEnqueuer,
      signedCommandRegistry,
      authReadiness: {
        mode: "jwks",
        configurationSource: "deployment_config",
        jwksUrl: "https://idp.example.com/.well-known/jwks.json",
        issuer: "https://idp.example.com/",
      },
    });
    await missingAudienceApp.ready();
    try {
      const blockedByAuth = await missingAudienceApp.inject({
        method: "GET",
        url: "/v1/ops/production-readiness",
        headers: { authorization: `Bearer ${viewer}` },
      });
      const blockedByAuthBody = blockedByAuth.json() as {
        status: string;
        summary: { blocker_count: number; controlled_prod_ready: boolean };
        gates: Array<{ gate_id: string; status: string; reason_code: string | null }>;
      };
      const authGate = blockedByAuthBody.gates.find((item) => item.gate_id === "auth_sso_readiness");
      check("JWKS readiness without audience blocks controlled-prod readiness",
        blockedByAuth.statusCode === 200 &&
          blockedByAuthBody.status === "blocked" &&
          blockedByAuthBody.summary.blocker_count === 1 &&
          blockedByAuthBody.summary.controlled_prod_ready === false &&
          authGate?.status === "blocked" &&
          authGate.reason_code === "auth_sso_audience_missing",
        blockedByAuth.body);
    } finally {
      await missingAudienceApp.close();
    }

    const failedReceiptAt = new Date(Date.now() - 4 * 60 * 1000).toISOString();
    const deliveredReceiptAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const sentReceiptAt = new Date(Date.now() - 1 * 60 * 1000).toISOString();
    await withTenantTx(pool, TENANT_A, async (client) => {
      await client.query(
        `INSERT INTO ops_notification_deliveries (
           id, tenant_id, alert_id, detected_at, source, subject_type, subject_id,
           channel, provider_alias, status, receipt_id, receipt_at,
           endpoint_secret_ref, credential_secret_ref, route_policy_ref,
           attempt_no, summary, error_code, metadata, recorded_by, retention_until, legal_hold
         )
         VALUES (
           $1::uuid, $2::uuid, 'bot_pool:browser-default', $3::timestamptz,
           'bot_pool', 'bot_pool', 'browser-default',
           'teams', 'teams-primary', 'failed', NULL, $4::timestamptz,
           'secret://tenant-a/notification/teams/primary',
           'secret://tenant-a/notification/teams/credential',
           'ops-alerts-primary', 1,
           'Provider returned a temporary error for the controlled-prod drill alert.',
           'PROVIDER_5XX', '{"provider_region":"ap-northeast-2"}'::jsonb,
           'admin-a', $5::timestamptz, false
         )`,
        [DELIVERY_FAIL_A, TENANT_A, failedReceiptAt, failedReceiptAt, new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()],
      );
    });
    const blockedByFailedDelivery = await app.inject({
      method: "GET",
      url: "/v1/ops/production-readiness",
      headers: { authorization: `Bearer ${viewer}` },
    });
    const blockedByFailedDeliveryBody = blockedByFailedDelivery.json() as {
      status: string;
      summary: { blocker_count: number; deferred_count: number; controlled_prod_ready: boolean };
      gates: Array<{ gate_id: string; status: string; reason_code: string | null; evidence: string[] }>;
    };
    check("failed external delivery receipt blocks controlled-prod readiness",
      blockedByFailedDelivery.statusCode === 200 &&
        blockedByFailedDeliveryBody.status === "blocked" &&
        blockedByFailedDeliveryBody.summary.blocker_count === 1 &&
        blockedByFailedDeliveryBody.summary.deferred_count === 4 &&
        blockedByFailedDeliveryBody.summary.controlled_prod_ready === false &&
        blockedByFailedDeliveryBody.gates.find((item) => item.gate_id === "external_alert_delivery")?.reason_code === "external_delivery_receipt_failed",
      blockedByFailedDelivery.body);

    await withTenantTx(pool, TENANT_A, async (client) => {
      await client.query(
        `INSERT INTO ops_notification_deliveries (
           id, tenant_id, alert_id, detected_at, source, subject_type, subject_id,
           channel, provider_alias, status, receipt_id, receipt_at,
           endpoint_secret_ref, credential_secret_ref, route_policy_ref,
           attempt_no, summary, error_code, metadata, recorded_by, retention_until, legal_hold
         )
         VALUES (
           $1::uuid, $2::uuid, 'bot_pool:browser-default', $3::timestamptz,
           'bot_pool', 'bot_pool', 'browser-default',
           'teams', 'teams-primary', 'delivered', 'teams-receipt-prod-1', $4::timestamptz,
           'secret://tenant-a/notification/teams/primary',
           'secret://tenant-a/notification/teams/credential',
           'ops-alerts-primary', 2,
           'Provider accepted and delivered the controlled-prod drill alert.',
           NULL, '{"provider_region":"ap-northeast-2"}'::jsonb,
           'admin-a', $5::timestamptz, false
         )`,
        [DELIVERY_OK_A, TENANT_A, deliveredReceiptAt, deliveredReceiptAt, new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()],
      );
    });
    const readyWithDeliveryReceipt = await app.inject({
      method: "GET",
      url: "/v1/ops/production-readiness",
      headers: { authorization: `Bearer ${viewer}` },
    });
    const readyWithDeliveryReceiptBody = readyWithDeliveryReceipt.json() as {
      status: string;
      summary: { blocker_count: number; deferred_count: number; controlled_prod_ready: boolean };
      gates: Array<{ gate_id: string; status: string; reason_code: string | null; evidence: string[] }>;
    };
    check("fresh delivered provider receipt satisfies external alert readiness gate",
      readyWithDeliveryReceipt.statusCode === 200 &&
        readyWithDeliveryReceiptBody.status === "warning" &&
        readyWithDeliveryReceiptBody.summary.blocker_count === 0 &&
        readyWithDeliveryReceiptBody.summary.deferred_count === 4 &&
        readyWithDeliveryReceiptBody.summary.controlled_prod_ready === false &&
        readyWithDeliveryReceiptBody.gates.find((item) => item.gate_id === "external_alert_delivery")?.status === "pass" &&
        readyWithDeliveryReceiptBody.gates.find((item) => item.gate_id === "external_alert_delivery")?.evidence.some((line) => line === "receipt_id=teams-receipt-prod-1") === true,
      readyWithDeliveryReceipt.body);

    const deniedPost = await app.inject({
      method: "POST",
      url: "/v1/ops/production-readiness/evidence",
      headers: { authorization: `Bearer ${viewer}`, "idempotency-key": "readiness-evidence-viewer-denied" },
      payload: {
        evidence_type: "external_alert_delivery",
        status: "valid",
        evidence_at: "2026-06-29T00:05:00.000Z",
        expires_at: "2026-09-29T00:05:00.000Z",
        summary: "External alert delivery drill receipt verified.",
      },
    });
    check("viewer cannot record production readiness evidence",
      deniedPost.statusCode === 403 && deniedPost.json().code === "AUTHZ_FORBIDDEN",
      deniedPost.body);

    const alertEvidence = await app.inject({
      method: "POST",
      url: "/v1/ops/production-readiness/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "readiness-evidence-alert-1" },
      payload: {
        evidence_type: "external_alert_delivery",
        status: "valid",
        evidence_at: "2026-06-29T00:05:00.000Z",
        expires_at: "2026-09-29T00:05:00.000Z",
        summary: "External alert delivery drill receipt verified.",
        evidence_ref: "ticket:OPS-123",
        metadata: {
          channel: "teams",
          provider_alias: "teams-primary",
          receipt_id: "receipt-123",
          receipt_at: "2026-06-29T00:05:30.000Z",
          delivery_status: "delivered",
        },
      },
    });
    const alertEvidenceBody = alertEvidence.json() as { evidence_id: string; evidence_type: string; metadata: { channel?: string } };
    check("admin records external alert delivery evidence",
      alertEvidence.statusCode === 201 &&
        alertEvidenceBody.evidence_type === "external_alert_delivery" &&
        alertEvidenceBody.metadata.channel === "teams",
      alertEvidence.body);

    const alertEvidenceReplay = await app.inject({
      method: "POST",
      url: "/v1/ops/production-readiness/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "readiness-evidence-alert-1" },
      payload: {
        evidence_type: "external_alert_delivery",
        status: "valid",
        evidence_at: "2026-06-29T00:05:00.000Z",
        expires_at: "2026-09-29T00:05:00.000Z",
        summary: "External alert delivery drill receipt verified.",
        evidence_ref: "ticket:OPS-123",
        metadata: {
          channel: "teams",
          provider_alias: "teams-primary",
          receipt_id: "receipt-123",
          receipt_at: "2026-06-29T00:05:30.000Z",
          delivery_status: "delivered",
        },
      },
    });
    check("readiness evidence idempotency replays recorded item",
      alertEvidenceReplay.statusCode === 201 &&
        (alertEvidenceReplay.json() as { evidence_id: string }).evidence_id === alertEvidenceBody.evidence_id,
      alertEvidenceReplay.body);

    await withTenantTx(pool, TENANT_A, async (client) => {
      await client.query(
        `INSERT INTO ops_notification_deliveries (
           id, tenant_id, alert_id, detected_at, source, subject_type, subject_id,
           channel, provider_alias, status, receipt_id, receipt_at,
           endpoint_secret_ref, credential_secret_ref, route_policy_ref,
           attempt_no, summary, error_code, metadata, recorded_by, retention_until, legal_hold
         )
         VALUES (
           $1::uuid, $2::uuid, 'bot_pool:browser-default', $3::timestamptz,
           'bot_pool', 'bot_pool', 'browser-default',
           'teams', 'teams-primary', 'sent', 'teams-receipt-sent-after-owner-evidence', $4::timestamptz,
           'secret://tenant-a/notification/teams/primary',
           'secret://tenant-a/notification/teams/credential',
           'ops-alerts-primary', 3,
           'Provider send attempt was accepted but no delivered receipt has arrived yet.',
           NULL, '{"provider_region":"ap-northeast-2"}'::jsonb,
           'admin-a', $5::timestamptz, false
         )`,
        [DELIVERY_SENT_A, TENANT_A, sentReceiptAt, sentReceiptAt, new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()],
      );
    });
    const readyWithOwnerEvidenceDespiteSentReceipt = await app.inject({
      method: "GET",
      url: "/v1/ops/production-readiness",
      headers: { authorization: `Bearer ${viewer}` },
    });
    const readyWithOwnerEvidenceDespiteSentReceiptBody = readyWithOwnerEvidenceDespiteSentReceipt.json() as {
      status: string;
      summary: { blocker_count: number; deferred_count: number; controlled_prod_ready: boolean };
      gates: Array<{ gate_id: string; status: string; reason_code: string | null; evidence: string[] }>;
    };
    const ownerAlertGate = readyWithOwnerEvidenceDespiteSentReceiptBody.gates.find((item) => item.gate_id === "external_alert_delivery");
    check("valid owner external alert evidence overrides newer sent-only provider receipt",
      readyWithOwnerEvidenceDespiteSentReceipt.statusCode === 200 &&
        readyWithOwnerEvidenceDespiteSentReceiptBody.status === "warning" &&
        readyWithOwnerEvidenceDespiteSentReceiptBody.summary.blocker_count === 0 &&
        readyWithOwnerEvidenceDespiteSentReceiptBody.summary.deferred_count === 4 &&
        readyWithOwnerEvidenceDespiteSentReceiptBody.summary.controlled_prod_ready === false &&
        ownerAlertGate?.status === "pass" &&
        ownerAlertGate.reason_code === null &&
        ownerAlertGate.evidence.some((line) => line === "evidence_ref=ticket:OPS-123") === true,
      readyWithOwnerEvidenceDespiteSentReceipt.body);

    const incompleteAlertEvidence = await app.inject({
      method: "POST",
      url: "/v1/ops/production-readiness/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "readiness-evidence-alert-incomplete" },
      payload: {
        evidence_type: "external_alert_delivery",
        status: "valid",
        evidence_at: "2026-06-29T00:05:00.000Z",
        expires_at: "2026-09-29T00:05:00.000Z",
        summary: "External alert delivery drill receipt is missing provider delivery state.",
        evidence_ref: "ticket:OPS-124",
        metadata: { channel: "teams", provider_alias: "teams-primary", receipt_id: "receipt-124", receipt_at: "2026-06-29T00:05:30.000Z" },
      },
    });
    check("valid external alert evidence requires delivered provider receipt metadata",
      incompleteAlertEvidence.statusCode === 422 &&
        incompleteAlertEvidence.json().code === "IR_SCHEMA_INVALID",
      incompleteAlertEvidence.body);

    const secretBearingEvidence = await app.inject({
      method: "POST",
      url: "/v1/ops/production-readiness/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "readiness-evidence-secret-rejected" },
      payload: {
        evidence_type: "external_alert_delivery",
        status: "valid",
        evidence_at: "2026-06-29T00:05:00.000Z",
        expires_at: "2026-09-29T00:05:00.000Z",
        summary: "Should reject endpoint material.",
        metadata: { endpoint_url: "https://hooks.slack.com/services/T000/B000/secret" },
      },
    });
    check("evidence metadata rejects raw endpoint/secret-bearing values",
      secretBearingEvidence.statusCode === 422 && secretBearingEvidence.json().code === "IR_SCHEMA_INVALID",
      secretBearingEvidence.body);

    const secretBearingSummaryEvidence = await app.inject({
      method: "POST",
      url: "/v1/ops/production-readiness/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "readiness-evidence-secret-summary-rejected" },
      payload: {
        evidence_type: "external_alert_delivery",
        status: "valid",
        evidence_at: "2026-06-29T00:05:00.000Z",
        expires_at: "2026-09-29T00:05:00.000Z",
        summary: "Should reject https://hooks.example.invalid/path?token=plain",
        evidence_ref: "ticket:OPS-125",
        metadata: {
          channel: "webhook",
          provider_alias: "webhook-primary",
          receipt_id: "receipt-125",
          receipt_at: "2026-06-29T00:05:30.000Z",
          delivery_status: "delivered",
        },
      },
    });
    check("evidence summary rejects raw endpoint/secret-bearing values",
      secretBearingSummaryEvidence.statusCode === 422 && secretBearingSummaryEvidence.json().code === "IR_SCHEMA_INVALID",
      secretBearingSummaryEvidence.body);

    const missedTargetBackupEvidence = await app.inject({
      method: "POST",
      url: "/v1/ops/production-readiness/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "readiness-evidence-backup-target-missed" },
      payload: {
        evidence_type: "managed_backup_restore_drill",
        status: "valid",
        evidence_at: "2026-06-29T00:10:00.000Z",
        expires_at: "2026-09-29T00:10:00.000Z",
        summary: "Managed backup PITR restore drill exceeded the controlled-prod RPO target.",
        evidence_ref: "drill:PITR-2026-06-28",
        metadata: {
          backup_policy_ref: "backup-policy:managed-pg-prod",
          restore_scope: "tenant-a-control-plane",
          restore_completed_at: "2026-06-29T00:30:00.000Z",
          rto_minutes: 20,
          rpo_minutes: 30,
        },
      },
    });
    check("valid managed backup evidence must meet controlled-prod RTO/RPO targets",
      missedTargetBackupEvidence.statusCode === 422 &&
        missedTargetBackupEvidence.json().code === "IR_SCHEMA_INVALID",
      missedTargetBackupEvidence.body);

    const backupEvidence = await app.inject({
      method: "POST",
      url: "/v1/ops/production-readiness/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "readiness-evidence-backup-1" },
      payload: {
        evidence_type: "managed_backup_restore_drill",
        status: "valid",
        evidence_at: "2026-06-29T00:10:00.000Z",
        expires_at: "2026-09-29T00:10:00.000Z",
        summary: "Managed backup PITR restore drill completed within target.",
        evidence_ref: "drill:PITR-2026-06-29",
        metadata: {
          backup_policy_ref: "backup-policy:managed-pg-prod",
          restore_scope: "tenant-a-control-plane",
          restore_completed_at: "2026-06-29T00:30:00.000Z",
          rto_minutes: 20,
          rpo_minutes: 5,
        },
      },
    });
    check("admin records managed backup/PITR restore evidence",
      backupEvidence.statusCode === 201 &&
        (backupEvidence.json() as { evidence_type: string }).evidence_type === "managed_backup_restore_drill",
      backupEvidence.body);

    const incompleteSloEvidence = await app.inject({
      method: "POST",
      url: "/v1/ops/production-readiness/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "readiness-evidence-slo-incomplete" },
      payload: {
        evidence_type: "slo_oncall_signoff",
        status: "valid",
        evidence_at: "2026-06-29T00:11:00.000Z",
        expires_at: "2026-09-29T00:11:00.000Z",
        summary: "SLO dashboard exists, but on-call/RACI coverage is not attached.",
        evidence_ref: "ticket:SRE-454",
        metadata: { slo_dashboard: "grafana-folder-rpa", severity_model: "sev1-sev4", raci_ref: "raci:SRE-RPA", support_hours: "24x7" },
      },
    });
    check("valid SLO/on-call evidence requires dashboard, severity model, rota, RACI, and support-hours metadata",
      incompleteSloEvidence.statusCode === 422 &&
        incompleteSloEvidence.json().code === "IR_SCHEMA_INVALID",
      incompleteSloEvidence.body);

    const failedSloEvidence = await app.inject({
      method: "POST",
      url: "/v1/ops/production-readiness/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "readiness-evidence-slo-failed-1" },
      payload: {
        evidence_type: "slo_oncall_signoff",
        status: "failed",
        evidence_at: "2026-06-29T00:12:00.000Z",
        summary: "SLO dashboard exists, but on-call coverage was not approved.",
        evidence_ref: "ticket:SRE-455",
        metadata: { slo_dashboard: "grafana-folder-rpa", oncall_gap: "secondary_missing" },
      },
    });
    check("admin records failed SLO/on-call evidence",
      failedSloEvidence.statusCode === 201 &&
        (failedSloEvidence.json() as { evidence_type: string; status: string }).evidence_type === "slo_oncall_signoff" &&
        (failedSloEvidence.json() as { status: string }).status === "failed",
      failedSloEvidence.body);

    const blockedByFailedSloEvidence = await app.inject({
      method: "GET",
      url: "/v1/ops/production-readiness",
      headers: { authorization: `Bearer ${viewer}` },
    });
    const blockedByFailedSloBody = blockedByFailedSloEvidence.json() as {
      status: string;
      summary: { blocker_count: number; deferred_count: number; controlled_prod_ready: boolean };
      gates: Array<{ gate_id: string; status: string; reason_code: string | null }>;
    };
    check("failed SLO/on-call evidence blocks controlled-prod readiness",
      blockedByFailedSloEvidence.statusCode === 200 &&
        blockedByFailedSloBody.status === "blocked" &&
        blockedByFailedSloBody.summary.blocker_count === 1 &&
        blockedByFailedSloBody.summary.deferred_count === 2 &&
        blockedByFailedSloBody.summary.controlled_prod_ready === false &&
        blockedByFailedSloBody.gates.find((item) => item.gate_id === "slo_oncall_signoff")?.reason_code === "slo_oncall_signoff_failed",
      blockedByFailedSloEvidence.body);

    const sloEvidence = await app.inject({
      method: "POST",
      url: "/v1/ops/production-readiness/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "readiness-evidence-slo-1" },
      payload: {
        evidence_type: "slo_oncall_signoff",
        status: "valid",
        evidence_at: "2026-06-29T00:15:00.000Z",
        expires_at: "2026-09-29T00:15:00.000Z",
        summary: "SLO dashboard, severity policy, and on-call/RACI sign-off approved.",
        evidence_ref: "ticket:SRE-456",
        metadata: {
          slo_dashboard: "grafana-folder-rpa",
          severity_model: "sev1-sev4",
          oncall_rota: "primary-secondary",
          raci_ref: "raci:SRE-RPA",
          support_hours: "24x7",
        },
      },
    });
    check("admin records SLO/on-call sign-off evidence",
      sloEvidence.statusCode === 201 &&
        (sloEvidence.json() as { evidence_type: string }).evidence_type === "slo_oncall_signoff",
      sloEvidence.body);

    const incompleteObservabilityEvidence = await app.inject({
      method: "POST",
      url: "/v1/ops/production-readiness/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "readiness-evidence-observability-incomplete" },
      payload: {
        evidence_type: "observability_telemetry_wiring",
        status: "valid",
        evidence_at: "2026-06-29T00:16:00.000Z",
        expires_at: "2026-09-29T00:16:00.000Z",
        summary: "OTLP collector and dashboard are named, but alert route evidence is missing.",
        evidence_ref: "ticket:OBS-123",
        metadata: {
          exporter: "otlp",
          collector_ref: "otel-collector:rpa-prod",
          dashboard_ref: "grafana-folder-rpa",
          sampled_at: "2026-06-29T00:16:30.000Z",
        },
      },
    });
    check("valid observability evidence requires exporter, collector, dashboard, alert route, and sample timestamp metadata",
      incompleteObservabilityEvidence.statusCode === 422 &&
        incompleteObservabilityEvidence.json().code === "IR_SCHEMA_INVALID",
      incompleteObservabilityEvidence.body);

    const observabilityEvidence = await app.inject({
      method: "POST",
      url: "/v1/ops/production-readiness/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "readiness-evidence-observability-1" },
      payload: {
        evidence_type: "observability_telemetry_wiring",
        status: "valid",
        evidence_at: "2026-06-29T00:16:00.000Z",
        expires_at: "2026-09-29T00:16:00.000Z",
        summary: "OTLP collector, dashboard, and alert route evidence approved.",
        evidence_ref: "ticket:OBS-124",
        metadata: {
          exporter: "otlp",
          collector_ref: "otel-collector:rpa-prod",
          dashboard_ref: "grafana-folder-rpa",
          alert_route_ref: "alert-route:rpa-sev",
          sampled_at: "2026-06-29T00:16:30.000Z",
        },
      },
    });
    check("admin records observability telemetry wiring evidence",
      observabilityEvidence.statusCode === 201 &&
        (observabilityEvidence.json() as { evidence_type: string }).evidence_type === "observability_telemetry_wiring",
      observabilityEvidence.body);

    const incompleteSupportTrainingEvidence = await app.inject({
      method: "POST",
      url: "/v1/ops/production-readiness/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "readiness-evidence-support-training-incomplete" },
      payload: {
        evidence_type: "support_training_completion",
        status: "valid",
        evidence_at: "2026-06-29T00:17:00.000Z",
        expires_at: "2026-09-29T00:17:00.000Z",
        summary: "Support model exists, but training completion coverage is missing.",
        evidence_ref: "ticket:TRAIN-122",
        metadata: {
          support_model_ref: "support-model:L1-L3",
          training_completion_ref: "training:completion-2026-06",
          trained_role_count: 3,
          trained_user_count: 18,
          completed_at: "2026-06-29T00:17:30.000Z",
        },
      },
    });
    check("valid support/training evidence requires coverage metadata",
      incompleteSupportTrainingEvidence.statusCode === 422 &&
        incompleteSupportTrainingEvidence.json().code === "IR_SCHEMA_INVALID",
      incompleteSupportTrainingEvidence.body);

    const supportTrainingRosterDenied = await app.inject({
      method: "POST",
      url: "/v1/ops/production-readiness/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "readiness-evidence-support-training-roster-denied" },
      payload: {
        evidence_type: "support_training_completion",
        status: "valid",
        evidence_at: "2026-06-29T00:17:00.000Z",
        expires_at: "2026-09-29T00:17:00.000Z",
        summary: "Support and training completion approved.",
        evidence_ref: "ticket:TRAIN-123",
        metadata: {
          support_model_ref: "support-model:L1-L3",
          training_completion_ref: "training:completion-2026-06",
          trained_role_count: 3,
          trained_user_count: 18,
          coverage_percent: 100,
          completed_at: "2026-06-29T00:17:30.000Z",
          training_roster: "raw user roster must not be stored",
        },
      },
    });
    check("support/training evidence forbids raw roster metadata",
      supportTrainingRosterDenied.statusCode === 422 &&
        supportTrainingRosterDenied.json().details?.reason === "metadata_secret_or_endpoint_key_forbidden",
      supportTrainingRosterDenied.body);

    const supportTrainingEvidence = await app.inject({
      method: "POST",
      url: "/v1/ops/production-readiness/evidence",
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "readiness-evidence-support-training-1" },
      payload: {
        evidence_type: "support_training_completion",
        status: "valid",
        evidence_at: "2026-06-29T00:17:00.000Z",
        expires_at: "2026-09-29T00:17:00.000Z",
        summary: "Support model and role training completion approved.",
        evidence_ref: "ticket:TRAIN-123",
        metadata: {
          support_model_ref: "support-model:L1-L3",
          training_completion_ref: "training:completion-2026-06",
          trained_role_count: 3,
          trained_user_count: 18,
          coverage_percent: 100,
          completed_at: "2026-06-29T00:17:30.000Z",
        },
      },
    });
    check("admin records support/training completion evidence",
      supportTrainingEvidence.statusCode === 201 &&
        (supportTrainingEvidence.json() as { evidence_type: string }).evidence_type === "support_training_completion",
      supportTrainingEvidence.body);

    const evidenceList = await app.inject({
      method: "GET",
      url: "/v1/ops/production-readiness/evidence?limit=10",
      headers: { authorization: `Bearer ${viewer}` },
    });
    check("viewer lists metadata-only readiness evidence",
      evidenceList.statusCode === 200 &&
        (evidenceList.json() as { items: unknown[] }).items.length === 6,
      evidenceList.body);

    const readyWithOwnerEvidence = await app.inject({
      method: "GET",
      url: "/v1/ops/production-readiness",
      headers: { authorization: `Bearer ${viewer}` },
    });
    const bodyWithOwnerEvidence = readyWithOwnerEvidence.json() as {
      status: string;
      summary: { blocker_count: number; warning_count: number; deferred_count: number; controlled_prod_ready: boolean };
      gates: Array<{ gate_id: string; status: string; reason_code: string | null; evidence: string[] }>;
    };
    const gateWithOwnerEvidence = (id: string) => bodyWithOwnerEvidence.gates.find((item) => item.gate_id === id);
    check("owner evidence closes controlled-prod deferred gates",
      readyWithOwnerEvidence.statusCode === 200 &&
        bodyWithOwnerEvidence.status === "ready" &&
        bodyWithOwnerEvidence.summary.controlled_prod_ready === true &&
        bodyWithOwnerEvidence.summary.blocker_count === 0 &&
        bodyWithOwnerEvidence.summary.warning_count === 0 &&
        bodyWithOwnerEvidence.summary.deferred_count === 0 &&
        gateWithOwnerEvidence("external_alert_delivery")?.status === "pass" &&
        gateWithOwnerEvidence("managed_backup_restore_drill")?.status === "pass" &&
        gateWithOwnerEvidence("slo_oncall_signoff")?.status === "pass" &&
        gateWithOwnerEvidence("observability_telemetry_wiring")?.status === "pass" &&
        gateWithOwnerEvidence("support_training_completion")?.status === "pass",
      readyWithOwnerEvidence.body);

    await withTenantTx(pool, TENANT_A, async (client) => {
      await client.query(
        `INSERT INTO ai_runtime_policies (
           id, tenant_id, mode, subject_mapping_ref, emergency_override_owner_ref,
           policy_decision_ref, evidence_ref, updated_by
         )
         VALUES (
           '83000000-0000-4000-8000-0000000008a1'::uuid,
           $1::uuid,
           'block',
           'policy:ai-subject-map',
           'group:ai-override-owners',
           'policy-decision:ai-runtime-block',
           'artifact:ai-runtime-policy',
           'admin-a'
         )`,
        [TENANT_A],
      );
    });
    const configuredPromptApp = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer: { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} } as RunEnqueuer,
      signedCommandRegistry,
      authReadiness: SSO_READY,
      aiGovernanceConfiguredModels: ["codex-configured"],
      aiGovernanceConfiguredPromptVersions: ["dom-executor@configured"],
    });
    await configuredPromptApp.ready();
    try {
      const configuredPromptReadiness = await configuredPromptApp.inject({
        method: "GET",
        url: "/v1/ops/production-readiness",
        headers: { authorization: `Bearer ${viewer}` },
      });
      const configuredPromptBody = configuredPromptReadiness.json() as {
        status: string;
        gates: Array<{ gate_id: string; status: string; reason_code: string | null; evidence: string[] }>;
        signals: {
          ai_governance: {
            configured_models?: string[];
            prompt_template_versions?: string[];
            requirements?: Array<{ evidence_type: string; subject_ref: string; status: string }>;
          };
        };
      };
      const configuredPromptGate = configuredPromptBody.gates.find((item) => item.gate_id === "ai_governance_runtime");
      const requirements = configuredPromptBody.signals.ai_governance.requirements ?? [];
      check("configured model and prompt version block AI readiness before any observed LLM call",
        configuredPromptReadiness.statusCode === 200 &&
          configuredPromptBody.status === "blocked" &&
          configuredPromptGate?.status === "blocked" &&
          configuredPromptGate.reason_code === "ai_governance_block_missing_evidence" &&
          configuredPromptBody.signals.ai_governance.configured_models?.includes("codex-configured") === true &&
          configuredPromptBody.signals.ai_governance.prompt_template_versions?.includes("dom-executor@configured") === true &&
          requirements.some((item) => item.evidence_type === "model_registry" && item.subject_ref === "model:codex-configured" && item.status === "missing") &&
          requirements.some((item) => item.evidence_type === "cost_control" && item.subject_ref === `tenant:${TENANT_A}:ai_cost_control` && item.status === "missing") &&
          requirements.some((item) => item.evidence_type === "prompt_registry" && item.subject_ref === "prompt:dom-executor@configured" && item.status === "missing") &&
          requirements.some((item) => item.evidence_type === "eval_result" && item.subject_ref === "prompt:dom-executor@configured" && item.status === "missing"),
        configuredPromptReadiness.body);
    } finally {
      await configuredPromptApp.close();
      await withTenantTx(pool, TENANT_A, async (client) => {
        await client.query(`UPDATE ai_runtime_policies SET deleted_at = now() WHERE tenant_id = $1::uuid`, [TENANT_A]);
      });
    }

    await withTenantTx(pool, TENANT_A, async (client) => {
      await client.query(
        `INSERT INTO gateway_policies (id, tenant_id, model, capabilities, budget, is_default)
         VALUES (
           '83000000-0000-4000-8000-000000000901'::uuid,
           $1::uuid,
           'codex-prod-primary',
           '{"domReasoning":true,"vision":false,"jsonMode":false,"toolCall":false,"sse":true,"maxContextTokens":8000}'::jsonb,
           '{"maxInputTokens":10000,"maxOutputTokens":2000,"maxCost":10}'::jsonb,
           true
         )`,
        [TENANT_A],
      );
    });
    const aiPolicyMissingReadiness = await app.inject({
      method: "GET",
      url: "/v1/ops/production-readiness",
      headers: { authorization: `Bearer ${viewer}` },
    });
    const aiPolicyMissingBody = aiPolicyMissingReadiness.json() as {
      status: string;
      summary: { deferred_count: number; controlled_prod_ready: boolean };
      gates: Array<{ gate_id: string; status: string; reason_code: string | null }>;
    };
    const aiGate = aiPolicyMissingBody.gates.find((item) => item.gate_id === "ai_governance_runtime");
    check("AI runtime use without policy defers controlled-prod readiness",
      aiPolicyMissingReadiness.statusCode === 200 &&
        aiPolicyMissingBody.status === "warning" &&
        aiPolicyMissingBody.summary.deferred_count === 1 &&
        aiPolicyMissingBody.summary.controlled_prod_ready === false &&
        aiGate?.status === "deferred" &&
        aiGate.reason_code === "ai_runtime_policy_missing",
      aiPolicyMissingReadiness.body);

    const tenantB = await app.inject({
      method: "GET",
      url: "/v1/ops/production-readiness",
      headers: { authorization: `Bearer ${viewerB}` },
    });
    const bodyB = tenantB.json() as { status: string; summary: { blocker_count: number }; gates: Array<{ gate_id: string; reason_code: string | null }> };
    check("tenant B missing tenant evidence is blocked",
      tenantB.statusCode === 200 &&
        bodyB.status === "blocked" &&
        bodyB.summary.blocker_count >= 2 &&
        bodyB.gates.some((item) => item.gate_id === "browser_pool_ha") &&
        bodyB.gates.some((item) => item.reason_code === "audit_log_empty"),
      tenantB.body);

    const denied = await app.inject({
      method: "GET",
      url: "/v1/ops/production-readiness",
      headers: { authorization: `Bearer ${noRole}` },
    });
    check("no-role production readiness denied -> 403", denied.statusCode === 403 && denied.json().code === "AUTHZ_FORBIDDEN", denied.body);
  } finally {
    await app.close();
    await pool.end();
  }
  if (failures > 0) {
    console.error(`FAIL: ${failures} production readiness API check(s) failed`);
    process.exit(1);
  }
  console.log("PASS: production readiness API integration green");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
