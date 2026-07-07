import { ErrorState, desktopStateForError } from "../../components/states";
import { navigate } from "../../router";
import type { OpsAlertItem, OpsHealth } from "../../api/types";

export function OpsSignalPanel({
  health,
  alerts,
  isLoading,
  isError,
  error,
}: {
  health: OpsHealth | undefined;
  alerts: readonly OpsAlertItem[];
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
}): JSX.Element {
  const topAlerts = alerts.slice(0, 3);
  const errorState = isError ? desktopStateForError(error) : null;
  return (
    <section className="panel ops-signal-panel" aria-label="운영 헬스와 긴급 알림">
      <div className="panel-head">
        <div>
          <h2>운영 헬스와 긴급 알림</h2>
          <p className="subtle">{health?.detected_at ?? (isLoading ? "동기화 중" : "스냅샷 없음")}</p>
        </div>
        <span className={`badge ${opsHealthTone(health?.status, isError)}`}>{opsHealthLabel(health?.status, isLoading, isError)}</span>
      </div>
      {isError ? (
        <ErrorState
          title={errorState?.title}
          message={`운영 알림 스냅샷을 확인하지 못했습니다. ${errorState?.message ?? ""}`}
          details={errorState?.details}
        />
      ) : (
        <div className="ops-signal-body">
          <div className="ops-signal-facts">
            <span>
              <strong>{health === undefined ? "-" : health.queue.available ? String(health.queue.pending_jobs ?? 0) : "미연결"}</strong>
              <small>큐 대기</small>
            </span>
            <span>
              <strong>{health === undefined ? "-" : String(health.stale_runs.nonterminal_over_15m)}</strong>
              <small>지연 실행</small>
            </span>
            <span>
              <strong>{health === undefined ? "-" : String(health.browser_leases.expired_open)}</strong>
              <small>만료 미회수 세션</small>
            </span>
          </div>
          {topAlerts.length === 0 ? (
            <p className="subtle ops-signal-empty">긴급 운영 알림이 없습니다.</p>
          ) : (
            <ul className="ops-signal-alerts">
              {topAlerts.map((alert) => (
                <li key={alert.alert_id}>
                  <span className={`badge ${opsAlertTone(alert.severity)}`}>{opsAlertSeverityLabel(alert.severity)}</span>
                  <button className="linklike" type="button" onClick={() => navigateOpsAlert(alert.route)}>
                    {alert.title}
                  </button>
                  <span className="subtle">{opsAlertSourceLabel(alert.source)} · {alert.recommended_action}</span>
                </li>
              ))}
            </ul>
          )}
          <button className="btn" type="button" onClick={() => navigate("automationOps")}>알림 센터 열기</button>
        </div>
      )}
    </section>
  );
}

function opsHealthTone(status: OpsHealth["status"] | undefined, isError: boolean): "green" | "amber" | "red" | "muted" {
  if (isError) return "red";
  if (status === "ok") return "green";
  if (status === "warning") return "amber";
  if (status === "critical") return "red";
  return "muted";
}

function opsHealthLabel(status: OpsHealth["status"] | undefined, isLoading: boolean, isError: boolean): string {
  if (isError) return "조회 실패";
  if (status === "ok") return "정상";
  if (status === "warning") return "주의";
  if (status === "critical") return "위험";
  return isLoading ? "동기화 중" : "미확인";
}

function opsAlertTone(severity: OpsAlertItem["severity"]): "red" | "amber" | "blue" {
  if (severity === "critical") return "red";
  if (severity === "warning") return "amber";
  return "blue";
}

function opsAlertSeverityLabel(severity: OpsAlertItem["severity"]): string {
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
  if (source === "audit_verifier") return "감사 체인";
  return "재처리 대기";
}

function navigateOpsAlert(route: string | null): void {
  if (route === null || route.trim().length === 0) {
    navigate("automationOps");
    return;
  }
  const trimmed = route.trim();
  location.hash = trimmed.startsWith("#") ? trimmed : `#${trimmed.replace(/^\/+/, "")}`;
}
