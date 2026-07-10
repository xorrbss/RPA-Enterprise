import { describe, expect, test } from "vitest";

import { renderIrSentences, type StepSentence } from "../src/components/easy-create/step-sentences";

function firstStep(input: unknown): StepSentence {
  const [head] = renderIrSentences(input);
  if (head === undefined) throw new Error("no steps rendered");
  return head;
}

// E2(설계 §5): IR→문장 규칙 단위 테스트 — 스냅샷이 아니라 규칙별 케이스(action 10종·flow·예약 핸들러·폴백·상한).

function ir(nodes: Record<string, unknown>, start = "n1"): unknown {
  return { start, nodes };
}

describe("step-sentences — action 문장표", () => {
  test.each([
    [{ action: "navigate", url_ref: "entry_url" }, "페이지로 이동합니다", "주소: 접속 주소 (시작 주소)"], // urlRefLabel 해석
    [{ action: "act", instruction: "로그인 버튼을 클릭" }, "로그인 버튼을 클릭", undefined],
    [{ action: "observe", instruction: "결재 목록이 보이는지" }, "화면을 확인합니다 — 결재 목록이 보이는지", undefined],
    [{ action: "extract", instruction: "제목을 읽는다", schema_ref: "titles_v1" }, "제목을 읽는다", "결과 형식: titles_v1"],
    [{ action: "download" }, "파일을 내려받습니다", undefined],
    [{ action: "upload" }, "파일을 올립니다", undefined],
    [{ action: "api_call", args: { method: "POST" }, url_ref: "api_url" }, "POST 요청을 보냅니다", "주소: api_url"], // 미매핑 키는 원문 폴백
    [{ action: "file", args: { op: "move" } }, "파일을 처리합니다", "op: move"],
    [{ action: "human_task", assignee_role: "reviewer" }, "사람의 확인을 요청합니다", "담당: reviewer"],
    [{ action: "shell", cmd_ref: "signed:export" }, "등록된 명령을 실행합니다", "명령 키: signed:export"],
  ])("%j → 문장", (what, sentence, detail) => {
    const step = firstStep(ir({ n1: { what: [what], terminal: "success" } }));
    expect(step.sentence).toBe(sentence);
    expect(step.detail).toBe(detail);
    expect(step.fallback).toBe(false);
  });

  test("알 수 없는 action은 원문 폴백(fallback:true) — 문장 날조 금지", () => {
    const step = firstStep(ir({ n1: { what: [{ action: "teleport" }], terminal: "success" } }));
    expect(step.fallback).toBe(true);
    expect(step.sentence).toContain("teleport");
    expect(step.detail).toContain("teleport");
  });

  test("instruction 없는 act 도 폴백으로 표시(빈 문장 금지)", () => {
    const step = firstStep(ir({ n1: { what: [{ action: "act" }], terminal: "success" } }));
    expect(step.fallback).toBe(true);
    expect(step.sentence).toBe("화면을 조작합니다");
  });
});

describe("step-sentences — flow·verify·예약 핸들러", () => {
  test("on 분기: 조건(IREL 원문)은 요약하지 않고 detail 원문으로", () => {
    const step = firstStep(
      ir({
        n1: {
          what: [{ action: "observe", instruction: "화면 상태" }],
          on: [
            { when: "flags.login_required", target: "login", priority: 1 },
            { when: "true", target: "done", priority: 9 },
          ],
        },
        login: { what: [{ action: "act", instruction: "로그인" }], terminal: "success" },
        done: { terminal: "success" },
      }),
    );
    expect(step.flow?.kind).toBe("branch");
    expect(step.flow?.label).toBe("조건에 따라 나뉩니다");
    expect(step.flow?.detail).toContain("flags.login_required → login");
  });

  test("loop: 최대 반복 수 배지 + body 1회 전개(주 경로)", () => {
    const steps = renderIrSentences(
      ir({
        n1: { loop: { body_target: "body", max_iterations: 5 } },
        body: { what: [{ action: "extract", instruction: "행을 읽는다" }], terminal: "success" },
      }),
    );
    expect(steps[0]!.flow?.label).toBe("반복 (최대 5회)");
    expect(steps[1]!.nodeId).toBe("body");
    expect(steps[1]!.offMainPath).toBe(false);
  });

  test("terminal 4종 문장", () => {
    const cases: Array<[string, string]> = [
      ["success", "완료합니다"],
      ["success_empty", "데이터 없이 완료합니다"],
      ["fail_business", "업무 실패로 종료합니다"],
      ["fail_system", "시스템 실패로 종료합니다"],
    ];
    for (const [terminal, label] of cases) {
      const step = firstStep(ir({ n1: { terminal } }));
      expect(step.flow?.label).toBe(label);
      expect(step.sentence).toBe(label); // 동작 없는 흐름 노드 — 흐름이 곧 문장(원시 '동작 없음' 노출 금지)
    }
  });

  test("verify.criteria 요약(종류 레지스트리)", () => {
    const step = firstStep(
      ir({
        n1: {
          what: [{ action: "extract", instruction: "표를 읽는다" }],
          verify: { criteria: [{ type: "min_rows", value: 3 }, { type: "element_visible", selector: ".x" }] },
          terminal: "success",
        },
      }),
    );
    expect(step.verify).toEqual(["확인: 최소 3행", "확인: 화면 요소 표시"]);
  });

  test("예약 핸들러 target 라벨(@human_task/@challenge/@end_no_data)", () => {
    const steps = renderIrSentences(
      ir({
        n1: {
          what: [{ action: "observe", instruction: "상태" }],
          on: [
            { when: "flags.captcha", target: "@challenge", priority: 1 },
            { when: "flags.empty", target: "@end_no_data", priority: 2 },
            { when: "true", target: "@human_task", priority: 3 },
          ],
        },
      }),
    );
    expect(steps[0]!.flow?.detail).toContain("→ 추가 인증 처리로");
    expect(steps[0]!.flow?.detail).toContain("→ 데이터 없으면 종료");
    expect(steps[0]!.flow?.detail).toContain("→ 사람 확인으로");
  });

  test("fallback_chain 은 '대체 경로 준비됨' 표기", () => {
    const step = firstStep(
      ir({ n1: { what: [{ action: "act", instruction: "클릭" }], fallback_chain: [{ target: "alt" }], terminal: "success" } }),
    );
    expect(step.detail).toContain("대체 경로 준비됨");
  });
});

describe("step-sentences — 폴백 정밀화(F6)", () => {
  test("객체형 예약 핸들러 next({handler:'@human_task'})는 사람 확인 문장 재사용(기본 문장 금지)", () => {
    const step = firstStep(
      ir({
        n1: { next: { handler: "@human_task", input: { assignee_role: "reviewer" }, return_node: "n2" } },
        n2: { terminal: "success" },
      }),
    );
    expect(step.flow?.kind).toBe("next");
    expect(step.flow?.label).toBe("→ 사람 확인으로");
    expect(step.sentence).toBe("→ 사람 확인으로"); // 동작 없는 흐름 노드 — 흐름이 곧 문장
    expect(step.sentence).not.toBe("다음 단계로 진행합니다");
  });

  test("on 분기 target 이 객체형 @challenge 여도 라벨 경유 — '[object Object]' 미노출", () => {
    const step = firstStep(
      ir({
        n1: {
          what: [{ action: "observe", instruction: "상태" }],
          on: [
            { when: "flags.captcha", target: { handler: "@challenge", input: {}, return_node: "n1" }, priority: 1 },
            { when: "true", target: "done", priority: 9 },
          ],
        },
        done: { terminal: "success" },
      }),
    );
    expect(step.flow?.detail).toContain("추가 인증 처리로");
    expect(step.flow?.detail).not.toContain("[object Object]");
  });

  test("fallback_chain 만 있는 노드는 대체 경로 문장(기본 문장 금지)", () => {
    const step = firstStep(ir({ n1: { fallback_chain: [{ target: "t0" }, { target: "t1" }] }, t0: { terminal: "success" }, t1: { terminal: "fail_business" } }));
    expect(step.flow?.kind).toBe("fallback");
    expect(step.sentence).toBe("잘 안 되면 대체 경로 2개를 차례로 시도합니다");
  });

  test("what 없는 평범한 next 는 현행 기본 문장 유지(회귀 고정)", () => {
    const step = firstStep(ir({ n1: { next: "n2" }, n2: { terminal: "success" } }));
    expect(step.flow).toBeUndefined();
    expect(step.sentence).toBe("다음 단계로 진행합니다");
  });

  test("@end_no_data const 문자열 next 회귀 — 데이터 없으면 종료", () => {
    const step = firstStep(
      ir({ n1: { what: [{ action: "extract", instruction: "표를 읽는다", schema_ref: "rows_v1" }], next: "@end_no_data" } }),
    );
    expect(step.flow?.kind).toBe("next");
    expect(step.flow?.label).toBe("→ 데이터 없으면 종료");
  });
});

describe("step-sentences — 순회 규칙", () => {
  test("주 경로 미포함 노드는 '기타 경로'(offMainPath)로 뒤에 나열 — 누락 은폐 금지", () => {
    const steps = renderIrSentences(
      ir({
        n1: { what: [{ action: "act", instruction: "메인" }], next: "n2" },
        n2: { terminal: "success" },
        orphanish: { what: [{ action: "act", instruction: "예외 처리" }], terminal: "fail_business" },
      }),
    );
    expect(steps.map((s) => s.nodeId)).toEqual(["n1", "n2", "orphanish"]);
    expect(steps[2]!.offMainPath).toBe(true);
  });

  test("순환 그래프에서도 dedupe 로 종료(무한 루프 금지)", () => {
    const steps = renderIrSentences(
      ir({
        n1: { what: [{ action: "act", instruction: "a" }], next: "n2" },
        n2: { what: [{ action: "act", instruction: "b" }], next: "n1" },
      }),
    );
    expect(steps).toHaveLength(2);
  });

  test("상한 200 초과 노드는 절단(graph_max_steps 정합)", () => {
    const nodes: Record<string, unknown> = {};
    for (let i = 1; i <= 250; i++) {
      nodes[`n${i}`] = { what: [{ action: "act", instruction: `s${i}` }], next: `n${i + 1}` };
    }
    const steps = renderIrSentences(ir(nodes));
    expect(steps.length).toBeLessThanOrEqual(200);
  });

  test("유효하지 않은 IR 은 빈 배열(빈 화면이 아니라 호출측이 폴백 처리)", () => {
    expect(renderIrSentences(null)).toEqual([]);
    expect(renderIrSentences({ nodes: {} })).toEqual([]);
    expect(renderIrSentences({ start: "x", nodes: {} })).toEqual([]);
  });
});
