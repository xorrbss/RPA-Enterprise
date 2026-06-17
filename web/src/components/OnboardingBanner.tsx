import { Rocket } from "lucide-react";

import { navigate, type ViewKey } from "../router";

// 빈 첫 화면(실행 0건) 안내 배너 — 순수 표시 컴포넌트. 자체 fetch/상태 없음: 부모(Dashboard)가 실 필드로
// '진짜 빈 테넌트'를 판정한 결과(message + 선택적 cta)만 받아 렌더한다(단방향 의존, 데이터 창작 금지).
// 마크업/색은 기존 .arrival-banner + .badge.blue 톤 재사용(Phase 1 '신규 색 토큰 0' 규칙). role='status'로
// EmptyState/Freshness와 동일 a11y 패턴. cta 유무는 부모의 RBAC(useCan) 판정 결과를 그대로 따른다.
export function OnboardingBanner({
  message,
  cta,
}: {
  message: string;
  cta?: { label: string; view: ViewKey };
}): JSX.Element {
  return (
    <div className="arrival-banner badge blue" role="status">
      <Rocket size={16} aria-hidden="true" />
      <span>{message}</span>
      {cta !== undefined && (
        <button type="button" className="btn primary" onClick={() => navigate(cta.view)}>
          {cta.label}
        </button>
      )}
    </div>
  );
}
