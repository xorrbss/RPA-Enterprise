import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { fakeClient } from "./fake-client";

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

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

describe("adoption evidence route", () => {
  beforeEach(() => {
    location.hash = "#adoptionEvidence";
    localStorage.setItem("rpa.token", jwt(["viewer"]));
  });

  test("direct route renders readiness and metadata-only evidence packet", async () => {
    renderApp(
      fakeClient({
        getAuthReadiness: async () => ({
          ...(await fakeClient().getAuthReadiness()),
          status: "warning",
          enterprise_sso_ready: false,
          role_mapping: { configured: false, mapped_values: 0 },
          operational_gaps: ["SSO 설정 확인 필요"],
          current_principal: {
            ...(await fakeClient().getAuthReadiness()).current_principal,
            subject_id: "u",
            roles: ["viewer"],
          },
        }),
        listSites: async () => ({ items: [], next_cursor: null }),
        listScenarios: async () => ({ items: [], next_cursor: null }),
        listRuns: async () => ({ items: [], next_cursor: null }),
        getRunSummary: async () => ({ by_status: {}, success_rate: null, total: 0, cache: { by_mode: {}, hit_rate: null } }),
      }),
    );

    expect(await screen.findByRole("heading", { level: 1, name: "도입 증빙" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "도입 증빙 작업대" })).toBeInTheDocument();
    const readiness = await screen.findByRole("region", { name: "파일럿 준비 상태" });
    const packet = await screen.findByRole("region", { name: "도입 증빙 패킷" });

    expect(within(readiness).getByText("SSO")).toBeInTheDocument();
    expect(within(readiness).queryByRole("button", { name: "접속 설정 확인" })).toBeNull();
    expect(within(readiness).getAllByText("권한 있는 담당자에게 요청").length).toBeGreaterThanOrEqual(2);
    expect(within(packet).getByText(/metadata-only 증빙/)).toBeInTheDocument();
    expect(within(packet).getByText(/Negative proof/)).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toContain("must-not-leak");
    expect(document.body.textContent ?? "").not.toContain("raw_prompt");
  });

  test("readiness uses approved sites and successful test runs as shared criteria", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    renderApp(
      fakeClient({
        getAuthReadiness: async () => ({
          ...(await fakeClient().getAuthReadiness()),
          status: "ok",
          enterprise_sso_ready: true,
          role_mapping: { configured: true, mapped_values: 3 },
          operational_gaps: [],
          current_principal: {
            ...(await fakeClient().getAuthReadiness()).current_principal,
            subject_id: "admin-a",
            roles: ["admin"],
          },
        }),
        listSites: async () => ({
          items: [
            {
              site_profile_id: "site-pending",
              name: "승인 대기 포털",
              risk: "green",
              approval_status: "pending",
              circuit_status: "closed",
              login_capable: true,
              session_ready: true,
            },
          ],
          next_cursor: null,
        }),
        listScenarios: async () => ({
          items: [{ scenario_id: "scenario-1", name: "Invoice lookup", version: 1, latest_version_id: "version-1", promotion_status: "draft" }],
          next_cursor: null,
        }),
        listRuns: async () => ({
          items: [
            {
              run_id: "run-failed-test",
              status: "failed_system",
              run_mode: "test",
              scenario_name: "Invoice lookup",
              current_node: null,
              as_of: "2026-06-30T03:00:00.000Z",
              failure_reason: null,
            },
          ],
          next_cursor: null,
        }),
      }),
    );

    const readiness = await screen.findByRole("region", { name: "파일럿 준비 상태" });
    const siteGate = within(readiness).getByText("사이트").closest("li");
    const testGate = within(readiness).getByText("테스트 실행").closest("li");
    if (siteGate === null || testGate === null) throw new Error("readiness gate not found");

    await waitFor(() => expect(siteGate).toHaveTextContent("차단"));
    expect(siteGate).toHaveTextContent("등록된 사이트가 있지만 아직 승인된 실행 대상은 없습니다.");
    await waitFor(() => expect(testGate).toHaveTextContent("차단"));
    expect(testGate).toHaveTextContent("최근 테스트가 시스템 실패 상태입니다.");
    expect(readiness).not.toHaveTextContent("9/9 준비");
  });

  test("recent execution evidence opens the latest run artifacts focus", async () => {
    renderApp(
      fakeClient({
        listRuns: async () => ({
          items: [
            {
              run_id: "run-evidence-1",
              status: "completed",
              run_mode: "prod",
              current_node: null,
              as_of: "2026-06-30T03:00:00.000Z",
              failure_reason: null,
            },
          ],
          next_cursor: null,
        }),
      }),
    );

    const workbench = await screen.findByRole("region", { name: "도입 증빙 작업대" });
    fireEvent.click(await within(workbench).findByRole("button", { name: "최근 실행 증빙" }));
    await waitFor(() => expect(location.hash).toBe("#runTrace?run=run-evidence-1&focus=artifacts"));
  });

  test("admin workbench links evidence packet without routing through dashboard focus", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    renderApp();

    const setup = await screen.findByRole("region", { name: "관리자 도입 설정" });
    within(setup).getByRole("button", { name: "증빙 패킷 보기" }).click();

    await waitFor(() => expect(location.hash).toBe("#adoptionEvidence"));
  });
});
