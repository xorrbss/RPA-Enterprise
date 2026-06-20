import { AlertTriangle } from "lucide-react";

// 사이트 서킷 차단 안내(순수 표시) — 부모(Security)가 실제 circuit_status='open' 항목 수를 세어 전달(데이터 창작 금지).
// 사이트 서킷은 조회로만 노출(api-surface §sites: 강제 재개 비노출)이므로, 안내는 '자동 재개'와 '운영 정책'을
// 운영자어로 설명한다 — operatorAction("차단율 대시보드 확인, 윈도우 재개")을 콘솔이 할 수 있는 범위로 번역.
// 마크업/색은 기존 .arrival-banner + .badge.amber 재사용(Phase 1 '신규 색 토큰 0'). role='status'로 a11y 패턴 통일.
export function SiteCircuitNotice({ openCount }: { openCount: number }): JSX.Element | null {
  if (openCount <= 0) return null;
  return (
    <div className="arrival-banner badge amber" role="status">
      <AlertTriangle size={16} aria-hidden="true" />
      <span>
        사이트 {openCount}곳이 일시 차단되었습니다 — 차단율이 임계를 넘어 자동 보호된 상태이며, 잠시 후 다시 시도해 자동으로 재개됩니다.
        강제 재개는 운영 정책이라 콘솔에서 제공하지 않습니다(차단율은 운영 대시보드에서 확인).
      </span>
    </div>
  );
}
