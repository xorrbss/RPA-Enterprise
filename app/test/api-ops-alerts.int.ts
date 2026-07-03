/**
 * Integration test for /v1/ops-alerts.
 *
 * Run with:
 *   npm --prefix app exec tsx -- app/test/api-ops-alerts.int.ts
 */
import { readFileSync } from "node:fs";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import { webhookSigningPayload } from "../src/api/webhook-trigger-auth";
import { createPool, withTenantTx } from "../src/db/pool";
import type { PlainSecret, SecretRef } from "../../ts/core-types";
import type { SecretStoreBoundary, SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_ops_alerts_int";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const SCEN_A = "8a000000-0000-4000-8000-000000000001";
const SVER_A = "8a000000-0000-4000-8000-000000000002";
const SCEN_B = "8b000000-0000-4000-8000-000000000001";
const SVER_B = "8b000000-0000-4000-8000-000000000002";
const RUN_A = "8a100000-0000-4000-8000-000000000001";
const RUN_FAIL_1 = "8a100000-0000-4000-8000-000000000101";
const RUN_FAIL_2 = "8a100000-0000-4000-8000-000000000102";
const RUN_FAIL_3 = "8a100000-0000-4000-8000-000000000103";
const RUN_SLA_EXTRA = [
  "8a100000-0000-4000-8000-000000000201",
  "8a100000-0000-4000-8000-000000000202",
  "8a100000-0000-4000-8000-000000000203",
  "8a100000-0000-4000-8000-000000000204",
] as const;
const RUN_B = "8b100000-0000-4000-8000-000000000001";
const HT_WARNING = "8a200000-0000-4000-8000-000000000001";
const HT_CRITICAL = "8a200000-0000-4000-8000-000000000002";
const TRIGGER_A = "8a300000-0000-4000-8000-000000000001";
const FIRE_A = "8a310000-0000-4000-8000-000000000001";
const WORKITEM_A = "8a400000-0000-4000-8000-000000000001";
const DLQ_A = "8a410000-0000-4000-8000-000000000001";
const ART_FAILED = "8a420000-0000-4000-8000-000000000001";
const ART_FAILURE_ROW = "8a430000-0000-4000-8000-000000000001";
const RUN_SEC_ABORT = "8a100000-0000-4000-8000-000000000301";
const WORKER_POOL_A = "8a500000-0000-4000-8000-000000000001";
const SITE_POOL_A = "8a600000-0000-4000-8000-000000000001";
const IDENTITY_POOL_A = "8a700000-0000-4000-8000-000000000001";
const LEASE_POOL_EXPIRED = "8a800000-0000-4000-8000-000000000001";
const AUDIT_A = "8a900000-0000-4000-8000-000000000001";
const AUDIT_VERIFIER_INVALID = "8a910000-0000-4000-8000-000000000001";
const READINESS_EVIDENCE_SLO = "8aa00000-0000-4000-8000-000000000001";
const READINESS_EVIDENCE_SUPPORT = "8aa00000-0000-4000-8000-000000000002";
// S4b session_expiry: 같은 site/identity 에 identity_key 로 구분되는 세션 2건(임박 warning / 만료 critical).
const SESSION_KEY_SOON = "";
const SESSION_KEY_OVERDUE = "ops@example.com";

function md5Hex(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

function sessionExpiryAlertId(identityKey: string): string {
  return `session_expiry:${SITE_POOL_A}:${IDENTITY_POOL_A}:${md5Hex(identityKey)}`;
}
const OPS_CALLBACK_SIGNATURE_SECRET_REF = "secret://tenant-a/notification/webhook/callback-signing" as SecretRef;
const OPS_CALLBACK_SIGNATURE_SECRET = "ops-notification-callback-signing-secret" as PlainSecret;

const SECRET = new TextEncoder().encode("ops-alerts-int-secret-do-not-use-in-prod-0123456789");

const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return { kind: "available", snapshot: { sourceRef: "secret://staging/registry" as SecretRef, commands: [] } };
  },
};

const opsCallbackBoundaryCalls: Array<{ ref: string; purpose: string; tenantId: string; connectorId: string | undefined }> = [];
const opsNotificationCallbackSecretBoundary: SecretStoreBoundary = {
  store: {
    async resolve(ref) {
      if (ref !== OPS_CALLBACK_SIGNATURE_SECRET_REF) throw new Error(`unexpected ops callback secret ref: ${ref}`);
      return OPS_CALLBACK_SIGNATURE_SECRET;
    },
  },
  async authorize(request) {
    return { kind: "allow", ref: request.ref };
  },
  async resolveAuthorized(request) {
    opsCallbackBoundaryCalls.push({
      ref: request.ref,
      purpose: request.purpose,
      tenantId: request.principal.tenantId,
      connectorId: request.connectorId,
    });
    return this.store.resolve(request.ref);
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

function isoMinutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function signedOpsNotificationCallbackHeaders(
  receiptId: string,
  body: unknown,
  timestamp = String(Date.now()),
): Record<string, string> {
  const signature = createHmac("sha256", OPS_CALLBACK_SIGNATURE_SECRET)
    .update(webhookSigningPayload(timestamp, receiptId, body))
    .digest("hex");
  return {
    "x-rpa-ops-notification-event-id": receiptId,
    "x-rpa-ops-notification-timestamp": timestamp,
    "x-rpa-ops-notification-signature": `sha256=${signature}`,
  };
}

type Pool = ReturnType<typeof createPool>;

async function deliveryReceiptCount(pool: Pool, tenantId: string, alertId: string): Promise<number> {
  return withTenantTx(pool, tenantId, async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM ops_notification_deliveries
        WHERE tenant_id=$1::uuid AND alert_id=$2 AND deleted_at IS NULL`,
      [tenantId, alertId],
    );
    return Number(result.rows[0]?.count ?? "0");
  });
}

async function seedScenario(pool: Pool, tenant: string, scenarioId: string, versionId: string): Promise<void> {
  await withTenantTx(pool, tenant, async (client) => {
    await client.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'ops alerts')`, [scenarioId, tenant]);
    await client.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'prod','{"nodes":[],"target":{"site_profile_id":"00000000-0000-4000-8000-000000000001","browser_identity_id":"00000000-0000-4000-8000-000000000002","network_policy_id":"00000000-0000-4000-8000-000000000003"}}'::jsonb)`,
      [versionId, tenant, scenarioId],
    );
  });
}

async function seedAlerts(pool: Pool): Promise<void> {
  await seedScenario(pool, TENANT_A, SCEN_A, SVER_A);
  await seedScenario(pool, TENANT_B, SCEN_B, SVER_B);

  const direct = await pool.connect();
  try {
    await direct.query(`SET search_path = ${SCHEMA}, public`);
    await direct.query(
      `INSERT INTO workers (id, kind, status, heartbeat_at, circuit_state)
       VALUES ($1,'browser','active',now(),'closed')`,
      [WORKER_POOL_A],
    );
  } finally {
    direct.release();
  }

  await withTenantTx(pool, TENANT_A, async (client) => {
    await client.query(`INSERT INTO site_profiles (id, tenant_id, name, url_pattern) VALUES ($1,$2,'ops-pool','https://ops-pool.example/*')`, [SITE_POOL_A, TENANT_A]);
    await client.query(`INSERT INTO browser_identities (id, tenant_id, site_profile_id, label) VALUES ($1,$2,$3,'ops-pool')`, [IDENTITY_POOL_A, TENANT_A, SITE_POOL_A]);
    await client.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, created_at, updated_at)
       VALUES ($1,$2,$3,'running',$1,$4::timestamptz,$5::timestamptz)`,
      [RUN_A, TENANT_A, SVER_A, isoMinutesFromNow(-90), isoMinutesFromNow(-5)],
    );
    await client.query(
      `INSERT INTO browser_leases
         (id, tenant_id, site_profile_id, browser_identity_id, run_id, owner_worker_id, isolation, state, cleanup_policy, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'context','active','preserve_session',$7::timestamptz)`,
      [LEASE_POOL_EXPIRED, TENANT_A, SITE_POOL_A, IDENTITY_POOL_A, RUN_A, WORKER_POOL_A, isoMinutesFromNow(-7)],
    );
    // 로그인 세션: 6시간 뒤 만료(임박 warning) + 2시간 전 만료(critical). 쿠키 원문은 절대 시드하지 않는다(불투명 바이트).
    await client.query(
      `INSERT INTO browser_sessions (tenant_id, site_profile_id, browser_identity_id, identity_key, ciphertext, enc_kid, expires_at)
       VALUES ($1,$2,$3,$4,$6::bytea,'dev-plaintext-v1',$7::timestamptz),
              ($1,$2,$3,$5,$6::bytea,'dev-plaintext-v1',$8::timestamptz)`,
      [TENANT_A, SITE_POOL_A, IDENTITY_POOL_A, SESSION_KEY_SOON, SESSION_KEY_OVERDUE, Buffer.from([0]), isoMinutesFromNow(360), isoMinutesFromNow(-120)],
    );
    for (const [index, runId] of RUN_SLA_EXTRA.entries()) {
      await client.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, created_at, updated_at)
         VALUES ($1,$2,$3,'running',$1,$4::timestamptz,$5::timestamptz)`,
        [runId, TENANT_A, SVER_A, isoMinutesFromNow(-100 - index), isoMinutesFromNow(-10 - index)],
      );
    }
    await client.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, created_at, updated_at)
       VALUES ($1,$2,$5,'failed_system',$1,$6::timestamptz,$7::timestamptz),
              ($3,$2,$5,'failed_business',$3,$6::timestamptz,$8::timestamptz),
              ($4,$2,$5,'failed_system',$4,$6::timestamptz,$9::timestamptz)`,
      [RUN_FAIL_1, TENANT_A, RUN_FAIL_2, RUN_FAIL_3, SVER_A, isoMinutesFromNow(-12), isoMinutesFromNow(-8), isoMinutesFromNow(-5), isoMinutesFromNow(-2)],
    );
    await client.query(
      `INSERT INTO human_tasks (id, tenant_id, run_id, kind, state, expires_at, assignee)
       VALUES ($1,$2,$3,'validation','open',$4::timestamptz,'reviewer-a'),
              ($5,$2,$3,'approval','in_progress',$6::timestamptz,'approver-a')`,
      [HT_WARNING, TENANT_A, RUN_A, isoMinutesFromNow(10), HT_CRITICAL, isoMinutesFromNow(-6)],
    );
    await client.query(
      `INSERT INTO run_triggers (id, tenant_id, scenario_version_id, cron_expression, timezone, created_by)
       VALUES ($1,$2,$3,'0 9 * * *','Asia/Seoul','operator-a')`,
      [TRIGGER_A, TENANT_A, SVER_A],
    );
    await client.query(
      `INSERT INTO run_trigger_fires (id, tenant_id, trigger_id, fire_key, status, scheduled_for, failure_reason, correlation_id)
       VALUES ($1,$2,$3,'2026-06-23T00:00:00.000Z','failed',$4::timestamptz,'{"code":"CONTROL_PLANE_INTERNAL_ERROR"}'::jsonb,$1)`,
      [FIRE_A, TENANT_A, TRIGGER_A, isoMinutesFromNow(-30)],
    );
    await client.query(
      `INSERT INTO workitems (id, tenant_id, connector_id, unique_reference, status)
       VALUES ($1,$2,'ops-alerts','ops-alerts-ref','failed_system')`,
      [WORKITEM_A, TENANT_A],
    );
    await client.query(
      `INSERT INTO dead_letter (id, tenant_id, workitem_id, reason_code, replayable, created_at)
       VALUES ($1,$2,$3,'WORKITEM_CHECKOUT_CONFLICT',true,$4::timestamptz)`,
      [DLQ_A, TENANT_A, WORKITEM_A, isoMinutesFromNow(-20)],
    );
    // A4-3 artifact_redaction: failed 아티팩트는 RLS 로 앱에서 안 보이므로, 워커가 finalize tx 에서 push 하는
    // artifact_redaction_failures 원장이 알림의 유일한 원천이다(여기서는 워커 기록 결과를 그대로 시드).
    await client.query(
      `INSERT INTO artifacts (id, tenant_id, run_id, type, redaction_status, redaction_attempts, object_ref, retention_until)
       VALUES ($1,$2,$3,'screenshot','failed',5,'object://ops-alerts/redaction-failed',$4::timestamptz)`,
      [ART_FAILED, TENANT_A, RUN_A, isoDaysFromNow(30)],
    );
    await client.query(
      `INSERT INTO artifact_redaction_failures (id, tenant_id, artifact_id, run_id, failure_kind, attempts, detected_at)
       VALUES ($1,$2,$3,$4,'attempts_exhausted',5,$5::timestamptz)`,
      [ART_FAILURE_ROW, TENANT_A, ART_FAILED, RUN_A, isoMinutesFromNow(-10)],
    );
    // R3-1 security_abort: 보안 예외 즉시 중단(R10→R23) 종결 run — failure_reason.code 가 security 분류.
    await client.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, created_at, updated_at, ended_at, failure_reason)
       VALUES ($1,$2,$3,'cancelled',$1,$4::timestamptz,$5::timestamptz,$5::timestamptz,'{"code":"DOMAIN_POLICY_VIOLATION","message":""}'::jsonb)`,
      [RUN_SEC_ABORT, TENANT_A, SVER_A, isoMinutesFromNow(-30), isoMinutesFromNow(-3)],
    );
    await client.query(
      `INSERT INTO scim_providers
         (id, tenant_id, provider_key, display_name, status, inbound_schema_ref, auth_mode,
          signature_secret_ref, secret_rotation_policy, clock_skew_seconds, created_by, created_at,
          decommissioned_at, decommissioned_by, decommission_reason)
       VALUES
         (gen_random_uuid(), $1::uuid, 'okta-due-soon', 'Okta Due Soon', 'active', 'scim-principal@1',
          'signed_request_v1', 'secret://tenant-a/scim/okta-due-soon/signing', 'periodic_30d', 300, 'ops-test', $2::timestamptz,
          NULL, NULL, NULL),
         (gen_random_uuid(), $1::uuid, 'okta-overdue', 'Okta Overdue', 'active', 'scim-principal@1',
          'signed_request_v1', 'secret://tenant-a/scim/okta-overdue/signing', 'periodic_30d', 300, 'ops-test', $3::timestamptz,
          NULL, NULL, NULL),
         (gen_random_uuid(), $1::uuid, 'okta-manual', 'Okta Manual', 'active', 'scim-principal@1',
          'signed_request_v1', 'secret://tenant-a/scim/okta-manual/signing', 'manual', 300, 'ops-test', $4::timestamptz,
          NULL, NULL, NULL),
         (gen_random_uuid(), $1::uuid, 'okta-decommissioned', 'Okta Decommissioned', 'disabled', 'scim-principal@1',
          'signed_request_v1', 'secret://tenant-a/scim/okta-decommissioned/signing', 'periodic_30d', 300, 'ops-test', $5::timestamptz,
          now(), 'ops-test', 'retired')`,
      [TENANT_A, isoDaysFromNow(-25), isoDaysFromNow(-31), isoDaysFromNow(-365), isoDaysFromNow(-365)],
    );
    await client.query(
      `INSERT INTO audit_log (
         id, tenant_id, sequence_no, actor, action, outcome, reason, correlation_id,
         idempotency_key, occurred_at, payload, retention_until, previous_hash, hash
       )
       VALUES (
         $1,$2::uuid,1,'{"subjectId":"operator-a","roles":["admin"]}'::jsonb,
         'ops_alert.audit_seed','allow',NULL,$1,'ops-alert-audit-seed',$3::timestamptz,
         '{"kind":"ops_alert_seed"}'::jsonb,$4::timestamptz,NULL,'sha256:ops-alert-audit-seed'
       )`,
      [AUDIT_A, TENANT_A, isoMinutesFromNow(-95), isoDaysFromNow(90)],
    );
    await client.query(
      `INSERT INTO audit_verifier_runs (
         id, tenant_id, status, rows_checked, violation_count, violations,
         checked_from_sequence, checked_to_sequence, started_at, completed_at,
         correlation_id, triggered_by, trigger_kind, retention_until, legal_hold
       )
       VALUES (
         $1,$2::uuid,'invalid',1,1,
         '[{"sequenceNo":1,"id":"8a900000-0000-4000-8000-000000000001","kind":"hash_mismatch","detail":"test mismatch"}]'::jsonb,
         1,1,$3::timestamptz,$4::timestamptz,$1,
         '{"subjectId":"system:maintenance","roles":["system","audit_verifier"]}'::jsonb,
         'maintenance',$5::timestamptz,false
      )`,
      [AUDIT_VERIFIER_INVALID, TENANT_A, isoMinutesFromNow(-91), isoMinutesFromNow(-90), isoDaysFromNow(90)],
    );
    await client.query(
      `INSERT INTO production_readiness_evidence (
         id, tenant_id, evidence_type, status, evidence_at, expires_at,
         summary, evidence_ref, metadata, recorded_by, retention_until, legal_hold
       )
       VALUES (
         $1,$2::uuid,'slo_oncall_signoff','valid',$3::timestamptz,$4::timestamptz,
         'SLO/on-call signoff expires during pilot readiness review.',
         'artifact://readiness/slo-oncall/2026-06-29',
         '{
           "slo_dashboard":"grafana-rpa-controlled-prod",
           "severity_model":"sev1-sev4",
           "oncall_rota":"ops-primary-weekly",
           "raci_ref":"raci-rpa-ops",
           "support_hours":"24x7"
         }'::jsonb,
         'ops-test',$5::timestamptz,false
       )`,
      [READINESS_EVIDENCE_SLO, TENANT_A, isoDaysFromNow(-25), isoDaysFromNow(3), isoDaysFromNow(365)],
    );
    await client.query(
      `INSERT INTO production_readiness_evidence (
         id, tenant_id, evidence_type, status, evidence_at, expires_at,
         summary, evidence_ref, metadata, recorded_by, retention_until, legal_hold
       )
       VALUES (
         $1,$2::uuid,'support_training_completion','failed',$3::timestamptz,NULL,
         'Support model exists, but role training completion evidence failed.',
         'artifact://readiness/support-training/2026-06-29',
         '{
           "support_model_ref":"support-model:L1-L3",
           "training_completion_ref":"training:completion-2026-06",
           "trained_role_count":3,
           "trained_user_count":12,
           "coverage_percent":80,
           "completed_at":"2026-06-29T00:17:30.000Z"
         }'::jsonb,
         'ops-test',$4::timestamptz,false
       )`,
      [READINESS_EVIDENCE_SUPPORT, TENANT_A, isoDaysFromNow(-1), isoDaysFromNow(365)],
    );
  });

  await withTenantTx(pool, TENANT_B, async (client) => {
    await client.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, created_at)
       VALUES ($1,$2,$3,'running',$1,$4::timestamptz)`,
      [RUN_B, TENANT_B, SVER_B, isoMinutesFromNow(-10)],
    );
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const enqueuedNotifications: Array<{ tenantId: string; attemptId: string; correlationId: string }> = [];
  const enqueuer: RunEnqueuer = {
    async enqueueRunClaim() {},
    async enqueueRunAbort() {},
    async enqueueSinkDeliver() {},
    async enqueueOpsNotificationSend(_client, input) {
      enqueuedNotifications.push(input);
    },
  };
  const app = buildServer({
    pool,
    auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
    rbac: new RoleMatrixRbacMiddleware(),
    idempotency: new PgControlPlaneIdempotencyStore(pool),
    enqueuer,
    signedCommandRegistry,
    opsNotificationCallbackSecretBoundary,
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
    await seedAlerts(pool);
    await app.ready();

    const viewer = await mint(["viewer"]);
    const operator = await mint(["operator"], TENANT_A, "operator-a");
    const admin = await mint(["admin"], TENANT_A, "admin-a");
    const noRole = await mint([]);
    const viewerB = await mint(["viewer"], TENANT_B, "viewer-b");

    // limit=25: security_abort(critical) 추가로 20건 페이지에서 마지막 warning 이 밀려나 전소스 존재 단언이 깨지지 않게.
    const all = await app.inject({ method: "GET", url: "/v1/ops-alerts?limit=25", headers: { authorization: `Bearer ${viewer}` } });
    check("viewer list ops alerts -> 200", all.statusCode === 200, all.body);
    const allBody = all.json() as {
      items: Array<{
        alert_id: string;
        severity: string;
        source: string;
        route: string | null;
        status: string;
        delivery: { channel: string; external_delivery: boolean };
        ack: null | { acknowledged_by: string; acknowledged_at: string; comment: string | null };
      }>;
      next_cursor: string | null;
    };
    const alertById = new Map(allBody.items.map((item) => [item.alert_id, item]));
    check(
      "all twelve alert sources are present",
      ["run_sla", "human_task_sla", "trigger_fire", "failure_spike", "dlq", "bot_pool", "scim_secret_rotation", "audit_verifier", "readiness_evidence", "session_expiry", "artifact_redaction", "security_abort"].every((source) =>
        allBody.items.some((item) => item.source === source),
      ),
      all.body,
    );
    check("console delivery metadata is explicit and unacked by default", allBody.items.every((item) => item.status === "open" && item.delivery.channel === "console" && item.delivery.external_delivery === false && item.ack === null), all.body);
    check("critical alerts sort first", allBody.items[0]?.severity === "critical", all.body);
    check("route hints are console hash routes", allBody.items.some((item) => typeof item.route === "string" && item.route.startsWith("#")), all.body);
    check("run SLA route deep-links to run trace subject", alertById.get(`run_sla:${RUN_A}`)?.route === `#runTrace?run=${RUN_A}`, all.body);
    check("human task SLA route deep-links to task subject", alertById.get(`human_task_sla:${HT_CRITICAL}`)?.route === `#humanTasks?ht=${HT_CRITICAL}`, all.body);
    check("trigger fire route deep-links to trigger subject", alertById.get(`trigger_fire:${FIRE_A}`)?.route === `#automationOps?trigger=${TRIGGER_A}`, all.body);
    check("bot pool alert deep-links to automationOps queue section", alertById.get("bot_pool:browser-default")?.route === "#automationOps?section=queue", all.body);
    check("audit verifier alert targets Audit Explorer", alertById.get(`audit_verifier:${AUDIT_VERIFIER_INVALID}`)?.route === "#auditExplorer", all.body);
    check("readiness evidence alert targets production readiness panel", alertById.get("readiness_evidence:slo_oncall_signoff")?.route === "#automationOps?section=readiness", all.body);

    const scimOnly = await app.inject({ method: "GET", url: "/v1/ops-alerts?source=scim_secret_rotation", headers: { authorization: `Bearer ${viewer}` } });
    const scimBody = scimOnly.json() as {
      items: Array<{ alert_id: string; source: string; severity: string; subject_type: string; subject_id: string | null; route: string | null; due_at: string | null }>;
    };
    check("SCIM SecretRef rotation alert filter -> 200", scimOnly.statusCode === 200, scimOnly.body);
    check(
      "SCIM SecretRef rotation emits due soon and overdue only",
      scimBody.items.length === 2 &&
        scimBody.items.some((item) => item.alert_id === "scim_secret_rotation:okta-due-soon" && item.severity === "warning") &&
        scimBody.items.some((item) => item.alert_id === "scim_secret_rotation:okta-overdue" && item.severity === "critical") &&
        scimBody.items.every((item) => item.source === "scim_secret_rotation" && item.subject_type === "scim_provider" && typeof item.due_at === "string") &&
        !scimBody.items.some((item) => item.subject_id === "okta-manual" || item.subject_id === "okta-decommissioned"),
      scimOnly.body,
    );
    check(
      "SCIM SecretRef rotation alert routes to security console",
      scimBody.items.every((item) => item.route?.startsWith("#security?section=access") === true),
      scimOnly.body,
    );

    const auditOnly = await app.inject({ method: "GET", url: "/v1/ops-alerts?source=audit_verifier", headers: { authorization: `Bearer ${viewer}` } });
    const auditBody = auditOnly.json() as {
      items: Array<{ alert_id: string; source: string; severity: string; subject_type: string; subject_id: string | null; route: string | null; due_at?: string | null }>;
    };
    check("audit verifier alert filter -> 200", auditOnly.statusCode === 200, auditOnly.body);
    check(
      "audit verifier emits invalid and stale metadata-only alerts",
      auditBody.items.length === 2 &&
        auditBody.items.some((item) => item.alert_id === `audit_verifier:${AUDIT_VERIFIER_INVALID}` && item.severity === "critical" && item.subject_id === AUDIT_VERIFIER_INVALID) &&
        auditBody.items.some((item) => item.alert_id === "audit_verifier:stale" && item.severity === "warning" && typeof item.due_at === "string") &&
        auditBody.items.every((item) => item.source === "audit_verifier" && item.subject_type === "audit_verifier" && item.route === "#auditExplorer"),
      auditOnly.body,
    );

    const readinessOnly = await app.inject({ method: "GET", url: "/v1/ops-alerts?source=readiness_evidence", headers: { authorization: `Bearer ${viewer}` } });
    const readinessBody = readinessOnly.json() as {
      items: Array<{ alert_id: string; source: string; severity: string; subject_type: string; subject_id: string | null; route: string | null; due_at?: string | null; detail: string }>;
    };
    check("readiness evidence alert filter -> 200", readinessOnly.statusCode === 200, readinessOnly.body);
    check(
      "readiness evidence emits due-soon and failed metadata-only alerts",
      readinessBody.items.length === 2 &&
        readinessBody.items.some((item) =>
          item.alert_id === "readiness_evidence:slo_oncall_signoff" &&
          item.severity === "warning" &&
          item.subject_id === "slo_oncall_signoff" &&
          typeof item.due_at === "string" &&
          !item.detail.includes("artifact://"),
        ) &&
        readinessBody.items.some((item) =>
          item.alert_id === "readiness_evidence:support_training_completion" &&
          item.severity === "critical" &&
          item.subject_id === "support_training_completion" &&
          !item.detail.includes("artifact://"),
        ) &&
        readinessBody.items.every((item) =>
          item.source === "readiness_evidence" &&
          item.subject_type === "readiness_evidence" &&
          item.route === "#automationOps?section=readiness",
        ),
      readinessOnly.body,
    );

    // S4b: session_expiry — 목록/필터/by-id(ack 경유)/ack 원장.
    const sessionOnly = await app.inject({ method: "GET", url: "/v1/ops-alerts?source=session_expiry", headers: { authorization: `Bearer ${viewer}` } });
    const sessionBody = sessionOnly.json() as {
      items: Array<{ alert_id: string; source: string; severity: string; title: string; detail: string; subject_type: string; subject_id: string | null; route: string | null; due_at?: string | null; detected_at: string }>;
    };
    check("session expiry alert filter -> 200", sessionOnly.statusCode === 200, sessionOnly.body);
    check(
      "session expiry emits overdue critical and due-soon warning",
      sessionBody.items.length === 2 &&
        sessionBody.items[0]?.alert_id === sessionExpiryAlertId(SESSION_KEY_OVERDUE) &&
        sessionBody.items[0]?.severity === "critical" &&
        sessionBody.items[0]?.title === "로그인 세션 만료" &&
        sessionBody.items.some((item) => item.alert_id === sessionExpiryAlertId(SESSION_KEY_SOON) && item.severity === "warning" && item.title === "로그인 세션 만료 임박"),
      sessionOnly.body,
    );
    check(
      "session expiry alerts carry browser_session subject + site deep-link + stable due_at",
      sessionBody.items.every((item) =>
        item.source === "session_expiry" &&
        item.subject_type === "browser_session" &&
        item.subject_id === SITE_POOL_A &&
        item.route === `#security?section=sites&site=${SITE_POOL_A}` &&
        typeof item.due_at === "string" &&
        item.due_at === item.detected_at,
      ),
      sessionOnly.body,
    );
    check(
      "session expiry detail is operator Korean and never leaks cookies or identity key",
      sessionBody.items.every((item) => item.detail.includes("만료") && !item.detail.includes(SESSION_KEY_OVERDUE) && !JSON.stringify(item).includes(SESSION_KEY_OVERDUE)),
      sessionOnly.body,
    );

    const sessionAckMissing = await app.inject({
      method: "POST",
      url: `/v1/ops-alerts/${encodeURIComponent(`session_expiry:${SITE_POOL_A}:${IDENTITY_POOL_A}:${"0".repeat(32)}`)}/ack`,
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": "ack-session-missing" },
      payload: {},
    });
    check("session expiry ack with non-current generation hash -> 404", sessionAckMissing.statusCode === 404 && sessionAckMissing.json().code === "RESOURCE_NOT_FOUND", sessionAckMissing.body);

    const sessionAck = await app.inject({
      method: "POST",
      url: `/v1/ops-alerts/${encodeURIComponent(sessionExpiryAlertId(SESSION_KEY_OVERDUE))}/ack`,
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": "ack-session-overdue" },
      payload: { comment: "세션 재등록 예정" },
    });
    const sessionAckBody = sessionAck.json() as { alert_id: string; status: string; source: string; subject_type: string; ack: { acknowledged_by: string; comment: string | null } };
    check(
      "operator acks overdue session expiry alert (by-id resolves current generation)",
      sessionAck.statusCode === 200 &&
        sessionAckBody.alert_id === sessionExpiryAlertId(SESSION_KEY_OVERDUE) &&
        sessionAckBody.status === "acknowledged" &&
        sessionAckBody.source === "session_expiry" &&
        sessionAckBody.subject_type === "browser_session" &&
        sessionAckBody.ack.acknowledged_by === "operator-a" &&
        sessionAckBody.ack.comment === "세션 재등록 예정",
      sessionAck.body,
    );
    const sessionOpenAfterAck = await app.inject({ method: "GET", url: "/v1/ops-alerts?source=session_expiry", headers: { authorization: `Bearer ${viewer}` } });
    const sessionOpenAfterAckBody = sessionOpenAfterAck.json() as { items: Array<{ alert_id: string; status: string }> };
    check(
      "acked session expiry alert hidden from open list, due-soon one stays open",
      sessionOpenAfterAck.statusCode === 200 &&
        sessionOpenAfterAckBody.items.length === 1 &&
        sessionOpenAfterAckBody.items[0]?.alert_id === sessionExpiryAlertId(SESSION_KEY_SOON) &&
        sessionOpenAfterAckBody.items[0]?.status === "open",
      sessionOpenAfterAck.body,
    );

    // A4-3 artifact_redaction — 레다크션 terminal 실패 원장 알림(목록/필터/ack).
    const redactionOnly = await app.inject({ method: "GET", url: "/v1/ops-alerts?source=artifact_redaction", headers: { authorization: `Bearer ${viewer}` } });
    const redactionBody = redactionOnly.json() as {
      items: Array<{ alert_id: string; source: string; severity: string; title: string; detail: string; subject_type: string; subject_id: string | null; route: string | null; detected_at: string }>;
    };
    check("artifact_redaction filter -> 200 + 1 item", redactionOnly.statusCode === 200 && redactionBody.items.length === 1, redactionOnly.body);
    check(
      "artifact_redaction alert is critical, artifact-subject, run deep-link, operator Korean",
      redactionBody.items[0]?.alert_id === `artifact_redaction:${ART_FAILED}` &&
        redactionBody.items[0]?.severity === "critical" &&
        redactionBody.items[0]?.title === "증빙 보호 처리 실패" &&
        redactionBody.items[0]?.detail.includes("5회") &&
        redactionBody.items[0]?.subject_type === "artifact" &&
        redactionBody.items[0]?.subject_id === ART_FAILED &&
        redactionBody.items[0]?.route === `#runTrace?run=${RUN_A}`,
      redactionOnly.body,
    );
    check(
      "artifact_redaction alert leaks no object refs or content",
      !JSON.stringify(redactionBody.items[0]).includes("object://"),
      redactionOnly.body,
    );
    const redactionAck = await app.inject({
      method: "POST",
      url: `/v1/ops-alerts/${encodeURIComponent(`artifact_redaction:${ART_FAILED}`)}/ack`,
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": "ack-artifact-redaction" },
      payload: { comment: "재처리 요청함" },
    });
    check(
      "artifact_redaction ack by-id -> 200 acknowledged",
      redactionAck.statusCode === 200 && (redactionAck.json() as { status: string }).status === "acknowledged",
      redactionAck.body,
    );
    const redactionAfterAck = await app.inject({ method: "GET", url: "/v1/ops-alerts?source=artifact_redaction", headers: { authorization: `Bearer ${viewer}` } });
    check(
      "acked artifact_redaction alert hidden from open list",
      redactionAfterAck.statusCode === 200 && (redactionAfterAck.json() as { items: unknown[] }).items.length === 0,
      redactionAfterAck.body,
    );

    // R3-1 security_abort — 보안 예외 즉시 중단 알림(목록/필터/ack, v2.33).
    const secOnly = await app.inject({ method: "GET", url: "/v1/ops-alerts?source=security_abort", headers: { authorization: `Bearer ${viewer}` } });
    const secBody = secOnly.json() as {
      items: Array<{ alert_id: string; source: string; severity: string; title: string; detail: string; subject_type: string; subject_id: string | null; route: string | null; detected_at: string }>;
    };
    check("security_abort filter -> 200 + 1 item", secOnly.statusCode === 200 && secBody.items.length === 1, secOnly.body);
    check(
      "security_abort alert is critical, run-subject, run deep-link, catalog userMessage",
      secBody.items[0]?.alert_id === `security_abort:${RUN_SEC_ABORT}` &&
        secBody.items[0]?.severity === "critical" &&
        secBody.items[0]?.title === "보안 차단으로 자동화 중단" &&
        secBody.items[0]?.detail.includes("허용되지 않은 이동") &&
        secBody.items[0]?.subject_type === "run" &&
        secBody.items[0]?.subject_id === RUN_SEC_ABORT &&
        secBody.items[0]?.route === `#runTrace?run=${RUN_SEC_ABORT}`,
      secOnly.body,
    );
    const secAck = await app.inject({
      method: "POST",
      url: `/v1/ops-alerts/${encodeURIComponent(`security_abort:${RUN_SEC_ABORT}`)}/ack`,
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": "ack-security-abort" },
      payload: { comment: "보안 담당 확인" },
    });
    check(
      "security_abort ack by-id -> 200 acknowledged (DDL source CHECK 통과)",
      secAck.statusCode === 200 && (secAck.json() as { status: string }).status === "acknowledged",
      secAck.body,
    );
    const secAfterAck = await app.inject({ method: "GET", url: "/v1/ops-alerts?source=security_abort", headers: { authorization: `Bearer ${viewer}` } });
    check(
      "acked security_abort alert hidden from open list",
      secAfterAck.statusCode === 200 && (secAfterAck.json() as { items: unknown[] }).items.length === 0,
      secAfterAck.body,
    );
    // 음성 대조: 같은 cancelled 라도 failure_reason 이 없거나 비-security 면 알림이 계산되지 않아야 한다 —
    //   위 filter 가 정확히 1건(RUN_SEC_ABORT)임이 그 증명(다른 cancelled/failed 시드는 제외됨).

    const humanOnly = await app.inject({ method: "GET", url: "/v1/ops-alerts?source=human_task_sla&severity=warning", headers: { authorization: `Bearer ${viewer}` } });
    const humanBody = humanOnly.json() as { items: Array<{ source: string; severity: string; alert_id: string; route: string | null }> };
    check("source/severity filter -> 200", humanOnly.statusCode === 200, humanOnly.body);
    check("human warning filter returns only matching alerts", humanBody.items.length === 1 && humanBody.items[0].alert_id === `human_task_sla:${HT_WARNING}`, humanOnly.body);
    check("human warning route targets matching task", humanBody.items[0]?.route === `#humanTasks?ht=${HT_WARNING}`, humanOnly.body);

    const spikeOnly = await app.inject({ method: "GET", url: "/v1/ops-alerts?source=failure_spike&severity=warning", headers: { authorization: `Bearer ${viewer}` } });
    const spikeBody = spikeOnly.json() as { items: Array<{ source: string; severity: string; alert_id: string; subject_type: string; subject_id: string | null; route: string | null }> };
    check("failure spike filter -> 200", spikeOnly.statusCode === 200, spikeOnly.body);
    check("failure spike warning returns aggregate run alert", spikeBody.items.length === 1 && spikeBody.items[0]?.alert_id === "failure_spike:15m" && spikeBody.items[0]?.subject_type === "run" && spikeBody.items[0]?.subject_id === null, spikeOnly.body);
    check("failure spike route opens failed run trace", spikeBody.items[0]?.route === "#runTrace?status=failed_system", spikeOnly.body);

    const runSlaFirst = await app.inject({ method: "GET", url: "/v1/ops-alerts?source=run_sla&limit=2", headers: { authorization: `Bearer ${viewer}` } });
    const runSlaFirstBody = runSlaFirst.json() as { items: Array<{ alert_id: string }>; next_cursor: string | null };
    check("run SLA limited page keeps v1 cursor closed", runSlaFirst.statusCode === 200 && runSlaFirstBody.items.length === 2 && runSlaFirstBody.next_cursor === null, runSlaFirst.body);

    const invalidCursor = await app.inject({ method: "GET", url: "/v1/ops-alerts?cursor=not-a-cursor", headers: { authorization: `Bearer ${viewer}` } });
    check("cursor query remains unsupported -> 422", invalidCursor.statusCode === 422 && invalidCursor.json().code === "IR_SCHEMA_INVALID" && invalidCursor.json().details?.reason === "ops_alert_cursor_not_supported", invalidCursor.body);

    const invalid = await app.inject({ method: "GET", url: "/v1/ops-alerts?source=email", headers: { authorization: `Bearer ${viewer}` } });
    check("invalid source -> 422", invalid.statusCode === 422 && invalid.json().code === "IR_SCHEMA_INVALID", invalid.body);

    const viewerAckDenied = await app.inject({
      method: "POST",
      url: `/v1/ops-alerts/${encodeURIComponent("bot_pool:browser-default")}/ack`,
      headers: { authorization: `Bearer ${viewer}`, "idempotency-key": "ack-viewer-denied" },
      payload: { comment: "viewer should not ack" },
    });
    check("viewer ops alert ack denied -> 403", viewerAckDenied.statusCode === 403 && viewerAckDenied.json().code === "AUTHZ_FORBIDDEN", viewerAckDenied.body);

    const missingKeyAck = await app.inject({
      method: "POST",
      url: `/v1/ops-alerts/${encodeURIComponent("bot_pool:browser-default")}/ack`,
      headers: { authorization: `Bearer ${operator}` },
      payload: { comment: "missing idempotency key" },
    });
    check("ops alert ack without idempotency key -> 422", missingKeyAck.statusCode === 422 && missingKeyAck.json().code === "IR_SCHEMA_INVALID", missingKeyAck.body);

    const deliveryViewerDenied = await app.inject({
      method: "POST",
      url: `/v1/ops-alerts/${encodeURIComponent("bot_pool:browser-default")}/deliveries`,
      headers: { authorization: `Bearer ${viewer}`, "idempotency-key": "delivery-viewer-denied" },
      payload: {
        channel: "teams",
        provider_alias: "teams-primary",
        status: "delivered",
        receipt_id: "teams-receipt-viewer",
        receipt_at: isoMinutesFromNow(-3),
        endpoint_secret_ref: "secret://tenant-a/notification/teams/primary",
        summary: "Viewer should not record delivery receipts.",
      },
    });
    check("viewer cannot record ops alert delivery receipt -> 403", deliveryViewerDenied.statusCode === 403 && deliveryViewerDenied.json().code === "AUTHZ_FORBIDDEN", deliveryViewerDenied.body);

    const deliveryOperatorDenied = await app.inject({
      method: "POST",
      url: `/v1/ops-alerts/${encodeURIComponent("bot_pool:browser-default")}/deliveries`,
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": "delivery-operator-denied" },
      payload: {
        channel: "teams",
        provider_alias: "teams-primary",
        status: "delivered",
        receipt_id: "teams-receipt-operator",
        receipt_at: isoMinutesFromNow(-3),
        endpoint_secret_ref: "secret://tenant-a/notification/teams/primary",
        summary: "Operator acknowledgement does not grant external delivery write.",
      },
    });
    check("operator cannot record ops alert delivery receipt -> 403", deliveryOperatorDenied.statusCode === 403 && deliveryOperatorDenied.json().code === "AUTHZ_FORBIDDEN", deliveryOperatorDenied.body);

    const failedReceiptAt = isoMinutesFromNow(-4);
    const deliveredReceiptAt = isoMinutesFromNow(-2);
    const failedDelivery = await app.inject({
      method: "POST",
      url: `/v1/ops-alerts/${encodeURIComponent("bot_pool:browser-default")}/deliveries`,
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "delivery-bot-pool-failed-1" },
      payload: {
        channel: "teams",
        provider_alias: "teams-primary",
        status: "failed",
        receipt_at: failedReceiptAt,
        endpoint_secret_ref: "secret://tenant-a/notification/teams/primary",
        credential_secret_ref: "secret://tenant-a/notification/teams/credential",
        route_policy_ref: "ops-alerts-primary",
        recipient_group_ref: "ops-primary-oncall",
        attempt_no: 1,
        summary: "Provider returned a temporary error for the drill alert.",
        error_code: "PROVIDER_5XX",
        metadata: { provider_region: "ap-northeast-2" },
      },
    });
    const failedDeliveryBody = failedDelivery.json() as { delivery_id: string; status: string; receipt_id: string | null; error_code: string | null; endpoint_secret_ref: string; recipient_group_ref: string | null };
    check("admin records failed external delivery receipt",
      failedDelivery.statusCode === 201 &&
        failedDeliveryBody.status === "failed" &&
        failedDeliveryBody.receipt_id === null &&
        failedDeliveryBody.error_code === "PROVIDER_5XX" &&
        failedDeliveryBody.recipient_group_ref === "ops-primary-oncall" &&
        failedDeliveryBody.endpoint_secret_ref === "secret://tenant-a/notification/teams/primary",
      failedDelivery.body);

    const deliveredDelivery = await app.inject({
      method: "POST",
      url: `/v1/ops-alerts/${encodeURIComponent("bot_pool:browser-default")}/deliveries`,
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "delivery-bot-pool-delivered-1" },
      payload: {
        channel: "teams",
        provider_alias: "teams-primary",
        status: "delivered",
        receipt_id: "teams-receipt-1",
        receipt_at: deliveredReceiptAt,
        endpoint_secret_ref: "secret://tenant-a/notification/teams/primary",
        credential_secret_ref: "secret://tenant-a/notification/teams/credential",
        route_policy_ref: "ops-alerts-primary",
        recipient_group_ref: "ops-primary-oncall",
        attempt_no: 2,
        summary: "Provider accepted and delivered the drill alert.",
        metadata: { provider_region: "ap-northeast-2" },
      },
    });
    const deliveredDeliveryBody = deliveredDelivery.json() as { delivery_id: string; status: string; receipt_id: string | null; recipient_group_ref: string | null; attempt_no: number; metadata: { provider_region?: string } };
    check("admin records delivered external delivery receipt",
      deliveredDelivery.statusCode === 201 &&
        deliveredDeliveryBody.status === "delivered" &&
        deliveredDeliveryBody.receipt_id === "teams-receipt-1" &&
        deliveredDeliveryBody.recipient_group_ref === "ops-primary-oncall" &&
        deliveredDeliveryBody.attempt_no === 2 &&
        deliveredDeliveryBody.metadata.provider_region === "ap-northeast-2",
      deliveredDelivery.body);

    const deliveredDeliveryReplay = await app.inject({
      method: "POST",
      url: `/v1/ops-alerts/${encodeURIComponent("bot_pool:browser-default")}/deliveries`,
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "delivery-bot-pool-delivered-1" },
      payload: {
        channel: "teams",
        provider_alias: "teams-primary",
        status: "delivered",
        receipt_id: "teams-receipt-1",
        receipt_at: deliveredReceiptAt,
        endpoint_secret_ref: "secret://tenant-a/notification/teams/primary",
        credential_secret_ref: "secret://tenant-a/notification/teams/credential",
        route_policy_ref: "ops-alerts-primary",
        recipient_group_ref: "ops-primary-oncall",
        attempt_no: 2,
        summary: "Provider accepted and delivered the drill alert.",
        metadata: { provider_region: "ap-northeast-2" },
      },
    });
    check("ops alert delivery idempotency replays recorded receipt",
      deliveredDeliveryReplay.statusCode === 201 &&
        (deliveredDeliveryReplay.json() as { delivery_id: string }).delivery_id === deliveredDeliveryBody.delivery_id,
      deliveredDeliveryReplay.body);

    const queuedWebhook = await app.inject({
      method: "POST",
      url: `/v1/ops-alerts/${encodeURIComponent("bot_pool:browser-default")}/deliveries/send-webhook`,
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "delivery-webhook-send-1" },
      payload: {
        provider_alias: "webhook-primary",
        endpoint_secret_ref: "secret://rpa/test/notification-sender/notification/webhook/ops-primary",
        callback_signature_secret_ref: OPS_CALLBACK_SIGNATURE_SECRET_REF,
        route_policy_ref: "ops-alerts-webhook-primary",
        recipient_group_ref: "ops-primary-oncall",
        allowed_hosts: ["hooks.example.com"],
        summary: "Queue webhook delivery for the drill alert.",
        metadata: { provider_region: "ap-northeast-2" },
      },
    });
    const queuedWebhookBody = queuedWebhook.json() as {
      attempt_id: string;
      status: string;
      channel: string;
      allowed_hosts: string[];
      recipient_group_ref: string | null;
      endpoint_secret_ref: string;
      receipt_id: string | null;
      callback_signature_secret_ref: string | null;
    };
    check("admin queues SecretRef-backed webhook notification attempt",
      queuedWebhook.statusCode === 202 &&
        queuedWebhookBody.status === "pending" &&
        queuedWebhookBody.channel === "webhook" &&
        queuedWebhookBody.allowed_hosts[0] === "hooks.example.com" &&
        queuedWebhookBody.recipient_group_ref === "ops-primary-oncall" &&
        queuedWebhookBody.endpoint_secret_ref === "secret://rpa/test/notification-sender/notification/webhook/ops-primary" &&
        queuedWebhookBody.callback_signature_secret_ref === OPS_CALLBACK_SIGNATURE_SECRET_REF &&
        queuedWebhookBody.receipt_id === null &&
        enqueuedNotifications.length === 1 &&
        enqueuedNotifications[0]?.attemptId === queuedWebhookBody.attempt_id,
      queuedWebhook.body);

    const queuedWebhookReplay = await app.inject({
      method: "POST",
      url: `/v1/ops-alerts/${encodeURIComponent("bot_pool:browser-default")}/deliveries/send-webhook`,
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "delivery-webhook-send-1" },
      payload: {
        provider_alias: "webhook-primary",
        endpoint_secret_ref: "secret://rpa/test/notification-sender/notification/webhook/ops-primary",
        callback_signature_secret_ref: OPS_CALLBACK_SIGNATURE_SECRET_REF,
        route_policy_ref: "ops-alerts-webhook-primary",
        recipient_group_ref: "ops-primary-oncall",
        allowed_hosts: ["hooks.example.com"],
        summary: "Queue webhook delivery for the drill alert.",
        metadata: { provider_region: "ap-northeast-2" },
      },
    });
    check("webhook notification enqueue idempotency replays without duplicate job",
      queuedWebhookReplay.statusCode === 202 &&
        (queuedWebhookReplay.json() as { attempt_id: string }).attempt_id === queuedWebhookBody.attempt_id &&
        enqueuedNotifications.length === 1,
      queuedWebhookReplay.body);

    await withTenantTx(pool, TENANT_A, async (client) => {
      await client.query(
        `UPDATE ops_notification_attempts
            SET status='sent',
                receipt_id='webhook-sent-receipt-1',
                receipt_at=now(),
                completed_at=now()
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [TENANT_A, queuedWebhookBody.attempt_id],
      );
    });
    const callbackBody = {
      receipt_id: "webhook-delivered-receipt-1",
      status: "delivered",
      metadata: { provider_region: "ap-northeast-2" },
    };
    const signedCallback = await app.inject({
      method: "POST",
      url: `/v1/webhooks/ops-alerts/${TENANT_A}/${queuedWebhookBody.attempt_id}`,
      headers: signedOpsNotificationCallbackHeaders("webhook-delivered-receipt-1", callbackBody),
      payload: callbackBody,
    });
    const signedCallbackBody = signedCallback.json() as {
      status: string;
      receipt_id: string | null;
      recorded_by: string;
      callback_signature_secret_ref: string | null;
      metadata: { notification_attempt_id?: string; callback_received?: boolean; provider_region?: string };
    };
    check("signed provider webhook callback records delivered receipt without JWT",
      signedCallback.statusCode === 202 &&
        signedCallbackBody.status === "delivered" &&
        signedCallbackBody.receipt_id === "webhook-delivered-receipt-1" &&
        signedCallbackBody.recorded_by === "provider-callback" &&
        signedCallbackBody.callback_signature_secret_ref === OPS_CALLBACK_SIGNATURE_SECRET_REF &&
        signedCallbackBody.metadata.notification_attempt_id === queuedWebhookBody.attempt_id &&
        signedCallbackBody.metadata.callback_received === true &&
        signedCallbackBody.metadata.provider_region === "ap-northeast-2",
      signedCallback.body);
    check(
      "ops notification callback resolves signing SecretRef through notification boundary",
      opsCallbackBoundaryCalls.some((call) =>
        call.ref === OPS_CALLBACK_SIGNATURE_SECRET_REF &&
        call.purpose === "notification" &&
        call.tenantId === TENANT_A &&
        call.connectorId === "ops-alerts-webhook-primary",
      ),
      JSON.stringify(opsCallbackBoundaryCalls),
    );

    const callbackReplay = await app.inject({
      method: "POST",
      url: `/v1/webhooks/ops-alerts/${TENANT_A}/${queuedWebhookBody.attempt_id}`,
      headers: signedOpsNotificationCallbackHeaders("webhook-delivered-receipt-1", callbackBody),
      payload: callbackBody,
    });
    check("same provider callback receipt replays without duplicate delivery row",
      callbackReplay.statusCode === 202 &&
        (callbackReplay.json() as { receipt_id: string }).receipt_id === "webhook-delivered-receipt-1" &&
        (await deliveryReceiptCount(pool, TENANT_A, "bot_pool:browser-default")) === 3,
      callbackReplay.body);

    const nextGenerationAttemptId = randomUUID();
    await withTenantTx(pool, TENANT_A, async (client) => {
      await client.query(
        `INSERT INTO ops_notification_attempts (
           id, tenant_id, alert_id, detected_at, source, subject_type, subject_id,
           channel, provider_alias, status, endpoint_secret_ref, credential_secret_ref,
           callback_signature_secret_ref, route_policy_ref, recipient_group_ref, allowed_hosts,
           attempt_no, max_attempts, next_attempt_at, payload, summary, error_code,
           receipt_id, receipt_at, metadata, requested_by, requested_at, started_at,
           completed_at, lease_token, retention_until, legal_hold
         )
         SELECT $3::uuid, tenant_id, alert_id, detected_at + interval '1 minute', source, subject_type, subject_id,
                channel, provider_alias, 'sent', endpoint_secret_ref, credential_secret_ref,
                callback_signature_secret_ref, route_policy_ref, recipient_group_ref, allowed_hosts,
                attempt_no + 1, max_attempts, now(), payload, summary, NULL,
                'webhook-sent-receipt-generation-2', now(), metadata, requested_by, requested_at, now(),
                now(), NULL, retention_until, legal_hold
           FROM ops_notification_attempts
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [TENANT_A, queuedWebhookBody.attempt_id, nextGenerationAttemptId],
      );
    });
    const nextGenerationCallback = await app.inject({
      method: "POST",
      url: `/v1/webhooks/ops-alerts/${TENANT_A}/${nextGenerationAttemptId}`,
      headers: signedOpsNotificationCallbackHeaders("webhook-delivered-receipt-1", callbackBody),
      payload: callbackBody,
    });
    const nextGenerationCallbackBody = nextGenerationCallback.json() as {
      receipt_id: string | null;
      metadata: { notification_attempt_id?: string };
    };
    check("same provider receipt id is scoped to alert generation",
      nextGenerationCallback.statusCode === 202 &&
        nextGenerationCallbackBody.receipt_id === "webhook-delivered-receipt-1" &&
        nextGenerationCallbackBody.metadata.notification_attempt_id === nextGenerationAttemptId &&
        (await deliveryReceiptCount(pool, TENANT_A, "bot_pool:browser-default")) === 4,
      nextGenerationCallback.body);

    const mismatchCallbackBody = { ...callbackBody, status: "failed", error_code: "PROVIDER_DELIVERY_FAILED" };
    const mismatchCallback = await app.inject({
      method: "POST",
      url: `/v1/webhooks/ops-alerts/${TENANT_A}/${queuedWebhookBody.attempt_id}`,
      headers: signedOpsNotificationCallbackHeaders("webhook-delivered-receipt-1", mismatchCallbackBody),
      payload: mismatchCallbackBody,
    });
    check("same provider callback receipt with mismatched status is rejected",
      mismatchCallback.statusCode === 412 &&
        mismatchCallback.json().code === "SCENARIO_VERSION_CONFLICT",
      mismatchCallback.body);

    const badCallbackSignature = await app.inject({
      method: "POST",
      url: `/v1/webhooks/ops-alerts/${TENANT_A}/${queuedWebhookBody.attempt_id}`,
      headers: {
        ...signedOpsNotificationCallbackHeaders("webhook-bad-signature", { ...callbackBody, receipt_id: "webhook-bad-signature" }),
        "x-rpa-ops-notification-signature": "sha256=0000000000000000000000000000000000000000000000000000000000000000",
      },
      payload: { ...callbackBody, receipt_id: "webhook-bad-signature" },
    });
    check("bad provider webhook callback signature rejected -> 401",
      badCallbackSignature.statusCode === 401 && badCallbackSignature.json().code === "UNAUTHENTICATED",
      badCallbackSignature.body);

    const rawAllowedHost = await app.inject({
      method: "POST",
      url: `/v1/ops-alerts/${encodeURIComponent("bot_pool:browser-default")}/deliveries/send-webhook`,
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "delivery-webhook-raw-host-rejected" },
      payload: {
        endpoint_secret_ref: "secret://rpa/test/notification-sender/notification/webhook/ops-primary",
        route_policy_ref: "ops-alerts-webhook-primary",
        allowed_hosts: ["https://hooks.example.com/services/T000"],
      },
    });
    check("webhook notification allowed_hosts rejects raw endpoint URL",
      rawAllowedHost.statusCode === 422 && rawAllowedHost.json().code === "IR_SCHEMA_INVALID",
      rawAllowedHost.body);

    const deliveryList = await app.inject({
      method: "GET",
      url: `/v1/ops-alerts/${encodeURIComponent("bot_pool:browser-default")}/deliveries?limit=10`,
      headers: { authorization: `Bearer ${viewer}` },
    });
    const deliveryListBody = deliveryList.json() as { items: Array<{ status: string; receipt_id: string | null; error_code: string | null; recipient_group_ref: string | null }>; next_cursor: string | null };
    check("viewer lists metadata-only ops alert delivery receipts",
      deliveryList.statusCode === 200 &&
        deliveryListBody.items.length === 4 &&
        deliveryListBody.items[0]?.status === "delivered" &&
        deliveryListBody.items[0]?.recipient_group_ref === "ops-primary-oncall" &&
        deliveryListBody.items.some((item) => item.status === "delivered" && item.receipt_id === "webhook-delivered-receipt-1") &&
        deliveryListBody.items.some((item) => item.status === "failed" && item.error_code === "PROVIDER_5XX") &&
        deliveryListBody.next_cursor === null,
      deliveryList.body);

    const secretBearingDelivery = await app.inject({
      method: "POST",
      url: `/v1/ops-alerts/${encodeURIComponent("bot_pool:browser-default")}/deliveries`,
      headers: { authorization: `Bearer ${admin}`, "idempotency-key": "delivery-secret-rejected" },
      payload: {
        channel: "slack",
        provider_alias: "slack-primary",
        status: "delivered",
        receipt_id: "slack-receipt-1",
        receipt_at: isoMinutesFromNow(-1),
        endpoint_secret_ref: "secret://tenant-a/notification/slack/primary",
        summary: "Provider accepted receipt.",
        metadata: { endpoint_url: "https://hooks.slack.com/services/T000/B000/secret" },
      },
    });
    check("ops alert delivery metadata rejects raw endpoint material",
      secretBearingDelivery.statusCode === 422 && secretBearingDelivery.json().code === "IR_SCHEMA_INVALID",
      secretBearingDelivery.body);

    const ack = await app.inject({
      method: "POST",
      url: `/v1/ops-alerts/${encodeURIComponent("bot_pool:browser-default")}/ack`,
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": "ack-bot-pool" },
      payload: { comment: "checking worker lease expiry" },
    });
    const ackBody = ack.json() as { alert_id: string; status: string; source: string; ack: { acknowledged_by: string; acknowledged_at: string; comment: string | null } };
    check("operator bot pool ack -> 200 acknowledged", ack.statusCode === 200 && ackBody.alert_id === "bot_pool:browser-default" && ackBody.status === "acknowledged" && ackBody.source === "bot_pool" && ackBody.ack.acknowledged_by === "operator-a" && ackBody.ack.comment === "checking worker lease expiry", ack.body);

    const ackReplay = await app.inject({
      method: "POST",
      url: `/v1/ops-alerts/${encodeURIComponent("bot_pool:browser-default")}/ack`,
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": "ack-bot-pool" },
      payload: { comment: "checking worker lease expiry" },
    });
    const ackReplayBody = ackReplay.json() as { alert_id: string; status: string; ack: { acknowledged_by: string; acknowledged_at: string; comment: string | null } };
    check(
      "ops alert ack idempotency replay returns same acknowledged generation",
      ackReplay.statusCode === 200 &&
        ackReplayBody.alert_id === ackBody.alert_id &&
        ackReplayBody.status === "acknowledged" &&
        ackReplayBody.ack.acknowledged_by === ackBody.ack.acknowledged_by &&
        ackReplayBody.ack.acknowledged_at === ackBody.ack.acknowledged_at &&
        ackReplayBody.ack.comment === ackBody.ack.comment,
      ackReplay.body,
    );

    const botPoolOpen = await app.inject({ method: "GET", url: "/v1/ops-alerts?source=bot_pool", headers: { authorization: `Bearer ${viewer}` } });
    check("acknowledged bot pool alert hidden from default open list", botPoolOpen.statusCode === 200 && botPoolOpen.json().items.length === 0, botPoolOpen.body);
    const botPoolAcked = await app.inject({ method: "GET", url: "/v1/ops-alerts?source=bot_pool&status=acknowledged", headers: { authorization: `Bearer ${viewer}` } });
    check("acknowledged bot pool alert visible by status filter", botPoolAcked.statusCode === 200 && botPoolAcked.json().items.length === 1 && botPoolAcked.json().items[0]?.status === "acknowledged", botPoolAcked.body);

    const unknownAck = await app.inject({
      method: "POST",
      url: "/v1/ops-alerts/bot_pool%3Amissing/ack",
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": "ack-missing" },
      payload: {},
    });
    check("ack for non-current alert -> 404", unknownAck.statusCode === 404 && unknownAck.json().code === "RESOURCE_NOT_FOUND", unknownAck.body);

    const tenantB = await app.inject({ method: "GET", url: "/v1/ops-alerts", headers: { authorization: `Bearer ${viewerB}` } });
    check("tenant B sees no tenant A alerts", tenantB.statusCode === 200 && tenantB.json().items.length === 0, tenantB.body);

    const denied = await app.inject({ method: "GET", url: "/v1/ops-alerts", headers: { authorization: `Bearer ${noRole}` } });
    check("no-role ops alert read denied -> 403", denied.statusCode === 403 && denied.json().code === "AUTHZ_FORBIDDEN", denied.body);
  } finally {
    await app.close();
    await pool.end();
  }
  if (failures > 0) {
    console.error(`FAIL: ${failures} ops alert API check(s) failed`);
    process.exit(1);
  }
  console.log("PASS: ops alert API integration green");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
