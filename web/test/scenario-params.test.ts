import { describe, expect, test } from "vitest";

import { extractUrlRefKeys, extractParamDefaults } from "../src/api/scenario-params";
import { buildIr } from "../src/components/OperatorWizard";

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

describe("extractParamDefaults", () => {
  test("params_schema.properties[key].default(string) 추출", () => {
    const ir = {
      params_schema: { type: "object", properties: { entry_url: { type: "string", default: "https://x.example/a" }, other: { type: "string" } } },
    };
    expect(extractParamDefaults(ir)).toEqual({ entry_url: "https://x.example/a" });
  });

  test("params_schema 부재/형식 무효 → 빈 객체(throw 없음)", () => {
    expect(extractParamDefaults(undefined)).toEqual({});
    expect(extractParamDefaults(null)).toEqual({});
    expect(extractParamDefaults({})).toEqual({});
    expect(extractParamDefaults({ params_schema: { properties: "nope" } })).toEqual({});
  });

  test("비-string/빈 default 는 무시", () => {
    expect(extractParamDefaults({ params_schema: { properties: { a: { default: 5 }, b: { default: "" } } } })).toEqual({});
  });
});

describe("OperatorWizard.buildIr — url_ref 키 모델(리터럴 금지)", () => {
  test("url_ref 는 입력 URL이 아니라 심볼릭 키(entry_url); 입력 URL은 params_schema default 로", () => {
    const ir = buildIr("리뷰수집", "https://login.office.hiworks.com/x", "리뷰", "list") as {
      nodes: { open: { what: { url_ref: string }[] } };
    };
    expect(ir.nodes.open.what[0]?.url_ref).toBe("entry_url");
    // 런타임 키-only 계약과 정합: 키는 entry_url, 입력 URL은 default 로 라운드트립(실행 대화상자 prefill).
    expect(extractUrlRefKeys(ir)).toEqual(["entry_url"]);
    expect(extractParamDefaults(ir)).toEqual({ entry_url: "https://login.office.hiworks.com/x" });
  });

  test("무효/빈 URL이면 default 없이 키만 선언(required 유지)", () => {
    const ir = buildIr("x", "not-a-url", "d", "once") as {
      nodes: { open: { what: { url_ref: string }[] } };
      params_schema: { required: string[] };
    };
    expect(ir.nodes.open.what[0]?.url_ref).toBe("entry_url");
    expect(extractParamDefaults(ir)).toEqual({});
    expect(ir.params_schema.required).toEqual(["entry_url"]);
  });
});
