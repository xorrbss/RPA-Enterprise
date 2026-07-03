import { useMemo, useState, type FormEvent } from "react";

import type {
  ExternalAlertEvidenceRecordDraft,
  SloEvidenceRecordDraft,
  SupportTrainingEvidenceRecordDraft,
} from "./production-readiness-types";

export function ExternalAlertEvidenceRecorder({
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
        <strong>알림 전달 증빙 기록</strong>
        {hasError ? <span className="badge red">기록 실패</span> : null}
      </div>
      <div className="production-readiness-record-grid">
        <label>
          알림 증빙 참조
          <input value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} placeholder="증빙:OPS-123" />
        </label>
        <label>
          알림 증빙 요약
          <input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="제공자가 리허설 알림 전달을 완료했습니다." />
        </label>
        <label>
          알림 채널
          <select value={channel} onChange={(event) => setChannel(event.target.value as ExternalAlertEvidenceRecordDraft["channel"])}>
            <option value="webhook">웹훅</option>
            <option value="teams">Teams</option>
            <option value="slack">Slack</option>
            <option value="email">이메일</option>
          </select>
        </label>
        <label>
          제공자 별칭
          <input value={providerAlias} onChange={(event) => setProviderAlias(event.target.value)} placeholder="webhook-primary" />
        </label>
        <label>
          접수 번호
          <input value={receiptId} onChange={(event) => setReceiptId(event.target.value)} placeholder="전달-접수-123" />
        </label>
        <label>
          접수 시각
          <input value={receiptAt} onChange={(event) => setReceiptAt(event.target.value)} placeholder="2026-06-29T00:05:30.000Z" />
        </label>
        <label>
          알림 증빙 만료일
          <input type="date" value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} />
        </label>
      </div>
      <div className="form-actions">
        <button className="btn primary" type="submit" disabled={!canSubmit || isRecording}>
          {isRecording ? "기록 중" : "알림 증빙 기록"}
        </button>
      </div>
    </form>
  );
}

export function SloEvidenceRecorder({
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
        <strong>SLO·당직 승인 증빙 기록</strong>
        {hasError ? <span className="badge red">기록 실패</span> : null}
      </div>
      <div className="production-readiness-record-grid">
        <label>
          SLO 증빙 참조
          <input value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} placeholder="증빙:SRE-456" />
        </label>
        <label>
          SLO 증빙 요약
          <input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="SLO와 당직 승인이 완료되었습니다." />
        </label>
        <label>
          SLO 대시보드
          <input value={sloDashboard} onChange={(event) => setSloDashboard(event.target.value)} placeholder="grafana-folder-rpa" />
        </label>
        <label>
          심각도 모델
          <input value={severityModel} onChange={(event) => setSeverityModel(event.target.value)} placeholder="sev1-sev4" />
        </label>
        <label>
          당직 로테이션
          <input value={oncallRota} onChange={(event) => setOncallRota(event.target.value)} placeholder="primary-secondary" />
        </label>
        <label>
          RACI 참조
          <input value={raciRef} onChange={(event) => setRaciRef(event.target.value)} placeholder="raci:SRE-RPA" />
        </label>
        <label>
          지원 시간
          <input value={supportHours} onChange={(event) => setSupportHours(event.target.value)} placeholder="24x7" />
        </label>
        <label>
          SLO 증빙 만료일
          <input type="date" value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} />
        </label>
      </div>
      <div className="form-actions">
        <button className="btn primary" type="submit" disabled={!canSubmit || isRecording}>
          {isRecording ? "기록 중" : "SLO 증빙 기록"}
        </button>
      </div>
    </form>
  );
}

export function SupportTrainingEvidenceRecorder({
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
        <strong>지원·교육 증빙 기록</strong>
        {hasError ? <span className="badge red">기록 실패</span> : null}
      </div>
      <div className="production-readiness-record-grid">
        <label>
          지원 증빙 참조
          <input value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} placeholder="증빙:TRAIN-123" />
        </label>
        <label>
          지원 증빙 요약
          <input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="지원 모델과 교육 완료가 승인되었습니다." />
        </label>
        <label>
          지원 모델 참조
          <input value={supportModelRef} onChange={(event) => setSupportModelRef(event.target.value)} placeholder="support-model:L1-L3" />
        </label>
        <label>
          교육 완료 참조
          <input value={trainingCompletionRef} onChange={(event) => setTrainingCompletionRef(event.target.value)} placeholder="training:completion-2026-06" />
        </label>
        <label>
          교육 완료 역할 수
          <input type="number" min="1" step="1" value={trainedRoleCount} onChange={(event) => setTrainedRoleCount(event.target.value)} placeholder="3" />
        </label>
        <label>
          교육 완료 사용자 수
          <input type="number" min="1" step="1" value={trainedUserCount} onChange={(event) => setTrainedUserCount(event.target.value)} placeholder="18" />
        </label>
        <label>
          교육 이수율
          <input type="number" min="1" max="100" step="0.1" value={coveragePercent} onChange={(event) => setCoveragePercent(event.target.value)} placeholder="95" />
        </label>
        <label>
          교육 완료 시각
          <input value={completedAt} onChange={(event) => setCompletedAt(event.target.value)} placeholder="2026-06-29T00:45:00.000Z" />
        </label>
        <label>
          지원·교육 증빙 만료일
          <input type="date" value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} />
        </label>
      </div>
      <div className="form-actions">
        <button className="btn primary" type="submit" disabled={!canSubmit || isRecording}>
          {isRecording ? "기록 중" : "지원 증빙 기록"}
        </button>
      </div>
    </form>
  );
}
