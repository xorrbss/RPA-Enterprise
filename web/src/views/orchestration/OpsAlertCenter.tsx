import { useState, type FormEvent } from "react";

import type { OpsAlertItem, OpsNotificationAttempt, OpsNotificationDelivery } from "../../api/types";
import { statusLabel as commonStatusLabel } from "../../components/badges";
import { formatDateTime } from "./format";
import type { AlertSeverityFilter, AlertSourceFilter } from "./trigger-helpers";

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

export function OpsAlertCenter({
  alerts,
  isError,
  isLoading,
  isFetchingMore,
  nextCursor,
  severity,
  source,
  onLoadMore,
  onSeverityChange,
  onSourceChange,
  canAck,
  ackingAlertId,
  ackErrorAlertId,
  onAck,
  deliveryAlertId,
  deliveryReceipts,
  isDeliveryLoading,
  isDeliveryError,
  onToggleDeliveries,
  canSendWebhook,
  sendingWebhookAlertId,
  webhookSendErrorAlertId,
  queuedWebhookAttempt,
  onSendWebhook,
}: {
  alerts: readonly OpsAlertItem[];
  isError: boolean;
  isLoading: boolean;
  isFetchingMore: boolean;
  nextCursor: string | null;
  severity: AlertSeverityFilter;
  source: AlertSourceFilter;
  onLoadMore: (cursor: string) => void;
  onSeverityChange: (severity: AlertSeverityFilter) => void;
  onSourceChange: (source: AlertSourceFilter) => void;
  canAck: boolean;
  ackingAlertId: string | null;
  ackErrorAlertId: string | null;
  onAck: (alert: OpsAlertItem) => void;
  deliveryAlertId: string | null;
  deliveryReceipts: readonly OpsNotificationDelivery[];
  isDeliveryLoading: boolean;
  isDeliveryError: boolean;
  onToggleDeliveries: (alert: OpsAlertItem) => void;
  canSendWebhook: boolean;
  sendingWebhookAlertId: string | null;
  webhookSendErrorAlertId: string | null;
  queuedWebhookAttempt: OpsNotificationAttempt | null;
  onSendWebhook: (alert: OpsAlertItem, draft: OpsWebhookSendDraft) => void;
}): JSX.Element {
  const [webhookFormAlertId, setWebhookFormAlertId] = useState<string | null>(null);
  const alertGroups = groupOpsAlerts(alerts);

  return (
    <div className="ops-column ops-alert-center">
      <div className="ops-alert-center-head">
        <h3>알림 센터</h3>
        <span className="badge muted">{isLoading ? "동기화 중" : `${alerts.length}건`}</span>
      </div>
      <div className="ops-alert-controls">
        <label className="select-compact">
          심각도
          <select aria-label="알림 심각도" value={severity} onChange={(event) => onSeverityChange(event.target.value as AlertSeverityFilter)}>
            <option value="all">전체</option>
            <option value="critical">{alertSeverityLabel("critical")}</option>
            <option value="warning">{alertSeverityLabel("warning")}</option>
            <option value="info">{alertSeverityLabel("info")}</option>
          </select>
        </label>
        <label className="select-compact">
          유형
          <select aria-label="알림 유형" value={source} onChange={(event) => onSourceChange(event.target.value as AlertSourceFilter)}>
            <option value="all">전체</option>
            <option value="run_sla">실행 SLA</option>
            <option value="human_task_sla">사람 작업 SLA</option>
            <option value="trigger_fire">트리거 발화</option>
            <option value="failure_spike">실패 급증</option>
            <option value="dlq">재처리 대기</option>
            <option value="bot_pool">Bot Pool</option>
            <option value="scim_secret_rotation">SCIM SecretRef</option>
            <option value="readiness_evidence">운영 전환 준비</option>
            <option value="audit_verifier">감사 체인</option>
          </select>
        </label>
      </div>
      {isError ? (
        <div className="ops-alert-empty" role="status">
          <strong>운영 알림을 불러오지 못했습니다.</strong>
          <span className="subtle">알림 API와 콘솔 네트워크 상태를 확인하세요.</span>
        </div>
      ) : alerts.length === 0 ? (
        <div className="ops-alert-empty" role="status">
          <strong>열린 운영 알림이 없습니다.</strong>
          <span className="subtle">SLA, 트리거, 재처리 대기 감시는 현재 정상 범위입니다.</span>
        </div>
      ) : (
        <>
        <ul className="ops-alert-list">
          {alertGroups.map((group) => {
            const { representative: alert } = group;
            return (
            <li key={alert.alert_id}>
              <div className="ops-alert-main">
                <div className="ops-alert-badges">
                  <span className={`badge ${alertSeverityTone(alert.severity)}`}>{alertSeverityLabel(alert.severity)}</span>
                  <span className="subtle">{opsAlertSourceLabel(alert.source)}</span>
                  {group.count > 1 && <span className="badge muted">외 {group.count - 1}건</span>}
                </div>
                <strong>{alert.title}</strong>
                <span className="subtle">{localizeStatusText(alert.detail)}</span>
                <span className="ops-alert-action">권장 조치: {localizeStatusText(alert.recommended_action)}</span>
                <span className="subtle">{opsAlertTiming(alert)}</span>
              </div>
              <div className="inline-actions">
                {alert.route !== null && (
                  <button className="linklike" type="button" onClick={() => navigateAlertRoute(alert.route)}>
                    {opsAlertActionLabel(alert)}
                  </button>
                )}
                <button className="linklike" type="button" onClick={() => onToggleDeliveries(alert)}>
                  {deliveryAlertId === alert.alert_id ? "전달 증빙 닫기" : "전달 증빙"}
                </button>
                {canSendWebhook && (
                  <button
                    className="linklike"
                    type="button"
                    onClick={() => setWebhookFormAlertId((current) => (current === alert.alert_id ? null : alert.alert_id))}
                  >
                    {webhookFormAlertId === alert.alert_id ? "웹훅 닫기" : "웹훅 발송"}
                  </button>
                )}
                {alert.status === "acknowledged" && alert.ack !== null ? (
                  <span className="badge muted" title={`확인자: ${alert.ack.acknowledged_by} · ${formatDateTime(alert.ack.acknowledged_at)}`}>
                    확인됨
                  </span>
                ) : canAck ? (
                  <button className="btn" type="button" disabled={ackingAlertId === alert.alert_id} onClick={() => onAck(alert)}>
                    {ackingAlertId === alert.alert_id ? "확인 중" : "확인"}
                  </button>
                ) : null}
                {ackErrorAlertId === alert.alert_id && (
                  <span className="form-alert red" role="alert">
                    확인 처리 실패
                  </span>
                )}
              </div>
              {deliveryAlertId === alert.alert_id && (
                <DeliveryReceiptPanel receipts={deliveryReceipts} isLoading={isDeliveryLoading} isError={isDeliveryError} />
              )}
              {webhookFormAlertId === alert.alert_id && (
                <WebhookSendPanel
                  alert={alert}
                  isSending={sendingWebhookAlertId === alert.alert_id}
                  hasError={webhookSendErrorAlertId === alert.alert_id}
                  queuedAttempt={queuedWebhookAttempt?.alert_id === alert.alert_id ? queuedWebhookAttempt : null}
                  onSend={onSendWebhook}
                />
              )}
            </li>
            );
          })}
        </ul>
        {nextCursor !== null && (
          <div className="inline-actions">
            <button className="btn" type="button" disabled={isFetchingMore} onClick={() => onLoadMore(nextCursor)}>
              {isFetchingMore ? "불러오는 중" : "더 보기"}
            </button>
          </div>
        )}
        </>
      )}
    </div>
  );
}

function WebhookSendPanel({
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

function DeliveryReceiptPanel({
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

function parseAllowedHosts(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((part) => part.trim().toLowerCase()).filter(Boolean))];
}

function isDnsHost(host: string): boolean {
  if (host === "localhost" || host.includes("/") || host.includes(":")) return false;
  const labels = host.split(".");
  return labels.length >= 2 && labels.every((label) =>
    label.length > 0 &&
    label.length <= 63 &&
    /^[a-z0-9-]+$/i.test(label) &&
    !label.startsWith("-") &&
    !label.endsWith("-"),
  );
}

function isSecretRef(value: string): boolean {
  return value.startsWith("secret://") && value.length > "secret://".length;
}

interface OpsAlertGroup {
  readonly representative: OpsAlertItem;
  readonly count: number;
}

function groupOpsAlerts(alerts: readonly OpsAlertItem[]): OpsAlertGroup[] {
  const groups = new Map<string, { representative: OpsAlertItem; count: number }>();
  alerts.forEach((alert) => {
    const key = `${alert.subject_type}:${alert.source}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { representative: alert, count: 1 });
      return;
    }
    existing.count += 1;
  });
  return [...groups.values()];
}

function localizeStatusText(value: string): string {
  return value.replace(
    /\b(queued|claimed|running|suspending|suspended|resume_requested|resuming|completed|cancelled|failed_business|failed_system|pending|sending|sent|delivered|failed|dead_letter|open|acknowledged)\b/g,
    (status) => commonStatusLabel(status),
  );
}

function notificationStatusLabel(status: OpsNotificationAttempt["status"] | OpsNotificationDelivery["status"]): string {
  switch (status) {
    case "pending": return "발송 대기";
    case "sending": return "발송 중";
    case "sent": return "발송됨";
    case "delivered": return "전달됨";
    case "failed": return "실패";
    case "dead_letter": return "실패 보관";
    default: return commonStatusLabel(status);
  }
}

function attemptStatusTone(status: OpsNotificationAttempt["status"]): "green" | "amber" | "red" | "blue" {
  if (status === "sent") return "green";
  if (status === "dead_letter") return "red";
  if (status === "failed") return "amber";
  return "blue";
}

function deliveryStatusTone(status: OpsNotificationDelivery["status"]): "green" | "amber" | "red" {
  if (status === "delivered") return "green";
  if (status === "failed") return "red";
  return "amber";
}

function navigateAlertRoute(route: string | null): void {
  if (route === null) return;
  const trimmed = route.trim();
  if (trimmed.length === 0) return;
  location.hash = trimmed.startsWith("#") ? trimmed : `#${trimmed.replace(/^\/+/, "")}`;
}

function alertSeverityTone(severity: OpsAlertItem["severity"]): "red" | "amber" | "blue" {
  if (severity === "critical") return "red";
  if (severity === "warning") return "amber";
  return "blue";
}

function alertSeverityLabel(severity: OpsAlertItem["severity"]): string {
  if (severity === "critical") return "위험";
  if (severity === "warning") return "주의";
  return "정보";
}

function opsAlertSourceLabel(source: OpsAlertItem["source"]): string {
  if (source === "run_sla") return "실행 SLA";
  if (source === "human_task_sla") return "사람 작업 SLA";
  if (source === "trigger_fire") return "트리거 발화";
  if (source === "failure_spike") return "실패 급증";
  if (source === "bot_pool") return "Bot Pool";
  if (source === "scim_secret_rotation") return "SCIM SecretRef";
  if (source === "readiness_evidence") return "운영 전환 준비";
  if (source === "audit_verifier") return "감사 체인";
  return "재처리 대기";
}

function opsAlertTiming(alert: OpsAlertItem): string {
  return alert.due_at !== undefined && alert.due_at !== null
    ? `감지 ${formatDateTime(alert.detected_at)} · 기한 ${formatDateTime(alert.due_at)}`
    : `감지 ${formatDateTime(alert.detected_at)}`;
}

function opsAlertActionLabel(alert: OpsAlertItem): string {
  if (alert.source === "failure_spike") return "실패 기록 보기";
  switch (alert.subject_type) {
    case "run":
      return "실행 보기";
    case "human_task":
      return "사람 작업 보기";
    case "run_trigger":
      return "예약 이력 보기";
    case "dlq":
      return "재처리 대기 보기";
    case "bot_pool":
      return "Bot Pool 보기";
    case "scim_provider":
      return "SCIM 설정 보기";
    case "readiness_evidence":
      return "운영 전환 준비";
    case "audit_verifier":
      return "감사 검증 보기";
    default:
      return "자세히 보기";
  }
}
