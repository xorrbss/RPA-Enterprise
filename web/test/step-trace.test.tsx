import { beforeEach, describe, expect, test } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { fakeClient } from "./fake-client";

function renderApp(client: ApiClient = fakeClient()): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>
        <App />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

// 실행 상세 패널을 열어 단계 트레이스를 마운트.
async function openDetail(): Promise<void> {
  location.hash = "#runTrace";
  (await screen.findByRole("button", { name: "상세" })).click();
}

describe("단계 트레이스 — 셀프힐링 서사 (B)", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", "test-token");
  });

  // B1/B3 — 보이는 신호로 'AI가 무엇을·어떤 모델로' 구성(데이터에 없는 값 미창작).
  test("B3: 카드 기본 보기 — 동작 한국어 라벨 + AI 모델·토큰·비용·첫응답", async () => {
    renderApp();
    await openDetail();
    await waitFor(() => expect(screen.getByText("데이터 추출")).toBeInTheDocument()); // extract
    expect(screen.getByText("페이지 이동")).toBeInTheDocument(); // navigate
    expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument();
    expect(screen.getByText("입력 500 · 출력 200 토큰")).toBeInTheDocument();
    expect(screen.getByText("$0.001234")).toBeInTheDocument();
    expect(screen.getByText("첫응답 120ms")).toBeInTheDocument();
    expect(screen.getByText("규칙 기반 단계 (AI 미사용)")).toBeInTheDocument(); // stagehand 없는 단계
  });

  // A5/B — 캐시 모드 한국어 라벨.
  test("B: 캐시 모드가 한국어 라벨로 표시", async () => {
    renderApp();
    await openDetail();
    await waitFor(() => expect(screen.getByText("캐시 재사용")).toBeInTheDocument()); // hit
    expect(screen.getByText("캐시 미사용")).toBeInTheDocument(); // bypass
  });

  // B2 — 소요시간 상대 길이 바 + 정확한 ms 동시 노출(조용한 false 금지).
  test("B2: 소요시간 바(시각) + ms 텍스트", async () => {
    renderApp();
    await openDetail();
    await waitFor(() => expect(screen.getByText("1200ms")).toBeInTheDocument());
    expect(screen.getByText("820ms")).toBeInTheDocument();
    expect(document.querySelector(".dur-fill")).not.toBeNull(); // 시각 바 존재
  });

  // B3 — 셀프힐링: attempt>0을 회색 꼬리표가 아니라 '재시도 N회차' 신호로 격상 + 예외 코드 노출.
  test("B3: 재시도(attempt>0) → '재시도 N회차' 칩 + 실패 단계 예외 코드", async () => {
    renderApp(
      fakeClient({
        listRunSteps: async () => ({
          items: [
            { step_id: "x", node_id: "find_login", attempt: 0, action: "observe", status: "failed_system", cache_mode: "miss", artifact_ids: [], stagehand_calls: [{ model: "gpt-4o-mini", transport: "sse", stream_status: "error", ttfb_ms: 90, input_tokens: 300, output_tokens: 0, cost: "0.0005" }], started_at: null, ended_at: null, duration_ms: 500, exception: { class: "system", code: "DOM_ELEMENT_NOT_FOUND" } },
            { step_id: "x", node_id: "find_login", attempt: 1, action: "observe", status: "success", cache_mode: "miss", artifact_ids: [], stagehand_calls: [{ model: "gpt-4o-mini", transport: "sse", stream_status: "done", ttfb_ms: 110, input_tokens: 320, output_tokens: 40, cost: "0.0007" }], started_at: null, ended_at: null, duration_ms: 700, exception: null },
          ],
          next_cursor: null,
        }),
      }),
    );
    await openDetail();
    await waitFor(() => expect(screen.getByText("재시도 1회차")).toBeInTheDocument());
    expect(screen.getByText("DOM_ELEMENT_NOT_FOUND")).toBeInTheDocument(); // 실패 시도의 예외 코드
  });

  // B4 — 카드(서사) ↔ 표(밀집) 토글.
  test("B4: 카드 기본 + 표 토글", async () => {
    renderApp();
    await openDetail();
    const cards = await screen.findByRole("button", { name: "카드" });
    const table = screen.getByRole("button", { name: "표" });
    expect(cards).toHaveAttribute("aria-pressed", "true"); // 기본 = 카드
    expect(table).toHaveAttribute("aria-pressed", "false");
    table.click();
    await waitFor(() => expect(screen.getByText("AI(모델·출력토큰)")).toBeInTheDocument()); // 표 전용 헤더
    expect(screen.getByRole("button", { name: "표" })).toHaveAttribute("aria-pressed", "true");
  });
});
