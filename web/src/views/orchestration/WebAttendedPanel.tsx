import { useMemo, useState, type FormEvent } from "react";

import type {
  HumanTaskPolicySnapshot,
  RunItem,
  RunPriority,
  RunResumeRequest,
  WebAttendedRunRequest,
} from "../../api/types";
import { formatDateTime } from "./format";

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
        <h3>Web Attended</h3>
        <span className="badge muted">{isLoading ? "Loading" : `${runRequests.length + resumeRequests.length} ledger rows`}</span>
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
        <span className="badge amber">{policy.on_timeout}</span>
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
  const [consentSummary, setConsentSummary] = useState("Business owner approved this web-attended launch.");
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
      setValidationError("Scenario version and consent summary are required.");
      return;
    }
    try {
      JSON.parse(paramsJson);
    } catch {
      setValidationError("Params must be valid JSON.");
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
          Scenario version id
          <input aria-label="Web Attended scenario version id" value={scenarioVersionId} onChange={(event) => setScenarioVersionId(event.target.value)} />
        </label>
        <label className="field">
          Priority
          <select aria-label="Web Attended priority" value={priority} onChange={(event) => setPriority(event.target.value as RunPriority)}>
            {RUN_PRIORITIES.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Model
          <input aria-label="Web Attended model" value={model} onChange={(event) => setModel(event.target.value)} />
        </label>
        <label className="field">
          Human task id
          <input aria-label="Web Attended human task id" value={humanTaskId} onChange={(event) => setHumanTaskId(event.target.value)} />
        </label>
        <label className="field ops-webhook-summary">
          Params JSON
          <textarea aria-label="Web Attended params JSON" rows={4} value={paramsJson} onChange={(event) => setParamsJson(event.target.value)} />
        </label>
        <label className="field ops-webhook-summary">
          Consent summary
          <textarea aria-label="Web Attended consent summary" rows={2} value={consentSummary} onChange={(event) => setConsentSummary(event.target.value)} />
        </label>
        <label className="field">
          Consent evidence ref
          <input aria-label="Web Attended consent evidence ref" value={consentEvidenceRef} onChange={(event) => setConsentEvidenceRef(event.target.value)} />
        </label>
        <label className="field">
          Input refs
          <input aria-label="Web Attended input refs" value={inputRefsCsv} onChange={(event) => setInputRefsCsv(event.target.value)} />
        </label>
      </div>
      <div className="inline-actions">
        <label className="checkbox-inline">
          <input type="checkbox" checked={legalHold} onChange={(event) => setLegalHold(event.target.checked)} />
          Legal hold
        </label>
        <button className="btn" type="submit" disabled={isCreating}>
          {isCreating ? "Requesting" : "Request run"}
        </button>
        {validationError !== null && <span className="form-alert red" role="alert">{validationError}</span>}
        {hasError && <span className="form-alert red" role="alert">Web Attended request failed</span>}
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
        <strong>Web Attended ledger unavailable</strong>
        <span className="subtle">Run requests could not be loaded.</span>
      </div>
    );
  }
  if (requests.length === 0) {
    return (
      <div className="ops-alert-empty" role="status">
        <strong>No Web Attended requests</strong>
        <span className="subtle">No request rows match the current tenant.</span>
      </div>
    );
  }
  return (
    <ul className="ops-alert-list">
      {requests.map((request) => (
        <li key={request.request_id}>
          <div className="ops-alert-main">
            <div className="ops-alert-badges">
              <span className={`badge ${webAttendedTone(request.status)}`}>{request.status}</span>
              <span className="subtle">{formatDateTime(request.requested_at)}</span>
            </div>
            <strong>{request.scenario_version_id}</strong>
            <span className="subtle">run {request.run_id ?? "-"}</span>
            <span className="subtle">{request.consent_summary}</span>
            {request.consent_evidence_ref !== null && <span className="subtle">evidence {request.consent_evidence_ref}</span>}
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
        <strong>No suspended runs</strong>
        <span className="subtle">Resume queue is empty.</span>
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
              <span className="subtle">{run.current_node ?? "no current node"} / {formatDateTime(run.updated_at ?? run.as_of)}</span>
            </div>
            {canResume && (
              <button className="linklike" type="button" disabled={resumingRunId === run.run_id} onClick={() => onResume(run)}>
                {resumingRunId === run.run_id ? "Resuming" : "Resume"}
              </button>
            )}
          </div>
          {resumeErrorRunId === run.run_id && <span className="form-alert red" role="alert">Resume failed</span>}
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
        <strong>Resume ledger unavailable</strong>
        <span className="subtle">Resume requests could not be loaded.</span>
      </div>
    );
  }
  if (requests.length === 0) {
    return (
      <div className="ops-alert-empty" role="status">
        <strong>No resume requests</strong>
        <span className="subtle">No resume rows match the current tenant.</span>
      </div>
    );
  }
  return (
    <ul className="ops-delivery-list">
      {requests.map((request) => (
        <li key={request.request_id}>
          <div className="ops-alert-badges">
            <span className={`badge ${resumeTone(request.status)}`}>{request.status}</span>
            <span className="subtle">{request.previous_run_status}</span>
          </div>
          <strong>{request.run_id}</strong>
          <span className="subtle">{request.reason ?? "no reason"} / {formatDateTime(request.requested_at)}</span>
          {request.human_task_id !== null && <span className="subtle">human task {request.human_task_id}</span>}
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

function webAttendedTone(status: WebAttendedRunRequest["status"]): "green" | "amber" | "red" | "blue" {
  if (status === "run_queued") return "green";
  if (status === "blocked" || status === "cancelled") return "red";
  return "blue";
}

function resumeTone(status: RunResumeRequest["status"]): "green" | "amber" | "red" | "blue" {
  return status === "reenqueued" ? "amber" : "blue";
}
