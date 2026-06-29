import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import type {
  ProductionReadiness,
  ProductionReadinessEvidence,
  ProductionReadinessEvidenceStatus,
  ProductionReadinessGate,
  ProductionReadinessGateStatus,
  ProductionReadinessStatus,
} from "../../api/types";
import { formatDateTime } from "./format";

export interface SloEvidenceRecordDraft {
  readonly evidenceRef: string;
  readonly summary: string;
  readonly expiresAt: string;
  readonly sloDashboard: string;
  readonly severityModel: string;
  readonly oncallRota: string;
  readonly raciRef: string;
  readonly supportHours: string;
}

export interface BackupEvidenceRecordDraft {
  readonly evidenceRef: string;
  readonly summary: string;
  readonly expiresAt: string;
  readonly backupPolicyRef: string;
  readonly restoreScope: string;
  readonly restoreCompletedAt: string;
  readonly rtoMinutes: number;
  readonly rpoMinutes: number;
}

export interface ExternalAlertEvidenceRecordDraft {
  readonly evidenceRef: string;
  readonly summary: string;
  readonly expiresAt: string;
  readonly channel: "teams" | "slack" | "email" | "webhook";
  readonly providerAlias: string;
  readonly receiptId: string;
  readonly receiptAt: string;
}

export interface ObservabilityEvidenceRecordDraft {
  readonly evidenceRef: string;
  readonly summary: string;
  readonly expiresAt: string;
  readonly exporter: "prometheus" | "otlp";
  readonly collectorRef: string;
  readonly dashboardRef: string;
  readonly alertRouteRef: string;
  readonly sampledAt: string;
}

export interface SupportTrainingEvidenceRecordDraft {
  readonly evidenceRef: string;
  readonly summary: string;
  readonly supportModelRef: string;
  readonly trainingCompletionRef: string;
  readonly trainedRoleCount: number;
  readonly trainedUserCount: number;
  readonly coveragePercent: number;
  readonly completedAt: string;
  readonly expiresAt: string;
}

export function ProductionReadinessPanel({
  readiness,
  isLoading,
  isError,
  externalAlertEvidence,
  isExternalAlertEvidenceLoading,
  isExternalAlertEvidenceError,
  backupEvidence,
  isBackupEvidenceLoading,
  isBackupEvidenceError,
  sloEvidence,
  isSloEvidenceLoading,
  isSloEvidenceError,
  observabilityEvidence,
  isObservabilityEvidenceLoading,
  isObservabilityEvidenceError,
  canRecordBackupEvidence,
  isRecordingBackupEvidence,
  recordBackupEvidenceError,
  onRecordBackupEvidence,
  canRecordExternalAlertEvidence,
  isRecordingExternalAlertEvidence,
  recordExternalAlertEvidenceError,
  onRecordExternalAlertEvidence,
  canRecordSloEvidence,
  isRecordingSloEvidence,
  recordSloEvidenceError,
  onRecordSloEvidence,
  canRecordObservabilityEvidence,
  isRecordingObservabilityEvidence,
  recordObservabilityEvidenceError,
  onRecordObservabilityEvidence,
}: {
  readiness: ProductionReadiness | undefined;
  isLoading: boolean;
  isError: boolean;
  externalAlertEvidence: readonly ProductionReadinessEvidence[];
  isExternalAlertEvidenceLoading: boolean;
  isExternalAlertEvidenceError: boolean;
  backupEvidence: readonly ProductionReadinessEvidence[];
  isBackupEvidenceLoading: boolean;
  isBackupEvidenceError: boolean;
  sloEvidence: readonly ProductionReadinessEvidence[];
  isSloEvidenceLoading: boolean;
  isSloEvidenceError: boolean;
  observabilityEvidence: readonly ProductionReadinessEvidence[];
  isObservabilityEvidenceLoading: boolean;
  isObservabilityEvidenceError: boolean;
  canRecordBackupEvidence: boolean;
  isRecordingBackupEvidence: boolean;
  recordBackupEvidenceError: boolean;
  onRecordBackupEvidence: (draft: BackupEvidenceRecordDraft) => void;
  canRecordExternalAlertEvidence: boolean;
  isRecordingExternalAlertEvidence: boolean;
  recordExternalAlertEvidenceError: boolean;
  onRecordExternalAlertEvidence: (draft: ExternalAlertEvidenceRecordDraft) => void;
  canRecordSloEvidence: boolean;
  isRecordingSloEvidence: boolean;
  recordSloEvidenceError: boolean;
  onRecordSloEvidence: (draft: SloEvidenceRecordDraft) => void;
  canRecordObservabilityEvidence: boolean;
  isRecordingObservabilityEvidence: boolean;
  recordObservabilityEvidenceError: boolean;
  onRecordObservabilityEvidence: (draft: ObservabilityEvidenceRecordDraft) => void;
}): JSX.Element {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const supportTrainingEvidence = useQuery({
    queryKey: ["production-readiness-evidence", "support_training_completion"],
    queryFn: () => api.listProductionReadinessEvidence({ evidence_type: "support_training_completion", limit: 3 }),
    refetchInterval: 60_000,
  });
  const recordSupportTrainingEvidenceMutation = useMutation({
    mutationFn: (draft: SupportTrainingEvidenceRecordDraft) => api.recordProductionReadinessEvidence({
      evidence_type: "support_training_completion",
      status: "valid",
      evidence_at: new Date().toISOString(),
      expires_at: draft.expiresAt,
      summary: draft.summary,
      evidence_ref: draft.evidenceRef,
      metadata: {
        support_model_ref: draft.supportModelRef,
        training_completion_ref: draft.trainingCompletionRef,
        trained_role_count: draft.trainedRoleCount,
        trained_user_count: draft.trainedUserCount,
        coverage_percent: draft.coveragePercent,
        completed_at: draft.completedAt,
      },
      legal_hold: false,
    }, supportTrainingEvidenceIdempotencyKey(draft)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["production-readiness"] });
      void queryClient.invalidateQueries({ queryKey: ["production-readiness-evidence", "support_training_completion"] });
    },
  });
  const canRecordSupportTrainingEvidence =
    canRecordSloEvidence || canRecordObservabilityEvidence || canRecordBackupEvidence || canRecordExternalAlertEvidence;

  if (isError) {
    return (
      <section className="panel production-readiness" aria-label="Controlled production readiness">
        <div className="panel-head">
          <h2>Controlled-prod readiness</h2>
          <span className="badge red">Load failed</span>
        </div>
        <p className="empty-state">Production readiness evidence could not be loaded.</p>
      </section>
    );
  }

  const topGates = readiness?.gates.filter((gate) => gate.status !== "pass").slice(0, 5) ?? [];
  const auditVerifier = readiness?.signals.audit_verifier;
  const latestAuditCompletedAt = auditVerifier?.latest_completed_at ?? null;
  const auditVerifierFresh = auditVerifier?.latest_status === "valid" && auditVerifier.stale === false;
  return (
    <section className="panel production-readiness" aria-label="Controlled production readiness">
      <div className="panel-head">
        <div>
          <h2>Controlled-prod readiness</h2>
          <p className="subtle">
            {readiness === undefined ? (isLoading ? "Checking evidence" : "No snapshot") : formatDateTime(readiness.evaluated_at)}
          </p>
        </div>
        <span className={`badge ${readinessTone(readiness?.status)}`}>{readinessLabel(readiness?.status, isLoading)}</span>
      </div>
      <div className="ops-health-grid">
        <ReadinessTile
          title="Runtime blockers"
          value={readiness === undefined ? "-" : String(readiness.summary.blocker_count)}
          detail={readiness === undefined ? "Evidence pending" : readiness.summary.blocker_count === 0 ? "No runtime blockers" : "Must close"}
          tone={readiness !== undefined && readiness.summary.blocker_count > 0 ? "red" : "green"}
        />
        <ReadinessTile
          title="External evidence"
          value={readiness === undefined ? "-" : String(readiness.summary.deferred_count)}
          detail={readiness === undefined ? "Evidence pending" : readiness.summary.deferred_count === 0 ? "Attached" : "Owner evidence needed"}
          tone={readiness !== undefined && readiness.summary.deferred_count > 0 ? "amber" : "green"}
        />
        <ReadinessTile
          title="Browser capacity"
          value={readiness === undefined ? "-" : String(readiness.signals.bot_pool.capacity_slots)}
          detail={readiness === undefined ? "Workers pending" : `active ${readiness.signals.bot_pool.workers.active}`}
          tone={readiness !== undefined && readiness.signals.bot_pool.workers.active >= 2 ? "green" : "amber"}
        />
        <ReadinessTile
          title="Audit verifier"
          value={auditVerifier?.latest_status ?? "-"}
          detail={latestAuditCompletedAt !== null ? formatDateTime(latestAuditCompletedAt) : "No fresh proof"}
          tone={auditVerifierFresh ? "green" : "amber"}
        />
      </div>
      <ul className="production-readiness-gates">
        {(topGates.length > 0 ? topGates : readiness?.gates.slice(0, 3) ?? []).map((gate) => (
          <li key={gate.gate_id}>
            <span className={`badge ${gateTone(gate.status)}`}>{gateStatusLabel(gate.status)}</span>
            <div>
              <strong>{gate.label}</strong>
              <span className="subtle">{gate.reason_code ?? gate.detail}</span>
            </div>
          </li>
        ))}
      </ul>
      <ExternalAlertEvidenceList
        items={externalAlertEvidence}
        isLoading={isExternalAlertEvidenceLoading}
        isError={isExternalAlertEvidenceError}
      />
      <SloEvidenceList
        items={sloEvidence}
        isLoading={isSloEvidenceLoading}
        isError={isSloEvidenceError}
      />
      <SupportTrainingEvidenceList
        items={supportTrainingEvidence.data?.items ?? ([] as ProductionReadinessEvidence[])}
        isLoading={supportTrainingEvidence.data === undefined && supportTrainingEvidence.isFetching}
        isError={supportTrainingEvidence.isError}
      />
      <ObservabilityEvidenceList
        items={observabilityEvidence}
        isLoading={isObservabilityEvidenceLoading}
        isError={isObservabilityEvidenceError}
      />
      <BackupEvidenceList
        items={backupEvidence}
        isLoading={isBackupEvidenceLoading}
        isError={isBackupEvidenceError}
      />
      {canRecordExternalAlertEvidence ? (
        <ExternalAlertEvidenceRecorder
          isRecording={isRecordingExternalAlertEvidence}
          hasError={recordExternalAlertEvidenceError}
          onSubmit={onRecordExternalAlertEvidence}
        />
      ) : null}
      {canRecordBackupEvidence ? (
        <BackupEvidenceRecorder
          isRecording={isRecordingBackupEvidence}
          hasError={recordBackupEvidenceError}
          onSubmit={onRecordBackupEvidence}
        />
      ) : null}
      {canRecordSloEvidence ? (
        <SloEvidenceRecorder
          isRecording={isRecordingSloEvidence}
          hasError={recordSloEvidenceError}
          onSubmit={onRecordSloEvidence}
        />
      ) : null}
      {canRecordSupportTrainingEvidence ? (
        <SupportTrainingEvidenceRecorder
          isRecording={recordSupportTrainingEvidenceMutation.isPending}
          hasError={recordSupportTrainingEvidenceMutation.isError}
          onSubmit={(draft) => recordSupportTrainingEvidenceMutation.mutate(draft)}
        />
      ) : null}
      {canRecordObservabilityEvidence ? (
        <ObservabilityEvidenceRecorder
          isRecording={isRecordingObservabilityEvidence}
          hasError={recordObservabilityEvidenceError}
          onSubmit={onRecordObservabilityEvidence}
        />
      ) : null}
    </section>
  );
}

function ExternalAlertEvidenceRecorder({
  isRecording,
  hasError,
  onSubmit,
}: {
  isRecording: boolean;
  hasError: boolean;
  onSubmit: (draft: ExternalAlertEvidenceRecordDraft) => void;
}): JSX.Element {
  const defaultExpiry = useMemo(() => {
    const date = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
  }, []);
  const [evidenceRef, setEvidenceRef] = useState("");
  const [summary, setSummary] = useState("");
  const [expiresOn, setExpiresOn] = useState(defaultExpiry);
  const [channel, setChannel] = useState<ExternalAlertEvidenceRecordDraft["channel"]>("webhook");
  const [providerAlias, setProviderAlias] = useState("webhook-primary");
  const [receiptId, setReceiptId] = useState("");
  const [receiptAt, setReceiptAt] = useState("");
  const canSubmit = [
    evidenceRef,
    summary,
    expiresOn,
    providerAlias,
    receiptId,
    receiptAt,
  ].every((value) => value.trim().length > 0);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canSubmit || isRecording) return;
    onSubmit({
      evidenceRef: evidenceRef.trim(),
      summary: summary.trim(),
      expiresAt: new Date(`${expiresOn}T23:59:59.000Z`).toISOString(),
      channel,
      providerAlias: providerAlias.trim(),
      receiptId: receiptId.trim(),
      receiptAt: receiptAt.trim(),
    });
  }

  return (
    <form className="production-readiness-record" onSubmit={submit}>
      <div className="production-readiness-evidence-head">
        <strong>Record alert delivery evidence</strong>
        {hasError ? <span className="badge red">Record failed</span> : null}
      </div>
      <div className="production-readiness-record-grid">
        <label>
          Alert evidence ref
          <input value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} placeholder="ticket:OPS-123" />
        </label>
        <label>
          Alert evidence summary
          <input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="Provider delivered the controlled-prod drill alert" />
        </label>
        <label>
          Notification channel
          <select value={channel} onChange={(event) => setChannel(event.target.value as ExternalAlertEvidenceRecordDraft["channel"])}>
            <option value="webhook">Webhook</option>
            <option value="teams">Teams</option>
            <option value="slack">Slack</option>
            <option value="email">Email</option>
          </select>
        </label>
        <label>
          Provider alias
          <input value={providerAlias} onChange={(event) => setProviderAlias(event.target.value)} placeholder="webhook-primary" />
        </label>
        <label>
          Receipt id
          <input value={receiptId} onChange={(event) => setReceiptId(event.target.value)} placeholder="receipt-123" />
        </label>
        <label>
          Receipt at
          <input value={receiptAt} onChange={(event) => setReceiptAt(event.target.value)} placeholder="2026-06-29T00:05:30.000Z" />
        </label>
        <label>
          Alert evidence expires on
          <input type="date" value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} />
        </label>
      </div>
      <div className="form-actions">
        <button className="btn primary" type="submit" disabled={!canSubmit || isRecording}>
          {isRecording ? "Recording" : "Record alert evidence"}
        </button>
      </div>
    </form>
  );
}

function SloEvidenceRecorder({
  isRecording,
  hasError,
  onSubmit,
}: {
  isRecording: boolean;
  hasError: boolean;
  onSubmit: (draft: SloEvidenceRecordDraft) => void;
}): JSX.Element {
  const defaultExpiry = useMemo(() => {
    const date = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
  }, []);
  const [evidenceRef, setEvidenceRef] = useState("");
  const [summary, setSummary] = useState("");
  const [expiresOn, setExpiresOn] = useState(defaultExpiry);
  const [sloDashboard, setSloDashboard] = useState("");
  const [severityModel, setSeverityModel] = useState("");
  const [oncallRota, setOncallRota] = useState("");
  const [raciRef, setRaciRef] = useState("");
  const [supportHours, setSupportHours] = useState("");
  const canSubmit = [
    evidenceRef,
    summary,
    expiresOn,
    sloDashboard,
    severityModel,
    oncallRota,
    raciRef,
    supportHours,
  ].every((value) => value.trim().length > 0);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canSubmit || isRecording) return;
    const expiresAt = new Date(`${expiresOn}T23:59:59.000Z`).toISOString();
    onSubmit({
      evidenceRef: evidenceRef.trim(),
      summary: summary.trim(),
      expiresAt,
      sloDashboard: sloDashboard.trim(),
      severityModel: severityModel.trim(),
      oncallRota: oncallRota.trim(),
      raciRef: raciRef.trim(),
      supportHours: supportHours.trim(),
    });
  }

  return (
    <form className="production-readiness-record" onSubmit={submit}>
      <div className="production-readiness-evidence-head">
        <strong>Record SLO sign-off</strong>
        {hasError ? <span className="badge red">Record failed</span> : null}
      </div>
      <div className="production-readiness-record-grid">
        <label>
          Evidence ref
          <input value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} placeholder="ticket:SRE-456" />
        </label>
        <label>
          Summary
          <input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="SLO and on-call sign-off approved" />
        </label>
        <label>
          SLO dashboard
          <input value={sloDashboard} onChange={(event) => setSloDashboard(event.target.value)} placeholder="grafana-folder-rpa" />
        </label>
        <label>
          Severity model
          <input value={severityModel} onChange={(event) => setSeverityModel(event.target.value)} placeholder="sev1-sev4" />
        </label>
        <label>
          On-call rota
          <input value={oncallRota} onChange={(event) => setOncallRota(event.target.value)} placeholder="primary-secondary" />
        </label>
        <label>
          RACI ref
          <input value={raciRef} onChange={(event) => setRaciRef(event.target.value)} placeholder="raci:SRE-RPA" />
        </label>
        <label>
          Support hours
          <input value={supportHours} onChange={(event) => setSupportHours(event.target.value)} placeholder="24x7" />
        </label>
        <label>
          Expires on
          <input type="date" value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} />
        </label>
      </div>
      <div className="form-actions">
        <button className="btn primary" type="submit" disabled={!canSubmit || isRecording}>
          {isRecording ? "Recording" : "Record SLO evidence"}
        </button>
      </div>
    </form>
  );
}

function SupportTrainingEvidenceRecorder({
  isRecording,
  hasError,
  onSubmit,
}: {
  isRecording: boolean;
  hasError: boolean;
  onSubmit: (draft: SupportTrainingEvidenceRecordDraft) => void;
}): JSX.Element {
  const defaultExpiry = useMemo(() => {
    const date = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
  }, []);
  const [evidenceRef, setEvidenceRef] = useState("");
  const [summary, setSummary] = useState("");
  const [supportModelRef, setSupportModelRef] = useState("");
  const [trainingCompletionRef, setTrainingCompletionRef] = useState("");
  const [trainedRoleCount, setTrainedRoleCount] = useState("");
  const [trainedUserCount, setTrainedUserCount] = useState("");
  const [coveragePercent, setCoveragePercent] = useState("");
  const [completedAt, setCompletedAt] = useState("");
  const [expiresOn, setExpiresOn] = useState(defaultExpiry);
  const parsedTrainedRoleCount = Number(trainedRoleCount);
  const parsedTrainedUserCount = Number(trainedUserCount);
  const parsedCoveragePercent = Number(coveragePercent);
  const canSubmit = [
    evidenceRef,
    summary,
    supportModelRef,
    trainingCompletionRef,
    completedAt,
    expiresOn,
  ].every((value) => value.trim().length > 0) &&
    Number.isInteger(parsedTrainedRoleCount) && parsedTrainedRoleCount > 0 &&
    Number.isInteger(parsedTrainedUserCount) && parsedTrainedUserCount > 0 &&
    Number.isFinite(parsedCoveragePercent) && parsedCoveragePercent > 0 && parsedCoveragePercent <= 100;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canSubmit || isRecording) return;
    onSubmit({
      evidenceRef: evidenceRef.trim(),
      summary: summary.trim(),
      supportModelRef: supportModelRef.trim(),
      trainingCompletionRef: trainingCompletionRef.trim(),
      trainedRoleCount: parsedTrainedRoleCount,
      trainedUserCount: parsedTrainedUserCount,
      coveragePercent: parsedCoveragePercent,
      completedAt: completedAt.trim(),
      expiresAt: new Date(`${expiresOn}T23:59:59.000Z`).toISOString(),
    });
  }

  return (
    <form className="production-readiness-record" onSubmit={submit}>
      <div className="production-readiness-evidence-head">
        <strong>Record support/training evidence</strong>
        {hasError ? <span className="badge red">Record failed</span> : null}
      </div>
      <div className="production-readiness-record-grid">
        <label>
          Support evidence ref
          <input value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} placeholder="ticket:TRAIN-123" />
        </label>
        <label>
          Support summary
          <input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="Support model and training completion approved" />
        </label>
        <label>
          Support model ref
          <input value={supportModelRef} onChange={(event) => setSupportModelRef(event.target.value)} placeholder="support-model:L1-L3" />
        </label>
        <label>
          Training completion ref
          <input value={trainingCompletionRef} onChange={(event) => setTrainingCompletionRef(event.target.value)} placeholder="training:completion-2026-06" />
        </label>
        <label>
          Trained role count
          <input type="number" min="1" step="1" value={trainedRoleCount} onChange={(event) => setTrainedRoleCount(event.target.value)} placeholder="3" />
        </label>
        <label>
          Trained user count
          <input type="number" min="1" step="1" value={trainedUserCount} onChange={(event) => setTrainedUserCount(event.target.value)} placeholder="18" />
        </label>
        <label>
          Coverage percent
          <input type="number" min="1" max="100" step="0.1" value={coveragePercent} onChange={(event) => setCoveragePercent(event.target.value)} placeholder="95" />
        </label>
        <label>
          Completed at
          <input value={completedAt} onChange={(event) => setCompletedAt(event.target.value)} placeholder="2026-06-29T00:45:00.000Z" />
        </label>
        <label>
          Support training expires on
          <input type="date" value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} />
        </label>
      </div>
      <div className="form-actions">
        <button className="btn primary" type="submit" disabled={!canSubmit || isRecording}>
          {isRecording ? "Recording" : "Record support evidence"}
        </button>
      </div>
    </form>
  );
}

function ObservabilityEvidenceRecorder({
  isRecording,
  hasError,
  onSubmit,
}: {
  isRecording: boolean;
  hasError: boolean;
  onSubmit: (draft: ObservabilityEvidenceRecordDraft) => void;
}): JSX.Element {
  const defaultExpiry = useMemo(() => {
    const date = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
  }, []);
  const [evidenceRef, setEvidenceRef] = useState("");
  const [summary, setSummary] = useState("");
  const [expiresOn, setExpiresOn] = useState(defaultExpiry);
  const [exporter, setExporter] = useState<ObservabilityEvidenceRecordDraft["exporter"]>("otlp");
  const [collectorRef, setCollectorRef] = useState("");
  const [dashboardRef, setDashboardRef] = useState("");
  const [alertRouteRef, setAlertRouteRef] = useState("");
  const [sampledAt, setSampledAt] = useState("");
  const canSubmit = [
    evidenceRef,
    summary,
    expiresOn,
    collectorRef,
    dashboardRef,
    alertRouteRef,
    sampledAt,
  ].every((value) => value.trim().length > 0);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canSubmit || isRecording) return;
    onSubmit({
      evidenceRef: evidenceRef.trim(),
      summary: summary.trim(),
      expiresAt: new Date(`${expiresOn}T23:59:59.000Z`).toISOString(),
      exporter,
      collectorRef: collectorRef.trim(),
      dashboardRef: dashboardRef.trim(),
      alertRouteRef: alertRouteRef.trim(),
      sampledAt: sampledAt.trim(),
    });
  }

  return (
    <form className="production-readiness-record" onSubmit={submit}>
      <div className="production-readiness-evidence-head">
        <strong>Record telemetry evidence</strong>
        {hasError ? <span className="badge red">Record failed</span> : null}
      </div>
      <div className="production-readiness-record-grid">
        <label>
          Telemetry evidence ref
          <input value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} placeholder="ticket:OBS-124" />
        </label>
        <label>
          Telemetry summary
          <input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="OTLP collector, dashboard, and alert route approved" />
        </label>
        <label>
          Telemetry exporter
          <select value={exporter} onChange={(event) => setExporter(event.target.value as ObservabilityEvidenceRecordDraft["exporter"])}>
            <option value="otlp">OTLP</option>
            <option value="prometheus">Prometheus</option>
          </select>
        </label>
        <label>
          Collector ref
          <input value={collectorRef} onChange={(event) => setCollectorRef(event.target.value)} placeholder="otel-collector:rpa-prod" />
        </label>
        <label>
          Dashboard ref
          <input value={dashboardRef} onChange={(event) => setDashboardRef(event.target.value)} placeholder="grafana-folder-rpa" />
        </label>
        <label>
          Alert route ref
          <input value={alertRouteRef} onChange={(event) => setAlertRouteRef(event.target.value)} placeholder="alert-route:rpa-sev" />
        </label>
        <label>
          Sampled at
          <input value={sampledAt} onChange={(event) => setSampledAt(event.target.value)} placeholder="2026-06-29T00:16:30.000Z" />
        </label>
        <label>
          Telemetry evidence expires on
          <input type="date" value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} />
        </label>
      </div>
      <div className="form-actions">
        <button className="btn primary" type="submit" disabled={!canSubmit || isRecording}>
          {isRecording ? "Recording" : "Record telemetry evidence"}
        </button>
      </div>
    </form>
  );
}

function BackupEvidenceRecorder({
  isRecording,
  hasError,
  onSubmit,
}: {
  isRecording: boolean;
  hasError: boolean;
  onSubmit: (draft: BackupEvidenceRecordDraft) => void;
}): JSX.Element {
  const defaultExpiry = useMemo(() => {
    const date = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
  }, []);
  const [evidenceRef, setEvidenceRef] = useState("");
  const [summary, setSummary] = useState("");
  const [expiresOn, setExpiresOn] = useState(defaultExpiry);
  const [backupPolicyRef, setBackupPolicyRef] = useState("");
  const [restoreScope, setRestoreScope] = useState("");
  const [restoreCompletedAt, setRestoreCompletedAt] = useState("");
  const [rtoMinutes, setRtoMinutes] = useState("");
  const [rpoMinutes, setRpoMinutes] = useState("");
  const parsedRto = Number(rtoMinutes);
  const parsedRpo = Number(rpoMinutes);
  const canSubmit = [
    evidenceRef,
    summary,
    expiresOn,
    backupPolicyRef,
    restoreScope,
    restoreCompletedAt,
  ].every((value) => value.trim().length > 0) &&
    Number.isFinite(parsedRto) && parsedRto > 0 && parsedRto <= 120 &&
    Number.isFinite(parsedRpo) && parsedRpo > 0 && parsedRpo <= 15;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canSubmit || isRecording) return;
    onSubmit({
      evidenceRef: evidenceRef.trim(),
      summary: summary.trim(),
      expiresAt: new Date(`${expiresOn}T23:59:59.000Z`).toISOString(),
      backupPolicyRef: backupPolicyRef.trim(),
      restoreScope: restoreScope.trim(),
      restoreCompletedAt: restoreCompletedAt.trim(),
      rtoMinutes: parsedRto,
      rpoMinutes: parsedRpo,
    });
  }

  return (
    <form className="production-readiness-record" onSubmit={submit}>
      <div className="production-readiness-evidence-head">
        <strong>Record backup drill</strong>
        {hasError ? <span className="badge red">Record failed</span> : null}
      </div>
      <div className="production-readiness-record-grid">
        <label>
          Backup evidence ref
          <input value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} placeholder="drill:PITR-2026-06-29" />
        </label>
        <label>
          Backup summary
          <input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="PITR restore completed within target" />
        </label>
        <label>
          Backup policy ref
          <input value={backupPolicyRef} onChange={(event) => setBackupPolicyRef(event.target.value)} placeholder="backup-policy:managed-pg-prod" />
        </label>
        <label>
          Restore scope
          <input value={restoreScope} onChange={(event) => setRestoreScope(event.target.value)} placeholder="tenant-a-control-plane" />
        </label>
        <label>
          Restore completed at
          <input value={restoreCompletedAt} onChange={(event) => setRestoreCompletedAt(event.target.value)} placeholder="2026-06-29T00:30:00.000Z" />
        </label>
        <label>
          RTO minutes
          <input type="number" min="1" max="120" value={rtoMinutes} onChange={(event) => setRtoMinutes(event.target.value)} placeholder="20" />
        </label>
        <label>
          RPO minutes
          <input type="number" min="1" max="15" value={rpoMinutes} onChange={(event) => setRpoMinutes(event.target.value)} placeholder="5" />
        </label>
        <label>
          Backup expires on
          <input type="date" value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} />
        </label>
      </div>
      <div className="form-actions">
        <button className="btn primary" type="submit" disabled={!canSubmit || isRecording}>
          {isRecording ? "Recording" : "Record backup evidence"}
        </button>
      </div>
    </form>
  );
}

function BackupEvidenceList({
  items,
  isLoading,
  isError,
}: {
  items: readonly ProductionReadinessEvidence[];
  isLoading: boolean;
  isError: boolean;
}): JSX.Element {
  if (isError) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>Backup/PITR evidence</strong>
        <span className="subtle">Evidence ledger unavailable</span>
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>Backup/PITR evidence</strong>
        <span className="subtle">Checking owner evidence</span>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>Backup/PITR evidence</strong>
        <span className="subtle">No restore drill evidence recorded</span>
      </div>
    );
  }
  return (
    <div className="production-readiness-evidence">
      <div className="production-readiness-evidence-head">
        <strong>Backup/PITR evidence</strong>
        <span className="subtle">latest {items.length}</span>
      </div>
      <ul className="production-readiness-evidence-list">
        {items.map((item) => (
          <li key={item.evidence_id}>
            <div className="production-readiness-evidence-head">
              <span className={`badge ${evidenceStatusTone(item.status)}`}>{evidenceStatusLabel(item.status)}</span>
              <span className="subtle">{formatDateTime(item.evidence_at)}</span>
            </div>
            <strong>{item.summary}</strong>
            <span className="subtle">{item.evidence_ref ?? "no evidence ref"}</span>
            <span className="subtle">
              policy {metadataText(item.metadata.backup_policy_ref)} / scope {metadataText(item.metadata.restore_scope)}
            </span>
            <span className="subtle">
              RTO {metadataText(item.metadata.rto_minutes)}m / RPO {metadataText(item.metadata.rpo_minutes)}m / restored {metadataText(item.metadata.restore_completed_at)}
            </span>
            <span className="subtle">expires {item.expires_at === null ? "not set" : formatDateTime(item.expires_at)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ExternalAlertEvidenceList({
  items,
  isLoading,
  isError,
}: {
  items: readonly ProductionReadinessEvidence[];
  isLoading: boolean;
  isError: boolean;
}): JSX.Element {
  if (isError) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>External alert evidence</strong>
        <span className="subtle">Evidence ledger unavailable</span>
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>External alert evidence</strong>
        <span className="subtle">Checking provider delivery evidence</span>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>External alert evidence</strong>
        <span className="subtle">No provider delivered drill evidence recorded</span>
      </div>
    );
  }
  return (
    <div className="production-readiness-evidence">
      <div className="production-readiness-evidence-head">
        <strong>External alert evidence</strong>
        <span className="subtle">latest {items.length}</span>
      </div>
      <ul className="production-readiness-evidence-list">
        {items.map((item) => (
          <li key={item.evidence_id}>
            <div className="production-readiness-evidence-head">
              <span className={`badge ${evidenceStatusTone(item.status)}`}>{evidenceStatusLabel(item.status)}</span>
              <span className="subtle">{formatDateTime(item.evidence_at)}</span>
            </div>
            <strong>{item.summary}</strong>
            <span className="subtle">{item.evidence_ref ?? "no evidence ref"}</span>
            <span className="subtle">
              {metadataText(item.metadata.channel)} / {metadataText(item.metadata.provider_alias)} / {metadataText(item.metadata.delivery_status)}
            </span>
            <span className="subtle">
              receipt {metadataText(item.metadata.receipt_id)} at {metadataText(item.metadata.receipt_at)}
            </span>
            <span className="subtle">expires {item.expires_at === null ? "not set" : formatDateTime(item.expires_at)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SloEvidenceList({
  items,
  isLoading,
  isError,
}: {
  items: readonly ProductionReadinessEvidence[];
  isLoading: boolean;
  isError: boolean;
}): JSX.Element {
  if (isError) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>SLO/on-call evidence</strong>
        <span className="subtle">Evidence ledger unavailable</span>
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>SLO/on-call evidence</strong>
        <span className="subtle">Checking owner evidence</span>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>SLO/on-call evidence</strong>
        <span className="subtle">No owner sign-off evidence recorded</span>
      </div>
    );
  }
  return (
    <div className="production-readiness-evidence">
      <div className="production-readiness-evidence-head">
        <strong>SLO/on-call evidence</strong>
        <span className="subtle">latest {items.length}</span>
      </div>
      <ul className="production-readiness-evidence-list">
        {items.map((item) => (
          <li key={item.evidence_id}>
            <div className="production-readiness-evidence-head">
              <span className={`badge ${evidenceStatusTone(item.status)}`}>{evidenceStatusLabel(item.status)}</span>
              <span className="subtle">{formatDateTime(item.evidence_at)}</span>
            </div>
            <strong>{item.summary}</strong>
            <span className="subtle">{item.evidence_ref ?? "no evidence ref"}</span>
            <span className="subtle">
              dashboard {metadataText(item.metadata.slo_dashboard)} / severity {metadataText(item.metadata.severity_model)} / rota {metadataText(item.metadata.oncall_rota)}
            </span>
            <span className="subtle">
              RACI {metadataText(item.metadata.raci_ref)} / support {metadataText(item.metadata.support_hours)}
            </span>
            <span className="subtle">expires {item.expires_at === null ? "not set" : formatDateTime(item.expires_at)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SupportTrainingEvidenceList({
  items,
  isLoading,
  isError,
}: {
  items: readonly ProductionReadinessEvidence[];
  isLoading: boolean;
  isError: boolean;
}): JSX.Element {
  if (isError) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>Support/training evidence</strong>
        <span className="subtle">Evidence ledger unavailable</span>
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>Support/training evidence</strong>
        <span className="subtle">Checking support readiness evidence</span>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>Support/training evidence</strong>
        <span className="subtle">No support model or training completion evidence recorded</span>
      </div>
    );
  }
  return (
    <div className="production-readiness-evidence">
      <div className="production-readiness-evidence-head">
        <strong>Support/training evidence</strong>
        <span className="subtle">latest {items.length}</span>
      </div>
      <ul className="production-readiness-evidence-list">
        {items.map((item) => (
          <li key={item.evidence_id}>
            <div className="production-readiness-evidence-head">
              <span className={`badge ${evidenceStatusTone(item.status)}`}>{evidenceStatusLabel(item.status)}</span>
              <span className="subtle">{formatDateTime(item.evidence_at)}</span>
            </div>
            <strong>{item.summary}</strong>
            <span className="subtle">{item.evidence_ref ?? "no evidence ref"}</span>
            <span className="subtle">
              model {metadataText(item.metadata.support_model_ref)} / training {metadataText(item.metadata.training_completion_ref)}
            </span>
            <span className="subtle">
              roles {metadataText(item.metadata.trained_role_count)} / users {metadataText(item.metadata.trained_user_count)} / coverage {metadataPercentText(item.metadata.coverage_percent)}
            </span>
            <span className="subtle">completed {metadataText(item.metadata.completed_at)}</span>
            <span className="subtle">expires {item.expires_at === null ? "not set" : formatDateTime(item.expires_at)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ObservabilityEvidenceList({
  items,
  isLoading,
  isError,
}: {
  items: readonly ProductionReadinessEvidence[];
  isLoading: boolean;
  isError: boolean;
}): JSX.Element {
  if (isError) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>Observability evidence</strong>
        <span className="subtle">Evidence ledger unavailable</span>
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>Observability evidence</strong>
        <span className="subtle">Checking telemetry evidence</span>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="production-readiness-evidence" role="status">
        <strong>Observability evidence</strong>
        <span className="subtle">No telemetry wiring evidence recorded</span>
      </div>
    );
  }
  return (
    <div className="production-readiness-evidence">
      <div className="production-readiness-evidence-head">
        <strong>Observability evidence</strong>
        <span className="subtle">latest {items.length}</span>
      </div>
      <ul className="production-readiness-evidence-list">
        {items.map((item) => (
          <li key={item.evidence_id}>
            <div className="production-readiness-evidence-head">
              <span className={`badge ${evidenceStatusTone(item.status)}`}>{evidenceStatusLabel(item.status)}</span>
              <span className="subtle">{formatDateTime(item.evidence_at)}</span>
            </div>
            <strong>{item.summary}</strong>
            <span className="subtle">{item.evidence_ref ?? "no evidence ref"}</span>
            <span className="subtle">
              exporter {metadataText(item.metadata.exporter)} / collector {metadataText(item.metadata.collector_ref)}
            </span>
            <span className="subtle">
              dashboard {metadataText(item.metadata.dashboard_ref)} / alert route {metadataText(item.metadata.alert_route_ref)}
            </span>
            <span className="subtle">sampled {metadataText(item.metadata.sampled_at)}</span>
            <span className="subtle">expires {item.expires_at === null ? "not set" : formatDateTime(item.expires_at)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReadinessTile({
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

function readinessTone(status: ProductionReadinessStatus | undefined): "green" | "amber" | "red" | "muted" {
  if (status === "ready") return "green";
  if (status === "warning") return "amber";
  if (status === "blocked") return "red";
  return "muted";
}

function readinessLabel(status: ProductionReadinessStatus | undefined, isLoading: boolean): string {
  if (status === "ready") return "Ready";
  if (status === "warning") return "Evidence needed";
  if (status === "blocked") return "Blocked";
  return isLoading ? "Checking" : "Unknown";
}

function gateTone(status: ProductionReadinessGateStatus): "green" | "amber" | "red" | "muted" {
  if (status === "pass") return "green";
  if (status === "blocked") return "red";
  if (status === "warning" || status === "deferred") return "amber";
  return "muted";
}

function gateStatusLabel(status: ProductionReadinessGate["status"]): string {
  if (status === "pass") return "Pass";
  if (status === "blocked") return "Blocked";
  if (status === "warning") return "Warning";
  return "Deferred";
}

function evidenceStatusTone(status: ProductionReadinessEvidenceStatus): "green" | "red" {
  return status === "valid" ? "green" : "red";
}

function evidenceStatusLabel(status: ProductionReadinessEvidenceStatus): string {
  return status === "valid" ? "Valid" : "Failed";
}

function metadataText(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return typeof value === "string" && value.trim().length > 0 ? value : "missing";
}

function metadataPercentText(value: unknown): string {
  const text = metadataText(value);
  return text === "missing" ? text : `${text}%`;
}

function supportTrainingEvidenceIdempotencyKey(draft: SupportTrainingEvidenceRecordDraft): string {
  const stableEvidenceRef = stableIdempotencyPart(draft.evidenceRef);
  const stableCompletionRef = stableIdempotencyPart(draft.trainingCompletionRef);
  return `readiness-support-training-${stableEvidenceRef}-${stableCompletionRef}-${Date.now()}`;
}

function stableIdempotencyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 80);
}
