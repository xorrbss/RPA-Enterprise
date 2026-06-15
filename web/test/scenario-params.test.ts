import { describe, expect, test } from "vitest";

import { extractUrlRefKeys } from "../src/api/scenario-params";

describe("extractUrlRefKeys", () => {
  test("navigate.url_ref 키 추출(등장 순서, 중복 제거)", () => {
    const ir = {
      start: "a",
      nodes: {
        a: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "b" },
        b: { what: [{ action: "observe" }, { action: "navigate", url_ref: "detail_url" }], next: "c" },
        c: { what: [{ action: "navigate", url_ref: "entry_url" }], terminal: "success" }, // 중복
      },
    };
    expect(extractUrlRefKeys(ir)).toEqual(["entry_url", "detail_url"]);
  });

  test("navigate 없으면 빈 배열", () => {
    expect(extractUrlRefKeys({ start: "a", nodes: { a: { on: [{ when: "flags.x", target: "b", priority: 0 }] }, b: { terminal: "success" } } })).toEqual([]);
  });

  test("ir 부재/형식 무효 → 빈 배열(throw 없음)", () => {
    expect(extractUrlRefKeys(undefined)).toEqual([]);
    expect(extractUrlRefKeys(null)).toEqual([]);
    expect(extractUrlRefKeys({})).toEqual([]);
    expect(extractUrlRefKeys({ nodes: "nope" })).toEqual([]);
  });

  test("빈 문자열 url_ref 는 무시", () => {
    expect(extractUrlRefKeys({ nodes: { a: { what: [{ action: "navigate", url_ref: "" }] } } })).toEqual([]);
  });
});
