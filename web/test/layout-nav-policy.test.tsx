import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import { fakeClient } from "./fake-client";

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

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

function navItemCount(nav: HTMLElement): number {
  return nav.querySelectorAll(".nav-item").length;
}

describe("layout nav policy", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    location.hash = "";
    localStorage.removeItem("rpa.nav.mode");
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  test("operator standard nav hides advanced and admin surfaces", () => {
    renderApp();
    const nav = screen.getByRole("navigation", { name: "주 메뉴" });
    expect(navItemCount(nav)).toBe(10);
    for (const label of ["내 할 일", "RPA 운영 대시보드", "사람 확인", "작업 목록", "자동화 만들기", "테스트 실행", "실행 기록", "실행 예약·알림", "문서 자동화"]) {
      expect(within(nav).getByRole("button", { name: label })).toBeInTheDocument();
    }
    for (const hidden of ["Product-open 점검", "중복 방지", "보안/개인정보", "AI 모델 설정", "자동화 검사"]) {
      expect(within(nav).queryByRole("button", { name: hidden })).toBeNull();
    }
  });

  test("operator advanced mode adds allowed expert tools only", () => {
    renderApp();
    const nav = screen.getByRole("navigation", { name: "주 메뉴" });
    fireEvent.click(within(nav).getByRole("button", { name: "고급" }));
    expect(within(nav).getByRole("button", { name: "자동화 검사" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "중복 방지" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "커넥터/템플릿" })).toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: "Product-open 점검" })).toBeNull();
    expect(within(nav).queryByRole("button", { name: "보안/개인정보" })).toBeNull();
  });

  test("admin nav keeps management screens accessible", () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    renderApp();
    const nav = screen.getByRole("navigation", { name: "주 메뉴" });
    for (const label of ["보안/개인정보", "AI 모델 설정", "업무 발굴/ROI", "커넥터/템플릿", "화면 요소 저장소", "자동화 검사", "중복 방지"]) {
      expect(within(nav).getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(within(nav).queryByRole("button", { name: "Product-open 점검" })).toBeNull();
  });

  test("hidden direct URL still renders the view without adding it to nav", () => {
    location.hash = "#idempotency";
    renderApp();
    expect(screen.getByRole("heading", { level: 1, name: "중복 방지" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "주 메뉴" });
    expect(within(nav).queryByRole("button", { name: "중복 방지" })).toBeNull();
    expect(location.hash).toBe("#idempotency");
  });
});
