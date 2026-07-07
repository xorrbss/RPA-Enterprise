import { useState, type FormEvent } from "react";

import type { IntegrationHandoff } from "../../api/types";
import { formatDateTime } from "./format";
import {
  IntegrationHandoffDispatchForm,
  IntegrationHandoffReceiptForm,
  type IntegrationHandoffDispatchDraft,
  type IntegrationHandoffReceiptDraft,
} from "./integration-handoff-forms";
import {
  DEFAULT_HANDOFF_PROVIDER_PROFILE,
  HANDOFF_PROVIDER_PROFILES,
  handoffStatusLabel,
  handoffTone,
  isDispatchable,
} from "./integration-handoff-labels";

// 발송/수신 확인 양식은 integration-handoff-forms.tsx, 라벨·연동 프로필은 integration-handoff-labels.ts 소관. 소비처 호환 위해 re-export.
export type { IntegrationHandoffDispatchDraft, IntegrationHandoffReceiptDraft } from "./integration-handoff-forms";

export interface IntegrationHandoffCreateDraft {
  readonly providerAlias: string;
  readonly jobRef: string;
  readonly payloadRef: string;
  readonly callbackUrlSecretRef: string | null;
  readonly callbackSignatureSecretRef: string | null;
  readonly legalHold: boolean;
}

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
