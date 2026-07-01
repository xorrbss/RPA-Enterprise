import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import { fakeClient } from "./fake-client";

function renderApp(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={fakeClient({ listScenarios: async () => ({ items: [], next_cursor: null }) })}>
        <App />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

describe("scenario-studio-first-action", () => {
  beforeEach(() => {
    location.hash = "#scenarioStudio";
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  test("starts with natural-language draft creation and keeps browser recording secondary", async () => {
    renderApp();

    const request = await screen.findByLabelText("자연어 요청");
    expect(request).toHaveAttribute("id", "scenario-natural-language-request");
    expect(screen.getByRole("button", { name: "브라우저 녹화로 만들기" })).toBeInTheDocument();
    expect(await screen.findByText("첫 실행 전")).toBeInTheDocument();

    const draftButtons = screen.getAllByRole("button", { name: "자동화 초안 만들기" });
    expect(draftButtons.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(draftButtons[0] as HTMLButtonElement);

    expect(request).toHaveFocus();
  });
});
