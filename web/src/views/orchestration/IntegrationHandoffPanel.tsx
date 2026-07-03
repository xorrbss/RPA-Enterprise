import { useState, type FormEvent } from "react";

import type { IntegrationHandoff, IntegrationHandoffReceiptStatus } from "../../api/types";
import { statusLabel } from "../../components/badges";
import { formatDateTime } from "./format";

export interface IntegrationHandoffCreateDraft {
  readonly providerAlias: string;
  readonly jobRef: string;
  readonly payloadRef: string;
  readonly callbackUrlSecretRef: string | null;
  readonly callbackSignatureSecretRef: string | null;
  readonly legalHold: boolean;
}

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

interface HandoffProviderProfile {
  readonly id: string;
  readonly label: string;
  readonly alias: string;
  readonly callbackUrlSecretRef: string;
  readonly callbackSignatureSecretRef: string;
  readonly dispatchEndpointSecretRef: string;
  readonly allowedHosts: string;
}

const HANDOFF_PROVIDER_PROFILES: readonly HandoffProviderProfile[] = [
  {
    id: "owner-defined",
    label: "직접 지정 기존 RPA",
    alias: "existing-rpa-primary",
    callbackUrlSecretRef: "secret://tenant-a/integration/existing-rpa/callback-url",
    callbackSignatureSecretRef: "secret://tenant-a/integration/existing-rpa/callback-signing",
    dispatchEndpointSecretRef: "secret://tenant-a/integration/existing-rpa/dispatch-endpoint",
    allowedHosts: "rpa-provider.example.com",
  },
  {
    id: "uipath",
    label: "UiPath 연동 프로필",
    alias: "uipath-primary",
    callbackUrlSecretRef: "secret://tenant-a/integration/uipath/callback-url",
    callbackSignatureSecretRef: "secret://tenant-a/integration/uipath/callback-signing",
    dispatchEndpointSecretRef: "secret://tenant-a/integration/uipath/dispatch-endpoint",
    allowedHosts: "uipath.example.com",
  },
  {
    id: "automation-anywhere",
    label: "Automation Anywhere 연동 프로필",
    alias: "automation-anywhere-primary",
    callbackUrlSecretRef: "secret://tenant-a/integration/automation-anywhere/callback-url",
    callbackSignatureSecretRef: "secret://tenant-a/integration/automation-anywhere/callback-signing",
    dispatchEndpointSecretRef: "secret://tenant-a/integration/automation-anywhere/dispatch-endpoint",
    allowedHosts: "automation-anywhere.example.com",
  },
  {
    id: "power-automate",
    label: "Power Automate 연동 프로필",
    alias: "power-automate-primary",
    callbackUrlSecretRef: "secret://tenant-a/integration/power-automate/callback-url",
    callbackSignatureSecretRef: "secret://tenant-a/integration/power-automate/callback-signing",
    dispatchEndpointSecretRef: "secret://tenant-a/integration/power-automate/dispatch-endpoint",
    allowedHosts: "power-automate.example.com",
  },
  {
    id: "blue-prism",
    label: "Blue Prism 연동 프로필",
    alias: "blue-prism-primary",
    callbackUrlSecretRef: "secret://tenant-a/integration/blue-prism/callback-url",
    callbackSignatureSecretRef: "secret://tenant-a/integration/blue-prism/callback-signing",
    dispatchEndpointSecretRef: "secret://tenant-a/integration/blue-prism/dispatch-endpoint",
    allowedHosts: "blue-prism.example.com",
  },
];

const DEFAULT_HANDOFF_PROVIDER_PROFILE = HANDOFF_PROVIDER_PROFILES[0] as HandoffProviderProfile;

export function IntegrationHandoffPanel({
  handoffs,
  isLoading,
  isError,
  canCreate,
  isCreating,
  createError,
  onCreate,
  canDispatch,
  dispatchingHandoffId,
  dispatchErrorHandoffId,
  onDispatch,
  canRecordReceipt,
  recordingHandoffId,
  receiptErrorHandoffId,
  onRecordReceipt,
}: {
  handoffs: readonly IntegrationHandoff[];
  isLoading: boolean;
  isError: boolean;
  canCreate: boolean;
  isCreating: boolean;
  createError: boolean;
  onCreate: (draft: IntegrationHandoffCreateDraft) => void;
  canDispatch: boolean;
  dispatchingHandoffId: string | null;
  dispatchErrorHandoffId: string | null;
  onDispatch: (handoff: IntegrationHandoff, draft: IntegrationHandoffDispatchDraft) => void;
  canRecordReceipt: boolean;
  recordingHandoffId: string | null;
  receiptErrorHandoffId: string | null;
  onRecordReceipt: (handoff: IntegrationHandoff, draft: IntegrationHandoffReceiptDraft) => void;
}): JSX.Element {
  return (
    <div className="ops-column">
      <div className="ops-alert-center-head">
        <h3>기존 RPA 전달</h3>
        <span className="badge muted">{isLoading ? "불러오는 중" : `${handoffs.length}건 표시`}</span>
      </div>
      {canCreate && (
        <IntegrationHandoffCreateForm
          isCreating={isCreating}
          hasError={createError}
          onCreate={onCreate}
        />
      )}
      <IntegrationHandoffList
        handoffs={handoffs}
        isError={isError}
        canDispatch={canDispatch}
        dispatchingHandoffId={dispatchingHandoffId}
        dispatchErrorHandoffId={dispatchErrorHandoffId}
        onDispatch={onDispatch}
        canRecordReceipt={canRecordReceipt}
        recordingHandoffId={recordingHandoffId}
        receiptErrorHandoffId={receiptErrorHandoffId}
        onRecordReceipt={onRecordReceipt}
      />
    </div>
  );
}

function IntegrationHandoffCreateForm({
  isCreating,
  hasError,
  onCreate,
}: {
  isCreating: boolean;
  hasError: boolean;
  onCreate: (draft: IntegrationHandoffCreateDraft) => void;
}): JSX.Element {
  const [providerProfileId, setProviderProfileId] = useState(DEFAULT_HANDOFF_PROVIDER_PROFILE.id);
  const [providerAlias, setProviderAlias] = useState(DEFAULT_HANDOFF_PROVIDER_PROFILE.alias);
  const [jobRef, setJobRef] = useState("queue:invoice-posting");
  const [payloadRef, setPayloadRef] = useState("artifact://handoff/invoice-posting-001");
  const [callbackUrlSecretRef, setCallbackUrlSecretRef] = useState(DEFAULT_HANDOFF_PROVIDER_PROFILE.callbackUrlSecretRef);
  const [callbackSignatureSecretRef, setCallbackSignatureSecretRef] = useState(DEFAULT_HANDOFF_PROVIDER_PROFILE.callbackSignatureSecretRef);
  const [legalHold, setLegalHold] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  function selectProviderProfile(profileId: string): void {
    const profile = HANDOFF_PROVIDER_PROFILES.find((candidate) => candidate.id === profileId) ?? DEFAULT_HANDOFF_PROVIDER_PROFILE;
    setProviderProfileId(profile.id);
    setProviderAlias(profile.alias);
    setCallbackUrlSecretRef(profile.callbackUrlSecretRef);
    setCallbackSignatureSecretRef(profile.callbackSignatureSecretRef);
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const provider = providerAlias.trim();
    const job = jobRef.trim();
    const payload = payloadRef.trim();
    const callbackRef = callbackUrlSecretRef.trim();
    const callbackSignatureRef = callbackSignatureSecretRef.trim();
    if (provider.length === 0 || job.length === 0 || payload.length === 0) {
      setValidationError("전달 대상, 작업 참조, 자료 참조를 모두 입력하세요.");
      return;
    }
    if (callbackRef.length > 0 && !callbackRef.startsWith("secret://")) {
      setValidationError("회신 주소는 SecretRef 형식이어야 합니다.");
      return;
    }
    if (callbackSignatureRef.length > 0 && !callbackSignatureRef.startsWith("secret://")) {
      setValidationError("회신 서명 키는 SecretRef 형식이어야 합니다.");
      return;
    }
    setValidationError(null);
    onCreate({
      providerAlias: provider,
      jobRef: job,
      payloadRef: payload,
      callbackUrlSecretRef: callbackRef.length === 0 ? null : callbackRef,
      callbackSignatureSecretRef: callbackSignatureRef.length === 0 ? null : callbackSignatureRef,
      legalHold,
    });
  }

  return (
    <form className="ops-webhook-form" onSubmit={submit}>
      <div className="form-grid ops-webhook-grid">
        <label className="field">
          전달 대상 프로필
          <select aria-label="전달 대상 프로필" value={providerProfileId} onChange={(event) => selectProviderProfile(event.target.value)}>
            {HANDOFF_PROVIDER_PROFILES.map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          전달 대상 별칭
          <input aria-label="전달 대상 별칭" value={providerAlias} onChange={(event) => setProviderAlias(event.target.value)} />
        </label>
        <label className="field">
          전달 작업 참조
          <input aria-label="전달 작업 참조" value={jobRef} onChange={(event) => setJobRef(event.target.value)} />
        </label>
        <label className="field">
          전달 자료 참조
          <input aria-label="전달 자료 참조" value={payloadRef} onChange={(event) => setPayloadRef(event.target.value)} />
        </label>
        <label className="field">
          전달 회신 SecretRef
          <input aria-label="전달 회신 SecretRef" value={callbackUrlSecretRef} onChange={(event) => setCallbackUrlSecretRef(event.target.value)} />
        </label>
        <label className="field">
          전달 서명 SecretRef
          <input aria-label="전달 서명 SecretRef" value={callbackSignatureSecretRef} onChange={(event) => setCallbackSignatureSecretRef(event.target.value)} />
        </label>
      </div>
      <p className="subtle">연동 프로필은 참고용 안내(메타데이터 전용)입니다. 벤더 API/OAuth, 작업 매핑, 엔드포인트 관리는 운영 담당자와 제공자가 결정하며, 회신·발송 정보는 SecretRef로만 보관해야 합니다.</p>
      <div className="inline-actions">
        <label className="checkbox-inline">
          <input type="checkbox" checked={legalHold} onChange={(event) => setLegalHold(event.target.checked)} />
          법적 보존
        </label>
        <button className="btn" type="submit" disabled={isCreating}>
          {isCreating ? "기록 중" : "전달 만들기"}
        </button>
        {validationError !== null && <span className="form-alert red" role="alert">{validationError}</span>}
        {hasError && <span className="form-alert red" role="alert">전달 요청에 실패했습니다</span>}
      </div>
    </form>
  );
}

function IntegrationHandoffList({
  handoffs,
  isError,
  canDispatch,
  dispatchingHandoffId,
  dispatchErrorHandoffId,
  onDispatch,
  canRecordReceipt,
  recordingHandoffId,
  receiptErrorHandoffId,
  onRecordReceipt,
}: {
  handoffs: readonly IntegrationHandoff[];
  isError: boolean;
  canDispatch: boolean;
  dispatchingHandoffId: string | null;
  dispatchErrorHandoffId: string | null;
  onDispatch: (handoff: IntegrationHandoff, draft: IntegrationHandoffDispatchDraft) => void;
  canRecordReceipt: boolean;
  recordingHandoffId: string | null;
  receiptErrorHandoffId: string | null;
  onRecordReceipt: (handoff: IntegrationHandoff, draft: IntegrationHandoffReceiptDraft) => void;
}): JSX.Element {
  const [receiptFormHandoffId, setReceiptFormHandoffId] = useState<string | null>(null);
  const [dispatchFormHandoffId, setDispatchFormHandoffId] = useState<string | null>(null);

  if (isError) {
    return (
      <div className="ops-alert-empty" role="status">
        <strong>전달 기록을 확인할 수 없습니다</strong>
        <span className="subtle">기존 RPA 전달 증빙을 불러오지 못했습니다.</span>
      </div>
    );
  }
  if (handoffs.length === 0) {
    return (
      <div className="ops-alert-empty" role="status">
        <strong>기록된 전달 요청이 없습니다</strong>
        <span className="subtle">수신 확인이 없으면 외부 RPA 완료로 처리하지 않습니다.</span>
      </div>
    );
  }
  return (
    <ul className="ops-alert-list">
      {handoffs.map((handoff) => (
        <li key={handoff.handoff_id}>
          <div className="ops-alert-main">
            <div className="ops-alert-badges">
              <span className={`badge ${handoffTone(handoff.status)}`}>{handoffStatusLabel(handoff.status)}</span>
              <span className="subtle">{handoff.provider_alias}</span>
            </div>
            <strong>{handoff.job_ref}</strong>
            <span className="subtle">자료 {handoff.payload_ref}</span>
            <span className="subtle">{formatDateTime(handoff.requested_at)} · 요청자 {handoff.requested_by}</span>
            {handoff.latest_receipt_id !== null && (
              <span className="subtle">수신 확인 {handoff.latest_receipt_id} / 외부 작업 {handoff.external_job_id ?? "대기"}</span>
            )}
          </div>
          <div className="inline-actions">
            {canDispatch && isDispatchable(handoff) && (
              <button className="linklike" type="button" onClick={() => setDispatchFormHandoffId((current) => (current === handoff.handoff_id ? null : handoff.handoff_id))}>
                {dispatchFormHandoffId === handoff.handoff_id ? "발송 닫기" : "발송"}
              </button>
            )}
            {canRecordReceipt && (
              <button
                className="linklike"
                type="button"
                onClick={() => setReceiptFormHandoffId((current) => (current === handoff.handoff_id ? null : handoff.handoff_id))}
              >
                {receiptFormHandoffId === handoff.handoff_id ? "수신 확인 닫기" : "수신 확인 기록"}
              </button>
            )}
            {dispatchErrorHandoffId === handoff.handoff_id && <span className="form-alert red" role="alert">발송에 실패했습니다</span>}
            {receiptErrorHandoffId === handoff.handoff_id && <span className="form-alert red" role="alert">수신 확인 기록에 실패했습니다</span>}
          </div>
          {dispatchFormHandoffId === handoff.handoff_id && (
            <IntegrationHandoffDispatchForm
              handoff={handoff}
              isDispatching={dispatchingHandoffId === handoff.handoff_id}
              onDispatch={onDispatch}
            />
          )}
          {receiptFormHandoffId === handoff.handoff_id && (
            <IntegrationHandoffReceiptForm
              handoff={handoff}
              isRecording={recordingHandoffId === handoff.handoff_id}
              onRecord={onRecordReceipt}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

function IntegrationHandoffDispatchForm({
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

function IntegrationHandoffReceiptForm({
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

const HANDOFF_STATUS_LABELS: Record<string, string> = { accepted: "접수됨", deferred: "전달 대기" }; // 패널 고유값만 로컬
function handoffStatusLabel(status: string): string { return HANDOFF_STATUS_LABELS[status] ?? statusLabel(status); } // 공유 enum(completed/failed/cancelled)은 badges statusLabel 재사용, 미매핑 raw 폴백(조용한 공백 금지)
function handoffTone(status: IntegrationHandoff["status"]): "green" | "amber" | "red" | "blue" | "muted" {
  if (status === "completed") return "green";
  if (status === "failed") return "red";
  if (status === "cancelled") return "muted"; // 취소됨=중립 — 실패와 분리(어휘 정합: badges.tsx tone)
  if (status === "deferred") return "amber";
  return "blue";
}

function isDispatchable(handoff: IntegrationHandoff): boolean {
  return handoff.status === "deferred" || handoff.status === "failed";
}

function profileForProviderAlias(providerAlias: string): HandoffProviderProfile {
  const normalized = providerAlias.trim().toLowerCase();
  return HANDOFF_PROVIDER_PROFILES.find((profile) =>
    normalized === profile.alias.toLowerCase() ||
    normalized === profile.id ||
    normalized.startsWith(`${profile.id}-`),
  ) ?? DEFAULT_HANDOFF_PROVIDER_PROFILE;
}
