import type { FastifyRequest } from "fastify";

import { ERROR_CATALOG } from "../../../ts/error-catalog";
import type { CanonicalRequestHash, IdempotencyKey } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { appendGovernanceAudit } from "./role-assignments";
import { ApiResponseError } from "./errors";
import { canonicalRequestHash, completeIdempotencyInTx } from "./idempotency";
import type { RunPriority } from "./run-queue";
import {
  apiErrorBody,
  isRecord,
  requirePrincipal,
  UUID_RE,
  IDEMPOTENCY_TTL_MS,
  type ApiServerDeps,
  type CommandResponse,
} from "./server-shared";

interface RunPriorityRow {
  id: string;
  status: string;
  priority: RunPriority;
  correlation_id: string;
}

interface ParsedPriorityBody {
  readonly priority: RunPriority;
  readonly reason: string | null;
}

export async function prioritizeRun(
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

  const body = parsePriorityBody(request.body);
  const requestHash = canonicalRequestHash("POST", `/v1/runs/${runId}/priority`, request.body ?? null);
  const reservation = await deps.idempotency.reserve({
    tenantId: principal.tenantId,
    endpoint: "prioritizeRun",
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

  try {
    let response: CommandResponse | null = null;
    await withTenantTx(deps.pool, principal.tenantId, async (client) => {
      const result = await client.query<RunPriorityRow>(
        `SELECT id, status, priority, correlation_id::text AS correlation_id
           FROM runs
          WHERE tenant_id = $1::uuid
            AND id = $2::uuid
          FOR UPDATE`,
        [principal.tenantId, runId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new ApiResponseError("RUN_NOT_FOUND");
      if (row.status !== "queued") {
        throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", {
          reason: "run_priority_requires_queued_status",
          status: row.status,
        });
      }

      if (row.priority !== body.priority) {
        await client.query(
          `UPDATE runs
              SET priority = $3,
                  updated_at = now()
            WHERE tenant_id = $1::uuid
              AND id = $2::uuid`,
          [principal.tenantId, runId, body.priority],
        );
        await deps.enqueuer.enqueueRunClaim(client, {
          tenantId: principal.tenantId,
          runId,
          correlationId: row.correlation_id,
          priority: body.priority,
        });
      }

      await appendGovernanceAudit(
        client,
        request,
        "run.prioritize",
        "allow",
        row.priority === body.priority ? "run_priority_unchanged" : "run_priority_changed",
        {
          run_id: runId,
          previous_priority: row.priority,
          priority: body.priority,
          reason: body.reason,
        },
      );

      response = {
        status: 200,
        body: {
          run_id: runId,
          status: "queued",
          previous_priority: row.priority,
          priority: body.priority,
        },
      };
      await completeIdempotencyInTx(client, reservation.recordId, response);
    });
    if (response === null) throw new Error("prioritizeRun completed without response");
    return response;
  } catch (err) {
    const apiErr = err instanceof ApiResponseError ? err : undefined;
    if (apiErr !== undefined) {
      if (shouldPersistPrioritizeFailure(apiErr)) {
        await deps.idempotency.saveFailure(reservation.recordId, apiErrorBody(apiErr, request.correlationId));
      }
      throw apiErr;
    }
    throw err;
  }
}

function parsePriorityBody(raw: unknown): ParsedPriorityBody {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  for (const key of Object.keys(raw)) {
    if (key !== "priority" && key !== "reason") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unknown_field", field: key });
    }
  }
  const priority = parseRunPriority(raw.priority);
  let reason: string | null = null;
  if (raw.reason !== undefined && raw.reason !== null) {
    if (typeof raw.reason !== "string" || raw.reason.trim().length === 0) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_reason" });
    }
    reason = raw.reason.trim();
  }
  return { priority, reason };
}

function parseRunPriority(raw: unknown): RunPriority {
  if (raw === "low" || raw === "medium" || raw === "high" || raw === "critical") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_run_priority" });
}

function shouldPersistPrioritizeFailure(error: ApiResponseError): boolean {
  return (
    !ERROR_CATALOG[error.code].retryable ||
    hasReason(error.details, "run_priority_requires_queued_status")
  );
}

function hasReason(details: unknown, reason: string): boolean {
  return typeof details === "object" && details !== null && "reason" in details && details.reason === reason;
}
