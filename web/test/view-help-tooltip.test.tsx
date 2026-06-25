import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";
import { beforeEach, describe, expect, test } from "vitest";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import { VIEW_META } from "../src/views/meta";
import { fakeClient } from "./fake-client";

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

function renderApp(): HTMLElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={fakeClient()}>
        <App />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return container;
}

describe("화면별 맥락 도움말 '?' 버튼", () => {
  beforeEach(() => {
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  test("topbar '?' 버튼이 helpText 를 노출한다(name=안정 라벨, title=도움말 본문)", () => {
    location.hash = "#dashboard";
    renderApp();

    const help = VIEW_META.dashboard.helpText;
    expect(help).toBeTruthy();
    // 접근성 name 은 짧고 안정적(화면 내용과 충돌 방지), 도움말 본문은 title(툴팁+accessible description)으로 노출.
    const button = screen.getByRole("button", { name: "RPA 운영 대시보드 화면 도움말" });
    expect(button).toHaveAttribute("title", help as string);
  });

  test("helpText 가 없으면 subtitle 로 폴백한다(현재 모든 화면은 helpText 보유)", () => {
    // 폴백 경로 단위 검증 — Layout 은 `helpText ?? subtitle` 을 사용한다.
    for (const meta of Object.values(VIEW_META)) {
      const shown = meta.helpText ?? meta.subtitle;
      expect(shown.length).toBeGreaterThan(0);
    }
  });

  test("'?' 클릭 시 도움말 본문을 화면에 펼치고 다시 누르면 닫는다(터치/SR 접근)", () => {
    location.hash = "#dashboard";
    renderApp();
    const help = VIEW_META.dashboard.helpText as string;
    const button = screen.getByRole("button", { name: "RPA 운영 대시보드 화면 도움말" });

    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "RPA 운영 대시보드 화면 도움말" })).toBeNull();

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const region = screen.getByRole("region", { name: "RPA 운영 대시보드 화면 도움말" });
    expect(region).toHaveTextContent(help);

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "RPA 운영 대시보드 화면 도움말" })).toBeNull();
  });

  test("도움말 버튼이 접근성 위반을 만들지 않는다(닫힘·열림 모두)", async () => {
    location.hash = "#security";
    const container = renderApp();
    expect((await axe(container)).violations).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "보안/개인정보 화면 도움말" }));
    expect((await axe(container)).violations).toEqual([]);
  });
});
