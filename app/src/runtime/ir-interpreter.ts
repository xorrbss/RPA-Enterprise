/**
 * IR 인터프리터 (D3 가동 1단계 — architecture.md §10 Interpreter측 / executor-dryrun.int.ts 일반화).
 *
 * claimed→running 으로 진입한 run의 컴파일된 IR 그래프를 start 노드부터 순회한다:
 *   노드의 결정형 `what` 액션을 ExecutorPlugin으로 실행 → 흐름키(terminal/next/on[])로 다음 노드 선택.
 *   on[] 노드는 PageStateResolver로 PageState(flags)를 산출(observe)한 뒤 flow-control.selectOnBranch로 분기.
 *
 * 의존 방향(§10 단방향): Interpreter → {ExecutorPlugin, PageStateResolver, flow-control(codegen evaluator)}.
 * 런타임 파싱 없음 — 저장/승격 시 컴파일된 on[] AST(CompiledOnBranch)만 평가한다.
 *
 * 범위(결정형): navigate/download/upload(UtilityExecutor) + next/on[]/terminal/**loop·fallback_chain**(RQ-002).
 *   - loop: body_target 서브그래프를 until/max_iterations 까지 반복(while-loop; body가 loop 노드로 사이클백, V4).
 *     loop.* 스코프(iteration/page_count) 주입. cursor.*·데이터-단위 page 의미는 수집 파이프라인 소관(미투영, loud).
 *   - fallback_chain: 티어(T0→T3)를 순서대로 entry_node 부터 sub-traversal 실행, advance_when/기본(실패)으로 전환.
 *     채택 티어 terminal이 노드 outcome(terminal-producing), 티어 노드 출력에 tier 투영(D8-A9).
 *   - dom act/observe/extract(LLM)·vision은 실행기가 EXECUTOR_CAPABILITY_MISMATCH로 거부 → 그대로 전파(가정 금지).
 *   - 예약핸들러(@challenge/@human_task/@end_no_data)·suspend는 후속 단계. 미처리 status는 조용히 흘리지 않고
 *     InterpreterError로 표면화한다("조용한 false/unknown 금지").
 */
import type { IRELNode, IRELScope } from "../../../codegen/irel-compile";
import type { ExecutorPlugin, PageStateResolver, RunContext, StepResult, StepStatus } from "../../../ts/core-types";
import { evaluateCondition, selectOnBranch, type CompiledOnBranch } from "./flow-control";

/** 표준 노드 출력 필드(IREL node.<id>.*). 미투영 필드는 부재 → 참조 시 IREL_RUNTIME_MISSING(loud). */
interface NodeOutput {
  readonly status: StepStatus;
  readonly row_count?: number;
  readonly extracted_ref?: string;
  // tier: fallback_chain 노드가 채택한 티어(T0..T3). fallback 노드 출력에만 부착(ir-expression §2). 비-fallback은 부재(loud).
  readonly tier?: string;
}

/** StepResult → 표준 노드 출력 투영(ir-expression §2). status는 항상; row_count/extracted_ref는 extract 액션만. */
function projectNodeOutput(res: StepResult): NodeOutput {
  if (res.action !== "extract") return { status: res.status };
  const rowCount = res.output !== null && typeof res.output === "object" ? (res.output as { rowCount?: unknown }).rowCount : undefined;
  const ref = res.artifacts[0];
  return {
    status: res.status,
    ...(typeof rowCount === "number" ? { row_count: rowCount } : {}),
    ...(typeof ref === "string" ? { extracted_ref: ref } : {}),
  };
}

export type NodeFlow =
  | { readonly kind: "terminal"; readonly terminal: string }
  | { readonly kind: "next"; readonly target: string }
  | { readonly kind: "on"; readonly branches: readonly CompiledOnBranch<string>[] }
  // loop: body_target 서브그래프를 until=true 또는 max_iterations 도달까지 반복(둘 다 exit_target로 graceful 탈출,
  // ir.schema/V4). body 서브그래프는 loop 노드로 사이클백(V4: 사이클은 loop 노드 포함 시만 허용). until은 컴파일 AST.
  | { readonly kind: "loop"; readonly until: IRELNode; readonly bodyTarget: string; readonly exitTarget: string; readonly maxIterations: number }
  // fallback: 티어(T0→T3)를 순서대로 entry_node 부터 서브그래프 실행(sub-traversal), advance_when(true=전환) 또는 기본
  // (실패 시 전환)으로 다음 티어 시도. 채택 티어의 terminal이 노드 outcome(terminal-producing), tier 투영(ir-static-validation §4).
  | { readonly kind: "fallback"; readonly tiers: readonly { readonly tier: string; readonly entryNode: string; readonly advanceWhen?: IRELNode }[] };

/** 인터프리터가 순회하는 노드. what 은 ExecutorPlugin.execute가 받는 액션(형 검증은 실행기 책임). */
export interface ScenarioNode {
  readonly what: readonly unknown[];
  readonly flow: NodeFlow;
}

export interface CompiledScenario {
  readonly start: string;
  readonly nodes: Readonly<Record<string, ScenarioNode>>;
}

export interface InterpreterDeps {
  readonly executor: ExecutorPlugin;
  readonly resolver: PageStateResolver;
  /** run 실행 파라미터(runs.params). on[].when 의 params.* 참조 스코프. 드라이버가 run.params 를 주입. */
  readonly params?: Record<string, unknown>;
  /** 그래프 비종료(무한 루프) 방어 상한(총 노드 순회). 미지정 시 ops-defaults.md §5 `interpreter.graph_max_steps`(200) 적용. */
  readonly maxSteps?: number;
}

export interface InterpreterStep {
  readonly nodeId: string;
  readonly action: string;
  readonly status: StepStatus;
}

export interface ScenarioOutcome {
  readonly terminal: string; // success | success_empty | fail_business | fail_system
  readonly visited: readonly string[];
  readonly steps: readonly InterpreterStep[];
}

export class InterpreterError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InterpreterError";
  }
}

// ops-defaults.md §5 `interpreter.graph_max_steps` — **구조적(non-loop) 노드 순회** 상한(비종료 방어, D8-A7/A8).
// loop 반복은 max_iterations로 독립 바운드되며 runScenario가 loop별 (max_iterations×nodeCount) 만큼 budget을 확장해
// 두 가드를 실제 독립화한다(loop 반복이 구조 상한을 spurious 소진 방지). 환경별/중첩-loop 오버라이드는 deps.maxSteps.
const DEFAULT_MAX_STEPS = 200;

// 실패 status → terminal 매핑. 처리 못 하는 status(suspended/challenge/uncertain 등)는 null → 호출부가 표면화.
function failureTerminal(status: StepStatus): string | null {
  if (status === "failed_business") return "fail_business";
  if (status === "failed_system" || status === "failed_security") return "fail_system";
  return null;
}

/** 순회 공유 가변 상태 — fallback 티어 sub-traversal 이 nodeScope/loopState/steps/visited/budget 을 공유한다. */
interface TraversalState {
  readonly scenario: CompiledScenario;
  readonly deps: InterpreterDeps;
  readonly nodeScope: Record<string, NodeOutput>;
  readonly loopState: Map<string, number>;
  readonly visited: string[];
  readonly steps: InterpreterStep[];
  readonly budget: { remaining: number };
}

/** IRELScope.node 캐스트(NodeOutput record → IREL 평가용). */
function nodeScopeRef(state: TraversalState): Record<string, Record<string, unknown>> {
  return state.nodeScope as unknown as Record<string, Record<string, unknown>>;
}

/** terminal 문자열 → StepStatus(fallback 노드 출력의 status 도출 — 채택 티어 entry_node 출력 부재 시). */
function terminalToStatus(terminal: string): StepStatus {
  if (terminal === "fail_business") return "failed_business";
  if (terminal === "fail_system" || terminal === "fail_security") return "failed_system";
  return "success";
}

// 실패 terminal 집합(failureTerminal 산출 + 표준 vocab fail_*). 생략 advance_when 기본 전환 판정(§4: StepResult.status=failed_*).
// startsWith("fail") 대신 정확 매칭 — "failover_*" 류 비-실패 terminal 오분류 방지(break-it).
const FAILURE_TERMINALS = new Set(["fail_business", "fail_system", "fail_security"]);

/** fallback advance 기본(§4): 티어 결과가 실패 terminal 이면 다음 티어로 전환. */
function isFailureTerminal(terminal: string): boolean {
  return FAILURE_TERMINALS.has(terminal);
}

/**
 * startNode 부터 terminal 까지 순회하며 terminal 문자열을 반환한다(가변 state 공유, ctx 원본 불변).
 * fallback 티어는 본 함수를 재귀 호출(sub-traversal)해 같은 state(nodeScope/loopState/budget) 위에서 실행한다.
 */
async function traverse(state: TraversalState, startNode: string, initialCtx: RunContext, currentTier?: string): Promise<string> {
  // currentTier: 이 순회가 fallback 티어 sub-traversal 일 때 그 티어(T0..T3). 실행 노드 출력에 tier 부착(ir-expression §2,
  // node.<id>.tier 참조 가능 — 같은 티어 서브그래프 내 노드가 어느 티어로 실행 중인지 분기 가능). 최상위(non-fallback)는 undefined.
  let nodeId = startNode;
  let ctx = initialCtx;
  for (;;) {
    // 비종료 방어(budget = graph_max_steps + loop/fallback allowance). 소진 시 IR_LOOP_LIMIT(조용한 무한루프 금지).
    if (state.budget.remaining <= 0) {
      throw new InterpreterError(
        "IR_LOOP_LIMIT",
        `interpreter: exceeded step budget (graph_max_steps + loop/fallback allowance) without terminal (비종료 의심 — loop은 max_iterations로 graceful exit)`,
      );
    }
    state.budget.remaining -= 1;
    const node = state.scenario.nodes[nodeId];
    if (node === undefined) {
      throw new InterpreterError("IR_SCHEMA_INVALID", `interpreter: unknown node '${nodeId}'`);
    }
    state.visited.push(nodeId);
    ctx = { ...ctx, nodeId };

    // 1) 결정형 what 액션 실행. 비-success는 terminal 실패로 매핑하거나 표면화.
    let lastResult: StepResult | undefined;
    for (let k = 0; k < node.what.length; k += 1) {
      const res = await state.deps.executor.execute(`${nodeId}.${k}`, node.what[k], ctx);
      state.steps.push({ nodeId, action: res.action, status: res.status });
      lastResult = res;
      if (res.status === "success") continue;
      // 실패 노드도 status 투영(ir-expression §2: failed_* 포함 모든 실행 노드의 status). fallback advance_when 이
      //   `node.<entry>.status == "failed_system"`(실패 시 전환)처럼 실패 status 를 관측해야 하므로 terminal 반환 전 기록.
      const failOut = projectNodeOutput(res);
      state.nodeScope[nodeId] = currentTier !== undefined ? { ...failOut, tier: currentTier } : failOut;
      const term = failureTerminal(res.status);
      if (term !== null) return term;
      throw new InterpreterError(
        "EXECUTOR_STATUS_UNSUPPORTED",
        `interpreter: step '${nodeId}.${k}' returned status '${res.status}' (suspend/challenge 미지원)`,
      );
    }
    if (lastResult !== undefined) {
      const out = projectNodeOutput(lastResult);
      // fallback 티어 sub-traversal(currentTier 있음)이면 노드 출력에 tier 부착(ir-expression §2 tier 투영).
      state.nodeScope[nodeId] = currentTier !== undefined ? { ...out, tier: currentTier } : out;
    }

    // 2) 흐름 전이.
    if (node.flow.kind === "terminal") return node.flow.terminal;
    if (node.flow.kind === "next") {
      nodeId = node.flow.target;
      continue;
    }
    if (node.flow.kind === "loop") {
      const lf = node.flow;
      // flags 산출(on[]과 동일 경계) — until 이 flags.* 참조 가능. loop.* 스코프는 loop 노드 내부 전용(ir-expression §2).
      const loopPageState = await state.deps.resolver.resolvePageState(ctx);
      ctx = { ...ctx, pageState: loopPageState };
      const iteration = state.loopState.get(nodeId) ?? 0;
      const loopScope: IRELScope = {
        flags: loopPageState.flags,
        params: state.deps.params,
        node: nodeScopeRef(state),
        // page_count=iteration(D8-A8): 결정형 인터프리터는 page를 body pass와 구분 안 함. cursor.*/데이터-page는 미투영(loud).
        loop: { iteration, page_count: iteration },
      };
      // until=true 또는 max_iterations 도달 → exit_target(둘 다 graceful, ir.schema/V4). cursor.* 미투영 참조는 IREL_RUNTIME_MISSING(loud).
      if (evaluateCondition(lf.until, loopScope) || iteration >= lf.maxIterations) {
        state.loopState.delete(nodeId);
        nodeId = lf.exitTarget;
      } else {
        state.loopState.set(nodeId, iteration + 1);
        nodeId = lf.bodyTarget;
      }
      continue;
    }
    if (node.flow.kind === "fallback") {
      const fallbackNodeId = nodeId;
      const tiers = node.flow.tiers;
      // 티어 순서대로 entry_node 서브그래프 실행(sub-traversal, state 공유). advance_when(true)/기본(실패 terminal) → 다음 티어.
      // 마지막 티어는 무조건 채택(§4 "마지막 티어 실패 시 마지막 티어 StepResult 채택"). 채택 terminal이 노드 outcome(terminal-producing).
      let adopted = tiers[tiers.length - 1];
      let adoptedTerminal = "";
      for (let t = 0; t < tiers.length; t += 1) {
        const tier = tiers[t];
        // 티어 sub-traversal: currentTier=tier.tier 로 실행 → 티어 서브그래프 노드 출력에 tier 부착(node.<id>.tier 투영).
        const tierTerminal = await traverse(state, tier.entryNode, ctx, tier.tier);
        const isLast = t === tiers.length - 1;
        // 마지막 티어는 무조건 채택(§4 — 전환할 티어 없음): advance_when 을 **평가하지 않는다**(무의미한 resolvePageState
        //   side-effect + 부재참조 spurious throw 방지). 비-마지막만 advance_when(있으면)/기본(실패 terminal)으로 판정.
        let advance = false;
        if (!isLast) {
          advance = tier.advanceWhen !== undefined
            ? evaluateCondition(tier.advanceWhen, {
                flags: (await state.deps.resolver.resolvePageState({ ...ctx, nodeId: fallbackNodeId })).flags,
                params: state.deps.params,
                node: nodeScopeRef(state),
              })
            : isFailureTerminal(tierTerminal);
        }
        if (!advance) {
          adopted = tier;
          adoptedTerminal = tierTerminal;
          break;
        }
      }
      // §4: 노드 출력 = 채택 티어 outcome. status는 채택 terminal 파생(deeper 노드 실패가 entry success로 마스킹되지 않게,
      //   break-it). tier 투영(ir-expression §2). terminal-producing(채택 terminal=run outcome). 티어 노드 출력은 node.<id>로 별도 참조.
      state.nodeScope[fallbackNodeId] = { status: terminalToStatus(adoptedTerminal), tier: adopted.tier };
      return adoptedTerminal;
    }
    // on[]: PageState(flags) 산출(observe) → 분기. scope = flags + params + 누적 node.
    // 주의: on[].when 이 참조하는 node.<id> 는 컴파일 시 graph-ancestor 보장이나 런타임 도달 보장은 dominator 뿐 —
    // diamond DAG 에서 분기로 건너뛴 ancestor 참조는 IREL_RUNTIME_MISSING(loud, 정상).
    const pageState = await state.deps.resolver.resolvePageState(ctx);
    ctx = { ...ctx, pageState };
    nodeId = selectOnBranch(nodeId, node.flow.branches, {
      flags: pageState.flags,
      params: state.deps.params,
      node: nodeScopeRef(state),
    });
  }
}

/**
 * 컴파일된 시나리오를 한 run에 대해 순회 실행하고 terminal outcome을 반환한다(ctx 원본 불변).
 */
export async function runScenario(
  scenario: CompiledScenario,
  initialCtx: RunContext,
  deps: InterpreterDeps,
): Promise<ScenarioOutcome> {
  // budget = graph_max_steps(구조적) + loop/fallback allowance(D8-A8/A9). loop 반복·fallback 티어 재시도가 구조 상한을
  // spurious 소진하지 않게 확장(두 가드 독립). deps.maxSteps override는 그대로(운영자 전권). 비-loop/비-fallback은 200 불변.
  const nodeCount = Object.keys(scenario.nodes).length;
  let allowance = 0;
  for (const n of Object.values(scenario.nodes)) {
    if (n.flow.kind === "loop") allowance += n.flow.maxIterations * nodeCount;
    else if (n.flow.kind === "fallback") allowance += n.flow.tiers.length * nodeCount;
  }
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS + allowance;
  const state: TraversalState = {
    scenario,
    deps,
    nodeScope: {},
    loopState: new Map(),
    visited: [],
    steps: [],
    budget: { remaining: maxSteps },
  };
  const terminal = await traverse(state, scenario.start, initialCtx);
  return { terminal, visited: state.visited, steps: state.steps };
}
