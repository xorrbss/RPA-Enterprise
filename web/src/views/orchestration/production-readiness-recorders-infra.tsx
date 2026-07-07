import { useMemo, useState, type FormEvent } from "react";

import type {
  BackupEvidenceRecordDraft,
  ObservabilityEvidenceRecordDraft,
} from "./production-readiness-types";

export function ObservabilityEvidenceRecorder({
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
        <strong>관측성 증빙 기록</strong>
        {hasError ? <span className="badge red">기록 실패</span> : null}
      </div>
      <div className="production-readiness-record-grid">
        <label>
          관측성 증빙 참조
          <input value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} placeholder="증빙:OBS-124" />
        </label>
        <label>
          관측성 증빙 요약
          <input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="수집기, 대시보드, 알림 경로가 승인되었습니다." />
        </label>
        <label>
          텔레메트리 방식
          <select value={exporter} onChange={(event) => setExporter(event.target.value as ObservabilityEvidenceRecordDraft["exporter"])}>
            <option value="otlp">OTLP</option>
            <option value="prometheus">Prometheus</option>
          </select>
        </label>
        <label>
          수집기 참조
          <input value={collectorRef} onChange={(event) => setCollectorRef(event.target.value)} placeholder="otel-collector:rpa-prod" />
        </label>
        <label>
          대시보드 참조
          <input value={dashboardRef} onChange={(event) => setDashboardRef(event.target.value)} placeholder="grafana-folder-rpa" />
        </label>
        <label>
          알림 경로 참조
          <input value={alertRouteRef} onChange={(event) => setAlertRouteRef(event.target.value)} placeholder="alert-route:rpa-sev" />
        </label>
        <label>
          샘플링 시각
          <input value={sampledAt} onChange={(event) => setSampledAt(event.target.value)} placeholder="2026-06-29T00:16:30.000Z" />
        </label>
        <label>
          관측성 증빙 만료일
          <input type="date" value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} />
        </label>
      </div>
      <div className="form-actions">
        <button className="btn primary" type="submit" disabled={!canSubmit || isRecording}>
          {isRecording ? "기록 중" : "관측성 증빙 기록"}
        </button>
      </div>
    </form>
  );
}

export function BackupEvidenceRecorder({
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
        <strong>백업 복구 리허설 증빙 기록</strong>
        {hasError ? <span className="badge red">기록 실패</span> : null}
      </div>
      <div className="production-readiness-record-grid">
        <label>
          백업 증빙 참조
          <input value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} placeholder="복구리허설:PITR-2026-06-29" />
        </label>
        <label>
          백업 증빙 요약
          <input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="PITR 복구가 목표 시간 안에 완료되었습니다." />
        </label>
        <label>
          백업 정책 참조
          <input value={backupPolicyRef} onChange={(event) => setBackupPolicyRef(event.target.value)} placeholder="backup-policy:managed-pg-prod" />
        </label>
        <label>
          복구 범위
          <input value={restoreScope} onChange={(event) => setRestoreScope(event.target.value)} placeholder="tenant-a-control-plane" />
        </label>
        <label>
          복구 완료 시각
          <input value={restoreCompletedAt} onChange={(event) => setRestoreCompletedAt(event.target.value)} placeholder="2026-06-29T00:30:00.000Z" />
        </label>
        <label>
          목표 복구 시간(분)
          <input type="number" min="1" max="120" value={rtoMinutes} onChange={(event) => setRtoMinutes(event.target.value)} placeholder="20" />
        </label>
        <label>
          목표 복구 시점(분)
          <input type="number" min="1" max="15" value={rpoMinutes} onChange={(event) => setRpoMinutes(event.target.value)} placeholder="5" />
        </label>
        <label>
          백업 증빙 만료일
          <input type="date" value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} />
        </label>
      </div>
      <div className="form-actions">
        <button className="btn primary" type="submit" disabled={!canSubmit || isRecording}>
          {isRecording ? "기록 중" : "백업 증빙 기록"}
        </button>
      </div>
    </form>
  );
}
