import type { OpsAlertItem } from "../../api/types";
import { formatDateTime } from "./format";
import type { AlertSeverityFilter, AlertSourceFilter } from "./trigger-helpers";

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
}): JSX.Element {
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
          {alerts.map((alert) => (
            <li key={alert.alert_id}>
              <div className="ops-alert-main">
                <div className="ops-alert-badges">
                  <span className={`badge ${alertSeverityTone(alert.severity)}`}>{alertSeverityLabel(alert.severity)}</span>
                  <span className="subtle">{opsAlertSourceLabel(alert.source)}</span>
                </div>
                <strong>{alert.title}</strong>
                <span className="subtle">{alert.detail}</span>
                <span className="ops-alert-action">권장 조치: {alert.recommended_action}</span>
                <span className="subtle">{opsAlertTiming(alert)}</span>
              </div>
              {alert.route !== null && (
                <button className="linklike" type="button" onClick={() => navigateAlertRoute(alert.route)}>
                  {opsAlertActionLabel(alert)}
                </button>
              )}
            </li>
          ))}
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
    default:
      return "자세히 보기";
  }
}
