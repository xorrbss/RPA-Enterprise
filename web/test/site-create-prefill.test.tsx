import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { fakeClient } from "./fake-client";

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
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

describe("site onboarding to scenario studio", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", jwt(["viewer", "operator", "reviewer", "approver", "admin"]));
  });

  test("site create response pre-fills natural-language save-and-run target", async () => {
    const generated: Array<Parameters<ApiClient["generateScenario"]>[0]> = [];
    renderApp(
      fakeClient({
        listSites: async () => ({
          items: [
            {
              site_profile_id: "site-new",
              risk: "green",
              approval_status: "approved",
              circuit_status: "closed",
              name: "하이웍스",
              url_pattern: "https://login.office.hiworks.com",
              default_browser_identity_id: "browser-new",
              default_network_policy_id: "network-new",
            },
          ],
          next_cursor: null,
        }),
        createSite: async (body) => ({
          site_profile_id: "site-new",
          name: String(body.name),
          url_pattern: String(body.url_pattern),
          risk: body.risk ?? "green",
          approved: false,
          default_browser_identity_id: "browser-new",
          default_network_policy_id: "network-new",
        }),
        generateScenario: async (body) => {
          generated.push(body);
          return {
            generation_id: "00000000-0000-0000-0000-0000000000b1",
            mode: body.mode ?? "save_and_run",
            status: "saved",
            prompt_hash: "hash",
            planner: body.planner ?? "deterministic_mvp",
            model: body.model ?? null,
            scenario_id: "00000000-0000-0000-0000-0000000000c1",
            scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
            run_id: null,
            evidence_policy: body.evidence,
            blockers: [],
            draft_ir: {},
            validation_report: {},
          };
        },
      }),
    );

    location.hash = "#security";
    (await screen.findByRole("button", { name: "새 사이트" })).click();
    fireEvent.change(await screen.findByLabelText("이름"), { target: { value: "하이웍스" } });
    fireEvent.change(screen.getByLabelText("URL 패턴 (http/https origin)"), { target: { value: "https://login.office.hiworks.com" } });
    screen.getByRole("button", { name: "등록" }).click();

    await waitFor(() => expect(location.hash.startsWith("#scenarioStudio?")).toBe(true));
    const params = new URLSearchParams(location.hash.split("?")[1]);
    expect(params.get("site")).toBe("site-new");
    expect(params.get("start_url")).toBe("https://login.office.hiworks.com");
    expect(params.get("browser_identity")).toBe("browser-new");
    expect(params.get("network_policy")).toBe("network-new");
    expect(await screen.findByLabelText("시작 URL")).toHaveValue("https://login.office.hiworks.com");
    expect(screen.getByLabelText("사이트 ID")).toHaveValue("site-new");
    expect(screen.getByLabelText("브라우저 ID")).toHaveValue("browser-new");
    expect(screen.getByLabelText("네트워크 정책 ID")).toHaveValue("network-new");

    fireEvent.change(screen.getByLabelText("자연어 요청"), { target: { value: "오늘 결재함을 확인해줘" } });
    screen.getByRole("button", { name: "저장 후 실행" }).click();
    await waitFor(() => expect(generated).toHaveLength(1));
    expect(generated[0]).toMatchObject({
      prompt: "오늘 결재함을 확인해줘",
      start_url: "https://login.office.hiworks.com",
      target: {
        site_profile_id: "site-new",
        browser_identity_id: "browser-new",
        network_policy_id: "network-new",
      },
      evidence: { screenshot: "each_step", video: "never" },
    });
  });
});
