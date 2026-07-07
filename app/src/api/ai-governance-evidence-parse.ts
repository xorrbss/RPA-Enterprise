import { ApiResponseError } from "../runtime/errors";
import { isRecord } from "./command";

export type AiGovernanceEvidenceType = "model_registry" | "prompt_registry" | "eval_result" | "cost_control" | "human_override";
export type AiGovernanceEvidenceStatus = "valid" | "failed" | "deferred";

export interface AiGovernanceEvidenceInput {
  readonly evidenceType: AiGovernanceEvidenceType;
  readonly subjectRef: string;
  readonly status: AiGovernanceEvidenceStatus;
  readonly evidenceAt: Date;
  readonly expiresAt: Date | null;
  readonly summary: string;
  readonly evidenceRef: string | null;
  readonly policyDecisionRef: string | null;
  readonly auditCorrelationId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly legalHold: boolean;
}

export function parseAiGovernanceEvidenceRequest(raw: unknown): AiGovernanceEvidenceInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ai_governance_evidence_body_expected_object" });
  const allowed = new Set([
    "evidence_type",
    "subject_ref",
    "status",
    "evidence_at",
    "expires_at",
    "summary",
    "evidence_ref",
    "policy_decision_ref",
    "audit_correlation_id",
    "metadata",
    "legal_hold",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ai_governance_evidence_unknown_field", field: key });
  }
  const evidenceType = parseEvidenceType(raw.evidence_type);
  const status = parseEvidenceStatus(raw.status);
  const evidenceAt = parseIsoDate(raw.evidence_at, "evidence_at");
  const expiresAt = raw.expires_at === undefined || raw.expires_at === null ? null : parseIsoDate(raw.expires_at, "expires_at");
  const now = Date.now();
  if (evidenceAt.getTime() > now + 5 * 60 * 1000) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "evidence_at_in_future" });
  }
  if (expiresAt !== null && expiresAt.getTime() <= evidenceAt.getTime()) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "expires_at_must_be_after_evidence_at" });
  }
  if (status === "valid" && evidenceType !== "human_override") {
    if (expiresAt === null) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "expires_at_required_for_valid_ai_governance_evidence" });
    if (expiresAt.getTime() <= now) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "expires_at_must_be_future" });
  }
  const subjectRef = parseSafeText(raw.subject_ref, "subject_ref", 1, 300);
  const summary = parseSafeText(raw.summary, "summary", 1, 1000);
  const evidenceRef = raw.evidence_ref === undefined || raw.evidence_ref === null || raw.evidence_ref === ""
    ? null
    : parseSafeText(raw.evidence_ref, "evidence_ref", 1, 500);
  const policyDecisionRef = raw.policy_decision_ref === undefined || raw.policy_decision_ref === null || raw.policy_decision_ref === ""
    ? null
    : parseSafeText(raw.policy_decision_ref, "policy_decision_ref", 1, 300);
  const auditCorrelationId = raw.audit_correlation_id === undefined || raw.audit_correlation_id === null || raw.audit_correlation_id === ""
    ? null
    : parseUuid(raw.audit_correlation_id, "audit_correlation_id");
  const metadata = parseEvidenceMetadata(raw.metadata);
  if (status === "valid") {
    if (evidenceRef === null) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "valid_ai_governance_evidence_ref_required" });
    if (policyDecisionRef === null) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "valid_ai_governance_policy_decision_ref_required" });
    if (auditCorrelationId === null) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "valid_ai_governance_audit_correlation_required" });
    assertTypeMetadata(evidenceType, metadata);
  }
  return {
    evidenceType,
    subjectRef,
    status,
    evidenceAt,
    expiresAt,
    summary,
    evidenceRef,
    policyDecisionRef,
    auditCorrelationId,
    metadata,
    legalHold: raw.legal_hold === undefined ? false : parseBoolean(raw.legal_hold, "legal_hold"),
  };
}

export function parseEvidenceTypeQuery(raw: unknown): AiGovernanceEvidenceType | undefined {
  if (raw === undefined) return undefined;
  return parseEvidenceType(raw);
}

function parseEvidenceType(raw: unknown): AiGovernanceEvidenceType {
  if (
    raw === "model_registry" ||
    raw === "prompt_registry" ||
    raw === "eval_result" ||
    raw === "cost_control" ||
    raw === "human_override"
  ) return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_ai_governance_evidence_type" });
}

export function parseEvidenceStatusQuery(raw: unknown): AiGovernanceEvidenceStatus | undefined {
  if (raw === undefined) return undefined;
  return parseEvidenceStatus(raw);
}

function parseEvidenceStatus(raw: unknown): AiGovernanceEvidenceStatus {
  if (raw === "valid" || raw === "failed" || raw === "deferred") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_ai_governance_evidence_status" });
}

export function parseSubjectRefQuery(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  return parseSafeText(raw, "subject_ref", 1, 300);
}

function parseIsoDate(raw: unknown, field: string): Date {
  if (typeof raw !== "string" || raw.length === 0) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_iso_datetime", field });
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_iso_datetime", field });
  return date;
}

function parseUuid(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}`, field });
  }
  return raw.toLowerCase();
}

function parseSafeText(raw: unknown, field: string, min: number, max: number): string {
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  const value = raw.trim();
  if (value.length < min || value.length > max) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  assertSafeEvidenceString(value, field);
  return value;
}

function parseEvidenceMetadata(raw: unknown): Readonly<Record<string, unknown>> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_must_be_object" });
  if (JSON.stringify(raw).length > 5000) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_too_large" });
  assertSafeMetadata(raw, "metadata", 0);
  return raw;
}

function parseBoolean(raw: unknown, field: string): boolean {
  if (typeof raw === "boolean") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function assertTypeMetadata(evidenceType: AiGovernanceEvidenceType, metadata: Readonly<Record<string, unknown>>): void {
  if (evidenceType === "model_registry") {
    assertModelRegistryMetadata(metadata);
    return;
  }
  if (evidenceType === "prompt_registry") {
    assertPromptRegistryMetadata(metadata);
    return;
  }
  if (evidenceType === "eval_result") {
    assertEvalResultMetadata(metadata);
    return;
  }
  if (evidenceType === "cost_control") {
    assertCostControlMetadata(metadata);
    return;
  }
  assertHumanOverrideMetadata(metadata);
}

function assertModelRegistryMetadata(metadata: Readonly<Record<string, unknown>>): void {
  assertRequiredMetadataString(metadata, "provider_alias", "model_registry_metadata_required");
  assertRequiredMetadataString(metadata, "model_alias", "model_registry_metadata_required");
  assertRequiredMetadataString(metadata, "model_version", "model_registry_metadata_required");
  const riskTier = assertRequiredMetadataString(metadata, "risk_tier", "model_registry_metadata_required");
  if (!["low", "medium", "high"].includes(riskTier)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "model_registry_risk_tier_invalid", field: "metadata.risk_tier" });
  assertRequiredMetadataString(metadata, "data_retention_policy_ref", "model_registry_metadata_required");
  assertRequiredMetadataString(metadata, "tenant_allowlist_ref", "model_registry_metadata_required");
  assertPastMetadataDate(metadata, "approved_at", "model_registry_metadata_required", "model_registry_approved_at_in_future");
}

function assertPromptRegistryMetadata(metadata: Readonly<Record<string, unknown>>): void {
  assertRequiredMetadataString(metadata, "prompt_template_id", "prompt_registry_metadata_required");
  assertRequiredMetadataString(metadata, "prompt_template_version", "prompt_registry_metadata_required");
  assertRequiredMetadataString(metadata, "owner_ref", "prompt_registry_metadata_required");
  assertRequiredMetadataString(metadata, "eval_suite_ref", "prompt_registry_metadata_required");
  assertRequiredMetadataString(metadata, "rollback_target_ref", "prompt_registry_metadata_required");
  assertPastMetadataDate(metadata, "approved_at", "prompt_registry_metadata_required", "prompt_registry_approved_at_in_future");
}

function assertEvalResultMetadata(metadata: Readonly<Record<string, unknown>>): void {
  assertRequiredMetadataString(metadata, "eval_suite_ref", "eval_result_metadata_required");
  assertRequiredMetadataString(metadata, "dataset_ref", "eval_result_metadata_required");
  assertPastMetadataDate(metadata, "sampled_at", "eval_result_metadata_required", "eval_result_sampled_at_in_future");
  const passRate = assertRequiredMetadataFiniteNumber(metadata, "pass_rate", "eval_result_metadata_required");
  if (passRate < 0 || passRate > 1) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "eval_result_pass_rate_invalid", field: "metadata.pass_rate" });
  for (const key of ["prompt_injection_passed", "data_leakage_passed", "hallucination_passed", "policy_block_passed"] as const) {
    if (assertRequiredMetadataBoolean(metadata, key, "eval_result_metadata_required") !== true) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "eval_result_required_check_failed", field: `metadata.${key}` });
    }
  }
}

function assertCostControlMetadata(metadata: Readonly<Record<string, unknown>>): void {
  assertRequiredMetadataString(metadata, "budget_ref", "cost_control_metadata_required");
  assertRequiredMetadataString(metadata, "scope_ref", "cost_control_metadata_required");
  assertRequiredMetadataString(metadata, "anomaly_alert_ref", "cost_control_metadata_required");
  const monthlyLimit = assertRequiredMetadataFiniteNumber(metadata, "monthly_limit", "cost_control_metadata_required");
  const perRunCap = assertRequiredMetadataFiniteNumber(metadata, "per_run_cap", "cost_control_metadata_required");
  if (monthlyLimit <= 0) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "cost_control_monthly_limit_invalid", field: "metadata.monthly_limit" });
  if (perRunCap <= 0 || perRunCap > monthlyLimit) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "cost_control_per_run_cap_invalid", field: "metadata.per_run_cap" });
  assertPastMetadataDate(metadata, "effective_at", "cost_control_metadata_required", "cost_control_effective_at_in_future");
}

function assertHumanOverrideMetadata(metadata: Readonly<Record<string, unknown>>): void {
  assertRequiredMetadataString(metadata, "override_actor_ref", "human_override_metadata_required");
  const action = assertRequiredMetadataString(metadata, "override_action", "human_override_metadata_required");
  if (!["accepted_ai_output", "rejected_ai_output", "corrected_ai_output", "escalated_to_human", "rolled_back_prompt"].includes(action)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "human_override_action_invalid", field: "metadata.override_action" });
  }
  assertRequiredMetadataString(metadata, "reason_code", "human_override_metadata_required");
  assertRequiredMetadataString(metadata, "audit_event_ref", "human_override_metadata_required");
  assertPastMetadataDate(metadata, "occurred_at", "human_override_metadata_required", "human_override_occurred_at_in_future");
}

function assertPastMetadataDate(
  metadata: Readonly<Record<string, unknown>>,
  key: string,
  missingReason: string,
  futureReason: string,
): void {
  const raw = assertRequiredMetadataString(metadata, key, missingReason);
  const date = parseIsoDate(raw, `metadata.${key}`);
  if (date.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: futureReason, field: `metadata.${key}` });
  }
}

function assertRequiredMetadataString(metadata: Readonly<Record<string, unknown>>, key: string, reason: string): string {
  const value = metadata[key];
  if (typeof value !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason, field: `metadata.${key}` });
  return parseSafeText(value, `metadata.${key}`, 1, 300);
}

function assertRequiredMetadataFiniteNumber(metadata: Readonly<Record<string, unknown>>, key: string, reason: string): number {
  const value = metadata[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason, field: `metadata.${key}` });
  }
  return value;
}

function assertRequiredMetadataBoolean(metadata: Readonly<Record<string, unknown>>, key: string, reason: string): boolean {
  const value = metadata[key];
  if (typeof value !== "boolean") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason, field: `metadata.${key}` });
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
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || forbiddenEvidenceKey(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_secret_or_raw_value_key_forbidden", path: `${path}.${key}` });
    }
    assertSafeMetadata(child, `${path}.${key}`, depth + 1);
  }
}

function assertSafeEvidenceString(value: string, path: string): void {
  if (/https?:\/\//i.test(value) || /hooks\.slack\.com/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "raw_endpoint_url_forbidden", path });
  }
  if (/\bbearer\s+[a-z0-9._~+/=-]{8,}/i.test(value) || /\b(token|password|secret)=/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_material_forbidden", path });
  }
  if (/\b(api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|credential|authorization)\s*[:=]\s*\S{4,}/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_material_forbidden", path });
  }
}

function forbiddenEvidenceKey(key: string): boolean {
  return /(^|[_.-])(api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|credential|authorization|cookie|webhook_url|endpoint_url|url|dsn|smtp|raw_prompt|prompt_text|prompt_body|raw_output|output_text|output_body|raw_document|document_body|training_roster|participant_list|full_text|payload|body)([_.-]|$)/i.test(key);
}
