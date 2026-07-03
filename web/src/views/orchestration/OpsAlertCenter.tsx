import { useState } from "react";

import type { OpsAlertItem, OpsNotificationAttempt, OpsNotificationDelivery } from "../../api/types";
import { formatDateTime } from "./format";
import {
  ALERT_SOURCE_FILTER_OPTIONS,
  alertSeverityLabel,
  alertSeverityTone,
  groupOpsAlerts,
  localizeStatusText,
  navigateAlertRoute,
  opsAlertActionLabel,
  opsAlertSourceLabel,
  opsAlertTiming,
} from "./ops-alert-labels";
import { DeliveryReceiptPanel, WebhookSendPanel, type OpsWebhookSendDraft } from "./ops-alert-panels";
import type { AlertSeverityFilter, AlertSourceFilter } from "./trigger-helpers";

// 라벨·필터 옵션은 ops-alert-labels.ts, 웹훅 발송/전달 증빙 패널은 ops-alert-panels.tsx 소관. 소비처 호환 위해 re-export.
export type { OpsWebhookSendDraft } from "./ops-alert-panels";

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
            {ALERT_SOURCE_FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
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
