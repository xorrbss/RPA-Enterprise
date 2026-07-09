import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { fakeClient } from "./fake-client";

function renderApp(client: ApiClient = fakeClient({ listScenarios: async () => ({ items: [], next_cursor: null }) })): void {
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

describe("scenario-studio-first-action", () => {
  beforeEach(() => {
    location.hash = "#create";
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  test("create console starts with natural-language draft creation and keeps browser recording secondary", async () => {
    renderApp();

    const request = await screen.findByLabelText("자연어 요청");
    const chooser = await screen.findByRole("region", { name: "자동화 시작 방식" });
    expect(request).toHaveAttribute("id", "scenario-natural-language-request");
    expect(within(chooser).getByRole("button", { name: "브라우저 업무 자동화" })).toBeInTheDocument();
    expect(within(chooser).getByRole("button", { name: "템플릿에서 시작" })).toBeInTheDocument();
    expect(within(chooser).getByRole("button", { name: "문서/IDP 자동화" })).toBeInTheDocument();
    expect(within(chooser).getByRole("button", { name: "API/커넥터 자동화" })).toBeInTheDocument();
    expect(within(chooser).getByRole("button", { name: "직접 설계" })).toBeInTheDocument();
    expect(within(chooser).getByRole("button", { name: "브라우저 녹화로 만들기" })).toBeInTheDocument();
    expect(within(chooser).getByText("AI Agent/MCP 자동화")).toBeInTheDocument();
    expect(within(chooser).getByText("결정 필요")).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "만들기 기본 경로" })).toHaveTextContent("말로 설명");
    expect(screen.getByText(/테스트까지 한 흐름/)).toBeInTheDocument();

    const draftButtons = screen.getAllByRole("button", { name: "자동화 초안 만들기" });
    expect(draftButtons.length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("button", { name: "+ 새 자동화 만들기" })).toBeNull();
    expect(within(chooser).getByRole("button", { name: "직접 설계" })).toBeInTheDocument();
    fireEvent.click(within(chooser).getByRole("button", { name: "브라우저 업무 자동화" }));

    expect(request).toHaveFocus();
  });

  test("routes reusable-template starts to the connector catalog", async () => {
    renderApp();

    const chooser = await screen.findByRole("region", { name: "자동화 시작 방식" });
    fireEvent.click(within(chooser).getByRole("button", { name: "템플릿에서 시작" }));

    await waitFor(() => expect(location.hash).toBe("#connectorCatalog?focus=templates"));
  });

  test("creator ai deep link focuses the natural-language request", async () => {
    location.hash = "#create?creator=ai";
    renderApp();

    const request = await screen.findByLabelText("자연어 요청");

    await waitFor(() => expect(request).toHaveFocus());
  });

  test("setup corridor surfaces the first missing preparation step without marking unknown evidence green", async () => {
    renderApp(
      fakeClient({
        listScenarios: async () => ({ items: [], next_cursor: null }),
        listSites: async () => ({ items: [], next_cursor: null }),
        listRuns: async () => ({ items: [], next_cursor: null }),
      }),
    );

    const corridor = await screen.findByRole("region", { name: "자동화 준비 단계" });

    await waitFor(() => expect(corridor).toHaveTextContent("첫 자동화를 실행할 대상 사이트를 먼저 등록하세요."));
    expect(within(corridor).getByText("증빙")).toBeInTheDocument();
    expect(within(corridor).getByText("테스트를 완료한 뒤 실행 산출물과 감사 증빙을 확인합니다.")).toBeInTheDocument();

    fireEvent.click(within(corridor).getByRole("button", { name: "사이트 등록" }));
    await waitFor(() => expect(location.hash).toBe("#security?section=sites&intent=site-create"));
  });

  test("read-only users can inspect setup state without write CTAs", async () => {
    localStorage.setItem("rpa.token", jwt(["viewer"]));
    renderApp(
      fakeClient({
        listScenarios: async () => ({ items: [], next_cursor: null }),
        listSites: async () => ({ items: [], next_cursor: null }),
        listRuns: async () => ({ items: [], next_cursor: null }),
      }),
    );

    const corridor = await screen.findByRole("region", { name: "자동화 준비 단계" });

    await waitFor(() => expect(corridor).toHaveTextContent("첫 자동화를 실행할 대상 사이트를 먼저 등록하세요."));
    expect(within(corridor).queryByRole("button", { name: /사이트 등록|초안 만들기|계획 확인|테스트 화면/ })).toBeNull();
  });

  test("saved automation actions lead with plan and dispatch direct runs as test mode", async () => {
    location.hash = "#scenarioStudio";
    const calls: Array<{ runMode: string | undefined; scenarioVersionId: string }> = [];
    renderApp(
      fakeClient({
        listScenarios: async () => ({
          items: [{ scenario_id: "sc-test-path", name: "주문 수집", version: 3, latest_version_id: "ver-test-path" }],
          next_cursor: null,
        }),
        createRun: async (body) => {
          calls.push({ runMode: body.run_mode, scenarioVersionId: body.scenario_version_id });
          return { run_id: "run-studio-test", status: "queued", run_mode: "test" };
        },
      }),
    );

    // T7: 기본 노출은 [열기][실행], 나머지는 더 보기 메뉴로.
    expect(await screen.findByRole("button", { name: "열기" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "계획·테스트" })).toBeNull();
    expect(screen.queryByText(/테스트 가능 · v/)).toBeNull(); // 관찰 안 한 값 단정 열 제거

    fireEvent.click(screen.getByRole("button", { name: "실행" }));
    fireEvent.click(await screen.findByRole("button", { name: "실행 시작" }));

    await waitFor(() => expect(calls).toEqual([{ runMode: "test", scenarioVersionId: "ver-test-path" }]));
    // E4: 스튜디오 행 실행도 화면 유지 + run 해시 보존(인라인 진행).
    await waitFor(() => expect(location.hash).toContain("run=run-studio-test"));
  });

  test("saved automation can open focused studio with test and evidence continuation", async () => {
    location.hash = "#scenarioStudio";
    renderApp(
      fakeClient({
        listScenarios: async () => ({
          items: [{ scenario_id: "sc-focus", name: "주문 수집", version: 5, latest_version_id: "ver-focus", promotion_status: "draft" }],
          next_cursor: null,
        }),
        listRuns: async () => ({
          items: [
            {
              run_id: "run-focus",
              status: "completed",
              priority: "medium",
              run_mode: "test",
              scenario_id: "sc-focus",
              scenario_name: "주문 수집",
              current_node: null,
              as_of: "2026-07-09T01:00:00.000Z",
              failure_reason: null,
            },
          ],
          next_cursor: null,
        }),
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "열기" })); // T7: 집중 작업 → 열기

    await waitFor(() => expect(location.hash).toBe("#scenarioStudio?mode=focus&scenario=sc-focus"));
    const studio = await screen.findByRole("region", { name: "집중 자동화 스튜디오" });
    expect(within(studio).getByText("주문 수집")).toBeInTheDocument();
    expect(within(studio).getByRole("tab", { name: /설계/ })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(within(studio).getByRole("tab", { name: /활동/ }));
    expect(within(studio).getByText("실행 상태 metadata · 감사 이벤트 확인 필요")).toBeInTheDocument();
    expect(within(studio).getByRole("button", { name: "감사 이력" })).toBeInTheDocument();

    fireEvent.click(within(studio).getByRole("button", { name: "증빙" }));
    await waitFor(() => expect(location.hash).toBe("#runTrace?run=run-focus&focus=artifacts"));
  });

  test("keeps governance approval below the creation start path", async () => {
    location.hash = "#scenarioStudio";
    localStorage.setItem("rpa.token", jwt(["operator", "approver"]));
    renderApp();

    const create = await screen.findByRole("region", { name: "전문가 자동화 스튜디오 안내" });
    const inbox = await screen.findByRole("region", { name: "운영 기준 승인 대기" });

    expect(create.compareDocumentPosition(inbox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("shows a security-site CTA when the selected site still needs a login session", async () => {
    renderApp(
      fakeClient({
        listScenarios: async () => ({ items: [], next_cursor: null }),
        listSites: async () => ({
          items: [
            {
              site_profile_id: "site-orders",
              name: "주문 포털",
              url_pattern: "https://orders.example",
              risk: "green",
              approval_status: "approved",
              circuit_status: "closed",
              login_capable: true,
              session_ready: false,
              default_browser_identity_id: "browser-orders",
              default_network_policy_id: "network-orders",
            },
          ],
          next_cursor: null,
        }),
      }),
    );

    fireEvent.change(await screen.findByLabelText("자연어 요청"), { target: { value: "https://orders.example 에서 오늘 주문을 확인해줘" } });

    expect(await screen.findByText("주문 포털의 로그인 세션을 등록해야 저장 후 실행할 수 있습니다.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "세션 등록하러 가기" }));

    await waitFor(() => expect(location.hash).toBe("#security?section=sites&site=site-orders"));
  });
});
