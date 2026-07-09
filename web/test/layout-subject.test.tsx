import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import { fakeClient } from "./fake-client";

function jwt(sub: string, roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub, tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
});
