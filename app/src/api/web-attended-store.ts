import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { RunPriority } from "../runtime/run-queue";
import { isRecord } from "./command";
import { ApiResponseError } from "../runtime/errors";
import { HUMAN_TASK_POLICY_DEFAULTS } from "./human-task-policy-defaults";

export type WebAttendedRunRequestStatus = "requested" | "run_queued" | "blocked" | "cancelled";
export type RunResumeRequestStatus = "requested" | "reenqueued";

export interface WebAttendedRunRequest {
  readonly request_id: string;
  readonly scenario_version_id: string;
  readonly run_id: string | null;
  readonly human_task_id: string | null;
  readonly status: WebAttendedRunRequestStatus;
  readonly requested_by: string;
  readonly request_idempotency_key: string;
  readonly consent_summary: string;
  readonly consent_evidence_ref: string | null;
  readonly input_refs: readonly string[];
  readonly human_task_policy: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly requested_at: string;
  readonly updated_at: string;
  readonly legal_hold: boolean;
}

export interface WebAttendedRunRequestRow {
  readonly id: string;
  readonly scenario_version_id: string;
  readonly run_id: string | null;
  readonly human_task_id: string | null;
  readonly status: WebAttendedRunRequestStatus;
  readonly requested_by: string;
  readonly request_idempotency_key: string;
  readonly consent_summary: string;
  readonly consent_evidence_ref: string | null;
  readonly input_refs: unknown;
  readonly human_task_policy: unknown;
  readonly request_metadata: unknown;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly cursor_at: string;
  readonly legal_hold: boolean;
}

export interface RunResumeRequest {
  readonly request_id: string;
  readonly run_id: string;
  readonly human_task_id: string | null;
  readonly status: RunResumeRequestStatus;
  readonly previous_run_status: "suspended" | "resume_requested";
  readonly requested_by: string;
  readonly reason: string | null;
  readonly input_refs: readonly string[];
  readonly human_task_policy: Readonly<Record<string, unknown>>;
  readonly audit_correlation_id: string;
  readonly request_idempotency_key: string;
  readonly requested_at: string;
  readonly updated_at: string;
  readonly legal_hold: boolean;
}

export interface RunResumeRequestRow {
  readonly id: string;
  readonly run_id: string;
  readonly human_task_id: string | null;
  readonly status: RunResumeRequestStatus;
  readonly previous_run_status: "suspended" | "resume_requested";
  readonly requested_by: string;
  readonly reason: string | null;
  readonly input_refs: unknown;
  readonly human_task_policy: unknown;
  readonly audit_correlation_id: string;
  readonly request_idempotency_key: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly cursor_at: string;
  readonly legal_hold: boolean;
}

export interface WebAttendedCreateInput {
  readonly scenarioVersionId: string;
  readonly params: Record<string, unknown>;
  readonly asOf: string;
  readonly model: string | null;
  readonly priority: RunPriority;
  readonly humanTaskId: string | null;
  readonly consentSummary: string;
  readonly consentEvidenceRef: string | null;
  readonly inputRefs: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly legalHold: boolean;
}

export async function listWebAttendedRunRequests(
  client: PoolClient,
  tenantId: string,
  limit: number,
  cursor: { readonly createdAt: string; readonly id: string } | null,
  status: WebAttendedRunRequestStatus | undefined,
  runId: string | undefined,
  humanTaskId: string | undefined,
): Promise<WebAttendedRunRequestRow[]> {
  const values: unknown[] = [tenantId];
  const where = ["tenant_id = $1::uuid", "deleted_at IS NULL"];
  if (status !== undefined) {
    values.push(status);
    where.push(`status = $${values.length}`);
  }
  if (runId !== undefined) {
    values.push(runId);
    where.push(`run_id = $${values.length}::uuid`);
  }
  if (humanTaskId !== undefined) {
    values.push(humanTaskId);
    where.push(`human_task_id = $${values.length}::uuid`);
  }
  if (cursor !== null) {
    values.push(cursor.createdAt, cursor.id);
    where.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
  }
  values.push(limit + 1);
  const result = await client.query<WebAttendedRunRequestRow>(
    `SELECT id, scenario_version_id::text AS scenario_version_id, run_id::text AS run_id, human_task_id::text AS human_task_id,
            status, requested_by, request_idempotency_key, consent_summary, consent_evidence_ref, input_refs,
            human_task_policy, request_metadata, created_at, created_at::text AS cursor_at, updated_at, legal_hold
       FROM web_attended_run_requests
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT $${values.length}`,
    values,
  );
  return result.rows;
}

export async function listRunResumeRequests(
  client: PoolClient,
  tenantId: string,
  limit: number,
  cursor: { readonly createdAt: string; readonly id: string } | null,
  status: RunResumeRequestStatus | undefined,
  runId: string | undefined,
  humanTaskId: string | undefined,
): Promise<RunResumeRequestRow[]> {
  const values: unknown[] = [tenantId];
  const where = ["tenant_id = $1::uuid", "deleted_at IS NULL"];
  if (status !== undefined) {
    values.push(status);
    where.push(`status = $${values.length}`);
  }
  if (runId !== undefined) {
    values.push(runId);
    where.push(`run_id = $${values.length}::uuid`);
  }
  if (humanTaskId !== undefined) {
    values.push(humanTaskId);
    where.push(`human_task_id = $${values.length}::uuid`);
  }
  if (cursor !== null) {
    values.push(cursor.createdAt, cursor.id);
    where.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
  }
  values.push(limit + 1);
  const result = await client.query<RunResumeRequestRow>(
    `SELECT id, run_id::text AS run_id, human_task_id::text AS human_task_id, status, previous_run_status,
            requested_by, reason, input_refs, human_task_policy, audit_correlation_id::text AS audit_correlation_id,
            request_idempotency_key, created_at, created_at::text AS cursor_at, updated_at, legal_hold
       FROM run_resume_requests
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT $${values.length}`,
    values,
  );
  return result.rows;
}

export async function insertWebAttendedRunRequest(
  client: PoolClient,
  tenantId: string,
  input: WebAttendedCreateInput & {
    readonly runId: string;
    readonly requestedBy: string;
    readonly requestIdempotencyKey: string;
  },
): Promise<WebAttendedRunRequest> {
  const result = await client.query<WebAttendedRunRequestRow>(
    `INSERT INTO web_attended_run_requests
       (id, tenant_id, scenario_version_id, run_id, human_task_id, status, requested_by, request_idempotency_key,
        consent_summary, consent_evidence_ref, input_refs, human_task_policy, request_metadata, legal_hold)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'run_queued', $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13)
     RETURNING id, scenario_version_id::text AS scenario_version_id, run_id::text AS run_id, human_task_id::text AS human_task_id,
               status, requested_by, request_idempotency_key, consent_summary, consent_evidence_ref, input_refs,
               human_task_policy, request_metadata, created_at, created_at::text AS cursor_at, updated_at, legal_hold`,
    [
      randomUUID(),
      tenantId,
      input.scenarioVersionId,
      input.runId,
      input.humanTaskId,
      input.requestedBy,
      input.requestIdempotencyKey,
      input.consentSummary,
      input.consentEvidenceRef,
      JSON.stringify(input.inputRefs),
      JSON.stringify(HUMAN_TASK_POLICY_DEFAULTS),
      JSON.stringify(input.metadata),
      input.legalHold,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "web_attended_request_missing_after_insert" });
  return mapWebAttendedRunRequest(row);
}

export async function assertHumanTaskExists(client: PoolClient, tenantId: string, humanTaskId: string): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM human_tasks WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [tenantId, humanTaskId],
  );
  if (result.rowCount === 0) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "human_task_not_found" });
  }
}

export function mapWebAttendedRunRequest(row: WebAttendedRunRequestRow): WebAttendedRunRequest {
  return {
    request_id: row.id,
    scenario_version_id: row.scenario_version_id,
    run_id: row.run_id,
    human_task_id: row.human_task_id,
    status: row.status,
    requested_by: row.requested_by,
    request_idempotency_key: row.request_idempotency_key,
    consent_summary: row.consent_summary,
    consent_evidence_ref: row.consent_evidence_ref,
    input_refs: jsonStringArray(row.input_refs, "web_attended_run_requests.input_refs"),
    human_task_policy: jsonRecord(row.human_task_policy, "web_attended_run_requests.human_task_policy"),
    metadata: jsonRecord(row.request_metadata, "web_attended_run_requests.request_metadata"),
    requested_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    legal_hold: row.legal_hold,
  };
}

export function mapRunResumeRequest(row: RunResumeRequestRow): RunResumeRequest {
  return {
    request_id: row.id,
    run_id: row.run_id,
    human_task_id: row.human_task_id,
    status: row.status,
    previous_run_status: row.previous_run_status,
    requested_by: row.requested_by,
    reason: row.reason,
    input_refs: jsonStringArray(row.input_refs, "run_resume_requests.input_refs"),
    human_task_policy: jsonRecord(row.human_task_policy, "run_resume_requests.human_task_policy"),
    audit_correlation_id: row.audit_correlation_id,
    request_idempotency_key: row.request_idempotency_key,
    requested_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    legal_hold: row.legal_hold,
  };
}

function jsonStringArray(value: unknown, field: string): readonly string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "invalid_json_array", field });
}

function jsonRecord(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (isRecord(value)) return value;
  throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "invalid_json_object", field });
}
