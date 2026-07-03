import { redactedErrorCode } from "./redacted-error-code";
import { randomUUID } from "node:crypto";

import type pg from "pg";

import type {
  OpsNotificationDeliveryDecision,
  OpsNotificationDeliveryPort,
  RuntimeWorkerJob,
} from "../../../ts/runtime-contract";
import type { SecretRef } from "../../../ts/core-types";
import type { CorrelationId, TenantId } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import type { RuntimeJobEnqueuePort } from "./executor-ports";

type OpsNotificationAttemptStatus = "pending" | "sending" | "sent" | "failed" | "dead_letter";

interface OpsNotificationAttemptRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly alert_id: string;
  readonly detected_at: Date;
  readonly source: string;
  readonly subject_type: string;
  readonly subject_id: string | null;
  readonly channel: "webhook";
  readonly provider_alias: string;
  readonly status: OpsNotificationAttemptStatus;
  readonly endpoint_secret_ref: string;
  readonly credential_secret_ref: string | null;
  readonly callback_signature_secret_ref: string | null;
  readonly route_policy_ref: string;
  readonly recipient_group_ref: string | null;
  readonly allowed_hosts: readonly string[];
  readonly attempt_no: number;
  readonly max_attempts: number;
  readonly payload: unknown;
  readonly summary: string;
  readonly metadata: unknown;
  readonly requested_by: string;
  readonly retention_until: Date;
  readonly legal_hold: boolean;
}

export interface OpsNotificationDeliveryPolicy {
  readonly source: "ops-defaults.md#ops.notification.delivery";
  readonly maxAttempts: number;
}

export interface OpsNotificationDeliveryDeps {
  readonly pool: pg.Pool;
  readonly port: OpsNotificationDeliveryPort;
  readonly policy: OpsNotificationDeliveryPolicy;
  readonly retryAfterMs: number;
  readonly enqueuer: RuntimeJobEnqueuePort;
}

export type OpsNotificationAttemptOutcome =
  | { readonly status: "sent"; readonly emitted?: undefined }
  | { readonly status: "failed"; readonly nextAttemptId: string }
  | { readonly status: "dead_letter"; readonly emitted?: undefined }
  | { readonly status: "already_completed"; readonly emitted?: undefined };

export async function deliverOpsNotificationAttempt(
  deps: OpsNotificationDeliveryDeps,
  input: { readonly tenantId: string; readonly attemptId: string; readonly correlationId: string },
): Promise<OpsNotificationAttemptOutcome> {
  const leaseToken = randomUUID();
  const attempt = await claimPendingAttempt(deps.pool, input.tenantId, input.attemptId, leaseToken, deps.policy.maxAttempts);
  if (attempt === null) return { status: "already_completed" };
  if (!isRecord(attempt.payload)) {
    const decision: OpsNotificationDeliveryDecision = { kind: "permanent_failed", reason: "payload_not_object" };
    await completeFailedAttempt(deps, input, attempt, leaseToken, decision, true);
    return { status: "dead_letter" };
  }

  const decision = await deps.port.deliver({
    tenantId: input.tenantId as TenantId,
    correlationId: input.correlationId as CorrelationId,
    attemptId: attempt.id,
    alertId: attempt.alert_id,
    endpointSecretRef: attempt.endpoint_secret_ref as SecretRef,
    routePolicyRef: attempt.route_policy_ref,
    recipientGroupRef: attempt.recipient_group_ref,
    allowedHosts: attempt.allowed_hosts,
    payload: attempt.payload,
    attemptNo: attempt.attempt_no,
  });

  if (decision.kind === "sent") {
    await completeSentAttempt(deps.pool, input.tenantId, attempt, leaseToken, decision);
    return { status: "sent" };
  }

  const finalFailure = decision.kind === "permanent_failed" || attempt.attempt_no >= attempt.max_attempts;
  if (finalFailure) {
    await completeFailedAttempt(deps, input, attempt, leaseToken, decision, true);
    return { status: "dead_letter" };
  }
  const nextAttemptId = await completeFailedAttempt(deps, input, attempt, leaseToken, decision, false);
  return { status: "failed", nextAttemptId };
}

async function claimPendingAttempt(
  pool: pg.Pool,
  tenantId: string,
  attemptId: string,
  leaseToken: string,
  configuredMaxAttempts: number,
): Promise<OpsNotificationAttemptRow | null> {
  return withTenantTx(pool, tenantId, async (client) => {
    const result = await client.query<OpsNotificationAttemptRow>(
      `UPDATE ops_notification_attempts
          SET status='sending',
              lease_token=$3::uuid,
              started_at=now()
        WHERE tenant_id=$1::uuid
          AND id=$2::uuid
          AND status='pending'
          AND next_attempt_at <= now()
          AND deleted_at IS NULL
        RETURNING id::text, tenant_id::text, alert_id, detected_at, source, subject_type, subject_id,
                  channel, provider_alias, status, endpoint_secret_ref, credential_secret_ref, callback_signature_secret_ref, route_policy_ref,
                  recipient_group_ref, allowed_hosts, attempt_no, LEAST(max_attempts, $4::int) AS max_attempts,
                  payload, summary, metadata, requested_by, retention_until, legal_hold`,
      [tenantId, attemptId, leaseToken, configuredMaxAttempts],
    );
    return result.rows[0] ?? null;
  });
}

async function completeSentAttempt(
  pool: pg.Pool,
  tenantId: string,
  attempt: OpsNotificationAttemptRow,
  leaseToken: string,
  decision: Extract<OpsNotificationDeliveryDecision, { kind: "sent" }>,
): Promise<void> {
  const receiptAt = new Date();
  await withTenantTx(pool, tenantId, async (client) => {
    const updated = await client.query(
      `UPDATE ops_notification_attempts
          SET status='sent',
              receipt_id=$4,
              receipt_at=$5::timestamptz,
              completed_at=now(),
              error_code=NULL
        WHERE tenant_id=$1::uuid
          AND id=$2::uuid
          AND lease_token=$3::uuid
          AND status='sending'`,
      [tenantId, attempt.id, leaseToken, decision.receiptId, receiptAt.toISOString()],
    );
    if (updated.rowCount !== 1) throw new Error(`ops notification sent CAS expected 1 row, got ${updated.rowCount ?? 0}`);
    await insertDeliveryReceipt(client, tenantId, attempt, {
      status: "sent",
      receiptId: decision.receiptId,
      receiptAt,
      errorCode: null,
      providerStatusCode: decision.providerStatusCode,
    });
  });
}

async function completeFailedAttempt(
  deps: OpsNotificationDeliveryDeps,
  input: { readonly tenantId: string; readonly attemptId: string; readonly correlationId: string },
  attempt: OpsNotificationAttemptRow,
  leaseToken: string,
  decision: Exclude<OpsNotificationDeliveryDecision, { kind: "sent" }>,
  finalFailure: boolean,
): Promise<string> {
  const errorCode = redactedErrorCode(decision.reason, "OPS_NOTIFICATION_FAILED");
  const receiptAt = new Date();
  return withTenantTx(deps.pool, input.tenantId, async (client) => {
    const status: OpsNotificationAttemptStatus = finalFailure ? "dead_letter" : "failed";
    const updated = await client.query(
      `UPDATE ops_notification_attempts
          SET status=$4,
              error_code=$5,
              completed_at=now()
        WHERE tenant_id=$1::uuid
          AND id=$2::uuid
          AND lease_token=$3::uuid
          AND status='sending'`,
      [input.tenantId, attempt.id, leaseToken, status, errorCode],
    );
    if (updated.rowCount !== 1) throw new Error(`ops notification failure CAS expected 1 row, got ${updated.rowCount ?? 0}`);
    await insertDeliveryReceipt(client, input.tenantId, attempt, {
      status: "failed",
      receiptId: null,
      receiptAt,
      errorCode,
      providerStatusCode: decision.providerStatusCode ?? null,
    });

    if (finalFailure) return attempt.id;
    const nextAttemptId = randomUUID();
    await client.query(
       `INSERT INTO ops_notification_attempts (
         id, tenant_id, alert_id, detected_at, source, subject_type, subject_id,
         channel, provider_alias, status, endpoint_secret_ref, credential_secret_ref, callback_signature_secret_ref,
         route_policy_ref, recipient_group_ref, allowed_hosts, attempt_no, max_attempts, next_attempt_at,
         payload, summary, metadata, requested_by, retention_until, legal_hold
       )
       VALUES (
         $1::uuid,$2::uuid,$3,$4::timestamptz,$5,$6,$7,
         $8,$9,'pending',$10,$11,$12,
         $13,$14,$15::text[],$16,$17,now() + ($18::double precision * interval '1 millisecond'),
         $19::jsonb,$20,$21::jsonb,$22,$23::timestamptz,$24
       )`,
      [
        nextAttemptId,
        input.tenantId,
        attempt.alert_id,
        attempt.detected_at.toISOString(),
        attempt.source,
        attempt.subject_type,
        attempt.subject_id,
        attempt.channel,
        attempt.provider_alias,
        attempt.endpoint_secret_ref,
        attempt.credential_secret_ref,
        attempt.callback_signature_secret_ref,
        attempt.route_policy_ref,
        attempt.recipient_group_ref,
        attempt.allowed_hosts,
        attempt.attempt_no + 1,
        attempt.max_attempts,
        deps.retryAfterMs,
        JSON.stringify(attempt.payload),
        attempt.summary,
        JSON.stringify(isRecord(attempt.metadata) ? attempt.metadata : {}),
        attempt.requested_by,
        attempt.retention_until.toISOString(),
        attempt.legal_hold,
      ],
    );
    const job: RuntimeWorkerJob = {
      kind: "ops_notification_send",
      tenantId: input.tenantId as TenantId,
      correlationId: input.correlationId as CorrelationId,
      opsNotification: { attemptId: nextAttemptId },
    };
    await deps.enqueuer.enqueueRuntimeJob(client, job, deps.retryAfterMs);
    return nextAttemptId;
  });
}

async function insertDeliveryReceipt(
  client: pg.PoolClient,
  tenantId: string,
  attempt: OpsNotificationAttemptRow,
  input: {
    readonly status: "sent" | "failed";
    readonly receiptId: string | null;
    readonly receiptAt: Date;
    readonly errorCode: string | null;
    readonly providerStatusCode: number | null;
  },
): Promise<void> {
  const metadata = {
    ...(isRecord(attempt.metadata) ? attempt.metadata : {}),
    notification_attempt_id: attempt.id,
    provider_status_code: input.providerStatusCode,
  };
  await client.query(
    `INSERT INTO ops_notification_deliveries (
       id, tenant_id, alert_id, detected_at, source, subject_type, subject_id,
       channel, provider_alias, status, receipt_id, receipt_at,
       endpoint_secret_ref, credential_secret_ref, callback_signature_secret_ref, route_policy_ref,
       recipient_group_ref, attempt_no, summary, error_code, metadata, recorded_by, retention_until, legal_hold
     )
     VALUES (
       $1::uuid,$2::uuid,$3,$4::timestamptz,$5,$6,$7,
       $8,$9,$10,$11,$12::timestamptz,
       $13,$14,$15,$16,
       $17,$18,$19,$20,$21::jsonb,$22,$23::timestamptz,$24
     )`,
    [
      randomUUID(),
      tenantId,
      attempt.alert_id,
      attempt.detected_at.toISOString(),
      attempt.source,
      attempt.subject_type,
      attempt.subject_id,
      attempt.channel,
      attempt.provider_alias,
      input.status,
      input.receiptId,
      input.receiptAt.toISOString(),
      attempt.endpoint_secret_ref,
      attempt.credential_secret_ref,
      attempt.callback_signature_secret_ref,
      attempt.route_policy_ref,
      attempt.recipient_group_ref,
      attempt.attempt_no,
      attempt.summary,
      input.errorCode,
      JSON.stringify(metadata),
      "notification-sender",
      attempt.retention_until.toISOString(),
      attempt.legal_hold,
    ],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
