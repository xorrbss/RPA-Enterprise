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
 * 범위(1단계, 결정형): navigate/download/upload(UtilityExecutor) + next/on[]/terminal.
 *   - dom act/observe/extract(LLM)·vision은 실행기가 EXECUTOR_CAPABILITY_MISMATCH로 거부 → 그대로 전파(가정 금지).
 *   - loop/fallback_chain·예약핸들러(@challenge/@human_task/@end_no_data)·suspend는 후속 단계. 미처리 status는
 *     조용히 흘리지 않고 InterpreterError로 표면화한다("조용한 false/unknown 금지").
 */
import type { ExecutorPlugin, PageStateResolver, RunContext, StepResult, StepStatus } from "../../../ts/core-types";
import { selectOnBranch, type CompiledOnBranch } from "./flow-control";

/** 표준 노드 출력 필드(IREL node.<id>.*). 미투영 필드는 부재 → 참조 시 IREL_RUNTIME_MISSING(loud). */
interface NodeOutput {
  readonly status: StepStatus;
  readonly row_count?: number;
  readonly extracted_ref?: string;
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
  | { readonly kind: "on"; readonly branches: readonly CompiledOnBranch<string>[] };

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
  /** 그래프 비종료(무한 루프) 방어 상한. ops-defaults 연동은 후속. */
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

const DEFAULT_MAX_STEPS = 200;

// 실패 status → terminal 매핑. 처리 못 하는 status(suspended/challenge/uncertain 등)는 null → 호출부가 표면화.
function failureTerminal(status: StepStatus): string | null {
  if (status === "failed_business") return "fail_business";
  if (status === "failed_system" || status === "failed_security") return "fail_system";
  return null;
}

/**
 * 컴파일된 시나리오를 한 run에 대해 순회 실행하고 terminal outcome을 반환한다.
 * ctx는 노드마다 nodeId/pageState를 갱신한 사본으로 실행기에 전달된다(원본 불변).
 */
export async function runScenario(
  scenario: CompiledScenario,
  initialCtx: RunContext,
  deps: InterpreterDeps,
): Promise<ScenarioOutcome> {
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
  const visited: string[] = [];
  const steps: InterpreterStep[] = [];
  // 실행 완료 노드의 표준 출력(node.<id>.*). status(항상) + extract 노드의 row_count({rows} 봉투 길이)·extracted_ref
  // (출력 아티팩트). tier(fallback)·비-extract row_count 등 미투영 필드 참조는 IREL_RUNTIME_MISSING(loud, ir-expression §2).
  const nodeScope: Record<string, NodeOutput> = {};
  let ctx = initialCtx;
  let nodeId = scenario.start;

  for (let i = 0; i < maxSteps; i += 1) {
    const node = scenario.nodes[nodeId];
    if (node === undefined) {
      throw new InterpreterError("IR_SCHEMA_INVALID", `interpreter: unknown node '${nodeId}'`);
    }
    visited.push(nodeId);
    ctx = { ...ctx, nodeId };

    // 1) 노드의 결정형 what 액션을 순서대로 실행. 비-success는 terminal 실패로 매핑하거나 표면화.
    let lastResult: StepResult | undefined;
    for (let k = 0; k < node.what.length; k += 1) {
      const res = await deps.executor.execute(`${nodeId}.${k}`, node.what[k], ctx);
      steps.push({ nodeId, action: res.action, status: res.status });
      lastResult = res;
      if (res.status === "success") continue;
      const term = failureTerminal(res.status);
      if (term !== null) return { terminal: term, visited, steps };
      throw new InterpreterError(
        "EXECUTOR_STATUS_UNSUPPORTED",
        `interpreter: step '${nodeId}.${k}' returned status '${res.status}' (suspend/challenge/loop 미지원 — 1단계)`,
      );
    }
    // what 루프 직후 무조건 기록(terminal/next/on 분기 전 공통점). 빈 what[](observe 전용) 노드는 lastResult 미정 →
    // nodeScope 미기록 → node.<id>.* 참조는 IREL_RUNTIME_MISSING(loud). 비-success는 위에서 이미 return/throw 하므로
    // 여기 도달하면 status 는 항상 "success"(현 short-circuit 시맨틱 — 실패/suspend 연속 경로는 후속).
    if (lastResult !== undefined) nodeScope[nodeId] = projectNodeOutput(lastResult);

    // 2) 흐름 전이.
    if (node.flow.kind === "terminal") {
      return { terminal: node.flow.terminal, visited, steps };
    }
    if (node.flow.kind === "next") {
      nodeId = node.flow.target;
      continue;
    }
    // on[]: PageState(flags) 산출(observe) → 분기. scope = flags + params + 누적 node.status.
    // 주의: on[].when 이 참조하는 node.<id> 는 컴파일 시 graph-ancestor 보장(static-validation forward-ref)이나
    // 런타임 도달 보장은 dominator 뿐 — diamond DAG 에서 분기로 건너뛴 ancestor 참조는 IREL_RUNTIME_MISSING(loud, 정상).
    const pageState = await deps.resolver.resolvePageState(ctx);
    ctx = { ...ctx, pageState };
    nodeId = selectOnBranch(nodeId, node.flow.branches, {
      flags: pageState.flags,
      params: deps.params,
      node: nodeScope as unknown as Record<string, Record<string, unknown>>,
    });
  }

  throw new InterpreterError(
    "IR_LOOP_LIMIT",
    `interpreter: exceeded ${maxSteps} steps without reaching terminal (비종료 그래프 의심)`,
  );
}
