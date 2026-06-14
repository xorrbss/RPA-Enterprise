/**
 * D1 codegen — IR graph static validation (ir-static-validation.md V1..V11).
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
} from "./irel-compile";
import type { IRELCompileDiagnostic } from "./irel-compile";

const END_NO_DATA_TARGET = "@end_no_data";
const RETURNING_RESERVED_HANDLERS = new Set(["@challenge", "@human_task"]);
const MAX_LOOP_ITERATIONS = 10000;
const TIER_ORDER: Record<string, number> = { T0: 0, T1: 1, T2: 2, T3: 3 };
const VALUE_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export interface StaticValidationOptions {
  readonly signedCommandRefs?: ReadonlySet<string> | readonly string[];
}

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
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const nodeIds = new Set(Object.keys(ir.nodes));
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

  for (const [nodeId, node] of Object.entries(ir.nodes)) {
    validateTargets(nodeId, node, nodeIds, errors);
    validateOnPriorities(nodeId, node, errors);
    validateEndNoDataWitness(nodeId, node, warnings);
    validateFallbackChain(nodeId, node, errors);
    validateValuePaths(nodeId, node, errors);
    validateExpressions(nodeId, node, ir, nodeIds, graph, errors);
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

  return { errors, warnings };
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

function validateValuePaths(nodeId: string, node: IRNode, errors: ValidationIssue[]): void {
  for (const criterion of node.verify?.criteria ?? []) {
    if (criterion.type === "value_match" && !VALUE_PATH_RE.test(criterion.path)) {
      errors.push(issue("V10", "invalid_value_path", "IR_SCHEMA_INVALID", `invalid value_match.path '${criterion.path}'`, nodeId));
    }
  }
}

function validateExpressions(
  nodeId: string,
  node: IRNode,
  ir: IRScenario,
  nodeIds: ReadonlySet<string>,
  graph: ReadonlyMap<string, readonly string[]>,
  errors: ValidationIssue[],
): void {
  for (const expressionRef of expressionsOf(node)) {
    const result = compileIrelExpression(expressionRef.expression, {
      currentNodeId: nodeId,
      nodeIds,
      graph,
      paramsSchema: ir.params_schema,
      additionalPriorNodeIds: expressionRef.additionalPriorNodeIds,
      allowLoopScope: expressionRef.allowLoopScope,
      expectedType: "boolean",
    });
    if (!result.ok) {
      errors.push(...result.diagnostics.map((diagnostic) => expressionIssue(diagnostic, nodeId)));
    }
  }
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

function expressionsOf(node: IRNode): ExpressionRef[] {
  const expressions: ExpressionRef[] = [];
  for (const branch of onBranchesOf(node)) {
    if (typeof branch.when === "string") expressions.push({ expression: branch.when });
  }
  const loop = loopOf(node);
  if (loop !== undefined && typeof loop.until === "string") {
    expressions.push({ expression: loop.until, allowLoopScope: true });
  }
  const fallbackChain = fallbackChainOf(node);
  if (fallbackChain.length > 0) {
    const priorTierNodes = new Set<string>();
    for (const tier of fallbackChain) {
      if (typeof tier.entry_node !== "string") continue;
      priorTierNodes.add(tier.entry_node);
      if (typeof tier.advance_when === "string") {
        expressions.push({
          expression: tier.advance_when,
          additionalPriorNodeIds: new Set(priorTierNodes),
        });
      }
    }
  }
  if (node.verify?.vlm_fallback?.when) {
    expressions.push({ expression: node.verify.vlm_fallback.when });
  }
  for (const criterion of node.verify?.criteria ?? []) {
    if (criterion.type === "empty_result_allowed") expressions.push({ expression: criterion.when });
  }
  return expressions;
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
