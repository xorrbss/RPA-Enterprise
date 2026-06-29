import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import type { SecretRef } from "../../../ts/core-types";
import type { AuthenticatedPrincipal, PrincipalId, TenantId } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { isRecord, runIdempotentCommand } from "./command";
import { ApiResponseError } from "./errors";
import { paginate, parsePageParams } from "./list-query";
import { requirePrincipal, type ApiServerDeps } from "./server";
import { UUID_RE } from "./server-shared";
import { verifyWebhookSignature, webhookSigningPayload } from "./webhook-trigger-auth";

type IntegrationHandoffStatus = "accepted" | "deferred" | "completed" | "failed" | "cancelled";
type IntegrationHandoffReceiptStatus = Exclude<IntegrationHandoffStatus, "deferred">;
type IntegrationHandoffDispatchAttemptStatus = "pending" | "sending" | "accepted" | "failed" | "dead_letter";

const MAX_PROVIDER_CALLBACK_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;
const PROVIDER_CALLBACK_EVENT_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

interface IntegrationHandoff {
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

interface IntegrationHandoffRow {
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

interface IntegrationHandoffCreateInput {
  readonly providerAlias: string;
  readonly jobRef: string;
  readonly payloadRef: string;
  readonly callbackUrlSecretRef: string | null;
  readonly callbackSignatureSecretRef: string | null;
  readonly legalHold: boolean;
}

interface IntegrationHandoffCallbackInput {
  readonly externalJobId: string;
  readonly status: IntegrationHandoffReceiptStatus;
  readonly receiptId: string;
  readonly errorCode: string | null;
  readonly legalHold: boolean;
}

interface IntegrationHandoffDispatchInput {
  readonly endpointSecretRef: string;
  readonly allowedHosts: readonly string[];
  readonly maxAttempts: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly legalHold: boolean;
}

interface IntegrationHandoffDispatchAttempt {
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

interface IntegrationHandoffDispatchAttemptRow {
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

interface IntegrationHandoffCallbackHeaders {
  readonly eventId: string;
  readonly timestamp: string;
  readonly signature: string;
}

interface IntegrationHandoffAuthRow {
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

export function registerIntegrationHandoffRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/integration-handoffs", { config: { rbacAction: "integration.handoff" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const page = parsePageParams(query);
    const status = parseStatusFilter(query.status);
    const providerAlias = query.provider_alias === undefined ? undefined : parseSafeString(query.provider_alias, "provider_alias", 1, 120);

    const rows = await withTenantTx(deps.pool, principal.tenantId, (client) =>
      listIntegrationHandoffs(client, principal.tenantId, page.limit, page.cursor, status, providerAlias),
    );
    reply.code(200).send(paginate(rows, page.limit, (row) => ({ createdAt: row.cursor_at, id: row.id }), mapHandoff));
  });

  app.post("/v1/integration-handoffs", { config: { rbacAction: "integration.handoff" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseCreateRequest(request.body);
    const response = await runIdempotentCommand(
      deps,
      request,
      "createIntegrationHandoff",
      "/v1/integration-handoffs",
      async (client, tenantId) => {
        const item = await insertIntegrationHandoff(
          client,
          tenantId,
          principal.subjectId,
          requireIdempotencyHeader(request.headers["idempotency-key"]),
          body,
        );
        return { status: 202, body: item };
      },
    );
    reply.code(response.status).send(response.body);
  });

  app.post<{ Params: { handoff_id: string } }>(
    "/v1/integration-handoffs/:handoff_id/dispatch",
    { config: { rbacAction: "integration.handoff" } },
    async (request, reply) => {
      if (deps.enqueuer.enqueueIntegrationHandoffDispatch === undefined) {
        throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "integration_handoff_dispatch_enqueuer_not_configured" });
      }
      const principal = requirePrincipal(request);
      const handoffId = parseUuid(request.params.handoff_id, "handoff_id");
      const body = parseDispatchRequest(request.body);
      const enqueueIntegrationHandoffDispatch = deps.enqueuer.enqueueIntegrationHandoffDispatch.bind(deps.enqueuer);
      const response = await runIdempotentCommand(
        deps,
        request,
        "dispatchIntegrationHandoff",
        `/v1/integration-handoffs/${handoffId}/dispatch`,
        async (client, tenantId) => {
          const handoff = await selectIntegrationHandoffRow(client, tenantId, handoffId);
          if (handoff === undefined) {
            throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "integration_handoff_not_found" });
          }
          assertDispatchableHandoff(handoff);
          const attempt = await insertIntegrationHandoffDispatchAttempt(
            client,
            tenantId,
            handoff,
            principal.subjectId,
            requireIdempotencyHeader(request.headers["idempotency-key"]),
            body,
          );
          await enqueueIntegrationHandoffDispatch(client, {
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

  app.post<{ Params: { handoff_id: string } }>(
    "/v1/integration-handoffs/:handoff_id/callback",
    { config: { rbacAction: "integration.handoff" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const handoffId = parseUuid(request.params.handoff_id, "handoff_id");
      const body = parseCallbackRequest(request.body);
      const item = await withTenantTx(deps.pool, principal.tenantId, (client) =>
        recordIntegrationHandoffReceipt(client, principal.tenantId, handoffId, principal.subjectId, body),
      );
      reply.code(200).send(item);
    },
  );

  app.post<{ Params: { tenantId: string; handoff_id: string } }>(
    "/v1/webhooks/integration-handoffs/:tenantId/:handoff_id",
    { config: { skipJwtAuth: true } },
    async (request, reply) => {
      const tenantId = parseUuidNotFound(request.params.tenantId, "tenant_id");
      const handoffId = parseUuidNotFound(request.params.handoff_id, "handoff_id");
      const rawBody = request.body;
      const body = parseCallbackRequest(rawBody);
      const headers = parseProviderCallbackHeaders(request.headers);
      if (headers.eventId !== body.receiptId) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "handoff_callback_event_id_must_match_receipt_id" });
      }

      const authRow = await withTenantTx(deps.pool, tenantId, (client) =>
        selectIntegrationHandoffForAuth(client, handoffId),
      );
      if (authRow === null) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "integration_handoff_not_found" });
      }
      if (authRow.callback_signature_secret_ref === null) {
        throw new ApiResponseError("UNAUTHENTICATED", { reason: "integration_handoff_callback_signature_not_configured" });
      }

      const boundary = deps.integrationHandoffCallbackSecretBoundary ?? deps.webhookSecretBoundary;
      if (boundary === undefined) {
        throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "integration_handoff_callback_secret_boundary_not_configured" });
      }
      const secretRef = authRow.callback_signature_secret_ref as SecretRef;
      const secret = await boundary.resolveAuthorized({
        principal: integrationHandoffCallbackPrincipal(tenantId),
        ref: secretRef,
        purpose: "connector",
        connectorId: authRow.provider_alias,
      });
      const signingPayload = webhookSigningPayload(headers.timestamp, headers.eventId, rawBody);
      if (!verifyWebhookSignature(secret, headers.signature, signingPayload)) {
        throw new ApiResponseError("UNAUTHENTICATED", { reason: "invalid_integration_handoff_callback_signature" });
      }

      const item = await withTenantTx(deps.pool, tenantId, (client) =>
        recordIntegrationHandoffReceipt(
          client,
          tenantId,
          handoffId,
          "api:integration-handoff-callback",
          body,
          secretRef,
        ),
      );
      reply.code(202).send(item);
    },
  );
}

async function listIntegrationHandoffs(
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

async function insertIntegrationHandoff(
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

async function insertIntegrationHandoffDispatchAttempt(
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

async function recordIntegrationHandoffReceipt(
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

async function selectIntegrationHandoffForAuth(
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

async function selectIntegrationHandoffRow(
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

function mapHandoff(row: IntegrationHandoffRow): IntegrationHandoff {
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

function assertDispatchableHandoff(row: IntegrationHandoffRow): void {
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

function parseCreateRequest(raw: unknown): IntegrationHandoffCreateInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "integration_handoff_body_expected_object" });
  assertAllowedKeys(raw, ["provider_alias", "job_ref", "payload_ref", "callback_url_secret_ref", "callback_signature_secret_ref", "legal_hold"]);
  return {
    providerAlias: parseSafeString(raw.provider_alias, "provider_alias", 1, 120),
    jobRef: parseSafeString(raw.job_ref, "job_ref", 1, 300),
    payloadRef: parseSafeString(raw.payload_ref, "payload_ref", 1, 500),
    callbackUrlSecretRef: parseNullableSecretRef(raw.callback_url_secret_ref, "callback_url_secret_ref"),
    callbackSignatureSecretRef: parseNullableSecretRef(raw.callback_signature_secret_ref, "callback_signature_secret_ref"),
    legalHold: raw.legal_hold === undefined ? false : parseBoolean(raw.legal_hold, "legal_hold"),
  };
}

function parseDispatchRequest(raw: unknown): IntegrationHandoffDispatchInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "integration_handoff_dispatch_body_expected_object" });
  assertAllowedKeys(raw, ["endpoint_secret_ref", "allowed_hosts", "max_attempts", "metadata", "legal_hold"]);
  return {
    endpointSecretRef: parseSecretRef(raw.endpoint_secret_ref, "endpoint_secret_ref"),
    allowedHosts: parseAllowedHosts(raw.allowed_hosts),
    maxAttempts: raw.max_attempts === undefined ? 3 : parseInteger(raw.max_attempts, "max_attempts", 1, 20),
    metadata: parseMetadata(raw.metadata),
    legalHold: raw.legal_hold === undefined ? false : parseBoolean(raw.legal_hold, "legal_hold"),
  };
}

function parseCallbackRequest(raw: unknown): IntegrationHandoffCallbackInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "integration_handoff_callback_body_expected_object" });
  assertAllowedKeys(raw, ["external_job_id", "status", "receipt_id", "error_code", "legal_hold"]);
  const status = parseReceiptStatus(raw.status);
  const errorCode = raw.error_code === undefined || raw.error_code === null || raw.error_code === ""
    ? null
    : parseSafeString(raw.error_code, "error_code", 1, 120);
  if (status === "failed" && errorCode === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "error_code_required_for_failed_handoff" });
  }
  if ((status === "accepted" || status === "completed") && errorCode !== null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "error_code_for_successful_handoff_forbidden" });
  }
  return {
    externalJobId: parseSafeString(raw.external_job_id, "external_job_id", 1, 200),
    status,
    receiptId: parseSafeString(raw.receipt_id, "receipt_id", 1, 200),
    errorCode,
    legalHold: raw.legal_hold === undefined ? false : parseBoolean(raw.legal_hold, "legal_hold"),
  };
}

function parseStatusFilter(raw: unknown): IntegrationHandoffStatus | undefined {
  if (raw === undefined) return undefined;
  if (raw === "accepted" || raw === "deferred" || raw === "completed" || raw === "failed" || raw === "cancelled") {
    return raw;
  }
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_integration_handoff_status" });
}

function parseReceiptStatus(raw: unknown): IntegrationHandoffReceiptStatus {
  if (raw === "accepted" || raw === "completed" || raw === "failed" || raw === "cancelled") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_integration_handoff_callback_status" });
}

function parseUuid(raw: unknown, field: string): string {
  if (typeof raw === "string" && UUID_RE.test(raw)) return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function parseUuidNotFound(raw: unknown, field: string): string {
  if (typeof raw === "string" && UUID_RE.test(raw)) return raw;
  throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: `invalid_${field}` });
}

function parseProviderCallbackHeaders(headers: Record<string, unknown>): IntegrationHandoffCallbackHeaders {
  const eventId = requireHeader(headers["x-rpa-integration-event-id"], "x-rpa-integration-event-id");
  if (!PROVIDER_CALLBACK_EVENT_ID_RE.test(eventId)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_integration_handoff_event_id" });
  }
  const timestamp = requireHeader(headers["x-rpa-integration-timestamp"], "x-rpa-integration-timestamp");
  parseProviderCallbackTimestamp(timestamp);
  const signature = requireHeader(headers["x-rpa-integration-signature"], "x-rpa-integration-signature");
  return { eventId, timestamp, signature };
}

function parseProviderCallbackTimestamp(value: string): void {
  if (!/^\d{10,13}$/.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_integration_handoff_timestamp" });
  }
  const numeric = Number(value);
  const millis = value.length === 13 ? numeric : numeric * 1000;
  const parsed = new Date(millis);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_integration_handoff_timestamp" });
  }
  if (Math.abs(Date.now() - parsed.getTime()) > MAX_PROVIDER_CALLBACK_TIMESTAMP_SKEW_MS) {
    throw new ApiResponseError("UNAUTHENTICATED", { reason: "integration_handoff_timestamp_outside_window" });
  }
}

function requireHeader(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_integration_handoff_header", header: name });
}

function integrationHandoffCallbackPrincipal(tenantId: string): AuthenticatedPrincipal {
  return {
    subjectId: "api:integration-handoff-callback" as PrincipalId,
    tenantId: tenantId as TenantId,
    roles: [],
    source: "jwt",
    claims: { runtime_identity: "api" },
  };
}

function parseNullableSecretRef(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || !raw.startsWith("secret://") || raw.length <= "secret://".length || raw.length > 500) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  }
  assertSafeString(raw, field);
  return raw;
}

function parseSecretRef(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !raw.startsWith("secret://") || raw.length <= "secret://".length || raw.length > 500) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  }
  assertSafeString(raw, field);
  return raw;
}

function parseAllowedHosts(raw: unknown): readonly string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_allowed_hosts" });
  }
  const seen = new Set<string>();
  const hosts: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_allowed_host" });
    const host = item.trim().toLowerCase();
    if (
      host.length === 0 ||
      host.length > 253 ||
      host.includes("/") ||
      host.includes(":") ||
      host.includes("*") ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      /^[0-9.]+$/.test(host) ||
      !/^[a-z0-9.-]+$/.test(host) ||
      host.startsWith(".") ||
      host.endsWith(".")
    ) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_allowed_host", host: item });
    }
    if (!seen.has(host)) {
      seen.add(host);
      hosts.push(host);
    }
  }
  return hosts;
}

function parseInteger(raw: unknown, field: string, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  }
  return raw;
}

function parseMetadata(raw: unknown): Readonly<Record<string, unknown>> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_metadata" });
  assertSafeMetadata(raw, "metadata", 0);
  return raw;
}

function assertSafeMetadata(value: unknown, field: string, depth: number): void {
  if (depth > 4) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_too_deep", field });
  if (typeof value === "string") {
    assertSafeString(value, field);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 50) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_array_too_large", field });
    value.forEach((item, index) => assertSafeMetadata(item, `${field}.${index}`, depth + 1));
    return;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > 50) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_object_too_large", field });
    for (const [key, child] of entries) {
      if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || forbiddenEvidenceKey(key)) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_secret_or_endpoint_key_forbidden", field: `${field}.${key}` });
      }
      assertSafeMetadata(child, `${field}.${key}`, depth + 1);
    }
  }
}

function parseSafeString(raw: unknown, field: string, min: number, max: number): string {
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  const value = raw.trim();
  if (value.length < min || value.length > max) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  assertSafeString(value, field);
  return value;
}

function parseBoolean(raw: unknown, field: string): boolean {
  if (typeof raw === "boolean") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function assertAllowedKeys(raw: Record<string, unknown>, allowed: readonly string[]): void {
  const set = new Set(allowed);
  for (const key of Object.keys(raw)) {
    if (!set.has(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "integration_handoff_unknown_field", field: key });
    }
  }
}

function assertSafeString(value: string, field: string): void {
  if (/https?:\/\//i.test(value) || /hooks\.slack\.com/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "raw_endpoint_url_forbidden", field });
  }
  if (/\bbearer\s+[a-z0-9._~+/=-]{8,}/i.test(value) || /\b(token|password|secret)=/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_material_forbidden", field });
  }
}

function forbiddenEvidenceKey(key: string): boolean {
  return /(^|[_.-])(api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|credential|authorization|cookie|webhook_url|endpoint_url|url|dsn|smtp|raw_payload|request_payload|response_payload|payload|body|raw_body|provider_response|provider_body)([_.-]|$)/i.test(key);
}

function requireIdempotencyHeader(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_idempotency_key", header: "Idempotency-Key" });
  }
  return raw;
}

function requireOne<T>(row: T | undefined, reason: string): T {
  if (row === undefined) {
    throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason });
  }
  return row;
}
