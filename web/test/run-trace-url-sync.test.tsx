import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { fakeClient } from "./fake-client";

function tokenWithRoles(roles: string[]): string {
  const payload = btoa(JSON.stringify({ sub: "11111111-0000-4000-8000-000000000001", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `header.${payload}.sig`;
}

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

describe("RunTrace status URL sync", () => {
  beforeEach(() => {
    location.hash = "#runTrace";
    localStorage.setItem("rpa.token", tokenWithRoles(["admin"]));
  });

  test("상태 필터를 바꾸면 URL status도 같이 갱신한다", async () => {
    const calls: Array<Record<string, unknown>> = [];
    renderApp(fakeClient({
      listRuns: async (params) => {
        calls.push(params ?? {});
        return { items: [], next_cursor: null };
      },
    }));

    const select = await screen.findByLabelText("상태");
    fireEvent.change(select, { target: { value: "running" } });

    await waitFor(() => expect(calls.some((call) => call.status === "running")).toBe(true));
    expect(location.hash).toBe("#runTrace?status=running");
  });

  test("같은 화면에서 URL status가 바뀌면 목록 필터도 다시 맞춘다", async () => {
    const calls: Array<Record<string, unknown>> = [];
    location.hash = "#runTrace?status=running";
    renderApp(fakeClient({
      listRuns: async (params) => {
        calls.push(params ?? {});
        return { items: [], next_cursor: null };
      },
    }));

    await waitFor(() => expect(calls.some((call) => call.status === "running")).toBe(true));
    location.hash = "#runTrace?status=failed_system";

    await waitFor(() => expect(calls.some((call) => call.status === "failed_system")).toBe(true));
  });
});
