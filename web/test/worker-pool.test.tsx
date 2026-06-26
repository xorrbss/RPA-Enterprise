import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import type { WorkerPoolItem, WorkerPoolList } from "../src/api/types";
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

// 기본 pending(대기 0)으로 WorkerPoolList 를 만든다 — stuck 테스트만 override.
function wpList(items: WorkerPoolItem[], assigned: string | null, pending?: WorkerPoolList["pending"]): WorkerPoolList {
  return { items, assigned_pool_key: assigned, pending: pending ?? { queued_runs: 0, oldest_queued_at: null } };
}

function workerPool(overrides: Partial<WorkerPoolItem>): WorkerPoolItem {
  return {
    pool_key: "pa",
    description: null,
    status: "active",
    max_concurrency: 1,
    priority: "medium",
    created_at: "2026-06-25T00:00:00.000Z",
    updated_at: "2026-06-25T00:00:00.000Z",
    updated_by: null,
    ...overrides,
  };
}

const PA: WorkerPoolItem = workerPool({ pool_key: "pa" });

describe("전용 워커 풀 패널 (DG-3b)", () => {
  beforeEach(() => {
    location.hash = "#security";
    localStorage.clear();
  });

  test("operator 는 워커 풀 패널 미노출(worker_pool.manage admin 전용)", async () => {
    localStorage.setItem("rpa.token", jwt(["operator"]));
    renderApp(fakeClient({ listWorkerPools: async () => wpList([PA], null) }));
    expect(await screen.findByRole("region", { name: "자격증명 동시성 정책" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "전용 워커 풀" })).toBeNull();
  });

  test("admin: 풀 목록 + 현재 배정 + 배정 해제", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    renderApp(
      fakeClient({
        listWorkerPools: async () =>
          wpList([workerPool({ pool_key: "sensitive-finance", description: "재무 민감" })], "sensitive-finance"),
      }),
    );
    const region = await screen.findByRole("region", { name: "전용 워커 풀" });
    expect(within(region).getAllByText("sensitive-finance").length).toBeGreaterThanOrEqual(1);
    expect(within(region).getByText("배정됨")).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "배정 해제" })).toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: "이 테넌트에 배정" })).toBeNull();
  });

  test("admin: 미배정 시 기본 풀 표기", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    renderApp(fakeClient({ listWorkerPools: async () => wpList([PA], null) }));
    const region = await screen.findByRole("region", { name: "전용 워커 풀" });
    expect(within(region).getByText(/기본\(default\)/)).toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: "배정 해제" })).toBeNull();
    expect(within(region).getByRole("button", { name: "이 테넌트에 배정" })).toBeInTheDocument();
  });

  test("admin: 풀 생성 폼 → createWorkerPool 호출", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    let captured: { pool_key: string; description?: string; max_concurrency?: number; priority?: string } | null = null;
    renderApp(
      fakeClient({
        listWorkerPools: async () => wpList([], null),
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
    await waitFor(() => expect(captured).toEqual({ pool_key: "newpool", max_concurrency: 1, priority: "medium" }));
  });

  test("admin: Drain 상태 전환 → updateWorkerPool 호출", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    let captured: { poolKey: string; status?: string } | null = null;
    renderApp(
      fakeClient({
        listWorkerPools: async () => wpList([PA], null),
        updateWorkerPool: async (poolKey, body) => {
          captured = { poolKey, status: body.status };
          return { pool_key: poolKey, ...body };
        },
      }),
    );
    const region = await screen.findByRole("region", { name: "전용 워커 풀" });
    fireEvent.click(within(region).getByRole("button", { name: "Drain" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "확인" }));
    await waitFor(() => expect(captured).toEqual({ poolKey: "pa", status: "draining" }));
  });

  test("admin: 전용 풀 배정 + queued 적체 → 지연 힌트(stuck 가시화)", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    renderApp(
      fakeClient({
        listWorkerPools: async () => wpList([PA], "pa", { queued_runs: 3, oldest_queued_at: tenMinAgo }),
      }),
    );
    const region = await screen.findByRole("region", { name: "전용 워커 풀" });
    expect(within(region).getByText(/대기 실행/)).toBeInTheDocument();
    expect(within(region).getByText(/3건/)).toBeInTheDocument();
    // 5분 초과 적체 + 전용 풀 → 정직한 지연 힌트(단정 아님)
    expect(within(region).getByText(/WORKER_POOL_KEYS/)).toBeInTheDocument();
  });

  test("admin: 미배정(기본 풀) queued 적체는 지연 힌트 없음(기본 풀엔 워커 존재)", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    renderApp(
      fakeClient({
        listWorkerPools: async () => wpList([PA], null, { queued_runs: 2, oldest_queued_at: tenMinAgo }),
      }),
    );
    const region = await screen.findByRole("region", { name: "전용 워커 풀" });
    expect(within(region).getByText(/대기 실행/)).toBeInTheDocument();
    expect(within(region).queryByText(/WORKER_POOL_KEYS/)).toBeNull();
  });
});
