import { beforeEach, describe, expect, test } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { fakeClient } from "./fake-client";

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

describe("D7 운영 콘솔 shell", () => {
  beforeEach(() => {
    location.hash = "";
  });

  test("사이드바 + 11 nav item 렌더", () => {
    renderApp();
    const nav = screen.getByRole("navigation", { name: "주 메뉴" });
    expect(within(nav).getAllByRole("button")).toHaveLength(11);
  });

  test("기본 라우트 = dashboard (지표 + 최근 실행)", async () => {
    renderApp();
    expect(screen.getByRole("heading", { level: 1, name: "RPA 운영 대시보드" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("최근 실행")).toBeInTheDocument());
    // fake 실행이 running 상태로 표시
    await waitFor(() => expect(screen.getByText("running")).toBeInTheDocument());
  });

  test("해시 라우팅 → workitems", async () => {
    renderApp();
    location.hash = "#workitems";
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1, name: "작업 목록" })).toBeInTheDocument(),
    );
    // 빈 상태는 쿼리 resolve 후 표시(로딩 → 빈)
    await waitFor(() => expect(screen.getByText("작업 항목이 없습니다.")).toBeInTheDocument());
  });

  test("잘못된 해시 → dashboard 폴백", async () => {
    renderApp();
    location.hash = "#nonsense";
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1, name: "RPA 운영 대시보드" })).toBeInTheDocument(),
    );
  });

  test("오류 상태 표면화 (조용한 빈화면 금지)", async () => {
    renderApp(
      fakeClient({
        listRuns: async () => {
          throw new Error("boom");
        },
      }),
    );
    await waitFor(() => expect(screen.getByText("불러오지 못했습니다")).toBeInTheDocument());
  });

  test("운영자 명령: 실행 취소(abort) 디스패치 + Idempotency-Key", async () => {
    const calls: Array<{ runId: string; key: string }> = [];
    const client = fakeClient({
      abortRun: async (runId, key) => {
        calls.push({ runId, key });
        return { status: "cancelled" };
      },
    });
    window.confirm = () => true; // jsdom confirm 스텁
    renderApp(client);
    location.hash = "#runTrace";
    const abortBtn = await screen.findByRole("button", { name: "취소" });
    abortBtn.click();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.runId).toBe("11111111-aaaa-bbbb-cccc-000000000001");
    expect(calls[0]?.key.length).toBeGreaterThan(0); // crypto.randomUUID 멱등키
    await waitFor(() => expect(screen.getByText("완료")).toBeInTheDocument());
  });

  test("운영자 명령 실패 → 코드 표면화", async () => {
    const { ApiError } = await import("../src/api/types");
    window.confirm = () => true;
    renderApp(
      fakeClient({
        abortRun: async () => {
          throw new ApiError(409, "RUN_ABORTED", { code: "RUN_ABORTED" });
        },
      }),
    );
    location.hash = "#runTrace";
    const abortBtn = await screen.findByRole("button", { name: "취소" });
    abortBtn.click();
    await waitFor(() => expect(screen.getByText("RUN_ABORTED (409)")).toBeInTheDocument());
  });
});
