import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

describe("RunTrace suspended-run resume action", () => {
  beforeEach(() => {
    location.hash = "#runTrace?status=suspended";
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  test("operator can request resume from the trace table", async () => {
    const calls: Array<{ runId: string; key: string; reason?: string | null }> = [];
    renderApp(
      fakeClient({
        listRuns: async () => ({
          items: [
            {
              run_id: "11111111-aaaa-bbbb-cccc-000000000001",
              status: "suspended",
              priority: "medium",
              current_node: null,
              as_of: "2026-06-25T00:00:00.000Z",
              failure_reason: null,
            },
          ],
          next_cursor: null,
        }),
        resumeRun: async (runId, key, reason) => {
          calls.push({ runId, key, reason });
          return {
            run_id: runId,
            status: "resume_requested",
            previous_status: "suspended",
          };
        },
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "재개" }));
    const dialog = screen.getByRole("dialog");
    const buttons = within(dialog).getAllByRole("button");
    const confirm = buttons[buttons.length - 1];
    expect(confirm).toBeDefined();
    fireEvent.click(confirm!);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      runId: "11111111-aaaa-bbbb-cccc-000000000001",
      reason: "operator resume from RunTrace",
    });
    expect(typeof calls[0]!.key).toBe("string");
    expect(await screen.findByText("실행 재개를 요청했습니다.")).toBeInTheDocument();
  });
});
