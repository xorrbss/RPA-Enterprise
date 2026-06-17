import { useIsFetching } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { hhmmss } from "../util/time";

// 실시간 표시 + 라우트/폴링 진행 바 — rpa_enterprise_console.html Phase 5 패턴 이식.
// react-query 활성 fetch 수로 진행 상태를 도출하고, idle 전환 시 '마지막 갱신' 시각을 기록.

export function Freshness(): JSX.Element {
  const fetching = useIsFetching();
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const prev = useRef(fetching);
  useEffect(() => {
    if (prev.current > 0 && fetching === 0) setUpdatedAt(hhmmss(new Date()));
    prev.current = fetching;
  }, [fetching]);
  return (
    <>
      <div className={`route-progress${fetching > 0 ? " active" : ""}`} aria-hidden="true" />
      <span className="freshness" role="status" aria-live="polite">
        <span className="live-dot" aria-hidden="true" />
        {fetching > 0 ? "갱신 중…" : updatedAt !== null ? `방금 갱신 ${updatedAt}` : "실시간 폴링"}
      </span>
    </>
  );
}
