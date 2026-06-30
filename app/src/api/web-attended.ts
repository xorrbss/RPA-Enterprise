import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import type { RunPriority } from "./run-queue";
import { createRunInTx } from "./server-create-run";
import { isRecord, runIdempotentCommand } from "./command";
import { ApiResponseError } from "./errors";
import { HUMAN_TASK_POLICY_DEFAULTS } from "./human-task-policy-defaults";
import { paginate, parsePageParams, uuidFilter } from "./list-query";
import { appendGovernanceAudit } from "./role-assignments";
import { requirePrincipal, type ApiServerDeps } from "./server";
import { UUID_RE } from "./server-shared";

type WebAttendedRunRequestStatus = "requested" | "run_queued" | "blocked" | "cancelled";
type RunResumeRequestStatus = "requested" | "reenqueued";

interface WebAttendedRunRequest {
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

interface WebAttendedRunRequestRow {
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

interface RunResumeRequest {
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

interface RunResumeRequestRow {
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

interface WebAttendedCreateInput {
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

const ISO_8601_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export function registerWebAttendedRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/web-attended/run-requests", { config: { rbacAction: "run.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const page = parsePageParams(query);
    const status = parseWebAttendedStatusFilter(query.status);
    const runId = uuidFilter(query.run_id, "invalid_run_id");
    const humanTaskId = uuidFilter(query.human_task_id, "invalid_human_task_id");
    const rows = await withTenantTx(deps.pool, principal.tenantId, (client) =>
      listWebAttendedRunRequests(client, principal.tenantId, page.limit, page.cursor, status, runId, humanTaskId),
    );
    reply.code(200).send(paginate(rows, page.limit, (row) => ({ createdAt: row.cursor_at, id: row.id }), mapWebAttendedRunRequest));
  });

  app.post("/v1/web-attended/run-requests", { config: { rbacAction: "run.create" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseCreateRequest(request.body);
    const idempotencyKey = requireIdempotencyHeader(request.headers["idempotency-key"]);
    const response = await runIdempotentCommand(
      deps,
      request,
      "createWebAttendedRunRequest",
      "/v1/web-attended/run-requests",
      async (client, tenantId) => {
        if (body.humanTaskId !== null) {
          await assertHumanTaskExists(client, tenantId, body.humanTaskId);
        }
        const runId = randomUUID();
        await createRunInTx(client, deps.enqueuer, {
          runId,
          tenantId,
          scenarioVersionId: body.scenarioVersionId,
          params: body.params,
          asOf: body.asOf,
          correlationId: request.correlationId,
          model: body.model,
          configuredPromptVersions: deps.aiGovernanceConfiguredPromptVersions,
          priority: body.priority,
        });
        const item = await insertWebAttendedRunRequest(client, tenantId, {
          ...body,
          runId,
          requestedBy: principal.subjectId,
          requestIdempotencyKey: idempotencyKey,
        });
        await appendGovernanceAudit(client, request, "run.create", "allow", "web_attended_run_requested", {
          request_id: item.request_id,
          run_id: runId,
          scenario_version_id: body.scenarioVersionId,
          human_task_id: body.humanTaskId,
        });
        return { status: 201, body: item };
      },
    );
    reply.code(response.status).send(response.body);
  });

  app.get("/v1/run-resume-requests", { config: { rbacAction: "run.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const page = parsePageParams(query);
    const status = parseRunResumeStatusFilter(query.status);
    const runId = uuidFilter(query.run_id, "invalid_run_id");
    const humanTaskId = uuidFilter(query.human_task_id, "invalid_human_task_id");
    const rows = await withTenantTx(deps.pool, principal.tenantId, (client) =>
      listRunResumeRequests(client, principal.tenantId, page.limit, page.cursor, status, runId, humanTaskId),
    );
    reply.code(200).send(paginate(rows, page.limit, (row) => ({ createdAt: row.cursor_at, id: row.id }), mapRunResumeRequest));
  });
}

async function listWebAttendedRunRequests(
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

async function listRunResumeRequests(
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

async function insertWebAttendedRunRequest(
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

async function assertHumanTaskExists(client: PoolClient, tenantId: string, humanTaskId: string): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM human_tasks WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [tenantId, humanTaskId],
  );
  if (result.rowCount === 0) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "human_task_not_found" });
  }
}

function parseCreateRequest(raw: unknown): WebAttendedCreateInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "web_attended_body_expected_object" });
  assertAllowedKeys(raw, ["scenario_version_id", "params", "model", "priority", "human_task_id", "consent", "metadata", "legal_hold"]);
  const scenarioVersionId = parseUuid(raw.scenario_version_id, "scenario_version_id");
  if (!isRecord(raw.params)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "params_object_required" });
  const params = raw.params;
  const consent = parseConsent(raw.consent);
  return {
    scenarioVersionId,
    params,
    asOf: parseAsOf(params.as_of),
    model: parseOptionalModel(raw.model),
    priority: parsePriority(raw.priority),
    humanTaskId: raw.human_task_id === undefined || raw.human_task_id === null ? null : parseUuid(raw.human_task_id, "human_task_id"),
    consentSummary: consent.summary,
    consentEvidenceRef: consent.evidenceRef,
    inputRefs: consent.inputRefs,
    metadata: parseMetadata(raw.metadata),
    legalHold: raw.legal_hold === undefined ? false : parseBoolean(raw.legal_hold, "legal_hold"),
  };
}

function parseConsent(raw: unknown): { readonly summary: string; readonly evidenceRef: string | null; readonly inputRefs: readonly string[] } {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "consent_object_required" });
  assertAllowedKeys(raw, ["summary", "evidence_ref", "input_refs"]);
  return {
    summary: parseSafeString(raw.summary, "consent.summary", 1, 1000),
    evidenceRef: raw.evidence_ref === undefined || raw.evidence_ref === null ? null : parseSafeString(raw.evidence_ref, "consent.evidence_ref", 1, 500),
    inputRefs: parseRefArray(raw.input_refs),
  };
}

function parseAsOf(raw: unknown): string {
  if (raw === undefined) return new Date().toISOString();
  if (typeof raw !== "string" || !isStrictIsoDateTime(raw)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_as_of" });
  }
  return raw;
}

function isStrictIsoDateTime(value: string): boolean {
  if (!ISO_8601_RE.test(value)) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  return true;
}

function parseOptionalModel(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  return parseSafeString(raw, "model", 1, 120);
}

function parsePriority(raw: unknown): RunPriority {
  if (raw === undefined) return "medium";
  if (raw === "low" || raw === "medium" || raw === "high" || raw === "critical") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_priority" });
}

function parseWebAttendedStatusFilter(raw: unknown): WebAttendedRunRequestStatus | undefined {
  if (raw === undefined) return undefined;
  if (raw === "requested" || raw === "run_queued" || raw === "blocked" || raw === "cancelled") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_web_attended_status" });
}

function parseRunResumeStatusFilter(raw: unknown): RunResumeRequestStatus | undefined {
  if (raw === undefined) return undefined;
  if (raw === "requested" || raw === "reenqueued") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_run_resume_status" });
}

function parseUuid(raw: unknown, field: string): string {
  if (typeof raw === "string" && UUID_RE.test(raw)) return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function parseRefArray(raw: unknown): readonly string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 50) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_input_refs" });
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const ref = parseSafeString(item, "input_refs", 1, 300);
    if (!seen.has(ref)) {
      seen.add(ref);
      refs.push(ref);
    }
  }
  return refs;
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
      if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || forbiddenMetadataKey(key)) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_secret_key_forbidden", field: `${field}.${key}` });
      }
      assertSafeMetadata(child, `${field}.${key}`, depth + 1);
    }
    return;
  }
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    return;
  }
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_metadata_value", field });
}

function forbiddenMetadataKey(key: string): boolean {
  return /(^|[_.-])(api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|credential|authorization|cookie|raw_payload|request_payload|response_payload|payload|body|raw_body)([_.-]|$)/i.test(key);
}

function parseSafeString(raw: unknown, field: string, min: number, max: number): string {
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  const value = raw.trim();
  if (value.length < min || value.length > max) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  assertSafeString(value, field);
  return value;
}

function assertSafeString(value: string, field: string): void {
  if (/\bbearer\s+[a-z0-9._~+/=-]{8,}/i.test(value) || /\b(token|password|secret)=/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_material_forbidden", field });
  }
}

function parseBoolean(raw: unknown, field: string): boolean {
  if (typeof raw === "boolean") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function assertAllowedKeys(raw: Record<string, unknown>, allowed: readonly string[]): void {
  const set = new Set(allowed);
  for (const key of Object.keys(raw)) {
    if (!set.has(key)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unknown_field", field: key });
  }
}

function requireIdempotencyHeader(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_idempotency_key", header: "Idempotency-Key" });
  }
  return raw;
}

function mapWebAttendedRunRequest(row: WebAttendedRunRequestRow): WebAttendedRunRequest {
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

function mapRunResumeRequest(row: RunResumeRequestRow): RunResumeRequest {
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
