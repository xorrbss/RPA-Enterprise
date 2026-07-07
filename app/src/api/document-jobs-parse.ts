import { isRecord } from "./command";
import {
  parseDocumentFieldSchema,
  DocumentExtractorInputError,
  type DocumentExtractionField,
  type DocumentFieldSchema,
} from "./document-idp-extractor";
import type { DocumentJobStatus } from "./document-jobs-store";
import { ApiResponseError } from "../runtime/errors";
import { UUID_RE } from "./server-shared";

export interface CreateDocumentJobBody {
  source_artifact_id: string;
  document_type: string;
  field_schema: readonly DocumentFieldSchema[];
}

export interface ExternalDocumentExtractionFieldInput {
  readonly key: string;
  readonly value: string | null;
  readonly confidence: number;
}

export interface ExternalDocumentExtractionBody {
  readonly providerAlias: string;
  readonly receiptId: string;
  readonly normalizedSchemaRef: string;
  readonly evidenceRef: string | null;
  readonly fields: readonly ExternalDocumentExtractionFieldInput[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly legalHold: boolean;
}

export function parseCreateBody(raw: unknown): CreateDocumentJobBody {
  const body = parseKnownBody(raw, ["source_artifact_id", "document_type", "field_schema"]);
  const sourceArtifactId = requiredUuid(body.source_artifact_id, "source_artifact_id");
  const documentType = requiredText(body.document_type, "document_type");
  const fieldSchema = parseSchemaForApi(body.field_schema);
  return { source_artifact_id: sourceArtifactId, document_type: documentType, field_schema: fieldSchema };
}

export function parseExternalExtractionBody(raw: unknown): ExternalDocumentExtractionBody {
  const body = parseKnownBody(raw, [
    "provider_alias",
    "receipt_id",
    "normalized_schema_ref",
    "evidence_ref",
    "fields",
    "metadata",
    "legal_hold",
  ]);
  return {
    providerAlias: requiredSafeText(body.provider_alias, "provider_alias", 1, 120),
    receiptId: requiredSafeText(body.receipt_id, "receipt_id", 1, 160),
    normalizedSchemaRef: requiredSafeText(body.normalized_schema_ref, "normalized_schema_ref", 1, 160),
    evidenceRef: body.evidence_ref === undefined || body.evidence_ref === null
      ? null
      : requiredSafeText(body.evidence_ref, "evidence_ref", 1, 240),
    fields: parseExternalFields(body.fields),
    metadata: parseSafeMetadata(body.metadata),
    legalHold: body.legal_hold === undefined ? false : requiredBoolean(body.legal_hold, "legal_hold"),
  };
}

function parseExternalFields(raw: unknown): readonly ExternalDocumentExtractionFieldInput[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 200) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_external_fields" });
  }
  const seen = new Set<string>();
  return raw.map((item, index) => {
    if (!isRecord(item)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_external_field", index });
    const body = parseKnownBody(item, ["key", "value", "confidence"]);
    const key = requiredSafeText(body.key, `fields.${index}.key`, 1, 80);
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_external_field_key", field: key });
    }
    if (seen.has(key)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "duplicate_external_field", field: key });
    seen.add(key);
    const value = normalizeExternalValue(body.value, `fields.${index}.value`);
    const confidence = requiredConfidence(body.confidence, `fields.${index}.confidence`);
    return { key, value, confidence };
  });
}

export function normalizeExternalFields(
  schema: readonly DocumentFieldSchema[],
  inputFields: readonly ExternalDocumentExtractionFieldInput[],
): {
  readonly status: "completed" | "validation_required";
  readonly fields: readonly DocumentExtractionField[];
  readonly missingFields: readonly string[];
} {
  const schemaByKey = new Map(schema.map((field) => [field.key, field]));
  for (const input of inputFields) {
    if (!schemaByKey.has(input.key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "external_field_not_in_schema", field: input.key });
    }
  }
  const byKey = new Map(inputFields.map((field) => [field.key, field]));
  const fields = schema.map((field): DocumentExtractionField => {
    const input = byKey.get(field.key);
    if (input === undefined || input.value === null || input.value.trim().length === 0) {
      return { key: field.key, label: field.label, value: null, confidence: 0, status: "missing", source: "external_idp" };
    }
    const status = input.confidence >= field.minConfidence ? "extracted" : "low_confidence";
    return {
      key: field.key,
      label: field.label,
      value: input.value,
      confidence: input.confidence,
      status,
      source: "external_idp",
    };
  });
  const missingFields = fields
    .filter((field, index) => field.status === "low_confidence" || (field.status === "missing" && schema[index]?.required === true))
    .map((field) => field.key);
  return { status: missingFields.length > 0 ? "validation_required" : "completed", fields, missingFields };
}

export function parseSchemaForApi(value: unknown): readonly DocumentFieldSchema[] {
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

export function requireEmptyBody(raw: unknown): void {
  if (raw === undefined || raw === null) return;
  if (isRecord(raw) && Object.keys(raw).length === 0) return;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "body_must_be_empty" });
}

export function validateJobId(value: string): string {
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

function requiredSafeText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  const text = value.trim();
  if (text.length < min || text.length > max) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  assertSafeEvidenceString(text, field);
  return text;
}

function normalizeExternalValue(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value === "string") {
    if (value.length > 2000) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "external_field_value_too_large", field });
    assertSafeEvidenceString(value, field);
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_external_field_value", field });
}

function requiredConfidence(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_external_field_confidence", field });
  }
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  return value;
}

function parseSafeMetadata(value: unknown): Readonly<Record<string, unknown>> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_must_be_object" });
  if (JSON.stringify(value).length > 4000) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_too_large" });
  assertSafeMetadata(value, "metadata", 0);
  return value;
}

function assertSafeMetadata(value: unknown, path: string, depth: number): void {
  if (depth > 4) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_too_deep", path });
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value === "string") {
    assertSafeEvidenceString(value, path);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 50) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_array_too_large", path });
    value.forEach((item, index) => assertSafeMetadata(item, `${path}.${index}`, depth + 1));
    return;
  }
  if (!isRecord(value)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_value_not_json", path });
  const entries = Object.entries(value);
  if (entries.length > 50) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_object_too_large", path });
  for (const [key, child] of entries) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || forbiddenMetadataKey(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_secret_or_endpoint_key_forbidden", path: `${path}.${key}` });
    }
    assertSafeMetadata(child, `${path}.${key}`, depth + 1);
  }
}

function forbiddenMetadataKey(key: string): boolean {
  return /(^|[_\-.])(secret|token|password|credential|authorization|cookie|webhook_url|endpoint_url|url|dsn|smtp|raw_ocr_text|ocr_text|full_text|payload|body)([_\-.]|$)/i.test(key);
}

function assertSafeEvidenceString(value: string, field: string): void {
  if (/https?:\/\//i.test(value) || /hooks\.slack\.com/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "raw_endpoint_url_forbidden", field });
  }
  if (/\bbearer\s+[a-z0-9._~+/=-]{8,}/i.test(value) || /\b(token|password|secret)=/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_material_forbidden", field });
  }
}

export function statusFilter(value: unknown): DocumentJobStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "created" || value === "extracted" || value === "validation_required" || value === "validated" || value === "failed") return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_document_job_status" });
}
