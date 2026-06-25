import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  // 적대감사 #3 — StepBuilder 가 표현 못 하는 액션(api_call 등)을 포함한 IR 은 단계 편집 잠금(무음 action 소실 차단).
  //   C4 의 예약-핸들러 한정 가드를 모든 무음-손실 형태로 확장(stepBuilderRepresentable).
  test("api_call 액션 포함 IR 은 단계 편집 잠김(직접 편집 유지)", async () => {
    const API_CALL_IR = {
      meta: { name: "api", version: 1, studio_mode: "ir" },
      start: "call",
      nodes: { call: { what: [{ action: "api_call", url_ref: "entry_url" }], terminal: "success" } },
    };
    renderEdit(API_CALL_IR);
    await screen.findByLabelText("자동화 정의 원문");
    expect(screen.getByRole("button", { name: "단계 편집" })).toBeDisabled();
  });

  // C4c — 저장본(백엔드 target 주입 + jsonb key 재배열 + version bump 를 거친 승인 분기 IR)을 다시 열면 '쉬운 만들기'로
  //   재편집할 수 있다(라운드트립 정밀화 → easyUnsafe=false, '직접 편집' 강등 안 됨).
  test("저장본 승인 분기 재편집 — 쉬운 만들기(승인 양식)로 열림", async () => {
    const STORED_APPROVAL = {
      target: { site_profile_id: "s1", browser_identity_id: "b1", network_policy_id: "n1" },
      start: "open",
      nodes: {
        decide: { on: [{ priority: 2, target: "approved", when: 'node.review.decision == "approve"' }, { target: "rejected", when: "true", priority: 1 }] },
        rejected: { terminal: "fail_business" },
        review: { next: { return_node: "decide", input: { assignee_role: "reviewer", kind: "approval" }, handler: "@human_task" }, what: [] },
        approved: { terminal: "success" },
        open: { next: "review", what: [{ url_ref: "entry_url", action: "navigate" }] },
      },
      params_schema: { required: ["entry_url"], type: "object", properties: { entry_url: { default: "https://ok.example/doc", type: "string", description: "승인 대상이 보이는 페이지 주소" } } },
      meta: { studio_mode: "easy", version: 5, name: "승인자동화" },
    };
    renderEdit(STORED_APPROVAL);

    // 쉬운 만들기(승인 양식)로 열림 — 담당자 역할 필드 표시, 직접 편집 textarea 미표시, 잠금 노트 없음.
    expect(await screen.findByText("③ 승인을 맡을 담당자 역할")).toBeInTheDocument();
    expect(screen.queryByLabelText("자동화 정의 원문")).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByRole("button", { name: "쉬운 만들기" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "단계 편집" })).toBeDisabled();
  });

  // C4b — 쉬운 만들기에서 '승인 후 분기' 템플릿으로 @human_task 분기 자동화를 양식 저작. 생성 중 easy 가 잠기지 않는다
  //   (승인 분기 정형은 라운드트립 가능 → easyUnsafe=false). 단계 편집은 @human_task 표현 불가라 잠긴 채.
  test("새 자동화 — '승인 후 분기' 템플릿 선택 시 쉬운 만들기 유지(잠김 없음)+@human_task 양식 저작", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ApiClientProvider client={fakeClient({})}>
          <ScenarioForm mode={{ kind: "create" }} onClose={() => {}} />
        </ApiClientProvider>
      </QueryClientProvider>,
    );

    // 생성은 쉬운 만들기 기본 → 업무 템플릿 select 노출.
    const templateSelect = screen.getByLabelText("업무 템플릿") as HTMLSelectElement;
    fireEvent.change(templateSelect, { target: { value: "approval_branch" } });

    // 승인 전용 필드(담당자 역할) 노출, easy 유지(직접 편집 textarea 미표시).
    expect(screen.getByText("③ 승인을 맡을 담당자 역할")).toBeInTheDocument();
    expect(screen.queryByLabelText("자동화 정의 원문")).toBeNull();
    // 쉬운 만들기 버튼은 활성(승인 분기 정형은 표현 가능), 단계 편집은 비활성(@human_task 표현 불가).
    expect(screen.getByRole("button", { name: "쉬운 만들기" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "단계 편집" })).toBeDisabled();
  });
});
