import { beforeEach, describe, expect, test } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import type { ListParams } from "../src/api/types";
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

function jwt(): string {
  const payload = btoa(JSON.stringify({ sub: "u-me", tenant_id: "t", roles: ["operator", "reviewer", "approver"] })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

describe("MyWork human-task landing queue", () => {
  beforeEach(() => {
    location.hash = "#myWork";
    localStorage.setItem("rpa.token", jwt());
  });

  test("builds the queue from assignee=me plus unassigned=true without an unfiltered human-task fetch", async () => {
    const params: ListParams[] = [];
    renderApp(
      fakeClient({
        listHumanTasks: async (p) => {
          params.push(p ?? {});
          if (p?.assignee === "u-me") {
            return { items: [{ human_task_id: "ht-mine", state: "assigned", kind: "approval", assignee: "u-me", timeout: null, on_timeout: "escalate", run_id: null, payload: { title: "Mine approval" } }], next_cursor: null };
          }
          if (p?.unassigned === true) {
            return {
              items: [
                { human_task_id: "ht-unassigned", state: "open", kind: "approval", assignee: null, timeout: null, on_timeout: "escalate", run_id: null, payload: { title: "Unassigned approval" } },
                { human_task_id: "ht-resolved", state: "resolved", kind: "approval", assignee: null, timeout: null, on_timeout: "escalate", run_id: null, payload: { title: "Resolved approval" } },
              ],
              next_cursor: null,
            };
          }
          throw new Error(`unexpected params ${JSON.stringify(p)}`);
        },
      }),
    );

    expect(await screen.findByText("Mine approval")).toBeInTheDocument();
    expect(await screen.findByText("Unassigned approval")).toBeInTheDocument();
    expect(screen.queryByText("Resolved approval")).toBeNull();
    expect(params).toContainEqual({ assignee: "u-me" });
    expect(params).toContainEqual({ unassigned: true });
    expect(params.some((p) => Object.keys(p).length === 0)).toBe(false);

    const unassignedRow = screen.getByText("Unassigned approval").closest("li");
    expect(unassignedRow).not.toBeNull();
    within(unassignedRow as HTMLElement).getByRole("button").click();
    await waitFor(() => expect(location.hash).toBe("#humanTasks?ht=ht-unassigned"));
  });

  test("empty state does not promise that automation handled the work", async () => {
    renderApp(fakeClient({ listHumanTasks: async () => ({ items: [], next_cursor: null }) }));
    expect(await screen.findByText("지금 확인할 일이 없습니다. 자동화 상태는 실행 기록에서 확인하세요.")).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toContain("자동화가 알아서 처리");
  });
});
