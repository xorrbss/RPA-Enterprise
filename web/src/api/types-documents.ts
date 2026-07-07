import type { ListParams } from "./types-common";
import type { HumanTaskBusinessFormSchema } from "./types-human-tasks";

export type DocumentJobStatus = "created" | "extracted" | "validation_required" | "validated" | "failed";
export type DocumentExtractionStatus = "completed" | "validation_required" | "failed";
export type DocumentFieldType = "text" | "number" | "date" | "boolean";
export type DocumentFieldStatus = "extracted" | "missing" | "low_confidence";
export type DocumentFieldSource = "json" | "csv" | "pattern" | "label" | "missing" | "external_idp";
export type DocumentExtractionEngine = "built_in_deterministic_text_v1" | "external_idp_adapter_v1";

export interface DocumentFieldSchema {
  readonly key: string;
  readonly label?: string;
  readonly type?: DocumentFieldType;
  readonly required?: boolean;
  readonly aliases?: readonly string[];
  readonly patterns?: readonly string[];
  readonly min_confidence?: number;
}

export interface DocumentJobItem {
  readonly document_job_id: string;
  readonly source_artifact_id: string;
  readonly source_run_id: string;
  readonly document_type: string;
  readonly field_schema: readonly DocumentFieldSchema[];
  readonly status: DocumentJobStatus;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface DocumentJobListParams extends ListParams {
  readonly status?: DocumentJobStatus;
}

export interface DocumentJobCreateBody {
  readonly source_artifact_id: string;
  readonly document_type: string;
  readonly field_schema: readonly DocumentFieldSchema[];
}

export interface DocumentExtractionField {
  readonly key: string;
  readonly label: string;
  readonly value: string | null;
  readonly confidence: number;
  readonly status: DocumentFieldStatus;
  readonly source: DocumentFieldSource;
}

export interface ExternalDocumentExtractionField {
  readonly key: string;
  readonly value: string | number | boolean | null;
  readonly confidence: number;
}

export interface ExternalDocumentExtractionBody {
  readonly provider_alias: string;
  readonly receipt_id: string;
  readonly normalized_schema_ref: string;
  readonly evidence_ref?: string | null;
  readonly fields: readonly ExternalDocumentExtractionField[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly legal_hold?: boolean;
}

export interface DocumentExtraction {
  readonly document_extraction_id: string;
  readonly document_job_id: string;
  readonly engine: DocumentExtractionEngine;
  readonly status: DocumentExtractionStatus;
  readonly provider_alias: string | null;
  readonly provider_receipt_id: string | null;
  readonly normalized_schema_ref: string | null;
  readonly evidence_ref: string | null;
  readonly provider_metadata: Readonly<Record<string, unknown>>;
  readonly fields: readonly DocumentExtractionField[];
  readonly missing_fields: readonly string[];
  readonly validation_human_task_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface DocumentValidationTaskResult {
  readonly human_task_id: string;
  readonly state: string;
  readonly result_schema: HumanTaskBusinessFormSchema | Record<string, unknown>;
  readonly artifact_refs: readonly string[];
}
