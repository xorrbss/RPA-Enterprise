import { useState, type FormEvent } from "react";

import type { IntegrationHandoff, IntegrationHandoffReceiptStatus } from "../../api/types";
import { handoffStatusLabel, profileForProviderAlias } from "./integration-handoff-labels";

export interface IntegrationHandoffReceiptDraft {
  readonly externalJobId: string;
  readonly status: IntegrationHandoffReceiptStatus;
  readonly receiptId: string;
  readonly errorCode: string | null;
  readonly legalHold: boolean;
}

export interface IntegrationHandoffDispatchDraft {
  readonly endpointSecretRef: string;
  readonly allowedHosts: readonly string[];
  readonly maxAttempts: number;
  readonly legalHold: boolean;
}

export function IntegrationHandoffDispatchForm({
  handoff,
  isDispatching,
  onDispatch,
}: {
  handoff: IntegrationHandoff;
  isDispatching: boolean;
  onDispatch: (handoff: IntegrationHandoff, draft: IntegrationHandoffDispatchDraft) => void;
}): JSX.Element {
  const providerProfile = profileForProviderAlias(handoff.provider_alias);
  const [endpointSecretRef, setEndpointSecretRef] = useState(providerProfile.dispatchEndpointSecretRef);
  const [allowedHosts, setAllowedHosts] = useState(providerProfile.allowedHosts);
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [legalHold, setLegalHold] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const endpoint = endpointSecretRef.trim();
    const hosts = allowedHosts
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host.length > 0);
    if (!endpoint.startsWith("secret://")) {
      setValidationError("발송 대상 주소는 SecretRef 형식이어야 합니다.");
      return;
    }
    if (hosts.length === 0 || hosts.some((host) => host.includes("/") || host.includes(":") || host === "localhost")) {
      setValidationError("허용 호스트는 공개 호스트 이름만 입력할 수 있습니다.");
      return;
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
      setValidationError("최대 시도 횟수는 1에서 20 사이여야 합니다.");
      return;
    }
    setValidationError(null);
    onDispatch(handoff, { endpointSecretRef: endpoint, allowedHosts: hosts, maxAttempts, legalHold });
  }

  return (
    <form className="ops-webhook-form nested-form" onSubmit={submit}>
      <div className="form-grid ops-webhook-grid">
        <label className="field">
          발송 대상 SecretRef
          <input aria-label={`발송 대상 SecretRef ${handoff.handoff_id}`} value={endpointSecretRef} onChange={(event) => setEndpointSecretRef(event.target.value)} />
        </label>
        <label className="field">
          허용 호스트
          <input aria-label={`허용 호스트 ${handoff.handoff_id}`} value={allowedHosts} onChange={(event) => setAllowedHosts(event.target.value)} />
        </label>
        <label className="field">
          최대 시도 횟수
          <input aria-label={`최대 시도 횟수 ${handoff.handoff_id}`} type="number" min={1} max={20} value={maxAttempts} onChange={(event) => setMaxAttempts(Number(event.target.value))} />
        </label>
      </div>
      <div className="inline-actions">
        <label className="checkbox-inline">
          <input type="checkbox" checked={legalHold} onChange={(event) => setLegalHold(event.target.checked)} />
          법적 보존
        </label>
        <button className="btn" type="submit" disabled={isDispatching}>
          {isDispatching ? "발송 중" : "발송 예약"}
        </button>
        {validationError !== null && <span className="form-alert red" role="alert">{validationError}</span>}
      </div>
    </form>
  );
}

export function IntegrationHandoffReceiptForm({
  handoff,
  isRecording,
  onRecord,
}: {
  handoff: IntegrationHandoff;
  isRecording: boolean;
  onRecord: (handoff: IntegrationHandoff, draft: IntegrationHandoffReceiptDraft) => void;
}): JSX.Element {
  const [externalJobId, setExternalJobId] = useState(handoff.external_job_id ?? "job-0001");
  const [status, setStatus] = useState<IntegrationHandoffReceiptStatus>("completed");
  const [receiptId, setReceiptId] = useState(handoff.latest_receipt_id ?? "receipt-0001");
  const [errorCode, setErrorCode] = useState("");
  const [legalHold, setLegalHold] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const externalJob = externalJobId.trim();
    const receipt = receiptId.trim();
    const error = errorCode.trim();
    if (externalJob.length === 0 || receipt.length === 0) {
      setValidationError("외부 작업 ID와 수신 확인 ID를 입력하세요.");
      return;
    }
    if (status === "failed" && error.length === 0) {
      setValidationError("실패 처리에는 오류 코드가 필요합니다.");
      return;
    }
    setValidationError(null);
    onRecord(handoff, {
      externalJobId: externalJob,
      status,
      receiptId: receipt,
      errorCode: error.length === 0 ? null : error,
      legalHold,
    });
  }

  return (
    <form className="ops-webhook-form" onSubmit={submit}>
      <div className="form-grid ops-webhook-grid">
        <label className="field">
          외부 작업 ID
          <input aria-label="외부 작업 ID" value={externalJobId} onChange={(event) => setExternalJobId(event.target.value)} />
        </label>
        <label className="field">
          수신 확인 상태
          <select aria-label="수신 확인 상태" value={status} onChange={(event) => setStatus(event.target.value as IntegrationHandoffReceiptStatus)}>
            <option value="accepted">{handoffStatusLabel("accepted")}</option>
            <option value="completed">{handoffStatusLabel("completed")}</option>
            <option value="failed">{handoffStatusLabel("failed")}</option>
            <option value="cancelled">{handoffStatusLabel("cancelled")}</option>
          </select>
        </label>
        <label className="field">
          수신 확인 ID
          <input aria-label="수신 확인 ID" value={receiptId} onChange={(event) => setReceiptId(event.target.value)} />
        </label>
        <label className="field">
          오류 코드
          <input aria-label="오류 코드" value={errorCode} onChange={(event) => setErrorCode(event.target.value)} />
        </label>
      </div>
      <div className="inline-actions">
        <label className="checkbox-inline">
          <input type="checkbox" checked={legalHold} onChange={(event) => setLegalHold(event.target.checked)} />
          법적 보존
        </label>
        <button className="btn" type="submit" disabled={isRecording}>
          {isRecording ? "기록 중" : "수신 확인 저장"}
        </button>
        {validationError !== null && <span className="form-alert red" role="alert">{validationError}</span>}
      </div>
    </form>
  );
}
