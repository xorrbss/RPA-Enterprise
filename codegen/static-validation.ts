/**
 * D1 codegen — IR graph static validation (ir-static-validation.md V1..V12).
 *
 * This is intentionally deterministic and side-effect free. It runs after
 * `validateIR` succeeds, so it can use the generated IRScenario shape.
 */
import type {
  IRScenario,
  IRNode,
  ValidationIssue,
  ValidationReport,
} from "./types";
import {
  compileIrelExpression,
  validateParamsSchemaForIrel,
  IREL_DECISION_VALUES,
} from "./irel-compile";
import type {
  HumanTaskNodeMeta,
  IRELCompileDiagnostic,
  IRELNode,
  IRELTypeAtom,
} from "./irel-compile";

const END_NO_DATA_TARGET = "@end_no_data";
const RETURNING_RESERVED_HANDLERS = new Set(["@challenge", "@human_task"]);
const BROWSER_PRODUCT_EXCLUDED_ACTIONS = new Set(["file", "shell"]);
const MAX_LOOP_ITERATIONS = 10000;
const TIER_ORDER: Record<string, number> = { T0: 0, T1: 1, T2: 2, T3: 3 };
const VALUE_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
// value_match.path 평가 대상 루트(ir-static-validation §3): 직전 노드의 extracted 또는 node.<id>.*.
const VALUE_PATH_ROOTS = new Set<string>(["extracted", "node"]);

export interface StaticValidationOptions {
  readonly signedCommandRefs?: ReadonlySet<string> | readonly string[];
}

export interface CompiledScenarioAst {
  readonly kind: "rpa.scenario.compiled_ast.v1";
  readonly ir_version: "1.x";
  readonly scenario_version: number;
  readonly nodes: Record<string, CompiledNodeAst>;
}

export interface CompiledNodeAst {
  readonly on?: readonly CompiledOnBranchAst[];
  readonly loop?: CompiledLoopAst;
  readonly fallback_chain?: readonly CompiledFallbackTierAst[];
  readonly verify?: CompiledVerifyAst;
}

export interface CompiledOnBranchAst {
  readonly when: IRELNode;
  readonly target: unknown;
  readonly priority: number;
}

export interface CompiledLoopAst {
  readonly until: IRELNode;
  readonly body_target: string;
  readonly exit_target: string;
  readonly max_iterations: number;
}

export interface CompiledFallbackTierAst {
  readonly tier: string;
  readonly entry_node: string;
  readonly advance_when?: IRELNode;
}

export interface CompiledVerifyAst {
  readonly empty_result_allowed?: readonly IRELNode[];
}

export type CompileScenarioStaticResult =
  | { readonly report: ValidationReport; readonly compiledAst: CompiledScenarioAst }
  | { readonly report: ValidationReport; readonly compiledAst?: undefined };

interface ExpressionRef {
  readonly expression: string;
  readonly additionalPriorNodeIds?: ReadonlySet<string>;
  readonly allowLoopScope?: boolean;
}

interface RuntimeOnBranch {
  readonly target?: unknown;
  readonly when?: unknown;
  readonly priority?: unknown;
}

interface RuntimeLoop {
  readonly body_target?: unknown;
  readonly exit_target?: unknown;
  readonly until?: unknown;
  readonly max_iterations?: unknown;
}

interface RuntimeFallbackTier {
  readonly tier?: unknown;
  readonly entry_node?: unknown;
  readonly advance_when?: unknown;
}

interface RuntimeFlowNode {
  readonly next?: unknown;
  readonly on?: readonly RuntimeOnBranch[];
  readonly loop?: RuntimeLoop;
  readonly fallback_chain?: readonly RuntimeFallbackTier[];
}

type TargetRefKind =
  | "node"
  | "handler_return"
  | "loop_body"
  | "loop_exit"
  | "fallback_entry"
  | "end_no_data"
  | "invalid_reserved_handler";

interface TargetRef {
  readonly kind: TargetRefKind;
  readonly target?: string;
  readonly label: string;
  readonly reason?: string;
}

export function validateScenarioStatic(
  ir: IRScenario,
  options: StaticValidationOptions = {},
): ValidationReport {
  return compileScenarioStatic(ir, options).report;
}

export function compileScenarioStatic(
  ir: IRScenario,
  options: StaticValidationOptions = {},
): CompileScenarioStaticResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const nodeIds = new Set(Object.keys(ir.nodes));
  const compiledNodes: Record<string, CompiledNodeAst> = {};
  const signedCommandRefs =
    options.signedCommandRefs instanceof Set
      ? options.signedCommandRefs
      : Array.isArray(options.signedCommandRefs)
        ? new Set(options.signedCommandRefs)
        : undefined;

  if (!nodeIds.has(ir.start)) {
    errors.push(issue("V2", "start_not_found", "IR_SCHEMA_INVALID", `start node '${ir.start}' does not exist`));
  }

  const paramsSchemaDiagnostic = validateParamsSchemaForIrel(ir.params_schema);
  if (paramsSchemaDiagnostic !== undefined) {
    errors.push(expressionIssue(paramsSchemaDiagnostic));
  }

  const graph = buildGraph(ir);
  const humanTaskNodes = buildHumanTaskNodes(ir);

  for (const [nodeId, node] of Object.entries(ir.nodes)) {
    validateTargets(nodeId, node, nodeIds, errors);
    validateOnBranchReservedHandler(nodeId, node, errors);
    validateOnPriorities(nodeId, node, errors);
    validateEndNoDataWitness(nodeId, node, warnings);
    validateFallbackChain(nodeId, node, errors);
    validateFallbackIdempotency(nodeId, node, ir, errors);
    validateValuePaths(nodeId, node, errors);
    const compiledNode = validateExpressions(nodeId, node, ir, nodeIds, graph, humanTaskNodes, errors);
    if (compiledNode !== undefined) {
      compiledNodes[nodeId] = compiledNode;
      validateDecisionBranchCompleteness(nodeId, compiledNode, humanTaskNodes, warnings);
    }
    validateBrowserProductActions(nodeId, node, errors);
    validateSignedCommands(nodeId, node, signedCommandRefs, errors);
    validateLoopContract(nodeId, node, errors);
  }

  const reachable = reachableFrom(ir.start, graph);
  validateLoopExitReachability(ir, graph, nodeIds, reachable, errors);
  if (nodeIds.has(ir.start) && !hasReachableTerminal(ir, reachable)) {
    errors.push(issue("V3", "no_reachable_terminal", "IR_SCHEMA_INVALID", "no terminal or @end_no_data is reachable from start"));
  }

  for (const nodeId of nodeIds) {
    if (!reachable.has(nodeId)) {
      warnings.push(issue("V5", "unreachable_node", "IR_SCHEMA_INVALID", `node '${nodeId}' is not reachable from start`, nodeId));
    }
  }

  for (const nodeId of findIllegalCycles(graph, ir.nodes)) {
    errors.push(issue("V4", "illegal_cycle", "IR_SCHEMA_INVALID", `cycle reaches '${nodeId}' without a loop node`, nodeId));
  }

  const report = { errors, warnings };
  if (errors.length > 0) return { report };
  return {
    report,
    compiledAst: {
      kind: "rpa.scenario.compiled_ast.v1",
      ir_version: ir.meta.ir_version ?? "1.x",
      scenario_version: ir.meta.version,
      nodes: compiledNodes,
    },
  };
}

function validateTargets(
  nodeId: string,
  node: IRNode,
  nodeIds: Set<string>,
  errors: ValidationIssue[],
): void {
  for (const ref of targetRefsOf(node)) {
    if (ref.kind === "invalid_reserved_handler") {
      errors.push(issue(
        "V1",
        ref.reason ?? "reserved_handler_call_shape_invalid",
        "IR_SCHEMA_INVALID",
        `${ref.label} must use a closed handler-call object with handler, input, and return_node; @end_no_data is terminal and has no return_node`,
        nodeId,
      ));
      continue;
    }
    if (isNodeEdge(ref) && (ref.target === undefined || !nodeIds.has(ref.target))) {
      errors.push(issue("V1", "target_not_found", "IR_SCHEMA_INVALID", `${ref.label} '${ref.target ?? "<missing>"}' does not exist`, nodeId));
    }
  }
}

// on[].target = reservedHandlerCall(@challenge/@human_task) 은 스키마/그래프상 수용되나 인터프리터(ir-translate.toBranch)는
// next-target 핸들러콜만 지원하고 on-branch 핸들러콜은 IR_SCHEMA_INVALID 로 거부한다. compile-accept/runtime-reject
// 비대칭을 저장 시점(정적검증)에 제거한다(AUD-12 e). next= 핸들러콜은 계속 허용된다.
function validateOnBranchReservedHandler(nodeId: string, node: IRNode, errors: ValidationIssue[]): void {
  for (const branch of onBranchesOf(node)) {
    if (isRecord(branch.target)) {
      errors.push(issue(
        "V1",
        "on_branch_reserved_handler_unsupported",
        "IR_SCHEMA_INVALID",
        "on[].target reservedHandlerCall(@challenge/@human_task) is unsupported on an on[] branch; use 'next' for a returning handler call or a node-id/@end_no_data string target",
        nodeId,
      ));
    }
  }
}

function validateOnPriorities(nodeId: string, node: IRNode, errors: ValidationIssue[]): void {
  const branches = onBranchesOf(node);
  const seen = new Set<number>();
  for (const branch of branches) {
    if (typeof branch.priority !== "number") continue;
    if (seen.has(branch.priority)) {
      errors.push(issue("V6", "duplicate_priority", "IR_SCHEMA_INVALID", `duplicate on[] priority ${branch.priority}`, nodeId));
    }
    seen.add(branch.priority);
  }
}

function validateEndNoDataWitness(
  nodeId: string,
  node: IRNode,
  warnings: ValidationIssue[],
): void {
  const reachesEndNoData = targetRefsOf(node).some((ref) => ref.kind === "end_no_data");
  const terminalSuccessEmpty = "terminal" in node && node.terminal === "success_empty";
  if ((reachesEndNoData || terminalSuccessEmpty) && !hasEmptyResultWitness(node)) {
    warnings.push(issue("V7", "empty_result_without_witness", "IR_SCHEMA_INVALID", "@end_no_data/success_empty requires empty_result_allowed witness", nodeId));
  }
}

function validateFallbackChain(nodeId: string, node: IRNode, errors: ValidationIssue[]): void {
  const chain = fallbackChainOf(node);
  if (chain.length === 0) return;
  let previous = -1;
  const seen = new Set<string>();
  for (const tier of chain) {
    if (typeof tier.tier !== "string") continue;
    const order = TIER_ORDER[tier.tier];
    if (order === undefined || seen.has(tier.tier) || order <= previous) {
      errors.push(issue("V11", "fallback_chain_invalid", "IR_SCHEMA_INVALID", "fallback_chain tiers must be unique and monotonic T0→T3", nodeId));
      return;
    }
    seen.add(tier.tier);
    previous = order;
  }
}

// V12 — fallback_chain side-effect 멱등성(ir-static-validation.md §4).
// 스키마(ir.schema.json)는 *선언된* non-read_only side_effect 에만 idempotency_key 를 강제한다.
// V12 는 그 너머를 강제한다: 체인 내 어느 티어든 entry_node 가 mutating side_effect 를 선언하면
// (= 체인이 비-read_only), fallback 이 티어를 재실행하므로 *모든* 티어 entry_node 가
// side_effect.idempotency_key 를 명시해야 한다(재시도 안전). entry_node 가 side_effect 미선언이거나
// read_only(키 없음)면 V12 위반 — 스키마로는 못 잡는 무방비 재실행 진입점이다(결정: Option A).
function validateFallbackIdempotency(
  nodeId: string,
  node: IRNode,
  ir: IRScenario,
  errors: ValidationIssue[],
): void {
  const tiers: { readonly tier: string; readonly entry_node: string }[] = [];
  for (const tier of fallbackChainOf(node)) {
    if (typeof tier.tier === "string" && typeof tier.entry_node === "string") {
      tiers.push({ tier: tier.tier, entry_node: tier.entry_node });
    }
  }
  if (tiers.length === 0) return;

  const chainIsNonReadOnly = tiers.some((tier) => {
    const sideEffect = ir.nodes[tier.entry_node]?.side_effect;
    return sideEffect !== undefined && sideEffect.kind !== "read_only";
  });
  if (!chainIsNonReadOnly) return;

  for (const tier of tiers) {
    const key = ir.nodes[tier.entry_node]?.side_effect?.idempotency_key;
    if (typeof key !== "string" || key.length === 0) {
      errors.push(issue(
        "V12",
        "fallback_side_effect_idempotency_missing",
        "IR_SCHEMA_INVALID",
        `fallback_chain tier '${tier.tier}' entry_node '${tier.entry_node}' requires side_effect.idempotency_key (non-read_only fallback re-executes tiers; §4)`,
        nodeId,
      ));
    }
  }
}

function validateValuePaths(nodeId: string, node: IRNode, errors: ValidationIssue[]): void {
  for (const criterion of node.verify?.criteria ?? []) {
    if (criterion.type !== "value_match") continue;
    if (!VALUE_PATH_RE.test(criterion.path)) {
      errors.push(issue("V10", "invalid_value_path", "IR_SCHEMA_INVALID", `invalid value_match.path '${criterion.path}'`, nodeId));
      continue;
    }
    // §3: 평가 대상 루트는 직전 노드의 extracted(extract 결과) 또는 node.<id>.* 표준 출력이어야 한다.
    // 그 외 루트는 평가 대상 부재 → V10 위반(문법만 통과시키던 false-accept 제거; AUD-12 c).
    const root = criterion.path.split(".")[0] ?? "";
    if (!VALUE_PATH_ROOTS.has(root)) {
      errors.push(issue("V10", "invalid_value_path", "IR_SCHEMA_INVALID", `value_match.path '${criterion.path}' root '${root}' must be 'extracted' or 'node.<id>'`, nodeId));
    }
  }
}

function validateExpressions(
  nodeId: string,
  node: IRNode,
  ir: IRScenario,
  nodeIds: ReadonlySet<string>,
  graph: ReadonlyMap<string, readonly string[]>,
  humanTaskNodes: ReadonlyMap<string, HumanTaskNodeMeta>,
  errors: ValidationIssue[],
): CompiledNodeAst | undefined {
  const compiled: {
    on?: CompiledOnBranchAst[];
    loop?: CompiledLoopAst;
    fallback_chain?: CompiledFallbackTierAst[];
    verify?: CompiledVerifyAst;
  } = {};

  const on: CompiledOnBranchAst[] = [];
  for (const branch of onBranchesOf(node)) {
    if (typeof branch.when !== "string") continue;
    const when = compileBooleanExpression(nodeId, branch.when, ir, nodeIds, graph, humanTaskNodes, errors);
    if (when !== undefined && typeof branch.priority === "number") {
      on.push({ when, target: branch.target, priority: branch.priority });
    }
  }
  if (on.length > 0) compiled.on = on;

  const loop = loopOf(node);
  if (loop !== undefined && typeof loop.until === "string") {
    const until = compileBooleanExpression(nodeId, loop.until, ir, nodeIds, graph, humanTaskNodes, errors, { allowLoopScope: true });
    if (
      until !== undefined &&
      typeof loop.body_target === "string" &&
      typeof loop.exit_target === "string" &&
      typeof loop.max_iterations === "number"
    ) {
      compiled.loop = {
        until,
        body_target: loop.body_target,
        exit_target: loop.exit_target,
        max_iterations: loop.max_iterations,
      };
    }
  }

  const fallbackChain: CompiledFallbackTierAst[] = [];
  const priorTierNodes = new Set<string>();
  for (const tier of fallbackChainOf(node)) {
    if (typeof tier.entry_node === "string") priorTierNodes.add(tier.entry_node);
    if (typeof tier.tier !== "string" || typeof tier.entry_node !== "string") continue;

    let advanceWhen: IRELNode | undefined;
    if (typeof tier.advance_when === "string") {
      advanceWhen = compileBooleanExpression(nodeId, tier.advance_when, ir, nodeIds, graph, humanTaskNodes, errors, {
        additionalPriorNodeIds: new Set(priorTierNodes),
      });
    }
    fallbackChain.push(
      advanceWhen === undefined
        ? { tier: tier.tier, entry_node: tier.entry_node }
        : { tier: tier.tier, entry_node: tier.entry_node, advance_when: advanceWhen },
    );
  }
  if (fallbackChain.length > 0) compiled.fallback_chain = fallbackChain;

  // verify.vlm_fallback.when 은 verify-engine 상태 조건(기본 'criteria_uncertain', verify.schema.json §vlm_fallback)이며
  // IREL scope 가 아니다. IREL 로 컴파일/타입체크하지 않는다(문서화 기본값 false-reject 금지; AUD-12 a).
  const verify: {
    empty_result_allowed?: IRELNode[];
  } = {};
  const emptyResultAllowed: IRELNode[] = [];
  for (const criterion of node.verify?.criteria ?? []) {
    if (criterion.type !== "empty_result_allowed") continue;
    const witness = compileBooleanExpression(nodeId, criterion.when, ir, nodeIds, graph, humanTaskNodes, errors);
    if (witness !== undefined) emptyResultAllowed.push(witness);
  }
  if (emptyResultAllowed.length > 0) verify.empty_result_allowed = emptyResultAllowed;
  if (verify.empty_result_allowed !== undefined) compiled.verify = verify;

  return Object.keys(compiled).length > 0 ? compiled : undefined;
}

function compileBooleanExpression(
  nodeId: string,
  expression: string,
  ir: IRScenario,
  nodeIds: ReadonlySet<string>,
  graph: ReadonlyMap<string, readonly string[]>,
  humanTaskNodes: ReadonlyMap<string, HumanTaskNodeMeta>,
  errors: ValidationIssue[],
  options: Pick<ExpressionRef, "additionalPriorNodeIds" | "allowLoopScope"> = {},
): IRELNode | undefined {
  const result = compileIrelExpression(expression, {
    currentNodeId: nodeId,
    nodeIds,
    graph,
    paramsSchema: ir.params_schema,
    humanTaskNodes,
    additionalPriorNodeIds: options.additionalPriorNodeIds,
    allowLoopScope: options.allowLoopScope,
    expectedType: "boolean",
  });
  if (!result.ok) {
    errors.push(...result.diagnostics.map((diagnostic) => expressionIssue(diagnostic, nodeId)));
    return undefined;
  }
  return result.compiled.ast;
}

function validateSignedCommands(
  nodeId: string,
  node: IRNode,
  signedCommandRefs: ReadonlySet<string> | undefined,
  errors: ValidationIssue[],
): void {
  for (const action of node.what ?? []) {
    if (action.action !== "shell") continue;
    if (signedCommandRefs === undefined) {
      errors.push(issue("V8", "shell_cmd_registry_unavailable", "IR_SCHEMA_INVALID", "shell cmd_ref requires signed command registry at save/promote boundary", nodeId));
      continue;
    }
    if (!signedCommandRefs.has(action.cmd_ref)) {
      errors.push(issue("V8", "shell_cmd_unregistered", "IR_SCHEMA_INVALID", `shell cmd_ref '${action.cmd_ref}' is not registered`, nodeId));
    }
  }
}

function validateBrowserProductActions(nodeId: string, node: IRNode, errors: ValidationIssue[]): void {
  for (const action of node.what ?? []) {
    if (!BROWSER_PRODUCT_EXCLUDED_ACTIONS.has(action.action)) continue;
    errors.push(issue(
      "V8",
      "unsupported_browser_product_action",
      "IR_SCHEMA_INVALID",
      `action '${action.action}' is outside browser product mode; use api_call for supported server-side HTTP integration`,
      nodeId,
    ));
  }
}

function validateLoopContract(nodeId: string, node: IRNode, errors: ValidationIssue[]): void {
  const loop = loopOf(node);
  if (loop === undefined) return;

  if (typeof loop.body_target !== "string" || typeof loop.exit_target !== "string") {
    errors.push(issue("V4", "loop_target_invalid", "IR_SCHEMA_INVALID", "loop requires body_target and exit_target node ids", nodeId));
  }
  if (
    typeof loop.max_iterations !== "number" ||
    !Number.isInteger(loop.max_iterations) ||
    loop.max_iterations < 1 ||
    loop.max_iterations > MAX_LOOP_ITERATIONS
  ) {
    errors.push(issue("V4", "loop_max_iterations_unbounded", "IR_SCHEMA_INVALID", `loop.max_iterations must be between 1 and ${MAX_LOOP_ITERATIONS}`, nodeId));
  }
}

// business_form_v1 field.type → IREL scalar 타입(reserved-handlers.md @human_task; text/textarea/date/select=string).
const BUSINESS_FORM_FIELD_TYPE: Readonly<Record<string, readonly IRELTypeAtom[]>> = {
  text: ["string"],
  textarea: ["string"],
  date: ["string"],
  select: ["string"],
  number: ["number"],
  boolean: ["boolean"],
};

// @human_task 를 선언한 소유 노드(next= reservedHandlerCall(@human_task))를 도출한다(human_tasks.node_id 의 정적 대응).
// on[].target 핸들러콜은 V1(on_branch_reserved_handler_unsupported)로 거부되므로 소유 노드로 보지 않는다.
// correction.<key> 타입은 그 노드 input.result_schema(business_form_v1) fields[] 에서 결정(없으면 decision 만 노출).
function buildHumanTaskNodes(ir: IRScenario): Map<string, HumanTaskNodeMeta> {
  const map = new Map<string, HumanTaskNodeMeta>();
  for (const [nodeId, node] of Object.entries(ir.nodes)) {
    const next = runtimeFlow(node).next;
    if (!isRecord(next) || next.handler !== "@human_task") continue;
    const input = isRecord(next.input) ? next.input : {};
    map.set(nodeId, { correctionFields: correctionFieldsOf(input) });
  }
  return map;
}

function correctionFieldsOf(input: Record<string, unknown>): ReadonlyMap<string, readonly IRELTypeAtom[]> {
  const fields = new Map<string, readonly IRELTypeAtom[]>();
  const schema = input.result_schema;
  if (!isRecord(schema) || schema.version !== "business_form_v1" || !Array.isArray(schema.fields)) return fields;
  for (const field of schema.fields) {
    if (!isRecord(field)) continue;
    const key = field.key;
    const type = field.type;
    if (typeof key !== "string" || typeof type !== "string") continue;
    const irelType = BUSINESS_FORM_FIELD_TYPE[type];
    if (irelType !== undefined) fields.set(key, irelType);
  }
  return fields;
}

// V13 — decision 분기 완전성(ir-static-validation.md §1). 한 노드의 on[] 이 node.<htId>.decision(@human_task 닫힌 enum)
// 을 분기 키로 참조하면 enum 전부를 커버해야 한다(각 값 대응 == branch 또는 catch-all when:true). 부분 커버 시 그 값으로
// 해소된 task 의 재개가 매칭 branch 없음 → IR_NO_BRANCH_MATCHED → run 영구 stuck. promote-block warning.
// 보수적 판정(false-positive 방지): 단순 등식(`node.htId.decision == "L"`) 커버리지만 인정하고, 그 외 형태(!=, &&/||, 함수
// 내 참조 등)로 decision 을 참조하는 branch 가 있으면 정적 증명 불가로 보고 해당 ht 는 억제한다(런타임 백스톱이 최종 가드).
function validateDecisionBranchCompleteness(
  nodeId: string,
  compiledNode: CompiledNodeAst,
  humanTaskNodes: ReadonlyMap<string, HumanTaskNodeMeta>,
  warnings: ValidationIssue[],
): void {
  const branches = compiledNode.on;
  if (branches === undefined || branches.length === 0) return;

  const covered = new Map<string, Set<string>>();
  const impure = new Set<string>();
  const referenced = new Set<string>();
  let hasCatchAll = false;

  for (const branch of branches) {
    if (isLiteralTrue(branch.when)) {
      hasCatchAll = true;
      continue;
    }
    const equality = bareDecisionEquality(branch.when, humanTaskNodes);
    if (equality !== undefined) {
      referenced.add(equality.htNodeId);
      const literals = covered.get(equality.htNodeId) ?? new Set<string>();
      literals.add(equality.literal);
      covered.set(equality.htNodeId, literals);
      continue;
    }
    for (const htNodeId of decisionRefsIn(branch.when, humanTaskNodes)) {
      referenced.add(htNodeId);
      impure.add(htNodeId);
    }
  }

  if (hasCatchAll) return; // catch-all branch 가 미커버 decision 을 흡수.
  for (const htNodeId of referenced) {
    if (impure.has(htNodeId)) continue;
    const literals = covered.get(htNodeId) ?? new Set<string>();
    const missing = IREL_DECISION_VALUES.filter((value) => !literals.has(value));
    if (missing.length > 0) {
      warnings.push(issue(
        "V13",
        "decision_branch_incomplete",
        "IR_SCHEMA_INVALID",
        `on[] branches on node.${htNodeId}.decision do not cover decision value(s) [${missing.join(", ")}] and no catch-all branch exists; resume on an uncovered human decision would raise IR_NO_BRANCH_MATCHED and stick the run`,
        nodeId,
      ));
    }
  }
}

function isLiteralTrue(ast: IRELNode): boolean {
  return ast.kind === "literal" && ast.valueType === "boolean" && ast.value === true;
}

// `node.<htId>.decision == "literal"`(좌우 어느 쪽이든) 단순 등식이면 {htNodeId, literal} 반환.
function bareDecisionEquality(
  ast: IRELNode,
  humanTaskNodes: ReadonlyMap<string, HumanTaskNodeMeta>,
): { readonly htNodeId: string; readonly literal: string } | undefined {
  if (ast.kind !== "compare" || ast.op !== "==") return undefined;
  const leftNode = decisionVarNodeId(ast.left, humanTaskNodes);
  const rightNode = decisionVarNodeId(ast.right, humanTaskNodes);
  const leftLiteral = stringLiteralValue(ast.left);
  const rightLiteral = stringLiteralValue(ast.right);
  if (leftNode !== undefined && rightLiteral !== undefined) return { htNodeId: leftNode, literal: rightLiteral };
  if (rightNode !== undefined && leftLiteral !== undefined) return { htNodeId: rightNode, literal: leftLiteral };
  return undefined;
}

function decisionVarNodeId(
  ast: IRELNode,
  humanTaskNodes: ReadonlyMap<string, HumanTaskNodeMeta>,
): string | undefined {
  if (ast.kind !== "variable" || ast.path.length !== 3) return undefined;
  const [namespace, nodeId, field] = ast.path;
  if (namespace !== "node" || field !== "decision" || nodeId === undefined) return undefined;
  return humanTaskNodes.has(nodeId) ? nodeId : undefined;
}

function stringLiteralValue(ast: IRELNode): string | undefined {
  return ast.kind === "literal" && ast.valueType === "string" && typeof ast.value === "string" ? ast.value : undefined;
}

function decisionRefsIn(
  ast: IRELNode,
  humanTaskNodes: ReadonlyMap<string, HumanTaskNodeMeta>,
): Set<string> {
  const refs = new Set<string>();
  walkIrel(ast, (node) => {
    const htNodeId = decisionVarNodeId(node, humanTaskNodes);
    if (htNodeId !== undefined) refs.add(htNodeId);
  });
  return refs;
}

function walkIrel(ast: IRELNode, visit: (node: IRELNode) => void): void {
  visit(ast);
  switch (ast.kind) {
    case "unary":
      walkIrel(ast.expr, visit);
      break;
    case "binary":
    case "compare":
    case "logical":
      walkIrel(ast.left, visit);
      walkIrel(ast.right, visit);
      break;
    case "call":
      for (const arg of ast.args) walkIrel(arg, visit);
      break;
    default:
      break;
  }
}

function targetRefsOf(node: IRNode): TargetRef[] {
  const refs: TargetRef[] = [];
  const flow = runtimeFlow(node);

  if (flow.next !== undefined) refs.push(readTargetRef(flow.next, "next"));

  for (const branch of onBranchesOf(node)) {
    refs.push(readTargetRef(branch.target, "on[].target"));
  }

  for (const tier of fallbackChainOf(node)) {
    refs.push(readNodeTargetRef(tier.entry_node, "fallback_chain[].entry_node", "fallback_entry"));
  }

  const loop = loopOf(node);
  if (loop !== undefined) {
    refs.push(readNodeTargetRef(loop.body_target, "loop.body_target", "loop_body"));
    refs.push(readNodeTargetRef(loop.exit_target, "loop.exit_target", "loop_exit"));
  }

  return refs;
}

function buildGraph(ir: IRScenario): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const [nodeId, node] of Object.entries(ir.nodes)) {
    graph.set(nodeId, edgeTargetsOf(node));
  }
  return graph;
}

function edgeTargetsOf(node: IRNode): string[] {
  return targetRefsOf(node).flatMap((ref) => (isNodeEdge(ref) && ref.target !== undefined ? [ref.target] : []));
}

function reachableFrom(start: string, graph: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const nodeId = stack.pop() as string;
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    for (const next of graph.get(nodeId) ?? []) stack.push(next);
  }
  return seen;
}

function hasReachableTerminal(ir: IRScenario, reachable: Set<string>): boolean {
  for (const nodeId of reachable) {
    const node = ir.nodes[nodeId];
    if (!node) continue;
    if ("terminal" in node) return true;
    if (targetRefsOf(node).some((ref) => ref.kind === "end_no_data")) return true;
  }
  return false;
}

function findIllegalCycles(graph: Map<string, string[]>, nodes: Record<string, IRNode>): Set<string> {
  const illegal = new Set<string>();
  const indexByNode = new Map<string, number>();
  const lowlinkByNode = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let nextIndex = 0;

  function strongConnect(nodeId: string): void {
    indexByNode.set(nodeId, nextIndex);
    lowlinkByNode.set(nodeId, nextIndex);
    nextIndex += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    for (const next of graph.get(nodeId) ?? []) {
      if (!graph.has(next)) continue;
      if (!indexByNode.has(next)) {
        strongConnect(next);
        lowlinkByNode.set(nodeId, Math.min(
          lowlinkByNode.get(nodeId) as number,
          lowlinkByNode.get(next) as number,
        ));
      } else if (onStack.has(next)) {
        lowlinkByNode.set(nodeId, Math.min(
          lowlinkByNode.get(nodeId) as number,
          indexByNode.get(next) as number,
        ));
      }
    }

    if (lowlinkByNode.get(nodeId) !== indexByNode.get(nodeId)) return;

    const component: string[] = [];
    let current: string | undefined;
    do {
      current = stack.pop();
      if (current === undefined) break;
      onStack.delete(current);
      component.push(current);
    } while (current !== nodeId);

    const cyclic = component.length > 1 || component.some((id) => (graph.get(id) ?? []).includes(id));
    if (cyclic && !component.some((id) => isLoopNode(nodes[id]))) {
      illegal.add(component[0] as string);
    }
  }

  for (const nodeId of graph.keys()) {
    if (!indexByNode.has(nodeId)) strongConnect(nodeId);
  }
  return illegal;
}

function validateLoopExitReachability(
  ir: IRScenario,
  graph: Map<string, string[]>,
  nodeIds: ReadonlySet<string>,
  reachableFromStart: ReadonlySet<string>,
  errors: ValidationIssue[],
): void {
  for (const [nodeId, node] of Object.entries(ir.nodes)) {
    const loop = loopOf(node);
    if (loop === undefined || !reachableFromStart.has(nodeId) || typeof loop.exit_target !== "string") continue;
    if (!nodeIds.has(loop.exit_target)) continue;
    if (!reachableFrom(nodeId, graph).has(loop.exit_target)) {
      errors.push(issue("V4", "loop_exit_unreachable", "IR_SCHEMA_INVALID", `loop.exit_target '${loop.exit_target}' is not reachable from loop node '${nodeId}'`, nodeId));
    }
  }
}

function readTargetRef(value: unknown, label: string): TargetRef {
  if (typeof value === "string") {
    if (value === END_NO_DATA_TARGET) return { kind: "end_no_data", target: value, label };
    if (RETURNING_RESERVED_HANDLERS.has(value)) {
      return { kind: "invalid_reserved_handler", target: value, label, reason: "reserved_handler_call_shape_invalid" };
    }
    return { kind: "node", target: value, label };
  }

  if (!isRecord(value)) {
    return { kind: "invalid_reserved_handler", label, reason: "target_shape_invalid" };
  }

  const handler = value.handler;
  if (handler === END_NO_DATA_TARGET) {
    if (Object.prototype.hasOwnProperty.call(value, "return_node")) {
      return { kind: "invalid_reserved_handler", target: END_NO_DATA_TARGET, label, reason: "end_no_data_return_node_forbidden" };
    }
    return { kind: "invalid_reserved_handler", target: END_NO_DATA_TARGET, label, reason: "end_no_data_handler_call_invalid" };
  }

  if (typeof handler === "string" && RETURNING_RESERVED_HANDLERS.has(handler)) {
    return typeof value.return_node === "string"
      ? { kind: "handler_return", target: value.return_node, label: `${label}.return_node` }
      : { kind: "invalid_reserved_handler", target: handler, label, reason: "handler_return_node_missing" };
  }

  return { kind: "invalid_reserved_handler", label, reason: "reserved_handler_unknown" };
}

function readNodeTargetRef(value: unknown, label: string, kind: TargetRefKind): TargetRef {
  return typeof value === "string"
    ? { kind, target: value, label }
    : { kind: "invalid_reserved_handler", label, reason: "target_shape_invalid" };
}

function isNodeEdge(ref: TargetRef): boolean {
  return (
    ref.kind === "node" ||
    ref.kind === "handler_return" ||
    ref.kind === "loop_body" ||
    ref.kind === "loop_exit" ||
    ref.kind === "fallback_entry"
  );
}

function runtimeFlow(node: IRNode): RuntimeFlowNode {
  return node as unknown as RuntimeFlowNode;
}

function onBranchesOf(node: IRNode): readonly RuntimeOnBranch[] {
  const branches = runtimeFlow(node).on;
  return Array.isArray(branches) ? branches : [];
}

function fallbackChainOf(node: IRNode): readonly RuntimeFallbackTier[] {
  const chain = runtimeFlow(node).fallback_chain;
  return Array.isArray(chain) ? chain : [];
}

function loopOf(node: IRNode): RuntimeLoop | undefined {
  const loop = runtimeFlow(node).loop;
  return isRecord(loop) ? loop : undefined;
}

function isLoopNode(node: IRNode | undefined): boolean {
  return node !== undefined && loopOf(node) !== undefined;
}

function hasEmptyResultWitness(node: IRNode): boolean {
  return (node.verify?.criteria ?? []).some((criterion) => criterion.type === "empty_result_allowed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(
  rule: ValidationIssue["rule"],
  reason: string,
  code: ValidationIssue["code"],
  detail: string,
  nodeId?: string,
): ValidationIssue {
  return nodeId === undefined ? { rule, reason, code, detail } : { rule, reason, code, detail, nodeId };
}

function expressionIssue(diagnostic: IRELCompileDiagnostic, nodeId?: string): ValidationIssue {
  const rule: ValidationIssue["rule"] = diagnostic.reason === "unknown_node_field" ? "V9" : "V8";
  return issue(
    rule,
    diagnostic.reason,
    "IR_EXPRESSION_COMPILE_ERROR",
    `${diagnostic.code}: ${diagnostic.detail}`,
    nodeId,
  );
}
