import { ApiResponseError } from "../runtime/errors";
import { isRecord } from "./command";
import type {
  ProductionReadinessEvidenceInput,
  ProductionReadinessEvidenceStatus,
  ProductionReadinessEvidenceType,
} from "./production-readiness-evidence";

const CONTROLLED_PROD_RESTORE_RTO_MINUTES = 120;
const CONTROLLED_PROD_RESTORE_RPO_MINUTES = 15;

export function parseEvidenceTypeQuery(raw: unknown): ProductionReadinessEvidenceType | undefined {
  if (raw === undefined) return undefined;
  return parseEvidenceType(raw);
}

export function parseEvidenceRequest(raw: unknown): ProductionReadinessEvidenceInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "production_readiness_evidence_body_expected_object" });
  const allowed = new Set(["evidence_type", "status", "evidence_at", "expires_at", "summary", "evidence_ref", "metadata", "legal_hold"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "production_readiness_evidence_unknown_field", field: key });
    }
  }
  const evidenceType = parseEvidenceType(raw.evidence_type);
  const status = parseEvidenceStatus(raw.status);
  const evidenceAt = parseIsoDate(raw.evidence_at, "evidence_at");
  const expiresAt = raw.expires_at === undefined || raw.expires_at === null ? null : parseIsoDate(raw.expires_at, "expires_at");
  const now = Date.now();
  if (evidenceAt.getTime() > now + 5 * 60 * 1000) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "evidence_at_in_future" });
  }
  if (status === "valid") {
    if (expiresAt === null) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "expires_at_required_for_valid_evidence" });
    if (expiresAt.getTime() <= now) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "expires_at_must_be_future" });
  }
  if (expiresAt !== null && expiresAt.getTime() <= evidenceAt.getTime()) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "expires_at_must_be_after_evidence_at" });
  }
  const summary = parseBoundedString(raw.summary, "summary", 1, 1000);
  assertSafeEvidenceString(summary, "summary");
  const evidenceRef = raw.evidence_ref === undefined || raw.evidence_ref === null || raw.evidence_ref === ""
    ? null
    : parseEvidenceRef(raw.evidence_ref);
  const metadata = parseEvidenceMetadata(raw.metadata);
  assertEvidenceTypeMetadata(evidenceType, status, evidenceRef, metadata);
  const legalHold = raw.legal_hold === undefined ? false : parseBoolean(raw.legal_hold, "legal_hold");
  return { evidenceType, status, evidenceAt, expiresAt, summary, evidenceRef, metadata, legalHold };
}

function parseEvidenceType(raw: unknown): ProductionReadinessEvidenceType {
  if (
    raw === "external_alert_delivery" ||
    raw === "managed_backup_restore_drill" ||
    raw === "slo_oncall_signoff" ||
    raw === "observability_telemetry_wiring" ||
    raw === "support_training_completion"
  ) return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_production_readiness_evidence_type" });
}

function parseEvidenceStatus(raw: unknown): ProductionReadinessEvidenceStatus {
  if (raw === "valid" || raw === "failed") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_production_readiness_evidence_status" });
}

function parseIsoDate(raw: unknown, field: string): Date {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_iso_datetime", field });
  }
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_iso_datetime", field });
  }
  return date;
}

function parseEvidenceRef(raw: unknown): string {
  const value = parseBoundedString(raw, "evidence_ref", 1, 500);
  assertSafeEvidenceString(value, "evidence_ref");
  return value;
}

function parseEvidenceMetadata(raw: unknown): Readonly<Record<string, unknown>> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_must_be_object" });
  const encoded = JSON.stringify(raw);
  if (encoded.length > 4000) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_too_large" });
  assertSafeMetadata(raw, "metadata");
  return raw;
}

function assertEvidenceTypeMetadata(
  evidenceType: ProductionReadinessEvidenceType,
  status: ProductionReadinessEvidenceStatus,
  evidenceRef: string | null,
  metadata: Readonly<Record<string, unknown>>,
): void {
  if (status !== "valid") return;
  if (evidenceType === "external_alert_delivery") {
    assertExternalAlertDeliveryMetadata(evidenceRef, metadata);
    return;
  }
  if (evidenceType === "managed_backup_restore_drill") {
    assertManagedBackupRestoreMetadata(evidenceRef, metadata);
    return;
  }
  if (evidenceType === "observability_telemetry_wiring") {
    assertObservabilityTelemetryWiringMetadata(evidenceRef, metadata);
    return;
  }
  if (evidenceType === "support_training_completion") {
    assertSupportTrainingCompletionMetadata(evidenceRef, metadata);
    return;
  }
  if (evidenceType !== "slo_oncall_signoff") return;
  if (evidenceRef === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "slo_oncall_evidence_ref_required",
      field: "evidence_ref",
    });
  }
  for (const key of ["slo_dashboard", "severity_model", "oncall_rota", "raci_ref", "support_hours"] as const) {
    assertRequiredEvidenceMetadataString(metadata, key, "slo_oncall_metadata_required");
  }
}

function assertExternalAlertDeliveryMetadata(
  evidenceRef: string | null,
  metadata: Readonly<Record<string, unknown>>,
): void {
  if (evidenceRef === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "external_alert_delivery_evidence_ref_required",
      field: "evidence_ref",
    });
  }
  const channel = assertRequiredEvidenceMetadataString(metadata, "channel", "external_alert_delivery_metadata_required");
  if (!["teams", "slack", "email", "webhook"].includes(channel)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "external_alert_delivery_channel_invalid",
      field: "metadata.channel",
    });
  }
  assertRequiredEvidenceMetadataString(metadata, "provider_alias", "external_alert_delivery_metadata_required");
  assertRequiredEvidenceMetadataString(metadata, "receipt_id", "external_alert_delivery_metadata_required");
  const deliveryStatus = assertRequiredEvidenceMetadataString(metadata, "delivery_status", "external_alert_delivery_metadata_required");
  if (deliveryStatus !== "delivered") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "external_alert_delivery_status_must_be_delivered",
      field: "metadata.delivery_status",
    });
  }
  const receiptAtRaw = assertRequiredEvidenceMetadataString(metadata, "receipt_at", "external_alert_delivery_metadata_required");
  const receiptAt = parseIsoDate(receiptAtRaw, "metadata.receipt_at");
  if (receiptAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "receipt_at_in_future",
      field: "metadata.receipt_at",
    });
  }
}

function assertObservabilityTelemetryWiringMetadata(
  evidenceRef: string | null,
  metadata: Readonly<Record<string, unknown>>,
): void {
  if (evidenceRef === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "observability_telemetry_evidence_ref_required",
      field: "evidence_ref",
    });
  }
  const exporter = assertRequiredEvidenceMetadataString(metadata, "exporter", "observability_telemetry_metadata_required");
  if (!["prometheus", "otlp"].includes(exporter)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "observability_telemetry_exporter_invalid",
      field: "metadata.exporter",
    });
  }
  assertRequiredEvidenceMetadataString(metadata, "collector_ref", "observability_telemetry_metadata_required");
  assertRequiredEvidenceMetadataString(metadata, "dashboard_ref", "observability_telemetry_metadata_required");
  assertRequiredEvidenceMetadataString(metadata, "alert_route_ref", "observability_telemetry_metadata_required");
  const sampledAtRaw = assertRequiredEvidenceMetadataString(metadata, "sampled_at", "observability_telemetry_metadata_required");
  const sampledAt = parseIsoDate(sampledAtRaw, "metadata.sampled_at");
  if (sampledAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "observability_telemetry_sampled_at_in_future",
      field: "metadata.sampled_at",
    });
  }
}

function assertSupportTrainingCompletionMetadata(
  evidenceRef: string | null,
  metadata: Readonly<Record<string, unknown>>,
): void {
  if (evidenceRef === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "support_training_evidence_ref_required",
      field: "evidence_ref",
    });
  }
  assertRequiredEvidenceMetadataString(metadata, "support_model_ref", "support_training_metadata_required");
  assertRequiredEvidenceMetadataString(metadata, "training_completion_ref", "support_training_metadata_required");
  const trainedRoleCount = assertRequiredEvidenceMetadataFiniteNumber(metadata, "trained_role_count", "support_training_metadata_required");
  const trainedUserCount = assertRequiredEvidenceMetadataFiniteNumber(metadata, "trained_user_count", "support_training_metadata_required");
  const coveragePercent = assertRequiredEvidenceMetadataFiniteNumber(metadata, "coverage_percent", "support_training_metadata_required");
  if (!Number.isInteger(trainedRoleCount) || trainedRoleCount <= 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "support_training_role_count_invalid", field: "metadata.trained_role_count" });
  }
  if (!Number.isInteger(trainedUserCount) || trainedUserCount <= 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "support_training_user_count_invalid", field: "metadata.trained_user_count" });
  }
  if (coveragePercent < 0 || coveragePercent > 100) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "support_training_coverage_invalid", field: "metadata.coverage_percent" });
  }
  const completedAtRaw = assertRequiredEvidenceMetadataString(metadata, "completed_at", "support_training_metadata_required");
  const completedAt = parseIsoDate(completedAtRaw, "metadata.completed_at");
  if (completedAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "support_training_completed_at_in_future",
      field: "metadata.completed_at",
    });
  }
}

function assertManagedBackupRestoreMetadata(
  evidenceRef: string | null,
  metadata: Readonly<Record<string, unknown>>,
): void {
  if (evidenceRef === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "managed_backup_restore_evidence_ref_required",
      field: "evidence_ref",
    });
  }
  assertRequiredEvidenceMetadataString(metadata, "backup_policy_ref", "managed_backup_restore_metadata_required");
  assertRequiredEvidenceMetadataString(metadata, "restore_scope", "managed_backup_restore_metadata_required");
  assertRequiredEvidenceMetadataString(metadata, "restore_completed_at", "managed_backup_restore_metadata_required");
  const restoreCompletedAt = parseIsoDate(metadata.restore_completed_at, "metadata.restore_completed_at");
  if (restoreCompletedAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "restore_completed_at_in_future",
      field: "metadata.restore_completed_at",
    });
  }
  assertRequiredEvidenceMetadataNumber(
    metadata,
    "rto_minutes",
    CONTROLLED_PROD_RESTORE_RTO_MINUTES,
    "managed_backup_restore_rto_target_missed",
  );
  assertRequiredEvidenceMetadataNumber(
    metadata,
    "rpo_minutes",
    CONTROLLED_PROD_RESTORE_RPO_MINUTES,
    "managed_backup_restore_rpo_target_missed",
  );
}

function assertRequiredEvidenceMetadataString(
  metadata: Readonly<Record<string, unknown>>,
  key: string,
  reason: string,
): string {
  const value = metadata[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 200) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason,
      field: `metadata.${key}`,
    });
  }
  return value.trim();
}

function assertRequiredEvidenceMetadataNumber(
  metadata: Readonly<Record<string, unknown>>,
  key: string,
  max: number,
  targetMissedReason: string,
): void {
  const value = metadata[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "managed_backup_restore_metadata_required",
      field: `metadata.${key}`,
    });
  }
  if (value > max) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: targetMissedReason,
      field: `metadata.${key}`,
      target_max_minutes: max,
    });
  }
}

function assertRequiredEvidenceMetadataFiniteNumber(
  metadata: Readonly<Record<string, unknown>>,
  key: string,
  reason: string,
): number {
  const value = metadata[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason,
      field: `metadata.${key}`,
    });
  }
  return value;
}

function parseBoundedString(raw: unknown, field: string, min: number, max: number): string {
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  const value = raw.trim();
  if (value.length < min || value.length > max) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  return value;
}

function parseBoolean(raw: unknown, field: string): boolean {
  if (typeof raw === "boolean") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function assertSafeMetadata(value: unknown, path: string): void {
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value === "string") {
    assertSafeEvidenceString(value, path);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertSafeMetadata(item, `${path}.${index}`);
    return;
  }
  if (!isRecord(value)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_value_not_json", path });
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || forbiddenEvidenceKey(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_secret_or_endpoint_key_forbidden", path: `${path}.${key}` });
    }
    assertSafeMetadata(item, `${path}.${key}`);
  }
}

function assertSafeEvidenceString(value: string, path: string): void {
  if (
    /https?:\/\//i.test(value) ||
    /hooks\.slack\.com/i.test(value) ||
    /bearer\s+[a-z0-9._-]+/i.test(value) ||
    /\b(?:api[_-]?key|secret|token|password|credential|authorization|webhook_secret)\s*[:=]/i.test(value)
  ) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_or_endpoint_value_forbidden", path });
  }
}

function forbiddenEvidenceKey(key: string): boolean {
  return /(^|[_.-])(secret|token|password|credential|authorization|cookie|webhook_url|endpoint_url|url|dsn|smtp|raw_roster|training_roster|participant_list|user_list|raw_training_document|training_document_body|payload|body)([_.-]|$)/i.test(key);
}
