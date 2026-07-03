/**
 * /v1/ops-alerts 외부 전달 표면 — 전달 이력 조회/수동 기록, webhook 발송 attempt 인큐,
 * provider 콜백(HMAC 서명 검증) 수신. 원장은 metadata-only(원문 endpoint/secret 금지 — ops-alerts-parse 강제).
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import type { SecretRef } from "../../../ts/core-types";
import type { AuthenticatedPrincipal, PrincipalId, TenantId } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { ApiResponseError } from "../runtime/errors";
import { readComputedOpsAlertById } from "../runtime/ops-alerts/compute";
import {
  OPS_NOTIFICATION_DELIVERY_RETENTION_DAYS,
  insertOpsNotificationAttempt,
  type OpsNotificationAttemptRow,
} from "../runtime/ops-alerts/notification-attempts";
import type { ComputedOpsAlert, OpsAlertSource, OpsAlertSubjectType } from "../runtime/ops-alerts/types";
import { isRecord, runIdempotentCommand } from "./command";
import { parseLimit } from "./list-query";
import {
  assertNoCursor,
  parseAlertId,
  parseNotificationDeliveryRequest,
  parseNotificationWebhookSendRequest,
  parseOpsNotificationCallbackHeaders,
  parseOpsNotificationCallbackRequest,
  parseUuidNotFound,
  type OpsNotificationCallbackInput,
  type OpsNotificationChannel,
  type OpsNotificationDeliveryInput,
  type OpsNotificationDeliveryStatus,
} from "./ops-alerts-parse";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";
import { verifyWebhookSignature, webhookSigningPayload } from "./webhook-trigger-auth";

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

export function registerOpsAlertDeliveryRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
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

function opsNotificationCallbackPrincipal(tenantId: string): AuthenticatedPrincipal {
  return {
    subjectId: "api:ops-notification-callback" as PrincipalId,
    tenantId: tenantId as TenantId,
    roles: [],
    source: "jwt",
    claims: { runtime_identity: "api" },
  };
}
