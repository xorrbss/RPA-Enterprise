import { describe, expect, test, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { axe } from "vitest-axe";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import { navigate, type ViewKey } from "../src/router";
import { fakeClient } from "./fake-client";

function renderApp(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={fakeClient()}>
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
  });

  test("대시보드 axe 위반 없음", async () => {
    renderApp();
    await waitFor(() => expect(screen.getByText("최근 실행")).toBeInTheDocument());
    const results = await axe(document.body, AXE_OPTS);
    expect(results).toHaveNoViolations();
  });

  for (const view of ["workitems", "humanTasks", "runTrace", "security", "scenarioStudio"] as ViewKey[]) {
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
});
