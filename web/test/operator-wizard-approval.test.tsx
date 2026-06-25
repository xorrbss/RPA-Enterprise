import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { OperatorWizard, buildApprovalIr, wizardInitialFromIr } from "../src/components/OperatorWizard";

// C4b — '승인 후 분기' 양식 저작: OperatorWizard 가 @human_task approval + node.<review>.decision 분기 IR 을 생성하고,
//   그 정형을 라운드트립(이름/URL/역할 복원)하되 손편집된 분기는 안전하게 거부(undefined → 쉬운 만들기 잠금)하는지 검증.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

describe("buildApprovalIr / 라운드트립 (C4b)", () => {
  test("승인 분기 IR 구조 — navigate→@human_task→decision 분기", () => {
    // 구조 탐색은 테스트 단언이므로 any 로 자유 탐색(noUncheckedIndexedAccess 회피).
    const ir = buildApprovalIr("승인자동화", "https://ok.example/doc", "reviewer", 1) as any;
    const nodes = ir.nodes;
    // review 가 @human_task 소유 노드.
    const reviewNext = nodes.review.next;
    expect(reviewNext.handler).toBe("@human_task");
    expect(reviewNext.input.kind).toBe("approval");
    expect(reviewNext.input.assignee_role).toBe("reviewer");
    expect(reviewNext.return_node).toBe("decide");
    // input 은 humanTaskInput(additionalProperties:false) — return_node 를 input 안에 넣으면 ajv oneOf 실패(회귀 가드).
    expect(Object.keys(reviewNext.input).sort()).toEqual(["assignee_role", "kind"]);
    // decide 가 node.review.decision 으로 분기 + catch-all(V13).
    const on = nodes.decide.on;
    expect(on[0].when).toBe('node.review.decision == "approve"');
    expect(on[0].target).toBe("approved");
    expect(on[1].when).toBe("true");
    expect(nodes.approved.terminal).toBe("success");
    expect(nodes.rejected.terminal).toBe("fail_business");
    // 시작 URL 은 params default 로(리터럴 url_ref 금지).
    expect(ir.params_schema.properties.entry_url.default).toBe("https://ok.example/doc");
  });

  test("정형 승인 IR 은 라운드트립(필드 복원); 손편집된 분기는 거부(undefined)", () => {
    const ir = buildApprovalIr("승인자동화", "https://ok.example/doc", "approver", 1);
    const initial = wizardInitialFromIr(ir);
    expect(initial?.template).toBe("approval_branch");
    expect(initial?.assigneeRole).toBe("approver");
    expect(initial?.pageUrl).toBe("https://ok.example/doc");
    expect(initial?.name).toBe("승인자동화");

    // 반려 분기 대상을 손편집 → 재생성과 불일치 → undefined(무음 손실 차단, 쉬운 만들기 잠금).
    const tampered = JSON.parse(JSON.stringify(ir)) as any;
    tampered.nodes.decide.on = [
      { when: 'node.review.decision == "approve"', target: "approved", priority: 2 },
      { when: "true", target: "approved", priority: 1 }, // 반려도 approved 로 바꿈
    ];
    expect(wizardInitialFromIr(tampered)).toBeUndefined();
  });

  test("승인 분기 정형이 아닌 일반 @human_task IR 은 쉬운 만들기로 표현 불가(undefined)", () => {
    const ir = {
      meta: { name: "x", version: 1 },
      start: "t",
      nodes: {
        t: { what: [], next: { handler: "@human_task", input: { kind: "approval", assignee_role: "approver", return_node: "d" }, return_node: "d" } },
        d: { terminal: "success" },
      },
    };
    expect(wizardInitialFromIr(ir)).toBeUndefined();
  });
});

describe("OperatorWizard '승인 후 분기' 템플릿 (C4b)", () => {
  beforeEach(() => localStorage.clear());

  test("승인 분기 템플릿 선택 → @human_task decision IR emit + 담당자 역할 필드 표시", () => {
    const onChange = vi.fn();
    render(<OperatorWizard onChange={onChange} version={1} />);

    const templateSelect = screen.getByLabelText("업무 템플릿") as HTMLSelectElement;
    fireEvent.change(templateSelect, { target: { value: "approval_branch" } });

    // 담당자 역할 필드 노출(승인 전용), 수집 세부(④ 추출 규칙)는 미표시.
    expect(screen.getByText("③ 승인을 맡을 담당자 역할")).toBeInTheDocument();
    expect(screen.queryByText("④ 추출/입력 규칙")).toBeNull();

    // 마지막 onChange 가 @human_task decision 분기 IR.
    const lastIr = onChange.mock.calls.at(-1)?.[0];
    expect(isRecord(lastIr)).toBe(true);
    const nodes = (lastIr as any).nodes;
    expect(nodes.review.next.handler).toBe("@human_task");
    expect(nodes.decide.on[0].when).toBe('node.review.decision == "approve"');
  });
});
