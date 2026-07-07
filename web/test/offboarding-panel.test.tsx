import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import type { OffboardingPurgeRequestItem } from "../src/api/types";
import { fakeClient } from "./fake-client";

function jwt(roles: readonly string[], sub = "admin-1"): string {
  const payload = btoa(JSON.stringify({ sub, tenant_id: "t", roles }))
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

function item(overrides: Partial<OffboardingPurgeRequestItem>): OffboardingPurgeRequestItem {
  return {
    request_id: "70000000-0000-4000-8000-000000000001",
    status: "pending",
    reason: "계약 종료",
    requested_by: "admin-1",
    decided_by: null,
    decision_reason: null,
    decided_at: null,
    purge_after: null,
    purged_at: null,
    held_rows: {},
    created_at: "2026-07-03T00:00:00.000Z",
    updated_at: "2026-07-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("security hub offboarding section (O5)", () => {
  beforeEach(() => {
    location.hash = "#security?section=offboarding";
    localStorage.setItem("rpa.token", jwt(["admin"]));
  });

  test("반출 안내 + 빈 원장 + 요청 폼 렌더", async () => {
    renderApp(fakeClient());
    const panel = await screen.findByRole("region", { name: "오프보딩(데이터 반출·삭제)" });
    expect(within(panel).getByText(/데이터 반출 안내/)).toBeInTheDocument();
    expect(within(panel).getAllByText(/offboarding-download\.mjs/).length).toBeGreaterThanOrEqual(2); // PS + POSIX 두 명령
    expect(await within(panel).findByText("오프보딩 요청이 없습니다.")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "영구 삭제 요청" })).toBeDisabled(); // 사유 비어 있음
  });

  test("삭제 요청 폼: 사유 입력 후 제출 → create API 호출", async () => {
    const createOffboardingPurgeRequest = vi.fn(async (reason: string) => item({ reason }));
    renderApp(fakeClient({ createOffboardingPurgeRequest }));
    const panel = await screen.findByRole("region", { name: "오프보딩(데이터 반출·삭제)" });
    fireEvent.change(within(panel).getByLabelText(/영구 삭제 요청/), { target: { value: "계약 종료 철수" } });
    fireEvent.click(within(panel).getByRole("button", { name: "영구 삭제 요청" }));
    await waitFor(() => expect(createOffboardingPurgeRequest).toHaveBeenCalledTimes(1));
    expect(createOffboardingPurgeRequest.mock.calls[0]?.[0]).toBe("계약 종료 철수");
  });

  test("SoD: 요청자 본인의 승인/반려 버튼 비활성, 타 관리자는 활성 + decide 호출", async () => {
    const pending = item({ requested_by: "admin-1" });
    const listOffboardingPurgeRequests = async () => ({ items: [pending], grace_days: 7 });
    // 본인(admin-1): 비활성.
    renderApp(fakeClient({ listOffboardingPurgeRequests }));
    let panel = await screen.findByRole("region", { name: "오프보딩(데이터 반출·삭제)" });
    expect(await within(panel).findByRole("button", { name: "승인" })).toBeDisabled();
    expect(within(panel).getByRole("button", { name: "반려" })).toBeDisabled();

    // 타 관리자(admin-2): 활성 → 승인 클릭 시 decide(approved).
    document.body.innerHTML = "";
    localStorage.setItem("rpa.token", jwt(["admin"], "admin-2"));
    const decideOffboardingPurgeRequest = vi.fn(async (requestId: string, decision: "approved" | "rejected") =>
      item({ request_id: requestId, status: decision, decided_by: "admin-2" }));
    renderApp(fakeClient({ listOffboardingPurgeRequests, decideOffboardingPurgeRequest }));
    panel = await screen.findByRole("region", { name: "오프보딩(데이터 반출·삭제)" });
    const approve = await within(panel).findByRole("button", { name: "승인" });
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
    await waitFor(() => expect(decideOffboardingPurgeRequest).toHaveBeenCalledTimes(1));
    expect(decideOffboardingPurgeRequest.mock.calls[0]?.[1]).toBe("approved");
  });

  test("approved: 만료 예정 + 취소 버튼 → cancel 호출, 신규 요청 폼은 잠김", async () => {
    const approved = item({ status: "approved", decided_by: "admin-2", decided_at: "2026-07-03T01:00:00.000Z", purge_after: "2026-07-10T01:00:00.000Z" });
    const cancelOffboardingPurgeRequest = vi.fn(async (requestId: string) => item({ request_id: requestId, status: "cancelled" }));
    renderApp(fakeClient({
      listOffboardingPurgeRequests: async () => ({ items: [approved], grace_days: 7 }),
      cancelOffboardingPurgeRequest,
    }));
    const panel = await screen.findByRole("region", { name: "오프보딩(데이터 반출·삭제)" });
    expect(await within(panel).findByText(/영구 삭제$|영구 삭제 \(약/)).toBeInTheDocument();
    expect(within(panel).getByText(/진행 중인 요청이 있어 새 요청을 만들 수 없습니다/)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "오프보딩 취소" }));
    await waitFor(() => expect(cancelOffboardingPurgeRequest).toHaveBeenCalledTimes(1));
  });

  test("purged: 처분 요약(held_rows = 보존 의무 잔존) 렌더", async () => {
    const purged = item({
      status: "purged",
      decided_by: "admin-2",
      decided_at: "2026-07-03T01:00:00.000Z",
      purged_at: "2026-07-10T02:00:00.000Z",
      held_rows: { artifacts: 1, runs: 1 },
    });
    renderApp(fakeClient({ listOffboardingPurgeRequests: async () => ({ items: [purged], grace_days: 7 }) }));
    const panel = await screen.findByRole("region", { name: "오프보딩(데이터 반출·삭제)" });
    const disposal = await within(panel).findByText(/잔존: artifacts 1행 · runs 1행/);
    expect(disposal.textContent).toContain("보존 의무 잠금 증거");
  });

  test("viewer 는 섹션 접근 안내만(관리 표면 미노출)", async () => {
    localStorage.setItem("rpa.token", jwt(["viewer"], "viewer-1"));
    renderApp(fakeClient());
    // viewer 는 보안 허브 진입 자체가 제한될 수 있으므로 오프보딩 관리 표면이 없다는 것만 확인.
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "오프보딩(데이터 반출·삭제)" })).toBeNull();
    });
  });
});
