import { describe, expect, test } from "vitest";

import { stepBuilderRepresentable } from "../src/components/StepBuilder";

// 적대감사 #3 — StepBuilder(단계 편집)가 충실히 round-trip 하는 IR 만 true. 그 외(예약 핸들러·fallback_chain·미지원/
//   다중 what 액션)는 stepBuilderInitialFromIr 가 무음으로 단계를 떨구므로(action→none, flow→terminal:success) false →
//   ScenarioForm 이 단계 편집을 잠근다. C4 의 예약-핸들러 한정 가드를 모든 무음-손실 형태로 확장.

const collect = {
  meta: { name: "c", version: 1 },
  start: "open",
  nodes: {
    open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "collect" },
    collect: { what: [{ action: "extract", instruction: "x", schema_ref: "y" }], terminal: "success" },
  },
};

describe("stepBuilderRepresentable (적대감사 #3)", () => {
  test("안전 액션(navigate/extract/act/observe)+표준 flow(next/terminal/on/loop) → true", () => {
    expect(stepBuilderRepresentable(collect)).toBe(true);
    expect(stepBuilderRepresentable({ meta: { name: "l", version: 1 }, start: "a", nodes: {
      a: { loop: { body_target: "b", exit_target: "c", until: "flags.no_next_page", max_iterations: 2 } },
      b: { what: [{ action: "act", instruction: "next" }], next: "a" },
      c: { terminal: "success" },
    } })).toBe(true);
    expect(stepBuilderRepresentable({ meta: { name: "o", version: 1 }, start: "a", nodes: {
      a: { what: [{ action: "observe" }], on: [{ when: "flags.blocked", target: "b", priority: 1 }] },
      b: { terminal: "fail_business" },
    } })).toBe(true);
  });

  test("미지원 what 액션(api_call/shell/download/upload/file) → false(무음 action 소실)", () => {
    for (const action of ["api_call", "shell", "download", "upload", "file"]) {
      const ir = { meta: { name: "x", version: 1 }, start: "a", nodes: { a: { what: [{ action }], terminal: "success" } } };
      expect(stepBuilderRepresentable(ir)).toBe(false);
    }
  });

  test("다중 what 액션 → false(첫 액션만 보존)", () => {
    expect(stepBuilderRepresentable({ meta: { name: "m", version: 1 }, start: "a", nodes: {
      a: { what: [{ action: "observe" }, { action: "extract", schema_ref: "y" }], terminal: "success" },
    } })).toBe(false);
  });

  test("예약 핸들러(@human_task next-object) → false", () => {
    expect(stepBuilderRepresentable({ meta: { name: "h", version: 1 }, start: "a", nodes: {
      a: { what: [], next: { handler: "@human_task", input: { kind: "approval", assignee_role: "approver" }, return_node: "b" } },
      b: { terminal: "success" },
    } })).toBe(false);
  });

  test("on[].target 가 예약 핸들러 객체 → false(비대칭 #5)", () => {
    expect(stepBuilderRepresentable({ meta: { name: "ob", version: 1 }, start: "a", nodes: {
      a: { on: [{ when: "flags.blocked", target: { handler: "@human_task", input: { kind: "approval", assignee_role: "approver" }, return_node: "b" }, priority: 1 }] },
      b: { terminal: "success" },
    } })).toBe(false);
  });

  test("fallback_chain → false(무음 terminal:success 소실)", () => {
    expect(stepBuilderRepresentable({ meta: { name: "f", version: 1 }, start: "a", nodes: {
      a: { fallback_chain: [{ tier: "T0", entry_node: "b" }] },
      b: { what: [{ action: "extract", schema_ref: "y" }], terminal: "success" },
    } })).toBe(false);
  });

  test("빈/무효 IR → false", () => {
    expect(stepBuilderRepresentable(undefined)).toBe(false);
    expect(stepBuilderRepresentable({ meta: { name: "e", version: 1 }, start: "a", nodes: {} })).toBe(false);
  });
});
