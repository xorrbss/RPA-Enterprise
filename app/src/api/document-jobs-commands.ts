import { randomUUID } from "node:crypto";

import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import type { ObjectRef } from "../../../ts/core-types";
import {
  SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
  type CorrelationId,
  type IdempotencyKey,
  type IsoDateTime,
} from "../../../ts/security-middleware-contract";
import { HUMAN_TASK_DEFAULT_TIMEOUT_MS } from "../runtime/human-task-timeout-policy";
import { type CommandResponse } from "./command";
import { extractDocumentFields, type DocumentExtractionField } from "./document-idp-extractor";
import {
  normalizeExternalFields,
  parseSchemaForApi,
  type CreateDocumentJobBody,
  type ExternalDocumentExtractionBody,
} from "./document-jobs-parse";
import {
  assertProviderReceiptUnused,
  assertSupportedSourceArtifact,
  fieldRows,
  mapExtraction,
  mapJob,
  selectDocumentJob,
  selectExtraction,
  selectVisibleSourceArtifact,
  stringArray,
  validationTaskResponse,
  type DocumentExtractionRow,
  type DocumentJobRow,
  type SourceArtifactRow,
} from "./document-jobs-store";
import { ApiResponseError } from "../runtime/errors";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";

const ARTIFACT_READ_AUDIT_RETENTION_DAYS = 90;

export async function createDocumentJob(
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

export async function extractDocumentJob(
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
  const existing = await selectExtraction(client, job.id);
  if (existing !== null && existing.engine !== "built_in_deterministic_text_v1") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "document_extraction_already_recorded" });
  }
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

export async function recordExternalDocumentExtraction(
  client: PoolClient,
  tenantId: string,
  jobId: string,
  body: ExternalDocumentExtractionBody,
): Promise<CommandResponse> {
  const job = await selectDocumentJob(client, jobId);
  if (job === null) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  await assertProviderReceiptUnused(client, tenantId, jobId, body.providerAlias, body.receiptId);
  const existing = await selectExtraction(client, jobId);
  if (
    existing !== null &&
    (existing.engine !== "external_idp_adapter_v1" ||
      existing.provider_alias !== body.providerAlias ||
      existing.provider_receipt_id !== body.receiptId)
  ) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "document_extraction_already_recorded" });
  }
  if (existing !== null) return { status: 202, body: mapExtraction(existing) };

  const normalized = normalizeExternalFields(parseSchemaForApi(job.field_schema), body.fields);
  const extraction = await upsertExternalExtraction(client, tenantId, job.id, normalized, body);
  await client.query(
    `UPDATE document_jobs SET status=$3, updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    [tenantId, job.id, normalized.status === "completed" ? "extracted" : "validation_required"],
  );
  return { status: 202, body: mapExtraction(extraction) };
}

export async function createValidationTask(
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
     RETURNING id, document_job_id, engine, status, provider_alias, provider_receipt_id,
               normalized_schema_ref, evidence_ref, provider_metadata, fields, missing_fields,
               validation_human_task_id, created_at, updated_at`,
    [randomUUID(), tenantId, jobId, status, JSON.stringify(fields), JSON.stringify(missingFields)],
  );
  return result.rows[0];
}

async function upsertExternalExtraction(
  client: PoolClient,
  tenantId: string,
  jobId: string,
  normalized: {
    readonly status: "completed" | "validation_required";
    readonly fields: readonly DocumentExtractionField[];
    readonly missingFields: readonly string[];
  },
  body: ExternalDocumentExtractionBody,
): Promise<DocumentExtractionRow> {
  const result = await client.query<DocumentExtractionRow>(
    `INSERT INTO document_extractions
       (id, tenant_id, document_job_id, engine, status, provider_alias, provider_receipt_id,
        normalized_schema_ref, evidence_ref, provider_metadata, fields, missing_fields, legal_hold)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'external_idp_adapter_v1', $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12)
     ON CONFLICT (tenant_id, document_job_id)
     DO UPDATE SET status=EXCLUDED.status,
                   provider_alias=EXCLUDED.provider_alias,
                   provider_receipt_id=EXCLUDED.provider_receipt_id,
                   normalized_schema_ref=EXCLUDED.normalized_schema_ref,
                   evidence_ref=EXCLUDED.evidence_ref,
                   provider_metadata=EXCLUDED.provider_metadata,
                   fields=EXCLUDED.fields,
                   missing_fields=EXCLUDED.missing_fields,
                   legal_hold=EXCLUDED.legal_hold,
                   updated_at=now()
       WHERE document_extractions.engine='external_idp_adapter_v1'
         AND document_extractions.provider_alias=EXCLUDED.provider_alias
         AND document_extractions.provider_receipt_id=EXCLUDED.provider_receipt_id
     RETURNING id, document_job_id, engine, status, provider_alias, provider_receipt_id,
               normalized_schema_ref, evidence_ref, provider_metadata, fields, missing_fields,
               validation_human_task_id, created_at, updated_at`,
    [
      randomUUID(),
      tenantId,
      jobId,
      normalized.status,
      body.providerAlias,
      body.receiptId,
      body.normalizedSchemaRef,
      body.evidenceRef,
      JSON.stringify(body.metadata),
      JSON.stringify(normalized.fields),
      JSON.stringify(normalized.missingFields),
      body.legalHold,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "document_extraction_already_recorded" });
  return row;
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
