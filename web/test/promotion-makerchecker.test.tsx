import { beforeEach, describe, expect, test, vi } from "vitest";
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
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

const draftScenario = { scenario_id: "sc-1", name: "월말정산봇", version: 2, latest_version_id: "v", promotion_status: "draft" };

describe("승격 maker-checker (D4b)", () => {
  beforeEach(() => {
    location.hash = "#scenarioStudio";
    localStorage.clear();
  });

  test("operator: 초안에 '승격 요청' 노출 + 사유 입력 후 createPromotionRequest 호출", async () => {
    localStorage.setItem("rpa.token", jwt(["operator"]));
    const createPromotionRequest = vi.fn(async () => ({ request_id: "r1", status: "pending" }));
    renderApp(fakeClient({ listScenarios: async () => ({ items: [draftScenario], next_cursor: null }), createPromotionRequest }));
    fireEvent.click(await screen.findByRole("button", { name: "승격 요청" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("승격 사유"), { target: { value: "운영 적용" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "확인" }));
    await waitFor(() => expect(createPromotionRequest).toHaveBeenCalledWith("sc-1", 2, "운영 적용", expect.any(String)));
  });

  test("operator: 직접 '운영 지정'·승인 인박스는 권한 없어 미노출", async () => {
    localStorage.setItem("rpa.token", jwt(["operator"]));
    renderApp(fakeClient({ listScenarios: async () => ({ items: [draftScenario], next_cursor: null }) }));
    await screen.findByRole("button", { name: "승격 요청" });
    expect(screen.queryByRole("button", { name: "운영 지정" })).toBeNull();
    expect(screen.queryByText("승격 승인 대기")).toBeNull();
  });

  test("approver: 승인 인박스에 pending 요청 노출 + 승인 시 decidePromotionRequest(approve)", async () => {
    localStorage.setItem("rpa.token", jwt(["approver"]));
    const decidePromotionRequest = vi.fn(async () => ({ status: "approved" }));
    renderApp(
      fakeClient({
        listScenarios: async () => ({ items: [], next_cursor: null }),
        listPromotionRequests: async () => ({
          items: [{ request_id: "rq-1", scenario_id: "sc-9", scenario_name: "급여봇", version: 3, reason: "정기 운영", requested_by: "op-kim", created_at: "2026-06-25T00:00:00Z" }],
          next_cursor: null,
        }),
        decidePromotionRequest,
      }),
    );
    expect(await screen.findByText("급여봇")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "승인" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "확인" }));
    await waitFor(() => expect(decidePromotionRequest).toHaveBeenCalledWith("sc-9", "rq-1", "approve", undefined, expect.any(String)));
  });
});
