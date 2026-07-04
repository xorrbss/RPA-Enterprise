import { CronScheduleError, parseCronExpression } from "../runtime/run-trigger-schedule";
import { isRecord } from "./command";
import { ApiResponseError } from "../runtime/errors";
import { UUID_RE } from "./server-shared";

export type RunTriggerStatus = "enabled" | "paused" | "archived";
export type RunTriggerFireStatus = "queued" | "skipped" | "failed";
export type CatchupPolicy = "skip_missed" | "fire_once";
export type RunTriggerType = "cron" | "webhook";

export interface TriggerBody {
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

export function cronOrApiError<T>(fn: () => T): T {
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

export function parseCreateBody(raw: unknown): Required<Pick<TriggerBody, "scenario_version_id">> & TriggerBody {
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

export function parseUpdateBody(raw: unknown): TriggerBody {
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

export function validateTriggerId(value: unknown): string {
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

export function runTriggerStatusFilter(raw: unknown): RunTriggerStatus | undefined {
  if (raw === undefined) return undefined;
  if (raw === "enabled" || raw === "paused" || raw === "archived") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_status" });
}
