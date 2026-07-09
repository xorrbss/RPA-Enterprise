import { describe, expect, test } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { fakeClient } from "./fake-client";

function jwt(sub: string, roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub, tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

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

describe("layout subject chip", () => {
  // T1: 계정·역할 칩은 상단바 직접 노출 → 계정 팝오버로 이동. 기본은 숨김, 팝오버를 열어 확인한다.
  function openAccountMenu(): void {
    fireEvent.click(screen.getByRole("button", { name: "계정 메뉴" }));
  }

  test("shows the current account identifier in the account popover", () => {
    localStorage.setItem("rpa.token", jwt("auth0|alice", ["operator"]));
    location.hash = "#dashboard";

    renderApp();
    expect(screen.queryByLabelText("현재 접속 계정 auth0|alice")).toBeNull();
    openAccountMenu();

    expect(screen.getByLabelText("현재 접속 계정 auth0|alice")).toBeInTheDocument();
    expect(screen.getByText("auth0|alice")).toBeInTheDocument();
  });

  test("keeps long account identifiers available while showing a compact label", () => {
    const subject = "00000000-0000-0000-0000-000000000000";
    localStorage.setItem("rpa.token", jwt(subject, ["operator"]));
    location.hash = "#dashboard";

    renderApp();
    openAccountMenu();

    const chip = screen.getByLabelText(`현재 접속 계정 ${subject}`);
    expect(chip).toHaveAttribute("title", `현재 접속 계정 ${subject}`);
    expect(screen.getByText("...000000000000")).toBeInTheDocument();
    expect(screen.queryByText(subject)).toBeNull();
  });

  test("shows tenant/environment neutrally (no readiness status chip) and links to readiness", async () => {
    localStorage.setItem("rpa.token", jwt("auth0|alice", ["operator"]));
    location.hash = "#automationOps?section=schedule";

    renderApp();

    // fake readiness는 blocked(blocker_count 2)지만 컨텍스트 배지는 중립이어야 한다 —
    // "차단"이 env 옆에 붙으면 환경 전체 차단으로 오독(감사 P0-2). 신호는 알림 벨이 담당.
    const badge = await screen.findByRole("button", { name: /tenant\/environment 컨텍스트: tenant tenant-a, environment 통제 운영/ });
    expect(badge).not.toHaveClass("red");
    expect(badge).not.toHaveClass("amber");
    expect(within(badge).getByText("tenant-a")).toBeInTheDocument();
    expect(within(badge).getByText("통제 운영")).toBeInTheDocument();
    expect(within(badge).queryByText("차단")).toBeNull();

    fireEvent.click(badge);

    expect(location.hash).toBe("#automationOps?section=readiness");
  });

  test("fails closed when tenant/environment context cannot be confirmed", async () => {
    localStorage.setItem("rpa.token", jwt("auth0|alice", ["operator"]));
    location.hash = "#dashboard";

    renderApp(fakeClient({ getProductionReadiness: async () => { throw new Error("readiness unavailable"); } }));

    const badge = await screen.findByRole("button", { name: /tenant\/environment 컨텍스트 컨텍스트 미확인/ });
    expect(badge).toHaveClass("topbar-context-badge", "red");
    expect(badge).not.toHaveClass("green");
    expect(within(badge).getAllByText("미확인").length).toBeGreaterThanOrEqual(2);
    expect(within(badge).getByText("컨텍스트 미확인")).toBeInTheDocument();
  });
});
