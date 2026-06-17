import { beforeEach, describe, expect, test } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { fakeClient } from "./fake-client";

// 작업항목·사람확인 상세 드릴다운(getWorkitem/getHumanTask) + 원본 실행 교차 동선. smoke.test.tsx(500라인 한도)에서
// 의미 단위로 분리(CLAUDE.md #7). 표시값은 reads.ts 실 투영 필드만, run_id null이면 링크 미생성(fabrication 가드).
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
function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}
const ALL_ROLES = ["viewer", "operator", "reviewer", "approver", "admin"];

describe("작업항목·사람확인 상세 드릴다운", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", jwt(ALL_ROLES));
  });

  // T1 — 작업항목 drill-down: '상세' → getWorkitem 호출 + attempts·checked_out_by 실 필드 표출(실측 노출).
  test("작업항목 drill-down — getWorkitem 패널(시도/점유자 표시)", async () => {
    const calls: string[] = [];
    renderApp(
      fakeClient({
        listWorkitems: async () => ({
          items: [{ workitem_id: "wi-abc12345", status: "processing", unique_reference: "ref-1", attempts: 3, checked_out_by: "w-9", checked_out_at: "2026-06-15T00:00:00.000Z", run_id: "11111111-aaaa-bbbb-cccc-000000000001" }],
          next_cursor: null,
        }),
        getWorkitem: async (id) => {
          calls.push(id);
          return { workitem_id: id, status: "processing", unique_reference: "ref-1", attempts: 3, checked_out_by: "w-9", checked_out_at: "2026-06-15T00:00:00.000Z", run_id: "11111111-aaaa-bbbb-cccc-000000000001" };
        },
      }),
    );
    location.hash = "#workitems";
    (await screen.findByRole("button", { name: "상세" })).click();
    await waitFor(() => expect(calls).toContain("wi-abc12345"));
    const panel = await screen.findByRole("region", { name: "작업항목 상세" });
    await within(panel).findByText("w-9"); // checked_out_by(실 필드) — 상세 쿼리 resolve 후 표시
    expect(within(panel).getByText("3")).toBeInTheDocument(); // attempts(실 필드)
  });

  // T2 — run_id 채워진 작업항목 → '원본 실행 보기' → #runTrace?run=<id> 교차 동선.
  test("작업항목 상세: run_id 있으면 '원본 실행 보기' → runTrace 해시", async () => {
    renderApp(
      fakeClient({
        listWorkitems: async () => ({
          items: [{ workitem_id: "wi-1", status: "successful", unique_reference: "ref", attempts: 1, checked_out_by: null, checked_out_at: null, run_id: "run-xyz" }],
          next_cursor: null,
        }),
        getWorkitem: async (id) => ({ workitem_id: id, status: "successful", unique_reference: "ref", attempts: 1, checked_out_by: null, checked_out_at: null, run_id: "run-xyz" }),
      }),
    );
    location.hash = "#workitems";
    (await screen.findByRole("button", { name: "상세" })).click();
    (await screen.findByRole("button", { name: /원본 실행 보기/ })).click();
    await waitFor(() => expect(location.hash).toBe("#runTrace?run=run-xyz"));
  });

  // T3(fabrication 가드) — run_id:null이면 '원본 실행 보기' 버튼을 만들지 않는다(가짜 링크 미생성).
  test("작업항목 상세: run_id null이면 '원본 실행 보기' 미렌더(fabrication 가드)", async () => {
    renderApp(
      fakeClient({
        listWorkitems: async () => ({
          items: [{ workitem_id: "wi-2", status: "new", unique_reference: "ref", attempts: 0, checked_out_by: null, checked_out_at: null, run_id: null }],
          next_cursor: null,
        }),
        getWorkitem: async (id) => ({ workitem_id: id, status: "new", unique_reference: "ref", attempts: 0, checked_out_by: null, checked_out_at: null, run_id: null }),
      }),
    );
    location.hash = "#workitems";
    (await screen.findByRole("button", { name: "상세" })).click();
    const panel = await screen.findByRole("region", { name: "작업항목 상세" });
    await within(panel).findByText("— (미점유)"); // 상세 쿼리 resolve(checked_out_by null) 후 단언 — 로딩 중 false-pass 방지
    expect(within(panel).queryByRole("button", { name: /원본 실행 보기/ })).toBeNull();
  });

  // T4 — 사람확인 drill-down: '상세' → getHumanTask on_timeout 라벨 + 상태별 액션(HumanTaskActions) 재사용.
  test("사람확인 drill-down — getHumanTask 패널(만료 시 처리 + 액션)", async () => {
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({
          items: [{ human_task_id: "ht-d1", state: "in_progress", kind: "approval", assignee: "u-1", timeout: null, on_timeout: "escalate", run_id: null }],
          next_cursor: null,
        }),
        getHumanTask: async (id) => ({ human_task_id: id, state: "in_progress", kind: "approval", assignee: "u-1", timeout: null, on_timeout: "escalate", run_id: null }),
      }),
    );
    location.hash = "#humanTasks";
    (await screen.findByRole("button", { name: "상세" })).click();
    const panel = await screen.findByRole("region", { name: "사람확인 상세" });
    await within(panel).findByText("escalate"); // on_timeout(실 컬럼) — 상세 쿼리 resolve 후 표시
    expect(within(panel).getByRole("button", { name: "처리완료" })).toBeInTheDocument(); // in_progress 액션(HumanTaskActions 재사용)
  });

  // T5 — run_id 채워진 사람확인 → '원본 실행 보기' → runTrace 해시.
  test("사람확인 상세: run_id 있으면 '원본 실행 보기' → runTrace 해시", async () => {
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({
          items: [{ human_task_id: "ht-r", state: "open", kind: "validation", assignee: null, timeout: null, on_timeout: null, run_id: "run-ht" }],
          next_cursor: null,
        }),
        getHumanTask: async (id) => ({ human_task_id: id, state: "open", kind: "validation", assignee: null, timeout: null, on_timeout: null, run_id: "run-ht" }),
      }),
    );
    location.hash = "#humanTasks";
    (await screen.findByRole("button", { name: "상세" })).click();
    (await screen.findByRole("button", { name: /원본 실행 보기/ })).click();
    await waitFor(() => expect(location.hash).toBe("#runTrace?run=run-ht"));
  });

  // T6(fabrication 가드) — run_id:null → '원본 실행 보기' 미렌더.
  test("사람확인 상세: run_id null이면 '원본 실행 보기' 미렌더(fabrication 가드)", async () => {
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({
          items: [{ human_task_id: "ht-n", state: "open", kind: "approval", assignee: null, timeout: null, on_timeout: "escalate", run_id: null }],
          next_cursor: null,
        }),
      }),
    );
    location.hash = "#humanTasks";
    (await screen.findByRole("button", { name: "상세" })).click();
    const panel = await screen.findByRole("region", { name: "사람확인 상세" });
    await within(panel).findByText("escalate"); // on_timeout — 상세 쿼리 resolve 후 단언(로딩 중 false-pass 방지)
    expect(within(panel).queryByRole("button", { name: /원본 실행 보기/ })).toBeNull();
  });
});
