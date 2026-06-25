import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { fakeClient } from "./fake-client";

function renderApp(client: ApiClient): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>
        <App />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

describe("Scenario studio pagination", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.clear();
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  test("scenario list follows next_cursor instead of showing only the first page", async () => {
    const calls: Array<{ cursor?: string; limit?: number }> = [];
    renderApp(
      fakeClient({
        listScenarios: async (params) => {
          calls.push(params ?? {});
          if (params?.cursor === "scenario-cursor-2") {
            return {
              items: [{ scenario_id: "sc-page-2", name: "second page scenario", version: 1, latest_version_id: "ver-page-2" }],
              next_cursor: null,
            };
          }
          return {
            items: [{ scenario_id: "sc-page-1", name: "first page scenario", version: 1, latest_version_id: "ver-page-1" }],
            next_cursor: "scenario-cursor-2",
          };
        },
      }),
    );
    location.hash = "#scenarioStudio";

    expect(await screen.findByText("first page scenario")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다음" }));

    await waitFor(() => expect(calls.some((c) => c.cursor === "scenario-cursor-2")).toBe(true));
    expect(await screen.findByText("second page scenario")).toBeInTheDocument();
  });

  test("자동화 목록이 식별값(scenario_id)을 노출한다 — 자동화 검사 화면이 가리키는 출처", async () => {
    renderApp(
      fakeClient({
        listScenarios: async () => ({
          items: [{ scenario_id: "sc-7e3f0011", name: "주문 수집", version: 1, latest_version_id: "ver-1" }],
          next_cursor: null,
        }),
      }),
    );
    location.hash = "#scenarioStudio";

    const idCell = await screen.findByText("sc-7e3f0011");
    expect(idCell.tagName).toBe("CODE"); // 선택·복사 가능한 식별값
  });
});
