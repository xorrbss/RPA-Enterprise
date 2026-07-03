import { useMemo, useState, type FormEvent } from "react";

import type {
  HumanTaskPolicySnapshot,
  RunItem,
  RunPriority,
  RunResumeRequest,
  WebAttendedRunRequest,
} from "../../api/types";
import { formatDateTime } from "./format";
import { statusLabel } from "../../components/badges";

export interface WebAttendedRunCreateDraft {
  readonly scenarioVersionId: string;
  readonly paramsJson: string;
  readonly model: string | null;
  readonly priority: RunPriority;
  readonly humanTaskId: string | null;
  readonly consentSummary: string;
  readonly consentEvidenceRef: string | null;
  readonly inputRefsCsv: string;
  readonly legalHold: boolean;
}

const DEFAULT_POLICY: HumanTaskPolicySnapshot = {
  source: "ops-defaults.md#human_task.default_timeout",
  default_timeout_ms: 1_800_000,
  on_timeout: "fail",
  allowed_kinds: ["approval", "validation", "exception", "captcha", "mfa"],
};

const RUN_PRIORITIES: readonly RunPriority[] = ["low", "medium", "high", "critical"];
const RUN_PRIORITY_LABELS: Record<RunPriority, string> = {
  low: "낮음",
  medium: "보통",
  high: "높음",
  critical: "긴급",
};

export function WebAttendedPanel({
  runRequests,
  resumeRequests,
  suspendedRuns,
  isLoading,
  isError,
  canCreate,
  isCreating,
  createError,
  onCreate,
  canResume,
  resumingRunId,
  resumeErrorRunId,
  onResume,
}: {
  readonly runRequests: readonly WebAttendedRunRequest[];
  readonly resumeRequests: readonly RunResumeRequest[];
  readonly suspendedRuns: readonly RunItem[];
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly canCreate: boolean;
  readonly isCreating: boolean;
  readonly createError: boolean;
  readonly onCreate: (draft: WebAttendedRunCreateDraft) => void;
  readonly canResume: boolean;
  readonly resumingRunId: string | null;
  readonly resumeErrorRunId: string | null;
  readonly onResume: (run: RunItem) => void;
}): JSX.Element {
  const policy = useMemo(
    () => runRequests[0]?.human_task_policy ?? resumeRequests[0]?.human_task_policy ?? DEFAULT_POLICY,
    [resumeRequests, runRequests],
  );

  return (
    <div className="ops-column">
      <div className="ops-alert-center-head">
        <h3>사람 확인 실행</h3>
        <span className="badge muted">{isLoading ? "확인 중" : `${runRequests.length + resumeRequests.length}건`}</span>
      </div>
      <PolicySummary policy={policy} />
      {canCreate && (
        <WebAttendedRunCreateForm
          isCreating={isCreating}
          hasError={createError}
          onCreate={onCreate}
        />
      )}
      <WebAttendedRunRequestList requests={runRequests} isError={isError} />
      <SuspendedRunList
        runs={suspendedRuns}
        canResume={canResume}
        resumingRunId={resumingRunId}
        resumeErrorRunId={resumeErrorRunId}
        onResume={onResume}
      />
      <RunResumeRequestList requests={resumeRequests} isError={isError} />
    </div>
  );
}

function PolicySummary({ policy }: { readonly policy: HumanTaskPolicySnapshot }): JSX.Element {
  return (
    <div className="ops-delivery-panel" role="status">
      <div className="ops-alert-badges">
        <span className="badge blue">{formatDuration(policy.default_timeout_ms)}</span>
        <span className="badge amber">{onTimeoutLabel(policy.on_timeout)}</span>
      </div>
      <span className="subtle">{policy.allowed_kinds.join(", ")}</span>
    </div>
  );
}

function WebAttendedRunCreateForm({
  isCreating,
  hasError,
  onCreate,
}: {
  readonly isCreating: boolean;
  readonly hasError: boolean;
  readonly onCreate: (draft: WebAttendedRunCreateDraft) => void;
}): JSX.Element {
  const [scenarioVersionId, setScenarioVersionId] = useState("00000000-0000-4000-8000-000000000101");
  const [paramsJson, setParamsJson] = useState("{\n  \"as_of\": \"2026-06-30T00:00:00.000Z\"\n}");
  const [model, setModel] = useState("");
  const [priority, setPriority] = useState<RunPriority>("medium");
  const [humanTaskId, setHumanTaskId] = useState("");
  const [consentSummary, setConsentSummary] = useState("업무 담당자가 사람 확인 실행을 승인했습니다.");
  const [consentEvidenceRef, setConsentEvidenceRef] = useState("ticket:RPA-ATT-1001");
  const [inputRefsCsv, setInputRefsCsv] = useState("artifact://web-attended/input-001");
  const [legalHold, setLegalHold] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const scenario = scenarioVersionId.trim();
    const consent = consentSummary.trim();
    const evidence = consentEvidenceRef.trim();
    const humanTask = humanTaskId.trim();
    const selectedModel = model.trim();
    if (scenario.length === 0 || consent.length === 0) {
      setValidationError("자동화 버전 ID와 실행 동의 요약을 입력하세요.");
      return;
    }
    try {
      JSON.parse(paramsJson);
    } catch {
      setValidationError("실행 파라미터는 올바른 JSON이어야 합니다.");
      return;
    }
    setValidationError(null);
    onCreate({
      scenarioVersionId: scenario,
      paramsJson,
      model: selectedModel.length === 0 ? null : selectedModel,
      priority,
      humanTaskId: humanTask.length === 0 ? null : humanTask,
      consentSummary: consent,
      consentEvidenceRef: evidence.length === 0 ? null : evidence,
      inputRefsCsv,
      legalHold,
    });
  }

  return (
    <form className="ops-webhook-form" onSubmit={submit}>
      <div className="form-grid ops-webhook-grid">
        <label className="field">
          자동화 버전 ID
          <input aria-label="사람 확인 실행 자동화 버전 ID" value={scenarioVersionId} onChange={(event) => setScenarioVersionId(event.target.value)} />
        </label>
        <label className="field">
          우선순위
          <select aria-label="사람 확인 실행 우선순위" value={priority} onChange={(event) => setPriority(event.target.value as RunPriority)}>
            {RUN_PRIORITIES.map((item) => (
              <option key={item} value={item}>{RUN_PRIORITY_LABELS[item]}</option>
            ))}
          </select>
        </label>
        <label className="field">
          모델
          <input aria-label="사람 확인 실행 모델" value={model} onChange={(event) => setModel(event.target.value)} />
        </label>
        <label className="field">
          사람 확인 작업 ID
          <input aria-label="사람 확인 작업 ID" value={humanTaskId} onChange={(event) => setHumanTaskId(event.target.value)} />
        </label>
        <label className="field ops-webhook-summary">
          실행 파라미터(JSON)
          <textarea aria-label="사람 확인 실행 파라미터 JSON" rows={4} value={paramsJson} onChange={(event) => setParamsJson(event.target.value)} />
        </label>
        <label className="field ops-webhook-summary">
          실행 동의 요약
          <textarea aria-label="사람 확인 실행 동의 요약" rows={2} value={consentSummary} onChange={(event) => setConsentSummary(event.target.value)} />
        </label>
        <label className="field">
          동의 증빙 참조
          <input aria-label="사람 확인 실행 동의 증빙 참조" value={consentEvidenceRef} onChange={(event) => setConsentEvidenceRef(event.target.value)} />
        </label>
        <label className="field">
          입력 증빙 참조
          <input aria-label="사람 확인 실행 입력 증빙 참조" value={inputRefsCsv} onChange={(event) => setInputRefsCsv(event.target.value)} />
        </label>
      </div>
      <div className="inline-actions">
        <label className="checkbox-inline">
          <input type="checkbox" checked={legalHold} onChange={(event) => setLegalHold(event.target.checked)} />
          법적 보존
        </label>
        <button className="btn" type="submit" disabled={isCreating}>
          {isCreating ? "요청 중" : "실행 요청"}
        </button>
        {validationError !== null && <span className="form-alert red" role="alert">{validationError}</span>}
        {hasError && <span className="form-alert red" role="alert">사람 확인 실행 요청에 실패했습니다.</span>}
      </div>
    </form>
  );
}

function WebAttendedRunRequestList({
  requests,
  isError,
}: {
  readonly requests: readonly WebAttendedRunRequest[];
  readonly isError: boolean;
}): JSX.Element {
  if (isError) {
    return (
      <div className="ops-alert-empty" role="status">
        <strong>실행 요청 장부를 불러오지 못했습니다.</strong>
        <span className="subtle">실행 요청 목록을 확인할 수 없습니다.</span>
      </div>
    );
  }
  if (requests.length === 0) {
    return (
      <div className="ops-alert-empty" role="status">
        <strong>실행 요청 없음</strong>
        <span className="subtle">현재 테넌트에 요청 행이 없습니다.</span>
      </div>
    );
  }
  return (
    <ul className="ops-alert-list">
      {requests.map((request) => (
        <li key={request.request_id}>
          <div className="ops-alert-main">
            <div className="ops-alert-badges">
              <span className={`badge ${webAttendedTone(request.status)}`}>{webAttendedStatusLabel(request.status)}</span>
              <span className="subtle">{formatDateTime(request.requested_at)}</span>
            </div>
            <strong>{request.scenario_version_id}</strong>
            <span className="subtle">실행 {request.run_id ?? "-"}</span>
            <span className="subtle">{request.consent_summary}</span>
            {request.consent_evidence_ref !== null && <span className="subtle">증빙 {request.consent_evidence_ref}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function SuspendedRunList({
  runs,
  canResume,
  resumingRunId,
  resumeErrorRunId,
  onResume,
}: {
  readonly runs: readonly RunItem[];
  readonly canResume: boolean;
  readonly resumingRunId: string | null;
  readonly resumeErrorRunId: string | null;
  readonly onResume: (run: RunItem) => void;
}): JSX.Element {
  if (runs.length === 0) {
    return (
      <div className="ops-alert-empty" role="status">
        <strong>일시 중단 실행 없음</strong>
        <span className="subtle">재개 대기열이 비어 있습니다.</span>
      </div>
    );
  }
  return (
    <ul className="ops-delivery-list">
      {runs.map((run) => (
        <li key={run.run_id}>
          <div className="ops-delivery-panel-head">
            <div>
              <strong>{run.run_id}</strong>
              <span className="subtle">{run.current_node ?? "현재 노드 없음"} / {formatDateTime(run.updated_at ?? run.as_of)}</span>
            </div>
            {canResume && (
              <button className="linklike" type="button" disabled={resumingRunId === run.run_id} onClick={() => onResume(run)}>
                {resumingRunId === run.run_id ? "재개 중" : "재개"}
              </button>
            )}
          </div>
          {resumeErrorRunId === run.run_id && <span className="form-alert red" role="alert">재개에 실패했습니다.</span>}
        </li>
      ))}
    </ul>
  );
}

function RunResumeRequestList({
  requests,
  isError,
}: {
  readonly requests: readonly RunResumeRequest[];
  readonly isError: boolean;
}): JSX.Element {
  if (isError) {
    return (
      <div className="ops-alert-empty" role="status">
        <strong>재개 요청 장부를 불러오지 못했습니다.</strong>
        <span className="subtle">재개 요청 목록을 확인할 수 없습니다.</span>
      </div>
    );
  }
  if (requests.length === 0) {
    return (
      <div className="ops-alert-empty" role="status">
        <strong>재개 요청 없음</strong>
        <span className="subtle">현재 테넌트에 재개 요청 행이 없습니다.</span>
      </div>
    );
  }
  return (
    <ul className="ops-delivery-list">
      {requests.map((request) => (
        <li key={request.request_id}>
          <div className="ops-alert-badges">
            <span className={`badge ${resumeTone(request.status)}`}>{resumeStatusLabel(request.status)}</span>
            <span className="subtle">이전 상태: {statusLabel(request.previous_run_status)}</span>
          </div>
          <strong>{request.run_id}</strong>
          <span className="subtle">{request.reason ?? "사유 없음"} / {formatDateTime(request.requested_at)}</span>
          {request.human_task_id !== null && <span className="subtle">사람 확인 작업 {request.human_task_id}</span>}
        </li>
      ))}
    </ul>
  );
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return `${ms}ms`;
  const minutes = Math.round(ms / 60_000);
  return `${minutes}m`;
}

// U4-3: raw enum 배지 → 운영자 한국어(닫힌 맵+raw 폴백) + '취소됨=중립(muted)' 어휘 체인 정합(badges.tsx tone 원칙).
const WEB_ATTENDED_STATUS_LABELS: Record<string, string> = {
  requested: "요청됨", run_queued: "실행 대기", blocked: "차단됨", cancelled: "취소됨",
};
function webAttendedStatusLabel(status: WebAttendedRunRequest["status"]): string {
  return WEB_ATTENDED_STATUS_LABELS[status] ?? status;
}
const RESUME_STATUS_LABELS: Record<string, string> = { requested: "요청됨", reenqueued: "재대기" };
function resumeStatusLabel(status: RunResumeRequest["status"]): string {
  return RESUME_STATUS_LABELS[status] ?? status;
}
const ON_TIMEOUT_LABELS: Record<string, string> = { fail: "실패 처리", escalate: "상위 이관" };
function onTimeoutLabel(value: HumanTaskPolicySnapshot["on_timeout"]): string {
  return ON_TIMEOUT_LABELS[value] ?? value;
}

function webAttendedTone(status: WebAttendedRunRequest["status"]): "green" | "amber" | "red" | "blue" | "muted" {
  if (status === "run_queued") return "green";
  if (status === "blocked") return "red";
  if (status === "cancelled") return "muted"; // 취소됨=중립 — 실패(red)와 분리
  return "blue";
}

function resumeTone(status: RunResumeRequest["status"]): "green" | "amber" | "blue" {
  return status === "reenqueued" ? "amber" : "blue";
}
