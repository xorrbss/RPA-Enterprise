import { describe, expect, test } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";

import { Freshness } from "../src/components/Freshness";

// R2 — 전역 Freshness 표시 정직화. 진행=useIsFetching(관찰 fetch 수), 성공-관찰 시각=query cache success dataUpdatedAt.
// 에러로 끝난 폴링이 '방금 갱신'으로 거짓 안심 주던 조용한 false 차단 + 성공 관찰 전엔 녹색 live-dot/'실시간' 미단정.

function newQc(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// Freshness 옆에서 쿼리를 마운트해 query cache 상태를 구동(컴포넌트가 cache를 진실원천으로 읽음).
function Probe({ queryKey, queryFn }: { queryKey: string; queryFn: () => Promise<unknown> }): null {
  useQuery({ queryKey: [queryKey], queryFn, retry: false });
  return null;
}

function renderFreshness(qc: QueryClient, probe?: JSX.Element): void {
  render(
    <QueryClientProvider client={qc}>
      {probe}
      <Freshness />
    </QueryClientProvider>,
  );
}

describe("Freshness — 표시 정직성(R2)", () => {
  // (1) 쿼리 0건(성공 관찰 0) → '실시간 폴링'/'방금 갱신' 부재 + 녹색 live-dot 부재(liveness 미단정).
  test("성공 관찰 0 → '실시간'·'방금 갱신' 미단정 + .live-dot 부재", () => {
    renderFreshness(newQc());
    expect(screen.queryByText(/실시간/)).toBeNull();
    expect(screen.queryByText(/방금 갱신/)).toBeNull();
    expect(document.querySelector(".live-dot")).toBeNull();
    expect(screen.getByText(/연결 확인 중/)).toBeInTheDocument();
  });

  // (2) 영원 pending queryFn → useIsFetching>0 → '갱신 중…'(관찰 진행).
  test("진행 중 fetch → '갱신 중…' 노출", async () => {
    const qc = newQc();
    renderFreshness(qc, <Probe queryKey="pending" queryFn={() => new Promise<unknown>(() => {})} />);
    await waitFor(() => expect(screen.getByText(/갱신 중…/)).toBeInTheDocument());
  });

  // (3) 즉시 resolve 쿼리 1건 → dataUpdatedAt 성공시각 관찰 → '방금 갱신' + 녹색 live-dot.
  test("성공 fetch → '방금 갱신' + .live-dot 존재", async () => {
    const qc = newQc();
    renderFreshness(qc, <Probe queryKey="ok" queryFn={async () => ({ ok: true })} />);
    await waitFor(() => expect(screen.getByText(/방금 갱신/)).toBeInTheDocument());
    expect(document.querySelector(".live-dot")).not.toBeNull();
  });

  // (4) reject queryFn(retry:false) → idle 전환되어도 성공 dataUpdatedAt 없음 → '방금 갱신'/.live-dot 미노출.
  // 옛 휴리스틱(idle 전환=갱신됨)이 에러를 '갱신됨'으로 거짓표기하던 조용한 false를 정확히 차단.
  test("에러로 끝난 fetch → '방금 갱신'/.live-dot 미노출(거짓 갱신 차단)", async () => {
    const qc = newQc();
    renderFreshness(qc, <Probe queryKey="bad" queryFn={async () => { throw new Error("boom"); }} />);
    // 폴링이 끝나(idle) '갱신 중…'이 사라질 때까지 대기 — 에러는 dataUpdatedAt을 갱신하지 않음.
    await waitFor(() => expect(screen.queryByText(/갱신 중…/)).toBeNull());
    expect(screen.queryByText(/방금 갱신/)).toBeNull();
    expect(document.querySelector(".live-dot")).toBeNull();
    expect(screen.getByText(/연결 확인 중/)).toBeInTheDocument();
  });

  // (5) 어떤 상태에서도 .freshness[role='status'] 엘리먼트는 1개 존재(step-trace F2의 >=2 의존 구조 보존).
  test("항상 .freshness[role='status'] 1개 렌더(F2 의존 보존)", () => {
    renderFreshness(newQc());
    expect(document.querySelectorAll(".freshness[role='status']").length).toBe(1);
  });
});
