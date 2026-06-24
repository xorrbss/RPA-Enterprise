import { describe, expect, test } from "vitest";

import {
  coerceParamValue,
  extractScenarioParamFields,
  extractUrlRefKeys,
  extractParamDefaults,
  isParamFieldInvalid,
  isParamFieldMissing,
  shouldIncludeParam,
  urlRefLabel,
} from "../src/api/scenario-params";
import { buildIr, wizardInitialFromIr } from "../src/components/OperatorWizard";
import { stepBuilderInitialFromIr } from "../src/components/StepBuilder";

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

describe("urlRefLabel", () => {
  test("known execution params use business labels instead of raw keys", () => {
    expect(urlRefLabel("entry_url")).toBe("접속 주소 (시작 주소)");
    expect(urlRefLabel("start_url")).toBe("시작 주소");
    expect(urlRefLabel("max_pages")).toBe("최대 페이지 수");
  });

  test("unknown execution params fall back to the original key", () => {
    expect(urlRefLabel("customer_code")).toBe("customer_code");
  });
});

describe("extractScenarioParamFields", () => {
  test("params_schema를 운영자용 실행 폼 필드로 변환한다", () => {
    const ir = {
      params_schema: {
        type: "object",
        required: ["entry_url", "max_pages", "mode"],
        properties: {
          entry_url: {
            type: "string",
            title: "업무 포털 주소",
            description: "자동화를 시작할 웹 주소",
            default: "https://portal.example/orders",
            format: "uri",
          },
          max_pages: { type: "integer", title: "최대 페이지", default: 3 },
          include_closed: { type: "boolean", title: "마감건 포함", default: true },
          mode: { type: "string", title: "조회 범위", enum: ["today", "week"] },
        },
      },
      start: "open",
      nodes: {
        open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "done" },
        done: { terminal: "success" },
      },
    };

    expect(extractScenarioParamFields(ir)).toEqual([
      {
        key: "entry_url",
        label: "업무 포털 주소",
        kind: "text",
        required: true,
        defaultValue: "https://portal.example/orders",
        description: "자동화를 시작할 웹 주소",
        placeholder: "https://…",
        source: "params_schema",
      },
      {
        key: "max_pages",
        label: "최대 페이지",
        kind: "number",
        required: true,
        defaultValue: "3",
        placeholder: "0",
        source: "params_schema",
      },
      {
        key: "include_closed",
        label: "마감건 포함",
        kind: "checkbox",
        required: false,
        defaultValue: "true",
        source: "params_schema",
      },
      {
        key: "mode",
        label: "조회 범위",
        kind: "select",
        required: true,
        defaultValue: "",
        options: [
          { value: "today", label: "today" },
          { value: "week", label: "week" },
        ],
        source: "params_schema",
      },
    ]);
  });

  test("params_schema에 빠진 navigate.url_ref는 필수 URL 필드로 병합한다", () => {
    const ir = {
      params_schema: {
        type: "object",
        properties: {
          report_type: { type: "string", title: "보고서 유형" },
        },
      },
      nodes: {
        open: { what: [{ action: "navigate", url_ref: "entry_url" }] },
      },
    };

    expect(extractScenarioParamFields(ir).map((field) => ({
      key: field.key,
      label: field.label,
      required: field.required,
      source: field.source,
    }))).toEqual([
      { key: "report_type", label: "보고서 유형", required: false, source: "params_schema" },
      { key: "entry_url", label: "접속 주소 (시작 주소)", required: true, source: "url_ref" },
    ]);
  });
});

describe("scenario param field validation/coercion", () => {
  test("필수/숫자 검증과 payload 변환을 타입별로 수행한다", () => {
    const fields = extractScenarioParamFields({
      params_schema: {
        required: ["entry_url", "max_pages"],
        properties: {
          entry_url: { type: "string", title: "시작 주소" },
          max_pages: { type: "integer", title: "최대 페이지" },
          include_closed: { type: "boolean", title: "마감건 포함" },
        },
      },
    });
    const [entry, maxPages, includeClosed] = fields;
    expect(entry).toBeDefined();
    expect(maxPages).toBeDefined();
    expect(includeClosed).toBeDefined();

    expect(isParamFieldMissing(entry!, "")).toBe(true);
    expect(isParamFieldMissing(includeClosed!, "")).toBe(false);
    expect(isParamFieldInvalid(maxPages!, "not-a-number")).toBe(true);
    expect(shouldIncludeParam(entry!, " https://x.example ")).toBe(true);
    expect(shouldIncludeParam(maxPages!, "")).toBe(true);
    expect(shouldIncludeParam(includeClosed!, "")).toBe(true);
    expect(coerceParamValue(entry!, " https://x.example ")).toBe("https://x.example");
    expect(coerceParamValue(maxPages!, "5")).toBe(5);
    expect(coerceParamValue(includeClosed!, "true")).toBe(true);
    expect(coerceParamValue(includeClosed!, "")).toBe(false);
  });
});

describe("OperatorWizard.buildIr — url_ref 키 모델(리터럴 금지)", () => {
  test("url_ref 는 입력 URL이 아니라 심볼릭 키(entry_url); 입력 URL은 params_schema default 로", () => {
    const ir = buildIr("리뷰수집", "https://login.office.hiworks.com/x", "리뷰", "list") as {
      meta: { studio_mode: string };
      nodes: {
        open: { what: { url_ref: string }[]; next: string };
        collect: { what: { instruction?: string }[]; next: string };
        page_loop: { loop: { body_target: string; exit_target: string; until: string; max_iterations: number } };
        next_page: { what: { action: string; instruction?: string }[]; next: string };
      };
    };
    expect(ir.nodes.open.what[0]?.url_ref).toBe("entry_url");
    expect(ir.meta.studio_mode).toBe("easy");
    expect(ir.nodes.collect.what[0]?.instruction).toContain("리뷰");
    expect(ir.nodes.collect.next).toBe("page_loop");
    expect(ir.nodes.page_loop.loop).toMatchObject({ body_target: "next_page", exit_target: "done", max_iterations: 2 });
    expect(ir.nodes.page_loop.loop.until).toContain("flags.no_next_page");
    expect(ir.nodes.next_page.what[0]).toMatchObject({ action: "act", instruction: expect.stringContaining("다음 페이지") });
    // 런타임 키-only 계약과 정합: 키는 entry_url, 입력 URL은 default 로 라운드트립(실행 대화상자 prefill).
    expect(extractUrlRefKeys(ir)).toEqual(["entry_url"]);
    expect(extractParamDefaults(ir)).toEqual({ entry_url: "https://login.office.hiworks.com/x" });
  });

  test("list pagination 옵션은 loop 반복 횟수와 마지막 페이지 flag로 컴파일된다", () => {
    const ir = buildIr("공지", "https://example.com/notices", "공지", "list", "공지 추출", "", 1, {
      maxPages: 5,
      nextInstruction: "다음 버튼을 누른다.",
      noNextFlag: "cursor_reached",
    }) as {
      nodes: {
        collect: { next: string };
        page_loop: { loop: { until: string; max_iterations: number } };
        next_page: { what: { instruction?: string }[] };
      };
    };
    expect(ir.nodes.collect.next).toBe("page_loop");
    expect(ir.nodes.page_loop.loop.max_iterations).toBe(4); // 첫 페이지 수집 후 추가 페이지 클릭 수
    expect(ir.nodes.page_loop.loop.until).toBe("flags.cursor_reached || loop.page_count >= 4");
    expect(ir.nodes.next_page.what[0]?.instruction).toBe("다음 버튼을 누른다.");
  });

  test("blank extract instruction falls back to a default instruction", () => {
    const ir = buildIr("주문수집", "https://example.com/orders", "주문", "once", "", "") as {
      nodes: { collect: { what: { instruction?: string; schema_ref?: string }[] } };
    };
    const extract = ir.nodes.collect.what[0];
    expect(extract?.schema_ref).toBe("주문");
    expect(extract?.instruction).toContain("주문");
    expect(extract?.instruction?.trim().length).toBeGreaterThan(0);
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

  test("easy IR은 편집 초기값으로 라운드트립된다", () => {
    const ir = buildIr("리뷰수집", "https://login.office.hiworks.com/x", "리뷰", "list", "리뷰 제목과 별점을 추출하라.", 4);
    expect((ir as { meta: { version: number } }).meta.version).toBe(4);
    expect(wizardInitialFromIr(ir)).toEqual({
      name: "리뷰수집",
      pageUrl: "https://login.office.hiworks.com/x",
      dataName: "리뷰",
      kind: "list",
      instruction: "리뷰 제목과 별점을 추출하라.",
      maxPages: 3,
      nextInstruction: "다음 페이지 버튼을 눌러 다음 목록 화면으로 이동하라.",
      noNextFlag: "no_next_page",
    });
  });

  test("form IR loop와 observe/act 지시문은 단계 편집 초기값으로 라운드트립된다", () => {
    const initial = stepBuilderInitialFromIr({
      meta: { name: "페이지 반복", version: 1, studio_mode: "form" },
      start: "loop",
      nodes: {
        loop: { loop: { body_target: "next", exit_target: "done", until: "flags.no_next_page", max_iterations: 3 } },
        next: { what: [{ action: "act", instruction: "다음 페이지 클릭" }], next: "loop" },
        done: { terminal: "success" },
      },
    });
    expect(initial?.steps[0]).toMatchObject({
      id: "loop",
      action: "none",
      flow: { kind: "loop", bodyTarget: "next", exitTarget: "done", until: "flags.no_next_page", maxIterations: 3 },
    });
    expect(initial?.steps[1]).toMatchObject({ id: "next", action: "act", instruction: "다음 페이지 클릭" });
  });

  test("form IR은 단계 편집 초기값으로 라운드트립된다", () => {
    const initial = stepBuilderInitialFromIr({
      meta: { name: "폼 자동화", version: 2, studio_mode: "form" },
      start: "open",
      nodes: {
        open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "collect" },
        collect: { what: [{ action: "extract", instruction: "행을 추출하라.", schema_ref: "rows" }], terminal: "success" },
      },
    });
    expect(initial?.name).toBe("폼 자동화");
    expect(initial?.steps[0]).toMatchObject({ id: "open", action: "navigate", urlRef: "entry_url", flow: { kind: "next", target: "collect" } });
    expect(initial?.steps[1]).toMatchObject({ id: "collect", action: "extract", schemaRef: "rows", extractInstruction: "행을 추출하라." });
  });
});
