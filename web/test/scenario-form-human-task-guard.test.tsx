import { beforeEach, describe, expect, test } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ScenarioForm } from "../src/components/ScenarioForm";
import { ApiClientProvider } from "../src/api/context";
import { fakeClient } from "./fake-client";

// C4 — @human_task 사람 승인 분기(decision) 시나리오를 빌더 모드(쉬운 만들기/단계 편집)로 열면 stepBuilderInitialFromIr 가
//   reserved_handler 노드를 무음으로 terminal:success 로 떨어뜨려 단계·분기를 파괴한다(조용한 false). ScenarioForm 이 그 IR 을
//   감지해 '직접 편집'으로 잠그고 빌더 버튼을 비활성화하는지 검증한다.

const HUMAN_TASK_IR = {
  meta: { name: "승인 후 분기", version: 1, studio_mode: "ir" },
  start: "ask",
  nodes: {
    ask: {
      what: [],
      next: { handler: "@human_task", input: { kind: "approval", assignee_role: "approver" }, return_node: "branch" },
    },
    branch: {
      on: [
        { when: 'node.ask.decision == "approve"', target: "approved", priority: 2 },
        { when: "true", target: "rejected", priority: 1 },
      ],
    },
    approved: { terminal: "success" },
    rejected: { terminal: "fail_business" },
  },
};

const PLAIN_IR = {
  meta: { name: "단순 수집", version: 1, studio_mode: "ir" },
  start: "open",
  nodes: {
    open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "collect" },
    collect: { what: [{ action: "extract", instruction: "추출", schema_ref: "수집데이터" }], terminal: "success" },
  },
};

function renderEdit(ir: unknown): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = fakeClient({
    getScenario: async (id) => ({ scenario_id: id, name: "x", version: 1, promotion_status: "draft", ir }),
  });
  render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>
        <ScenarioForm mode={{ kind: "edit", scenarioId: "s1", name: "x", version: 1 }} onClose={() => {}} />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

describe("ScenarioForm — @human_task 분기 보호 (C4)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("예약 핸들러(@human_task) IR 은 직접 편집으로 잠기고 빌더 모드가 비활성·IR 보존", async () => {
    renderEdit(HUMAN_TASK_IR);

    // 직접 편집 textarea 에 @human_task 와 decision 분기가 그대로 보존(무음 terminal 변환 없음).
    const textarea = (await screen.findByLabelText("자동화 정의 원문")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toContain("@human_task"));
    expect(textarea.value).toContain("node.ask.decision");

    // 빌더 버튼 비활성(클릭해도 무음 파괴 모드 진입 불가).
    expect(screen.getByRole("button", { name: "쉬운 만들기" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "단계 편집" })).toBeDisabled();

    // 운영자 안내 노트 표시.
    expect(screen.getByRole("note")).toHaveTextContent("사람 승인 분기");
  });

  test("예약 핸들러 없는 일반 IR 은 빌더 모드 사용 가능(회귀 방지)", async () => {
    renderEdit(PLAIN_IR);

    await screen.findByLabelText("자동화 정의 원문");
    expect(screen.getByRole("button", { name: "쉬운 만들기" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "단계 편집" })).not.toBeDisabled();
    expect(screen.queryByRole("note")).toBeNull();
  });
});
