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
    expect(await screen.findByText("세션 미등록")).toBeInTheDocument();
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
