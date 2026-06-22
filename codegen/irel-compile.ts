/**
 * Deterministic IREL parser, type checker, and pure runtime evaluator.
 *
 * The module boundary mirrors ir-expression.md: save/promote calls parse +
 * typecheck and caches AST; the interpreter evaluates only compiled AST.
 * It never falls back to JavaScript eval, truthy coercion, now(), or random.
 */

export const IREL_ALLOWED_FLAGS = [
  "flags.no_next_page",
  "flags.cursor_reached",
  "flags.login_required",
  "flags.blocked",
  "flags.not_found",
  "flags.no_review_message_visible",
  "flags.reviews_visible",
] as const;

export const IREL_ALLOWED_NODE_FIELDS = [
  "row_count",
  "status",
  "extracted_ref",
  "tier",
] as const;

export type IRELTypeAtom = "int" | "number" | "string" | "boolean" | "null";
export type IRELValue = number | string | boolean | null;
export type IRELCompileErrorCode =
  | "IREL_PARSE_ERROR"
  | "IREL_UNKNOWN_VARIABLE"
  | "IREL_UNKNOWN_FUNCTION"
  | "IREL_TYPE_ERROR"
  | "IREL_FORWARD_REF"
  | "IREL_SCOPE_VIOLATION";

export interface IRELSourceLocation {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

export interface IRELCompileDiagnostic {
  readonly code: IRELCompileErrorCode;
  readonly reason:
    | "irel_parse_error"
    | "unknown_variable"
    | "unknown_flag"
    | "unknown_node_field"
    | "unknown_function"
    | "irel_type_error"
    | "forward_ref"
    | "loop_scope_violation"
    | "params_schema_type_invalid";
  readonly detail: string;
  readonly location?: IRELSourceLocation;
}

export interface IRELCompileContext {
  readonly currentNodeId: string;
  readonly nodeIds: ReadonlySet<string>;
  readonly graph: ReadonlyMap<string, readonly string[]>;
  readonly paramsSchema?: Record<string, unknown>;
  readonly additionalPriorNodeIds?: ReadonlySet<string>;
  readonly allowLoopScope?: boolean;
  readonly expectedType?: IRELTypeAtom;
}

export type IRELCompiledExpression = {
  readonly ast: IRELNode;
  readonly type: readonly IRELTypeAtom[];
};

export type IRELCompileResult =
  | { readonly ok: true; readonly compiled: IRELCompiledExpression }
  | { readonly ok: false; readonly diagnostics: readonly IRELCompileDiagnostic[] };

type Token =
  | { readonly kind: "identifier"; readonly value: string; readonly pos: number }
  | { readonly kind: "number"; readonly value: string; readonly pos: number }
  | { readonly kind: "string"; readonly value: string; readonly pos: number }
  | { readonly kind: "boolean"; readonly value: "true" | "false"; readonly pos: number }
  | { readonly kind: "null"; readonly pos: number }
  | { readonly kind: "symbol"; readonly value: SymbolValue; readonly pos: number }
  | { readonly kind: "eof"; readonly pos: number };

type SymbolValue =
  | "||"
  | "&&"
  | "=="
  | "!="
  | ">="
  | "<="
  | ">"
  | "<"
  | "+"
  | "-"
  | "!"
  | "("
  | ")"
  | ","
  | ".";

export type IRELLiteralNode = {
  readonly kind: "literal";
  readonly valueType: IRELTypeAtom;
  readonly value: IRELValue;
  readonly grouped?: boolean;
};
export type IRELVariableNode = {
  readonly kind: "variable";
  readonly path: readonly string[];
  readonly grouped?: boolean;
};
export type IRELCallNode = {
  readonly kind: "call";
  readonly name: string;
  readonly args: readonly IRELNode[];
  readonly grouped?: boolean;
};
export type IRELUnaryNode = {
  readonly kind: "unary";
  readonly op: "!";
  readonly expr: IRELNode;
  readonly grouped?: boolean;
};
export type IRELBinaryNode = {
  readonly kind: "binary";
  readonly op: "+" | "-";
  readonly left: IRELNode;
  readonly right: IRELNode;
  readonly grouped?: boolean;
};
export type IRELCompareNode = {
  readonly kind: "compare";
  readonly op: "==" | "!=" | ">" | ">=" | "<" | "<=";
  readonly left: IRELNode;
  readonly right: IRELNode;
  readonly grouped?: boolean;
};
export type IRELLogicalNode = {
  readonly kind: "logical";
  readonly op: "&&" | "||";
  readonly left: IRELNode;
  readonly right: IRELNode;
  readonly grouped?: boolean;
};
export type IRELNode =
  | IRELLiteralNode
  | IRELVariableNode
  | IRELCallNode
  | IRELUnaryNode
  | IRELBinaryNode
  | IRELCompareNode
  | IRELLogicalNode;
export type IRELExpressionNode = IRELNode;

export type IRELParseResult =
  | { readonly ok: true; readonly ast: IRELNode }
  | { readonly ok: false; readonly diagnostic: IRELCompileDiagnostic };

export type IRELTypeCheckResult =
  | { readonly ok: true; readonly type: readonly IRELTypeAtom[] }
  | { readonly ok: false; readonly diagnostics: readonly IRELCompileDiagnostic[] };

export interface IRELScope {
  readonly params?: Record<string, unknown>;
  readonly node?: Record<string, Record<string, unknown>>;
  readonly cursor?: Record<string, unknown>;
  readonly flags?: Record<string, unknown>;
  readonly loop?: Record<string, unknown>;
}

export class IRELRuntimeMissingError extends Error {
  readonly code = "IREL_RUNTIME_MISSING";

  constructor(detail: string) {
    super(detail);
    this.name = "IRELRuntimeMissingError";
  }
}

type TypeResult =
  | { readonly ok: true; readonly type: readonly IRELTypeAtom[] }
  | { readonly ok: false };

const FLAG_SET = new Set<string>(IREL_ALLOWED_FLAGS);
const NODE_FIELD_SET = new Set<string>(IREL_ALLOWED_NODE_FIELDS);
const CURSOR_FIELDS: Readonly<Record<string, readonly IRELTypeAtom[]>> = {
  last_review_id: typeOf("string", "null"),
};

export function compileIrelExpression(
  expression: string,
  context: IRELCompileContext,
): IRELCompileResult {
  const parsed = parseIrelExpression(expression);
  if (!parsed.ok) return { ok: false, diagnostics: [parsed.diagnostic] };

  const checked = typeCheckIrelExpression(parsed.ast, context);
  return checked.ok
    ? { ok: true, compiled: { ast: parsed.ast, type: checked.type } }
    : { ok: false, diagnostics: checked.diagnostics };
}

export function parseIrelExpression(expression: string): IRELParseResult {
  const lexed = tokenize(expression);
  if (!lexed.ok) return { ok: false, diagnostic: lexed.diagnostic };

  const parser = new Parser(lexed.tokens, expression);
  return parser.parse();
}

export function typeCheckIrelExpression(
  ast: IRELNode,
  context: IRELCompileContext,
): IRELTypeCheckResult {
  const diagnostics: IRELCompileDiagnostic[] = [];
  const typeResult = typeCheck(ast, context, diagnostics);
  if (!typeResult.ok) return { ok: false, diagnostics };

  if (
    context.expectedType !== undefined &&
    !isExactly(typeResult.type, context.expectedType)
  ) {
    diagnostics.push(
      diagnostic(
        "IREL_TYPE_ERROR",
        "irel_type_error",
        `expression must return ${context.expectedType}, got ${formatType(typeResult.type)}`,
      ),
    );
  }

  return diagnostics.length === 0 ? { ok: true, type: typeResult.type } : { ok: false, diagnostics };
}

export function validateParamsSchemaForIrel(
  paramsSchema: Record<string, unknown> | undefined,
): IRELCompileDiagnostic | undefined {
  if (paramsSchema === undefined) return undefined;
  if (!schemaCanBeObject(paramsSchema)) {
    return diagnostic(
      "IREL_TYPE_ERROR",
      "params_schema_type_invalid",
      "params_schema must be an object schema for deterministic params.* type inference",
    );
  }
  return undefined;
}

export function evaluateIrelExpression(ast: IRELNode, scope: IRELScope): IRELValue {
  switch (ast.kind) {
    case "literal":
      return ast.value;
    case "variable":
      return resolveRuntimeVariable(ast.path, scope);
    case "call":
      return evaluateCall(ast, scope);
    case "unary": {
      const value = evaluateIrelExpression(ast.expr, scope);
      return !expectRuntimeBoolean(value, "! operand");
    }
    case "binary": {
      const left = expectRuntimeNumber(evaluateIrelExpression(ast.left, scope), `${ast.op} left operand`);
      const right = expectRuntimeNumber(evaluateIrelExpression(ast.right, scope), `${ast.op} right operand`);
      return ast.op === "+" ? left + right : left - right;
    }
    case "compare":
      return evaluateCompare(ast, scope);
    case "logical":
      return evaluateLogical(ast, scope);
  }
}

export function evaluateIrelBooleanExpression(ast: IRELNode, scope: IRELScope): boolean {
  return expectRuntimeBoolean(evaluateIrelExpression(ast, scope), "expression result");
}

function tokenize(input: string): { ok: true; tokens: Token[] } | { ok: false; diagnostic: IRELCompileDiagnostic } {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i += 1;
      continue;
    }

    if (isIdentifierStart(ch)) {
      const start = i;
      i += 1;
      while (i < input.length && isIdentifierPart(input[i])) i += 1;
      const value = input.slice(start, i);
      if (value === "true" || value === "false") {
        tokens.push({ kind: "boolean", value, pos: start });
      } else if (value === "null") {
        tokens.push({ kind: "null", pos: start });
      } else {
        tokens.push({ kind: "identifier", value, pos: start });
      }
      continue;
    }

    if (isDigit(ch)) {
      const start = i;
      i = readNumber(input, i);
      tokens.push({ kind: "number", value: input.slice(start, i), pos: start });
      continue;
    }

    if (ch === "\"") {
      const start = i;
      i += 1;
      let value = "";
      let closed = false;
      while (i < input.length) {
        const current = input[i];
        if (current === "\\" || current === "\n" || current === "\r") {
          return { ok: false, diagnostic: parseDiagnostic(input, start, "string literals may not contain escapes or newlines") };
        }
        if (current === "\"") {
          closed = true;
          i += 1;
          break;
        }
        value += current;
        i += 1;
      }
      if (!closed) return { ok: false, diagnostic: parseDiagnostic(input, start, "unterminated string literal") };
      tokens.push({ kind: "string", value, pos: start });
      continue;
    }

    const two = input.slice(i, i + 2);
    if (isSymbol(two)) {
      tokens.push({ kind: "symbol", value: two, pos: i });
      i += 2;
      continue;
    }
    if (isSymbol(ch)) {
      tokens.push({ kind: "symbol", value: ch, pos: i });
      i += 1;
      continue;
    }

    return { ok: false, diagnostic: parseDiagnostic(input, i, `unexpected character '${ch}'`) };
  }

  tokens.push({ kind: "eof", pos: input.length });
  return { ok: true, tokens };
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly source: string,
  ) {}

  parse(): { ok: true; ast: IRELNode } | { ok: false; diagnostic: IRELCompileDiagnostic } {
    try {
      const ast = this.parseOr();
      const token = this.peek();
      if (token.kind !== "eof") throw this.error(token.pos, "unexpected trailing token");
      return { ok: true, ast };
    } catch (err: unknown) {
      if (err instanceof ParseError) return { ok: false, diagnostic: err.diagnostic };
      throw err;
    }
  }

  private parseOr(): IRELNode {
    let left = this.parseAnd();
    while (this.match("||")) {
      const op = this.previous();
      if (isUngroupedLogical(left, "&&")) {
        throw this.error(op.pos, "mixed && and || requires explicit parentheses");
      }
      const right = this.parseAnd();
      if (isUngroupedLogical(right, "&&")) {
        throw this.error(op.pos, "mixed && and || requires explicit parentheses");
      }
      left = { kind: "logical", op: "||", left, right };
    }
    return left;
  }

  private parseAnd(): IRELNode {
    let left = this.parseNot();
    while (this.match("&&")) {
      const right = this.parseNot();
      left = { kind: "logical", op: "&&", left, right };
    }
    return left;
  }

  private parseNot(): IRELNode {
    if (!this.match("!")) return this.parseComparison();
    const op = this.previous();
    const expr = this.parseComparison();
    if (expr.kind === "compare" && expr.grouped !== true) {
      throw this.error(op.pos, "! with a comparison requires explicit parentheses");
    }
    return { kind: "unary", op: "!", expr };
  }

  private parseComparison(): IRELNode {
    const left = this.parseAdditive();
    if (!this.match("==", "!=", ">", ">=", "<", "<=")) return left;
    const op = this.previous().value;
    if (!isCompareOp(op)) throw this.error(this.previous().pos, "invalid comparison operator");
    const right = this.parseAdditive();
    if (this.match("==", "!=", ">", ">=", "<", "<=")) {
      throw this.error(this.previous().pos, "chained comparisons are not allowed");
    }
    return { kind: "compare", op, left, right };
  }

  private parseAdditive(): IRELNode {
    let left = this.parsePrimary();
    while (this.match("+", "-")) {
      const op = this.previous().value;
      if (op !== "+" && op !== "-") throw this.error(this.previous().pos, "invalid additive operator");
      const right = this.parsePrimary();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parsePrimary(): IRELNode {
    const token = this.peek();
    if (token.kind === "number") {
      this.advance();
      return {
        kind: "literal",
        valueType: token.value.includes(".") ? "number" : "int",
        value: Number(token.value),
      };
    }
    if (token.kind === "string") {
      this.advance();
      return { kind: "literal", valueType: "string", value: token.value };
    }
    if (token.kind === "boolean") {
      this.advance();
      return { kind: "literal", valueType: "boolean", value: token.value === "true" };
    }
    if (token.kind === "null") {
      this.advance();
      return { kind: "literal", valueType: "null", value: null };
    }
    if (this.match("-")) {
      const next = this.peek();
      if (next.kind !== "number") throw this.error(this.previous().pos, "unary - is only allowed on numeric literals");
      this.advance();
      return {
        kind: "literal",
        valueType: next.value.includes(".") ? "number" : "int",
        value: -Number(next.value),
      };
    }
    if (token.kind === "identifier") return this.parseIdentifierPrimary();
    if (this.match("(")) {
      const expr = this.parseOr();
      this.consume(")", "expected ')' after expression");
      return markGrouped(expr);
    }
    throw this.error(token.pos, "expected expression");
  }

  private parseIdentifierPrimary(): IRELNode {
    const name = this.consumeIdentifier("expected identifier").value;
    if (this.match("(")) {
      const args: IRELNode[] = [];
      if (!this.check(")")) {
        do {
          args.push(this.parseOr());
        } while (this.match(","));
      }
      this.consume(")", "expected ')' after function arguments");
      return { kind: "call", name, args };
    }

    const path = [name];
    while (this.match(".")) {
      path.push(this.consumeIdentifier("expected identifier after '.'").value);
    }
    return { kind: "variable", path };
  }

  private match(...values: readonly SymbolValue[]): boolean {
    const token = this.peek();
    if (token.kind !== "symbol" || !values.includes(token.value)) return false;
    this.index += 1;
    return true;
  }

  private consume(value: SymbolValue, message: string): Token {
    if (this.match(value)) return this.previous();
    throw this.error(this.peek().pos, message);
  }

  private consumeIdentifier(message: string): Extract<Token, { kind: "identifier" }> {
    const token = this.peek();
    if (token.kind !== "identifier") throw this.error(token.pos, message);
    this.index += 1;
    return token;
  }

  private check(value: SymbolValue): boolean {
    const token = this.peek();
    return token.kind === "symbol" && token.value === value;
  }

  private advance(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  private previous(): Extract<Token, { kind: "symbol" }> {
    const token = this.tokens[this.index - 1];
    if (token?.kind !== "symbol") throw new Error("parser invariant failed");
    return token;
  }

  private peek(): Token {
    return this.tokens[this.index] ?? { kind: "eof", pos: this.tokens[this.tokens.length - 1]?.pos ?? 0 };
  }

  private error(pos: number, message: string): ParseError {
    return new ParseError(parseDiagnostic(this.source, pos, message));
  }
}

class ParseError extends Error {
  constructor(readonly diagnostic: IRELCompileDiagnostic) {
    super(diagnostic.detail);
  }
}

function evaluateLogical(
  ast: Extract<IRELNode, { kind: "logical" }>,
  scope: IRELScope,
): boolean {
  const left = expectRuntimeBoolean(evaluateIrelExpression(ast.left, scope), `${ast.op} left operand`);
  const right = expectRuntimeBoolean(evaluateIrelExpression(ast.right, scope), `${ast.op} right operand`);
  return ast.op === "||" ? left || right : left && right;
}

function evaluateCompare(
  ast: Extract<IRELNode, { kind: "compare" }>,
  scope: IRELScope,
): boolean {
  const left = evaluateIrelExpression(ast.left, scope);
  const right = evaluateIrelExpression(ast.right, scope);
  switch (ast.op) {
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    case ">":
      return expectRuntimeNumber(left, "> left operand") > expectRuntimeNumber(right, "> right operand");
    case ">=":
      return expectRuntimeNumber(left, ">= left operand") >= expectRuntimeNumber(right, ">= right operand");
    case "<":
      return expectRuntimeNumber(left, "< left operand") < expectRuntimeNumber(right, "< right operand");
    case "<=":
      return expectRuntimeNumber(left, "<= left operand") <= expectRuntimeNumber(right, "<= right operand");
  }
}

function evaluateCall(
  ast: Extract<IRELNode, { kind: "call" }>,
  scope: IRELScope,
): IRELValue {
  switch (ast.name) {
    case "len": {
      requireRuntimeArity(ast, 1);
      return expectRuntimeString(evaluateIrelExpression(ast.args[0] as IRELNode, scope), "len argument 1").length;
    }
    case "is_null": {
      requireRuntimeArity(ast, 1);
      return evaluateIrelExpression(ast.args[0] as IRELNode, scope) === null;
    }
    case "coalesce": {
      requireRuntimeArity(ast, 2);
      const first = evaluateIrelExpression(ast.args[0] as IRELNode, scope);
      return first === null ? evaluateIrelExpression(ast.args[1] as IRELNode, scope) : first;
    }
    case "date_before": {
      requireRuntimeArity(ast, 2);
      return runtimeDateMillis(ast.args[0] as IRELNode, scope, "date_before argument 1") <
        runtimeDateMillis(ast.args[1] as IRELNode, scope, "date_before argument 2");
    }
    case "date_after": {
      requireRuntimeArity(ast, 2);
      return runtimeDateMillis(ast.args[0] as IRELNode, scope, "date_after argument 1") >
        runtimeDateMillis(ast.args[1] as IRELNode, scope, "date_after argument 2");
    }
    case "starts_with": {
      requireRuntimeArity(ast, 2);
      const value = expectRuntimeString(evaluateIrelExpression(ast.args[0] as IRELNode, scope), "starts_with argument 1");
      const prefix = expectRuntimeString(evaluateIrelExpression(ast.args[1] as IRELNode, scope), "starts_with argument 2");
      return value.startsWith(prefix);
    }
    case "contains": {
      requireRuntimeArity(ast, 2);
      const value = expectRuntimeString(evaluateIrelExpression(ast.args[0] as IRELNode, scope), "contains argument 1");
      const needle = expectRuntimeString(evaluateIrelExpression(ast.args[1] as IRELNode, scope), "contains argument 2");
      return value.includes(needle);
    }
    default:
      throw new IRELRuntimeMissingError(`unknown compiled function '${ast.name}'`);
  }
}

function requireRuntimeArity(ast: Extract<IRELNode, { kind: "call" }>, expected: number): void {
  if (ast.args.length !== expected) {
    throw new IRELRuntimeMissingError(`${ast.name} expected ${expected} arguments, got ${ast.args.length}`);
  }
}

function runtimeDateMillis(ast: IRELNode, scope: IRELScope, detail: string): number {
  const value = expectRuntimeString(evaluateIrelExpression(ast, scope), detail);
  // 결정성(ir-expression §5; now() 금지·재시도/replay 동일 결과): 오프셋 없는 datetime 은 ECMAScript 상
  // 호스트 로컬 TZ 로 파싱돼 워커마다 다른 밀리초를 낸다. date-only(YYYY-MM-DD)는 UTC 자정으로 결정적이므로 허용하고,
  // 시각을 포함한 datetime 은 명시 오프셋(Z 또는 ±HH:MM)을 요구한다(가정 금지: 로컬→UTC 암묵 가정 금지, loud reject).
  if (/[tT]/.test(value) && !/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value)) {
    throw new IRELRuntimeMissingError(
      `${detail} datetime '${value}' requires an explicit UTC offset ('Z' or ±HH:MM) for deterministic comparison`,
    );
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new IRELRuntimeMissingError(`${detail} must be an ISO-8601 string`);
  }
  return millis;
}

function resolveRuntimeVariable(path: readonly string[], scope: IRELScope): IRELValue {
  const [namespace] = path;
  if (namespace === "params") return toRuntimeValue(readRuntimePath(scope.params, path.slice(1), path.join(".")), path.join("."));
  if (namespace === "node") {
    const [, nodeId, field] = path;
    if (path.length !== 3 || nodeId === undefined || field === undefined) {
      throw new IRELRuntimeMissingError(`invalid compiled node path '${path.join(".")}'`);
    }
    const nodeOutput = readRuntimePath(scope.node, [nodeId], `node.${nodeId}`);
    if (!isRecord(nodeOutput)) throw new IRELRuntimeMissingError(`node.${nodeId} is missing from runtime scope`);
    return toRuntimeValue(readRuntimePath(nodeOutput, [field], path.join(".")), path.join("."));
  }
  if (namespace === "cursor") return toRuntimeValue(readRuntimePath(scope.cursor, path.slice(1), path.join(".")), path.join("."));
  if (namespace === "flags") return toRuntimeValue(readRuntimePath(scope.flags, path.slice(1), path.join(".")), path.join("."));
  if (namespace === "loop") return toRuntimeValue(readRuntimePath(scope.loop, path.slice(1), path.join(".")), path.join("."));
  throw new IRELRuntimeMissingError(`unknown compiled variable namespace '${namespace ?? "<empty>"}'`);
}

function readRuntimePath(root: unknown, path: readonly string[], label: string): unknown {
  if (path.length === 0) throw new IRELRuntimeMissingError(`${label} requires a property path`);
  let current: unknown = root;
  for (const part of path) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      throw new IRELRuntimeMissingError(`${label} is missing from runtime scope`);
    }
    current = current[part];
  }
  if (current === undefined) throw new IRELRuntimeMissingError(`${label} is missing from runtime scope`);
  return current;
}

function toRuntimeValue(value: unknown, label: string): IRELValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new IRELRuntimeMissingError(`${label} is not a scalar IREL runtime value`);
}

function expectRuntimeBoolean(value: IRELValue, detail: string): boolean {
  if (typeof value === "boolean") return value;
  throw new IRELRuntimeMissingError(`${detail} must be boolean, got ${runtimeTypeOf(value)}`);
}

function expectRuntimeNumber(value: IRELValue, detail: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new IRELRuntimeMissingError(`${detail} must be number, got ${runtimeTypeOf(value)}`);
}

function expectRuntimeString(value: IRELValue, detail: string): string {
  if (typeof value === "string") return value;
  throw new IRELRuntimeMissingError(`${detail} must be string, got ${runtimeTypeOf(value)}`);
}

function runtimeTypeOf(value: IRELValue): IRELTypeAtom {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "number";
  if (typeof value === "string") return "string";
  return "boolean";
}

function typeCheck(
  ast: IRELNode,
  context: IRELCompileContext,
  diagnostics: IRELCompileDiagnostic[],
): TypeResult {
  switch (ast.kind) {
    case "literal":
      return okType(typeOf(ast.valueType));
    case "variable":
      return resolveVariable(ast.path, context, diagnostics);
    case "call":
      return typeCheckCall(ast, context, diagnostics);
    case "unary": {
      const inner = typeCheck(ast.expr, context, diagnostics);
      if (!inner.ok) return inner;
      if (!isExactly(inner.type, "boolean")) {
        diagnostics.push(diagnostic("IREL_TYPE_ERROR", "irel_type_error", `! requires boolean, got ${formatType(inner.type)}`));
        return failType();
      }
      return okType(typeOf("boolean"));
    }
    case "binary": {
      const left = typeCheck(ast.left, context, diagnostics);
      const right = typeCheck(ast.right, context, diagnostics);
      if (!left.ok || !right.ok) return failType();
      if (!isNumeric(left.type) || !isNumeric(right.type)) {
        diagnostics.push(diagnostic("IREL_TYPE_ERROR", "irel_type_error", `${ast.op} requires numeric operands, got ${formatType(left.type)} and ${formatType(right.type)}`));
        return failType();
      }
      return okType(left.type.includes("number") || right.type.includes("number") ? typeOf("number") : typeOf("int"));
    }
    case "compare": {
      const left = typeCheck(ast.left, context, diagnostics);
      const right = typeCheck(ast.right, context, diagnostics);
      if (!left.ok || !right.ok) return failType();
      if (ast.op === "==" || ast.op === "!=") {
        if (!canCompareEquality(left.type, right.type)) {
          diagnostics.push(diagnostic("IREL_TYPE_ERROR", "irel_type_error", `${ast.op} requires compatible operands, got ${formatType(left.type)} and ${formatType(right.type)}`));
          return failType();
        }
        return okType(typeOf("boolean"));
      }
      if (!isNumeric(left.type) || !isNumeric(right.type)) {
        diagnostics.push(diagnostic("IREL_TYPE_ERROR", "irel_type_error", `${ast.op} requires numeric operands, got ${formatType(left.type)} and ${formatType(right.type)}`));
        return failType();
      }
      return okType(typeOf("boolean"));
    }
    case "logical": {
      const left = typeCheck(ast.left, context, diagnostics);
      const right = typeCheck(ast.right, context, diagnostics);
      if (!left.ok || !right.ok) return failType();
      if (!isExactly(left.type, "boolean") || !isExactly(right.type, "boolean")) {
        diagnostics.push(diagnostic("IREL_TYPE_ERROR", "irel_type_error", `${ast.op} requires boolean operands, got ${formatType(left.type)} and ${formatType(right.type)}`));
        return failType();
      }
      return okType(typeOf("boolean"));
    }
  }
}

function typeCheckCall(
  ast: Extract<IRELNode, { kind: "call" }>,
  context: IRELCompileContext,
  diagnostics: IRELCompileDiagnostic[],
): TypeResult {
  const argTypes: readonly IRELTypeAtom[][] = ast.args.map((arg) => {
    const result = typeCheck(arg, context, diagnostics);
    return result.ok ? [...result.type] : [];
  });
  if (argTypes.some((arg) => arg.length === 0)) return failType();

  switch (ast.name) {
    case "len":
      return expectArgs(ast.name, argTypes, [typeOf("string")], "int", diagnostics);
    case "is_null":
      if (argTypes.length !== 1) return wrongArity(ast.name, 1, argTypes.length, diagnostics);
      return okType(typeOf("boolean"));
    case "coalesce":
      return typeCheckCoalesce(argTypes, diagnostics);
    case "date_before":
    case "date_after":
    case "starts_with":
    case "contains":
      return expectArgs(ast.name, argTypes, [typeOf("string"), typeOf("string")], "boolean", diagnostics);
    default:
      diagnostics.push(diagnostic("IREL_UNKNOWN_FUNCTION", "unknown_function", `unknown function '${ast.name}'`));
      return failType();
  }
}

function resolveVariable(
  path: readonly string[],
  context: IRELCompileContext,
  diagnostics: IRELCompileDiagnostic[],
): TypeResult {
  const [namespace] = path;
  if (namespace === undefined) {
    diagnostics.push(diagnostic("IREL_UNKNOWN_VARIABLE", "unknown_variable", "empty variable path"));
    return failType();
  }

  if (namespace === "flags") {
    const full = path.join(".");
    if (path.length !== 2 || !FLAG_SET.has(full)) {
      diagnostics.push(diagnostic("IREL_UNKNOWN_VARIABLE", "unknown_flag", `unknown flag '${full}'`));
      return failType();
    }
    return okType(typeOf("boolean"));
  }

  if (namespace === "loop") {
    if (context.allowLoopScope !== true) {
      diagnostics.push(diagnostic("IREL_SCOPE_VIOLATION", "loop_scope_violation", `loop scope is not available at node '${context.currentNodeId}'`));
      return failType();
    }
    if (path.length !== 2 || (path[1] !== "iteration" && path[1] !== "page_count")) {
      diagnostics.push(diagnostic("IREL_UNKNOWN_VARIABLE", "unknown_variable", `unknown loop variable '${path.join(".")}'`));
      return failType();
    }
    return okType(typeOf("int"));
  }

  if (namespace === "cursor") {
    if (path.length !== 2 || path[1] === undefined || CURSOR_FIELDS[path[1]] === undefined) {
      diagnostics.push(diagnostic("IREL_UNKNOWN_VARIABLE", "unknown_variable", `unknown cursor variable '${path.join(".")}'`));
      return failType();
    }
    return okType(CURSOR_FIELDS[path[1]]);
  }

  if (namespace === "node") {
    return resolveNodeVariable(path, context, diagnostics);
  }

  if (namespace === "params") {
    return resolveParamVariable(path.slice(1), context.paramsSchema, diagnostics);
  }

  diagnostics.push(diagnostic("IREL_UNKNOWN_VARIABLE", "unknown_variable", `unknown variable namespace '${namespace}'`));
  return failType();
}

function resolveNodeVariable(
  path: readonly string[],
  context: IRELCompileContext,
  diagnostics: IRELCompileDiagnostic[],
): TypeResult {
  if (path.length !== 3 || path[1] === undefined || path[2] === undefined) {
    diagnostics.push(diagnostic("IREL_UNKNOWN_VARIABLE", "unknown_variable", `node references must be node.<id>.<field>, got '${path.join(".")}'`));
    return failType();
  }

  const [, nodeId, field] = path;
  if (!NODE_FIELD_SET.has(field)) {
    diagnostics.push(diagnostic("IREL_UNKNOWN_VARIABLE", "unknown_node_field", `unknown node output field '${field}'`));
    return failType();
  }
  if (!context.nodeIds.has(nodeId)) {
    diagnostics.push(diagnostic("IREL_UNKNOWN_VARIABLE", "unknown_variable", `unknown node reference '${nodeId}'`));
    return failType();
  }
  if (
    context.additionalPriorNodeIds?.has(nodeId) !== true &&
    (nodeId === context.currentNodeId || !isAncestor(nodeId, context.currentNodeId, context.graph))
  ) {
    diagnostics.push(diagnostic("IREL_FORWARD_REF", "forward_ref", `node '${nodeId}' is not a prior dependency of '${context.currentNodeId}'`));
    return failType();
  }

  if (field === "row_count") return okType(typeOf("int"));
  return okType(typeOf("string"));
}

function resolveParamVariable(
  path: readonly string[],
  paramsSchema: Record<string, unknown> | undefined,
  diagnostics: IRELCompileDiagnostic[],
): TypeResult {
  if (path.length === 0) {
    diagnostics.push(diagnostic("IREL_UNKNOWN_VARIABLE", "unknown_variable", "params namespace requires a property path"));
    return failType();
  }
  if (paramsSchema === undefined) {
    diagnostics.push(diagnostic("IREL_UNKNOWN_VARIABLE", "unknown_variable", `params.${path.join(".")} is not declared because params_schema is absent`));
    return failType();
  }
  if (!schemaCanBeObject(paramsSchema)) {
    diagnostics.push(diagnostic("IREL_TYPE_ERROR", "params_schema_type_invalid", "params_schema must be an object schema for params.* references"));
    return failType();
  }

  let schema: Record<string, unknown> = paramsSchema;
  for (let index = 0; index < path.length; index += 1) {
    const part = path[index];
    if (part === undefined) {
      diagnostics.push(diagnostic("IREL_UNKNOWN_VARIABLE", "unknown_variable", "empty params path segment"));
      return failType();
    }
    const properties = readProperties(schema);
    const child = properties[part];
    if (!isRecord(child)) {
      diagnostics.push(diagnostic("IREL_UNKNOWN_VARIABLE", "unknown_variable", `params.${path.slice(0, index + 1).join(".")} is not declared in params_schema`));
      return failType();
    }
    if (index === path.length - 1) {
      const inferred = inferPrimitiveSchemaType(child);
      if (inferred === undefined) {
        diagnostics.push(diagnostic("IREL_TYPE_ERROR", "params_schema_type_invalid", `params.${path.join(".")} must have a deterministic scalar JSON Schema type`));
        return failType();
      }
      return okType(inferred);
    }
    if (!schemaCanBeObject(child)) {
      diagnostics.push(diagnostic("IREL_TYPE_ERROR", "params_schema_type_invalid", `params.${path.slice(0, index + 1).join(".")} must be an object schema for nested params access`));
      return failType();
    }
    schema = child;
  }

  diagnostics.push(diagnostic("IREL_UNKNOWN_VARIABLE", "unknown_variable", "empty params path"));
  return failType();
}

function expectArgs(
  name: string,
  actual: readonly (readonly IRELTypeAtom[])[],
  expected: readonly (readonly IRELTypeAtom[])[],
  returnType: IRELTypeAtom,
  diagnostics: IRELCompileDiagnostic[],
): TypeResult {
  if (actual.length !== expected.length) return wrongArity(name, expected.length, actual.length, diagnostics);
  for (let i = 0; i < expected.length; i += 1) {
    const actualType = actual[i];
    const expectedType = expected[i];
    if (actualType === undefined || expectedType === undefined || !isAssignable(actualType, expectedType)) {
      diagnostics.push(diagnostic("IREL_TYPE_ERROR", "irel_type_error", `${name} argument ${i + 1} expects ${formatType(expectedType ?? [])}, got ${formatType(actualType ?? [])}`));
      return failType();
    }
  }
  return okType(typeOf(returnType));
}

function wrongArity(
  name: string,
  expected: number,
  actual: number,
  diagnostics: IRELCompileDiagnostic[],
): TypeResult {
  diagnostics.push(diagnostic("IREL_TYPE_ERROR", "irel_type_error", `${name} expects ${expected} arguments, got ${actual}`));
  return failType();
}

function typeCheckCoalesce(
  argTypes: readonly (readonly IRELTypeAtom[])[],
  diagnostics: IRELCompileDiagnostic[],
): TypeResult {
  if (argTypes.length !== 2) return wrongArity("coalesce", 2, argTypes.length, diagnostics);
  const first = argTypes[0] ?? [];
  const second = argTypes[1] ?? [];
  if (!first.includes("null")) {
    diagnostics.push(diagnostic("IREL_TYPE_ERROR", "irel_type_error", `coalesce first argument must include null, got ${formatType(first)}`));
    return failType();
  }
  const firstWithoutNull = first.filter((atom) => atom !== "null");
  if (firstWithoutNull.length > 0 && !isAssignable(second, firstWithoutNull)) {
    diagnostics.push(diagnostic("IREL_TYPE_ERROR", "irel_type_error", `coalesce fallback must match ${formatType(firstWithoutNull)}, got ${formatType(second)}`));
    return failType();
  }
  return okType(firstWithoutNull.length > 0 ? firstWithoutNull : second);
}

function inferPrimitiveSchemaType(schema: Record<string, unknown>): readonly IRELTypeAtom[] | undefined {
  const constType = literalType(schema.const);
  if (constType !== undefined) return typeOf(constType);

  if (Array.isArray(schema.enum)) {
    const atoms = schema.enum.map(literalType);
    if (atoms.some((atom) => atom === undefined)) return undefined;
    return uniqueTypes(atoms.filter((atom): atom is IRELTypeAtom => atom !== undefined));
  }

  const rawType = schema.type;
  if (typeof rawType === "string") return schemaTypeAtom(rawType);
  if (Array.isArray(rawType)) {
    const atoms = rawType.map((entry) => (typeof entry === "string" ? schemaTypeAtom(entry) : undefined));
    if (atoms.some((atom) => atom === undefined)) return undefined;
    return uniqueTypes(atoms.flatMap((atom) => atom ?? []));
  }
  return undefined;
}

function schemaTypeAtom(typeName: string): readonly IRELTypeAtom[] | undefined {
  switch (typeName) {
    case "integer":
      return typeOf("int");
    case "number":
      return typeOf("number");
    case "string":
      return typeOf("string");
    case "boolean":
      return typeOf("boolean");
    case "null":
      return typeOf("null");
    default:
      return undefined;
  }
}

function schemaCanBeObject(schema: Record<string, unknown>): boolean {
  const rawType = schema.type;
  if (rawType === undefined) return true;
  if (rawType === "object") return true;
  return false;
}

function readProperties(schema: Record<string, unknown>): Record<string, unknown> {
  return isRecord(schema.properties) ? schema.properties : {};
}

function literalType(value: unknown): IRELTypeAtom | undefined {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(value) ? "int" : "number";
    default:
      return undefined;
  }
}

function isAncestor(
  candidate: string,
  current: string,
  graph: ReadonlyMap<string, readonly string[]>,
): boolean {
  const reverse = new Map<string, string[]>();
  for (const [from, targets] of graph) {
    for (const target of targets) {
      const incoming = reverse.get(target) ?? [];
      incoming.push(from);
      reverse.set(target, incoming);
    }
  }

  const seen = new Set<string>();
  const stack = [...(reverse.get(current) ?? [])];
  while (stack.length > 0) {
    const nodeId = stack.pop() as string;
    if (nodeId === candidate) return true;
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    stack.push(...(reverse.get(nodeId) ?? []));
  }
  return false;
}

function parseDiagnostic(source: string, pos: number, message: string): IRELCompileDiagnostic {
  const location = sourceLocation(source, pos);
  return diagnostic(
    "IREL_PARSE_ERROR",
    "irel_parse_error",
    `${message} at line ${location.line}, column ${location.column} (offset ${location.offset})`,
    location,
  );
}

function diagnostic(
  code: IRELCompileErrorCode,
  reason: IRELCompileDiagnostic["reason"],
  detail: string,
  location?: IRELSourceLocation,
): IRELCompileDiagnostic {
  return location === undefined ? { code, reason, detail } : { code, reason, detail, location };
}

function sourceLocation(source: string, pos: number): IRELSourceLocation {
  const offset = Math.max(0, Math.min(pos, source.length));
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset; i += 1) {
    if (source[i] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { offset, line, column };
}

function okType(type: readonly IRELTypeAtom[]): TypeResult {
  return { ok: true, type };
}

function failType(): TypeResult {
  return { ok: false };
}

function typeOf(...atoms: readonly IRELTypeAtom[]): readonly IRELTypeAtom[] {
  return uniqueTypes(atoms);
}

function uniqueTypes(atoms: readonly IRELTypeAtom[]): readonly IRELTypeAtom[] {
  const order: readonly IRELTypeAtom[] = ["int", "number", "string", "boolean", "null"];
  const set = new Set(atoms);
  return order.filter((atom) => set.has(atom));
}

function isNumeric(type: readonly IRELTypeAtom[]): boolean {
  return type.length > 0 && type.every((atom) => atom === "int" || atom === "number");
}

function isExactly(type: readonly IRELTypeAtom[], atom: IRELTypeAtom): boolean {
  return type.length === 1 && type[0] === atom;
}

function canCompareEquality(left: readonly IRELTypeAtom[], right: readonly IRELTypeAtom[]): boolean {
  if (isExactly(left, "null") || isExactly(right, "null")) return true;
  if (isNumeric(left) && isNumeric(right)) return true;
  return left.some((atom) => atom !== "null" && right.includes(atom));
}

function isAssignable(actual: readonly IRELTypeAtom[], expected: readonly IRELTypeAtom[]): boolean {
  if (expected.length === 0 || actual.length === 0) return false;
  if (expected.every((atom) => atom === "int" || atom === "number") && isNumeric(actual)) return true;
  return actual.every((atom) => expected.includes(atom));
}

function formatType(type: readonly IRELTypeAtom[]): string {
  return type.length === 0 ? "<invalid>" : type.join("|");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function markGrouped(node: IRELNode): IRELNode {
  return { ...node, grouped: true } as IRELNode;
}

function isUngroupedLogical(node: IRELNode, op: "&&" | "||"): boolean {
  return node.kind === "logical" && node.op === op && node.grouped !== true;
}

function isIdentifierStart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z_]/.test(ch);
}

function isIdentifierPart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && /[0-9]/.test(ch);
}

function readNumber(input: string, start: number): number {
  let i = start;
  while (i < input.length && isDigit(input[i])) i += 1;
  if (input[i] === "." && isDigit(input[i + 1])) {
    i += 1;
    while (i < input.length && isDigit(input[i])) i += 1;
  }
  return i;
}

function isSymbol(value: string): value is SymbolValue {
  return (
    value === "||" ||
    value === "&&" ||
    value === "==" ||
    value === "!=" ||
    value === ">=" ||
    value === "<=" ||
    value === ">" ||
    value === "<" ||
    value === "+" ||
    value === "-" ||
    value === "!" ||
    value === "(" ||
    value === ")" ||
    value === "," ||
    value === "."
  );
}

function isCompareOp(value: SymbolValue): value is "==" | "!=" | ">" | ">=" | "<" | "<=" {
  return value === "==" || value === "!=" || value === ">" || value === ">=" || value === "<" || value === "<=";
}
