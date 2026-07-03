import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import type { RuntimeCapabilities } from "../src/api/types";
import { fakeClient } from "./fake-client";

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
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

const REQUEST_ID = "70000000-0000-4000-8000-000000000001";

function capsWith(offboarding: RuntimeCapabilities["offboarding"]): () => Promise<RuntimeCapabilities> {
  return async () => ({ session_capture: { server: { mode: "off", enabled: false } }, offboarding });
}

describe("offboarding global banner (O3)", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", jwt(["admin"]));
  });

  test("approved 원장이면 만료 예정 배너 + admin 취소 버튼", async () => {
    renderApp(fakeClient({
      getCapabilities: capsWith({ active: true, status: "approved", purge_after: "2026-07-10T00:00:00.000Z", request_id: REQUEST_ID }),
    }));
    const banner = await screen.findByText(/이 테넌트는 오프보딩 진행 중입니다/);
    expect(banner.textContent).toContain("영구 삭제");
    expect(screen.getByRole("button", { name: "오프보딩 취소" })).toBeInTheDocument();
  });

  test("purging 상태는 삭제 진행 중 문구 + 취소 버튼 없음", async () => {
    renderApp(fakeClient({
      getCapabilities: capsWith({ active: true, status: "purging", purge_after: null, request_id: REQUEST_ID }),
    }));
    await screen.findByText(/오프보딩 영구 삭제가 진행 중/);
    expect(screen.queryByRole("button", { name: "오프보딩 취소" })).toBeNull();
  });

  test("operator 는 배너는 보되 취소 버튼은 없음(RBAC 미러)", async () => {
    localStorage.setItem("rpa.token", jwt(["operator"]));
    renderApp(fakeClient({
      getCapabilities: capsWith({ active: true, status: "approved", purge_after: "2026-07-10T00:00:00.000Z", request_id: REQUEST_ID }),
    }));
    await screen.findByText(/이 테넌트는 오프보딩 진행 중입니다/);
    expect(screen.queryByRole("button", { name: "오프보딩 취소" })).toBeNull();
  });

  test("취소 클릭 → cancel API 호출(요청 id 전달)", async () => {
    const cancelOffboardingPurgeRequest = vi.fn(async (requestId: string) => ({
      request_id: requestId,
      status: "cancelled" as const,
      reason: "계약 종료",
      requested_by: "admin-1",
      decided_by: "admin-2",
      decision_reason: null,
      decided_at: "2026-07-03T00:10:00.000Z",
      purge_after: null,
      purged_at: null,
      held_rows: {},
      created_at: "2026-07-03T00:00:00.000Z",
      updated_at: "2026-07-03T00:20:00.000Z",
    }));
    renderApp(fakeClient({
      getCapabilities: capsWith({ active: true, status: "approved", purge_after: "2026-07-10T00:00:00.000Z", request_id: REQUEST_ID }),
      cancelOffboardingPurgeRequest,
    }));
    fireEvent.click(await screen.findByRole("button", { name: "오프보딩 취소" }));
    await waitFor(() => expect(cancelOffboardingPurgeRequest).toHaveBeenCalledTimes(1));
    expect(cancelOffboardingPurgeRequest.mock.calls[0]?.[0]).toBe(REQUEST_ID);
  });

  test("활성 원장이 없거나 pending 이면 배너 없음", async () => {
    renderApp(fakeClient({
      getCapabilities: capsWith({ active: true, status: "pending", purge_after: null, request_id: REQUEST_ID }),
    }));
    await waitFor(() => expect(screen.queryByText(/오프보딩 진행 중/)).toBeNull());
  });
});
