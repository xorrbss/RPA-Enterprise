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
  type IRELCompileContext,
  type IRELCompileDiagnostic,
  type IRELLiteralNode,
  type IRELNode,
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

fixture("vlm_fallback.when is compiled", () => {
  expectStaticReasons("vlm_fallback.when valid", {
    meta: { name: "vlm", version: 1 },
    start: "n1",
    nodes: {
      n1: {
        verify: {
          criteria: [{ type: "min_rows", n: 1 }],
          vlm_fallback: { prompt: "inspect", when: "flags.reviews_visible" },
        },
        terminal: "success",
      },
    },
  }, []);

  expectStaticReasons("vlm_fallback.when invalid", {
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
  }, ["unknown_flag"]);
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

console.log(`irel fixtures: ${failures.length === 0 ? "ALL PASS" : `${failures.length} failed`}`);
if (failures.length > 0) {
  for (const failure of failures) console.error("FAIL:", failure);
  process.exit(1);
}
