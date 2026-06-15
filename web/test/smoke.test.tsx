import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    await waitFor(() => expect(screen.getByText("조건에 맞는 작업 항목이 없습니다.")).toBeInTheDocument());
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

  test("human-task 처리완료(resolve) 디스패치", async () => {
    const calls: string[] = [];
    window.confirm = () => true;
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({
          items: [{ human_task_id: "ht-1", state: "in_progress", kind: "approval", assignee: null, timeout: null, run_id: null }],
          next_cursor: null,
        }),
        resolveHumanTask: async (id) => {
          calls.push(id);
          return {};
        },
      }),
    );
    location.hash = "#humanTasks";
    const btn = await screen.findByRole("button", { name: "처리완료" });
    btn.click();
    await waitFor(() => expect(calls).toContain("ht-1"));
  });

  test("scenario prod 승격 디스패치 (If-Match=version)", async () => {
    const calls: Array<{ id: string; version: number }> = [];
    window.confirm = () => true;
    renderApp(
      fakeClient({
        listScenarios: async () => ({
          items: [{ scenario_id: "22222222-aaaa-bbbb-cccc-000000000001", name: "리뷰 수집", version: 3, latest_version_id: "33333333-aaaa-bbbb-cccc-000000000001" }],
          next_cursor: null,
        }),
        promoteScenario: async (id, version) => {
          calls.push({ id, version });
          return { version, promotion_status: "prod" };
        },
      }),
    );
    location.hash = "#scenarioStudio";
    const btn = await screen.findByRole("button", { name: "prod 승격" });
    btn.click();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ id: "22222222-aaaa-bbbb-cccc-000000000001", version: 3 });
  });

  test("페이지네이션: next_cursor 있으면 '다음' 클릭 시 cursor 전달", async () => {
    const calls: Array<Record<string, unknown>> = [];
    renderApp(
      fakeClient({
        listRuns: async (p) => {
          calls.push(p ?? {});
          // 커서 기준(호출 횟수 무관): 첫 페이지→cursor-1, 진행 후→끝.
          return { items: [{ run_id: "r1", status: "running", current_node: null, as_of: null }], next_cursor: p?.cursor ? null : "cursor-1" };
        },
      }),
    );
    location.hash = "#runTrace";
    const nextBtn = await screen.findByRole("button", { name: "다음" });
    expect(nextBtn).not.toBeDisabled();
    nextBtn.click();
    await waitFor(() => expect(calls.some((c) => c.cursor === "cursor-1")).toBe(true));
  });

  test("필터: 상태 선택 시 fetcher에 status 전달", async () => {
    const calls: Array<Record<string, unknown>> = [];
    renderApp(
      fakeClient({
        listRuns: async (p) => {
          calls.push(p ?? {});
          return { items: [], next_cursor: null };
        },
      }),
    );
    location.hash = "#runTrace";
    const select = await screen.findByLabelText("상태");
    fireEvent.change(select, { target: { value: "running" } });
    await waitFor(() => expect(calls.some((c) => c.status === "running")).toBe(true));
  });

  test("시나리오 검사: validate 디스패치 + ValidationReport 렌더", async () => {
    const calls: Array<{ id: string }> = [];
    renderApp(
      fakeClient({
        validateScenario: async (id) => {
          calls.push({ id });
          return { valid: false, report: { errors: [{ rule: "V3", message: "no branch matched" }], warnings: [] } };
        },
      }),
    );
    location.hash = "#irValidation";
    const idInput = await screen.findByPlaceholderText(/00000000/);
    fireEvent.change(idInput, { target: { value: "scn-1" } });
    screen.getByRole("button", { name: "검사 실행" }).click();
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(screen.getByText("거부")).toBeInTheDocument());
    expect(screen.getByText(/no branch matched/)).toBeInTheDocument();
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
