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

describe("RunTrace failed-run rerun actions", () => {
  beforeEach(() => {
    location.hash = "#runTrace?status=failed_system";
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  test("failed run can be rerun with the same input", async () => {
    const calls: Array<{ runId: string; body: unknown; key: string }> = [];
    renderApp(
      fakeClient({
        listRuns: async () => ({
          items: [
            {
              run_id: "11111111-aaaa-bbbb-cccc-000000000001",
              status: "failed_system",
              current_node: null,
              as_of: "2026-06-25T00:00:00.000Z",
              failure_reason: { code: "RUN_LOOP_FAILED", message: "navigation failed" },
            },
          ],
          next_cursor: null,
        }),
        rerunRun: async (runId, body, key) => {
          calls.push({ runId, body, key });
          return {
            rerun_id: "77000000-0000-0000-0000-000000000001",
            source_run_id: runId,
            run_id: "77000000-0000-0000-0000-000000000002",
            status: "queued",
            mode: body.mode,
            as_of: "2026-06-26T00:00:00.000Z",
          };
        },
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "같은 입력 재실행" }));
    const dialog = screen.getByRole("dialog");
    const buttons = within(dialog).getAllByRole("button");
    const confirm = buttons[buttons.length - 1];
    expect(confirm).toBeDefined();
    fireEvent.click(confirm!);

    await waitFor(() => expect(calls).toHaveLength(1));
    const call = calls[0];
    expect(call).toBeDefined();
    expect(call).toMatchObject({
      runId: "11111111-aaaa-bbbb-cccc-000000000001",
      body: { mode: "same_input" },
    });
    expect(typeof call!.key).toBe("string");
    expect(await screen.findByText("재실행을 대기열에 등록했습니다.")).toBeInTheDocument();
  });

  test("failed run can be rerun with edited JSON input", async () => {
    const calls: Array<{ body: { mode: string; params?: Record<string, unknown>; reason?: string | null } }> = [];
    renderApp(
      fakeClient({
        listRuns: async () => ({
          items: [
            {
              run_id: "11111111-aaaa-bbbb-cccc-000000000001",
              status: "failed_business",
              current_node: null,
              as_of: "2026-06-25T00:00:00.000Z",
              failure_reason: { code: "IR_SCHEMA_INVALID", message: "input missing" },
            },
          ],
          next_cursor: null,
        }),
        rerunRun: async (runId, body) => {
          calls.push({ body });
          return {
            rerun_id: "77000000-0000-0000-0000-000000000003",
            source_run_id: runId,
            run_id: "77000000-0000-0000-0000-000000000004",
            status: "queued",
            mode: body.mode,
            as_of: "2026-06-26T00:00:00.000Z",
          };
        },
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "수정 입력 재실행" }));
    fireEvent.change(screen.getByLabelText("수정 입력(JSON object)"), {
      target: { value: '{"invoice_id":"A-100","amount":1200}' },
    });
    const dialog = screen.getByRole("dialog");
    const buttons = within(dialog).getAllByRole("button");
    const confirm = buttons[buttons.length - 1];
    expect(confirm).toBeDefined();
    fireEvent.click(confirm!);

    await waitFor(() => expect(calls).toHaveLength(1));
    const call = calls[0];
    expect(call).toBeDefined();
    expect(call!.body).toEqual({
      mode: "edited_input",
      params: { invoice_id: "A-100", amount: 1200 },
      reason: "operator edited input",
    });
    expect(await screen.findByText("수정 입력 재실행을 대기열에 등록했습니다.")).toBeInTheDocument();
  });
});
