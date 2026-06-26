import { createHash, randomUUID } from "node:crypto";

import type { FastifyRequest } from "fastify";

import type { CanonicalRequestHash, IdempotencyKey } from "../../../ts/security-middleware-contract";
import { ERROR_CATALOG } from "../../../ts/error-catalog";
import { withTenantTx } from "../db/pool";
import { appendGovernanceAudit } from "./role-assignments";
import { ApiResponseError } from "./errors";
import { canonicalRequestHash, completeIdempotencyInTx } from "./idempotency";
import { createRunInTx } from "./server-create-run";
import {
  apiErrorBody,
  isRecord,
  requirePrincipal,
  UUID_RE,
  IDEMPOTENCY_TTL_MS,
  type ApiServerDeps,
  type CommandResponse,
} from "./server-shared";

const FAILED_RUN_STATUSES = new Set(["failed_business", "failed_system"]);
const ISO_8601_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

interface SourceRunRow {
  id: string;
  status: string;
  scenario_version_id: string;
  params: unknown;
  as_of: Date | null;
  model: string | null;
}

interface ParsedRerunBody {
  readonly mode: "same_input" | "edited_input";
  readonly params?: Record<string, unknown>;
  readonly reason: string | null;
}

export async function rerunRun(
  deps: ApiServerDeps,
  runId: string,
  request: FastifyRequest,
): Promise<CommandResponse> {
  const principal = requirePrincipal(request);
  if (!UUID_RE.test(runId)) throw new ApiResponseError("RUN_NOT_FOUND");

  const idempotencyKey = request.headers["idempotency-key"];
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_idempotency_key", header: "Idempotency-Key" });
  }

  const body = parseRerunBody(request.body);
  const requestHash = canonicalRequestHash("POST", `/v1/runs/${runId}/rerun`, request.body ?? null);
  const reservation = await deps.idempotency.reserve({
    tenantId: principal.tenantId,
    endpoint: "rerunRun",
    key: idempotencyKey as IdempotencyKey,
    requestHash: requestHash as CanonicalRequestHash,
    expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString(),
  });
  if (reservation.kind === "replay") {
    return { status: reservation.response.status, body: reservation.response.body };
  }
  if (reservation.kind === "in_flight") {
    throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", { reason: "idempotency_in_flight" });
  }
  if (reservation.kind === "blocked") {
    throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "idempotency_request_hash_mismatch" });
  }

  const childRunId = randomUUID();
  const rerunId = randomUUID();
  try {
    let response: CommandResponse | null = null;
    await withTenantTx(deps.pool, principal.tenantId, async (client) => {
      const source = await client.query<SourceRunRow>(
        `SELECT id, status, scenario_version_id, params, as_of, model
           FROM runs
          WHERE tenant_id = $1::uuid
            AND id = $2::uuid
          FOR UPDATE`,
        [principal.tenantId, runId],
      );
      const row = source.rows[0];
      if (row === undefined) throw new ApiResponseError("RUN_NOT_FOUND");
      if (!FAILED_RUN_STATUSES.has(row.status)) {
        throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", {
          reason: "run_rerun_requires_failed_status",
          status: row.status,
        });
      }

      const params = body.mode === "same_input" ? coerceParams(row.params) : body.params ?? {};
      const asOf =
        body.mode === "same_input"
          ? row.as_of?.toISOString() ?? new Date().toISOString()
          : paramsAsOf(params);

      await createRunInTx(client, deps.enqueuer, {
        runId: childRunId,
        tenantId: principal.tenantId,
        scenarioVersionId: row.scenario_version_id,
        params,
        asOf,
        correlationId: request.correlationId,
        model: row.model,
      });
      await client.query(
        `INSERT INTO run_reruns
           (id, tenant_id, source_run_id, child_run_id, mode, params, requested_by, reason)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::jsonb, $7, $8)`,
        [
          rerunId,
          principal.tenantId,
          runId,
          childRunId,
          body.mode,
          JSON.stringify(params),
          principal.subjectId,
          body.reason,
        ],
      );
      await appendGovernanceAudit(client, request, "run.rerun", "allow", "run_rerun_created", {
        rerun_id: rerunId,
        source_run_id: runId,
        child_run_id: childRunId,
        mode: body.mode,
        reason: body.reason,
        params_sha256: paramsHash(params),
      });
      response = {
        status: 201,
        body: {
          rerun_id: rerunId,
          source_run_id: runId,
          run_id: childRunId,
          status: "queued",
          mode: body.mode,
          as_of: asOf,
        },
      };
      await completeIdempotencyInTx(client, reservation.recordId, response);
    });
    if (response === null) throw new Error("rerunRun completed without response");
    return response;
  } catch (err) {
    const apiErr = err instanceof ApiResponseError ? err : undefined;
    if (apiErr !== undefined) {
      if (!ERROR_CATALOG[apiErr.code].retryable) {
        await deps.idempotency.saveFailure(reservation.recordId, apiErrorBody(apiErr, request.correlationId));
      }
      throw apiErr;
    }
    throw err;
  }
}

function parseRerunBody(raw: unknown): ParsedRerunBody {
  if (raw === undefined || raw === null) return { mode: "same_input", reason: null };
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  for (const key of Object.keys(raw)) {
    if (key !== "mode" && key !== "params" && key !== "reason") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unknown_field", field: key });
    }
  }
  const mode = raw.mode === undefined ? (raw.params === undefined ? "same_input" : "edited_input") : raw.mode;
  if (mode !== "same_input" && mode !== "edited_input") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_rerun_mode" });
  }
  if (mode === "same_input" && raw.params !== undefined) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "same_input_params_not_allowed" });
  }
  const params = raw.params === undefined ? undefined : parseParams(raw.params);
  if (mode === "edited_input" && params === undefined) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "edited_input_params_required" });
  }
  let reason: string | null = null;
  if (raw.reason !== undefined && raw.reason !== null) {
    if (typeof raw.reason !== "string" || raw.reason.trim().length === 0) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_reason" });
    }
    reason = raw.reason.trim();
  }
  return { mode, params, reason };
}

function parseParams(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "params_object_required" });
  const asOf = raw.as_of;
  if (asOf !== undefined && (typeof asOf !== "string" || !isStrictIsoDateTime(asOf))) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_as_of" });
  }
  return raw;
}

function coerceParams(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "source_params_not_object" });
  return raw;
}

function paramsAsOf(params: Record<string, unknown>): string {
  if (params.as_of === undefined) return new Date().toISOString();
  if (typeof params.as_of === "string" && isStrictIsoDateTime(params.as_of)) return params.as_of;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_as_of" });
}

function paramsHash(params: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(stableStringify(params)).digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function isStrictIsoDateTime(value: string): boolean {
  const match = ISO_8601_RE.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offsetText !== "Z") {
    const offsetHour = Number(offsetText.slice(1, 3));
    const offsetMinute = Number(offsetText.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return day >= 1 && day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
