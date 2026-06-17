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
    expect(screen.getByText("입력 ≥500 · 출력 ≥200 토큰")).toBeInTheDocument(); // 2번째 호출 토큰 null → 합계를 총계 아닌 하한(≥)으로
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

  // P0-2 "한눈에": 단계 기록에서 관찰된 복구 신호(재시도·캐시 재생·비정상 응답 종료)를 상단에 집계.
  test("P0-2: 자동 복구 요약 배너 — 다시 시도 · 캐시 계획 재생 · 비정상 응답 종료", async () => {
    renderApp(
      fakeClient({
        listRunSteps: async () => ({
          items: [
            { step_id: "a", node_id: "n0", attempt: 0, action: "observe", status: "failed_system", cache_mode: "miss", artifact_ids: [], stagehand_calls: [{ model: "gpt-4o-mini", transport: "sse", stream_status: "error", ttfb_ms: null, input_tokens: null, output_tokens: null, cost: null }], started_at: null, ended_at: null, duration_ms: 100, exception: { class: "system", code: "GATEWAY_STREAM_ABORTED" } },
            { step_id: "a", node_id: "n0", attempt: 1, action: "observe", status: "success", cache_mode: "miss", artifact_ids: [], stagehand_calls: [{ model: "gpt-4o-mini", transport: "sse", stream_status: "done", ttfb_ms: 100, input_tokens: 10, output_tokens: 5, cost: "0.001" }], started_at: null, ended_at: null, duration_ms: 200, exception: null },
            { step_id: "c", node_id: "click", attempt: 0, action: "act", status: "success", cache_mode: "hit", artifact_ids: [], stagehand_calls: [], started_at: null, ended_at: null, duration_ms: 20, exception: null },
          ],
          next_cursor: null,
        }),
      }),
    );
    await openDetail();
    await waitFor(() =>
      expect(
        screen.getByText((t) => t.includes("관찰된 자동 복구") && t.includes("다시 시도 1개 단계") && t.includes("캐시 계획 재생 1개 단계") && t.includes("비정상 응답 종료 1건")),
      ).toBeInTheDocument(),
    );
  });

  // 신호가 없으면(정상 완료만) 요약 배너를 그리지 않는다(없는 복구를 있는 척하지 않음 — 조용한 false 금지).
  test("P0-2: 복구 신호 없으면 요약 배너 미표시", async () => {
    renderApp(); // 기본 픽스처 — 재시도 0, hit는 호출 있음(재생 아님), stream done
    await openDetail();
    await waitFor(() => expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument());
    expect(screen.queryByText(/관찰된 자동 복구/)).toBeNull();
  });

  // P0-2: 비정상 응답 종료(stream_status)를 카드에 한국어 신호로 노출(정상 종료는 표기하지 않음).
  test("P0-2: stream_status length → '응답 길이 한도로 잘림' 칩", async () => {
    renderApp(
      fakeClient({
        listRunSteps: async () => ({
          items: [{ step_id: "t", node_id: "extract", attempt: 0, action: "extract", status: "success", cache_mode: "miss", artifact_ids: [], stagehand_calls: [{ model: "gpt-4o-mini", transport: "sse", stream_status: "length", ttfb_ms: 90, input_tokens: 100, output_tokens: 512, cost: "0.002" }], started_at: null, ended_at: null, duration_ms: 300, exception: null }],
          next_cursor: null,
        }),
      }),
    );
    await openDetail();
    await waitFor(() => expect(screen.getByText("응답 길이 한도로 잘림")).toBeInTheDocument());
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

  // F1 — 현재 실행 단계 하이라이트(status='started' 파생). 비-터미널 enum은 'started' 하나뿐이므로 마지막 'started' = 현재.
  test("F1: status='started'인 마지막 단계만 .step-card.current로 강조", async () => {
    renderApp(
      fakeClient({
        listRunSteps: async () => ({
          items: [
            { step_id: "s1", node_id: "done_node", attempt: 0, action: "navigate", status: "success", cache_mode: "bypass", artifact_ids: [], stagehand_calls: [], started_at: null, ended_at: null, duration_ms: 100, exception: null },
            { step_id: "s2", node_id: "live_node", attempt: 0, action: "observe", status: "started", cache_mode: "miss", artifact_ids: [], stagehand_calls: [], started_at: null, ended_at: null, duration_ms: null, exception: null },
          ],
          next_cursor: null,
        }),
      }),
    );
    await openDetail();
    await waitFor(() => expect(screen.getByText("live_node")).toBeInTheDocument());
    const current = document.querySelectorAll<HTMLElement>(".step-card.current");
    expect(current.length).toBe(1); // 정확히 1개
    expect(current[0]!.textContent).toContain("live_node"); // 그것이 started 단계(s2)
    expect(current[0]!.textContent).not.toContain("done_node"); // s1엔 .current 부재
    expect(screen.getByText("진행 중")).toBeInTheDocument(); // '진행 중' 칩
  });

  // F1 회귀(거짓 현재단계): 같은 step_id가 재시도로 여러 행일 때, 종료된 이전 attempt 행을 '현재'로 강조하면 안 된다.
  // attempt0=failed_system(터미널) + attempt1=started(라이브) → started 행 정확히 1개만 .current/'진행 중'.
  test("F1: 동일 step_id 재시도 — 종료된 attempt0 아닌 started attempt1만 .current(거짓 현재단계 금지)", async () => {
    renderApp(
      fakeClient({
        listRunSteps: async () => ({
          items: [
            { step_id: "x", node_id: "find_login", attempt: 0, action: "observe", status: "failed_system", cache_mode: "miss", artifact_ids: [], stagehand_calls: [], started_at: null, ended_at: null, duration_ms: 500, exception: { class: "system", code: "DOM_ELEMENT_NOT_FOUND" } },
            { step_id: "x", node_id: "find_login", attempt: 1, action: "observe", status: "started", cache_mode: "miss", artifact_ids: [], stagehand_calls: [], started_at: null, ended_at: null, duration_ms: null, exception: null },
          ],
          next_cursor: null,
        }),
      }),
    );
    await openDetail();
    await waitFor(() => expect(screen.getByText("DOM_ELEMENT_NOT_FOUND")).toBeInTheDocument()); // 두 행 모두 마운트됨
    const current = document.querySelectorAll<HTMLElement>(".step-card.current");
    expect(current.length).toBe(1); // 정확히 1개(종료된 attempt0까지 강조하지 않음)
    expect(current[0]!.textContent).toContain("재시도 1회차"); // 그것이 attempt1(started) 행
    expect(current[0]!.textContent).not.toContain("DOM_ELEMENT_NOT_FOUND"); // 실패한 attempt0 카드엔 .current 부재
    expect(screen.queryAllByText("진행 중")).toHaveLength(1); // '진행 중' 칩도 정확히 1개
  });

  // F1 핵심 가드(silent-false): 모든 단계가 종료(started 없음)면 현재단계를 만들지 않는다 — run이 running이어도.
  test("F1: started 단계가 없으면 .current 강조 0(거짓 현재단계 금지)", async () => {
    renderApp(); // 기본 픽스처 — 전부 status:'success'
    await openDetail();
    await waitFor(() => expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument());
    expect(document.querySelectorAll(".step-card.current").length).toBe(0);
    expect(screen.queryByText("진행 중")).toBeNull();
  });

  // F2 — 관찰된 단계 수만 표기. 총 단계수/진행%는 분모가 API에 없으므로 만들지 않는다(창작 금지 가드).
  test("F2: '관찰된 N개 단계' 표기 + 진행%/총단계 텍스트 부재", async () => {
    renderApp(); // 기본 픽스처 2단계
    await openDetail();
    await waitFor(() => expect(screen.getByText("관찰된 2개 단계")).toBeInTheDocument());
    expect(screen.queryByText(/진행률|%|총\s*\d+\s*단계/)).toBeNull();
  });

  // F2 절단 정직성(Dashboard.pageCount와 동일 규율): next_cursor가 남으면 페이지 길이를 총계처럼 보이지 않게 `N+`로.
  test("F2: next_cursor 있으면 '관찰된 N+개 단계'(미공개 절단 방지)", async () => {
    renderApp(
      fakeClient({
        listRunSteps: async () => ({
          items: [{ step_id: "a", node_id: "n", attempt: 0, action: "act", status: "success", cache_mode: "miss", artifact_ids: [], stagehand_calls: [], started_at: null, ended_at: null, duration_ms: 10, exception: null }],
          next_cursor: "cur-2", // 더 있음
        }),
      }),
    );
    await openDetail();
    await waitFor(() => expect(screen.getByText("관찰된 1+개 단계")).toBeInTheDocument());
    expect(screen.queryByText("관찰된 1개 단계")).toBeNull(); // 총계처럼 보이는 정확수 표기 아님
  });

  // F2 — 트레이스-로컬 라이브(갱신) 인디케이터가 패널에 마운트된다(폴링 사실 표시).
  test("F2: 트레이스 패널에 freshness role=status 라이브 표시 존재", async () => {
    renderApp();
    await openDetail();
    await waitFor(() => expect(screen.getByText("관찰된 2개 단계")).toBeInTheDocument());
    const freshness = document.querySelectorAll(".freshness[role='status']");
    // 전역 topbar 1개 + 트레이스-로컬 1개 → 최소 2개(패널 신호가 추가로 마운트됨).
    expect(freshness.length).toBeGreaterThanOrEqual(2);
  });
});
