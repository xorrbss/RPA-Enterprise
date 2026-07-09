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
