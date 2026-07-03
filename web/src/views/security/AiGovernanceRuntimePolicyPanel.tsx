import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { useCan } from "../../api/permissions";
import type {
  AiGovernanceRuntimePolicy,
  AiGovernanceRuntimePolicyMode,
  AiGovernanceRuntimePolicyRequest,
} from "../../api/types";
import { errorLabel } from "../../components/badges";
import { EmptyState, ErrorState, Loading } from "../../components/states";
import { formatDateTime } from "../orchestration/format";

const POLICY_QUERY_KEY = ["ai-governance-runtime-policy"] as const;
const POLICY_MODES = ["observe", "warn", "block"] as const;

interface PolicyDraft {
  readonly mode: AiGovernanceRuntimePolicyMode;
  readonly subjectMappingRef: string;
  readonly graceUntil: string;
  readonly emergencyOverrideOwnerRef: string;
  readonly policyDecisionRef: string;
  readonly evidenceRef: string;
}

const DEFAULT_DRAFT: PolicyDraft = {
  mode: "warn",
  subjectMappingRef: "subject-map:ai-runtime/default",
  graceUntil: "",
  emergencyOverrideOwnerRef: "team:ai-governance-oncall",
  policyDecisionRef: "policy-decision:ai-governance/runtime-enforcement",
  evidenceRef: "",
};

export function AiGovernanceRuntimePolicyPanel(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<PolicyDraft>(DEFAULT_DRAFT);
  const [loadedPolicyKey, setLoadedPolicyKey] = useState<string | null>(null);
  const [lastSavedPolicyId, setLastSavedPolicyId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: POLICY_QUERY_KEY,
    queryFn: () => api.getAiGovernanceRuntimePolicy(),
    refetchInterval: 30_000,
  });
  const policy = query.data?.configured === true ? query.data.policy : undefined;
  const currentPolicyKey = policy !== undefined ? `${policy.policy_id}:${policy.updated_at}` : query.data?.configured === false ? "not-configured" : null;
  const canManage = can("ai_governance.manage");
  const save = useMutation({
    mutationFn: (request: AiGovernanceRuntimePolicyRequest) =>
      api.upsertAiGovernanceRuntimePolicy(request, runtimePolicyKey(request)),
    onSuccess: (savedPolicy) => {
      setLastSavedPolicyId(savedPolicy.policy_id);
      void queryClient.invalidateQueries({ queryKey: POLICY_QUERY_KEY });
    },
  });

  useEffect(() => {
    if (currentPolicyKey === null || currentPolicyKey === loadedPolicyKey) return;
    setLoadedPolicyKey(currentPolicyKey);
    setDraft(policy !== undefined ? policyToDraft(policy) : DEFAULT_DRAFT);
  }, [currentPolicyKey, loadedPolicyKey, policy]);

  const validation = useMemo(() => validateDraft(draft), [draft]);

  function setField<K extends keyof PolicyDraft>(key: K, value: PolicyDraft[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!validation.canSubmit || save.isPending) return;
    save.mutate(buildPolicyRequest(draft));
  }

  return (
    <section className="panel" aria-label="AI 운영 정책" style={{ marginBottom: 12 }}>
      <div className="panel-head">
        <div>
          <h2>AI 운영 정책</h2>
        </div>
        <span className={`badge ${policyTone(policy)}`}>{policyBadgeLabel(policy)}</span>
      </div>
      <div className="panel-body">
        {query.isLoading ? (
          <Loading />
        ) : query.isError ? (
          <ErrorState message={errorLabel(query.error)} onRetry={() => void query.refetch()} />
        ) : (
          <>
            <div className="ops-health-grid" style={{ paddingTop: 16 }}>
              <PolicyTile title="정책 설정" value={policy !== undefined ? "설정됨" : "미설정"} detail="테넌트 AI 실행 통제" tone={policy !== undefined ? "green" : "amber"} />
              <PolicyTile title="적용 방식" value={policy !== undefined ? modeLabel(policy.mode) : "미설정"} detail={modeDetail(policy?.mode)} tone={policyTone(policy)} />
              <PolicyTile title="유예 기한" value={formatDateTime(policy?.grace_until)} detail={graceDetail(policy?.grace_until)} tone={graceTone(policy?.grace_until)} />
              <PolicyTile title="감사 기록" value={policy?.audit_action ?? "미설정"} detail="변경 불가 감사 기록" tone={policy !== undefined ? "blue" : "amber"} />
            </div>
            <CurrentPolicy policy={policy} />
            {canManage ? (
              <form className="production-readiness-record" onSubmit={submit}>
                <div className="production-readiness-evidence-head">
                  <div>
                    <strong>운영 정책 등록·변경</strong>
                  </div>
                  <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
                    {lastSavedPolicyId !== null ? <span className="badge green">저장됨 {safeRef(lastSavedPolicyId)}</span> : null}
                    {save.error !== null ? <span className="badge red">{errorLabel(save.error)}</span> : null}
                  </span>
                </div>
                <div className="production-readiness-record-grid">
                  <label>
                    적용 방식
                    <select value={draft.mode} onChange={(event) => setField("mode", event.target.value as AiGovernanceRuntimePolicyMode)}>
                      {POLICY_MODES.map((mode) => (
                        <option key={mode} value={mode}>
                          {modeLabel(mode)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    대상 매핑 참조
                    <input value={draft.subjectMappingRef} onChange={(event) => setField("subjectMappingRef", event.target.value)} placeholder="subject-map:ai-runtime/default" />
                  </label>
                  <label>
                    유예 기한
                    <input type="datetime-local" value={draft.graceUntil} onChange={(event) => setField("graceUntil", event.target.value)} />
                  </label>
                  <label>
                    긴급 해제 담당 참조
                    <input value={draft.emergencyOverrideOwnerRef} onChange={(event) => setField("emergencyOverrideOwnerRef", event.target.value)} placeholder="team:ai-governance-oncall" />
                  </label>
                  <label>
                    정책 결정 참조
                    <input value={draft.policyDecisionRef} onChange={(event) => setField("policyDecisionRef", event.target.value)} placeholder="policy-decision:ai-governance/runtime-enforcement" />
                  </label>
                  <label>
                    증빙 참조
                    <input value={draft.evidenceRef} onChange={(event) => setField("evidenceRef", event.target.value)} placeholder="artifact:ai-governance/runtime-policy" />
                  </label>
                </div>
                {!validation.hasRequiredRefs ? <span className="subtle">적용 방식, 대상 매핑, 긴급 해제 담당, 정책 결정 참조를 모두 입력하세요.</span> : null}
                {validation.graceInvalid ? <span className="subtle">유예 기한은 미래 날짜와 시간이어야 합니다.</span> : null}
                {validation.hasBlockedText ? <span className="subtle">참조 값만 입력하세요. 주소(URL)나 비밀번호·토큰 같은 값은 지운 뒤 저장하세요.</span> : null}
                <div className="form-actions">
                  <button className="btn primary" type="submit" disabled={!validation.canSubmit || save.isPending}>
                    {save.isPending ? "저장 중" : "운영 정책 저장"}
                  </button>
                </div>
              </form>
            ) : (
              <p className="subtle" style={{ borderTop: "1px solid var(--line)", margin: "0 16px 16px", paddingTop: 12 }}>
                AI 운영 정책 관리는 관리자 권한이 필요합니다.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function CurrentPolicy({ policy }: { policy: AiGovernanceRuntimePolicy | undefined }): JSX.Element {
  if (policy === undefined) return <EmptyState message="설정된 AI 운영 정책이 없습니다." />;
  return (
    <div className="table-wrap">
      <table className="ops-table">
        <thead>
          <tr>
            <th scope="col">상태</th>
            <th scope="col">참조</th>
            <th scope="col">감사</th>
            <th scope="col">변경</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <span className={`badge ${policyTone(policy)}`}>{modeLabel(policy.mode)}</span>
              <span className="subtle" style={{ display: "block" }}>
                유예 {formatDateTime(policy.grace_until)}
              </span>
            </td>
            <td>
              <span className="subtle" style={{ display: "block" }}>
                대상 {safeRef(policy.subject_mapping_ref)}
              </span>
              <span className="subtle" style={{ display: "block" }}>
                담당 {safeRef(policy.emergency_override_owner_ref)}
              </span>
              <span className="subtle" style={{ display: "block" }}>
                결정 {safeRef(policy.policy_decision_ref)}
              </span>
              <span className="subtle" style={{ display: "block" }}>
                증빙 {nullableRef(policy.evidence_ref)}
              </span>
            </td>
            <td>
              <code>{policy.audit_action}</code>
            </td>
            <td>
              <span className="subtle" style={{ display: "block" }}>
                처리자 {safeRef(policy.updated_by)}
              </span>
              <span className="subtle" style={{ display: "block" }}>
                {formatDateTime(policy.updated_at)}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function PolicyTile({
  title,
  value,
  detail,
  tone,
}: {
  title: string;
  value: string;
  detail: string;
  tone: "green" | "blue" | "amber" | "red";
}): JSX.Element {
  return (
    <div className="ops-health-tile">
      <span className="subtle">{title}</span>
      <strong>{value}</strong>
      <span className={`badge ${tone}`}>{detail}</span>
    </div>
  );
}

function policyToDraft(policy: AiGovernanceRuntimePolicy): PolicyDraft {
  return {
    mode: policy.mode,
    subjectMappingRef: safeFormValue(policy.subject_mapping_ref),
    graceUntil: isoToDatetimeLocal(policy.grace_until),
    emergencyOverrideOwnerRef: safeFormValue(policy.emergency_override_owner_ref),
    policyDecisionRef: safeFormValue(policy.policy_decision_ref),
    evidenceRef: safeFormValue(policy.evidence_ref ?? ""),
  };
}

function buildPolicyRequest(draft: PolicyDraft): AiGovernanceRuntimePolicyRequest {
  return {
    mode: draft.mode,
    subject_mapping_ref: draft.subjectMappingRef.trim(),
    grace_until: datetimeLocalToIso(draft.graceUntil),
    emergency_override_owner_ref: draft.emergencyOverrideOwnerRef.trim(),
    policy_decision_ref: draft.policyDecisionRef.trim(),
    evidence_ref: blankToNull(draft.evidenceRef),
  };
}

function validateDraft(draft: PolicyDraft): {
  readonly hasRequiredRefs: boolean;
  readonly graceInvalid: boolean;
  readonly hasBlockedText: boolean;
  readonly canSubmit: boolean;
} {
  const refs = [draft.subjectMappingRef, draft.emergencyOverrideOwnerRef, draft.policyDecisionRef];
  const hasRequiredRefs = refs.every((value) => value.trim().length > 0);
  const graceIso = datetimeLocalToIso(draft.graceUntil);
  const graceInvalid = draft.graceUntil.trim().length > 0 && (graceIso === null || Date.parse(graceIso) <= Date.now());
  const hasBlockedText = [draft.subjectMappingRef, draft.graceUntil, draft.emergencyOverrideOwnerRef, draft.policyDecisionRef, draft.evidenceRef].some((value) =>
    value.trim().length > 0 && isBlockedRawText(value),
  );
  return {
    hasRequiredRefs,
    graceInvalid,
    hasBlockedText,
    canSubmit: hasRequiredRefs && !graceInvalid && !hasBlockedText,
  };
}

function policyTone(policy: AiGovernanceRuntimePolicy | undefined): "green" | "blue" | "amber" | "red" {
  if (policy === undefined) return "amber";
  if (policy.mode === "block") return "red";
  if (policy.mode === "warn") return "amber";
  return "blue";
}

function policyBadgeLabel(policy: AiGovernanceRuntimePolicy | undefined): string {
  return policy === undefined ? "미설정" : modeLabel(policy.mode);
}

// 적용 방식 → 운영자 한국어(닫힌 맵). 미매핑은 raw 폴백(조용한 공백 금지).
const MODE_LABELS: Record<string, string> = { observe: "관찰", warn: "경고", block: "차단" };
function modeLabel(mode: AiGovernanceRuntimePolicyMode): string {
  return MODE_LABELS[mode] ?? mode;
}

function modeDetail(mode: AiGovernanceRuntimePolicyMode | undefined): string {
  if (mode === "block") return "미충족 실행 차단";
  if (mode === "warn") return "경고 후 기록";
  if (mode === "observe") return "기록만 수집";
  return "정책 설정 필요";
}

function graceDetail(value: string | null | undefined): string {
  if (value === null || value === undefined) return "유예 없음";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "설정됨";
  return ms > Date.now() ? "유예 적용 중" : "유예 만료";
}

function graceTone(value: string | null | undefined): "green" | "blue" | "amber" | "red" {
  if (value === null || value === undefined) return "blue";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "amber";
  return ms > Date.now() ? "amber" : "red";
}

function isoToDatetimeLocal(value: string | null): string {
  if (value === null) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const yyyy = String(date.getFullYear()).padStart(4, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function datetimeLocalToIso(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeFormValue(value: string): string {
  return isBlockedRawText(value) ? "" : value;
}

function safeRef(value: string): string {
  return isBlockedRawText(value) ? "표시 제한" : value;
}

function nullableRef(value: string | null): string {
  return value === null || value.trim().length === 0 ? "미입력" : safeRef(value);
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isBlockedRawText(value: string): boolean {
  return /https?:\/\//i.test(value) ||
    /\bbearer\s+[a-z0-9._~+/=-]{8,}/i.test(value) ||
    /\b(api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|credential|authorization)\s*[:=]\s*\S{4,}/i.test(value) ||
    /\b(token|password|secret)=/i.test(value);
}

function runtimePolicyKey(request: AiGovernanceRuntimePolicyRequest): string {
  return `ai-runtime-policy-${request.mode}-${stableKeyPart(request.subject_mapping_ref)}-${Date.now()}`;
}

function stableKeyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 80);
}
