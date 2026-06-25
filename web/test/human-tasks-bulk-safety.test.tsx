import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
});
