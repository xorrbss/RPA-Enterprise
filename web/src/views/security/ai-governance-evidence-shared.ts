import type {
  AiGovernanceEvidence,
  AiGovernanceEvidenceRequest,
  AiGovernanceEvidenceStatus,
  AiGovernanceEvidenceType,
} from "../../api/types";

export const EVIDENCE_TYPES = ["model_registry", "prompt_registry", "eval_result", "cost_control", "human_override"] as const;
export const EVIDENCE_STATUSES = ["valid", "deferred", "failed"] as const;
const HUMAN_OVERRIDE_ACTIONS = [
  "accepted_ai_output",
  "rejected_ai_output",
  "corrected_ai_output",
  "escalated_to_human",
  "rolled_back_prompt",
] as const;

// 선택형 세부 항목 값 → 운영자 한국어(저장 값은 raw 유지). 미매핑은 raw 폴백(조용한 공백 금지).
export const METADATA_OPTION_LABELS: Record<string, string> = {
  low: "낮음", medium: "중간", high: "높음", accepted_ai_output: "AI 결과 수용", rejected_ai_output: "AI 결과 반려",
  corrected_ai_output: "AI 결과 수정", escalated_to_human: "담당자 이관", rolled_back_prompt: "프롬프트 되돌림",
};

export type MetadataFieldKind = "text" | "number" | "boolean" | "select";

export interface MetadataField {
  readonly key: string;
  readonly label: string;
  readonly kind: MetadataFieldKind;
  readonly placeholder?: string;
  readonly options?: readonly string[];
}

export interface EvidenceRecordDraft {
  readonly evidenceType: AiGovernanceEvidenceType;
  readonly status: AiGovernanceEvidenceStatus;
  readonly subjectRef: string;
  readonly summary: string;
  readonly evidenceRef: string;
  readonly policyDecisionRef: string;
  readonly auditCorrelationId: string;
  readonly expiresOn: string;
  readonly metadataValues: Readonly<Record<string, string>>;
  readonly legalHold: boolean;
}

export const DEFAULT_SUBJECTS: Readonly<Record<AiGovernanceEvidenceType, string>> = {
  model_registry: "model:codex-prod-primary",
  prompt_registry: "prompt-template:invoice-triage@3",
  eval_result: "eval-suite:invoice-triage-regression",
  cost_control: "budget:ai-gateway/controlled-prod",
  human_override: "human-override:case-review",
};

export const DEFAULT_SUMMARIES: Readonly<Record<AiGovernanceEvidenceType, string>> = {
  model_registry: "정책·감사 연동과 함께 모델 등록 승인을 기록",
  prompt_registry: "되돌림·평가 참조와 함께 프롬프트 템플릿 승인을 기록",
  eval_result: "평가 묶음이 필수 AI 거버넌스 점검을 통과",
  cost_control: "통제 운영 환경의 비용 예산·이상 감지 통제 승인",
  human_override: "사람 개입 결정을 감사 연동 증빙으로 기록",
};

export const METADATA_FIELDS: Readonly<Record<AiGovernanceEvidenceType, readonly MetadataField[]>> = {
  model_registry: [
    { key: "provider_alias", label: "제공자 별칭", kind: "text", placeholder: "provider:primary-ai" },
    { key: "model_alias", label: "모델 별칭", kind: "text", placeholder: "model:codex-prod-primary" },
    { key: "model_version", label: "모델 버전", kind: "text", placeholder: "2026-06-approved" },
    { key: "risk_tier", label: "위험 등급", kind: "select", options: ["low", "medium", "high"] },
    { key: "data_retention_policy_ref", label: "보존 정책 참조", kind: "text", placeholder: "policy:data-retention/ai" },
    { key: "tenant_allowlist_ref", label: "테넌트 허용 목록 참조", kind: "text", placeholder: "tenant-allowlist:controlled-prod" },
    { key: "approved_at", label: "승인 시각", kind: "text", placeholder: "2026-06-29T00:00:00.000Z" },
  ],
  prompt_registry: [
    { key: "prompt_template_id", label: "프롬프트 템플릿 ID", kind: "text", placeholder: "prompt-template:invoice-triage" },
    { key: "prompt_template_version", label: "프롬프트 버전", kind: "text", placeholder: "v3" },
    { key: "owner_ref", label: "담당 참조", kind: "text", placeholder: "team:finance-automation" },
    { key: "eval_suite_ref", label: "평가 묶음 참조", kind: "text", placeholder: "eval-suite:invoice-triage-regression" },
    { key: "rollback_target_ref", label: "되돌림 대상 참조", kind: "text", placeholder: "prompt-template:invoice-triage@2" },
    { key: "approved_at", label: "승인 시각", kind: "text", placeholder: "2026-06-29T00:00:00.000Z" },
  ],
  eval_result: [
    { key: "eval_suite_ref", label: "평가 묶음 참조", kind: "text", placeholder: "eval-suite:invoice-triage-regression" },
    { key: "dataset_ref", label: "데이터셋 참조", kind: "text", placeholder: "dataset:invoice-redacted-sample" },
    { key: "sampled_at", label: "표본 시각", kind: "text", placeholder: "2026-06-29T00:00:00.000Z" },
    { key: "pass_rate", label: "통과율", kind: "number", placeholder: "0.98" },
    { key: "prompt_injection_passed", label: "주입 공격 점검", kind: "boolean" },
    { key: "data_leakage_passed", label: "정보 유출 점검", kind: "boolean" },
    { key: "hallucination_passed", label: "환각 점검", kind: "boolean" },
    { key: "policy_block_passed", label: "정책 차단 점검", kind: "boolean" },
  ],
  cost_control: [
    { key: "budget_ref", label: "예산 참조", kind: "text", placeholder: "budget:ai-gateway/controlled-prod" },
    { key: "scope_ref", label: "범위 참조", kind: "text", placeholder: "scope:tenant-a/prod" },
    { key: "anomaly_alert_ref", label: "이상 비용 알림 참조", kind: "text", placeholder: "alert-route:ai-cost-anomaly" },
    { key: "monthly_limit", label: "월 한도", kind: "number", placeholder: "500" },
    { key: "per_run_cap", label: "회당 한도", kind: "number", placeholder: "5" },
    { key: "effective_at", label: "적용 시각", kind: "text", placeholder: "2026-06-29T00:00:00.000Z" },
  ],
  human_override: [
    { key: "override_actor_ref", label: "처리자 참조", kind: "text", placeholder: "principal:reviewer-a" },
    { key: "override_action", label: "개입 조치", kind: "select", options: HUMAN_OVERRIDE_ACTIONS },
    { key: "reason_code", label: "사유 코드", kind: "text", placeholder: "policy_exception_review" },
    { key: "audit_event_ref", label: "감사 이벤트 참조", kind: "text", placeholder: "audit-event:human-override" },
    { key: "occurred_at", label: "발생 시각", kind: "text", placeholder: "2026-06-29T00:00:00.000Z" },
  ],
};

export function summarizeEvidence(items: readonly AiGovernanceEvidence[]): { total: number; valid: number; deferred: number; failed: number } {
  return {
    total: items.length,
    valid: items.filter((item) => item.status === "valid").length,
    deferred: items.filter((item) => item.status === "deferred").length,
    failed: items.filter((item) => item.status === "failed").length,
  };
}

export function buildEvidenceRequest(draft: EvidenceRecordDraft): AiGovernanceEvidenceRequest {
  const expiresAt = draft.expiresOn.length > 0 ? new Date(`${draft.expiresOn}T23:59:59.000Z`).toISOString() : null;
  const evidenceRef = blankToNull(draft.evidenceRef);
  const policyDecisionRef = blankToNull(draft.policyDecisionRef);
  const auditCorrelationId = blankToNull(draft.auditCorrelationId);
  return {
    evidence_type: draft.evidenceType,
    subject_ref: draft.subjectRef,
    status: draft.status,
    evidence_at: new Date().toISOString(),
    ...(expiresAt !== null ? { expires_at: expiresAt } : {}),
    summary: draft.summary,
    ...(evidenceRef !== null ? { evidence_ref: evidenceRef } : {}),
    ...(policyDecisionRef !== null ? { policy_decision_ref: policyDecisionRef } : {}),
    ...(auditCorrelationId !== null ? { audit_correlation_id: auditCorrelationId } : {}),
    metadata: buildMetadata(draft.evidenceType, draft.metadataValues),
    legal_hold: draft.legalHold,
  };
}

function buildMetadata(
  evidenceType: AiGovernanceEvidenceType,
  metadataValues: Readonly<Record<string, string>>,
): Readonly<Record<string, unknown>> {
  const metadata: Record<string, unknown> = {};
  for (const field of METADATA_FIELDS[evidenceType]) {
    const raw = metadataValues[field.key];
    if (raw === undefined || raw.trim().length === 0) continue;
    if (field.kind === "number") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) metadata[field.key] = parsed;
    } else if (field.kind === "boolean") {
      metadata[field.key] = raw === "true";
    } else {
      metadata[field.key] = raw.trim();
    }
  }
  return metadata;
}

export function metadataValueReady(field: MetadataField, value: string | undefined): boolean {
  if (value === undefined || value.trim().length === 0) return false;
  if (field.kind === "number") return Number.isFinite(Number(value));
  return true;
}

export function recordDraftHasBlockedText({
  subjectRef,
  summary,
  evidenceRef,
  policyDecisionRef,
  metadataValues,
  fields,
}: {
  readonly subjectRef: string;
  readonly summary: string;
  readonly evidenceRef: string;
  readonly policyDecisionRef: string;
  readonly metadataValues: Readonly<Record<string, string>>;
  readonly fields: readonly MetadataField[];
}): boolean {
  return [subjectRef, summary, evidenceRef, policyDecisionRef, ...fields.map((field) => metadataValues[field.key] ?? "")]
    .some((value) => value.trim().length > 0 && isBlockedEvidenceText(value));
}

export function defaultMetadataValues(): Record<string, string> {
  const now = new Date(Date.now() - 60_000).toISOString();
  return {
    provider_alias: "provider:primary-ai",
    model_alias: "model:codex-prod-primary",
    model_version: "2026-06-approved",
    risk_tier: "medium",
    data_retention_policy_ref: "policy:data-retention/ai",
    tenant_allowlist_ref: "tenant-allowlist:controlled-prod",
    approved_at: now,
    prompt_template_id: "prompt-template:invoice-triage",
    prompt_template_version: "v3",
    owner_ref: "team:finance-automation",
    eval_suite_ref: "eval-suite:invoice-triage-regression",
    rollback_target_ref: "prompt-template:invoice-triage@2",
    dataset_ref: "dataset:invoice-redacted-sample",
    sampled_at: now,
    pass_rate: "0.98",
    prompt_injection_passed: "true",
    data_leakage_passed: "true",
    hallucination_passed: "true",
    policy_block_passed: "true",
    budget_ref: "budget:ai-gateway/controlled-prod",
    scope_ref: "scope:tenant-a/prod",
    anomaly_alert_ref: "alert-route:ai-cost-anomaly",
    monthly_limit: "500",
    per_run_cap: "5",
    effective_at: now,
    override_actor_ref: "principal:reviewer-a",
    override_action: "corrected_ai_output",
    reason_code: "policy_exception_review",
    audit_event_ref: "audit-event:human-override",
    occurred_at: now,
  };
}

export function defaultFutureDate(): string {
  return new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// 증빙 종류 → 운영자 한국어(닫힌 맵). 미매핑은 raw 폴백(조용한 공백 금지).
const EVIDENCE_TYPE_LABELS: Record<string, string> = {
  model_registry: "모델 등록", prompt_registry: "프롬프트 등록", eval_result: "평가 결과", cost_control: "비용 통제", human_override: "사람 개입",
};
export function evidenceTypeLabel(type: AiGovernanceEvidenceType): string {
  return EVIDENCE_TYPE_LABELS[type] ?? type;
}

// 증빙 상태 → 운영자 한국어(닫힌 맵). 미매핑은 raw 폴백(조용한 공백 금지).
const EVIDENCE_STATUS_LABELS: Record<string, string> = { valid: "유효", deferred: "보류", failed: "실패" };
export function evidenceStatusLabel(status: AiGovernanceEvidenceStatus): string {
  return EVIDENCE_STATUS_LABELS[status] ?? status;
}

export function evidenceStatusTone(status: AiGovernanceEvidenceStatus): "green" | "amber" | "red" {
  if (status === "valid") return "green";
  if (status === "deferred") return "amber";
  return "red";
}

export function metadataSummary(item: AiGovernanceEvidence): string {
  const metadata = item.metadata;
  if (item.evidence_type === "model_registry") {
    return [
      `제공자 ${metadataText(metadata.provider_alias)}`,
      `모델 ${metadataText(metadata.model_alias)}`,
      `버전 ${metadataText(metadata.model_version)}`,
      `위험 ${metadataText(metadata.risk_tier)}`,
    ].join(" / ");
  }
  if (item.evidence_type === "prompt_registry") {
    return [
      `템플릿 ${metadataText(metadata.prompt_template_id)}`,
      `버전 ${metadataText(metadata.prompt_template_version)}`,
      `평가 ${metadataText(metadata.eval_suite_ref)}`,
      `되돌림 ${metadataText(metadata.rollback_target_ref)}`,
    ].join(" / ");
  }
  if (item.evidence_type === "eval_result") {
    return [
      `평가 묶음 ${metadataText(metadata.eval_suite_ref)}`,
      `데이터셋 ${metadataText(metadata.dataset_ref)}`,
      `통과율 ${metadataText(metadata.pass_rate)}`,
      `표본 ${metadataText(metadata.sampled_at)}`,
    ].join(" / ");
  }
  if (item.evidence_type === "cost_control") {
    return [
      `예산 ${metadataText(metadata.budget_ref)}`,
      `범위 ${metadataText(metadata.scope_ref)}`,
      `월 한도 ${metadataText(metadata.monthly_limit)}`,
      `회당 한도 ${metadataText(metadata.per_run_cap)}`,
    ].join(" / ");
  }
  return [
    `처리자 ${metadataText(metadata.override_actor_ref)}`,
    `조치 ${metadataText(metadata.override_action)}`,
    `사유 ${metadataText(metadata.reason_code)}`,
    `이벤트 ${metadataText(metadata.audit_event_ref)}`,
  ].join(" / ");
}

function metadataText(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return typeof value === "string" && value.trim().length > 0 ? safeText(value) : "없음";
}

export function refText(value: string | null): string {
  return value === null || value.trim().length === 0 ? "없음" : safeText(value);
}

export function safeText(value: string): string {
  if (isBlockedEvidenceText(value)) return "표시 제한";
  return value;
}

function isBlockedEvidenceText(value: string): boolean {
  return /https?:\/\//i.test(value) ||
    /\bbearer\s+[a-z0-9._~+/=-]{8,}/i.test(value) ||
    /\b(token|password|secret|credential|authorization)\s*[:=]\s*\S{4,}/i.test(value);
}

export function stringFilterValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function governanceEvidenceKey(draft: EvidenceRecordDraft): string {
  return `ai-governance-${stableKeyPart(draft.evidenceType)}-${stableKeyPart(draft.subjectRef)}-${Date.now()}`;
}

function stableKeyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 80);
}
