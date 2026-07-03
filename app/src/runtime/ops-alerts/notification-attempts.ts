/**
 * 운영 알림 webhook 전달 attempt 영속화 — api 수동 send-webhook 라우트와 worker 무인 자동 발화
 * producer(ops-notification-fire)가 공용한다. payload 에는 SecretRef 참조만 담는다(원문 endpoint/secret 금지).
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import {
  OPS_NOTIFICATION_DELIVERY_MAX_ATTEMPTS_DEFAULT,
} from "../../../../ts/runtime-contract";
import type {
  ComputedOpsAlert,
  OpsAlertSource,
  OpsAlertSubjectType,
  OpsNotificationWebhookSendInput,
} from "./types";

export const OPS_NOTIFICATION_DELIVERY_RETENTION_DAYS = 365;

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

export interface OpsNotificationAttemptRow {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
