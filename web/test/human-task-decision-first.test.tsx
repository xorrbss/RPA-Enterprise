import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import type { HumanTaskItem } from "../src/api/types";
import { fakeClient } from "./fake-client";

// T5(감사 P1-8): 승인 업무는 열자마자 결정([승인][반려])이 1차 액션 — 시작/이관 2단계 우회 제거.
// 전이는 일괄 승인이 검증한 H1→H2→H3 체인을 단건 재사용(단계별 결정형 멱등키), 구조화 검토 업무는 제외.

function jwt(roles: readonly string[], sub = "op-1"): string {
  const payload = btoa(JSON.stringify({ sub, tenant_id: "t", roles }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

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

function approvalTask(overrides: Partial<HumanTaskItem> = {}): HumanTaskItem {
  return {
    human_task_id: "ht-approve-1",
    state: "open",
    kind: "approval",
    assignee: null,
    timeout: null,
    on_timeout: "escalate",
    run_id: null,
    ...overrides,
  } as HumanTaskItem;
}

describe("human task decision-first", () => {
  beforeEach(() => {
    location.hash = "#humanTasks";
    localStorage.setItem("rpa.token", jwt(["operator", "reviewer", "approver"]));
  });

  test("열린 승인 업무는 [승인]이 assign→start→resolve(approve) 체인으로 한 번에 처리된다", async () => {
    const calls: string[] = [];
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({ items: [approvalTask()], next_cursor: null }),
        assignHumanTask: async (id, assignee) => {
          calls.push(`assign:${id}:${assignee}`);
          return approvalTask({ state: "assigned", assignee });
        },
        startHumanTask: async (id) => {
          calls.push(`start:${id}`);
          return approvalTask({ state: "in_progress" });
        },
        resolveHumanTask: async (id, _key, result) => {
          calls.push(`resolve:${id}:${JSON.stringify(result)}`);
          return approvalTask({ state: "resolved" });
        },
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "승인" }));
    // ActionButton 확인 다이얼로그 — 실제 실행 전 확인은 유지된다(위험 액션).
    fireEvent.click(await screen.findByRole("button", { name: "확인" }));

    await waitFor(() => expect(calls.some((c) => c.startsWith("resolve:ht-approve-1"))).toBe(true));
    expect(calls[0]).toBe("assign:ht-approve-1:op-1");
    expect(calls[1]).toBe("start:ht-approve-1");
    expect(calls[2]).toContain('"decision":"approve"');
  });

  test("[반려]는 사유 없이 실행되지 않고, 사유와 함께 reject로 처리된다", async () => {
    const resolves: unknown[] = [];
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({ items: [approvalTask()], next_cursor: null }),
        assignHumanTask: async (_id, assignee) => approvalTask({ state: "assigned", assignee }),
        startHumanTask: async () => approvalTask({ state: "in_progress" }),
        resolveHumanTask: async (_id, _key, result) => {
          resolves.push(result);
          return approvalTask({ state: "resolved" });
        },
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "반려" }));
    const reasonInput = await screen.findByLabelText("반려 사유");
    fireEvent.change(reasonInput, { target: { value: "금액 불일치" } });
    fireEvent.click(screen.getByRole("button", { name: "확인" }));

    await waitFor(() => expect(resolves).toHaveLength(1));
    expect(resolves[0]).toEqual({ decision: "reject", reason: "금액 불일치" });
  });

  test("구조화 검토(양식·증빙) 업무에는 승인/반려 단축이 없다 — blanket 결정 차단", async () => {
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({
          items: [approvalTask({ human_task_id: "ht-form-1", result_schema: { version: "business_form_v1", fields: [] } as unknown as Record<string, unknown> })],
          next_cursor: null,
        }),
      }),
    );

    await screen.findAllByText("승인 요청");
    expect(screen.queryByRole("button", { name: "승인" })).toBeNull();
    expect(screen.queryByRole("button", { name: "반려" })).toBeNull();
  });

  test("문서 검증 업무가 없으면 0짜리 요약 타일 3개를 렌더하지 않는다", async () => {
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({ items: [approvalTask()], next_cursor: null }),
      }),
    );

    await screen.findByText("승인 요청");
    expect(screen.queryByText("검증 대기 문서")).toBeNull();
    expect(screen.queryByText("증빙 자료 있음")).toBeNull();
    expect(screen.queryByText("업무 입력 필요")).toBeNull();
  });

  test("타인에게 배정된 승인 업무에는 승인/반려 단축이 없다(가로채기 방지)", async () => {
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({ items: [approvalTask({ state: "assigned", assignee: "someone-else" })], next_cursor: null }),
      }),
    );

    await screen.findAllByText("승인 요청");
    expect(screen.queryByRole("button", { name: "승인" })).toBeNull();
    expect(screen.queryByRole("button", { name: "반려" })).toBeNull();
  });
});
