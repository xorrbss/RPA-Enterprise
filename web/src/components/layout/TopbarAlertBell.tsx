import { useCallback, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";

import { navigate } from "../../router";
import { useApiClient } from "../../api/context";
import type { OpsAlertItem, ProductionReadiness } from "../../api/types";
import { groupOpsAlerts, navigateAlertRoute, opsAlertSourceLabel, type OpsAlertGroup } from "../../util/ops-alerts";
import { usePopoverDismiss } from "./usePopoverDismiss";

// 상단바 알림 벨 — 운영 알림(그룹)과 운영 전환 준비 차단을 한 진입점으로 모은다(T1).
// env 옆 상시 빨간 "차단" 칩을 대체: 신호는 사라지지 않고 벨 배지·레이블로 옮긴다(조용한 은폐 금지).
// F4 §4.3: 클릭 즉시 이동을 드롭다운 미리보기로 대체 — readiness 차단 1행 + 그룹 상위 5행(severity 내림차순)
// + "알림 센터에서 모두 보기". 닫힘 규약은 usePopoverDismiss(GlobalCreateMenu 와 공유).

function readinessBlockerCount(readiness: ProductionReadiness | undefined): number {
  if (readiness === undefined) return 0;
  if (readiness.status === "blocked" || readiness.summary.blocker_count > 0) {
    return Math.max(readiness.summary.blocker_count, 1);
  }
  return 0;
}

const SEVERITY_RANK: Record<OpsAlertItem["severity"], number> = { critical: 2, warning: 1, info: 0 };

function topGroupsBySeverity(groups: readonly OpsAlertGroup[]): OpsAlertGroup[] {
  return [...groups]
    .sort((a, b) => SEVERITY_RANK[b.representative.severity] - SEVERITY_RANK[a.representative.severity])
    .slice(0, 5);
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
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);
  const { onKeyDown } = usePopoverDismiss({ open, onClose: close, rootRef, triggerRef });
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
  const topGroups = topGroupsBySeverity(groups);
  const goTo = (move: () => void): void => {
    close();
    move();
  };
  return (
    <span ref={rootRef} className="topbar-alert-bell" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="btn icon-btn alert-bell-trigger"
        aria-label={`알림 — ${summary}`}
        title={`${summary} — 알림 미리보기 열기`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <Bell size={16} aria-hidden="true" />
        {badgeCount > 0 && (
          <span className={`alert-bell-count ${tone}`} aria-hidden="true">
            {badgeCount > 9 ? "9+" : String(badgeCount)}
          </span>
        )}
      </button>
      {open && (
        <div id={menuId} className="alert-bell-popover" role="menu" aria-label="알림 미리보기">
          {blockerCount > 0 && (
            <button
              type="button"
              role="menuitem"
              className="alert-bell-item"
              onClick={() => goTo(() => navigate("automationOps", { section: "readiness" }))}
            >
              <span className="alert-bell-item-copy">
                <strong>운영 전환 준비 차단 {blockerCount}건</strong>
                <small>운영 준비 화면에서 차단 사유 확인</small>
              </span>
            </button>
          )}
          {alerts.isError && (
            <div role="menuitem" aria-disabled="true" className="alert-bell-note">
              운영 알림을 확인할 수 없습니다.
            </div>
          )}
          {!alerts.isError && alerts.data === undefined && (
            <div role="menuitem" aria-disabled="true" className="alert-bell-note">
              운영 알림 확인 중…
            </div>
          )}
          {topGroups.map(({ representative, count }) => (
            <button
              key={representative.alert_id}
              type="button"
              role="menuitem"
              className="alert-bell-item"
              onClick={() =>
                goTo(() => {
                  const route = representative.route;
                  if (route !== null && route.trim().length > 0) navigateAlertRoute(route);
                  else navigate("automationOps", { section: "alerts" });
                })
              }
            >
              <span className="alert-bell-item-copy">
                <strong>
                  {representative.title}
                  {count > 1 && <span className="badge muted">외 {count - 1}건</span>}
                </strong>
                <small>{opsAlertSourceLabel(representative.source)}</small>
              </span>
            </button>
          ))}
          {alerts.data !== undefined && topGroups.length === 0 && blockerCount === 0 && (
            <div role="menuitem" aria-disabled="true" className="alert-bell-note">
              새 알림이 없습니다.
            </div>
          )}
          <button
            type="button"
            role="menuitem"
            className="alert-bell-more"
            onClick={() => goTo(() => navigate("automationOps", { section: "alerts" }))}
          >
            알림 센터에서 모두 보기 →
          </button>
        </div>
      )}
    </span>
  );
}
