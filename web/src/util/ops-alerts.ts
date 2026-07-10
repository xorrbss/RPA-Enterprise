import type { OpsAlertItem } from "../api/types";

// 운영 알림 그룹핑 단일 출처 — `${subject_type}:${source}` 키로 동일 계열을 묶는다(대표 1건 + 건수).
// 알림 센터(OpsAlertCenter)·대시보드(OpsSignalPanel)·상단바 벨(TopbarAlertBell)이 같은 결과를 소비해
// 화면마다 dedupe 규칙이 갈라지는 것을 구조로 차단한다(감사 P0-3 해소, T1/T2 설계).
export interface OpsAlertGroup {
  readonly representative: OpsAlertItem;
  readonly count: number;
}

export function groupOpsAlerts(alerts: readonly OpsAlertItem[]): OpsAlertGroup[] {
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

// F4: 소스 라벨·route 이동도 그룹핑과 같은 이유로 공용 유틸로 이동(벨은 components/layout 이라 views 역참조 금지).
// 기존 소비처(views/orchestration/ops-alert-labels.ts)는 재수출로 경로 호환 유지.
export function opsAlertSourceLabel(source: OpsAlertItem["source"]): string {
  if (source === "run_sla") return "실행 SLA";
  if (source === "human_task_sla") return "사람 작업 SLA";
  if (source === "trigger_fire") return "트리거 발화";
  if (source === "failure_spike") return "실패 급증";
  if (source === "session_expiry") return "로그인 세션 만료";
  if (source === "artifact_redaction") return "증빙 보호 실패";
  if (source === "security_abort") return "보안 차단 중단";
  if (source === "bot_pool") return "Bot Pool";
  if (source === "scim_secret_rotation") return "SCIM SecretRef";
  if (source === "readiness_evidence") return "운영 전환 준비";
  if (source === "audit_verifier") return "감사 체인";
  return "재처리 대기";
}

export function navigateAlertRoute(route: string | null): void {
  if (route === null) return;
  const trimmed = route.trim();
  if (trimmed.length === 0) return;
  location.hash = trimmed.startsWith("#") ? trimmed : `#${trimmed.replace(/^\/+/, "")}`;
}
