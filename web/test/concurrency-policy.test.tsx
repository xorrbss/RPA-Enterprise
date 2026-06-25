import { beforeEach, describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
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
