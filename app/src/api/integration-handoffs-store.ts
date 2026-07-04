import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { ApiResponseError } from "../runtime/errors";

export type IntegrationHandoffStatus = "accepted" | "deferred" | "completed" | "failed" | "cancelled";
export type IntegrationHandoffReceiptStatus = Exclude<IntegrationHandoffStatus, "deferred">;
export type IntegrationHandoffDispatchAttemptStatus = "pending" | "sending" | "accepted" | "failed" | "dead_letter";

export interface IntegrationHandoff {
  readonly handoff_id: string;
  readonly provider_alias: string;
  readonly job_ref: string;
  readonly payload_ref: string;
  readonly callback_url_secret_ref: string | null;
  readonly callback_signature_secret_ref: string | null;
  readonly external_job_id: string | null;
  readonly status: IntegrationHandoffStatus;
  readonly latest_receipt_id: string | null;
  readonly error_code: string | null;
  readonly requested_by: string;
  readonly request_idempotency_key: string;
  readonly requested_at: string;
  readonly updated_at: string;
  readonly callback_received_at: string | null;
  readonly legal_hold: boolean;
}

export interface IntegrationHandoffRow {
  readonly id: string;
  readonly provider_alias: string;
  readonly job_ref: string;
  readonly payload_ref: string;
  readonly callback_url_secret_ref: string | null;
  readonly callback_signature_secret_ref: string | null;
  readonly request_idempotency_key: string;
  readonly status: IntegrationHandoffStatus;
  readonly external_job_id: string | null;
  readonly latest_receipt_id: string | null;
  readonly latest_error_code: string | null;
  readonly requested_by: string;
  readonly callback_received_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly cursor_at: string;
  readonly legal_hold: boolean;
}

export interface IntegrationHandoffCreateInput {
  readonly providerAlias: string;
  readonly jobRef: string;
  readonly payloadRef: string;
  readonly callbackUrlSecretRef: string | null;
  readonly callbackSignatureSecretRef: string | null;
  readonly legalHold: boolean;
}

export interface IntegrationHandoffCallbackInput {
  readonly externalJobId: string;
  readonly status: IntegrationHandoffReceiptStatus;
  readonly receiptId: string;
  readonly errorCode: string | null;
  readonly legalHold: boolean;
}

export interface IntegrationHandoffDispatchInput {
  readonly endpointSecretRef: string;
  readonly allowedHosts: readonly string[];
  readonly maxAttempts: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly legalHold: boolean;
}

export interface IntegrationHandoffDispatchAttempt {
  readonly attempt_id: string;
  readonly handoff_id: string;
  readonly provider_alias: string;
  readonly status: IntegrationHandoffDispatchAttemptStatus;
  readonly endpoint_secret_ref: string;
  readonly allowed_hosts: readonly string[];
  readonly request_idempotency_key: string;
  readonly attempt_no: number;
  readonly max_attempts: number;
  readonly external_job_id: string | null;
  readonly receipt_id: string | null;
  readonly error_code: string | null;
  readonly requested_by: string;
  readonly requested_at: string;
  readonly updated_at: string;
  readonly legal_hold: boolean;
}

export interface IntegrationHandoffDispatchAttemptRow {
  readonly id: string;
  readonly handoff_id: string;
  readonly provider_alias: string;
  readonly status: IntegrationHandoffDispatchAttemptStatus;
  readonly endpoint_secret_ref: string;
  readonly allowed_hosts: readonly string[];
  readonly request_idempotency_key: string;
  readonly attempt_no: number;
  readonly max_attempts: number;
  readonly external_job_id: string | null;
  readonly receipt_id: string | null;
  readonly error_code: string | null;
  readonly requested_by: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly legal_hold: boolean;
}

export interface IntegrationHandoffAuthRow {
  readonly id: string;
  readonly provider_alias: string;
  readonly callback_signature_secret_ref: string | null;
}

interface IntegrationHandoffReceiptRow {
  readonly external_job_id: string;
  readonly status: IntegrationHandoffReceiptStatus;
  readonly receipt_id: string;
  readonly error_code: string | null;
  readonly legal_hold: boolean;
}

export async function listIntegrationHandoffs(
  client: PoolClient,
  tenantId: string,
  limit: number,
  cursor: { readonly createdAt: string; readonly id: string } | null,
  status: IntegrationHandoffStatus | undefined,
  providerAlias: string | undefined,
): Promise<IntegrationHandoffRow[]> {
  const values: unknown[] = [tenantId];
  const where = ["tenant_id = $1::uuid"];
  if (status !== undefined) {
    values.push(status);
    where.push(`status = $${values.length}`);
  }
  if (providerAlias !== undefined) {
    values.push(providerAlias);
    where.push(`provider_alias = $${values.length}`);
  }
  if (cursor !== null) {
    values.push(cursor.createdAt, cursor.id);
    where.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
  }
  values.push(limit + 1);
  const result = await client.query<IntegrationHandoffRow>(
    `SELECT id, provider_alias, job_ref, payload_ref, callback_url_secret_ref, callback_signature_secret_ref, request_idempotency_key,
            status, external_job_id, latest_receipt_id, latest_error_code, requested_by,
            callback_received_at, created_at, created_at::text AS cursor_at, updated_at, legal_hold
       FROM integration_handoffs
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT $${values.length}`,
    values,
  );
  return result.rows;
}

export async function insertIntegrationHandoff(
  client: PoolClient,
  tenantId: string,
  requestedBy: string,
  requestIdempotencyKey: string,
  input: IntegrationHandoffCreateInput,
): Promise<IntegrationHandoff> {
  const result = await client.query<IntegrationHandoffRow>(
    `INSERT INTO integration_handoffs
       (id, tenant_id, provider_alias, job_ref, payload_ref, callback_url_secret_ref, callback_signature_secret_ref,
        request_idempotency_key, status, requested_by, legal_hold)
     VALUES
       ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, 'deferred', $9, $10)
     ON CONFLICT (tenant_id, request_idempotency_key) DO UPDATE
        SET updated_at = integration_handoffs.updated_at
     RETURNING id, provider_alias, job_ref, payload_ref, callback_url_secret_ref, callback_signature_secret_ref, request_idempotency_key,
               status, external_job_id, latest_receipt_id, latest_error_code, requested_by,
               callback_received_at, created_at, created_at::text AS cursor_at, updated_at, legal_hold`,
    [
      randomUUID(),
      tenantId,
      input.providerAlias,
      input.jobRef,
      input.payloadRef,
      input.callbackUrlSecretRef,
      input.callbackSignatureSecretRef,
      requestIdempotencyKey,
      requestedBy,
      input.legalHold,
    ],
  );
  return mapHandoff(requireOne(result.rows[0], "integration_handoff_missing_after_insert"));
}

export async function insertIntegrationHandoffDispatchAttempt(
  client: PoolClient,
  tenantId: string,
  handoff: IntegrationHandoffRow,
  requestedBy: string,
  requestIdempotencyKey: string,
  input: IntegrationHandoffDispatchInput,
): Promise<IntegrationHandoffDispatchAttempt> {
  const payload = buildDispatchPayload(tenantId, handoff, input);
  const result = await client.query<IntegrationHandoffDispatchAttemptRow>(
    `INSERT INTO integration_handoff_dispatch_attempts
       (id, tenant_id, handoff_id, provider_alias, endpoint_secret_ref, allowed_hosts,
        request_idempotency_key, attempt_no, max_attempts, payload, requested_by, legal_hold)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::text[],
        $7, 1, $8, $9::jsonb, $10, $11)
     ON CONFLICT (tenant_id, handoff_id, request_idempotency_key, attempt_no) DO UPDATE
        SET updated_at = integration_handoff_dispatch_attempts.updated_at
     RETURNING id, handoff_id, provider_alias, status, endpoint_secret_ref, allowed_hosts,
               request_idempotency_key, attempt_no, max_attempts, external_job_id, receipt_id,
               error_code, requested_by, created_at, updated_at, legal_hold`,
    [
      randomUUID(),
      tenantId,
      handoff.id,
      handoff.provider_alias,
      input.endpointSecretRef,
      input.allowedHosts,
      requestIdempotencyKey,
      input.maxAttempts,
      JSON.stringify(payload),
      requestedBy,
      input.legalHold,
    ],
  );
  return mapDispatchAttempt(requireOne(result.rows[0], "integration_handoff_dispatch_attempt_missing_after_insert"));
}

export async function recordIntegrationHandoffReceipt(
  client: PoolClient,
  tenantId: string,
  handoffId: string,
  receivedBy: string,
  input: IntegrationHandoffCallbackInput,
  verifiedSignatureSecretRef?: string,
): Promise<IntegrationHandoff> {
  const locked = await client.query<{ id: string; callback_signature_secret_ref: string | null }>(
    `SELECT id, callback_signature_secret_ref
       FROM integration_handoffs
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
      FOR UPDATE`,
    [tenantId, handoffId],
  );
  if (locked.rows[0] === undefined) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "integration_handoff_not_found" });
  }
  if (verifiedSignatureSecretRef !== undefined && locked.rows[0].callback_signature_secret_ref !== verifiedSignatureSecretRef) {
    throw new ApiResponseError("UNAUTHENTICATED", { reason: "integration_handoff_signature_secret_rotated" });
  }

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO integration_handoff_receipts
       (id, tenant_id, handoff_id, external_job_id, status, receipt_id, error_code, received_by, legal_hold)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (tenant_id, handoff_id, receipt_id) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      tenantId,
      handoffId,
      input.externalJobId,
      input.status,
      input.receiptId,
      input.errorCode,
      receivedBy,
      input.legalHold,
    ],
  );
  if (inserted.rows[0] === undefined) {
    const existing = await selectIntegrationHandoffReceipt(client, tenantId, handoffId, input.receiptId);
    if (existing === null) {
      throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "integration_handoff_receipt_missing_after_conflict" });
    }
    assertReceiptReplayMatches(existing, input);
    return mapHandoff(requireOne(await selectIntegrationHandoffRow(client, tenantId, handoffId), "integration_handoff_missing_after_receipt_replay"));
  }

  const updated = await client.query<IntegrationHandoffRow>(
    `UPDATE integration_handoffs
        SET status = $3,
            external_job_id = $4,
            latest_receipt_id = $5,
            latest_error_code = $6,
            callback_received_at = now(),
            updated_at = now(),
            legal_hold = legal_hold OR $7
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
      RETURNING id, provider_alias, job_ref, payload_ref, callback_url_secret_ref, callback_signature_secret_ref, request_idempotency_key,
                status, external_job_id, latest_receipt_id, latest_error_code, requested_by,
                callback_received_at, created_at, created_at::text AS cursor_at, updated_at, legal_hold`,
    [tenantId, handoffId, input.status, input.externalJobId, input.receiptId, input.errorCode, input.legalHold],
  );
  return mapHandoff(requireOne(updated.rows[0], "integration_handoff_missing_after_update"));
}

export async function selectIntegrationHandoffForAuth(
  client: PoolClient,
  handoffId: string,
): Promise<IntegrationHandoffAuthRow | null> {
  const result = await client.query<IntegrationHandoffAuthRow>(
    `SELECT id, provider_alias, callback_signature_secret_ref
       FROM integration_handoffs
      WHERE id = $1::uuid`,
    [handoffId],
  );
  return result.rows[0] ?? null;
}

export async function selectIntegrationHandoffRow(
  client: PoolClient,
  tenantId: string,
  handoffId: string,
): Promise<IntegrationHandoffRow | undefined> {
  const result = await client.query<IntegrationHandoffRow>(
    `SELECT id, provider_alias, job_ref, payload_ref, callback_url_secret_ref, callback_signature_secret_ref,
            request_idempotency_key, status, external_job_id, latest_receipt_id, latest_error_code,
            requested_by, callback_received_at, created_at, created_at::text AS cursor_at, updated_at, legal_hold
       FROM integration_handoffs
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid`,
    [tenantId, handoffId],
  );
  return result.rows[0];
}

async function selectIntegrationHandoffReceipt(
  client: PoolClient,
  tenantId: string,
  handoffId: string,
  receiptId: string,
): Promise<IntegrationHandoffReceiptRow | null> {
  const result = await client.query<IntegrationHandoffReceiptRow>(
    `SELECT external_job_id, status, receipt_id, error_code, legal_hold
       FROM integration_handoff_receipts
      WHERE tenant_id = $1::uuid
        AND handoff_id = $2::uuid
        AND receipt_id = $3`,
    [tenantId, handoffId, receiptId],
  );
  return result.rows[0] ?? null;
}

function assertReceiptReplayMatches(
  existing: IntegrationHandoffReceiptRow,
  input: IntegrationHandoffCallbackInput,
): void {
  const matches = existing.external_job_id === input.externalJobId &&
    existing.status === input.status &&
    existing.receipt_id === input.receiptId &&
    existing.error_code === input.errorCode &&
    existing.legal_hold === input.legalHold;
  if (!matches) {
    throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "integration_handoff_receipt_replay_mismatch" });
  }
}

export function mapHandoff(row: IntegrationHandoffRow): IntegrationHandoff {
  return {
    handoff_id: row.id,
    provider_alias: row.provider_alias,
    job_ref: row.job_ref,
    payload_ref: row.payload_ref,
    callback_url_secret_ref: row.callback_url_secret_ref,
    callback_signature_secret_ref: row.callback_signature_secret_ref,
    external_job_id: row.external_job_id,
    status: row.status,
    latest_receipt_id: row.latest_receipt_id,
    error_code: row.latest_error_code,
    requested_by: row.requested_by,
    request_idempotency_key: row.request_idempotency_key,
    requested_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    callback_received_at: row.callback_received_at?.toISOString() ?? null,
    legal_hold: row.legal_hold,
  };
}

function mapDispatchAttempt(row: IntegrationHandoffDispatchAttemptRow): IntegrationHandoffDispatchAttempt {
  return {
    attempt_id: row.id,
    handoff_id: row.handoff_id,
    provider_alias: row.provider_alias,
    status: row.status,
    endpoint_secret_ref: row.endpoint_secret_ref,
    allowed_hosts: row.allowed_hosts,
    request_idempotency_key: row.request_idempotency_key,
    attempt_no: row.attempt_no,
    max_attempts: row.max_attempts,
    external_job_id: row.external_job_id,
    receipt_id: row.receipt_id,
    error_code: row.error_code,
    requested_by: row.requested_by,
    requested_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    legal_hold: row.legal_hold,
  };
}

export function assertDispatchableHandoff(row: IntegrationHandoffRow): void {
  if (row.status === "deferred" || row.status === "failed") return;
  throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", {
    reason: "integration_handoff_not_dispatchable",
    status: row.status,
  });
}

function buildDispatchPayload(
  tenantId: string,
  handoff: IntegrationHandoffRow,
  input: IntegrationHandoffDispatchInput,
): Readonly<Record<string, unknown>> {
  return {
    handoff_id: handoff.id,
    tenant_id: tenantId,
    provider_alias: handoff.provider_alias,
    job_ref: handoff.job_ref,
    payload_ref: handoff.payload_ref,
    callback: {
      url_path: `/v1/webhooks/integration-handoffs/${tenantId}/${handoff.id}`,
      callback_url_secret_ref: handoff.callback_url_secret_ref,
      signature: handoff.callback_signature_secret_ref === null ? "not_configured" : "hmac-sha256-secret-ref",
      event_id_header: "X-RPA-Integration-Event-Id",
      timestamp_header: "X-RPA-Integration-Timestamp",
      signature_header: "X-RPA-Integration-Signature",
    },
    metadata: input.metadata,
  };
}

function requireOne<T>(row: T | undefined, reason: string): T {
  if (row === undefined) {
    throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason });
  }
  return row;
}
