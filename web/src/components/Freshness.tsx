import { useIsFetching, useQueryClient } from "@tanstack/react-query";

import { hhmmss } from "../util/time";

// 실시간 표시 + 라우트/폴링 진행 바 — rpa_enterprise_console.html Phase 5 패턴 이식.
// 진행은 react-query 활성 fetch 수(관찰값)로, '성공-관찰 시각'은 query cache의 success 쿼리 dataUpdatedAt 최대값으로 도출.
// dataUpdatedAt은 성공 fetch에만 기록되므로(TraceFreshness가 이미 신뢰원천으로 사용), 에러로 끝난 폴링이 '방금 갱신'으로
// 거짓 안심을 주던 조용한 false를 차단한다. 성공 관찰 0이면 녹색 live-dot/'실시간' 단정 없이 중립 도트+중립 문구.

// query cache 전체에서 status==="success"인 쿼리의 dataUpdatedAt 최대값(성공 관찰 0이면 0).
function maxSuccessAt(qc: ReturnType<typeof useQueryClient>): number {
  let max = 0;
  for (const q of qc.getQueryCache().getAll()) {
    if (q.state.status === "success" && q.state.dataUpdatedAt > max) max = q.state.dataUpdatedAt;
  }
  return max;
}

export function Freshness(): JSX.Element {
  const fetching = useIsFetching();
  const qc = useQueryClient();
  // useIsFetching가 fetch 시작/완료 시 rerender를 보장하므로, query cache 직접 구독 없이 성공 시각만 읽는다.
  // 직접 구독은 다른 컴포넌트 렌더 중 cache 알림이 들어올 때 React 경고를 만들 수 있다.
  const lastSuccessAt = maxSuccessAt(qc);
  return (
    <>
      <div className={`route-progress${fetching > 0 ? " active" : ""}`} aria-hidden="true" />
      <span className="freshness" role="status" aria-live="polite">
        {fetching > 0 ? (
          <>
            <span className="now-dot" aria-hidden="true" /> 갱신 중…
          </>
        ) : lastSuccessAt > 0 ? (
          <>
            <span className="live-dot" aria-hidden="true" /> 방금 갱신 {hhmmss(new Date(lastSuccessAt))}
          </>
        ) : (
          <>
            <span className="now-dot" aria-hidden="true" /> 연결 확인 중…
          </>
        )}
      </span>
    </>
  );
}
