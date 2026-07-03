import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { useCan } from "../../api/permissions";
import { useListView } from "../../api/useListView";
import type {
  AiGovernanceEvidence,
  AiGovernanceEvidenceListParams,
  AiGovernanceEvidenceRequest,
  AiGovernanceEvidenceStatus,
  AiGovernanceEvidenceType,
} from "../../api/types";
import { errorLabel } from "../../components/badges";
import { FilterSelect } from "../../components/FilterSelect";
import { EmptyState, ErrorState, Loading } from "../../components/states";
import { formatDateTime } from "../orchestration/format";

const EVIDENCE_TYPES = ["model_registry", "prompt_registry", "eval_result", "cost_control", "human_override"] as const;
const EVIDENCE_STATUSES = ["valid", "deferred", "failed"] as const;
const HUMAN_OVERRIDE_ACTIONS = [
  "accepted_ai_output",
  "rejected_ai_output",
  "corrected_ai_output",
  "escalated_to_human",
  "rolled_back_prompt",
] as const;

// 선택형 세부 항목 값 → 운영자 한국어(저장 값은 raw 유지). 미매핑은 raw 폴백(조용한 공백 금지).
const METADATA_OPTION_LABELS: Record<string, string> = {
  low: "낮음", medium: "중간", high: "높음", accepted_ai_output: "AI 결과 수용", rejected_ai_output: "AI 결과 반려",
  corrected_ai_output: "AI 결과 수정", escalated_to_human: "담당자 이관", rolled_back_prompt: "프롬프트 되돌림",
};

type MetadataFieldKind = "text" | "number" | "boolean" | "select";

interface MetadataField {
  readonly key: string;
  readonly label: string;
  readonly kind: MetadataFieldKind;
  readonly placeholder?: string;
  readonly options?: readonly string[];
}

interface EvidenceRecordDraft {
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

const DEFAULT_SUBJECTS: Readonly<Record<AiGovernanceEvidenceType, string>> = {
  model_registry: "model:codex-prod-primary",
  prompt_registry: "prompt-template:invoice-triage@3",
  eval_result: "eval-suite:invoice-triage-regression",
  cost_control: "budget:ai-gateway/controlled-prod",
  human_override: "human-override:case-review",
};

const DEFAULT_SUMMARIES: Readonly<Record<AiGovernanceEvidenceType, string>> = {
  model_registry: "정책·감사 연동과 함께 모델 등록 승인을 기록",
  prompt_registry: "되돌림·평가 참조와 함께 프롬프트 템플릿 승인을 기록",
  eval_result: "평가 묶음이 필수 AI 거버넌스 점검을 통과",
  cost_control: "통제 운영 환경의 비용 예산·이상 감지 통제 승인",
  human_override: "사람 개입 결정을 감사 연동 증빙으로 기록",
};

const METADATA_FIELDS: Readonly<Record<AiGovernanceEvidenceType, readonly MetadataField[]>> = {
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

export function AiGovernanceEvidencePanel(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const queryClient = useQueryClient();
  const [subjectDraft, setSubjectDraft] = useState("");
  const [lastRecordedId, setLastRecordedId] = useState<string | null>(null);
  const lv = useListView<AiGovernanceEvidence>(
    ["ai-governance-evidence"],
    (params) => api.listAiGovernanceEvidence(params as AiGovernanceEvidenceListParams),
    { limit: 25, refetchInterval: 30_000 },
  );
  const items = lv.query.data?.items ?? [];
  const summary = useMemo(() => summarizeEvidence(items), [items]);
  const recordMutation = useMutation({
    mutationFn: (draft: EvidenceRecordDraft) => api.recordAiGovernanceEvidence(buildEvidenceRequest(draft), governanceEvidenceKey(draft)),
    onSuccess: (item) => {
      setLastRecordedId(item.evidence_id);
      void queryClient.invalidateQueries({ queryKey: ["ai-governance-evidence"] });
    },
  });

  function setFilter(key: keyof AiGovernanceEvidenceListParams, value: string | undefined): void {
    lv.setFilter({ ...lv.filter, [key]: value });
  }

  function applySubjectFilter(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setFilter("subject_ref", subjectDraft.trim().length > 0 ? subjectDraft.trim() : undefined);
  }

  return (
    <section className="panel" aria-label="AI 거버넌스 증빙">
      <div className="panel-head">
        <div>
          <h2>AI 거버넌스 증빙</h2>
        </div>
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <FilterSelect
            label="종류"
            value={stringFilterValue(lv.filter.evidence_type)}
            options={EVIDENCE_TYPES}
            labelFor={(value) => evidenceTypeLabel(value as AiGovernanceEvidenceType)}
            onChange={(value) => setFilter("evidence_type", value)}
          />
          <FilterSelect
            label="상태"
            value={stringFilterValue(lv.filter.status)}
            options={EVIDENCE_STATUSES}
            labelFor={(value) => evidenceStatusLabel(value as AiGovernanceEvidenceStatus)}
            onChange={(value) => setFilter("status", value)}
          />
          <form onSubmit={applySubjectFilter} style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <label className="subtle" htmlFor="ai-governance-subject-filter">
              대상
            </label>
            <input
              id="ai-governance-subject-filter"
              value={subjectDraft}
              onChange={(event) => setSubjectDraft(event.target.value)}
              placeholder="model:codex-prod-primary"
              style={{
                minWidth: 220,
                border: "1px solid var(--line-strong)",
                borderRadius: 8,
                background: "var(--surface)",
                color: "var(--text)",
                font: "inherit",
                padding: "5px 8px",
              }}
            />
            <button className="btn" type="submit">적용</button>
          </form>
        </span>
      </div>
      <div className="panel-body">
        <div className="ops-health-grid" style={{ paddingTop: 16 }}>
          <EvidenceTile title="증빙 건수" value={String(summary.total)} detail="현재 필터 페이지" tone="blue" />
          <EvidenceTile title="유효" value={String(summary.valid)} detail="감사 연동 승인" tone={summary.valid > 0 ? "green" : "muted"} />
          <EvidenceTile title="보류" value={String(summary.deferred)} detail="증빙 보완 대기" tone={summary.deferred > 0 ? "amber" : "muted"} />
          <EvidenceTile title="실패" value={String(summary.failed)} detail="통제 점검 실패" tone={summary.failed > 0 ? "red" : "muted"} />
        </div>
        <EvidenceTable queryState={lv.query} items={items} />
        {lv.pager.hasPrev || lv.pager.hasNext ? (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 16px", alignItems: "center" }}>
            <button className="btn" type="button" onClick={lv.pager.onPrev} disabled={!lv.pager.hasPrev}>이전</button>
            <span className="subtle">{lv.pager.pageIndex + 1}페이지</span>
            <button className="btn" type="button" onClick={lv.pager.onNext} disabled={!lv.pager.hasNext}>다음</button>
          </div>
        ) : null}
        {can("ai_governance.manage") ? (
          <AiGovernanceEvidenceRecorder
            isRecording={recordMutation.isPending}
            error={recordMutation.error}
            lastRecordedId={lastRecordedId}
            onSubmit={(draft) => recordMutation.mutate(draft)}
          />
        ) : (
          <p className="subtle" style={{ borderTop: "1px solid var(--line)", margin: "0 16px 16px", paddingTop: 12 }}>
            AI 거버넌스 증빙 기록은 관리자 권한이 필요합니다.
          </p>
        )}
      </div>
    </section>
  );
}

function EvidenceTable({
  queryState,
  items,
}: {
  queryState: { readonly isLoading: boolean; readonly isError: boolean; readonly error: unknown; readonly refetch: () => unknown };
  items: readonly AiGovernanceEvidence[];
}): JSX.Element {
  if (queryState.isLoading) return <Loading />;
  if (queryState.isError) return <ErrorState message={errorLabel(queryState.error)} onRetry={() => void queryState.refetch()} />;
  if (items.length === 0) return <EmptyState message="현재 필터에 맞는 AI 거버넌스 증빙이 없습니다." />;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>종류</th>
            <th>상태</th>
            <th>대상</th>
            <th>증빙</th>
            <th>정책·감사</th>
            <th>기록</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.evidence_id}>
              <td>
                <span className="badge blue">{evidenceTypeLabel(item.evidence_type)}</span>
              </td>
              <td>
                <span className={`badge ${evidenceStatusTone(item.status)}`}>{evidenceStatusLabel(item.status)}</span>
              </td>
              <td>
                <code>{safeText(item.subject_ref)}</code>
              </td>
              <td>
                <strong style={{ display: "block", overflowWrap: "anywhere" }}>{safeText(item.summary)}</strong>
                <span className="subtle" style={{ display: "block" }}>
                  증빙 {refText(item.evidence_ref)}
                </span>
                <span className="subtle" style={{ display: "block" }}>
                  {metadataSummary(item)}
                </span>
              </td>
              <td>
                <span className="subtle" style={{ display: "block" }}>
                  정책 {refText(item.policy_decision_ref)}
                </span>
                <span className="subtle" style={{ display: "block" }}>
                  감사 {refText(item.audit_correlation_id)}
                </span>
                <span className="subtle" style={{ display: "block" }}>
                  만료 {formatDateTime(item.expires_at)}
                </span>
              </td>
              <td>
                <span className="subtle" style={{ display: "block" }}>
                  {formatDateTime(item.recorded_at)}
                </span>
                <span className="subtle" style={{ display: "block" }}>
                  처리자 {safeText(item.recorded_by)}
                </span>
                {item.legal_hold ? <span className="badge amber">법적 보존</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AiGovernanceEvidenceRecorder({
  isRecording,
  error,
  lastRecordedId,
  onSubmit,
}: {
  isRecording: boolean;
  error: unknown;
  lastRecordedId: string | null;
  onSubmit: (draft: EvidenceRecordDraft) => void;
}): JSX.Element {
  const [evidenceType, setEvidenceType] = useState<AiGovernanceEvidenceType>("model_registry");
  const [status, setStatus] = useState<AiGovernanceEvidenceStatus>("valid");
  const [subjectRef, setSubjectRef] = useState(DEFAULT_SUBJECTS.model_registry);
  const [summary, setSummary] = useState(DEFAULT_SUMMARIES.model_registry);
  const [evidenceRef, setEvidenceRef] = useState("artifact:ai-governance/model-registry-codex-prod-primary");
  const [policyDecisionRef, setPolicyDecisionRef] = useState("policy-decision:ai-governance/model-approval");
  const [auditCorrelationId, setAuditCorrelationId] = useState("");
  const [expiresOn, setExpiresOn] = useState(() => defaultFutureDate());
  const [legalHold, setLegalHold] = useState(false);
  const [metadataValues, setMetadataValues] = useState<Record<string, string>>(() => defaultMetadataValues());
  const fields = METADATA_FIELDS[evidenceType];
  const isValid = status === "valid";
  const requiresExpiry = isValid && evidenceType !== "human_override";
  const validLinkageReady =
    !isValid ||
    (evidenceRef.trim().length > 0 &&
      policyDecisionRef.trim().length > 0 &&
      isUuid(auditCorrelationId.trim()) &&
      (!requiresExpiry || expiresOn.trim().length > 0));
  const metadataReady = !isValid || fields.every((field) => metadataValueReady(field, metadataValues[field.key]));
  const hasBlockedText = recordDraftHasBlockedText({
    subjectRef,
    summary,
    evidenceRef,
    policyDecisionRef,
    metadataValues,
    fields,
  });
  const canSubmit = subjectRef.trim().length > 0 && summary.trim().length > 0 && validLinkageReady && metadataReady && !hasBlockedText && !isRecording;

  function setMetadataValue(key: string, value: string): void {
    setMetadataValues((current) => ({ ...current, [key]: value }));
  }

  function selectEvidenceType(next: AiGovernanceEvidenceType): void {
    setEvidenceType(next);
    if (Object.values(DEFAULT_SUBJECTS).includes(subjectRef) || subjectRef.trim().length === 0) setSubjectRef(DEFAULT_SUBJECTS[next]);
    if (Object.values(DEFAULT_SUMMARIES).includes(summary) || summary.trim().length === 0) setSummary(DEFAULT_SUMMARIES[next]);
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      evidenceType,
      status,
      subjectRef: subjectRef.trim(),
      summary: summary.trim(),
      evidenceRef: evidenceRef.trim(),
      policyDecisionRef: policyDecisionRef.trim(),
      auditCorrelationId: auditCorrelationId.trim(),
      expiresOn: expiresOn.trim(),
      metadataValues,
      legalHold,
    });
  }

  return (
    <form className="production-readiness-record" onSubmit={submit}>
      <div className="production-readiness-evidence-head">
        <div>
          <strong>AI 거버넌스 증빙 기록</strong>
        </div>
        <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
          {lastRecordedId !== null ? <span className="badge green">기록됨 {lastRecordedId}</span> : null}
          {error !== null ? <span className="badge red">{errorLabel(error)}</span> : null}
        </span>
      </div>
      <div className="production-readiness-record-grid">
        <label>
          증빙 종류
          <select value={evidenceType} onChange={(event) => selectEvidenceType(event.target.value as AiGovernanceEvidenceType)}>
            {EVIDENCE_TYPES.map((type) => (
              <option key={type} value={type}>
                {evidenceTypeLabel(type)}
              </option>
            ))}
          </select>
        </label>
        <label>
          상태
          <select value={status} onChange={(event) => setStatus(event.target.value as AiGovernanceEvidenceStatus)}>
            {EVIDENCE_STATUSES.map((item) => (
              <option key={item} value={item}>
                {evidenceStatusLabel(item)}
              </option>
            ))}
          </select>
        </label>
        <label>
          대상 참조
          <input value={subjectRef} onChange={(event) => setSubjectRef(event.target.value)} placeholder="model:codex-prod-primary" />
        </label>
        <label>
          요약
          <input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="감사 연동 증빙과 함께 승인을 기록" />
        </label>
        <label>
          증빙 참조
          <input value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} placeholder="artifact:ai-governance/model-approval" />
        </label>
        <label>
          정책 결정 참조
          <input value={policyDecisionRef} onChange={(event) => setPolicyDecisionRef(event.target.value)} placeholder="policy-decision:ai-governance/model-approval" />
        </label>
        <label>
          감사 추적 ID
          <input value={auditCorrelationId} onChange={(event) => setAuditCorrelationId(event.target.value)} placeholder="00000000-0000-4000-8000-000000000000" />
        </label>
        <label>
          만료일
          <input type="date" value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} />
        </label>
      </div>
      <div className="production-readiness-record-grid">
        {fields.map((field) => (
          <MetadataInput key={field.key} field={field} value={metadataValues[field.key] ?? ""} onChange={(value) => setMetadataValue(field.key, value)} />
        ))}
      </div>
      <label className="subtle" style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={legalHold} onChange={(event) => setLegalHold(event.target.checked)} />
        법적 보존으로 유지
      </label>
      {isValid && !validLinkageReady ? (
        <span className="subtle">유효 증빙에는 증빙 참조, 정책 결정 참조, 감사 추적 ID가 필요하며 사람 개입 외에는 미래 만료일도 필요합니다.</span>
      ) : null}
      {isValid && !metadataReady ? <span className="subtle">유효한 {evidenceTypeLabel(evidenceType)} 증빙에는 템플릿 세부 항목을 모두 입력해야 합니다.</span> : null}
      {hasBlockedText ? <span className="subtle">참조 값만 입력하세요. 주소(URL)나 비밀번호·토큰 같은 값은 지운 뒤 기록하세요.</span> : null}
      <div className="form-actions">
        <button className="btn primary" type="submit" disabled={!canSubmit}>
          {isRecording ? "기록 중" : "AI 증빙 기록"}
        </button>
      </div>
    </form>
  );
}

function MetadataInput({
  field,
  value,
  onChange,
}: {
  field: MetadataField;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  if (field.kind === "boolean") {
    return (
      <label>
        {field.label}
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="true">통과</option>
          <option value="false">실패</option>
        </select>
      </label>
    );
  }
  if (field.kind === "select") {
    return (
      <label>
        {field.label}
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {METADATA_OPTION_LABELS[option] ?? option}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label>
      {field.label}
      <input
        type={field.kind === "number" ? "number" : "text"}
        step={field.kind === "number" ? "0.01" : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.placeholder}
      />
    </label>
  );
}

function EvidenceTile({
  title,
  value,
  detail,
  tone,
}: {
  title: string;
  value: string;
  detail: string;
  tone: "green" | "blue" | "amber" | "red" | "muted";
}): JSX.Element {
  return (
    <div className="ops-health-tile">
      <span className="subtle">{title}</span>
      <strong>{value}</strong>
      <span className={`badge ${tone}`}>{detail}</span>
    </div>
  );
}

function summarizeEvidence(items: readonly AiGovernanceEvidence[]): { total: number; valid: number; deferred: number; failed: number } {
  return {
    total: items.length,
    valid: items.filter((item) => item.status === "valid").length,
    deferred: items.filter((item) => item.status === "deferred").length,
    failed: items.filter((item) => item.status === "failed").length,
  };
}

function buildEvidenceRequest(draft: EvidenceRecordDraft): AiGovernanceEvidenceRequest {
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

function metadataValueReady(field: MetadataField, value: string | undefined): boolean {
  if (value === undefined || value.trim().length === 0) return false;
  if (field.kind === "number") return Number.isFinite(Number(value));
  return true;
}

function recordDraftHasBlockedText({
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

function defaultMetadataValues(): Record<string, string> {
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

function defaultFutureDate(): string {
  return new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// 증빙 종류 → 운영자 한국어(닫힌 맵). 미매핑은 raw 폴백(조용한 공백 금지).
const EVIDENCE_TYPE_LABELS: Record<string, string> = {
  model_registry: "모델 등록", prompt_registry: "프롬프트 등록", eval_result: "평가 결과", cost_control: "비용 통제", human_override: "사람 개입",
};
function evidenceTypeLabel(type: AiGovernanceEvidenceType): string {
  return EVIDENCE_TYPE_LABELS[type] ?? type;
}

// 증빙 상태 → 운영자 한국어(닫힌 맵). 미매핑은 raw 폴백(조용한 공백 금지).
const EVIDENCE_STATUS_LABELS: Record<string, string> = { valid: "유효", deferred: "보류", failed: "실패" };
function evidenceStatusLabel(status: AiGovernanceEvidenceStatus): string {
  return EVIDENCE_STATUS_LABELS[status] ?? status;
}

function evidenceStatusTone(status: AiGovernanceEvidenceStatus): "green" | "amber" | "red" {
  if (status === "valid") return "green";
  if (status === "deferred") return "amber";
  return "red";
}

function metadataSummary(item: AiGovernanceEvidence): string {
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

function refText(value: string | null): string {
  return value === null || value.trim().length === 0 ? "없음" : safeText(value);
}

function safeText(value: string): string {
  if (isBlockedEvidenceText(value)) return "표시 제한";
  return value;
}

function isBlockedEvidenceText(value: string): boolean {
  return /https?:\/\//i.test(value) ||
    /\bbearer\s+[a-z0-9._~+/=-]{8,}/i.test(value) ||
    /\b(token|password|secret|credential|authorization)\s*[:=]\s*\S{4,}/i.test(value);
}

function stringFilterValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function governanceEvidenceKey(draft: EvidenceRecordDraft): string {
  return `ai-governance-${stableKeyPart(draft.evidenceType)}-${stableKeyPart(draft.subjectRef)}-${Date.now()}`;
}

function stableKeyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 80);
}
