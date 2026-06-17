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
    expect(screen.getByText("$0.001234")).toBeInTheDocument(); // 원본 cost 문자열 그대로(toFixed 가공 없음)
    expect(screen.getByText("첫응답 120ms")).toBeInTheDocument();
    expect(screen.getByText("AI 호출 없음")).toBeInTheDocument(); // stagehand 없는 bypass 단계(과거 '규칙 기반' 오표기 수정)
  });

  // 캐시 hit + 호출 0 = AI가 도출한 plan 재생 → 'AI 미사용'으로 단정하지 않음(silent false 수정).
  test("B: 캐시 hit + 호출 0 → '캐시된 계획 재생'(AI 미사용 단정 금지)", async () => {
    renderApp(
      fakeClient({
        listRunSteps: async () => ({
          items: [{ step_id: "h", node_id: "click_next", attempt: 0, action: "act", status: "success", cache_mode: "hit", artifact_ids: [], stagehand_calls: [], started_at: null, ended_at: null, duration_ms: 30, exception: null }],
          next_cursor: null,
        }),
      }),
    );
    await openDetail();
    await waitFor(() => expect(screen.getByText(/캐시된 계획 재생/)).toBeInTheDocument());
    expect(screen.queryByText("AI 호출 없음")).toBeNull(); // hit 단계는 '호출 없음' 단독 표기 아님
  });

  // 토큰/비용 정직성: 다건 호출은 비용을 정밀도-보존 합산(toFixed 거짓 0/허위정밀 금지), 첫응답은 단일 호출만.
  test("B: 다건 stagehand 호출 — 비용 합산 + 첫응답 미표기", async () => {
    renderApp(
      fakeClient({
        listRunSteps: async () => ({
          items: [{
            step_id: "m", node_id: "extract", attempt: 0, action: "extract", status: "success", cache_mode: "miss", artifact_ids: [],
            stagehand_calls: [
              { model: "gpt-4o-mini", transport: "sse", stream_status: "done", ttfb_ms: 120, input_tokens: 500, output_tokens: 200, cost: "0.002" },
              { model: "gpt-4o", transport: "sse", stream_status: "done", ttfb_ms: null, input_tokens: null, output_tokens: null, cost: "0.0005" },
            ],
            started_at: null, ended_at: null, duration_ms: 1500, exception: null,
          }],
          next_cursor: null,
        }),
      }),
    );
    await openDetail();
    await waitFor(() => expect(screen.getByText("gpt-4o-mini, gpt-4o (2회 호출)")).toBeInTheDocument());
    expect(screen.getByText("$0.0025")).toBeInTheDocument(); // 0.002 + 0.0005, 허위정밀(toFixed 6) 없이
    expect(screen.queryByText(/첫응답/)).toBeNull(); // 다건은 단일 ttfb 단정 안 함
  });

  // 토큰 전부 null(usage 미수신) → '0 토큰'으로 거짓표기하지 않고 토큰 span 자체 생략.
  test("B: 토큰 전부 미보고 → '0 토큰' 거짓표기 금지(span 생략)", async () => {
    renderApp(
      fakeClient({
        listRunSteps: async () => ({
          items: [{
            step_id: "n", node_id: "observe", attempt: 0, action: "observe", status: "failed_system", cache_mode: "miss", artifact_ids: [],
            stagehand_calls: [{ model: "gpt-4o-mini", transport: "sse", stream_status: "error", ttfb_ms: null, input_tokens: null, output_tokens: null, cost: null }],
            started_at: null, ended_at: null, duration_ms: 200, exception: { class: "system", code: "GATEWAY_STREAM_ABORTED" },
          }],
          next_cursor: null,
        }),
      }),
    );
    await openDetail();
    await waitFor(() => expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument());
    expect(screen.queryByText(/토큰/)).toBeNull(); // 입력/출력 모두 null → 토큰 표기 없음
    expect(screen.queryByText(/^\$/)).toBeNull(); // cost null → 비용 칩 없음
  });

  // B2 — 바 길이는 최대 소요 대비 비례(상대), null 소요는 바 없이 '—'.
  test("B2: 바 비례 폭 + null 소요 '—'(no fill)", async () => {
    renderApp(); // 기본 픽스처 820ms, 1200ms (max=1200)
    await openDetail();
    await waitFor(() => expect(screen.getByText("1200ms")).toBeInTheDocument());
    const fills = document.querySelectorAll<HTMLElement>(".dur-fill");
    expect(fills.length).toBe(2);
    expect(fills[0]!.style.width).toBe("68%"); // 820/1200
    expect(fills[1]!.style.width).toBe("100%"); // 최대
  });

  test("B2: null 소요 단계는 바 없이 '—'", async () => {
    renderApp(
      fakeClient({
        listRunSteps: async () => ({
          items: [
            { step_id: "a", node_id: "n1", attempt: 0, action: "navigate", status: "success", cache_mode: "bypass", artifact_ids: [], stagehand_calls: [], started_at: null, ended_at: null, duration_ms: 1000, exception: null },
            { step_id: "b", node_id: "n2", attempt: 0, action: "navigate", status: "running", cache_mode: "bypass", artifact_ids: [], stagehand_calls: [], started_at: null, ended_at: null, duration_ms: null, exception: null },
          ],
          next_cursor: null,
        }),
      }),
    );
    await openDetail();
    await waitFor(() => expect(screen.getByText("1000ms")).toBeInTheDocument());
    expect(document.querySelectorAll(".dur-fill").length).toBe(1); // null 단계는 fill 없음(no silent false 분기)
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
    expect(screen.queryAllByText(/재시도/)).toHaveLength(1); // attempt:0 성공 단계는 재시도 칩 없음(거짓 신호 금지)
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
