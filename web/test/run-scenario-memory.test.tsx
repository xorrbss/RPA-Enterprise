import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { fakeClient } from "./fake-client";

const SCENARIO = { scenario_id: "sc1", name: "reviews", version: 2, latest_version_id: "ver-9" };
const RUN_BUTTON_LABEL = "실행";
const START_BUTTON_LABEL = "실행 시작";

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
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

function scenarioClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return fakeClient({
    listScenarios: async () => ({ items: [SCENARIO], next_cursor: null }),
    getScenario: async (id) => ({
      scenario_id: id,
      name: "reviews",
      version: 2,
      promotion_status: "prod",
      ir: {
        start: "open",
        nodes: {
          open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "done" },
          done: { terminal: "success" },
        },
      },
    }),
    ...overrides,
  });
}

describe("RunScenarioButton URL memory", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.clear();
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  test("prefills URL params from the last successful execution", async () => {
    const url = "http://127.0.0.1:8080/fixture/reviews";
    localStorage.setItem("rpa.run.params.sc1", JSON.stringify({ entry_url: url }));
    location.hash = "#playground";
    renderApp(scenarioClient());

    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "sc1" } });
    (await screen.findByRole("button", { name: RUN_BUTTON_LABEL })).click();

    expect(await screen.findByRole("textbox")).toHaveValue(url);
  });

  test("remembers URL params after a successful execution without storing unrelated params", async () => {
    const url = "http://127.0.0.1:8080/fixture/reviews";
    location.hash = "#playground";
    renderApp(
      scenarioClient({
        getScenario: async (id) => ({
          scenario_id: id,
          name: "reviews",
          version: 2,
          promotion_status: "prod",
          ir: {
            start: "open",
            params_schema: {
              type: "object",
              properties: {
                entry_url: { type: "string", title: "Entry URL", default: "http://127.0.0.1:8080/old" },
                reason: { type: "string", title: "Reason" },
              },
              required: ["entry_url"],
            },
            nodes: {
              open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "done" },
              done: { terminal: "success" },
            },
          },
        }),
        createRun: async () => ({ run_id: "run-url-memory", status: "queued" }),
      }),
    );

    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "sc1" } });
    (await screen.findByRole("button", { name: RUN_BUTTON_LABEL })).click();
    const inputs = await screen.findAllByRole("textbox");
    expect(inputs).toHaveLength(2);
    const [urlInput, reasonInput] = inputs as [HTMLElement, HTMLElement];
    expect(urlInput).toBeDefined();
    expect(reasonInput).toBeDefined();
    fireEvent.change(urlInput, { target: { value: url } });
    fireEvent.change(reasonInput, { target: { value: "do not persist" } });
    (await screen.findByRole("button", { name: START_BUTTON_LABEL })).click();

    await waitFor(() => expect(localStorage.getItem("rpa.run.params.sc1")).not.toBeNull());
    expect(JSON.parse(localStorage.getItem("rpa.run.params.sc1") ?? "{}")).toEqual({ entry_url: url });
  });
});
