import { describe, expect, test, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { fakeClient } from "./fake-client";

// 로그인 필요 사이트의 세션 미등록 안내(메시지)·등록 직행(딥링크) 회귀 가드.
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

const LOGIN_SITE = {
  site_profile_id: "site-login-1",
  risk: "green",
  approval_status: "approved",
  circuit_status: "closed",
  name: "하이웍스",
  url_pattern: "https://login.example",
  login_capable: true,
  session_ready: false,
};

describe("로그인 세션 등록 안내/진입", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", jwt(["operator", "admin"]));
  });

  test("Security #site 딥링크 → 해당 사이트 세션 등록 배너(메시지+등록 버튼)", async () => {
    renderApp(fakeClient({ listSites: async () => ({ items: [LOGIN_SITE], next_cursor: null }) }));
    location.hash = `#security?site=${LOGIN_SITE.site_profile_id}`;
    const banner = await screen.findByRole("status", { name: "세션 등록 안내" });
    expect(within(banner).getByText(/로그인 세션을 등록하세요/)).toBeInTheDocument();
    expect(within(banner).getByRole("button", { name: "세션 등록" })).toBeInTheDocument();
  });

  test("Security 목록 — login_capable 사이트에 '세션 미등록' 배지", async () => {
    renderApp(fakeClient({ listSites: async () => ({ items: [LOGIN_SITE], next_cursor: null }) }));
    location.hash = "#security";
    expect((await screen.findAllByText("세션 미등록")).length).toBeGreaterThanOrEqual(1);
  });

  test("Security 상단 — 세션 갱신 큐에서 미등록 사이트를 바로 처리한다", async () => {
    renderApp(fakeClient({ listSites: async () => ({ items: [LOGIN_SITE], next_cursor: null }) }));
    location.hash = "#security";

    const queue = await screen.findByRole("region", { name: "로그인 세션 갱신 큐" });
    expect(within(queue).getByText("1건 확인 필요")).toBeInTheDocument();
    expect(within(queue).getByText("하이웍스")).toBeInTheDocument();
    expect(within(queue).getByText("로그인 세션이 없어 브라우저 실행 전에 등록이 필요합니다.")).toBeInTheDocument();
    expect(within(queue).getByText("세션 미등록")).toBeInTheDocument();
    expect(within(queue).getByRole("button", { name: "세션 등록" })).toBeInTheDocument();
    expect(within(queue).getByRole("button", { name: "운영자 PC 등록" })).toBeInTheDocument();
  });

  test("Security 목록 — 세션 등록 상태를 펼쳐 최근 capture 진행 상태를 확인한다", async () => {
    renderApp(
      fakeClient({
        listSites: async () => ({ items: [LOGIN_SITE], next_cursor: null }),
        listSessionCaptures: async () => ({
          items: [
            {
              capture_session_id: "c0000000-0000-0000-0000-000000000001",
              status: "awaiting_login",
              detail: "operator login pending",
              updated_at: "2026-06-23T09:00:00.000Z",
            },
          ],
          next_cursor: null,
        }),
      }),
    );
    location.hash = "#security";
    fireEvent.click(await screen.findByRole("button", { name: "상태 보기" }));
    const panel = await screen.findByRole("region", { name: /세션 등록 상태/ });
    expect(await within(panel).findByText("로그인 대기")).toBeInTheDocument();
    expect(within(panel).getByText("운영자 로그인을 기다리는 중입니다.")).toHaveAttribute("title", "operator login pending");
    expect(within(panel).queryByText("operator login pending")).not.toBeInTheDocument();
  });

  test("Security 목록 — 사이트 화면 상태 조건을 수정 저장한다", async () => {
    let saved: unknown = undefined;
    const siteWithSelectors = {
      ...LOGIN_SITE,
      page_state_summary: {
        configured: true,
        login_url_configured: true,
        authenticated_selector_configured: true,
        flag_count: 1,
        flags: ["reviews_visible"],
      },
    };
    renderApp(
      fakeClient({
        listSites: async () => ({ items: [siteWithSelectors], next_cursor: null }),
        getSite: async () => ({
          ...siteWithSelectors,
          page_state_selectors: {
            loginUrl: "https://login.example/signin",
            authenticatedWhen: { selector: ".old-user-menu" },
            flags: { reviews_visible: { kind: "min_count", selector: ".review-item", n: 1 } },
          },
        }),
        updateSitePageState: async (_siteId, selectors) => {
          saved = selectors;
          return {
            site_profile_id: LOGIN_SITE.site_profile_id,
            page_state_selectors: selectors,
            page_state_summary: {
              configured: selectors !== null,
              login_url_configured: true,
              authenticated_selector_configured: true,
              flag_count: 1,
              flags: ["reviews_visible"],
            },
          };
        },
      }),
    );
    location.hash = "#security";
    fireEvent.click(await screen.findByRole("button", { name: "판정 설정" }));
    const panel = await screen.findByRole("region", { name: /화면 상태 판정/ });
    expect(await within(panel).findByText("리뷰 목록 표시")).toBeInTheDocument();
    expect(within(panel).getByText("최소 개수 이상")).toBeInTheDocument();
    expect(within(panel).getByText("판정 기준 보기")).toBeInTheDocument();
    fireEvent.change(await within(panel).findByLabelText("로그인 완료 확인 조건"), { target: { value: ".user-menu" } });
    fireEvent.click(within(panel).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(saved).not.toBeUndefined());
    expect(saved).toEqual({
      loginUrl: "https://login.example/signin",
      authenticatedWhen: { selector: ".user-menu" },
      flags: { reviews_visible: { kind: "min_count", selector: ".review-item", n: 1 } },
    });
  });

  test("실행 패널의 세션 미등록 → '세션 등록하러 가기'가 그 사이트로 딥링크", async () => {
    const SCEN = { scenario_id: "sc1", name: "로그인 자동화", version: 1, latest_version_id: "ver-1" };
    renderApp(
      fakeClient({
        listScenarios: async () => ({ items: [SCEN], next_cursor: null }),
        getScenario: async (id) => ({
          scenario_id: id,
          name: "로그인 자동화",
          version: 1,
          promotion_status: "draft",
          ir: {
            start: "open",
            params_schema: { type: "object", properties: { entry_url: { type: "string", default: "https://login.example/app" } }, required: ["entry_url"] },
            nodes: { open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "done" }, done: { terminal: "success" } },
          },
        }),
        listSites: async () => ({ items: [LOGIN_SITE], next_cursor: null }),
      }),
    );
    location.hash = "#scenarioStudio";
    fireEvent.click(await screen.findByRole("button", { name: "실행" }));
    const cta = await screen.findByRole("button", { name: "세션 등록하러 가기" });
    fireEvent.click(cta);
    await waitFor(() => expect(location.hash).toBe(`#security?site=${LOGIN_SITE.site_profile_id}`));
  });

  test("실행 상세 — navigate 단계 실패 시 세션 재등록 힌트 + 보안으로 이동", async () => {
    const RUN_ID = "11111111-aaaa-bbbb-cccc-000000000099";
    renderApp(
      fakeClient({
        getRun: async (id) => ({ run_id: id, status: "failed_system", worker_id: "w1", attempts: 0, as_of: null, failure_reason: null }),
        listRunSteps: async () => ({
          items: [
            {
              step_id: "s1", node_id: "open", attempt: 0, action: "navigate", status: "failed_system",
              cache_mode: "bypass", artifact_ids: [], stagehand_calls: [], started_at: null, ended_at: null,
              duration_ms: 50018, exception: { code: "CONTROL_PLANE_INTERNAL_ERROR", class: "system" },
            },
          ],
          next_cursor: null,
        }),
      }),
    );
    location.hash = `#runTrace?run=${RUN_ID}`;
    const banner = await screen.findByRole("status", { name: "세션 등록 안내" });
    expect(within(banner).getByText(/세션이 만료됐을 수 있어요/)).toBeInTheDocument();
    fireEvent.click(within(banner).getByRole("button", { name: /세션 등록하러 가기/ }));
    await waitFor(() => expect(location.hash).toBe("#security"));
  });
});
