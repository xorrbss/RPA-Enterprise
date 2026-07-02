import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    location.hash = "#scenarioStudio";
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  test("starts with natural-language draft creation and keeps browser recording secondary", async () => {
    renderApp();

    const request = await screen.findByLabelText("자연어 요청");
    expect(request).toHaveAttribute("id", "scenario-natural-language-request");
    expect(screen.getByRole("button", { name: "브라우저 녹화로 만들기" })).toBeInTheDocument();
    expect(await screen.findByText("첫 실행 전")).toBeInTheDocument();

    const draftButtons = screen.getAllByRole("button", { name: "자동화 초안 만들기" });
    expect(draftButtons.length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("button", { name: "+ 새 자동화 만들기" })).toBeNull();
    expect(screen.getByText("양식으로 직접 만들기")).toBeInTheDocument();
    fireEvent.click(draftButtons[0] as HTMLButtonElement);

    expect(request).toHaveFocus();
  });

  test("keeps governance approval below the creation start path", async () => {
    localStorage.setItem("rpa.token", jwt(["operator", "approver"]));
    renderApp();

    const create = await screen.findByRole("region", { name: "자동화 제작 시작" });
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
