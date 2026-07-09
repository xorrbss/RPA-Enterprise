import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";

import { navigate } from "../../router";
import { useApiClient } from "../../api/context";
import type { ProductionReadiness } from "../../api/types";
import { groupOpsAlerts } from "../../util/ops-alerts";

// 상단바 알림 벨 — 운영 알림(그룹)과 운영 전환 준비 차단을 한 진입점으로 모은다(T1).
// env 옆 상시 빨간 "차단" 칩을 대체: 신호는 사라지지 않고 벨 배지·레이블로 옮긴다(조용한 은폐 금지).
// P0는 알림 센터 딥링크만 — 드롭다운 미리보기는 열린 결정 P1(T계열 설계 §10).

function readinessBlockerCount(readiness: ProductionReadiness | undefined): number {
  if (readiness === undefined) return 0;
  if (readiness.status === "blocked" || readiness.summary.blocker_count > 0) {
    return Math.max(readiness.summary.blocker_count, 1);
  }
  return 0;
}

export function TopbarAlertBell(): JSX.Element | null {
  const api = useApiClient();
  // ["production-readiness"]는 TopbarContextBadge와 동일 키 — 요청은 캐시 공유로 1회.
  const readiness = useQuery({
    queryKey: ["production-readiness"],
    queryFn: () => api.getProductionReadiness(),
    refetchInterval: 15_000,
  });
  const alerts = useQuery({
    queryKey: ["ops-alerts", "topbar"],
    queryFn: () => api.listOpsAlerts({ limit: 50 }),
    refetchInterval: 30_000,
  });
  const blockerCount = readinessBlockerCount(readiness.data);
  const alertItems = alerts.data?.items ?? [];
  const groups = groupOpsAlerts(alertItems);
  // 알림 데이터가 없는 동안(로딩·오류·권한 없음)은 "새 알림 없음"으로 위장하지 않는다 —
  // 준비 차단 신호도 없으면 벨 자체를 렌더하지 않는다(조용한 green 금지).
  if (alerts.data === undefined && blockerCount === 0) return null;
  const parts: string[] = [];
  if (blockerCount > 0) parts.push(`운영 전환 준비 차단 ${blockerCount}건`);
  if (alerts.isError) parts.push("운영 알림 확인 불가");
  else if (groups.length > 0) parts.push(`운영 알림 ${groups.length}건`);
  const badgeCount = groups.length + (blockerCount > 0 ? 1 : 0);
  const tone =
    blockerCount > 0 || alertItems.some((a) => a.severity === "critical")
      ? "red"
      : alerts.isError || alertItems.some((a) => a.severity === "warning")
        ? "amber"
        : "muted";
  const summary = parts.length > 0 ? parts.join(" · ") : "새 알림 없음";
  return (
    <button
      type="button"
      className="btn icon-btn topbar-alert-bell"
      aria-label={`알림 — ${summary}`}
      title={`${summary} — 알림 센터 열기`}
      onClick={() => navigate("automationOps", { section: "alerts" })}
    >
      <Bell size={16} aria-hidden="true" />
      {badgeCount > 0 && (
        <span className={`alert-bell-count ${tone}`} aria-hidden="true">
          {badgeCount > 9 ? "9+" : String(badgeCount)}
        </span>
      )}
    </button>
  );
}
