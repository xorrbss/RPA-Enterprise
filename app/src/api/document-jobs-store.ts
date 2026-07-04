import type { PoolClient } from "pg";

import { isRecord } from "./command";
import type { DocumentExtractionField } from "./document-idp-extractor";
import { ApiResponseError } from "../runtime/errors";

export type DocumentJobStatus = "created" | "extracted" | "validation_required" | "validated" | "failed";
export type DocumentExtractionStatus = "completed" | "validation_required" | "failed";
export type DocumentExtractionEngine = "built_in_deterministic_text_v1" | "external_idp_adapter_v1";

export interface DocumentJobRow {
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

export interface DocumentExtractionRow {
  id: string;
  document_job_id: string;
  engine: DocumentExtractionEngine;
  status: DocumentExtractionStatus;
  provider_alias: string | null;
  provider_receipt_id: string | null;
  normalized_schema_ref: string | null;
  evidence_ref: string | null;
  provider_metadata: unknown;
  fields: unknown;
  missing_fields: unknown;
  validation_human_task_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface SourceArtifactRow {
  id: string;
  run_id: string | null;
  type: string;
  media_type: string | null;
  object_ref: string;
  redaction_status: string;
}

export async function assertProviderReceiptUnused(
  client: PoolClient,
  tenantId: string,
  jobId: string,
  providerAlias: string,
  receiptId: string,
): Promise<void> {
  const result = await client.query<{ document_job_id: string }>(
    `SELECT document_job_id
       FROM document_extractions
      WHERE tenant_id=$1::uuid
        AND provider_alias=$2
        AND provider_receipt_id=$3
        AND deleted_at IS NULL`,
    [tenantId, providerAlias, receiptId],
  );
  const row = result.rows[0];
  if (row !== undefined && row.document_job_id !== jobId) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "provider_receipt_already_used" });
  }
}

export async function assertDocumentJobExists(client: PoolClient, id: string): Promise<void> {
  const row = await selectDocumentJob(client, id);
  if (row === null) throw new ApiResponseError("RESOURCE_NOT_FOUND");
}

export async function selectDocumentJob(client: PoolClient, id: string): Promise<DocumentJobRow | null> {
  const result = await client.query<DocumentJobRow>(
    `SELECT id, source_artifact_id, source_run_id, document_type, field_schema, status,
            created_by, created_at, updated_at, created_at::text AS cursor_at
       FROM document_jobs
      WHERE id=$1::uuid AND deleted_at IS NULL`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function selectExtraction(client: PoolClient, jobId: string): Promise<DocumentExtractionRow | null> {
  const result = await client.query<DocumentExtractionRow>(
    `SELECT id, document_job_id, engine, status, provider_alias, provider_receipt_id,
            normalized_schema_ref, evidence_ref, provider_metadata, fields, missing_fields,
            validation_human_task_id, created_at, updated_at
       FROM document_extractions
      WHERE document_job_id=$1::uuid AND deleted_at IS NULL`,
    [jobId],
  );
  return result.rows[0] ?? null;
}

export async function selectVisibleSourceArtifact(client: PoolClient, id: string): Promise<SourceArtifactRow | null> {
  const result = await client.query<SourceArtifactRow>(
    `SELECT id, run_id::text AS run_id, type, media_type, object_ref, redaction_status
       FROM artifacts
      WHERE id=$1::uuid`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function validationTaskResponse(client: PoolClient, humanTaskId: string): Promise<Record<string, unknown>> {
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

export function assertSupportedSourceArtifact(artifact: SourceArtifactRow): void {
  const mediaType = artifact.media_type?.split(";")[0]?.trim().toLowerCase();
  if (mediaType === undefined || mediaType.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unsupported_document_artifact_media_type" });
  }
  if (mediaType.startsWith("text/") || mediaType === "application/json" || mediaType === "application/csv") return;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unsupported_document_artifact_media_type", media_type: artifact.media_type });
}

export function fieldRows(value: unknown): readonly DocumentExtractionField[] {
  return Array.isArray(value)
    ? value.filter((item): item is DocumentExtractionField => isRecord(item) && typeof item.key === "string" && typeof item.label === "string")
    : [];
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function mapJob(row: DocumentJobRow): Record<string, unknown> {
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

export function mapExtraction(row: DocumentExtractionRow): Record<string, unknown> {
  return {
    document_extraction_id: row.id,
    document_job_id: row.document_job_id,
    engine: row.engine,
    status: row.status,
    provider_alias: row.provider_alias,
    provider_receipt_id: row.provider_receipt_id,
    normalized_schema_ref: row.normalized_schema_ref,
    evidence_ref: row.evidence_ref,
    provider_metadata: recordOrEmpty(row.provider_metadata),
    fields: Array.isArray(row.fields) ? row.fields : [],
    missing_fields: stringArray(row.missing_fields),
    validation_human_task_id: row.validation_human_task_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
