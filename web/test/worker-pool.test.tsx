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

describe("전용 워커 풀 패널 (DG-3b)", () => {
  beforeEach(() => {
    location.hash = "#security";
    localStorage.clear();
  });

  test("operator 는 워커 풀 패널 미노출(worker_pool.manage admin 전용)", async () => {
    localStorage.setItem("rpa.token", jwt(["operator"]));
    renderApp(fakeClient({ listWorkerPools: async () => ({ items: [{ pool_key: "pa", description: null, created_at: "2026-06-25T00:00:00.000Z" }], assigned_pool_key: null }) }));
    // operator 도 보이는 동시성 패널(ops_alert.read)로 Security 뷰 렌더 확인 후, 워커 풀 패널은 게이트로 숨겨짐
    expect(await screen.findByRole("region", { name: "자격증명 동시성 정책" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "전용 워커 풀" })).toBeNull();
  });

  test("admin: 풀 목록 + 현재 배정 + 배정 해제", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    renderApp(
      fakeClient({
        listWorkerPools: async () => ({
          items: [{ pool_key: "sensitive-finance", description: "재무 민감", created_at: "2026-06-25T00:00:00.000Z" }],
          assigned_pool_key: "sensitive-finance",
        }),
      }),
    );
    const region = await screen.findByRole("region", { name: "전용 워커 풀" });
    // 'sensitive-finance'는 현재 배정 배지 + 행 코드 두 곳에 나타난다(중복 정상).
    expect(within(region).getAllByText("sensitive-finance").length).toBeGreaterThanOrEqual(1);
    expect(within(region).getByText("배정됨")).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "배정 해제" })).toBeInTheDocument();
    // 이미 배정된 풀은 '이 풀에 배정' 버튼 미노출
    expect(within(region).queryByRole("button", { name: "이 풀에 배정" })).toBeNull();
  });

  test("admin: 미배정 시 기본 풀 표기", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    renderApp(
      fakeClient({
        listWorkerPools: async () => ({ items: [{ pool_key: "pa", description: null, created_at: "2026-06-25T00:00:00.000Z" }], assigned_pool_key: null }),
      }),
    );
    const region = await screen.findByRole("region", { name: "전용 워커 풀" });
    expect(within(region).getByText(/기본\(default\)/)).toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: "배정 해제" })).toBeNull();
    expect(within(region).getByRole("button", { name: "이 풀에 배정" })).toBeInTheDocument();
  });

  test("admin: 풀 생성 폼 → createWorkerPool 호출", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    let captured: { pool_key: string; description?: string } | null = null;
    renderApp(
      fakeClient({
        listWorkerPools: async () => ({ items: [], assigned_pool_key: null }),
        createWorkerPool: async (body) => {
          captured = body;
          return { pool_key: body.pool_key, description: body.description ?? null };
        },
      }),
    );
    const region = await screen.findByRole("region", { name: "전용 워커 풀" });
    fireEvent.click(within(region).getByRole("button", { name: "풀 만들기" }));
    fireEvent.change(within(region).getByPlaceholderText(/sensitive-finance/), { target: { value: "newpool" } });
    fireEvent.click(within(region).getByRole("button", { name: "생성" }));
    await waitFor(() => expect(captured).toEqual({ pool_key: "newpool" }));
  });
});
