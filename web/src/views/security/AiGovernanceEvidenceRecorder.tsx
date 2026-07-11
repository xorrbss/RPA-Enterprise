import { useState, type FormEvent } from "react";

import type {
  AiGovernanceEvidenceStatus,
  AiGovernanceEvidenceType,
  AiGovernanceReadinessRequirement,
} from "../../api/types";
import { errorLabel } from "../../components/badges";
import {
  DEFAULT_SUBJECTS,
  DEFAULT_SUMMARIES,
  EVIDENCE_STATUSES,
  EVIDENCE_TYPES,
  METADATA_FIELDS,
  METADATA_OPTION_LABELS,
  defaultFutureDate,
  defaultMetadataValues,
  evidenceStatusLabel,
  evidenceTypeLabel,
  isUuid,
  metadataValueReady,
  openRequirements,
  recordDraftHasBlockedText,
  requirementStatusLabel,
  type EvidenceRecordDraft,
  type MetadataField,
} from "./ai-governance-evidence-shared";

export function AiGovernanceEvidenceRecorder({
  isRecording,
  error,
  lastRecordedId,
  requirements,
  onSubmit,
}: {
  isRecording: boolean;
  error: unknown;
  lastRecordedId: string | null;
  requirements: readonly AiGovernanceReadinessRequirement[] | undefined;
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

  // 준비도 게이트는 (증빙 종류 + 대상 참조) 정확 일치로만 요구를 충족시킨다. 기본 대상 참조는 어느 테넌트의
  // 요구와도 일치하지 않으므로, 그대로 기록하면 증빙은 남지만 게이트는 열린 채 남는다(조용한 실패) → 명시 경고한다.
  const open = openRequirements(requirements);
  const requiredSubjectsForType = (requirements ?? [])
    .filter((item) => item.evidence_type === evidenceType)
    .map((item) => item.subject_ref);
  const subjectClosesGate = requiredSubjectsForType.includes(subjectRef.trim());
  const subjectMissesRequirement = requiredSubjectsForType.length > 0 && !subjectClosesGate;

  function setMetadataValue(key: string, value: string): void {
    setMetadataValues((current) => ({ ...current, [key]: value }));
  }

  function selectEvidenceType(next: AiGovernanceEvidenceType): void {
    setEvidenceType(next);
    if (Object.values(DEFAULT_SUBJECTS).includes(subjectRef) || subjectRef.trim().length === 0) setSubjectRef(DEFAULT_SUBJECTS[next]);
    if (Object.values(DEFAULT_SUMMARIES).includes(summary) || summary.trim().length === 0) setSummary(DEFAULT_SUMMARIES[next]);
  }

  function applyRequirement(requirement: AiGovernanceReadinessRequirement): void {
    selectEvidenceType(requirement.evidence_type);
    setSubjectRef(requirement.subject_ref);
    setStatus("valid");
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
      {open.length > 0 ? (
        <div className="subtle" style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <span>운영 전환에 필요한 증빙</span>
          {open.map((requirement) => (
            <button
              key={`${requirement.evidence_type}:${requirement.subject_ref}`}
              className="btn"
              type="button"
              onClick={() => applyRequirement(requirement)}
            >
              {evidenceTypeLabel(requirement.evidence_type)} · {requirement.subject_ref} ({requirementStatusLabel(requirement.status)})
            </button>
          ))}
        </div>
      ) : null}
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
      {subjectMissesRequirement ? (
        <span className="subtle">
          이 대상 참조는 운영 전환에 필요한 증빙 목록에 없습니다. 기록은 되지만 준비 상태는 바뀌지 않습니다 — 위 버튼으로 요구 값을 넣으세요.
        </span>
      ) : null}
      {isValid && !validLinkageReady ? (
        <span className="subtle">
          유효 증빙에는 증빙 참조, 정책 결정 참조, 감사 추적 ID가 필요하며 사람 개입 외에는 미래 만료일도 필요합니다. 감사 추적 ID는 감사 이력 화면에서 행의 &apos;이 번호로 조회&apos;를 누르면 추적 번호 칸에 채워집니다.
        </span>
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
