import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { ApiClient } from "../src/api/client";
import { ApiClientProvider } from "../src/api/context";
import type { SiteItem } from "../src/api/types";
import { SiteApprovalControls } from "../src/views/security/SiteApprovalControls";
import { fakeClient } from "./fake-client";

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

function site(overrides: Partial<SiteItem>): SiteItem {
  return {
    site_profile_id: "site-1",
    name: "고위험 사이트",
    risk: "red",
    approval_status: "pending",
    circuit_status: "closed",
    ...overrides,
  };
}

function renderControls(s: SiteItem, overrides: Partial<ApiClient> = {}): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={fakeClient(overrides)}>
        <SiteApprovalControls site={s} />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

describe("site-approval-controls", () => {
  beforeEach(() => {
    localStorage.setItem("rpa.token", jwt(["approver"]));
  });

  test("승인 다이얼로그가 사유·만료를 UTC ISO로 전송한다", async () => {
    const approveSite = vi.fn(async () => ({ site_profile_id: "site-1", approved: true }));
    renderControls(site({}), { approveSite });

    fireEvent.click(screen.getByRole("button", { name: "승인" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("승인 사유 (선택)"), { target: { value: "보안 검토 완료" } });
    const future = new Date(Date.now() + 86_400_000);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const local = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T${pad(future.getHours())}:${pad(future.getMinutes())}`;
    fireEvent.change(within(dialog).getByLabelText(/승인 만료 시각/), { target: { value: local } });
    fireEvent.click(within(dialog).getByRole("button", { name: "승인" }));

    expect(await screen.findByText("승인됨")).toBeInTheDocument();
    expect(approveSite).toHaveBeenCalledTimes(1);
    const [, , opts] = approveSite.mock.calls[0] as unknown as [string, string, { reason?: string; expires_at?: string }];
    expect(opts.reason).toBe("보안 검토 완료");
    // datetime-local(로컬 시각) → UTC ISO 변환(서버 TZ 해석 어긋남 방지).
    expect(opts.expires_at).toBe(new Date(local).toISOString());
  });

  test("과거 만료 시각은 확인 버튼을 차단한다", () => {
    renderControls(site({}));

    fireEvent.click(screen.getByRole("button", { name: "승인" }));
    fireEvent.change(screen.getByLabelText(/승인 만료 시각/), { target: { value: "2020-01-01T09:00" } });

    expect(screen.getByText(/만료 시각이 이미 지났습니다/)).toBeInTheDocument();
    const dialog = screen.getByRole("dialog");
    const confirm = Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "승인");
    expect(confirm).toBeDefined();
    expect(confirm).toBeDisabled();
  });

  test("만료된 승인은 재승인 버튼과 이력을 노출한다", async () => {
    renderControls(
      site({ approval_status: "expired", approved_by: "auth0|approver@corp.example", approval_expires_at: "2026-01-01T00:00:00.000Z" }),
      {
        listSiteApprovals: async () => ({
          items: [
            { approved_by: "auth0|approver@corp.example", reason: "파일럿 한시 승인", expires_at: "2026-01-01T00:00:00.000Z", created_at: "2025-12-01T00:00:00.000Z" },
          ],
          next_cursor: null,
        }),
      },
    );

    expect(screen.getByRole("button", { name: "재승인" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "승인 이력" }));

    expect(await screen.findByText("auth0|approver@corp.example")).toBeInTheDocument();
    expect(screen.getByText(/사유: 파일럿 한시 승인/)).toBeInTheDocument();
    expect(screen.getByText(/만료:/)).toBeInTheDocument();
  });

  test("승인 권한이 없으면 승인 대기 사이트에 아무것도 그리지 않는다", () => {
    localStorage.setItem("rpa.token", jwt(["viewer"]));
    renderControls(site({}));

    expect(screen.queryByRole("button")).toBeNull();
  });
});
