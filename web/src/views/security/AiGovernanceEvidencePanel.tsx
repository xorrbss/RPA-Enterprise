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
  model_registry: "Model registry approval recorded with policy and audit linkage",
  prompt_registry: "Prompt template approval recorded with rollback and eval refs",
  eval_result: "Eval suite passed required AI governance checks",
  cost_control: "Cost budget and anomaly controls are approved for controlled production",
  human_override: "Human override decision recorded as audit-linked evidence",
};

const METADATA_FIELDS: Readonly<Record<AiGovernanceEvidenceType, readonly MetadataField[]>> = {
  model_registry: [
    { key: "provider_alias", label: "Provider alias", kind: "text", placeholder: "provider:primary-ai" },
    { key: "model_alias", label: "Model alias", kind: "text", placeholder: "model:codex-prod-primary" },
    { key: "model_version", label: "Model version", kind: "text", placeholder: "2026-06-approved" },
    { key: "risk_tier", label: "Risk tier", kind: "select", options: ["low", "medium", "high"] },
    { key: "data_retention_policy_ref", label: "Retention policy ref", kind: "text", placeholder: "policy:data-retention/ai" },
    { key: "tenant_allowlist_ref", label: "Tenant allowlist ref", kind: "text", placeholder: "tenant-allowlist:controlled-prod" },
    { key: "approved_at", label: "Approved at", kind: "text", placeholder: "2026-06-29T00:00:00.000Z" },
  ],
  prompt_registry: [
    { key: "prompt_template_id", label: "Prompt template id", kind: "text", placeholder: "prompt-template:invoice-triage" },
    { key: "prompt_template_version", label: "Prompt version", kind: "text", placeholder: "v3" },
    { key: "owner_ref", label: "Owner ref", kind: "text", placeholder: "team:finance-automation" },
    { key: "eval_suite_ref", label: "Eval suite ref", kind: "text", placeholder: "eval-suite:invoice-triage-regression" },
    { key: "rollback_target_ref", label: "Rollback target ref", kind: "text", placeholder: "prompt-template:invoice-triage@2" },
    { key: "approved_at", label: "Approved at", kind: "text", placeholder: "2026-06-29T00:00:00.000Z" },
  ],
  eval_result: [
    { key: "eval_suite_ref", label: "Eval suite ref", kind: "text", placeholder: "eval-suite:invoice-triage-regression" },
    { key: "dataset_ref", label: "Dataset ref", kind: "text", placeholder: "dataset:invoice-redacted-sample" },
    { key: "sampled_at", label: "Sampled at", kind: "text", placeholder: "2026-06-29T00:00:00.000Z" },
    { key: "pass_rate", label: "Pass rate", kind: "number", placeholder: "0.98" },
    { key: "prompt_injection_passed", label: "Injection check", kind: "boolean" },
    { key: "data_leakage_passed", label: "Data leakage check", kind: "boolean" },
    { key: "hallucination_passed", label: "Hallucination check", kind: "boolean" },
    { key: "policy_block_passed", label: "Policy block check", kind: "boolean" },
  ],
  cost_control: [
    { key: "budget_ref", label: "Budget ref", kind: "text", placeholder: "budget:ai-gateway/controlled-prod" },
    { key: "scope_ref", label: "Scope ref", kind: "text", placeholder: "scope:tenant-a/prod" },
    { key: "anomaly_alert_ref", label: "Anomaly alert ref", kind: "text", placeholder: "alert-route:ai-cost-anomaly" },
    { key: "monthly_limit", label: "Monthly limit", kind: "number", placeholder: "500" },
    { key: "per_run_cap", label: "Per-run cap", kind: "number", placeholder: "5" },
    { key: "effective_at", label: "Effective at", kind: "text", placeholder: "2026-06-29T00:00:00.000Z" },
  ],
  human_override: [
    { key: "override_actor_ref", label: "Actor ref", kind: "text", placeholder: "principal:reviewer-a" },
    { key: "override_action", label: "Override action", kind: "select", options: HUMAN_OVERRIDE_ACTIONS },
    { key: "reason_code", label: "Reason code", kind: "text", placeholder: "policy_exception_review" },
    { key: "audit_event_ref", label: "Audit event ref", kind: "text", placeholder: "audit-event:human-override" },
    { key: "occurred_at", label: "Occurred at", kind: "text", placeholder: "2026-06-29T00:00:00.000Z" },
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
    <section className="panel" aria-label="AI governance evidence">
      <div className="panel-head">
        <div>
          <h2>AI governance evidence</h2>
        </div>
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <FilterSelect
            label="Type"
            value={stringFilterValue(lv.filter.evidence_type)}
            options={EVIDENCE_TYPES}
            labelFor={(value) => evidenceTypeLabel(value as AiGovernanceEvidenceType)}
            onChange={(value) => setFilter("evidence_type", value)}
          />
          <FilterSelect
            label="Status"
            value={stringFilterValue(lv.filter.status)}
            options={EVIDENCE_STATUSES}
            labelFor={(value) => evidenceStatusLabel(value as AiGovernanceEvidenceStatus)}
            onChange={(value) => setFilter("status", value)}
          />
          <form onSubmit={applySubjectFilter} style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <label className="subtle" htmlFor="ai-governance-subject-filter">
              Subject
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
            <button className="btn" type="submit">
              Apply
            </button>
          </form>
        </span>
      </div>
      <div className="panel-body">
        <div className="ops-health-grid" style={{ paddingTop: 16 }}>
          <EvidenceTile title="Evidence rows" value={String(summary.total)} detail="current filter page" tone="blue" />
          <EvidenceTile title="Valid" value={String(summary.valid)} detail="audit-linked approvals" tone={summary.valid > 0 ? "green" : "muted"} />
          <EvidenceTile title="Deferred" value={String(summary.deferred)} detail="owner evidence pending" tone={summary.deferred > 0 ? "amber" : "muted"} />
          <EvidenceTile title="Failed" value={String(summary.failed)} detail="control check failed" tone={summary.failed > 0 ? "red" : "muted"} />
        </div>
        <EvidenceTable queryState={lv.query} items={items} />
        {lv.pager.hasPrev || lv.pager.hasNext ? (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 16px", alignItems: "center" }}>
            <button className="btn" type="button" onClick={lv.pager.onPrev} disabled={!lv.pager.hasPrev}>
              Previous
            </button>
            <span className="subtle">page {lv.pager.pageIndex + 1}</span>
            <button className="btn" type="button" onClick={lv.pager.onNext} disabled={!lv.pager.hasNext}>
              Next
            </button>
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
            Admin role is required to record AI governance evidence.
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
  if (items.length === 0) return <EmptyState message="No AI governance evidence matches the current filters." />;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Status</th>
            <th>Subject</th>
            <th>Evidence</th>
            <th>Policy/audit</th>
            <th>Recorded</th>
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
                  evidence {refText(item.evidence_ref)}
                </span>
                <span className="subtle" style={{ display: "block" }}>
                  {metadataSummary(item)}
                </span>
              </td>
              <td>
                <span className="subtle" style={{ display: "block" }}>
                  policy {refText(item.policy_decision_ref)}
                </span>
                <span className="subtle" style={{ display: "block" }}>
                  audit {refText(item.audit_correlation_id)}
                </span>
                <span className="subtle" style={{ display: "block" }}>
                  expires {formatDateTime(item.expires_at)}
                </span>
              </td>
              <td>
                <span className="subtle" style={{ display: "block" }}>
                  {formatDateTime(item.recorded_at)}
                </span>
                <span className="subtle" style={{ display: "block" }}>
                  by {safeText(item.recorded_by)}
                </span>
                {item.legal_hold ? <span className="badge amber">legal hold</span> : null}
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
          <strong>Record AI governance evidence</strong>
        </div>
        <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
          {lastRecordedId !== null ? <span className="badge green">recorded {lastRecordedId}</span> : null}
          {error !== null ? <span className="badge red">{errorLabel(error)}</span> : null}
        </span>
      </div>
      <div className="production-readiness-record-grid">
        <label>
          Evidence type
          <select value={evidenceType} onChange={(event) => selectEvidenceType(event.target.value as AiGovernanceEvidenceType)}>
            {EVIDENCE_TYPES.map((type) => (
              <option key={type} value={type}>
                {evidenceTypeLabel(type)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select value={status} onChange={(event) => setStatus(event.target.value as AiGovernanceEvidenceStatus)}>
            {EVIDENCE_STATUSES.map((item) => (
              <option key={item} value={item}>
                {evidenceStatusLabel(item)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Subject ref
          <input value={subjectRef} onChange={(event) => setSubjectRef(event.target.value)} placeholder="model:codex-prod-primary" />
        </label>
        <label>
          Summary
          <input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="Approval recorded with audit-linked evidence" />
        </label>
        <label>
          Evidence ref
          <input value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} placeholder="artifact:ai-governance/model-approval" />
        </label>
        <label>
          Policy decision ref
          <input value={policyDecisionRef} onChange={(event) => setPolicyDecisionRef(event.target.value)} placeholder="policy-decision:ai-governance/model-approval" />
        </label>
        <label>
          Audit correlation id
          <input value={auditCorrelationId} onChange={(event) => setAuditCorrelationId(event.target.value)} placeholder="00000000-0000-4000-8000-000000000000" />
        </label>
        <label>
          Expires on
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
        Retain under legal hold
      </label>
      {isValid && !validLinkageReady ? (
        <span className="subtle">Valid evidence requires evidence ref, policy decision ref, audit correlation id, and future expiry except human override.</span>
      ) : null}
      {isValid && !metadataReady ? <span className="subtle">Valid {evidenceTypeLabel(evidenceType)} evidence requires all template metadata fields.</span> : null}
      {hasBlockedText ? <span className="subtle">Use opaque refs only; remove endpoints or credential-like material before recording.</span> : null}
      <div className="form-actions">
        <button className="btn primary" type="submit" disabled={!canSubmit}>
          {isRecording ? "Recording" : "Record AI evidence"}
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
          <option value="true">passed</option>
          <option value="false">failed</option>
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
              {option.replaceAll("_", " ")}
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

function evidenceTypeLabel(type: AiGovernanceEvidenceType): string {
  if (type === "model_registry") return "Model registry";
  if (type === "prompt_registry") return "Prompt registry";
  if (type === "eval_result") return "Eval result";
  if (type === "cost_control") return "Cost control";
  return "Human override";
}

function evidenceStatusLabel(status: AiGovernanceEvidenceStatus): string {
  if (status === "valid") return "Valid";
  if (status === "deferred") return "Deferred";
  return "Failed";
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
      `provider ${metadataText(metadata.provider_alias)}`,
      `model ${metadataText(metadata.model_alias)}`,
      `version ${metadataText(metadata.model_version)}`,
      `risk ${metadataText(metadata.risk_tier)}`,
    ].join(" / ");
  }
  if (item.evidence_type === "prompt_registry") {
    return [
      `template ${metadataText(metadata.prompt_template_id)}`,
      `version ${metadataText(metadata.prompt_template_version)}`,
      `eval ${metadataText(metadata.eval_suite_ref)}`,
      `rollback ${metadataText(metadata.rollback_target_ref)}`,
    ].join(" / ");
  }
  if (item.evidence_type === "eval_result") {
    return [
      `suite ${metadataText(metadata.eval_suite_ref)}`,
      `dataset ${metadataText(metadata.dataset_ref)}`,
      `pass rate ${metadataText(metadata.pass_rate)}`,
      `sampled ${metadataText(metadata.sampled_at)}`,
    ].join(" / ");
  }
  if (item.evidence_type === "cost_control") {
    return [
      `budget ${metadataText(metadata.budget_ref)}`,
      `scope ${metadataText(metadata.scope_ref)}`,
      `monthly ${metadataText(metadata.monthly_limit)}`,
      `per-run ${metadataText(metadata.per_run_cap)}`,
    ].join(" / ");
  }
  return [
    `actor ${metadataText(metadata.override_actor_ref)}`,
    `action ${metadataText(metadata.override_action)}`,
    `reason ${metadataText(metadata.reason_code)}`,
    `event ${metadataText(metadata.audit_event_ref)}`,
  ].join(" / ");
}

function metadataText(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return typeof value === "string" && value.trim().length > 0 ? safeText(value) : "missing";
}

function refText(value: string | null): string {
  return value === null || value.trim().length === 0 ? "missing" : safeText(value);
}

function safeText(value: string): string {
  if (isBlockedEvidenceText(value)) return "withheld";
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
