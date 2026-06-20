import { describe, expect, test, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { axe } from "vitest-axe";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { navigate, type ViewKey } from "../src/router";
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

// color-contrast는 jsdom(레이아웃/렌더 없음)에서 산출 불가라 비활성. 나머지 구조/aria/라벨 규칙은 적용.
const AXE_OPTS = { rules: { "color-contrast": { enabled: false } } };

describe("D7 운영 콘솔 a11y (axe)", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", "test-token"); // TokenGate 통과
  });

  test("대시보드 axe 위반 없음", async () => {
    renderApp();
    await waitFor(() => expect(screen.getByText("최근 실행")).toBeInTheDocument());
    const results = await axe(document.body, AXE_OPTS);
    expect(results).toHaveNoViolations();
  });

  // 빈 테넌트(실행 0건) → OnboardingBanner 마운트 상태에서 axe 스캔(신규 role='status'/CTA 표면).
  test("빈 테넌트 대시보드(온보딩 배너) axe 위반 없음", async () => {
    const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles: ["operator"] })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    localStorage.setItem("rpa.token", `e30.${payload}.sig`);
    renderApp(fakeClient({ listRuns: async () => ({ items: [], next_cursor: null }) }));
    await waitFor(() => expect(screen.getByText("첫 실행을 시작해 보세요.")).toBeInTheDocument());
    const results = await axe(document.body, AXE_OPTS);
    expect(results).toHaveNoViolations();
  });

  test("확인 다이얼로그 열림 시 axe 위반 없음 (role=dialog)", async () => {
    // 명령 버튼 표시를 위해 roles JWT 주입(useCan은 토큰 roles를 읽어 게이팅).
    const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles: ["operator"] })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    localStorage.setItem("rpa.token", `e30.${payload}.sig`);
    renderApp();
    navigate("runTrace");
    (await screen.findByRole("button", { name: "취소" })).click();
    await screen.findByRole("dialog");
    const results = await axe(document.body, AXE_OPTS);
    expect(results).toHaveNoViolations();
  });

  // 비모달 사이드 드로어(SlideOver) 열림 상태 — role=region + tabIndex=-1(포커스 진입용) aria 회귀 없음 확인.
  test("작업항목 상세 드로어(SlideOver) 열림 시 axe 위반 없음", async () => {
    renderApp(
      fakeClient({
        listWorkitems: async () => ({
          items: [{ workitem_id: "wi-abc12345", status: "processing", unique_reference: "ref", attempts: 1, checked_out_by: null, checked_out_at: null, run_id: null }],
          next_cursor: null,
        }),
      }),
    );
    navigate("workitems");
    (await screen.findByRole("button", { name: "상세" })).click();
    await screen.findByRole("region", { name: "작업항목 상세" });
    expect(await axe(document.body, AXE_OPTS)).toHaveNoViolations();
  });

  for (const view of ["workitems", "humanTasks", "runTrace", "security", "scenarioStudio", "playground", "approvalInbox"] as ViewKey[]) {
    test(`${view} 뷰 axe 위반 없음`, async () => {
      renderApp();
      navigate(view);
      await waitFor(() => expect(screen.getByRole("main")).toBeInTheDocument());
      // 쿼리 resolve(빈/데이터 상태)까지 대기
      await waitFor(() => expect(document.querySelector(".skeleton")).toBeNull());
      const results = await axe(document.body, AXE_OPTS);
      expect(results).toHaveNoViolations();
    });
  }

  // StepTrace(단계 트레이스)는 run 선택 시에만 마운트 — 카드/표 두 보기 모두 axe 스캔(가장 복잡한 신규 a11y 표면).
  test("실행 상세 단계 트레이스(카드+표) axe 위반 없음", async () => {
    renderApp();
    location.hash = "#runTrace";
    (await screen.findByRole("button", { name: "상세" })).click();
    await screen.findByRole("button", { name: "카드" }); // 카드 보기 마운트 대기
    expect(await axe(document.body, AXE_OPTS)).toHaveNoViolations();
    (await screen.findByRole("button", { name: "표" })).click();
    await waitFor(() => expect(screen.getByText("AI(모델·출력토큰)")).toBeInTheDocument());
    expect(await axe(document.body, AXE_OPTS)).toHaveNoViolations();
  });
});
