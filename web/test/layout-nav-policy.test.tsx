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
    expect(navItemCount(nav)).toBe(11);
    for (const label of ["내 할 일", "RPA 운영 대시보드", "도입 증빙", "사람 확인", "작업 목록", "만들기 콘솔", "자동화 스튜디오", "실행 기록", "실행 예약·알림", "문서 자동화"]) {
      expect(within(nav).getByRole("button", { name: label })).toBeInTheDocument();
    }
    for (const hidden of ["Product-open 점검", "중복 방지", "보안/개인정보", "AI 모델 설정", "자동화 검사"]) {
      expect(within(nav).queryByRole("button", { name: hidden })).toBeNull();
    }
  });

  test("operator global create menu exposes creation, template, test, schedule, and setup starts", () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: /새로 만들기/ }));

    const menu = screen.getByRole("menu", { name: "새로 만들기" });
    expect(within(menu).getByRole("menuitem", { name: /자동화 만들기/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /템플릿에서 시작/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /테스트 실행/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /운영 예약/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /사이트\/세션 등록/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /증빙 확인/ })).toBeInTheDocument();

    fireEvent.click(within(menu).getByRole("menuitem", { name: /테스트 실행/ }));

    expect(location.hash).toBe("#create?focus=test");
    expect(screen.queryByRole("menu", { name: "새로 만들기" })).toBeNull();
  });

  test("global create schedule item deep links to the schedule section", () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: /새로 만들기/ }));

    fireEvent.click(within(screen.getByRole("menu", { name: "새로 만들기" })).getByRole("menuitem", { name: /운영 예약/ }));

    expect(location.hash).toBe("#automationOps?section=schedule");
    expect(screen.queryByRole("menu", { name: "새로 만들기" })).toBeNull();
  });

  test("global create menu closes on Escape with focus restored and outside clicks", () => {
    renderApp();
    const trigger = screen.getByRole("button", { name: /새로 만들기/ });

    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu", { name: "새로 만들기" }), { key: "Escape" });

    expect(screen.queryByRole("menu", { name: "새로 만들기" })).toBeNull();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "새로 만들기" })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("menu", { name: "새로 만들기" })).toBeNull();
  });

  test("viewer quick start does not expose write actions", () => {
    localStorage.setItem("rpa.token", jwt(["viewer"]));
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: /새로 만들기/ }));

    const menu = screen.getByRole("menu", { name: "새로 만들기" });
    expect(within(menu).queryByRole("menuitem", { name: /자동화 만들기/ })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /템플릿에서 시작/ })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /테스트 실행/ })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /운영 예약/ })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /사이트\/세션 등록/ })).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /증빙 확인/ }));

    expect(location.hash).toBe("#adoptionEvidence");
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
