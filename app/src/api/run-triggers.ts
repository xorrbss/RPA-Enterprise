import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import type { AuthenticatedPrincipal } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { CronScheduleError, nextCronFireAfter, parseCronExpression } from "../runtime/run-trigger-schedule";
import { runIdempotentCommand, isRecord, type CommandResponse } from "./command";
import { ApiResponseError } from "./errors";
import { paginate, parsePageParams, uuidFilter } from "./list-query";
import { requirePrincipal, type ApiServerDeps } from "./server";
import { UUID_RE } from "./server-shared";

type RunTriggerStatus = "enabled" | "paused" | "archived";
type RunTriggerFireStatus = "queued" | "skipped" | "failed";
type CatchupPolicy = "skip_missed" | "fire_once";
type RunTriggerType = "cron" | "webhook";

interface RunTriggerRow {
  id: string;
  scenario_version_id: string;
  trigger_type: RunTriggerType;
  status: RunTriggerStatus;
  cron_expression: string | null;
  timezone: string | null;
  webhook_secret_ref: string | null;
  params: unknown;
  catchup_policy: CatchupPolicy;
  max_concurrent_runs: number;
  next_fire_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  cursor_at: string;
}

interface RunTriggerFireRow {
  id: string;
  trigger_id: string;
  fire_key: string;
  status: RunTriggerFireStatus;
  scheduled_for: Date;
  run_id: string | null;
  failure_reason: unknown;
  created_at: Date;
  cursor_at: string;
}

interface TriggerBody {
  trigger_type?: unknown;
  scenario_version_id?: unknown;
  cron_expression?: unknown;
  timezone?: unknown;
  webhook_secret_ref?: unknown;
  params?: unknown;
  catchup_policy?: unknown;
  max_concurrent_runs?: unknown;
  next_fire_at?: unknown;
}

export function registerRunTriggerRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/run-triggers", { config: { rbacAction: "trigger.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);
    const status = runTriggerStatusFilter(query.status);
    const scenarioVersionId = uuidFilter(query.scenario_version_id, "invalid_scenario_version_id");

    const rows = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
      const result = await client.query<RunTriggerRow>(
        `SELECT id, scenario_version_id, trigger_type, status, cron_expression, timezone, webhook_secret_ref, params, catchup_policy,
                max_concurrent_runs, next_fire_at, created_by, created_at, updated_at, created_at::text AS cursor_at
           FROM run_triggers
          WHERE tenant_id = $1::uuid
            AND ($2::text IS NULL OR status = $2)
            AND ($3::uuid IS NULL OR scenario_version_id = $3::uuid)
            AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT $6`,
        [principal.tenantId, status ?? null, scenarioVersionId ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );
      return result.rows;
    });

    const exposeSecretRef = canManageRunTriggerSecretRef(principal);
    reply.code(200).send(paginate(rows, limit, (row) => ({ createdAt: row.cursor_at, id: row.id }), (row) => mapRunTrigger(row, exposeSecretRef)));
  });

  app.post("/v1/run-triggers", { config: { rbacAction: "trigger.manage" } }, async (request, reply) => {
    const body = parseCreateBody(request.body);
    const result = await runIdempotentCommand(deps, request, "createRunTrigger", "/v1/run-triggers", (client, tenantId) =>
      createRunTrigger(client, tenantId, request, body),
    );
    reply.code(result.status).send(result.body);
  });

  app.get<{ Params: { triggerId: string } }>(
    "/v1/run-triggers/:triggerId",
    { config: { rbacAction: "trigger.read" } },
    async (request, reply) => {
      const row = await requireTriggerRow(deps, request, request.params.triggerId);
      reply.code(200).send(mapRunTrigger(row, canManageRunTriggerSecretRef(requirePrincipal(request))));
    },
  );

  app.patch<{ Params: { triggerId: string } }>(
    "/v1/run-triggers/:triggerId",
    { config: { rbacAction: "trigger.manage" } },
    async (request, reply) => {
      validateTriggerId(request.params.triggerId);
      const body = parseUpdateBody(request.body);
      const path = `/v1/run-triggers/${request.params.triggerId}`;
      const result = await runIdempotentCommand(deps, request, "updateRunTrigger", path, (client, tenantId) =>
        updateRunTrigger(client, tenantId, request.params.triggerId, body),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { triggerId: string } }>(
    "/v1/run-triggers/:triggerId/pause",
    { config: { rbacAction: "trigger.manage" } },
    async (request, reply) => {
      const result = await commandStatusChange(deps, request, request.params.triggerId, "pauseRunTrigger", "paused");
      reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { triggerId: string } }>(
    "/v1/run-triggers/:triggerId/resume",
    { config: { rbacAction: "trigger.manage" } },
    async (request, reply) => {
      const result = await commandStatusChange(deps, request, request.params.triggerId, "resumeRunTrigger", "enabled");
      reply.code(result.status).send(result.body);
    },
  );

  app.get<{ Params: { triggerId: string } }>(
    "/v1/run-triggers/:triggerId/fires",
    { config: { rbacAction: "trigger.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const triggerId = validateTriggerId(request.params.triggerId);
      const query = request.query as Record<string, unknown>;
      const { limit, cursor } = parsePageParams(query);

      const rows = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
        await assertTriggerExists(client, triggerId);
        const result = await client.query<RunTriggerFireRow>(
          `SELECT id, trigger_id, fire_key, status, scheduled_for, run_id, failure_reason, created_at, scheduled_for::text AS cursor_at
             FROM run_trigger_fires
            WHERE tenant_id = $1::uuid
              AND trigger_id = $2::uuid
              AND ($3::timestamptz IS NULL OR (scheduled_for, id) < ($3::timestamptz, $4::uuid))
            ORDER BY scheduled_for DESC, id DESC
            LIMIT $5`,
          [principal.tenantId, triggerId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
        );
        return result.rows;
      });

      reply.code(200).send(paginate(rows, limit, (row) => ({ createdAt: row.cursor_at, id: row.id }), mapRunTriggerFire));
    },
  );
}

async function createRunTrigger(
  client: PoolClient,
  tenantId: string,
  request: FastifyRequest,
  body: Required<Pick<TriggerBody, "scenario_version_id">> & TriggerBody,
): Promise<CommandResponse> {
  await assertScenarioVersionExists(client, body.scenario_version_id as string);
  const id = randomUUID();
  const nextFireAt = body.trigger_type === "webhook"
    ? null
    : body.next_fire_at !== undefined
    ? body.next_fire_at ?? null
    : defaultNextFireAt(body.cron_expression as string, body.timezone as string);
  const result = await client.query<RunTriggerRow>(
    `INSERT INTO run_triggers
       (id, tenant_id, scenario_version_id, trigger_type, status, cron_expression, timezone, webhook_secret_ref, params, catchup_policy,
        max_concurrent_runs, next_fire_at, created_by)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'enabled', $5, $6, $7, $8::jsonb, $9, $10, $11::timestamptz, $12)
     RETURNING id, scenario_version_id, trigger_type, status, cron_expression, timezone, webhook_secret_ref, params, catchup_policy,
               max_concurrent_runs, next_fire_at, created_by, created_at, updated_at, created_at::text AS cursor_at`,
    [
      id,
      tenantId,
      body.scenario_version_id,
      body.trigger_type ?? "cron",
      body.cron_expression ?? null,
      body.timezone ?? null,
      body.webhook_secret_ref ?? null,
      JSON.stringify(body.params ?? {}),
      body.catchup_policy ?? "skip_missed",
      body.max_concurrent_runs ?? 1,
      nextFireAt,
      requirePrincipal(request).subjectId,
    ],
  );
  return { status: 201, body: mapRunTrigger(result.rows[0], true) };
}

async function updateRunTrigger(
  client: PoolClient,
  _tenantId: string,
  triggerId: string,
  body: TriggerBody,
): Promise<CommandResponse> {
  const existing = await requireTriggerExists(client, triggerId);
  validateUpdateForTriggerType(existing, body);
  const nextFireAt = nextFireAtForUpdate(existing, body);
  const result = await client.query<RunTriggerRow>(
    `UPDATE run_triggers
        SET cron_expression = COALESCE($2, cron_expression),
            timezone = COALESCE($3, timezone),
            webhook_secret_ref = COALESCE($4, webhook_secret_ref),
            params = COALESCE($5::jsonb, params),
            catchup_policy = COALESCE($6, catchup_policy),
            max_concurrent_runs = COALESCE($7, max_concurrent_runs),
            next_fire_at = CASE WHEN $8::boolean THEN $9::timestamptz ELSE next_fire_at END,
            updated_at = now()
      WHERE id = $1::uuid
      RETURNING id, scenario_version_id, trigger_type, status, cron_expression, timezone, webhook_secret_ref, params, catchup_policy,
                max_concurrent_runs, next_fire_at, created_by, created_at, updated_at, created_at::text AS cursor_at`,
    [
      triggerId,
      body.cron_expression ?? null,
      body.timezone ?? null,
      body.webhook_secret_ref ?? null,
      body.params === undefined ? null : JSON.stringify(body.params),
      body.catchup_policy ?? null,
      body.max_concurrent_runs ?? null,
      nextFireAt !== undefined,
      nextFireAt ?? null,
    ],
  );
  return { status: 200, body: mapRunTrigger(result.rows[0], true) };
}

async function commandStatusChange(
  deps: ApiServerDeps,
  request: FastifyRequest<{ Params: { triggerId: string } }>,
  triggerIdRaw: string,
  endpoint: "pauseRunTrigger" | "resumeRunTrigger",
  status: Extract<RunTriggerStatus, "enabled" | "paused">,
): Promise<CommandResponse> {
  const triggerId = validateTriggerId(triggerIdRaw);
  const path = `/v1/run-triggers/${triggerId}/${endpoint === "pauseRunTrigger" ? "pause" : "resume"}`;
  return runIdempotentCommand(deps, request, endpoint, path, async (client) => {
    const existing = await requireTriggerExists(client, triggerId);
    const resumeNextFireAt = status === "enabled" && existing.trigger_type === "cron" && existing.next_fire_at === null
      ? defaultNextFireAt(requireExistingString(existing.cron_expression, "cron_expression"), requireExistingString(existing.timezone, "timezone"))
      : null;
    const result = await client.query<RunTriggerRow>(
      `UPDATE run_triggers
          SET status = $2,
              next_fire_at = COALESCE($3::timestamptz, next_fire_at),
              updated_at = now()
        WHERE id = $1::uuid
        RETURNING id, scenario_version_id, trigger_type, status, cron_expression, timezone, webhook_secret_ref, params, catchup_policy,
                  max_concurrent_runs, next_fire_at, created_by, created_at, updated_at, created_at::text AS cursor_at`,
      [triggerId, status, resumeNextFireAt],
    );
    return { status: 200, body: mapRunTrigger(result.rows[0], true) };
  });
}

async function requireTriggerRow(
  deps: ApiServerDeps,
  request: FastifyRequest,
  triggerIdRaw: string,
): Promise<RunTriggerRow> {
  const principal = requirePrincipal(request);
  const triggerId = validateTriggerId(triggerIdRaw);
  const row = await withTenantTx(deps.pool, principal.tenantId, async (client) => selectTrigger(client, triggerId));
  if (row === null) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return row;
}

async function selectTrigger(client: PoolClient, triggerId: string): Promise<RunTriggerRow | null> {
  const result = await client.query<RunTriggerRow>(
    `SELECT id, scenario_version_id, trigger_type, status, cron_expression, timezone, webhook_secret_ref, params, catchup_policy,
            max_concurrent_runs, next_fire_at, created_by, created_at, updated_at, created_at::text AS cursor_at
       FROM run_triggers
      WHERE id = $1::uuid`,
    [triggerId],
  );
  return result.rows[0] ?? null;
}

async function assertTriggerExists(client: PoolClient, triggerId: string): Promise<void> {
  await requireTriggerExists(client, triggerId);
}

async function requireTriggerExists(client: PoolClient, triggerId: string): Promise<RunTriggerRow> {
  const row = await selectTrigger(client, triggerId);
  if (row === null) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND");
  }
  return row;
}

async function assertScenarioVersionExists(client: PoolClient, scenarioVersionId: string): Promise<void> {
  const result = await client.query("SELECT 1 FROM scenario_versions WHERE id = $1::uuid", [scenarioVersionId]);
  if (result.rowCount !== 1) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "scenario_version_not_found" });
  }
}

function nextFireAtForUpdate(existing: RunTriggerRow, body: TriggerBody): string | null | undefined {
  if (existing.trigger_type === "webhook") {
    return body.next_fire_at !== undefined ? null : undefined;
  }
  if (body.next_fire_at !== undefined) {
    if (body.next_fire_at === null) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "cron_trigger_requires_next_fire_at" });
    }
    return body.next_fire_at as string;
  }
  if (body.cron_expression === undefined && body.timezone === undefined) {
    return undefined;
  }
  return defaultNextFireAt(
    body.cron_expression !== undefined ? (body.cron_expression as string) : requireExistingString(existing.cron_expression, "cron_expression"),
    body.timezone !== undefined ? (body.timezone as string) : requireExistingString(existing.timezone, "timezone"),
  );
}

function validateUpdateForTriggerType(existing: RunTriggerRow, body: TriggerBody): void {
  if (existing.trigger_type === "webhook") {
    if (body.cron_expression !== undefined || body.timezone !== undefined || body.next_fire_at !== undefined) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "webhook_trigger_forbids_cron_fields" });
    }
    return;
  }
  if (body.webhook_secret_ref !== undefined) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "cron_trigger_forbids_webhook_secret_ref" });
  }
}

function defaultNextFireAt(cronExpression: string, timezone: string): string {
  return cronOrApiError(() => nextCronFireAfter(cronExpression, timezone, new Date()).toISOString());
}

function cronOrApiError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof CronScheduleError) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", {
        reason: "invalid_cron_expression",
        detail: err.reason,
        field: err.field ?? null,
      });
    }
    throw err;
  }
}

function parseCreateBody(raw: unknown): Required<Pick<TriggerBody, "scenario_version_id">> & TriggerBody {
  const body = parseKnownBody(raw, ["trigger_type", "scenario_version_id", "cron_expression", "timezone", "webhook_secret_ref", "params", "catchup_policy", "max_concurrent_runs", "next_fire_at"]);
  const triggerType = optionalTriggerType(body.trigger_type) ?? "cron";
  if (triggerType === "webhook") {
    if (body.cron_expression !== undefined || body.timezone !== undefined || body.next_fire_at !== undefined) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "webhook_trigger_forbids_cron_fields" });
    }
    return {
      trigger_type: triggerType,
      scenario_version_id: requireUuid(body.scenario_version_id, "scenario_version_id"),
      webhook_secret_ref: requireSecretRef(body.webhook_secret_ref),
      params: optionalParams(body.params),
      catchup_policy: optionalCatchupPolicy(body.catchup_policy),
      max_concurrent_runs: optionalPositiveInteger(body.max_concurrent_runs, "max_concurrent_runs"),
      next_fire_at: null,
    };
  }
  const nextFireAt = optionalDateTimeOrNull(body.next_fire_at);
  if (nextFireAt === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "cron_trigger_requires_next_fire_at" });
  }
  if (body.webhook_secret_ref !== undefined) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "cron_trigger_forbids_webhook_secret_ref" });
  }
  return {
    trigger_type: triggerType,
    scenario_version_id: requireUuid(body.scenario_version_id, "scenario_version_id"),
    cron_expression: requireCronExpression(body.cron_expression),
    timezone: requireTimezone(body.timezone),
    webhook_secret_ref: undefined,
    params: optionalParams(body.params),
    catchup_policy: optionalCatchupPolicy(body.catchup_policy),
    max_concurrent_runs: optionalPositiveInteger(body.max_concurrent_runs, "max_concurrent_runs"),
    next_fire_at: nextFireAt,
  };
}

function parseUpdateBody(raw: unknown): TriggerBody {
  const body = parseKnownBody(raw, ["cron_expression", "timezone", "webhook_secret_ref", "params", "catchup_policy", "max_concurrent_runs", "next_fire_at"]);
  if (Object.keys(body).length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "empty_update" });
  }
  const nextFireAt = optionalDateTimeOrNull(body.next_fire_at);
  return {
    cron_expression: body.cron_expression === undefined ? undefined : requireCronExpression(body.cron_expression),
    timezone: body.timezone === undefined ? undefined : requireTimezone(body.timezone),
    webhook_secret_ref: body.webhook_secret_ref === undefined ? undefined : requireSecretRef(body.webhook_secret_ref),
    params: body.params === undefined ? undefined : optionalParams(body.params),
    catchup_policy: optionalCatchupPolicy(body.catchup_policy),
    max_concurrent_runs: optionalPositiveInteger(body.max_concurrent_runs, "max_concurrent_runs"),
    next_fire_at: nextFireAt,
  };
}

function parseKnownBody(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unknown_field", field: key });
    }
  }
  return raw;
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value === "string" && UUID_RE.test(value)) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `${field}_required` });
}

function validateTriggerId(value: unknown): string {
  if (typeof value === "string" && UUID_RE.test(value)) return value;
  throw new ApiResponseError("RESOURCE_NOT_FOUND");
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `${field}_required` });
}

function requireCronExpression(value: unknown): string {
  const cronExpression = requireNonEmptyString(value, "cron_expression");
  cronOrApiError(() => parseCronExpression(cronExpression));
  return cronExpression;
}

function requireTimezone(value: unknown): string {
  const timezone = requireNonEmptyString(value, "timezone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_timezone" });
  }
  return timezone;
}

function requireExistingString(value: string | null, field: string): string {
  if (value !== null) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `${field}_required` });
}

function optionalTriggerType(value: unknown): RunTriggerType | undefined {
  if (value === undefined) return undefined;
  if (value === "cron" || value === "webhook") return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_trigger_type" });
}

function requireSecretRef(value: unknown): string {
  if (typeof value === "string" && value.startsWith("secret://") && value.length > "secret://".length) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "webhook_secret_ref_required" });
}

function optionalParams(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (isRecord(value)) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "params_object_required" });
}

function optionalCatchupPolicy(value: unknown): CatchupPolicy | undefined {
  if (value === undefined) return undefined;
  if (value === "skip_missed" || value === "fire_once") return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_catchup_policy" });
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function optionalDateTimeOrNull(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_next_fire_at" });
}

function runTriggerStatusFilter(raw: unknown): RunTriggerStatus | undefined {
  if (raw === undefined) return undefined;
  if (raw === "enabled" || raw === "paused" || raw === "archived") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_status" });
}

function canManageRunTriggerSecretRef(principal: AuthenticatedPrincipal): boolean {
  return principal.roles.some((role) => role === "operator" || role === "reviewer" || role === "approver" || role === "admin");
}

function mapRunTrigger(row: RunTriggerRow, exposeSecretRef: boolean): Record<string, unknown> {
  return {
    trigger_id: row.id,
    scenario_version_id: row.scenario_version_id,
    trigger_type: row.trigger_type,
    status: row.status,
    cron_expression: row.cron_expression,
    timezone: row.timezone,
    webhook_secret_ref: exposeSecretRef ? row.webhook_secret_ref : null,
    webhook_secret_configured: row.webhook_secret_ref !== null,
    params: isRecord(row.params) ? row.params : {},
    catchup_policy: row.catchup_policy,
    max_concurrent_runs: row.max_concurrent_runs,
    next_fire_at: row.next_fire_at !== null ? row.next_fire_at.toISOString() : null,
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function mapRunTriggerFire(row: RunTriggerFireRow): Record<string, unknown> {
  return {
    fire_id: row.id,
    trigger_id: row.trigger_id,
    fire_key: row.fire_key,
    status: row.status,
    scheduled_for: row.scheduled_for.toISOString(),
    run_id: row.run_id,
    failure_reason: isRecord(row.failure_reason) ? row.failure_reason : null,
    created_at: row.created_at.toISOString(),
  };
}
