import { beforeEach, describe, expect, test } from "vitest";
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

describe("동시성 정책 패널 (D5b)", () => {
  beforeEach(() => {
    location.hash = "#security";
    localStorage.clear();
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  test("정책 목록 + 사용량/여유(포화) 표시", async () => {
    renderApp(
      fakeClient({
        listConcurrencyPolicies: async () => ({
          items: [
            { credential_ref: "hr-bot", site_profile_id: "s1", site_name: "급여시스템", max_concurrency: 3, active_leases: 1 },
            { credential_ref: "erp-bot", site_profile_id: "s2", site_name: "ERP", max_concurrency: 1, active_leases: 1 },
          ],
          next_cursor: null,
        }),
      }),
    );
    expect(await screen.findByText("급여시스템")).toBeInTheDocument();
    expect(screen.getByText("hr-bot")).toBeInTheDocument();
    expect(screen.getByText("2 여유")).toBeInTheDocument(); // 3 - 1
    expect(screen.getByText("포화")).toBeInTheDocument(); // 1 - 1 = 0
  });

  test("정책 없으면 정직한 빈 표기", async () => {
    renderApp(fakeClient({ listConcurrencyPolicies: async () => ({ items: [], next_cursor: null }) }));
    expect(await screen.findByText(/설정된 동시성 정책이 없습니다/)).toBeInTheDocument();
  });
});

describe("자격증명 참조 등록/삭제 (DG-4)", () => {
  beforeEach(() => {
    location.hash = "#security";
    localStorage.clear();
  });

  test("operator 는 참조 등록/삭제 UI 미노출(credential.manage=admin 전용)", async () => {
    localStorage.setItem("rpa.token", jwt(["operator"]));
    renderApp(
      fakeClient({
        listConcurrencyPolicies: async () => ({
          items: [{ credential_ref: "hr-bot", site_profile_id: "s1", site_name: "급여시스템", max_concurrency: 2, active_leases: 0 }],
          next_cursor: null,
        }),
      }),
    );
    const region = await screen.findByRole("region", { name: "자격증명 동시성 정책" });
    expect(within(region).queryByRole("button", { name: "참조 등록" })).toBeNull();
    expect(within(region).queryByRole("button", { name: "삭제" })).toBeNull();
  });

  test("admin 등록 폼: ⛔ 값 입력란 없음 — 경로/사이트/한도만으로 등록", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    let captured: unknown = null;
    renderApp(
      fakeClient({
        listConcurrencyPolicies: async () => ({ items: [], next_cursor: null }),
        listSites: async () => ({
          items: [{ site_profile_id: "site-1", risk: "green", approval_status: "approved", circuit_status: "closed", name: "급여시스템" }],
          next_cursor: null,
        }),
        registerCredentialBinding: async (body) => {
          captured = body;
          return body;
        },
      }),
    );
    const region = await screen.findByRole("region", { name: "자격증명 동시성 정책" });
    fireEvent.click(within(region).getByRole("button", { name: "참조 등록" }));
    // ⛔ 핵심 negative control: 비밀번호/값 입력란이 존재하지 않는다(값은 out-of-band Vault/KMS).
    expect(region.querySelector("input[type=password]")).toBeNull();
    expect(within(region).getByText(/값은 여기에 입력하지 않습니다/)).toBeInTheDocument();
    // 경로 + 사이트(이름 picker) + 한도(기본 1) 로 등록
    fireEvent.change(within(region).getByPlaceholderText(/rpa\/prod\/runtime-worker\/executor/), {
      target: { value: "rpa/prod/runtime-worker/executor/hr_pw" },
    });
    const siteOption = await within(region).findByRole("option", { name: "급여시스템" });
    const select = siteOption.closest("select");
    if (select === null) throw new Error("site select not found");
    fireEvent.change(select, { target: { value: "site-1" } });
    fireEvent.click(within(region).getByRole("button", { name: "등록" }));
    await waitFor(() =>
      expect(captured).toEqual({ credential_ref: "rpa/prod/runtime-worker/executor/hr_pw", site_profile_id: "site-1", max_concurrency: 1 }),
    );
  });

  test("admin: 정책 행에 삭제 버튼 노출", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    renderApp(
      fakeClient({
        listConcurrencyPolicies: async () => ({
          items: [{ credential_ref: "hr-bot", site_profile_id: "s1", site_name: "급여시스템", max_concurrency: 3, active_leases: 1 }],
          next_cursor: null,
        }),
      }),
    );
    const region = await screen.findByRole("region", { name: "자격증명 동시성 정책" });
    expect(await within(region).findByText("hr-bot")).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "삭제" })).toBeInTheDocument();
  });
});
