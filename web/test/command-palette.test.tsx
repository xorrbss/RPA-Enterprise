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

async function openPaletteWithQuery(value: string, client: ApiClient = fakeClient()): Promise<HTMLElement> {
  renderApp(client);
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  const dialog = await screen.findByRole("dialog", { name: "전역 검색 및 화면 이동" });
  fireEvent.change(within(dialog).getByRole("combobox"), { target: { value } });
  return dialog;
}

async function clickPaletteResult(dialog: HTMLElement, label: string): Promise<void> {
  const node = await within(dialog).findByText(label);
  const option = node.closest('[role="option"]');
  expect(option).not.toBeNull();
  fireEvent.mouseDown(option as Element);
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

  test("검색어 없이 열어도 주요 운영 quick action을 노출", async () => {
    renderApp();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "전역 검색 및 화면 이동" });
    expect(within(dialog).getByText("시스템 실패 실행 보기")).toBeInTheDocument();
    expect(within(dialog).getByText("대기 실행 보기")).toBeInTheDocument();
    expect(within(dialog).getByText("사람확인 인박스 열기")).toBeInTheDocument();
    expect(within(dialog).getByText("Credential 관리 열기")).toBeInTheDocument();
    expect(within(dialog).getByText("Worker Pool 관리 열기")).toBeInTheDocument();
    expect(within(dialog).getByText("Automation report 열기")).toBeInTheDocument();
  });

  test("영어 키워드로 quick action 필터 후 Enter로 대기 실행 목록 이동", async () => {
    const dialog = await openPaletteWithQuery("queued");
    expect(within(dialog).getByText("대기 실행 보기")).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "Enter" });
    await waitFor(() => expect(location.hash).toBe("#runTrace?status=queued"));
  });

  test("한국어 키워드로 quick action 필터 후 Credential 관리로 이동", async () => {
    const dialog = await openPaletteWithQuery("자격증명");
    await clickPaletteResult(dialog, "Credential 관리 열기");
    await waitFor(() => expect(location.hash).toBe("#security?focus=credentials"));
  });

  test("자동화 결과 클릭 → 테스트 실행 딥링크로 이동", async () => {
    const dialog = await openPaletteWithQuery(
      "월말",
      fakeClient({
        listScenarios: async () => ({
          items: [{ scenario_id: "sc-1", name: "월말정산봇", version: 3, latest_version_id: "v-1" }],
          next_cursor: null,
        }),
      }),
    );
    await clickPaletteResult(dialog, "월말정산봇");
    await waitFor(() => expect(location.hash).toBe("#playground?scenario=sc-1"));
  });

  test("실행 결과 클릭 → 실행 기록 run 딥링크로 이동", async () => {
    const dialog = await openPaletteWithQuery(
      "run-pal",
      fakeClient({
        listRuns: async () => ({
          items: [{ run_id: "run-pal-1", status: "failed_system", current_node: null, as_of: "2026-06-25T00:00:00.000Z" }],
          next_cursor: null,
        }),
      }),
    );
    await clickPaletteResult(dialog, "실행 run-pal-1");
    await waitFor(() => expect(location.hash).toBe("#runTrace?run=run-pal-1"));
  });

  test("사람 확인 결과 클릭 → 업무 상세 딥링크로 이동", async () => {
    const dialog = await openPaletteWithQuery(
      "captcha",
      fakeClient({
        listHumanTasks: async () => ({
          items: [
            {
              human_task_id: "ht-pal-1",
              state: "open",
              kind: "captcha",
              assignee: null,
              timeout: null,
              on_timeout: null,
              run_id: "run-pal-1",
            },
          ],
          next_cursor: null,
        }),
      }),
    );
    await clickPaletteResult(dialog, "사람 확인 ht-pal-1");
    await waitFor(() => expect(location.hash).toBe("#humanTasks?ht=ht-pal-1"));
  });

  test("담당자 결과 클릭 → 보안 화면 principal 포커스로 이동", async () => {
    const dialog = await openPaletteWithQuery(
      "홍길동",
      fakeClient({
        listPrincipals: async () => ({
          items: [
            {
              principal_id: "principal-pal-1",
              sub: "hong.gildong",
              display_name: "홍길동",
              email: "hong@example.com",
              source: "manual",
              external_id: null,
              idp_provider: null,
              lifecycle_source: "local",
            },
          ],
          next_cursor: null,
        }),
      }),
    );
    await clickPaletteResult(dialog, "홍길동");
    await waitFor(() => expect(location.hash).toBe("#security?principal=principal-pal-1"));
  });

  test("Credential 결과 클릭 → 보안 화면 credential 포커스로 이동", async () => {
    const credentialRef = "rpa/prod/runtime-worker/executor/hiworks_password";
    const dialog = await openPaletteWithQuery(
      "하이웍스",
      fakeClient({
        listConcurrencyPolicies: async () => ({
          items: [
            {
              credential_ref: credentialRef,
              site_profile_id: "site-hiworks",
              site_name: "하이웍스",
              max_concurrency: 1,
              active_leases: 0,
              label: "하이웍스 운영 계정",
              status: "active",
            },
          ],
          next_cursor: null,
        }),
      }),
    );
    await clickPaletteResult(dialog, "하이웍스 운영 계정");
    const qs = new URLSearchParams({ credential: credentialRef, credential_site: "site-hiworks" }).toString();
    await waitFor(() => expect(location.hash).toBe(`#security?${qs}`));
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
