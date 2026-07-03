import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import type { SecretRef } from "../../../ts/core-types";
import type { AuthenticatedPrincipal, PrincipalId, TenantId } from "../../../ts/security-middleware-contract";
import {
  OPS_NOTIFICATION_DELIVERY_MAX_ATTEMPTS_DEFAULT,
} from "../../../ts/runtime-contract";
import { withTenantTx } from "../db/pool";
import { workerStaleThresholdSeconds } from "../worker/worker-heartbeat-policy";
import { readBrowserBotPool, type BotPoolItem } from "./bot-pools";
import { runIdempotentCommand, isRecord } from "./command";
import { ApiResponseError } from "./errors";
import { parseLimit } from "./list-query";
import { readArtifactRedactionAlerts, readArtifactRedactionAlertById } from "./ops-alerts-artifact-redaction";
import {
  SCIM_SECRET_ROTATION_DUE_SOON_DAYS,
  scimSecretRotationDueAt,
  scimSecretRotationStatus,
  type ScimSecretRotationPolicy,
} from "./scim";
import { requirePrincipal, type ApiServerDeps } from "./server";
import { UUID_RE } from "./server-shared";
import { verifyWebhookSignature, webhookSigningPayload } from "./webhook-trigger-auth";

export type OpsAlertSeverity = "critical" | "warning" | "info";
export type OpsAlertSource =
  | "run_sla"
  | "human_task_sla"
  | "trigger_fire"
  | "failure_spike"
  | "dlq"
  | "bot_pool"
  | "scim_secret_rotation"
  | "audit_verifier"
  | "readiness_evidence"
  | "session_expiry"
  | "artifact_redaction";
type OpsAlertSubjectType =
  | "run"
  | "human_task"
  | "run_trigger"
  | "dlq"
  | "bot_pool"
  | "scim_provider"
  | "audit_verifier"
  | "readiness_evidence"
  | "browser_session"
  | "artifact";
type OpsAlertStatus = "open" | "acknowledged";
type OpsAlertListStatus = OpsAlertStatus | "all";
type ProductionReadinessEvidenceAlertType =
  | "external_alert_delivery"
  | "managed_backup_restore_drill"
  | "slo_oncall_signoff"
  | "support_training_completion"
  | "observability_telemetry_wiring";
type ProductionReadinessEvidenceAlertStatus = "valid" | "failed";
export type OpsNotificationChannel = "teams" | "slack" | "email" | "webhook";
export type OpsNotificationDeliveryStatus = "sent" | "delivered" | "failed";

interface OpsAlertDelivery {
  readonly channel: "console";
  readonly status: "delivered";
  readonly delivered_at: string;
  readonly external_delivery: false;
}

interface OpsAlertAck {
  readonly acknowledged_by: string;
  readonly acknowledged_at: string;
  readonly comment: string | null;
}

interface OpsAlertItem {
  readonly alert_id: string;
  readonly severity: OpsAlertSeverity;
  readonly source: OpsAlertSource;
  readonly title: string;
  readonly detail: string;
  readonly subject_type: OpsAlertSubjectType;
  readonly subject_id: string | null;
  readonly status: OpsAlertStatus;
  readonly delivery: OpsAlertDelivery;
  readonly ack: OpsAlertAck | null;
  readonly recommended_action: string;
  readonly route: string | null;
  readonly detected_at: string;
  readonly due_at?: string | null;
}

export type ComputedOpsAlert = Omit<OpsAlertItem, "status" | "delivery" | "ack">;

export interface OpsNotificationDelivery {
  readonly delivery_id: string;
  readonly alert_id: string;
  readonly detected_at: string;
  readonly source: OpsAlertSource;
  readonly subject_type: OpsAlertSubjectType;
  readonly subject_id: string | null;
  readonly channel: OpsNotificationChannel;
  readonly provider_alias: string;
  readonly status: OpsNotificationDeliveryStatus;
  readonly receipt_id: string | null;
  readonly receipt_at: string;
  readonly endpoint_secret_ref: string;
  readonly credential_secret_ref: string | null;
  readonly callback_signature_secret_ref: string | null;
  readonly route_policy_ref: string | null;
  readonly recipient_group_ref: string | null;
  readonly attempt_no: number;
  readonly summary: string;
  readonly error_code: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly recorded_by: string;
  readonly recorded_at: string;
  readonly legal_hold: boolean;
}

interface OpsNotificationDeliveryRow {
  readonly id: string;
  readonly alert_id: string;
  readonly detected_at: Date;
  readonly source: OpsAlertSource;
  readonly subject_type: OpsAlertSubjectType;
  readonly subject_id: string | null;
  readonly channel: OpsNotificationChannel;
  readonly provider_alias: string;
  readonly status: OpsNotificationDeliveryStatus;
  readonly receipt_id: string | null;
  readonly receipt_at: Date;
  readonly endpoint_secret_ref: string;
  readonly credential_secret_ref: string | null;
  readonly callback_signature_secret_ref: string | null;
  readonly route_policy_ref: string | null;
  readonly recipient_group_ref: string | null;
  readonly attempt_no: number;
  readonly summary: string;
  readonly error_code: string | null;
  readonly metadata: unknown;
  readonly recorded_by: string;
  readonly recorded_at: Date;
  readonly legal_hold: boolean;
}

interface OpsNotificationDeliveryInput {
  readonly channel: OpsNotificationChannel;
  readonly providerAlias: string;
  readonly status: OpsNotificationDeliveryStatus;
  readonly receiptId: string | null;
  readonly receiptAt: Date;
  readonly endpointSecretRef: string;
  readonly credentialSecretRef: string | null;
  readonly callbackSignatureSecretRef: string | null;
  readonly routePolicyRef: string | null;
  readonly recipientGroupRef: string | null;
  readonly attemptNo: number;
  readonly summary: string;
  readonly errorCode: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly legalHold: boolean;
}

export interface OpsNotificationAttempt {
  readonly attempt_id: string;
  readonly alert_id: string;
  readonly detected_at: string;
  readonly source: OpsAlertSource;
  readonly subject_type: OpsAlertSubjectType;
  readonly subject_id: string | null;
  readonly channel: "webhook";
  readonly provider_alias: string;
  readonly status: "pending" | "sending" | "sent" | "failed" | "dead_letter";
  readonly endpoint_secret_ref: string;
  readonly callback_signature_secret_ref: string | null;
  readonly route_policy_ref: string;
  readonly recipient_group_ref: string | null;
  readonly allowed_hosts: readonly string[];
  readonly attempt_no: number;
  readonly max_attempts: number;
  readonly next_attempt_at: string;
  readonly summary: string;
  readonly error_code: string | null;
  readonly receipt_id: string | null;
  readonly receipt_at: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly requested_by: string;
  readonly requested_at: string;
  readonly legal_hold: boolean;
}

interface OpsNotificationAttemptRow {
  readonly id: string;
  readonly alert_id: string;
  readonly detected_at: Date;
  readonly source: OpsAlertSource;
  readonly subject_type: OpsAlertSubjectType;
  readonly subject_id: string | null;
  readonly channel: "webhook";
  readonly provider_alias: string;
  readonly status: "pending" | "sending" | "sent" | "failed" | "dead_letter";
  readonly endpoint_secret_ref: string;
  readonly callback_signature_secret_ref: string | null;
  readonly route_policy_ref: string;
  readonly recipient_group_ref: string | null;
  readonly allowed_hosts: readonly string[];
  readonly attempt_no: number;
  readonly max_attempts: number;
  readonly next_attempt_at: Date;
  readonly summary: string;
  readonly error_code: string | null;
  readonly receipt_id: string | null;
  readonly receipt_at: Date | null;
  readonly metadata: unknown;
  readonly requested_by: string;
  readonly requested_at: Date;
  readonly legal_hold: boolean;
}

export interface OpsNotificationWebhookSendInput {
  readonly providerAlias: string;
  readonly endpointSecretRef: string;
  readonly callbackSignatureSecretRef: string | null;
  readonly routePolicyRef: string;
  readonly recipientGroupRef: string | null;
  readonly allowedHosts: readonly string[];
  readonly summary: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly legalHold: boolean;
}

interface OpsNotificationCallbackInput {
  readonly status: "delivered" | "failed";
  readonly receiptId: string;
  readonly errorCode: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly legalHold: boolean;
}

interface OpsNotificationCallbackHeaders {
  readonly eventId: string;
  readonly timestamp: string;
  readonly signature: string;
}

interface RunSlaRow {
  id: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  age_minutes: number;
}

interface HumanTaskSlaRow {
  id: string;
  run_id: string;
  kind: string;
  state: string;
  assignee: string | null;
  expires_at: Date;
  due_minutes: number;
}

interface TriggerFireRow {
  id: string;
  trigger_id: string;
  status: "failed" | "skipped";
  scheduled_for: Date;
  failure_reason: unknown;
  created_at: Date;
}

interface FailureSpikeRow {
  failure_count: string;
  latest_at: Date | null;
}

interface DlqCountRow {
  workitem_count: string;
  sink_count: string;
  latest_at: Date | null;
}

interface BotPoolDetectedAtRow {
  detected_at: Date;
}

interface ScimSecretRotationAlertRow {
  provider_key: string;
  display_name: string;
  secret_rotation_policy: ScimSecretRotationPolicy;
  created_at: Date;
  last_secret_rotated_at: Date | null;
  decommissioned_at: Date | null;
}

interface AuditVerifierLatestRunRow {
  id: string;
  status: "valid" | "invalid" | "failed";
  rows_checked: string;
  violation_count: number;
  completed_at: Date;
}

interface AuditVerifierFreshnessRow {
  audit_count: string;
  latest_audit_at: Date | null;
  latest_run_id: string | null;
  latest_status: "valid" | "invalid" | "failed" | null;
  latest_completed_at: Date | null;
  stale: boolean;
}

interface ProductionReadinessEvidenceAlertRow {
  evidence_type: ProductionReadinessEvidenceAlertType;
  status: ProductionReadinessEvidenceAlertStatus;
  evidence_at: Date;
  expires_at: Date | null;
  recorded_at: Date;
}

interface BrowserSessionExpiryRow {
  site_profile_id: string;
  site_name: string;
  url_pattern: string;
  browser_identity_id: string;
  identity_hash: string;
  expires_at: Date;
  due_minutes: number;
}

interface OpsAlertAckRow {
  alert_id: string;
  detected_at: Date;
  acknowledged_by: string;
  acknowledged_at: Date;
  comment: string | null;
}

const SEVERITY_SET: Record<OpsAlertSeverity, true> = {
  critical: true,
  warning: true,
  info: true,
};

const SOURCE_SET: Record<OpsAlertSource, true> = {
  run_sla: true,
  human_task_sla: true,
  trigger_fire: true,
  failure_spike: true,
  dlq: true,
  bot_pool: true,
  scim_secret_rotation: true,
  audit_verifier: true,
  readiness_evidence: true,
  session_expiry: true,
  artifact_redaction: true,
};

const STATUS_SET: Record<OpsAlertListStatus, true> = {
  open: true,
  acknowledged: true,
  all: true,
};

const SEVERITY_RANK: Record<OpsAlertSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

const AUDIT_VERIFIER_STALE_AFTER_MS = 75 * 60 * 1000;
const READINESS_EVIDENCE_DUE_SOON_DAYS = 14;
const SESSION_EXPIRY_DUE_SOON_HOURS = 24;
const OPS_NOTIFICATION_DELIVERY_RETENTION_DAYS = 365;
const OPS_NOTIFICATION_CALLBACK_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;
const OPS_NOTIFICATION_CALLBACK_EVENT_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

export function registerOpsAlertRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/ops-alerts", { config: { rbacAction: "ops_alert.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    assertNoCursor(query.cursor);
    const limit = parseLimit(query.limit);
    const sourceQueryLimit = limit;
    const severity = severityFilter(query.severity);
    const source = sourceFilter(query.source);
    const status = statusFilter(query.status);

    const alerts = await withTenantTx(deps.pool, principal.tenantId, async (client) =>
      readOpsAlerts(client, principal.tenantId, source, sourceQueryLimit),
    );

    const filtered = alerts
      .filter((alert) => severity === undefined || alert.severity === severity)
      .filter((alert) => status === "all" || alert.status === status)
      .sort(compareAlerts);
    const page = filtered.slice(0, limit);

    reply.code(200).send({ items: page, next_cursor: null });
  });

  app.post("/v1/ops-alerts/:alert_id/ack", { config: { rbacAction: "ops_alert.ack" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const alertId = parseAlertId((request.params as Record<string, unknown>).alert_id);
    const body = parseAckRequest(request.body);
    const response = await runIdempotentCommand(
      deps,
      request,
      "ackOpsAlert",
      `/v1/ops-alerts/${alertId}/ack`,
      async (client, tenantId) => {
        const alert = await readComputedOpsAlertById(client, tenantId, alertId);
        if (alert === null) {
          throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "ops_alert_not_current", alert_id: alertId });
        }
        const item = await acknowledgeAlert(client, tenantId, alert, principal.subjectId, body.comment);
        return { status: 200, body: item };
      },
    );
    reply.code(response.status).send(response.body);
  });

  app.get("/v1/ops-alerts/:alert_id/deliveries", { config: { rbacAction: "ops_alert.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const alertId = parseAlertId((request.params as Record<string, unknown>).alert_id);
    const query = request.query as Record<string, unknown>;
    assertNoCursor(query.cursor);
    const limit = parseLimit(query.limit);
    const items = await withTenantTx(deps.pool, principal.tenantId, (client) =>
      readOpsNotificationDeliveries(client, principal.tenantId, alertId, limit),
    );
    reply.code(200).send({ items, next_cursor: null });
  });

  app.post("/v1/ops-alerts/:alert_id/deliveries", { config: { rbacAction: "ops_alert.deliver" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const alertId = parseAlertId((request.params as Record<string, unknown>).alert_id);
    const body = parseNotificationDeliveryRequest(request.body);
    const response = await runIdempotentCommand(
      deps,
      request,
      "recordOpsAlertDelivery",
      `/v1/ops-alerts/${alertId}/deliveries`,
      async (client, tenantId) => {
        const alert = await readComputedOpsAlertById(client, tenantId, alertId);
        if (alert === null) {
          throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "ops_alert_not_current", alert_id: alertId });
        }
        const item = await insertOpsNotificationDelivery(client, tenantId, alert, principal.subjectId, body);
        return { status: 201, body: item };
      },
    );
    reply.code(response.status).send(response.body);
  });

  app.post(
    "/v1/ops-alerts/:alert_id/deliveries/send-webhook",
    { config: { rbacAction: "ops_alert.deliver" } },
    async (request, reply) => {
      if (deps.enqueuer.enqueueOpsNotificationSend === undefined) {
        throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "ops_notification_enqueuer_not_configured" });
      }
      const principal = requirePrincipal(request);
      const alertId = parseAlertId((request.params as Record<string, unknown>).alert_id);
      const body = parseNotificationWebhookSendRequest(request.body);
      const enqueueOpsNotificationSend = deps.enqueuer.enqueueOpsNotificationSend.bind(deps.enqueuer);
      const response = await runIdempotentCommand(
        deps,
        request,
        "sendOpsAlertWebhookDelivery",
        `/v1/ops-alerts/${alertId}/deliveries/send-webhook`,
        async (client, tenantId) => {
          const alert = await readComputedOpsAlertById(client, tenantId, alertId);
          if (alert === null) {
            throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "ops_alert_not_current", alert_id: alertId });
          }
          const attempt = await insertOpsNotificationAttempt(client, tenantId, alert, principal.subjectId, body);
          await enqueueOpsNotificationSend(client, {
            tenantId,
            attemptId: attempt.attempt_id,
            correlationId: request.correlationId,
          });
          return { status: 202, body: attempt };
        },
      );
      reply.code(response.status).send(response.body);
    },
  );

  app.post<{ Params: { tenantId: string; attempt_id: string } }>(
    "/v1/webhooks/ops-alerts/:tenantId/:attempt_id",
    { config: { skipJwtAuth: true } },
    async (request, reply) => {
      const tenantId = parseUuidNotFound(request.params.tenantId, "tenant_id");
      const attemptId = parseUuidNotFound(request.params.attempt_id, "attempt_id");
      const rawBody = request.body;
      const body = parseOpsNotificationCallbackRequest(rawBody);
      const headers = parseOpsNotificationCallbackHeaders(request.headers);
      if (headers.eventId !== body.receiptId) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_notification_callback_event_id_must_match_receipt_id" });
      }

      const authRow = await withTenantTx(deps.pool, tenantId, (client) =>
        selectOpsNotificationAttemptForCallbackAuth(client, tenantId, attemptId),
      );
      if (authRow === null) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "ops_notification_attempt_not_found" });
      }
      if (authRow.callback_signature_secret_ref === null) {
        throw new ApiResponseError("UNAUTHENTICATED", { reason: "ops_notification_callback_signature_not_configured" });
      }

      const boundary = deps.opsNotificationCallbackSecretBoundary ?? deps.webhookSecretBoundary;
      if (boundary === undefined) {
        throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "ops_notification_callback_secret_boundary_not_configured" });
      }
      const secretRef = authRow.callback_signature_secret_ref as SecretRef;
      const secret = await boundary.resolveAuthorized({
        principal: opsNotificationCallbackPrincipal(tenantId),
        ref: secretRef,
        purpose: "notification",
        connectorId: authRow.route_policy_ref,
      });
      const signingPayload = webhookSigningPayload(headers.timestamp, headers.eventId, rawBody);
      if (!verifyWebhookSignature(secret, headers.signature, signingPayload)) {
        throw new ApiResponseError("UNAUTHENTICATED", { reason: "invalid_ops_notification_callback_signature" });
      }

      const item = await withTenantTx(deps.pool, tenantId, (client) =>
        recordOpsNotificationCallbackDelivery(client, tenantId, authRow, body),
      );
      reply.code(202).send(item);
    },
  );
}

async function readOpsAlerts(
  client: PoolClient,
  tenantId: string,
  source: OpsAlertSource | undefined,
  sourceQueryLimit: number,
): Promise<OpsAlertItem[]> {
  const alerts = await readComputedOpsAlerts(client, tenantId, source, sourceQueryLimit);
  return hydrateAlerts(client, tenantId, alerts);
}

export async function readComputedOpsAlerts(
  client: PoolClient,
  tenantId: string,
  source: OpsAlertSource | undefined,
  sourceQueryLimit: number,
): Promise<ComputedOpsAlert[]> {
  const runRows = source === undefined || source === "run_sla"
    ? await client.query<RunSlaRow>(
        `SELECT id, status, created_at, updated_at,
                floor(extract(epoch FROM (now() - created_at)) / 60)::int AS age_minutes
           FROM runs
          WHERE tenant_id = $1::uuid
            AND status IN ('queued','claimed','running','suspending','suspended','resume_requested','resuming','completing')
            AND created_at <= now() - interval '60 minutes'
          ORDER BY (created_at <= now() - interval '240 minutes') DESC, updated_at DESC, id ASC
          LIMIT $2`,
        [tenantId, sourceQueryLimit],
      )
    : { rows: [] as RunSlaRow[] };
  const humanRows = source === undefined || source === "human_task_sla"
    ? await client.query<HumanTaskSlaRow>(
        `SELECT id, run_id, kind, state, assignee, expires_at,
                floor(extract(epoch FROM (expires_at - now())) / 60)::int AS due_minutes
           FROM human_tasks
          WHERE tenant_id = $1::uuid
            AND state IN ('open','assigned','in_progress','escalated')
            AND expires_at IS NOT NULL
            AND expires_at <= now() + interval '15 minutes'
          ORDER BY (expires_at < now()) DESC, expires_at DESC, id ASC
          LIMIT $2`,
        [tenantId, sourceQueryLimit],
      )
    : { rows: [] as HumanTaskSlaRow[] };
  const triggerRows = source === undefined || source === "trigger_fire"
    ? await client.query<TriggerFireRow>(
        `SELECT id, trigger_id, status, scheduled_for, failure_reason, created_at
           FROM run_trigger_fires
          WHERE tenant_id = $1::uuid
            AND status IN ('failed','skipped')
          ORDER BY (status = 'failed') DESC, created_at DESC, id ASC
          LIMIT $2`,
        [tenantId, sourceQueryLimit],
      )
    : { rows: [] as TriggerFireRow[] };
  const failureSpikeRows = source === undefined || source === "failure_spike"
    ? await readFailureSpikeRows(client, tenantId)
    : { rows: [] as FailureSpikeRow[] };
  const dlqRows = source === undefined || source === "dlq"
    ? await readDlqRows(client, tenantId)
    : { rows: [] as DlqCountRow[] };
  const botPoolAlerts = source === undefined || source === "bot_pool"
    ? await readBotPoolAlerts(client, tenantId)
    : [];
  const scimSecretRotationAlerts = source === undefined || source === "scim_secret_rotation"
    ? await readScimSecretRotationAlerts(client, tenantId, sourceQueryLimit)
    : [];
  const auditVerifierAlerts = source === undefined || source === "audit_verifier"
    ? await readAuditVerifierAlerts(client, tenantId)
    : [];
  const readinessEvidenceAlerts = source === undefined || source === "readiness_evidence"
    ? await readReadinessEvidenceAlerts(client, tenantId, sourceQueryLimit)
    : [];
  const sessionExpiryAlerts = source === undefined || source === "session_expiry"
    ? await readSessionExpiryAlerts(client, tenantId, sourceQueryLimit)
    : [];
  const artifactRedactionAlerts = source === undefined || source === "artifact_redaction"
    ? await readArtifactRedactionAlerts(client, tenantId, sourceQueryLimit)
    : [];

  return [
    ...runRows.rows.map(mapRunSlaAlert),
    ...humanRows.rows.map(mapHumanTaskSlaAlert),
    ...triggerRows.rows.map(mapTriggerFireAlert),
    ...failureSpikeRows.rows.flatMap(mapFailureSpikeAlert),
    ...dlqRows.rows.flatMap(mapDlqAlert),
    ...botPoolAlerts,
    ...scimSecretRotationAlerts,
    ...auditVerifierAlerts,
    ...readinessEvidenceAlerts,
    ...sessionExpiryAlerts,
    ...artifactRedactionAlerts,
  ];
}

async function readComputedOpsAlertById(
  client: PoolClient,
  tenantId: string,
  alertId: string,
): Promise<ComputedOpsAlert | null> {
  if (alertId.startsWith("run_sla:")) {
    const subjectId = alertId.slice("run_sla:".length);
    const result = await client.query<RunSlaRow>(
      `SELECT id, status, created_at, updated_at,
              floor(extract(epoch FROM (now() - created_at)) / 60)::int AS age_minutes
         FROM runs
        WHERE tenant_id = $1::uuid
          AND id::text = $2
          AND status IN ('queued','claimed','running','suspending','suspended','resume_requested','resuming','completing')
          AND created_at <= now() - interval '60 minutes'`,
      [tenantId, subjectId],
    );
    return result.rows[0] === undefined ? null : mapRunSlaAlert(result.rows[0]);
  }
  if (alertId.startsWith("human_task_sla:")) {
    const subjectId = alertId.slice("human_task_sla:".length);
    const result = await client.query<HumanTaskSlaRow>(
      `SELECT id, run_id, kind, state, assignee, expires_at,
              floor(extract(epoch FROM (expires_at - now())) / 60)::int AS due_minutes
         FROM human_tasks
        WHERE tenant_id = $1::uuid
          AND id::text = $2
          AND state IN ('open','assigned','in_progress','escalated')
          AND expires_at IS NOT NULL
          AND expires_at <= now() + interval '15 minutes'`,
      [tenantId, subjectId],
    );
    return result.rows[0] === undefined ? null : mapHumanTaskSlaAlert(result.rows[0]);
  }
  if (alertId.startsWith("trigger_fire:")) {
    const subjectId = alertId.slice("trigger_fire:".length);
    const result = await client.query<TriggerFireRow>(
      `SELECT id, trigger_id, status, scheduled_for, failure_reason, created_at
         FROM run_trigger_fires
        WHERE tenant_id = $1::uuid
          AND id::text = $2
          AND status IN ('failed','skipped')`,
      [tenantId, subjectId],
    );
    return result.rows[0] === undefined ? null : mapTriggerFireAlert(result.rows[0]);
  }
  if (alertId === "failure_spike:15m") {
    const result = await readFailureSpikeRows(client, tenantId);
    return mapFailureSpikeAlert(result.rows[0] ?? { failure_count: "0", latest_at: null })[0] ?? null;
  }
  if (alertId === "dlq:unreplayed") {
    const result = await readDlqRows(client, tenantId);
    return mapDlqAlert(result.rows[0] ?? { workitem_count: "0", sink_count: "0", latest_at: null })[0] ?? null;
  }
  if (alertId.startsWith("bot_pool:")) {
    const alerts = await readBotPoolAlerts(client, tenantId);
    return alerts.find((alert) => alert.alert_id === alertId) ?? null;
  }
  if (alertId.startsWith("scim_secret_rotation:")) {
    const providerKey = alertId.slice("scim_secret_rotation:".length);
    return readScimSecretRotationAlertByProvider(client, tenantId, providerKey);
  }
  if (alertId === "audit_verifier:stale" || alertId.startsWith("audit_verifier:")) {
    return readAuditVerifierAlertById(client, tenantId, alertId);
  }
  if (alertId.startsWith("readiness_evidence:")) {
    const evidenceType = alertId.slice("readiness_evidence:".length);
    return readReadinessEvidenceAlertByType(client, tenantId, evidenceType);
  }
  if (alertId.startsWith("session_expiry:")) {
    return readSessionExpiryAlertById(client, tenantId, alertId);
  }
  if (alertId.startsWith("artifact_redaction:")) {
    return readArtifactRedactionAlertById(client, tenantId, alertId);
  }
  return null;
}

async function readFailureSpikeRows(client: PoolClient, tenantId: string): Promise<{ rows: FailureSpikeRow[] }> {
  return client.query<FailureSpikeRow>(
    `SELECT count(*)::text AS failure_count, max(updated_at) AS latest_at
       FROM runs
      WHERE tenant_id = $1::uuid
        AND status IN ('failed_business','failed_system')
        AND updated_at >= now() - interval '15 minutes'`,
    [tenantId],
  );
}

async function readDlqRows(client: PoolClient, tenantId: string): Promise<{ rows: DlqCountRow[] }> {
  return client.query<DlqCountRow>(
    `SELECT
       (SELECT count(*)::text
          FROM dead_letter
         WHERE tenant_id = $1::uuid AND replayed_at IS NULL) AS workitem_count,
       (SELECT count(*)::text
          FROM sink_deliveries
         WHERE tenant_id = $1::uuid AND status = 'dead_letter' AND requeued_at IS NULL) AS sink_count,
       GREATEST(
         (SELECT max(created_at)
            FROM dead_letter
           WHERE tenant_id = $1::uuid AND replayed_at IS NULL),
         (SELECT max(attempted_at)
            FROM sink_deliveries
           WHERE tenant_id = $1::uuid AND status = 'dead_letter' AND requeued_at IS NULL)
       ) AS latest_at`,
    [tenantId],
  );
}

async function readBotPoolAlerts(client: PoolClient, tenantId: string): Promise<ComputedOpsAlert[]> {
  const pool = await readBrowserBotPool(client, tenantId);
  if (pool.health === "ok") return [];
  const detectedAt = await readBotPoolDetectedAt(client, tenantId, pool.capacity.live_capacity.pool_key);
  return [mapBotPoolAlert(pool, detectedAt)];
}

async function readBotPoolDetectedAt(client: PoolClient, tenantId: string, poolKey: string): Promise<string> {
  const staleThresholdSeconds = workerStaleThresholdSeconds();
  const result = await client.query<BotPoolDetectedAtRow>(
    `SELECT COALESCE(
       (SELECT min(expires_at)
          FROM browser_leases
         WHERE tenant_id = $1::uuid
           AND state IN ('reserved','active')
           AND expires_at < now()),
       (SELECT min(created_at)
          FROM runs
         WHERE tenant_id = $1::uuid
           AND status = 'queued'),
       (SELECT min(circuit_until)
          FROM workers w
          LEFT JOIN worker_pool_memberships m ON m.worker_id = w.id
         WHERE w.kind = 'browser'
           AND w.circuit_state IN ('open','half_open')
           AND w.circuit_until IS NOT NULL
           AND (($2 = 'default' AND m.worker_id IS NULL) OR m.pool_key = $2)),
       (SELECT min(heartbeat_at)
          FROM workers w
          LEFT JOIN worker_pool_memberships m ON m.worker_id = w.id
         WHERE w.kind = 'browser'
           AND w.status = 'active'
           AND w.heartbeat_at <= now() - ($3::integer * interval '1 second')
           AND (($2 = 'default' AND m.worker_id IS NULL) OR m.pool_key = $2)),
       now()
     ) AS detected_at`,
    [tenantId, poolKey, staleThresholdSeconds],
  );
  return (result.rows[0]?.detected_at ?? new Date()).toISOString();
}

async function readScimSecretRotationAlerts(
  client: PoolClient,
  tenantId: string,
  sourceQueryLimit: number,
): Promise<ComputedOpsAlert[]> {
  const result = await client.query<ScimSecretRotationAlertRow>(
    `WITH provider_rotation AS (
       SELECT provider_key, display_name, secret_rotation_policy, created_at, last_secret_rotated_at, decommissioned_at,
              COALESCE(last_secret_rotated_at, created_at) +
              CASE secret_rotation_policy
                WHEN 'periodic_30d' THEN interval '30 days'
                WHEN 'periodic_60d' THEN interval '60 days'
                WHEN 'periodic_90d' THEN interval '90 days'
              END AS rotation_due_at
         FROM scim_providers
        WHERE tenant_id = $1::uuid
          AND status = 'active'
          AND decommissioned_at IS NULL
          AND secret_rotation_policy <> 'manual'
     )
     SELECT provider_key, display_name, secret_rotation_policy, created_at, last_secret_rotated_at, decommissioned_at
       FROM provider_rotation
      WHERE rotation_due_at <= now() + ($2::int * interval '1 day')
      ORDER BY (rotation_due_at <= now()) DESC, rotation_due_at ASC, provider_key ASC
      LIMIT $3`,
    [tenantId, SCIM_SECRET_ROTATION_DUE_SOON_DAYS, sourceQueryLimit],
  );
  return result.rows.flatMap(mapScimSecretRotationAlert);
}

async function readScimSecretRotationAlertByProvider(
  client: PoolClient,
  tenantId: string,
  providerKey: string,
): Promise<ComputedOpsAlert | null> {
  const result = await client.query<ScimSecretRotationAlertRow>(
    `SELECT provider_key, display_name, secret_rotation_policy, created_at, last_secret_rotated_at, decommissioned_at
       FROM scim_providers
      WHERE tenant_id = $1::uuid
        AND provider_key = $2::text
        AND status = 'active'
        AND decommissioned_at IS NULL
        AND secret_rotation_policy <> 'manual'`,
    [tenantId, providerKey],
  );
  return mapScimSecretRotationAlert(result.rows[0]).at(0) ?? null;
}

async function readAuditVerifierAlerts(client: PoolClient, tenantId: string): Promise<ComputedOpsAlert[]> {
  const latestRun = await client.query<AuditVerifierLatestRunRow>(
    `SELECT id, status, rows_checked::text, violation_count, completed_at
       FROM audit_verifier_runs
      WHERE tenant_id = $1::uuid
        AND deleted_at IS NULL
      ORDER BY completed_at DESC, id DESC
      LIMIT 1`,
    [tenantId],
  );
  const freshness = await readAuditVerifierFreshness(client, tenantId);
  return [
    ...mapAuditVerifierStatusAlert(latestRun.rows[0]),
    ...mapAuditVerifierStaleAlert(freshness.rows[0]),
  ];
}

async function readAuditVerifierAlertById(
  client: PoolClient,
  tenantId: string,
  alertId: string,
): Promise<ComputedOpsAlert | null> {
  if (alertId === "audit_verifier:stale") {
    return (await readAuditVerifierAlerts(client, tenantId)).find((alert) => alert.alert_id === alertId) ?? null;
  }
  const verificationRunId = alertId.slice("audit_verifier:".length);
  const result = await client.query<AuditVerifierLatestRunRow>(
    `SELECT id, status, rows_checked::text, violation_count, completed_at
       FROM audit_verifier_runs r
      WHERE r.tenant_id = $1::uuid
        AND r.id::text = $2
        AND r.deleted_at IS NULL
        AND r.status IN ('invalid','failed')
        AND NOT EXISTS (
          SELECT 1
            FROM audit_verifier_runs newer
           WHERE newer.tenant_id = r.tenant_id
             AND newer.deleted_at IS NULL
             AND (newer.completed_at, newer.id) > (r.completed_at, r.id)
        )`,
    [tenantId, verificationRunId],
  );
  return mapAuditVerifierStatusAlert(result.rows[0]).at(0) ?? null;
}

async function readAuditVerifierFreshness(
  client: PoolClient,
  tenantId: string,
): Promise<{ rows: AuditVerifierFreshnessRow[] }> {
  return client.query<AuditVerifierFreshnessRow>(
    `WITH latest_run AS (
       SELECT id, status, completed_at
         FROM audit_verifier_runs
        WHERE tenant_id = $1::uuid
          AND deleted_at IS NULL
        ORDER BY completed_at DESC, id DESC
        LIMIT 1
     )
     SELECT
       (SELECT count(*)::text
          FROM audit_log
         WHERE tenant_id = $1::uuid
           AND deleted_at IS NULL) AS audit_count,
       (SELECT max(occurred_at)
          FROM audit_log
         WHERE tenant_id = $1::uuid
           AND deleted_at IS NULL) AS latest_audit_at,
       latest_run.id::text AS latest_run_id,
       latest_run.status AS latest_status,
       latest_run.completed_at AS latest_completed_at,
       (latest_run.completed_at IS NULL
        OR latest_run.completed_at <= now() - ($2::bigint * interval '1 millisecond')) AS stale
      FROM (SELECT 1) seed
      LEFT JOIN latest_run ON true`,
    [tenantId, AUDIT_VERIFIER_STALE_AFTER_MS],
  );
}

async function readReadinessEvidenceAlerts(
  client: PoolClient,
  tenantId: string,
  sourceQueryLimit: number,
): Promise<ComputedOpsAlert[]> {
  const result = await client.query<ProductionReadinessEvidenceAlertRow>(
    `WITH ranked AS (
       SELECT evidence_type, status, evidence_at, expires_at, recorded_at,
              row_number() OVER (
                PARTITION BY evidence_type
                ORDER BY evidence_at DESC, recorded_at DESC, id DESC
              ) AS rn
         FROM production_readiness_evidence
        WHERE tenant_id = $1::uuid
          AND deleted_at IS NULL
          AND evidence_type IN ('external_alert_delivery','managed_backup_restore_drill','slo_oncall_signoff','support_training_completion','observability_telemetry_wiring')
     )
     SELECT evidence_type, status, evidence_at, expires_at, recorded_at
       FROM ranked
      WHERE rn = 1
        AND (
          status = 'failed'
          OR expires_at IS NULL
          OR expires_at <= now() + ($2::int * interval '1 day')
        )
      ORDER BY (status = 'failed') DESC,
               (expires_at IS NULL OR expires_at <= now()) DESC,
               expires_at ASC NULLS FIRST,
               evidence_type ASC
      LIMIT $3`,
    [tenantId, READINESS_EVIDENCE_DUE_SOON_DAYS, sourceQueryLimit],
  );
  return result.rows.map(mapReadinessEvidenceAlert);
}

async function readReadinessEvidenceAlertByType(
  client: PoolClient,
  tenantId: string,
  evidenceType: string,
): Promise<ComputedOpsAlert | null> {
  if (!isReadinessEvidenceAlertType(evidenceType)) return null;
  const result = await client.query<ProductionReadinessEvidenceAlertRow>(
    `WITH ranked AS (
       SELECT evidence_type, status, evidence_at, expires_at, recorded_at,
              row_number() OVER (
                PARTITION BY evidence_type
                ORDER BY evidence_at DESC, recorded_at DESC, id DESC
              ) AS rn
         FROM production_readiness_evidence
        WHERE tenant_id = $1::uuid
          AND deleted_at IS NULL
          AND evidence_type = $2::text
     )
     SELECT evidence_type, status, evidence_at, expires_at, recorded_at
       FROM ranked
      WHERE rn = 1
        AND (
          status = 'failed'
          OR expires_at IS NULL
          OR expires_at <= now() + ($3::int * interval '1 day')
        )`,
    [tenantId, evidenceType, READINESS_EVIDENCE_DUE_SOON_DAYS],
  );
  return result.rows[0] === undefined ? null : mapReadinessEvidenceAlert(result.rows[0]);
}

async function readSessionExpiryAlerts(
  client: PoolClient,
  tenantId: string,
  sourceQueryLimit: number,
): Promise<ComputedOpsAlert[]> {
  const result = await client.query<BrowserSessionExpiryRow>(
    `SELECT bs.site_profile_id::text AS site_profile_id,
            s.name AS site_name,
            s.url_pattern,
            bs.browser_identity_id::text AS browser_identity_id,
            md5(bs.identity_key) AS identity_hash,
            bs.expires_at,
            floor(extract(epoch FROM (bs.expires_at - now())) / 60)::int AS due_minutes
       FROM browser_sessions bs
       JOIN site_profiles s
         ON s.tenant_id = bs.tenant_id
        AND s.id = bs.site_profile_id
      WHERE bs.tenant_id = $1::uuid
        AND bs.expires_at IS NOT NULL
        AND bs.expires_at <= now() + ($2::int * interval '1 hour')
      ORDER BY (bs.expires_at <= now()) DESC, bs.expires_at ASC, bs.site_profile_id ASC, bs.browser_identity_id ASC, bs.identity_key ASC
      LIMIT $3`,
    [tenantId, SESSION_EXPIRY_DUE_SOON_HOURS, sourceQueryLimit],
  );
  return result.rows.map(mapSessionExpiryAlert);
}

async function readSessionExpiryAlertById(
  client: PoolClient,
  tenantId: string,
  alertId: string,
): Promise<ComputedOpsAlert | null> {
  const parts = alertId.split(":");
  if (parts.length !== 4) return null;
  const [, siteProfileId, browserIdentityId, identityHash] = parts;
  if (!UUID_RE.test(siteProfileId) || !UUID_RE.test(browserIdentityId) || !/^[a-f0-9]{32}$/.test(identityHash)) {
    return null;
  }
  const result = await client.query<BrowserSessionExpiryRow>(
    `SELECT bs.site_profile_id::text AS site_profile_id,
            s.name AS site_name,
            s.url_pattern,
            bs.browser_identity_id::text AS browser_identity_id,
            md5(bs.identity_key) AS identity_hash,
            bs.expires_at,
            floor(extract(epoch FROM (bs.expires_at - now())) / 60)::int AS due_minutes
       FROM browser_sessions bs
       JOIN site_profiles s
         ON s.tenant_id = bs.tenant_id
        AND s.id = bs.site_profile_id
      WHERE bs.tenant_id = $1::uuid
        AND bs.site_profile_id = $2::uuid
        AND bs.browser_identity_id = $3::uuid
        AND md5(bs.identity_key) = $4
        AND bs.expires_at IS NOT NULL
        AND bs.expires_at <= now() + ($5::int * interval '1 hour')`,
    [tenantId, siteProfileId, browserIdentityId, identityHash, SESSION_EXPIRY_DUE_SOON_HOURS],
  );
  return result.rows[0] === undefined ? null : mapSessionExpiryAlert(result.rows[0]);
}

function mapRunSlaAlert(row: RunSlaRow): ComputedOpsAlert {
  const critical = row.age_minutes >= 240;
  return {
    alert_id: `run_sla:${row.id}`,
    severity: critical ? "critical" : "warning",
    source: "run_sla",
    title: critical ? "장시간 실행 위험" : "실행 SLA 주의",
    detail: `${row.status} 상태가 ${row.age_minutes}분 동안 지속되었습니다.`,
    subject_type: "run",
    subject_id: row.id,
    recommended_action: "실행 기록에서 단계 지연과 마지막 업데이트를 확인하세요.",
    route: `#runTrace?run=${encodeURIComponent(row.id)}`,
    detected_at: row.updated_at.toISOString(),
    due_at: null,
  };
}

function mapHumanTaskSlaAlert(row: HumanTaskSlaRow): ComputedOpsAlert {
  const overdue = row.due_minutes < 0;
  const assignee = row.assignee !== null ? ` 담당자 ${row.assignee}` : " 미배정";
  return {
    alert_id: `human_task_sla:${row.id}`,
    severity: overdue ? "critical" : "warning",
    source: "human_task_sla",
    title: overdue ? "사람 확인 기한 초과" : "사람 확인 기한 임박",
    detail: `${row.kind}/${row.state}${assignee}. ${overdue ? `${Math.abs(row.due_minutes)}분 초과` : `${row.due_minutes}분 남음`}.`,
    subject_type: "human_task",
    subject_id: row.id,
    recommended_action: "담당자를 배정하거나 검증 워크벤치에서 판정하세요.",
    route: `#humanTasks?ht=${encodeURIComponent(row.id)}`,
    detected_at: row.expires_at.toISOString(),
    due_at: row.expires_at.toISOString(),
  };
}

function mapSessionExpiryAlert(row: BrowserSessionExpiryRow): ComputedOpsAlert {
  const overdue = row.due_minutes < 0;
  const siteLabel = `${row.site_name} (${row.url_pattern})`;
  return {
    alert_id: `session_expiry:${row.site_profile_id}:${row.browser_identity_id}:${row.identity_hash}`,
    severity: overdue ? "critical" : "warning",
    source: "session_expiry",
    title: overdue ? "로그인 세션 만료" : "로그인 세션 만료 임박",
    detail: overdue
      ? `${siteLabel} 세션이 ${Math.abs(row.due_minutes)}분 전에 만료되었습니다.`
      : `${siteLabel} 세션이 ${row.due_minutes}분 뒤 만료됩니다.`,
    subject_type: "browser_session",
    subject_id: row.site_profile_id,
    recommended_action: "보안 설정에서 해당 사이트의 세션을 다시 등록하세요.",
    route: `#security?section=sites&site=${encodeURIComponent(row.site_profile_id)}`,
    detected_at: row.expires_at.toISOString(),
    due_at: row.expires_at.toISOString(),
  };
}

function mapTriggerFireAlert(row: TriggerFireRow): ComputedOpsAlert {
  const code = failureCode(row.failure_reason);
  return {
    alert_id: `trigger_fire:${row.id}`,
    severity: row.status === "failed" ? "critical" : "warning",
    source: "trigger_fire",
    title: row.status === "failed" ? "예약 실행 실패" : "예약 실행 건너뜀",
    detail: `${row.scheduled_for.toISOString()} 예약 fire가 ${row.status} 상태입니다.${code !== null ? ` 사유: ${code}` : ""}`,
    subject_type: "run_trigger",
    subject_id: row.trigger_id,
    recommended_action: "예약 설정과 최대 동시 실행 수, 실패 사유를 확인하세요.",
    route: `#automationOps?trigger=${encodeURIComponent(row.trigger_id)}`,
    detected_at: row.created_at.toISOString(),
    due_at: row.scheduled_for.toISOString(),
  };
}

function mapFailureSpikeAlert(row: FailureSpikeRow): ComputedOpsAlert[] {
  const failureCount = Number(row.failure_count);
  if (failureCount < 3) return [];
  return [{
    alert_id: "failure_spike:15m",
    severity: failureCount >= 5 ? "critical" : "warning",
    source: "failure_spike",
    title: "실패 급증 감지",
    detail: `최근 15분 동안 실패한 실행이 ${failureCount}건 발생했습니다.`,
    subject_type: "run",
    subject_id: null,
    recommended_action: "실행 기록에서 failed_system/failed_business 원인을 확인하고 공통 장애 여부를 점검하세요.",
    route: "#runTrace?status=failed_system",
    detected_at: (row.latest_at ?? new Date()).toISOString(),
    due_at: null,
  }];
}

function mapDlqAlert(row: DlqCountRow): ComputedOpsAlert[] {
  const workitemCount = Number(row.workitem_count);
  const sinkCount = Number(row.sink_count);
  const total = workitemCount + sinkCount;
  if (total === 0) return [];
  return [{
    alert_id: "dlq:unreplayed",
    severity: total >= 10 ? "critical" : "warning",
    source: "dlq",
    title: "재처리 대기 DLQ",
    detail: `작업 항목 ${workitemCount}건, 외부 전달 ${sinkCount}건이 재처리를 기다립니다.`,
    subject_type: "dlq",
    subject_id: null,
    recommended_action: "DLQ 목록에서 재처리 가능 여부와 실패 코드를 확인하세요.",
    route: "#workitems",
    detected_at: (row.latest_at ?? new Date()).toISOString(),
    due_at: null,
  }];
}

function mapBotPoolAlert(pool: BotPoolItem, detectedAt: string): ComputedOpsAlert {
  const critical = pool.health === "critical";
  return {
    alert_id: `bot_pool:${pool.bot_pool_id}`,
    severity: critical ? "critical" : "warning",
    source: "bot_pool",
    title: critical ? "브라우저 풀 장애" : "브라우저 풀 주의",
    detail: pool.health_reason,
    subject_type: "bot_pool",
    subject_id: pool.bot_pool_id,
    recommended_action: "Bot Pool 용량, 만료 lease, worker heartbeat/circuit 상태를 확인하세요.",
    route: "#orchestration?panel=botPools",
    detected_at: detectedAt,
    due_at: null,
  };
}

function mapScimSecretRotationAlert(row: ScimSecretRotationAlertRow | undefined): ComputedOpsAlert[] {
  if (row === undefined) return [];
  const dueAt = scimSecretRotationDueAt(row.secret_rotation_policy, row.created_at, row.last_secret_rotated_at);
  if (dueAt === null) return [];
  const rotationStatus = scimSecretRotationStatus(
    row.secret_rotation_policy,
    row.created_at,
    row.last_secret_rotated_at,
    row.decommissioned_at,
  );
  if (rotationStatus !== "due_soon" && rotationStatus !== "overdue") return [];
  const overdue = rotationStatus === "overdue";
  const detectedAt = overdue
    ? dueAt
    : new Date(dueAt.getTime() - SCIM_SECRET_ROTATION_DUE_SOON_DAYS * 24 * 60 * 60 * 1000);
  return [{
    alert_id: `scim_secret_rotation:${row.provider_key}`,
    severity: overdue ? "critical" : "warning",
    source: "scim_secret_rotation",
    title: overdue ? "SCIM signing SecretRef rotation overdue" : "SCIM signing SecretRef rotation due soon",
    detail: `${row.display_name} (${row.provider_key}) policy ${row.secret_rotation_policy} is ${rotationStatus}; due_at ${dueAt.toISOString()}.`,
    subject_type: "scim_provider",
    subject_id: row.provider_key,
    recommended_action: "Patch the provider to a newly issued signature_secret_ref, or set secret_rotation_policy=manual only with owner-approved evidence.",
    route: `#security?panel=scim&provider=${encodeURIComponent(row.provider_key)}`,
    detected_at: detectedAt.toISOString(),
    due_at: dueAt.toISOString(),
  }];
}

function mapAuditVerifierStatusAlert(row: AuditVerifierLatestRunRow | undefined): ComputedOpsAlert[] {
  if (row === undefined || row.status === "valid") return [];
  return [{
    alert_id: `audit_verifier:${row.id}`,
    severity: "critical",
    source: "audit_verifier",
    title: row.status === "failed" ? "감사 체인 자동 검증 실패" : "감사 체인 무결성 위반",
    detail: row.status === "failed"
      ? "최신 감사 체인 검증 job이 실패했습니다. 실패 증적이 남아 있으며 운영자가 재검증해야 합니다."
      : `최신 감사 체인 검증에서 ${row.violation_count}건의 위반이 발견되었습니다. 검증 범위는 ${row.rows_checked}행입니다.`,
    subject_type: "audit_verifier",
    subject_id: row.id,
    recommended_action: "Audit Explorer에서 검증 실행 증적을 확인하고 수동 재검증 또는 incident 절차를 시작하세요.",
    route: "#auditExplorer",
    detected_at: row.completed_at.toISOString(),
    due_at: null,
  }];
}

function mapAuditVerifierStaleAlert(row: AuditVerifierFreshnessRow | undefined): ComputedOpsAlert[] {
  if (row === undefined || Number(row.audit_count) === 0 || !row.stale) return [];
  const dueAt = row.latest_completed_at === null
    ? null
    : new Date(row.latest_completed_at.getTime() + AUDIT_VERIFIER_STALE_AFTER_MS);
  const detectedAt = row.latest_completed_at ?? row.latest_audit_at ?? new Date();
  return [{
    alert_id: "audit_verifier:stale",
    severity: "warning",
    source: "audit_verifier",
    title: "감사 체인 검증 증적 지연",
    detail: row.latest_completed_at === null
      ? "감사 로그가 존재하지만 아직 자동 검증 실행 증적이 없습니다."
      : `마지막 감사 체인 검증이 ${row.latest_completed_at.toISOString()} 이후 갱신되지 않았습니다.`,
    subject_type: "audit_verifier",
    subject_id: row.latest_run_id,
    recommended_action: "maintenance scheduler와 audit_verifier runtime job 처리 상태를 확인하고 필요하면 수동 검증을 실행하세요.",
    route: "#auditExplorer",
    detected_at: detectedAt.toISOString(),
    due_at: dueAt?.toISOString() ?? null,
  }];
}

function mapReadinessEvidenceAlert(row: ProductionReadinessEvidenceAlertRow): ComputedOpsAlert {
  const label = readinessEvidenceLabel(row.evidence_type);
  const failed = row.status === "failed";
  const expired = row.expires_at === null || row.expires_at.getTime() <= Date.now();
  const detectedAt = failed
    ? row.evidence_at
    : row.expires_at === null
      ? row.evidence_at
      : new Date(row.expires_at.getTime() - READINESS_EVIDENCE_DUE_SOON_DAYS * 24 * 60 * 60 * 1000);
  return {
    alert_id: `readiness_evidence:${row.evidence_type}`,
    severity: failed || expired ? "critical" : "warning",
    source: "readiness_evidence",
    title: failed
      ? `${label} evidence failed`
      : expired
        ? `${label} evidence expired`
        : `${label} evidence expires soon`,
    detail: failed
      ? `${label} latest production-readiness evidence is recorded as failed at ${row.evidence_at.toISOString()}.`
      : row.expires_at === null
        ? `${label} latest production-readiness evidence has no expiry timestamp and cannot be treated as ready.`
        : `${label} latest production-readiness evidence expires at ${row.expires_at.toISOString()}.`,
    subject_type: "readiness_evidence",
    subject_id: row.evidence_type,
    recommended_action: "Open production readiness and record fresh valid owner/platform evidence before controlled-prod release.",
    route: "#automationOps?panel=productionReadiness",
    detected_at: detectedAt.toISOString(),
    due_at: row.expires_at?.toISOString() ?? null,
  };
}

function isReadinessEvidenceAlertType(value: string): value is ProductionReadinessEvidenceAlertType {
  return (
    value === "external_alert_delivery" ||
    value === "managed_backup_restore_drill" ||
    value === "slo_oncall_signoff" ||
    value === "support_training_completion" ||
    value === "observability_telemetry_wiring"
  );
}

function readinessEvidenceLabel(evidenceType: ProductionReadinessEvidenceAlertType): string {
  if (evidenceType === "external_alert_delivery") return "External alert delivery";
  if (evidenceType === "managed_backup_restore_drill") return "Managed backup/PITR restore drill";
  if (evidenceType === "slo_oncall_signoff") return "SLO/on-call sign-off";
  if (evidenceType === "support_training_completion") return "Support/training completion";
  return "Observability telemetry wiring";
}

async function hydrateAlerts(
  client: PoolClient,
  tenantId: string,
  alerts: readonly ComputedOpsAlert[],
): Promise<OpsAlertItem[]> {
  if (alerts.length === 0) return [];
  const alertIds = [...new Set(alerts.map((alert) => alert.alert_id))];
  const rows = await client.query<OpsAlertAckRow>(
    `SELECT alert_id, detected_at, acknowledged_by, acknowledged_at, comment
       FROM ops_alert_acknowledgements
      WHERE tenant_id = $1::uuid
        AND alert_id = ANY($2::text[])`,
    [tenantId, alertIds],
  );
  const ackByGeneration = new Map(rows.rows.map((row) => [alertGenerationKey(row.alert_id, row.detected_at), row]));
  return alerts.map((alert) => hydrateAlert(alert, ackByGeneration.get(alertGenerationKey(alert.alert_id, alert.detected_at))));
}

function hydrateAlert(alert: ComputedOpsAlert, ackRow: OpsAlertAckRow | undefined): OpsAlertItem {
  return {
    ...alert,
    status: ackRow === undefined ? "open" : "acknowledged",
    delivery: consoleDelivery(alert.detected_at),
    ack: ackRow === undefined
      ? null
      : {
          acknowledged_by: ackRow.acknowledged_by,
          acknowledged_at: ackRow.acknowledged_at.toISOString(),
          comment: ackRow.comment,
        },
  };
}

async function acknowledgeAlert(
  client: PoolClient,
  tenantId: string,
  alert: ComputedOpsAlert,
  acknowledgedBy: string,
  comment: string | null,
): Promise<OpsAlertItem> {
  const result = await client.query<OpsAlertAckRow>(
    `INSERT INTO ops_alert_acknowledgements (
       id, tenant_id, alert_id, detected_at, source, subject_type, subject_id,
       acknowledged_by, comment
     )
     VALUES ($1,$2::uuid,$3,$4::timestamptz,$5,$6,$7,$8,$9)
     ON CONFLICT (tenant_id, alert_id, detected_at) DO UPDATE
       SET alert_id = ops_alert_acknowledgements.alert_id
     RETURNING alert_id, detected_at, acknowledged_by, acknowledged_at, comment`,
    [
      randomUUID(),
      tenantId,
      alert.alert_id,
      alert.detected_at,
      alert.source,
      alert.subject_type,
      alert.subject_id,
      acknowledgedBy,
      comment,
    ],
  );
  return hydrateAlert(alert, result.rows[0]);
}

async function readOpsNotificationDeliveries(
  client: PoolClient,
  tenantId: string,
  alertId: string,
  limit: number,
): Promise<OpsNotificationDelivery[]> {
  const result = await client.query<OpsNotificationDeliveryRow>(
    `SELECT id::text, alert_id, detected_at, source, subject_type, subject_id,
            channel, provider_alias, status, receipt_id, receipt_at,
            endpoint_secret_ref, credential_secret_ref, callback_signature_secret_ref, route_policy_ref,
            recipient_group_ref, attempt_no, summary, error_code, metadata, recorded_by, recorded_at, legal_hold
       FROM ops_notification_deliveries
      WHERE tenant_id = $1::uuid
        AND alert_id = $2::text
        AND deleted_at IS NULL
      ORDER BY receipt_at DESC, recorded_at DESC, id DESC
      LIMIT $3`,
    [tenantId, alertId, limit],
  );
  return result.rows.map(mapOpsNotificationDelivery);
}

async function insertOpsNotificationDelivery(
  client: PoolClient,
  tenantId: string,
  alert: ComputedOpsAlert,
  recordedBy: string,
  input: OpsNotificationDeliveryInput,
): Promise<OpsNotificationDelivery> {
  const retentionUntil = new Date(Date.now() + OPS_NOTIFICATION_DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result = await client.query<OpsNotificationDeliveryRow>(
    `INSERT INTO ops_notification_deliveries (
       id, tenant_id, alert_id, detected_at, source, subject_type, subject_id,
       channel, provider_alias, status, receipt_id, receipt_at,
       endpoint_secret_ref, credential_secret_ref, callback_signature_secret_ref, route_policy_ref,
       recipient_group_ref, attempt_no, summary, error_code, metadata, recorded_by, retention_until, legal_hold
     )
     VALUES (
       $1::uuid,$2::uuid,$3,$4::timestamptz,$5,$6,$7,
       $8,$9,$10,$11,$12::timestamptz,$13,$14,$15,$16,
       $17,$18,$19,$20,$21::jsonb,$22,$23::timestamptz,$24
     )
     RETURNING id::text, alert_id, detected_at, source, subject_type, subject_id,
               channel, provider_alias, status, receipt_id, receipt_at,
               endpoint_secret_ref, credential_secret_ref, callback_signature_secret_ref, route_policy_ref,
               recipient_group_ref, attempt_no, summary, error_code, metadata, recorded_by, recorded_at, legal_hold`,
    [
      randomUUID(),
      tenantId,
      alert.alert_id,
      alert.detected_at,
      alert.source,
      alert.subject_type,
      alert.subject_id,
      input.channel,
      input.providerAlias,
      input.status,
      input.receiptId,
      input.receiptAt.toISOString(),
      input.endpointSecretRef,
      input.credentialSecretRef,
      input.callbackSignatureSecretRef,
      input.routePolicyRef,
      input.recipientGroupRef,
      input.attemptNo,
      input.summary,
      input.errorCode,
      JSON.stringify(input.metadata),
      recordedBy,
      retentionUntil.toISOString(),
      input.legalHold,
    ],
  );
  return mapOpsNotificationDelivery(result.rows[0]);
}

export async function insertOpsNotificationAttempt(
  client: PoolClient,
  tenantId: string,
  alert: ComputedOpsAlert,
  requestedBy: string,
  input: OpsNotificationWebhookSendInput,
): Promise<OpsNotificationAttempt> {
  const attemptId = randomUUID();
  const retentionUntil = new Date(Date.now() + OPS_NOTIFICATION_DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const payload = buildWebhookNotificationPayload(tenantId, alert, attemptId, input.routePolicyRef, input.recipientGroupRef, input.callbackSignatureSecretRef);
  const summary = input.summary ?? `Webhook notification requested for ${alert.alert_id}`;
  const result = await client.query<OpsNotificationAttemptRow>(
    `INSERT INTO ops_notification_attempts (
       id, tenant_id, alert_id, detected_at, source, subject_type, subject_id,
       channel, provider_alias, status, endpoint_secret_ref, credential_secret_ref, callback_signature_secret_ref,
       route_policy_ref, recipient_group_ref, allowed_hosts, attempt_no, max_attempts, next_attempt_at,
       payload, summary, metadata, requested_by, retention_until, legal_hold
     )
      VALUES (
        $1::uuid,$2::uuid,$3,$4::timestamptz,$5,$6,$7,
        'webhook',$8,'pending',$9,NULL,$10,
        $11,$12,$13::text[],1,$14,now(),
        $15::jsonb,$16,$17::jsonb,$18,$19::timestamptz,$20
      )
      ON CONFLICT (tenant_id, alert_id, detected_at, provider_alias)
      WHERE deleted_at IS NULL
        AND attempt_no = 1
        AND requested_by = 'system:ops-alert-auto-fire'
      DO NOTHING
      RETURNING id::text, alert_id, detected_at, source, subject_type, subject_id,
                channel, provider_alias, status, endpoint_secret_ref, callback_signature_secret_ref, route_policy_ref,
                recipient_group_ref, allowed_hosts, attempt_no, max_attempts, next_attempt_at, summary,
               error_code, receipt_id, receipt_at, metadata, requested_by, requested_at, legal_hold`,
    [
      attemptId,
      tenantId,
      alert.alert_id,
      alert.detected_at,
      alert.source,
      alert.subject_type,
      alert.subject_id,
      input.providerAlias,
      input.endpointSecretRef,
      input.callbackSignatureSecretRef,
      input.routePolicyRef,
      input.recipientGroupRef,
      input.allowedHosts,
      OPS_NOTIFICATION_DELIVERY_MAX_ATTEMPTS_DEFAULT,
      JSON.stringify(payload),
      summary,
      JSON.stringify(input.metadata),
      requestedBy,
      retentionUntil.toISOString(),
      input.legalHold,
    ],
  );
  if (result.rows[0] === undefined) {
    const existing = await selectExistingOpsNotificationAttemptGeneration(
      client,
      tenantId,
      alert.alert_id,
      alert.detected_at,
      input.providerAlias,
      1,
      requestedBy,
    );
    if (existing === null) {
      throw new Error("ops notification attempt conflict was reported but existing generation was not visible");
    }
    return mapOpsNotificationAttempt(existing);
  }
  return mapOpsNotificationAttempt(result.rows[0]);
}

async function selectExistingOpsNotificationAttemptGeneration(
  client: PoolClient,
  tenantId: string,
  alertId: string,
  detectedAt: string,
  providerAlias: string,
  attemptNo: number,
  requestedBy: string,
): Promise<OpsNotificationAttemptRow | null> {
  const result = await client.query<OpsNotificationAttemptRow>(
    `SELECT id::text, alert_id, detected_at, source, subject_type, subject_id,
            channel, provider_alias, status, endpoint_secret_ref, callback_signature_secret_ref, route_policy_ref,
            recipient_group_ref, allowed_hosts, attempt_no, max_attempts, next_attempt_at, summary,
            error_code, receipt_id, receipt_at, metadata, requested_by, requested_at, legal_hold
       FROM ops_notification_attempts
      WHERE tenant_id = $1::uuid
        AND alert_id = $2
        AND detected_at = $3::timestamptz
        AND provider_alias = $4
        AND attempt_no = $5::int
        AND requested_by = $6
        AND deleted_at IS NULL
      ORDER BY requested_at ASC, id ASC
      LIMIT 1`,
    [tenantId, alertId, detectedAt, providerAlias, attemptNo, requestedBy],
  );
  return result.rows[0] ?? null;
}

async function selectOpsNotificationAttemptForCallbackAuth(
  client: PoolClient,
  tenantId: string,
  attemptId: string,
): Promise<OpsNotificationAttemptRow | null> {
  const result = await client.query<OpsNotificationAttemptRow>(
    `SELECT id::text, alert_id, detected_at, source, subject_type, subject_id,
            channel, provider_alias, status, endpoint_secret_ref, callback_signature_secret_ref, route_policy_ref,
            recipient_group_ref, allowed_hosts, attempt_no, max_attempts, next_attempt_at, summary,
            error_code, receipt_id, receipt_at, metadata, requested_by, requested_at, legal_hold
       FROM ops_notification_attempts
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND deleted_at IS NULL`,
    [tenantId, attemptId],
  );
  return result.rows[0] ?? null;
}

async function recordOpsNotificationCallbackDelivery(
  client: PoolClient,
  tenantId: string,
  attempt: OpsNotificationAttemptRow,
  input: OpsNotificationCallbackInput,
): Promise<OpsNotificationDelivery> {
  if (attempt.status !== "sent") {
    throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "ops_notification_callback_attempt_not_sent" });
  }
  const errorCode = input.status === "failed" ? input.errorCode : null;
  if (input.status === "failed" && errorCode === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "error_code_required_for_failed_delivery" });
  }
  const receiptAt = new Date();
  const metadata = {
    ...input.metadata,
    notification_attempt_id: attempt.id,
    callback_received: true,
  };
  const result = await client.query<OpsNotificationDeliveryRow>(
    `INSERT INTO ops_notification_deliveries (
       id, tenant_id, alert_id, detected_at, source, subject_type, subject_id,
       channel, provider_alias, status, receipt_id, receipt_at,
       endpoint_secret_ref, credential_secret_ref, callback_signature_secret_ref, route_policy_ref,
       recipient_group_ref, attempt_no, summary, error_code, metadata, recorded_by, retention_until, legal_hold
     )
     VALUES (
       $1::uuid,$2::uuid,$3,$4::timestamptz,$5,$6,$7,
       $8,$9,$10,$11,$12::timestamptz,
       $13,NULL,$14,$15,
       $16,$17,$18,$19,$20::jsonb,$21,$22::timestamptz,$23
     )
     ON CONFLICT (tenant_id, alert_id, detected_at, provider_alias, receipt_id)
       WHERE receipt_id IS NOT NULL AND deleted_at IS NULL
       DO UPDATE
          SET recorded_at = ops_notification_deliveries.recorded_at
        WHERE ops_notification_deliveries.status = EXCLUDED.status
          AND COALESCE(ops_notification_deliveries.error_code, '') = COALESCE(EXCLUDED.error_code, '')
     RETURNING id::text, alert_id, detected_at, source, subject_type, subject_id,
               channel, provider_alias, status, receipt_id, receipt_at,
               endpoint_secret_ref, credential_secret_ref, callback_signature_secret_ref, route_policy_ref,
               recipient_group_ref, attempt_no, summary, error_code, metadata, recorded_by, recorded_at, legal_hold`,
    [
      randomUUID(),
      tenantId,
      attempt.alert_id,
      attempt.detected_at,
      attempt.source,
      attempt.subject_type,
      attempt.subject_id,
      attempt.channel,
      attempt.provider_alias,
      input.status,
      input.receiptId,
      receiptAt.toISOString(),
      attempt.endpoint_secret_ref,
      attempt.callback_signature_secret_ref,
      attempt.route_policy_ref,
      attempt.recipient_group_ref,
      attempt.attempt_no,
      input.status === "delivered"
        ? `Provider delivered webhook notification for ${attempt.alert_id}.`
        : `Provider reported webhook notification failure for ${attempt.alert_id}.`,
      errorCode,
      JSON.stringify(metadata),
      "provider-callback",
      new Date(Date.now() + OPS_NOTIFICATION_DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      input.legalHold || attempt.legal_hold,
    ],
  );
  if (result.rows[0] === undefined) {
    throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "ops_notification_callback_receipt_replay_mismatch" });
  }
  return mapOpsNotificationDelivery(result.rows[0]);
}

export async function readLatestOpsNotificationDelivery(
  client: PoolClient,
  tenantId: string,
): Promise<OpsNotificationDelivery | null> {
  const result = await client.query<OpsNotificationDeliveryRow>(
    `SELECT id::text, alert_id, detected_at, source, subject_type, subject_id,
            channel, provider_alias, status, receipt_id, receipt_at,
            endpoint_secret_ref, credential_secret_ref, callback_signature_secret_ref, route_policy_ref,
            recipient_group_ref, attempt_no, summary, error_code, metadata, recorded_by, recorded_at, legal_hold
       FROM ops_notification_deliveries
      WHERE tenant_id = $1::uuid
        AND deleted_at IS NULL
      ORDER BY receipt_at DESC, recorded_at DESC, id DESC
      LIMIT 1`,
    [tenantId],
  );
  return result.rows[0] === undefined ? null : mapOpsNotificationDelivery(result.rows[0]);
}

function mapOpsNotificationAttempt(row: OpsNotificationAttemptRow): OpsNotificationAttempt {
  return {
    attempt_id: row.id,
    alert_id: row.alert_id,
    detected_at: row.detected_at.toISOString(),
    source: row.source,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    channel: row.channel,
    provider_alias: row.provider_alias,
    status: row.status,
    endpoint_secret_ref: row.endpoint_secret_ref,
    callback_signature_secret_ref: row.callback_signature_secret_ref,
    route_policy_ref: row.route_policy_ref,
    recipient_group_ref: row.recipient_group_ref,
    allowed_hosts: row.allowed_hosts,
    attempt_no: row.attempt_no,
    max_attempts: row.max_attempts,
    next_attempt_at: row.next_attempt_at.toISOString(),
    summary: row.summary,
    error_code: row.error_code,
    receipt_id: row.receipt_id,
    receipt_at: row.receipt_at?.toISOString() ?? null,
    metadata: isRecord(row.metadata) ? row.metadata : {},
    requested_by: row.requested_by,
    requested_at: row.requested_at.toISOString(),
    legal_hold: row.legal_hold,
  };
}

function mapOpsNotificationDelivery(row: OpsNotificationDeliveryRow): OpsNotificationDelivery {
  return {
    delivery_id: row.id,
    alert_id: row.alert_id,
    detected_at: row.detected_at.toISOString(),
    source: row.source,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    channel: row.channel,
    provider_alias: row.provider_alias,
    status: row.status,
    receipt_id: row.receipt_id,
    receipt_at: row.receipt_at.toISOString(),
    endpoint_secret_ref: row.endpoint_secret_ref,
    credential_secret_ref: row.credential_secret_ref,
    callback_signature_secret_ref: row.callback_signature_secret_ref,
    route_policy_ref: row.route_policy_ref,
    recipient_group_ref: row.recipient_group_ref,
    attempt_no: row.attempt_no,
    summary: row.summary,
    error_code: row.error_code,
    metadata: isRecord(row.metadata) ? row.metadata : {},
    recorded_by: row.recorded_by,
    recorded_at: row.recorded_at.toISOString(),
    legal_hold: row.legal_hold,
  };
}

function buildWebhookNotificationPayload(
  tenantId: string,
  alert: ComputedOpsAlert,
  attemptId: string,
  routePolicyRef: string,
  recipientGroupRef: string | null = null,
  callbackSignatureSecretRef: string | null = null,
): Readonly<Record<string, unknown>> {
  return {
    schema: "ops-alert-webhook@1",
    attempt_id: attemptId,
    alert_id: alert.alert_id,
    severity: alert.severity,
    source: alert.source,
    title: alert.title,
    detail: alert.detail,
    subject_type: alert.subject_type,
    subject_id: alert.subject_id,
    recommended_action: alert.recommended_action,
    route: alert.route,
    detected_at: alert.detected_at,
    due_at: alert.due_at ?? null,
    route_policy_ref: routePolicyRef,
    recipient_group_ref: recipientGroupRef,
    delivery_callback: {
      url_path: `/v1/webhooks/ops-alerts/${tenantId}/${attemptId}`,
      signature: callbackSignatureSecretRef === null ? "not_configured" : "hmac-sha256-secret-ref",
    },
  };
}

function consoleDelivery(detectedAt: string): OpsAlertDelivery {
  return {
    channel: "console",
    status: "delivered",
    delivered_at: detectedAt,
    external_delivery: false,
  };
}

function alertGenerationKey(alertId: string, detectedAt: string | Date): string {
  const iso = detectedAt instanceof Date ? detectedAt.toISOString() : new Date(detectedAt).toISOString();
  return `${alertId}\u0000${iso}`;
}

function severityFilter(raw: unknown): OpsAlertSeverity | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string" && Object.prototype.hasOwnProperty.call(SEVERITY_SET, raw)) {
    return raw as OpsAlertSeverity;
  }
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_severity" });
}

function sourceFilter(raw: unknown): OpsAlertSource | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string" && Object.prototype.hasOwnProperty.call(SOURCE_SET, raw)) {
    return raw as OpsAlertSource;
  }
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_source" });
}

function statusFilter(raw: unknown): OpsAlertListStatus {
  if (raw === undefined) return "open";
  if (typeof raw === "string" && Object.prototype.hasOwnProperty.call(STATUS_SET, raw)) {
    return raw as OpsAlertListStatus;
  }
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_status" });
}

function compareAlerts(a: OpsAlertItem, b: OpsAlertItem): number {
  const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (rank !== 0) return rank;
  const detected = Date.parse(b.detected_at) - Date.parse(a.detected_at);
  if (detected !== 0) return detected;
  return a.alert_id.localeCompare(b.alert_id);
}

function assertNoCursor(raw: unknown): void {
  if (raw === undefined) return;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_alert_cursor_not_supported" });
}

function parseAlertId(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 300 || raw.includes("/")) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_alert_id" });
  }
  return raw;
}

function parseUuidNotFound(raw: unknown, field: string): string {
  if (typeof raw === "string" && UUID_RE.test(raw)) return raw;
  throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: `invalid_${field}` });
}

function parseAckRequest(raw: unknown): { comment: string | null } {
  if (raw === undefined || raw === null) return { comment: null };
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_alert_ack_body_expected_object" });
  const keys = Object.keys(raw);
  if (keys.some((key) => key !== "comment")) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_alert_ack_unknown_field" });
  }
  const comment = raw.comment;
  if (comment === undefined || comment === null || comment === "") return { comment: null };
  if (typeof comment !== "string" || comment.length > 1000) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_comment" });
  }
  return { comment };
}

function parseOpsNotificationCallbackRequest(raw: unknown): OpsNotificationCallbackInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_notification_callback_body_expected_object" });
  const allowed = new Set(["receipt_id", "status", "error_code", "metadata", "legal_hold"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_notification_callback_unknown_field", field: key });
    }
  }
  const receiptId = parseSafeDeliveryString(raw.receipt_id, "receipt_id", 1, 200);
  const status = parseOpsNotificationCallbackStatus(raw.status);
  const errorCode = raw.error_code === undefined || raw.error_code === null || raw.error_code === ""
    ? null
    : parseSafeDeliveryString(raw.error_code, "error_code", 1, 120);
  if (status === "failed" && errorCode === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "error_code_required_for_failed_delivery" });
  }
  if (status === "delivered" && errorCode !== null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "error_code_for_delivered_callback_forbidden" });
  }
  const metadata = parseDeliveryMetadata(raw.metadata);
  const legalHold = raw.legal_hold === undefined ? false : parseDeliveryBoolean(raw.legal_hold, "legal_hold");
  return { receiptId, status, errorCode, metadata, legalHold };
}

function parseOpsNotificationCallbackStatus(raw: unknown): "delivered" | "failed" {
  if (raw === "delivered" || raw === "failed") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_ops_notification_callback_status" });
}

function parseOpsNotificationCallbackHeaders(headers: Record<string, unknown>): OpsNotificationCallbackHeaders {
  const eventId = requireOpsNotificationCallbackHeader(headers["x-rpa-ops-notification-event-id"], "x-rpa-ops-notification-event-id");
  if (!OPS_NOTIFICATION_CALLBACK_EVENT_ID_RE.test(eventId)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_ops_notification_callback_event_id" });
  }
  const timestamp = requireOpsNotificationCallbackHeader(headers["x-rpa-ops-notification-timestamp"], "x-rpa-ops-notification-timestamp");
  parseOpsNotificationCallbackTimestamp(timestamp);
  const signature = requireOpsNotificationCallbackHeader(headers["x-rpa-ops-notification-signature"], "x-rpa-ops-notification-signature");
  return { eventId, timestamp, signature };
}

function parseOpsNotificationCallbackTimestamp(value: string): void {
  if (!/^\d{10,13}$/.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_ops_notification_callback_timestamp" });
  }
  const numeric = Number(value);
  const millis = value.length === 13 ? numeric : numeric * 1000;
  const parsed = new Date(millis);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_ops_notification_callback_timestamp" });
  }
  if (Math.abs(Date.now() - parsed.getTime()) > OPS_NOTIFICATION_CALLBACK_TIMESTAMP_SKEW_MS) {
    throw new ApiResponseError("UNAUTHENTICATED", { reason: "ops_notification_callback_timestamp_outside_window" });
  }
}

function requireOpsNotificationCallbackHeader(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_ops_notification_callback_header", header: name });
}

function opsNotificationCallbackPrincipal(tenantId: string): AuthenticatedPrincipal {
  return {
    subjectId: "api:ops-notification-callback" as PrincipalId,
    tenantId: tenantId as TenantId,
    roles: [],
    source: "jwt",
    claims: { runtime_identity: "api" },
  };
}

function parseNotificationWebhookSendRequest(raw: unknown): OpsNotificationWebhookSendInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_notification_send_body_expected_object" });
  const allowed = new Set([
    "provider_alias",
    "endpoint_secret_ref",
    "callback_signature_secret_ref",
    "route_policy_ref",
    "recipient_group_ref",
    "allowed_hosts",
    "summary",
    "metadata",
    "legal_hold",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_notification_send_unknown_field", field: key });
    }
  }
  const providerAlias = raw.provider_alias === undefined || raw.provider_alias === null || raw.provider_alias === ""
    ? "webhook-primary"
    : parseSafeDeliveryString(raw.provider_alias, "provider_alias", 1, 120);
  const endpointSecretRef = parseSecretRef(raw.endpoint_secret_ref, "endpoint_secret_ref");
  const callbackSignatureSecretRef = raw.callback_signature_secret_ref === undefined || raw.callback_signature_secret_ref === null || raw.callback_signature_secret_ref === ""
    ? null
    : parseSecretRef(raw.callback_signature_secret_ref, "callback_signature_secret_ref");
  const routePolicyRef = parseSafeDeliveryString(raw.route_policy_ref, "route_policy_ref", 1, 200);
  const recipientGroupRef = raw.recipient_group_ref === undefined || raw.recipient_group_ref === null || raw.recipient_group_ref === ""
    ? null
    : parseSafeDeliveryString(raw.recipient_group_ref, "recipient_group_ref", 1, 200);
  const allowedHosts = parseAllowedWebhookHosts(raw.allowed_hosts);
  const summary = raw.summary === undefined || raw.summary === null || raw.summary === ""
    ? null
    : parseSafeDeliveryString(raw.summary, "summary", 1, 1000);
  const metadata = parseDeliveryMetadata(raw.metadata);
  const legalHold = raw.legal_hold === undefined ? false : parseDeliveryBoolean(raw.legal_hold, "legal_hold");
  return { providerAlias, endpointSecretRef, callbackSignatureSecretRef, routePolicyRef, recipientGroupRef, allowedHosts, summary, metadata, legalHold };
}

function parseNotificationDeliveryRequest(raw: unknown): OpsNotificationDeliveryInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_notification_delivery_body_expected_object" });
  const allowed = new Set([
    "channel",
    "provider_alias",
    "status",
    "receipt_id",
    "receipt_at",
    "endpoint_secret_ref",
    "credential_secret_ref",
    "callback_signature_secret_ref",
    "route_policy_ref",
    "recipient_group_ref",
    "attempt_no",
    "summary",
    "error_code",
    "metadata",
    "legal_hold",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_notification_delivery_unknown_field", field: key });
    }
  }
  const channel = parseNotificationChannel(raw.channel);
  const providerAlias = parseSafeDeliveryString(raw.provider_alias, "provider_alias", 1, 120);
  const status = parseNotificationDeliveryStatus(raw.status);
  const receiptId = raw.receipt_id === undefined || raw.receipt_id === null || raw.receipt_id === ""
    ? null
    : parseSafeDeliveryString(raw.receipt_id, "receipt_id", 1, 200);
  const receiptAt = parseDeliveryIsoDate(raw.receipt_at, "receipt_at");
  if (receiptAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "receipt_at_in_future" });
  }
  const endpointSecretRef = parseSecretRef(raw.endpoint_secret_ref, "endpoint_secret_ref");
  const credentialSecretRef = raw.credential_secret_ref === undefined || raw.credential_secret_ref === null || raw.credential_secret_ref === ""
    ? null
    : parseSecretRef(raw.credential_secret_ref, "credential_secret_ref");
  const callbackSignatureSecretRef = raw.callback_signature_secret_ref === undefined || raw.callback_signature_secret_ref === null || raw.callback_signature_secret_ref === ""
    ? null
    : parseSecretRef(raw.callback_signature_secret_ref, "callback_signature_secret_ref");
  const routePolicyRef = raw.route_policy_ref === undefined || raw.route_policy_ref === null || raw.route_policy_ref === ""
    ? null
    : parseSafeDeliveryString(raw.route_policy_ref, "route_policy_ref", 1, 200);
  const recipientGroupRef = raw.recipient_group_ref === undefined || raw.recipient_group_ref === null || raw.recipient_group_ref === ""
    ? null
    : parseSafeDeliveryString(raw.recipient_group_ref, "recipient_group_ref", 1, 200);
  const attemptNo = raw.attempt_no === undefined ? 1 : parsePositiveInteger(raw.attempt_no, "attempt_no");
  const summary = parseSafeDeliveryString(raw.summary, "summary", 1, 1000);
  const errorCode = raw.error_code === undefined || raw.error_code === null || raw.error_code === ""
    ? null
    : parseSafeDeliveryString(raw.error_code, "error_code", 1, 120);
  if (status === "failed" && errorCode === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "error_code_required_for_failed_delivery" });
  }
  if (status !== "failed" && receiptId === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "receipt_id_required_for_successful_delivery" });
  }
  const metadata = parseDeliveryMetadata(raw.metadata);
  const legalHold = raw.legal_hold === undefined ? false : parseDeliveryBoolean(raw.legal_hold, "legal_hold");
  return {
    channel,
    providerAlias,
    status,
    receiptId,
    receiptAt,
    endpointSecretRef,
    credentialSecretRef,
    callbackSignatureSecretRef,
    routePolicyRef,
    recipientGroupRef,
    attemptNo,
    summary,
    errorCode,
    metadata,
    legalHold,
  };
}

function parseAllowedWebhookHosts(raw: unknown): readonly string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_allowed_hosts" });
  }
  const hosts = raw.map((item) => parseAllowedWebhookHost(item));
  return [...new Set(hosts)];
}

function parseAllowedWebhookHost(raw: unknown): string {
  const host = parseSafeDeliveryString(raw, "allowed_hosts", 1, 253).toLowerCase();
  if (host.includes("://") || host.includes("/") || host.includes("?") || host.includes("#")) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "allowed_host_must_not_be_url" });
  }
  if (host === "localhost" || host.endsWith(".localhost") || /^[0-9.]+$/.test(host) || host.includes(":")) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "allowed_host_public_dns_required" });
  }
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  const hostRe = new RegExp(`^(?:${label}\\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$`);
  if (!hostRe.test(host)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_allowed_host" });
  }
  return host;
}

function parseNotificationChannel(raw: unknown): OpsNotificationChannel {
  if (raw === "teams" || raw === "slack" || raw === "email" || raw === "webhook") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_notification_channel" });
}

function parseNotificationDeliveryStatus(raw: unknown): OpsNotificationDeliveryStatus {
  if (raw === "sent" || raw === "delivered" || raw === "failed") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_notification_delivery_status" });
}

function parseDeliveryIsoDate(raw: unknown, field: string): Date {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_iso_datetime", field });
  }
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_iso_datetime", field });
  }
  return date;
}

function parsePositiveInteger(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 1000) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  }
  return raw;
}

function parseSecretRef(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !raw.startsWith("secret://") || raw.length <= "secret://".length || raw.length > 500) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  }
  assertSafeDeliveryString(raw, field);
  return raw;
}

function parseSafeDeliveryString(raw: unknown, field: string, min: number, max: number): string {
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  const value = raw.trim();
  if (value.length < min || value.length > max) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  assertSafeDeliveryString(value, field);
  return value;
}

function parseDeliveryMetadata(raw: unknown): Readonly<Record<string, unknown>> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_must_be_object" });
  if (JSON.stringify(raw).length > 4000) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_too_large" });
  assertSafeDeliveryMetadata(raw, "metadata");
  return raw;
}

function parseDeliveryBoolean(raw: unknown, field: string): boolean {
  if (typeof raw === "boolean") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function assertSafeDeliveryMetadata(value: unknown, path: string): void {
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value === "string") {
    assertSafeDeliveryString(value, path);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertSafeDeliveryMetadata(item, `${path}.${index}`);
    return;
  }
  if (!isRecord(value)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_value_not_json", path });
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || forbiddenDeliveryMetadataKey(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_secret_or_endpoint_key_forbidden", path: `${path}.${key}` });
    }
    assertSafeDeliveryMetadata(item, `${path}.${key}`);
  }
}

function forbiddenDeliveryMetadataKey(key: string): boolean {
  return /(^|[_\-.])(secret|token|password|credential|authorization|cookie|webhook_url|endpoint_url|url|dsn|smtp)([_\-.]|$)/i.test(key);
}

function assertSafeDeliveryString(value: string, field: string): void {
  if (/https?:\/\//i.test(value) || /hooks\.slack\.com/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "raw_endpoint_url_forbidden", field });
  }
  if (/\bbearer\s+[a-z0-9._~+/=-]{8,}/i.test(value) || /\b(token|password|secret)=/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_material_forbidden", field });
  }
}

function failureCode(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const code = (value as Record<string, unknown>).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}
