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
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

// 문서 검증 업무(kind=validation + 증빙) 1건 + 일반 승인 업무 1건 — 둘 다 open(일괄 배정 대상).
const DOC_TASK = { human_task_id: "73000000-0000-0000-0000-0000000000d1", state: "open", kind: "validation", assignee: null, timeout: null, on_timeout: "escalate", run_id: null, artifact_refs: ["a1"] };
const PLAIN_TASK = { human_task_id: "73000000-0000-0000-0000-0000000000a2", state: "open", kind: "approval", assignee: null, timeout: null, on_timeout: "escalate", run_id: null };

describe("HumanTasks 일괄 동작 안전성", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", jwt(["viewer", "operator", "reviewer", "approver", "admin"]));
  });

  test("첫 화면에 현재 보기와 다음 처리 업무를 표보다 먼저 요약한다", async () => {
    const DUE_DOC_TASK = { ...DOC_TASK, timeout: "2026-06-18T10:00:00.000Z" };
    renderApp(fakeClient({ listHumanTasks: async () => ({ items: [DUE_DOC_TASK, PLAIN_TASK], next_cursor: null }) }));
    location.hash = "#humanTasks";

    const summary = await screen.findByRole("region", { name: "사람 확인 현재 보기 요약" });
    expect(await within(summary).findByRole("heading", { name: "현재 보기 2건 · 처리 대기 2건" })).toBeInTheDocument();
    expect(within(summary).getByText("다음 처리")).toBeInTheDocument();
    expect(within(summary).getByText("접수번호 #73000000")).toBeInTheDocument();
    expect(within(summary).getByText("종류 문서 검증")).toBeInTheDocument();

    fireEvent.click(within(summary).getByRole("button", { name: "다음 처리 열기" }));
    await waitFor(() => expect(location.hash).toContain(`ht=${DUE_DOC_TASK.human_task_id}`));
  });

  test("현재 필터에 처리 대기 업무가 없으면 다음 업무를 지어내지 않는다", async () => {
    renderApp(fakeClient({ listHumanTasks: async () => ({ items: [PLAIN_TASK], next_cursor: null }) }));
    location.hash = "#humanTasks";

    const controls = await screen.findByRole("region", { name: "검토 업무 목록 제어" });
    fireEvent.click(within(controls).getByRole("button", { name: "마감 임박 0" }));

    const summary = await screen.findByRole("region", { name: "사람 확인 현재 보기 요약" });
    expect(within(summary).getByRole("heading", { name: "현재 보기 0건 · 처리 대기 0건" })).toBeInTheDocument();
    expect(within(summary).getByText("현재 보기에서 처리 대기 업무가 없습니다.")).toBeInTheDocument();
    expect(within(summary).queryByRole("button", { name: "다음 처리 열기" })).toBeNull();
  });

  test("일괄 대상이 화면 필터(문서 검증만)와 일치한다 — pageItems가 아닌 visibleItems 기준", async () => {
    renderApp(fakeClient({ listHumanTasks: async () => ({ items: [DOC_TASK, PLAIN_TASK], next_cursor: null }) }));
    location.hash = "#humanTasks";

    // 필터 없음: 두 건 모두 대상.
    expect(await screen.findByRole("button", { name: "현재 목록 2건 담당자 지정" })).toBeInTheDocument();

    // '문서 검증 업무' 토글 → 보이는 목록은 문서 1건 → 일괄 대상도 1건이어야 한다.
    fireEvent.click(screen.getByRole("button", { name: /문서 검증 업무/ }));
    expect(await screen.findByRole("button", { name: "현재 목록 1건 담당자 지정" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "현재 목록 2건 담당자 지정" })).toBeNull();
  });

  test("일괄 배정 부분 실패를 집계해 표면화한다(조용한 false 금지)", async () => {
    let n = 0;
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({ items: [DOC_TASK, PLAIN_TASK], next_cursor: null }),
        assignHumanTask: async () => {
          n += 1;
          if (n === 1) throw new Error("conflict");
          return { human_task_id: "x", state: "assigned" };
        },
      }),
    );
    location.hash = "#humanTasks";

    fireEvent.click(await screen.findByRole("button", { name: "현재 목록 2건 담당자 지정" }));
    fireEvent.change(await screen.findByLabelText("담당자 선택 또는 직접 입력"), { target: { value: "alice" } });
    fireEvent.click(screen.getByRole("button", { name: "확인" }));

    expect(await screen.findByText("1건 지정 실패 — 1건은 처리됨")).toBeInTheDocument();
  });

  test("일괄 승인: 구조화 검토·타인 배정 업무는 제외하고, 배정→시작→승인(decision=approve) 체인으로 처리", async () => {
    // 대상 = PLAIN(open, 양식/증빙 없음) + MINE(in_progress, 내게 배정). DOC(증빙=구조화)와 OTHER(타인 배정)는 제외 → 2건.
    const MINE = { human_task_id: "73000000-0000-0000-0000-0000000000b3", state: "in_progress", kind: "approval", assignee: "u", timeout: null, on_timeout: "escalate", run_id: null };
    const OTHER = { human_task_id: "73000000-0000-0000-0000-0000000000c4", state: "in_progress", kind: "approval", assignee: "someone-else", timeout: null, on_timeout: "escalate", run_id: null };
    const calls: string[] = [];
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({ items: [DOC_TASK, PLAIN_TASK, MINE, OTHER], next_cursor: null }),
        assignHumanTask: async (id, assignee) => { calls.push(`assign:${id}:${assignee}`); return { human_task_id: id, state: "assigned" }; },
        startHumanTask: async (id) => { calls.push(`start:${id}`); return { human_task_id: id, state: "in_progress" }; },
        resolveHumanTask: async (id, _key, result) => { calls.push(`resolve:${id}:${(result as { decision?: string } | undefined)?.decision ?? "none"}`); return {}; },
      }),
    );
    location.hash = "#humanTasks";

    fireEvent.click(await screen.findByRole("button", { name: "현재 목록 2건 일괄 승인" }));
    fireEvent.click(await screen.findByRole("button", { name: "확인" }));

    // PLAIN(open): 내게 배정(sub=u) → 시작 → 승인. MINE(in_progress): 바로 승인. decision=approve 가 재개 분기에 전달된다.
    await waitFor(() => expect(calls.filter((c) => c.startsWith("resolve:"))).toHaveLength(2));
    expect(calls).toContain(`assign:${PLAIN_TASK.human_task_id}:u`);
    expect(calls).toContain(`start:${PLAIN_TASK.human_task_id}`);
    expect(calls).toContain(`resolve:${PLAIN_TASK.human_task_id}:approve`);
    expect(calls).toContain(`resolve:${MINE.human_task_id}:approve`);
    expect(calls.filter((c) => c.startsWith("resolve:"))).toHaveLength(2); // DOC/OTHER 미승인(제외 확인)
  });
});

// U2-1: 구조화 검토 1건이 지정(확인)→시작(확인)→입력→제출 4단계였다 — '내가 검토 시작' 원클릭 체인이
// H1→H2를 확인 1회로 축약하고 상세(검토 폼)로 이동하는지의 회귀 가드.
describe("HumanTasks 원클릭 검토 체인 (U2-1)", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", jwt(["viewer", "operator", "reviewer", "approver", "admin"]));
  });

  test("open 구조화 검토 업무: 확인 1회로 내 배정+시작 후 상세로 이동", async () => {
    const calls: string[] = [];
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({ items: [DOC_TASK], next_cursor: null }),
        assignHumanTask: async (id, assignee, key) => {
          calls.push(`assign:${id}:${assignee}:${key.endsWith(":a")}`);
          return { human_task_id: id, state: "assigned" };
        },
        startHumanTask: async (id, key) => {
          calls.push(`start:${id}:${key.endsWith(":s")}`);
          return { human_task_id: id, state: "in_progress" };
        },
      }),
    );
    location.hash = "#humanTasks";

    fireEvent.click((await screen.findAllByRole("button", { name: "내가 검토 시작" }))[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "확인" }));

    await waitFor(() => expect(calls).toEqual([
      `assign:${DOC_TASK.human_task_id}:u:true`,
      `start:${DOC_TASK.human_task_id}:true`,
    ]));
    // 시작 즉시 상세(검토 폼)로 딥링크 — ht 파라미터가 해당 업무를 가리킨다.
    await waitFor(() => expect(location.hash).toContain(`ht=${DOC_TASK.human_task_id}`));
  });

  test("타인에게 배정된 구조화 검토 업무에는 체인 버튼을 그리지 않는다(가로채기 방지)", async () => {
    const OTHERS_TASK = { ...DOC_TASK, human_task_id: "73000000-0000-0000-0000-0000000000d2", state: "assigned", assignee: "someone-else" };
    renderApp(fakeClient({ listHumanTasks: async () => ({ items: [OTHERS_TASK], next_cursor: null }) }));
    location.hash = "#humanTasks";

    await screen.findByRole("button", { name: "시작" });
    expect(screen.queryByRole("button", { name: "내가 검토 시작" })).toBeNull();
  });

  test("단순 확인 업무(구조화 입력 없음)에는 체인 버튼 대신 기존 경로 유지", async () => {
    renderApp(fakeClient({ listHumanTasks: async () => ({ items: [PLAIN_TASK], next_cursor: null }) }));
    location.hash = "#humanTasks";

    await screen.findByRole("button", { name: "내 담당으로 지정" });
    expect(screen.queryByRole("button", { name: "내가 검토 시작" })).toBeNull();
  });
});
