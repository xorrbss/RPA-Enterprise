/**
 * Deterministic IREL compiler/evaluator fixtures.
 *
 * Run directly with: npx tsx irel.fixtures.ts
 */
import assert from "node:assert/strict";

import {
  compileIrelExpression,
  evaluateIrelBooleanExpression,
  evaluateIrelExpression,
  IRELRuntimeMissingError,
  parseIrelExpression,
  typeCheckIrelExpression,
  type HumanTaskNodeMeta,
  type IRELCompileContext,
  type IRELCompileDiagnostic,
  type IRELLiteralNode,
  type IRELNode,
  type IRELTypeAtom,
} from "./irel-compile";
import { validateScenarioStatic } from "./static-validation";
import type { IRScenario } from "./types";

const PARAMS_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    max_pages: { type: "integer" },
    as_of: { type: "string" },
    search: { type: "string" },
    enabled: { type: "boolean" },
    optional_id: { type: ["string", "null"] },
    window: {
      type: "object",
      properties: {
        days: { type: "integer" },
      },
    },
    items: { type: "array" },
  },
};

const GRAPH: ReadonlyMap<string, readonly string[]> = new Map([
  ["start", ["extract"]],
  ["extract", ["done"]],
  ["done", []],
]);

function context(overrides: Partial<IRELCompileContext> = {}): IRELCompileContext {
  return {
    currentNodeId: "extract",
    nodeIds: new Set(["start", "extract", "done"]),
    graph: GRAPH,
    paramsSchema: PARAMS_SCHEMA,
    expectedType: "boolean",
    ...overrides,
  };
}

function scenario(data: unknown): IRScenario {
  return data as IRScenario;
}

function compileOk(expression: string, ctx: IRELCompileContext = context()): IRELNode {
  const result = compileIrelExpression(expression, ctx);
  if (!result.ok) throw new Error(`${expression} failed: ${formatDiagnostics(result.diagnostics)}`);
  return result.compiled.ast;
}

function expectCompileError(
  expression: string,
  reason: IRELCompileDiagnostic["reason"],
  ctx: IRELCompileContext = context(),
): void {
  const result = compileIrelExpression(expression, ctx);
  if (result.ok) throw new Error(`${expression} unexpectedly compiled`);
  const reasons = result.diagnostics.map((diagnostic) => diagnostic.reason);
  assert.ok(reasons.includes(reason), `${expression} reasons were [${reasons.join(", ")}]`);
}

function expectStaticReasons(
  name: string,
  ir: IRScenario,
  expectedErrors: readonly string[],
  expectedWarnings: readonly string[] = [],
): void {
  const report = validateScenarioStatic(ir);
  const errors = report.errors.map((issue) => issue.reason);
  const warnings = report.warnings.map((issue) => issue.reason);
  assert.deepEqual(errors.sort(), [...expectedErrors].sort(), `${name} errors`);
  assert.deepEqual(warnings.sort(), [...expectedWarnings].sort(), `${name} warnings`);
}

function formatDiagnostics(diagnostics: readonly IRELCompileDiagnostic[]): string {
  return diagnostics.map((diagnostic) => `${diagnostic.reason}:${diagnostic.detail}`).join("; ");
}

const failures: string[] = [];
function fixture(name: string, run: () => void): void {
  try {
    run();
  } catch (err: unknown) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

fixture("boundary: parse -> typecheck -> evaluate AST", () => {
  const parsed = parseIrelExpression("flags.blocked");
  if (!parsed.ok) throw new Error(parsed.diagnostic.detail);
  const checked = typeCheckIrelExpression(parsed.ast, context());
  if (!checked.ok) throw new Error(formatDiagnostics(checked.diagnostics));
  assert.deepEqual(checked.type, ["boolean"]);
  assert.equal(evaluateIrelBooleanExpression(parsed.ast, { flags: { blocked: true } }), true);
});

fixture("AST literal exports include deterministic literal value", () => {
  const parsed = parseIrelExpression("42");
  if (!parsed.ok) throw new Error(parsed.diagnostic.detail);
  assert.equal(parsed.ast.kind, "literal");
  const literal: IRELLiteralNode = parsed.ast;
  assert.equal(literal.valueType, "int");
  assert.equal(literal.value, 42);
});

fixture("precedence: additive before comparison before logical", () => {
  const ast = compileOk("1 + 2 > 2 && flags.blocked");
  assert.equal(ast.kind, "logical");
  if (ast.kind !== "logical") throw new Error("expected logical AST");
  assert.equal(ast.left.kind, "compare");
  assert.equal(evaluateIrelBooleanExpression(ast, { flags: { blocked: true } }), true);
});

fixture("parentheses permit explicit mixed logical grouping", () => {
  const ast = compileOk("(flags.blocked || flags.not_found) && flags.login_required");
  assert.equal(
    evaluateIrelBooleanExpression(ast, {
      flags: { blocked: false, not_found: true, login_required: true },
    }),
    true,
  );
});

fixture("unary ! requires explicit comparison parentheses", () => {
  const ast = compileOk("!(flags.blocked)");
  assert.equal(evaluateIrelBooleanExpression(ast, { flags: { blocked: false } }), true);
  expectCompileError("!flags.blocked == true", "irel_parse_error");
});

fixture("mixed && and || without parentheses is rejected", () => {
  expectCompileError("flags.blocked || flags.not_found && flags.login_required", "irel_parse_error");
});

fixture("syntax errors include deterministic line and column", () => {
  const parsed = parseIrelExpression("flags.blocked &&\n)");
  if (parsed.ok) throw new Error("expression unexpectedly parsed");
  assert.equal(parsed.diagnostic.location?.line, 2);
  assert.equal(parsed.diagnostic.location?.column, 1);
  assert.match(parsed.diagnostic.detail, /line 2, column 1/);
});

fixture("unknown function and variable are compile errors", () => {
  expectCompileError("now() == null", "unknown_function");
  expectCompileError("params.missing > 0", "unknown_variable");
});

fixture("params_schema supports scalar and nested scalar access", () => {
  const scalar = compileOk("params.max_pages > 0");
  const nested = compileOk("params.window.days > 3");
  assert.equal(evaluateIrelBooleanExpression(scalar, { params: { max_pages: 2 } }), true);
  assert.equal(evaluateIrelBooleanExpression(nested, { params: { window: { days: 4 } } }), true);
});

fixture("params_schema unsupported shapes are compile errors", () => {
  expectCompileError("params.items == null", "params_schema_type_invalid");
  expectCompileError("params.window == null", "params_schema_type_invalid");
});

fixture("node, cursor, flags, and loop scopes typecheck deterministically", () => {
  const nodeAst = compileOk("node.start.row_count > 0");
  assert.equal(evaluateIrelBooleanExpression(nodeAst, { node: { start: { row_count: 3 } } }), true);
  const httpAst = compileOk("node.start.http_status == 202 && node.start.http_ok");
  assert.equal(evaluateIrelBooleanExpression(httpAst, { node: { start: { http_status: 202, http_ok: true } } }), true);

  const cursorAst = compileOk("cursor.last_review_id == null || flags.reviews_visible");
  assert.equal(
    evaluateIrelBooleanExpression(cursorAst, {
      cursor: { last_review_id: null },
      flags: { reviews_visible: false },
    }),
    true,
  );

  expectCompileError("loop.page_count > 0", "loop_scope_violation");
  const loopAst = compileOk("loop.page_count >= params.max_pages", context({ allowLoopScope: true }));
  assert.equal(
    evaluateIrelBooleanExpression(loopAst, {
      loop: { page_count: 5 },
      params: { max_pages: 5 },
    }),
    true,
  );
});

fixture("forward node references are rejected", () => {
  expectCompileError(
    "node.extract.row_count > 0",
    "forward_ref",
    context({ currentNodeId: "start" }),
  );
});

fixture("runtime evaluator throws on missing scope instead of returning false", () => {
  const ast = compileOk("params.max_pages > 0");
  assert.throws(() => evaluateIrelExpression(ast, { params: {} }), IRELRuntimeMissingError);

  const logicalAst = compileOk("flags.blocked && params.max_pages > 0");
  assert.throws(
    () => evaluateIrelBooleanExpression(logicalAst, { flags: { blocked: false }, params: {} }),
    IRELRuntimeMissingError,
  );
});

fixture("fallback advance_when may reference current tier entry_node", () => {
  expectStaticReasons("fallback advance_when", {
    meta: { name: "fallback", version: 1 },
    start: "n1",
    nodes: {
      n1: { fallback_chain: [{ tier: "T0", entry_node: "t0", advance_when: "node.t0.status == \"failed_system\"" }] },
      t0: { terminal: "success" },
    },
  }, []);
});

fixture("fallback advance_when may be omitted", () => {
  expectStaticReasons("fallback omitted advance_when", {
    meta: { name: "fallback", version: 1 },
    start: "n1",
    nodes: {
      n1: { fallback_chain: [{ tier: "T0", entry_node: "t0" }] },
      t0: { terminal: "success" },
    },
  }, []);
});

fixture("vlm_fallback.when is a verify-engine state condition, not IREL", () => {
  // verify.schema.json: vlm_fallback.when 은 verify-engine 상태 조건(기본 'criteria_uncertain'), IREL scope 아님.
  // 정적검증은 이를 IREL 로 컴파일/타입체크하지 않는다(문서화 기본값을 false-reject 하면 안 됨; AUD-12 a).
  // 문서화된 기본값 'criteria_uncertain'(유효 IREL 식 아님)이 수용되어야 한다.
  expectStaticReasons("vlm_fallback.when documented default accepted", {
    meta: { name: "vlm", version: 1 },
    start: "n1",
    nodes: {
      n1: {
        verify: {
          criteria: [{ type: "min_rows", n: 1 }],
          vlm_fallback: { prompt: "inspect", when: "criteria_uncertain" },
        },
        terminal: "success",
      },
    },
  }, []);

  // IREL 였다면 unknown_flag 였을 토큰도 IREL 로 검사되지 않으므로 수용된다(스코프 분리).
  expectStaticReasons("vlm_fallback.when non-IREL token not flagged", {
    meta: { name: "vlm", version: 1 },
    start: "n1",
    nodes: {
      n1: {
        verify: {
          criteria: [{ type: "min_rows", n: 1 }],
          vlm_fallback: { prompt: "inspect", when: "flags.no_such_flag" },
        },
        terminal: "success",
      },
    },
  }, []);
});

fixture("date_before/date_after reject offset-less datetime (determinism)", () => {
  // ir-expression §5: now() 금지 + 결정성. 오프셋 없는 datetime 은 호스트 로컬 TZ 로 파싱돼 워커마다
  // 다른 밀리초를 낸다(AUD-12 b). 평가 시 loud reject(IRELRuntimeMissingError).
  const ast = compileOk("date_before(params.as_of, params.search)");
  assert.throws(
    () => evaluateIrelBooleanExpression(ast, { params: { as_of: "2026-06-22T10:00:00", search: "2026-06-22T11:00:00" } }),
    IRELRuntimeMissingError,
  );

  // date-only(YYYY-MM-DD, UTC 자정) 와 명시 오프셋(Z) 은 결정적 → 평가 성공.
  assert.equal(
    evaluateIrelBooleanExpression(ast, { params: { as_of: "2026-06-22", search: "2026-06-23" } }),
    true,
  );
  const after = compileOk("date_after(params.as_of, params.search)");
  assert.equal(
    evaluateIrelBooleanExpression(after, { params: { as_of: "2026-06-22T11:00:00Z", search: "2026-06-22T10:00:00Z" } }),
    true,
  );
});

fixture("V10 value_match.path root must be extracted or node", () => {
  const base = (path: string): IRScenario => scenario({
    meta: { name: "v10", version: 1 },
    start: "n1",
    nodes: { n1: { verify: { criteria: [{ type: "value_match", path, equals: 1 }] }, terminal: "success" } },
  });
  // §3: 평가 대상 루트는 직전 노드의 extracted 또는 node.<id>.* — 그 외 루트는 V10 위반(AUD-12 c).
  expectStaticReasons("extracted root valid", base("extracted.total"), []);
  expectStaticReasons("node root valid", base("node.n1.row_count"), []);
  expectStaticReasons("bare root rejected", base("total"), ["invalid_value_path"]);
  expectStaticReasons("unknown root rejected", base("response.body"), ["invalid_value_path"]);
});

fixture("on[].target reservedHandlerCall rejected at static validation (V1)", () => {
  // schema/target 은 reservedHandlerCall 을 next/on[].target 양쪽에 허용하나 인터프리터는 on-branch 에서만
  // 거부(compile-accept/runtime-reject 비대칭, AUD-12 e). 저장 시점에 거부해 비대칭을 제거한다.
  expectStaticReasons("on-branch reserved handler unsupported", scenario({
    meta: { name: "onrh", version: 1 },
    start: "n1",
    nodes: {
      n1: { on: [{ when: "flags.blocked", target: { handler: "@human_task", input: { assignee_role: "reviewer" }, return_node: "n2" }, priority: 1 }] },
      n2: { terminal: "success" },
    },
  }), ["on_branch_reserved_handler_unsupported"]);

  // next= 동일 핸들러콜은 계속 허용(인터프리터 지원). 거부는 on-branch 에만 적용됨을 증명.
  expectStaticReasons("next reserved handler still accepted", scenario({
    meta: { name: "nextrh", version: 1 },
    start: "n1",
    nodes: {
      n1: { next: { handler: "@human_task", input: { assignee_role: "reviewer" }, return_node: "n2" } },
      n2: { terminal: "success" },
    },
  }), []);
});

fixture("loop body and exit targets are part of static graph validation", () => {
  expectStaticReasons("loop body/exit valid", scenario({
    meta: { name: "loop", version: 1 },
    params_schema: PARAMS_SCHEMA,
    start: "loop",
    nodes: {
      loop: {
        loop: {
          body_target: "body",
          exit_target: "done",
          until: "loop.page_count >= params.max_pages || flags.no_next_page",
          max_iterations: 2,
        },
      },
      body: { next: "loop" },
      done: { terminal: "success" },
    },
  }), []);
});

// ── @human_task decision/correction 출력(ir-expression §2, ir-static-validation V9/V13) ──

const HUMAN_TASK_NODES = new Map<string, HumanTaskNodeMeta>([
  ["start", {
    correctionFields: new Map<string, readonly IRELTypeAtom[]>([
      ["amount", ["number"]],
      ["memo", ["string"]],
      ["ok", ["boolean"]],
    ]),
  }],
]);

function humanTaskContext(): IRELCompileContext {
  return context({ humanTaskNodes: HUMAN_TASK_NODES });
}

fixture("V9: node.<ht>.decision/correction gated to @human_task owning nodes", () => {
  // decision = string(@human_task 노드만). start 는 extract 의 선행(GRAPH) 이라 forward-ref 통과.
  const decisionAst = compileOk('node.start.decision == "approve"', humanTaskContext());
  assert.equal(evaluateIrelBooleanExpression(decisionAst, { node: { start: { decision: "approve" } } }), true);
  assert.equal(evaluateIrelBooleanExpression(decisionAst, { node: { start: { decision: "reject" } } }), false);

  // correction.<key> 타입은 business_form_v1 fields 에서 결정(amount=number, memo=string, ok=boolean).
  const amountAst = compileOk("node.start.correction.amount > 100", humanTaskContext());
  assert.equal(evaluateIrelBooleanExpression(amountAst, { node: { start: { correction: { amount: 150 } } } }), true);
  assert.equal(evaluateIrelBooleanExpression(amountAst, { node: { start: { correction: { amount: 50 } } } }), false);
  compileOk('node.start.correction.memo == "ok"', humanTaskContext());
  compileOk("node.start.correction.ok", humanTaskContext());

  // 게이트: humanTaskNodes 없는 컨텍스트(일반 노드)에서 decision/correction 참조 → unknown_node_field(V9).
  expectCompileError('node.start.decision == "approve"', "unknown_node_field");
  expectCompileError("node.start.correction.amount > 1", "unknown_node_field");
  // correction 미등록 키 / decision 하위경로 / 타입 불일치도 거부.
  expectCompileError('node.start.correction.unknown_key == "x"', "unknown_node_field", humanTaskContext());
  expectCompileError('node.start.decision.sub == "x"', "unknown_node_field", humanTaskContext());
  expectCompileError('node.start.correction.amount == "x"', "irel_type_error", humanTaskContext());
});

function humanTaskScenario(branchOns: readonly unknown[]): IRScenario {
  return scenario({
    meta: { name: "ht", version: 1 },
    start: "ask",
    nodes: {
      ask: {
        next: {
          handler: "@human_task",
          input: {
            assignee_role: "reviewer",
            result_schema: { version: "business_form_v1", fields: [{ key: "amount", label: "금액", type: "number" }] },
          },
          return_node: "branch",
        },
      },
      branch: { on: branchOns },
      done: { terminal: "success" },
    },
  });
}

fixture("V13: decision branch completeness (promote-block)", () => {
  // 부분 커버(approve/reject 만, correct/retry 누락)·catch-all 없음 → decision_branch_incomplete 경고.
  expectStaticReasons("partial decision coverage warns", humanTaskScenario([
    { when: 'node.ask.decision == "approve"', target: "done", priority: 1 },
    { when: 'node.ask.decision == "reject"', target: "done", priority: 2 },
  ]), [], ["decision_branch_incomplete"]);

  // 닫힌 enum 전부 커버 → 경고 없음.
  expectStaticReasons("full decision coverage clean", humanTaskScenario([
    { when: 'node.ask.decision == "approve"', target: "done", priority: 1 },
    { when: 'node.ask.decision == "reject"', target: "done", priority: 2 },
    { when: 'node.ask.decision == "correct"', target: "done", priority: 3 },
    { when: 'node.ask.decision == "retry"', target: "done", priority: 4 },
  ]), [], []);

  // catch-all(when:true) 이 미커버 decision 흡수 → 경고 없음.
  expectStaticReasons("catch-all suppresses warning", humanTaskScenario([
    { when: 'node.ask.decision == "approve"', target: "done", priority: 1 },
    { when: "true", target: "done", priority: 2 },
  ]), [], []);

  // 복합 표현(&&)으로 decision 참조 + catch-all → 정적 증명 불가지만 catch-all 로 안전(false-positive 없음).
  // 동시에 node.ask.correction.amount(number) 타입 추론이 통과함을 증명.
  expectStaticReasons("impure decision ref with catch-all + typed correction", humanTaskScenario([
    { when: 'node.ask.decision == "approve" && node.ask.correction.amount > 100', target: "done", priority: 1 },
    { when: "true", target: "done", priority: 2 },
  ]), [], []);
});

fixture("V9: decision on a non-@human_task node is a compile error", () => {
  expectStaticReasons("decision ref on plain node rejected", scenario({
    meta: { name: "nd", version: 1 },
    start: "a",
    nodes: {
      a: { next: "b" },
      b: { on: [{ when: 'node.a.decision == "approve"', target: "done", priority: 1 }] },
      done: { terminal: "success" },
    },
  }), ["unknown_node_field"]);
});

console.log(`irel fixtures: ${failures.length === 0 ? "ALL PASS" : `${failures.length} failed`}`);
if (failures.length > 0) {
  for (const failure of failures) console.error("FAIL:", failure);
  process.exit(1);
}
