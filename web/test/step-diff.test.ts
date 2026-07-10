import { describe, expect, test } from "vitest";

import { diffDraftIr } from "../src/components/easy-create/step-diff";

// F2: 말로 고치기 변경 표시 diff — node_id 기준 added/changed/removed/전면 교체(설계 §2.2).

const PREV = {
  start: "open",
  nodes: {
    open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "grab" },
    grab: { what: [{ action: "extract", instruction: "리뷰를 읽는다" }], terminal: "success" },
  },
};

describe("step-diff (F2)", () => {
  test("동일 IR은 무표시 — 마크·removed·전면 교체 전부 없음", () => {
    const d = diffDraftIr(PREV, JSON.parse(JSON.stringify(PREV)));
    expect(d.marks.size).toBe(0);
    expect(d.removedCount).toBe(0);
    expect(d.fullReplacement).toBe(false);
  });

  test("키 순서만 다른 노드는 변경으로 오인하지 않는다", () => {
    const next = {
      start: "open",
      nodes: {
        open: { next: "grab", what: [{ url_ref: "entry_url", action: "navigate" }] },
        grab: { terminal: "success", what: [{ instruction: "리뷰를 읽는다", action: "extract" }] },
      },
    };
    expect(diffDraftIr(PREV, next).marks.size).toBe(0);
  });

  test("added/changed/removed 를 분류한다", () => {
    const next = {
      start: "open",
      nodes: {
        open: { what: [{ action: "navigate", url_ref: "login_url" }], next: "save" },
        save: { what: [{ action: "act", instruction: "화면을 저장한다" }], terminal: "success" },
      },
    };
    const d = diffDraftIr(PREV, next);
    expect(d.marks.get("open")).toBe("changed");
    expect(d.marks.get("save")).toBe("added");
    expect(d.marks.has("grab")).toBe(false);
    expect(d.removedCount).toBe(1);
    expect(d.fullReplacement).toBe(false);
  });

  test("node_id 교집합이 없으면 전면 교체로 감지한다", () => {
    const next = {
      start: "n1",
      nodes: {
        n1: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "n2" },
        n2: { what: [{ action: "extract" }], terminal: "success" },
      },
    };
    const d = diffDraftIr(PREV, next);
    expect(d.fullReplacement).toBe(true);
    expect(d.marks.get("n1")).toBe("added");
    expect(d.marks.get("n2")).toBe("added");
    expect(d.removedCount).toBe(2);
  });

  test("이전 IR이 없으면(nodes 부재) 전면 교체가 아니라 전부 added", () => {
    const d = diffDraftIr(null, PREV);
    expect(d.marks.get("open")).toBe("added");
    expect(d.marks.get("grab")).toBe("added");
    expect(d.removedCount).toBe(0);
    expect(d.fullReplacement).toBe(false);
  });
});
