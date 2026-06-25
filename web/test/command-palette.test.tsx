import { describe, expect, test, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { axe } from "vitest-axe";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { fakeClient } from "./fake-client";

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

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

describe("커맨드 팔레트(Ctrl/⌘+K) — 전역 검색·이동", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  test("Ctrl+K로 열고 화면 이름으로 필터 → Enter로 이동", async () => {
    renderApp();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "전역 검색 및 화면 이동" });
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "중복 방지" } });
    expect(within(dialog).getByText("중복 방지")).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "Enter" });
    await waitFor(() => expect(location.hash).toBe("#idempotency"));
  });

  test("검색 버튼으로 열고 자동화 이름 검색", async () => {
    renderApp(
      fakeClient({
        listScenarios: async () => ({
          items: [{ scenario_id: "sc-1", name: "월말정산봇", version: 3, latest_version_id: "v-1" }],
          next_cursor: null,
        }),
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /검색/ }));
    const dialog = await screen.findByRole("dialog", { name: "전역 검색 및 화면 이동" });
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "월말" } });
    expect(await within(dialog).findByText("월말정산봇")).toBeInTheDocument();
  });

  test("Esc로 닫힌다", async () => {
    renderApp();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("열린 팔레트는 axe 위반 없음", async () => {
    renderApp();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog");
    expect(await axe(dialog)).toHaveNoViolations();
  });
});
