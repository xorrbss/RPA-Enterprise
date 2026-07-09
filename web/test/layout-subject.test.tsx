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
  test("shows the current account identifier", () => {
    localStorage.setItem("rpa.token", jwt("auth0|alice", ["operator"]));
    location.hash = "#dashboard";

    renderApp();

    expect(screen.getByLabelText("현재 접속 계정 auth0|alice")).toBeInTheDocument();
    expect(screen.getByText("auth0|alice")).toBeInTheDocument();
  });

  test("keeps long account identifiers available while showing a compact label", () => {
    const subject = "00000000-0000-0000-0000-000000000000";
    localStorage.setItem("rpa.token", jwt(subject, ["operator"]));
    location.hash = "#dashboard";

    renderApp();

    const chip = screen.getByLabelText(`현재 접속 계정 ${subject}`);
    expect(chip).toHaveAttribute("title", `현재 접속 계정 ${subject}`);
    expect(screen.getByText("...000000000000")).toBeInTheDocument();
    expect(screen.queryByText(subject)).toBeNull();
  });

  test("shows tenant/environment from production readiness and links to readiness", async () => {
    localStorage.setItem("rpa.token", jwt("auth0|alice", ["operator"]));
    location.hash = "#automationOps?section=schedule";

    renderApp();

    const badge = await screen.findByRole("button", { name: /tenant\/environment 컨텍스트: tenant tenant-a, environment 통제 운영, readiness 차단/ });
    expect(badge).toHaveClass("topbar-context-badge", "red");
    expect(within(badge).getByText("tenant-a")).toBeInTheDocument();
    expect(within(badge).getByText("통제 운영")).toBeInTheDocument();
    expect(within(badge).getByText("차단")).toBeInTheDocument();

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
