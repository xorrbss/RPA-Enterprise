import type { FastifyRequest } from "fastify";

import { ERROR_CATALOG } from "../../../ts/error-catalog";
import type { CanonicalRequestHash, IdempotencyKey } from "../../../ts/security-middleware-contract";
import type { RunState, SideEffectCmd } from "../../../ts/state-machine-types";
import { withTenantTx } from "../db/pool";
import { applyRunTransition } from "../runtime/run-transition";
import { ApiResponseError } from "./errors";
import { canonicalRequestHash, completeIdempotencyInTx } from "./idempotency";
import { appendGovernanceAudit } from "./role-assignments";
import {
  apiErrorBody,
  isRecord,
  requirePrincipal,
  UUID_RE,
  IDEMPOTENCY_TTL_MS,
  type ApiServerDeps,
  type CommandResponse,
} from "./server-shared";

interface RunResumeRow {
  readonly status: RunState;
  readonly correlation_id: string | null;
}

interface ParsedResumeBody {
  readonly reason: string | null;
}

export async function resumeRun(
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
  if (deps.enqueuer.enqueueRunResume === undefined) {
    throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "run_resume_enqueuer_not_configured" });
  }

  const body = parseResumeBody(request.body);
  const requestHash = canonicalRequestHash("POST", `/v1/runs/${runId}/resume`, request.body ?? null);
  const reservation = await deps.idempotency.reserve({
    tenantId: principal.tenantId,
    endpoint: "resumeRun",
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
      const result = await client.query<RunResumeRow>(
        `SELECT status, correlation_id::text AS correlation_id
           FROM runs
          WHERE tenant_id = $1::uuid
            AND id = $2::uuid
          FOR UPDATE`,
        [principal.tenantId, runId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new ApiResponseError("RUN_NOT_FOUND");
      if (row.status !== "suspended" && row.status !== "resume_requested") {
        throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", {
          reason: "run_resume_requires_suspended_or_resume_requested",
          status: row.status,
        });
      }

      const correlationId = row.correlation_id ?? request.correlationId;
      if (row.status === "resume_requested") {
        await deps.enqueuer.enqueueRunResume?.(client, {
          tenantId: principal.tenantId,
          runId,
          correlationId,
        });
        await appendGovernanceAudit(client, request, "run.resume", "allow", "run_resume_reenqueued", {
          run_id: runId,
          previous_status: row.status,
          reason: body.reason,
        });
        response = { status: 202, body: { run_id: runId, status: "resume_requested", previous_status: row.status } };
        await completeIdempotencyInTx(client, reservation.recordId, response);
        return;
      }

      const unresolved = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM human_tasks
          WHERE tenant_id = $1::uuid
            AND run_id = $2::uuid
            AND state IN ('open','assigned','in_progress','escalated')`,
        [principal.tenantId, runId],
      );
      if ((unresolved.rows[0]?.n ?? 0) > 0) {
        throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", { reason: "human_task_unresolved" });
      }

      const outcome = await applyRunTransition(client, {
        tenantId: principal.tenantId,
        runId,
        fromStatus: "suspended",
        event: { type: "human_task.resolved" },
        guard: { humanTaskValid: true },
        correlationId,
        eventIdempotencyKey: `${runId}:operator_resume:${reservation.recordId}`,
      });
      if (!outcome.applied) {
        throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", { reason: "run_resume_cas_contention" });
      }
      assertNoPendingResumeSideEffects(outcome.pending);

      await deps.enqueuer.enqueueRunResume?.(client, {
        tenantId: principal.tenantId,
        runId,
        correlationId,
      });
      await appendGovernanceAudit(client, request, "run.resume", "allow", "run_resume_requested", {
        run_id: runId,
        previous_status: row.status,
        reason: body.reason,
      });
      response = { status: 202, body: { run_id: runId, status: outcome.next, previous_status: row.status } };
      await completeIdempotencyInTx(client, reservation.recordId, response);
    });
    if (response === null) throw new Error("resumeRun completed without response");
    return response;
  } catch (err) {
    const apiErr = err instanceof ApiResponseError ? err : undefined;
    if (apiErr !== undefined) {
      if (shouldPersistResumeFailure(apiErr)) {
        await deps.idempotency.saveFailure(reservation.recordId, apiErrorBody(apiErr, request.correlationId));
      }
      throw apiErr;
    }
    throw err;
  }
}

function parseResumeBody(raw: unknown): ParsedResumeBody {
  if (raw === undefined || raw === null) return { reason: null };
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  for (const key of Object.keys(raw)) {
    if (key !== "reason") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unknown_field", field: key });
    }
  }
  if (raw.reason === undefined || raw.reason === null) return { reason: null };
  if (typeof raw.reason !== "string" || raw.reason.trim().length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_reason" });
  }
  return { reason: raw.reason.trim() };
}

function assertNoPendingResumeSideEffects(pending: readonly SideEffectCmd[]): void {
  if (pending.length === 0) return;
  throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", {
    reason: "run_resume_pending_side_effects_unsupported",
    pending: pending.map((cmd) => cmd.kind),
  });
}

function shouldPersistResumeFailure(error: ApiResponseError): boolean {
  return (
    !ERROR_CATALOG[error.code].retryable ||
    hasReason(error.details, "run_resume_requires_suspended_or_resume_requested") ||
    hasReason(error.details, "human_task_unresolved")
  );
}

function hasReason(details: unknown, reason: string): boolean {
  return typeof details === "object" && details !== null && "reason" in details && details.reason === reason;
}
