import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import type { ObjectRef } from "../../../ts/core-types";
import {
  SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
  type CorrelationId,
  type IdempotencyKey,
  type IsoDateTime,
} from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { HUMAN_TASK_DEFAULT_TIMEOUT_MS } from "../runtime/human-task-timeout-policy";
import { isRecord, runIdempotentCommand, type CommandResponse } from "./command";
import {
  extractDocumentFields,
  parseDocumentFieldSchema,
  DocumentExtractorInputError,
  type DocumentExtractionField,
  type DocumentFieldSchema,
} from "./document-idp-extractor";
import { ApiResponseError } from "./errors";
import { paginate, parsePageParams } from "./list-query";
import { requirePrincipal, type ApiServerDeps } from "./server";
import { UUID_RE } from "./server-shared";

const ARTIFACT_READ_AUDIT_RETENTION_DAYS = 90;

type DocumentJobStatus = "created" | "extracted" | "validation_required" | "validated" | "failed";
type DocumentExtractionStatus = "completed" | "validation_required" | "failed";

interface DocumentJobRow {
  id: string;
  source_artifact_id: string;
  source_run_id: string;
  document_type: string;
  field_schema: unknown;
  status: DocumentJobStatus;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  cursor_at: string;
}

interface DocumentExtractionRow {
  id: string;
  document_job_id: string;
  engine: "built_in_deterministic_text_v1";
  status: DocumentExtractionStatus;
  fields: unknown;
  missing_fields: unknown;
  validation_human_task_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface SourceArtifactRow {
  id: string;
  run_id: string | null;
  type: string;
  media_type: string | null;
  object_ref: string;
  redaction_status: string;
}

interface CreateDocumentJobBody {
  source_artifact_id: string;
  document_type: string;
  field_schema: readonly DocumentFieldSchema[];
}

export function registerDocumentJobRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/document-jobs", { config: { rbacAction: "document_job.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);
    const status = statusFilter(query.status);
    const rows = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
      const result = await client.query<DocumentJobRow>(
        `SELECT id, source_artifact_id, source_run_id, document_type, field_schema, status,
                created_by, created_at, updated_at, created_at::text AS cursor_at
           FROM document_jobs
          WHERE tenant_id = $1::uuid
            AND deleted_at IS NULL
            AND ($2::text IS NULL OR status = $2)
            AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT $5`,
        [principal.tenantId, status ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );
      return result.rows;
    });
    reply.code(200).send(paginate(rows, limit, (row) => ({ createdAt: row.cursor_at, id: row.id }), mapJob));
  });

  app.post("/v1/document-jobs", { config: { rbacAction: "document_job.manage" } }, async (request, reply) => {
    const body = parseCreateBody(request.body);
    const result = await runIdempotentCommand(deps, request, "createDocumentJob", "/v1/document-jobs", (client, tenantId) =>
      createDocumentJob(client, tenantId, request, body),
    );
    reply.code(result.status).send(result.body);
  });

  app.get<{ Params: { jobId: string } }>(
    "/v1/document-jobs/:jobId",
    { config: { rbacAction: "document_job.read" } },
    async (request, reply) => {
      const row = await requireDocumentJob(deps, request, request.params.jobId);
      reply.code(200).send(mapJob(row));
    },
  );

  app.post<{ Params: { jobId: string } }>(
    "/v1/document-jobs/:jobId/extract",
    { config: { rbacAction: "document_job.manage" } },
    async (request, reply) => {
      requireEmptyBody(request.body);
      const jobId = validateJobId(request.params.jobId);
      const result = await runIdempotentCommand(deps, request, "extractDocumentJob", `/v1/document-jobs/${jobId}/extract`, (client, tenantId) =>
        extractDocumentJob(deps, client, tenantId, request, jobId),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.get<{ Params: { jobId: string } }>(
    "/v1/document-jobs/:jobId/extraction",
    { config: { rbacAction: "document_job.read" } },
    async (request, reply) => {
      const jobId = validateJobId(request.params.jobId);
      const principal = requirePrincipal(request);
      const row = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
        await assertDocumentJobExists(client, jobId);
        return selectExtraction(client, jobId);
      });
      if (row === null) throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "document_extraction_not_found" });
      reply.code(200).send(mapExtraction(row));
    },
  );

  app.post<{ Params: { jobId: string } }>(
    "/v1/document-jobs/:jobId/validation-task",
    { config: { rbacAction: "document_job.manage" } },
    async (request, reply) => {
      requireEmptyBody(request.body);
      const jobId = validateJobId(request.params.jobId);
      const result = await runIdempotentCommand(
        deps,
        request,
        "createDocumentValidationTask",
        `/v1/document-jobs/${jobId}/validation-task`,
        (client, tenantId) => createValidationTask(client, tenantId, request, jobId),
      );
      reply.code(result.status).send(result.body);
    },
  );
}

async function createDocumentJob(
  client: PoolClient,
  tenantId: string,
  request: FastifyRequest,
  body: CreateDocumentJobBody,
): Promise<CommandResponse> {
  const artifact = await selectVisibleSourceArtifact(client, body.source_artifact_id);
  if (artifact === null) throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "source_artifact_not_found" });
  if (artifact.run_id === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "source_artifact_requires_run" });
  }
  assertSupportedSourceArtifact(artifact);
  const result = await client.query<DocumentJobRow>(
    `INSERT INTO document_jobs
       (id, tenant_id, source_artifact_id, source_run_id, document_type, field_schema, created_by)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::jsonb, $7)
     RETURNING id, source_artifact_id, source_run_id, document_type, field_schema, status,
               created_by, created_at, updated_at, created_at::text AS cursor_at`,
    [
      randomUUID(),
      tenantId,
      body.source_artifact_id,
      artifact.run_id,
      body.document_type,
      JSON.stringify(body.field_schema),
      requirePrincipal(request).subjectId,
    ],
  );
  return { status: 201, body: mapJob(result.rows[0]) };
}

async function extractDocumentJob(
  deps: ApiServerDeps,
  client: PoolClient,
  tenantId: string,
  request: FastifyRequest,
  jobId: string,
): Promise<CommandResponse> {
  if (deps.artifactStore === undefined || deps.securityAudit === undefined) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "document_idp_artifact_boundary_not_configured" });
  }
  const job = await selectDocumentJob(client, jobId);
  if (job === null) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  const artifact = await selectVisibleSourceArtifact(client, job.source_artifact_id);
  if (artifact === null) throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "source_artifact_not_found" });
  assertSupportedSourceArtifact(artifact);
  const content = await deps.artifactStore.get(artifact.object_ref as ObjectRef);
  if (content === null) throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "source_artifact_object_missing" });
  await recordArtifactRead(deps, request, artifact);

  const schema = parseSchemaForApi(job.field_schema);
  const extracted = extractDocumentFields(content, schema);
  const status = extracted.status;
  const extraction = await upsertExtraction(client, tenantId, job.id, extracted.fields, extracted.missingFields, status);
  await client.query(
    `UPDATE document_jobs SET status=$3, updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    [tenantId, job.id, status === "completed" ? "extracted" : "validation_required"],
  );
  return { status: 200, body: mapExtraction(extraction) };
}

async function createValidationTask(
  client: PoolClient,
  tenantId: string,
  request: FastifyRequest,
  jobId: string,
): Promise<CommandResponse> {
  const job = await selectDocumentJob(client, jobId);
  if (job === null) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  const extraction = await selectExtraction(client, jobId);
  if (extraction === null) throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "document_extraction_not_found" });
  if (extraction.status !== "validation_required") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "document_validation_not_required" });
  }
  if (extraction.validation_human_task_id !== null) {
    return { status: 200, body: await validationTaskResponse(client, extraction.validation_human_task_id) };
  }
  const fields = fieldRows(extraction.fields);
  const missing = stringArray(extraction.missing_fields);
  const schema = parseSchemaForApi(job.field_schema);
  const reviewFields = schema
    .filter((field) => missing.includes(field.key))
    .map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      required: true,
      help_text: "추출 결과가 없거나 신뢰도가 낮아 검토가 필요합니다.",
    }));
  const humanTaskId = randomUUID();
  await client.query(
    `INSERT INTO human_tasks
       (id, tenant_id, run_id, kind, state, assignee_role, on_timeout, payload, result_schema, artifact_refs, expires_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'validation', 'open', 'reviewer', 'fail', $4::jsonb, $5::jsonb, $6::jsonb,
             now() + ($7::bigint * interval '1 millisecond'))`,
    [
      humanTaskId,
      tenantId,
      job.source_run_id,
      JSON.stringify({
        document_job_id: job.id,
        document_type: job.document_type,
        review_reason: "missing_or_low_confidence_fields",
        extracted_fields: fields,
      }),
      JSON.stringify({ version: "business_form_v1", fields: reviewFields }),
      JSON.stringify([job.source_artifact_id]),
      HUMAN_TASK_DEFAULT_TIMEOUT_MS,
    ],
  );
  await client.query(
    `UPDATE document_extractions
        SET validation_human_task_id=$3::uuid, updated_at=now()
      WHERE tenant_id=$1::uuid AND document_job_id=$2::uuid`,
    [tenantId, job.id, humanTaskId],
  );
  await client.query(
    `UPDATE document_jobs SET status='validation_required', updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    [tenantId, job.id],
  );
  return { status: 201, body: await validationTaskResponse(client, humanTaskId) };
}

async function upsertExtraction(
  client: PoolClient,
  tenantId: string,
  jobId: string,
  fields: readonly DocumentExtractionField[],
  missingFields: readonly string[],
  status: "completed" | "validation_required",
): Promise<DocumentExtractionRow> {
  const result = await client.query<DocumentExtractionRow>(
    `INSERT INTO document_extractions
       (id, tenant_id, document_job_id, status, fields, missing_fields)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6::jsonb)
     ON CONFLICT (tenant_id, document_job_id)
     DO UPDATE SET status=EXCLUDED.status,
                   fields=EXCLUDED.fields,
                   missing_fields=EXCLUDED.missing_fields,
                   updated_at=now()
     RETURNING id, document_job_id, engine, status, fields, missing_fields, validation_human_task_id, created_at, updated_at`,
    [randomUUID(), tenantId, jobId, status, JSON.stringify(fields), JSON.stringify(missingFields)],
  );
  return result.rows[0];
}

async function recordArtifactRead(deps: ApiServerDeps, request: FastifyRequest, artifact: SourceArtifactRow): Promise<void> {
  if (deps.securityAudit === undefined) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "document_idp_audit_not_configured" });
  const principal = requirePrincipal(request);
  const occurredAt = new Date();
  await deps.securityAudit.recordDecision(
    {
      tenantId: principal.tenantId,
      actor: { subjectId: principal.subjectId, roles: principal.roles },
      action: "artifact.read",
      outcome: "allow",
      resource: { kind: "artifact", id: artifact.id },
      reason: "document_idp_extraction_source_read",
      correlationId: request.correlationId as CorrelationId,
      idempotencyKey: randomUUID() as IdempotencyKey,
      occurredAt: occurredAt.toISOString() as IsoDateTime,
      retentionUntil: new Date(occurredAt.getTime() + ARTIFACT_READ_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString() as IsoDateTime,
      payloadSchemaRef: SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
      failClosed: true,
      payload: {
        decision_kind: "artifact.read",
        artifact_id: artifact.id,
        redaction_status: artifact.redaction_status,
        consumer: "document_idp",
      },
    },
    { artifact_id: artifact.id, consumer: "document_idp" },
  );
}

async function requireDocumentJob(deps: ApiServerDeps, request: FastifyRequest, rawId: string): Promise<DocumentJobRow> {
  const id = validateJobId(rawId);
  const principal = requirePrincipal(request);
  const row = await withTenantTx(deps.pool, principal.tenantId, (client) => selectDocumentJob(client, id));
  if (row === null) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return row;
}

async function assertDocumentJobExists(client: PoolClient, id: string): Promise<void> {
  const row = await selectDocumentJob(client, id);
  if (row === null) throw new ApiResponseError("RESOURCE_NOT_FOUND");
}

async function selectDocumentJob(client: PoolClient, id: string): Promise<DocumentJobRow | null> {
  const result = await client.query<DocumentJobRow>(
    `SELECT id, source_artifact_id, source_run_id, document_type, field_schema, status,
            created_by, created_at, updated_at, created_at::text AS cursor_at
       FROM document_jobs
      WHERE id=$1::uuid AND deleted_at IS NULL`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function selectExtraction(client: PoolClient, jobId: string): Promise<DocumentExtractionRow | null> {
  const result = await client.query<DocumentExtractionRow>(
    `SELECT id, document_job_id, engine, status, fields, missing_fields, validation_human_task_id, created_at, updated_at
       FROM document_extractions
      WHERE document_job_id=$1::uuid AND deleted_at IS NULL`,
    [jobId],
  );
  return result.rows[0] ?? null;
}

async function selectVisibleSourceArtifact(client: PoolClient, id: string): Promise<SourceArtifactRow | null> {
  const result = await client.query<SourceArtifactRow>(
    `SELECT id, run_id::text AS run_id, type, media_type, object_ref, redaction_status
       FROM artifacts
      WHERE id=$1::uuid`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function validationTaskResponse(client: PoolClient, humanTaskId: string): Promise<Record<string, unknown>> {
  const result = await client.query<{
    id: string;
    state: string;
    result_schema: unknown;
    artifact_refs: unknown;
  }>(
    `SELECT id, state, result_schema, artifact_refs FROM human_tasks WHERE id=$1::uuid`,
    [humanTaskId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "validation_task_not_found" });
  return {
    human_task_id: row.id,
    state: row.state,
    result_schema: recordOrEmpty(row.result_schema),
    artifact_refs: stringArray(row.artifact_refs),
  };
}

function parseCreateBody(raw: unknown): CreateDocumentJobBody {
  const body = parseKnownBody(raw, ["source_artifact_id", "document_type", "field_schema"]);
  const sourceArtifactId = requiredUuid(body.source_artifact_id, "source_artifact_id");
  const documentType = requiredText(body.document_type, "document_type");
  const fieldSchema = parseSchemaForApi(body.field_schema);
  return { source_artifact_id: sourceArtifactId, document_type: documentType, field_schema: fieldSchema };
}

function parseSchemaForApi(value: unknown): readonly DocumentFieldSchema[] {
  try {
    return parseDocumentFieldSchema(value);
  } catch (err) {
    if (err instanceof DocumentExtractorInputError) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_field_schema", message: err.message });
    }
    throw err;
  }
}

function parseKnownBody(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_body" });
  const extra = Object.keys(raw).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unknown_field", field: extra });
  return raw;
}

function requireEmptyBody(raw: unknown): void {
  if (raw === undefined || raw === null) return;
  if (isRecord(raw) && Object.keys(raw).length === 0) return;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "body_must_be_empty" });
}

function validateJobId(value: string): string {
  if (!UUID_RE.test(value)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return value;
}

function requiredUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  }
  return value;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 120) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  }
  return value.trim();
}

function statusFilter(value: unknown): DocumentJobStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "created" || value === "extracted" || value === "validation_required" || value === "validated" || value === "failed") return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_document_job_status" });
}

function assertSupportedSourceArtifact(artifact: SourceArtifactRow): void {
  const mediaType = artifact.media_type?.split(";")[0]?.trim().toLowerCase();
  if (mediaType === undefined || mediaType.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unsupported_document_artifact_media_type" });
  }
  if (mediaType.startsWith("text/") || mediaType === "application/json" || mediaType === "application/csv") return;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unsupported_document_artifact_media_type", media_type: artifact.media_type });
}

function fieldRows(value: unknown): readonly DocumentExtractionField[] {
  return Array.isArray(value)
    ? value.filter((item): item is DocumentExtractionField => isRecord(item) && typeof item.key === "string" && typeof item.label === "string")
    : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function mapJob(row: DocumentJobRow): Record<string, unknown> {
  return {
    document_job_id: row.id,
    source_artifact_id: row.source_artifact_id,
    source_run_id: row.source_run_id,
    document_type: row.document_type,
    field_schema: row.field_schema,
    status: row.status,
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function mapExtraction(row: DocumentExtractionRow): Record<string, unknown> {
  return {
    document_extraction_id: row.id,
    document_job_id: row.document_job_id,
    engine: row.engine,
    status: row.status,
    fields: Array.isArray(row.fields) ? row.fields : [],
    missing_fields: stringArray(row.missing_fields),
    validation_human_task_id: row.validation_human_task_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
