import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import type { SecretRef } from "../../../ts/core-types";
import type { AuthenticatedPrincipal, PrincipalId, TenantId } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { isRecord } from "./command";
import { ApiResponseError } from "./errors";
import type { RunEnqueuer } from "./run-queue";
import { createRunInTx } from "./server-create-run";
import type { ApiServerDeps } from "./server-shared";
import { UUID_RE } from "./server-shared";
import { verifyWebhookSignature, webhookSigningPayload } from "./webhook-trigger-auth";

const MAX_WEBHOOK_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;
const WEBHOOK_EVENT_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

type RunTriggerStatus = "enabled" | "paused" | "archived";
type RunTriggerFireStatus = "queued" | "skipped" | "failed";

interface WebhookTriggerRow {
  id: string;
  scenario_version_id: string;
  status: RunTriggerStatus;
  params: unknown;
  max_concurrent_runs: number;
  webhook_secret_ref: string;
}

interface WebhookFireRow {
  id: string;
  trigger_id: string;
  fire_key: string;
  status: RunTriggerFireStatus;
  run_id: string | null;
  failure_reason: unknown;
  created_at: Date;
}

interface WebhookHeaders {
  eventId: string;
  timestamp: string;
  signature: string;
  eventTime: Date;
}

interface WebhookContext {
  tenantId: string;
  triggerId: string;
  eventId: string;
  fireKey: string;
  body: Record<string, unknown>;
  receivedAt: string;
  correlationId: string;
}

export function registerWebhookTriggerRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.post<{ Params: { tenantId: string; triggerId: string } }>(
    "/v1/webhooks/run-triggers/:tenantId/:triggerId",
    { config: { skipJwtAuth: true } },
    async (request, reply) => {
      const tenantId = requireUuidParam(request.params.tenantId, "tenant_id");
      const triggerId = requireUuidParam(request.params.triggerId, "trigger_id");
      const body = requireObjectBody(request.body);
      const headers = parseWebhookHeaders(request.headers);
      const receivedAt = new Date().toISOString();
      const fireKey = `webhook:${headers.eventId}`;

      const triggerForAuth = await withTenantTx(deps.pool, tenantId, (client) =>
        selectWebhookTrigger(client, triggerId, false),
      );
      if (triggerForAuth === null) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      if (triggerForAuth.status !== "enabled") {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "webhook_trigger_not_enabled" });
      }
      if (deps.webhookSecretBoundary === undefined) {
        throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "webhook_secret_boundary_not_configured" });
      }

      const secret = await deps.webhookSecretBoundary.resolveAuthorized({
        principal: webhookSecretPrincipal(tenantId),
        ref: triggerForAuth.webhook_secret_ref as SecretRef,
        purpose: "connector",
        connectorId: triggerId,
      });
      const signingPayload = webhookSigningPayload(headers.timestamp, headers.eventId, body);
      if (!verifyWebhookSignature(secret, headers.signature, signingPayload)) {
        throw new ApiResponseError("UNAUTHENTICATED", { reason: "invalid_webhook_signature" });
      }

      const receipt = await withTenantTx(deps.pool, tenantId, (client) =>
        acceptWebhookTriggerFire(client, deps.enqueuer, {
          tenantId,
          triggerId,
          eventId: headers.eventId,
          fireKey,
          body,
          receivedAt,
          correlationId: request.correlationId,
        }, triggerForAuth.webhook_secret_ref),
      );
      reply.code(202).send(receipt);
    },
  );
}

function webhookSecretPrincipal(tenantId: string): AuthenticatedPrincipal {
  return {
    subjectId: "api:webhook-trigger" as PrincipalId,
    tenantId: tenantId as TenantId,
    roles: ["admin"],
    source: "jwt",
    claims: { runtime_identity: "api" },
  };
}

async function acceptWebhookTriggerFire(
  client: PoolClient,
  enqueuer: RunEnqueuer,
  context: WebhookContext,
  verifiedSecretRef: string,
): Promise<Record<string, unknown>> {
  const trigger = await selectWebhookTrigger(client, context.triggerId, true);
  if (trigger === null) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND");
  }
  if (trigger.webhook_secret_ref !== verifiedSecretRef) {
    throw new ApiResponseError("UNAUTHENTICATED", { reason: "webhook_secret_ref_rotated" });
  }
  if (trigger.status !== "enabled") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "webhook_trigger_not_enabled" });
  }

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO run_trigger_fires
       (id, tenant_id, trigger_id, fire_key, status, scheduled_for, correlation_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'queued', $5::timestamptz, $6::uuid)
     ON CONFLICT (tenant_id, trigger_id, fire_key) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      context.tenantId,
      context.triggerId,
      context.fireKey,
      context.receivedAt,
      normalizeCorrelationId(context.correlationId),
    ],
  );

  if (inserted.rowCount === 0) {
    const existing = await requireWebhookFire(client, context.tenantId, context.triggerId, context.fireKey);
    return mapWebhookFire(existing, true);
  }

  const fireId = inserted.rows[0].id;
  const activeRuns = await countActiveRuns(client, context.tenantId, context.triggerId);
  if (activeRuns >= trigger.max_concurrent_runs) {
    const reason = { code: "MAX_CONCURRENCY_REACHED" };
    await markFire(client, fireId, "skipped", null, reason);
    const skipped = await requireWebhookFire(client, context.tenantId, context.triggerId, context.fireKey);
    return mapWebhookFire(skipped, false);
  }

  await client.query("SAVEPOINT webhook_trigger_create_run");
  try {
    const runId = randomUUID();
    await createRunInTx(client, enqueuer, {
      runId,
      tenantId: context.tenantId,
      scenarioVersionId: trigger.scenario_version_id,
      params: webhookRunParams(trigger.params, context),
      asOf: context.receivedAt,
      correlationId: context.correlationId,
    });
    await markFire(client, fireId, "queued", runId, null);
    await client.query("RELEASE SAVEPOINT webhook_trigger_create_run");
    const queued = await requireWebhookFire(client, context.tenantId, context.triggerId, context.fireKey);
    return mapWebhookFire(queued, false);
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT webhook_trigger_create_run");
    await markFire(client, fireId, "failed", null, failureReason(err));
    await client.query("RELEASE SAVEPOINT webhook_trigger_create_run");
    const failed = await requireWebhookFire(client, context.tenantId, context.triggerId, context.fireKey);
    return mapWebhookFire(failed, false);
  }
}

async function selectWebhookTrigger(
  client: PoolClient,
  triggerId: string,
  forUpdate: boolean,
): Promise<WebhookTriggerRow | null> {
  const result = await client.query<WebhookTriggerRow>(
    `SELECT id, scenario_version_id, status, params, max_concurrent_runs, webhook_secret_ref
       FROM run_triggers
      WHERE id = $1::uuid
        AND trigger_type = 'webhook'
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [triggerId],
  );
  return result.rows[0] ?? null;
}

async function requireWebhookFire(
  client: PoolClient,
  tenantId: string,
  triggerId: string,
  fireKey: string,
): Promise<WebhookFireRow> {
  const result = await client.query<WebhookFireRow>(
    `SELECT id, trigger_id, fire_key, status, run_id, failure_reason, created_at
       FROM run_trigger_fires
      WHERE tenant_id = $1::uuid
        AND trigger_id = $2::uuid
        AND fire_key = $3`,
    [tenantId, triggerId, fireKey],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "webhook_fire_missing_after_insert" });
  }
  return row;
}

async function countActiveRuns(client: PoolClient, tenantId: string, triggerId: string): Promise<number> {
  const active = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM run_trigger_fires f
       JOIN runs r ON r.tenant_id = f.tenant_id AND r.id = f.run_id
      WHERE f.tenant_id = $1::uuid
        AND f.trigger_id = $2::uuid
        AND r.status NOT IN ('completed','cancelled','failed_business','failed_system')`,
    [tenantId, triggerId],
  );
  return active.rows[0]?.n ?? 0;
}

async function markFire(
  client: PoolClient,
  fireId: string,
  status: RunTriggerFireStatus,
  runId: string | null,
  failureReasonValue: Record<string, unknown> | null,
): Promise<void> {
  await client.query(
    `UPDATE run_trigger_fires
        SET status = $2,
            run_id = $3::uuid,
            failure_reason = $4::jsonb
      WHERE id = $1::uuid`,
    [fireId, status, runId, failureReasonValue === null ? null : JSON.stringify(failureReasonValue)],
  );
}

function webhookRunParams(triggerParams: unknown, context: WebhookContext): Record<string, unknown> {
  const params = isRecord(triggerParams) ? triggerParams : {};
  return {
    ...params,
    webhook: {
      event_id: context.eventId,
      received_at: context.receivedAt,
      payload: context.body,
    },
  };
}

function parseWebhookHeaders(headers: Record<string, unknown>): WebhookHeaders {
  const eventId = requireHeader(headers["x-rpa-webhook-event-id"], "x-rpa-webhook-event-id");
  if (!WEBHOOK_EVENT_ID_RE.test(eventId)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_webhook_event_id" });
  }
  const timestamp = requireHeader(headers["x-rpa-webhook-timestamp"], "x-rpa-webhook-timestamp");
  const eventTime = parseWebhookTimestamp(timestamp);
  const signature = requireHeader(headers["x-rpa-webhook-signature"], "x-rpa-webhook-signature");
  return { eventId, timestamp, signature, eventTime };
}

function parseWebhookTimestamp(value: string): Date {
  if (!/^\d{10,13}$/.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_webhook_timestamp" });
  }
  const numeric = Number(value);
  const millis = value.length === 13 ? numeric : numeric * 1000;
  const parsed = new Date(millis);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_webhook_timestamp" });
  }
  if (Math.abs(Date.now() - parsed.getTime()) > MAX_WEBHOOK_TIMESTAMP_SKEW_MS) {
    throw new ApiResponseError("UNAUTHENTICATED", { reason: "webhook_timestamp_outside_window" });
  }
  return parsed;
}

function requireHeader(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_webhook_header", header: name });
}

function requireUuidParam(value: string, field: string): string {
  if (UUID_RE.test(value)) return value;
  throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: `invalid_${field}` });
}

function requireObjectBody(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
}

function normalizeCorrelationId(value: string): string {
  return UUID_RE.test(value) ? value : randomUUID();
}

function failureReason(error: unknown): Record<string, unknown> {
  if (error instanceof ApiResponseError) {
    return {
      code: error.code,
      details: error.details ?? null,
    };
  }
  return {
    code: "CONTROL_PLANE_INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}

function mapWebhookFire(row: WebhookFireRow, duplicate: boolean): Record<string, unknown> {
  return {
    fire_id: row.id,
    trigger_id: row.trigger_id,
    fire_key: row.fire_key,
    status: row.status,
    run_id: row.run_id,
    duplicate,
    failure_reason: isRecord(row.failure_reason) ? row.failure_reason : null,
    received_at: row.created_at.toISOString(),
  };
}
