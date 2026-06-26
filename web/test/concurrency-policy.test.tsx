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

describe("Credential concurrency panel", () => {
  beforeEach(() => {
    location.hash = "#security";
    localStorage.clear();
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  test("renders policy rows with capacity and lifecycle metadata", async () => {
    renderApp(
      fakeClient({
        listConcurrencyPolicies: async () => ({
          items: [
            {
              credential_ref: "rpa/prod/runtime-worker/executor/hr_pw",
              site_profile_id: "s1",
              site_name: "급여시스템",
              max_concurrency: 3,
              active_leases: 1,
              label: "하이웍스 운영 계정",
              status: "active",
              owner_sub: "ops-admin",
              rotation_policy: "periodic_90d",
              last_used_at: "2026-06-26T00:00:00.000Z",
            },
            {
              credential_ref: "rpa/prod/runtime-worker/executor/erp_pw_old",
              site_profile_id: "s2",
              site_name: "ERP",
              max_concurrency: 1,
              active_leases: 1,
              status: "deprecated",
              replaced_by_credential_ref: "rpa/prod/runtime-worker/executor/erp_pw",
            },
          ],
          next_cursor: null,
        }),
      }),
    );
    const region = await screen.findByRole("region", { name: "자격증명 동시성 정책" });
    expect(within(region).getByText("급여시스템")).toBeInTheDocument();
    expect(within(region).getByText("하이웍스 운영 계정")).toBeInTheDocument();
    expect(within(region).getByText(/2 여유/)).toBeInTheDocument();
    expect(within(region).getByText("교체됨")).toBeInTheDocument();
    expect(within(region).getByText(/ops-admin/)).toBeInTheDocument();
  });

  test("shows an empty state when no policy exists", async () => {
    renderApp(fakeClient({ listConcurrencyPolicies: async () => ({ items: [], next_cursor: null }) }));
    expect(await screen.findByText(/설정된 Credential 정책이 없습니다/)).toBeInTheDocument();
  });
});

describe("Credential reference lifecycle actions", () => {
  beforeEach(() => {
    location.hash = "#security";
    localStorage.clear();
  });

  test("operator cannot see register, rotate, or decommission controls", async () => {
    localStorage.setItem("rpa.token", jwt(["operator"]));
    renderApp(
      fakeClient({
        listConcurrencyPolicies: async () => ({
          items: [
            {
              credential_ref: "rpa/prod/runtime-worker/executor/hr_pw",
              site_profile_id: "s1",
              site_name: "급여시스템",
              max_concurrency: 2,
              active_leases: 0,
            },
          ],
          next_cursor: null,
        }),
      }),
    );
    const region = await screen.findByRole("region", { name: "자격증명 동시성 정책" });
    expect(within(region).queryByRole("button", { name: "참조 등록" })).toBeNull();
    expect(within(region).queryByRole("button", { name: "회전" })).toBeNull();
    expect(within(region).queryByRole("button", { name: "폐기" })).toBeNull();
  });

  test("admin registers a SecretRef path without any secret value field", async () => {
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
    expect(region.querySelector("input[type=password]")).toBeNull();
    expect(within(region).getByText(/비밀번호나 토큰 값은 입력하지 않습니다/)).toBeInTheDocument();
    fireEvent.change(within(region).getByPlaceholderText(/rpa\/prod\/runtime-worker\/executor/), {
      target: { value: "rpa/prod/runtime-worker/executor/hr_pw" },
    });
    const siteOption = await within(region).findByRole("option", { name: "급여시스템" });
    const select = siteOption.closest("select");
    if (select === null) throw new Error("site select not found");
    fireEvent.change(select, { target: { value: "site-1" } });
    fireEvent.click(within(region).getByRole("button", { name: "등록" }));
    await waitFor(() =>
      expect(captured).toEqual({
        credential_ref: "rpa/prod/runtime-worker/executor/hr_pw",
        site_profile_id: "site-1",
        max_concurrency: 1,
      }),
    );
  });

  test("admin rotates an active credential by supplying only a replacement SecretRef", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    let captured: unknown = null;
    renderApp(
      fakeClient({
        listConcurrencyPolicies: async () => ({
          items: [
            {
              credential_ref: "rpa/prod/runtime-worker/executor/hr_pw",
              site_profile_id: "s1",
              site_name: "급여시스템",
              max_concurrency: 3,
              active_leases: 0,
              status: "active",
            },
          ],
          next_cursor: null,
        }),
        rotateCredentialBinding: async (body) => {
          captured = body;
          return {
            credential_ref: body.credential_ref,
            site_profile_id: body.site_profile_id,
            status: "deprecated",
            replaced_by_credential_ref: body.new_credential_ref,
            replacement: {
              credential_ref: body.new_credential_ref,
              site_profile_id: body.site_profile_id,
              max_concurrency: 3,
              status: "active",
            },
          };
        },
      }),
    );
    const region = await screen.findByRole("region", { name: "자격증명 동시성 정책" });
    fireEvent.click(within(region).getByRole("button", { name: "회전" }));
    fireEvent.change(within(region).getByPlaceholderText("새 SecretRef 경로"), {
      target: { value: "rpa/prod/runtime-worker/executor/hr_pw_v2" },
    });
    fireEvent.change(within(region).getByPlaceholderText("회전 사유 (선택)"), { target: { value: "scheduled" } });
    fireEvent.click(within(region).getByRole("button", { name: "확인" }));
    await waitFor(() =>
      expect(captured).toEqual({
        credential_ref: "rpa/prod/runtime-worker/executor/hr_pw",
        new_credential_ref: "rpa/prod/runtime-worker/executor/hr_pw_v2",
        site_profile_id: "s1",
        reason: "scheduled",
      }),
    );
  });

  test("admin sees decommission control on manageable rows", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    renderApp(
      fakeClient({
        listConcurrencyPolicies: async () => ({
          items: [
            {
              credential_ref: "rpa/prod/runtime-worker/executor/hr_pw",
              site_profile_id: "s1",
              site_name: "급여시스템",
              max_concurrency: 3,
              active_leases: 1,
            },
          ],
          next_cursor: null,
        }),
      }),
    );
    const region = await screen.findByRole("region", { name: "자격증명 동시성 정책" });
    expect(await within(region).findByText("rpa/prod/runtime-worker/executor/hr_pw")).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "폐기" })).toBeInTheDocument();
  });
});
