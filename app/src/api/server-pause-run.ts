import { randomUUID } from "node:crypto";

import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import type { RunState } from "../../../ts/state-machine-types";
import { ApiResponseError } from "./errors";
import { runIdempotentCommand, isRecord } from "./command";
import { appendGovernanceAudit } from "./role-assignments";
import { requirePrincipal, UUID_RE, type ApiServerDeps, type CommandResponse } from "./server-shared";

interface RunPauseRow {
  readonly status: RunState;
  readonly correlation_id: string | null;
  readonly bookmark: unknown;
}

interface OpenPauseRequestRow {
  readonly id: string;
  readonly status: "requested" | "accepted";
}

interface ParsedPauseBody {
  readonly reason: string | null;
}

const RUN_TERMINAL_SET: ReadonlySet<RunState> = new Set<RunState>([
  "completed",
  "cancelled",
  "failed_business",
  "failed_system",
]);

export async function pauseRun(
  deps: ApiServerDeps,
  runId: string,
  request: FastifyRequest,
): Promise<CommandResponse> {
  const principal = requirePrincipal(request);
  if (!UUID_RE.test(runId)) throw new ApiResponseError("RUN_NOT_FOUND");

  const body = parsePauseBody(request.body);
  return runIdempotentCommand(deps, request, "pauseRun", `/v1/runs/${runId}/pause`, async (client) =>
    applyPauseIntent(client, request, principal.tenantId, principal.subjectId, runId, body),
  );
}

async function applyPauseIntent(
  client: PoolClient,
  request: FastifyRequest,
  tenantId: string,
  actorSub: string,
  runId: string,
  body: ParsedPauseBody,
): Promise<CommandResponse> {
  const run = await client.query<RunPauseRow>(
    `SELECT status, correlation_id::text AS correlation_id, bookmark
       FROM runs
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
      FOR UPDATE`,
    [tenantId, runId],
  );
  const row = run.rows[0];
  if (row === undefined) throw new ApiResponseError("RUN_NOT_FOUND");
  if (RUN_TERMINAL_SET.has(row.status) || row.status === "completing") {
    throw new ApiResponseError("RUN_ALREADY_TERMINAL", { status: row.status });
  }

  const open = await client.query<OpenPauseRequestRow>(
    `SELECT id::text, status
       FROM run_pause_requests
      WHERE tenant_id = $1::uuid
        AND run_id = $2::uuid
        AND status IN ('requested','accepted')
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE`,
    [tenantId, runId],
  );
  const existing = open.rows[0];
  if (existing !== undefined) {
    await appendGovernanceAudit(client, request, "run.pause", "allow", "run_pause_replayed", {
      run_id: runId,
      pause_request_id: existing.id,
      previous_status: row.status,
      reason: body.reason,
    });
    return {
      status: 202,
      body: { run_id: runId, status: "pause_requested", pause_request_id: existing.id, previous_status: row.status },
    };
  }

  if (row.status === "suspended" && isOperatorPauseBookmark(row.bookmark)) {
    await appendGovernanceAudit(client, request, "run.pause", "allow", "run_already_operator_paused", {
      run_id: runId,
      previous_status: row.status,
      reason: body.reason,
    });
    return { status: 200, body: { run_id: runId, status: "suspended", previous_status: row.status } };
  }
  if (row.status !== "running") {
    throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", {
      reason: "run_pause_requires_running",
      status: row.status,
    });
  }

  const pauseRequestId = randomUUID();
  await client.query(
    `INSERT INTO run_pause_requests (id, tenant_id, run_id, requested_by, reason)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)`,
    [pauseRequestId, tenantId, runId, actorSub, body.reason],
  );
  await appendGovernanceAudit(client, request, "run.pause", "allow", "run_pause_requested", {
    run_id: runId,
    pause_request_id: pauseRequestId,
    previous_status: row.status,
    reason: body.reason,
  });
  return {
    status: 202,
    body: { run_id: runId, status: "pause_requested", pause_request_id: pauseRequestId, previous_status: row.status },
  };
}

function parsePauseBody(raw: unknown): ParsedPauseBody {
  if (raw === undefined || raw === null) return { reason: null };
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  for (const key of Object.keys(raw)) {
    if (key !== "reason") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unknown_field", field: key });
  }
  if (raw.reason === undefined || raw.reason === null) return { reason: null };
  if (typeof raw.reason !== "string" || raw.reason.trim().length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_reason" });
  }
  return { reason: raw.reason.trim() };
}

function isOperatorPauseBookmark(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    "reason" in value &&
    (value as { readonly reason?: unknown }).reason === "operator_pause"
  );
}
