import { useState, type FormEvent } from "react";

import type { OpsAlertItem, OpsNotificationAttempt, OpsNotificationDelivery } from "../../api/types";
import { formatDateTime } from "./format";
import { attemptStatusTone, deliveryStatusTone, notificationStatusLabel } from "./ops-alert-labels";
import { isDnsHost, isSecretRef, parseAllowedHosts } from "./trigger-helpers";

export interface OpsWebhookSendDraft {
  readonly endpointSecretRef: string;
  readonly callbackSignatureSecretRef: string | null;
  readonly routePolicyRef: string;
  readonly recipientGroupRef: string | null;
  readonly allowedHosts: readonly string[];
  readonly providerAlias: string | null;
  readonly summary: string | null;
  readonly legalHold: boolean;
}

export function WebhookSendPanel({
  alert,
  isSending,
  hasError,
  queuedAttempt,
  onSend,
}: {
  alert: OpsAlertItem;
  isSending: boolean;
  hasError: boolean;
  queuedAttempt: OpsNotificationAttempt | null;
  onSend: (alert: OpsAlertItem, draft: OpsWebhookSendDraft) => void;
}): JSX.Element {
  const [endpointSecretRef, setEndpointSecretRef] = useState("");
  const [callbackSignatureSecretRef, setCallbackSignatureSecretRef] = useState("");
  const [routePolicyRef, setRoutePolicyRef] = useState("ops-alerts-primary");
  const [recipientGroupRef, setRecipientGroupRef] = useState("ops-primary-oncall");
  const [allowedHosts, setAllowedHosts] = useState("");
  const [providerAlias, setProviderAlias] = useState("webhook-primary");
  const [summary, setSummary] = useState(alert.title);
  const [legalHold, setLegalHold] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const endpoint = endpointSecretRef.trim();
    const callbackSignatureRef = callbackSignatureSecretRef.trim();
    const routePolicy = routePolicyRef.trim();
    const hosts = parseAllowedHosts(allowedHosts);
    if (!isSecretRef(endpoint)) {
      setValidationError("Endpoint SecretRef must start with secret://");
      return;
    }
    if (callbackSignatureRef.length > 0 && !isSecretRef(callbackSignatureRef)) {
      setValidationError("Callback signing SecretRef must start with secret://");
      return;
    }
    if (endpoint.length === 0) {
      setValidationError("Endpoint SecretRef를 입력하세요.");
      return;
    }
    if (routePolicy.length === 0) {
      setValidationError("Route policy ref를 입력하세요.");
      return;
    }
    if (hosts.length === 0) {
      setValidationError("허용 호스트를 하나 이상 입력하세요.");
      return;
    }
    if (hosts.some((host) => !isDnsHost(host))) {
      setValidationError("허용 호스트는 DNS 호스트명만 입력하세요.");
      return;
    }
    setValidationError(null);
    onSend(alert, {
      endpointSecretRef: endpoint,
      callbackSignatureSecretRef: callbackSignatureRef === "" ? null : callbackSignatureRef,
      routePolicyRef: routePolicy,
      recipientGroupRef: recipientGroupRef.trim() === "" ? null : recipientGroupRef.trim(),
      allowedHosts: hosts,
      providerAlias: providerAlias.trim() === "" ? null : providerAlias.trim(),
      summary: summary.trim() === "" ? null : summary.trim(),
      legalHold,
    });
  }

  return (
    <form className="ops-webhook-form" onSubmit={submit}>
      <div className="ops-delivery-panel-head">
        <strong>웹훅 발송 큐</strong>
        {queuedAttempt !== null && <span className={`badge ${attemptStatusTone(queuedAttempt.status)}`}>{notificationStatusLabel(queuedAttempt.status)}</span>}
      </div>
      <div className="form-grid ops-webhook-grid">
        <label className="field">
          Endpoint SecretRef
          <input
            aria-label="Endpoint SecretRef"
            value={endpointSecretRef}
            onChange={(event) => setEndpointSecretRef(event.target.value)}
            placeholder="secret://rpa/staging/notification-sender/notification/webhook/ops-primary"
          />
        </label>
        <label className="field">
          Callback signing SecretRef alias
          <input
            aria-label="Callback signing SecretRef"
            value={callbackSignatureSecretRef}
            onChange={(event) => setCallbackSignatureSecretRef(event.target.value)}
            placeholder="secret://rpa/staging/notification-sender/signing/webhook-callback"
          />
        </label>
        <label className="field">
          Route policy ref
          <input
            aria-label="Route policy ref"
            value={routePolicyRef}
            onChange={(event) => setRoutePolicyRef(event.target.value)}
            placeholder="ops-alerts-primary"
          />
        </label>
        <label className="field">
          Allowed hosts
          <input
            aria-label="Allowed hosts"
            value={allowedHosts}
            onChange={(event) => setAllowedHosts(event.target.value)}
            placeholder="hooks.slack.com, example.webhook.office.com"
          />
        </label>
        <label className="field">
          Recipient group ref
          <input
            aria-label="Recipient group ref"
            value={recipientGroupRef}
            onChange={(event) => setRecipientGroupRef(event.target.value)}
            placeholder="ops-primary-oncall"
          />
        </label>
        <label className="field">
          Provider alias
          <input
            aria-label="Provider alias"
            value={providerAlias}
            onChange={(event) => setProviderAlias(event.target.value)}
            placeholder="webhook-primary"
          />
        </label>
        <label className="field ops-webhook-summary">
          Summary
          <input
            aria-label="Webhook summary"
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            placeholder="Ops alert webhook notification"
          />
        </label>
      </div>
      <div className="inline-actions">
        <label className="checkbox-inline">
          <input type="checkbox" checked={legalHold} onChange={(event) => setLegalHold(event.target.checked)} />
          법적 보존
        </label>
        <button className="btn" type="submit" disabled={isSending}>
          {isSending ? "큐 등록 중" : "발송 큐잉"}
        </button>
        {queuedAttempt !== null && (
          <span className="subtle">attempt {queuedAttempt.attempt_no}/{queuedAttempt.max_attempts} · {formatDateTime(queuedAttempt.next_attempt_at)}</span>
        )}
        {validationError !== null && <span className="form-alert red" role="alert">{validationError}</span>}
        {hasError && <span className="form-alert red" role="alert">웹훅 발송 요청 실패</span>}
      </div>
    </form>
  );
}

export function DeliveryReceiptPanel({
  receipts,
  isLoading,
  isError,
}: {
  receipts: readonly OpsNotificationDelivery[];
  isLoading: boolean;
  isError: boolean;
}): JSX.Element {
  if (isError) {
    return (
      <div className="ops-delivery-panel" role="status">
        <strong>전달 증빙을 불러오지 못했습니다.</strong>
        <span className="subtle">외부 제공자 수신 증빙을 확인할 수 없습니다.</span>
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="ops-delivery-panel" role="status">
        <strong>전달 증빙 확인 중</strong>
      </div>
    );
  }
  if (receipts.length === 0) {
    return (
      <div className="ops-delivery-panel" role="status">
        <strong>제공자 수신 증빙이 없습니다.</strong>
        <span className="subtle">콘솔 확인과 외부 전달 증빙은 별도로 기록됩니다.</span>
      </div>
    );
  }
  return (
    <div className="ops-delivery-panel">
      <div className="ops-delivery-panel-head">
        <strong>제공자 전달 증빙</strong>
        <span className="badge muted">{receipts.length}건 표시</span>
      </div>
      <ul className="ops-delivery-list">
        {receipts.map((receipt) => (
          <li key={receipt.delivery_id}>
            <div className="ops-alert-badges">
              <span className={`badge ${deliveryStatusTone(receipt.status)}`}>{notificationStatusLabel(receipt.status)}</span>
              <span className="subtle">{receipt.channel} / {receipt.provider_alias}</span>
            </div>
            <span className="subtle">{formatDateTime(receipt.receipt_at)} · attempt {receipt.attempt_no}</span>
            <span>{receipt.summary}</span>
            <span className="subtle">
              {receipt.receipt_id !== null ? `receipt ${receipt.receipt_id}` : `error ${receipt.error_code ?? "unknown"}`} · endpoint {receipt.endpoint_secret_ref}
            </span>
            {receipt.recipient_group_ref !== null && <span className="subtle">recipient group {receipt.recipient_group_ref}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
