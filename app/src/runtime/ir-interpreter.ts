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
import type { ExecutorPlugin, PageStateResolver, RunContext, StepStatus } from "../../../ts/core-types";
import { selectOnBranch, type CompiledOnBranch } from "./flow-control";

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
    for (let k = 0; k < node.what.length; k += 1) {
      const res = await deps.executor.execute(`${nodeId}.${k}`, node.what[k], ctx);
      steps.push({ nodeId, action: res.action, status: res.status });
      if (res.status === "success") continue;
      const term = failureTerminal(res.status);
      if (term !== null) return { terminal: term, visited, steps };
      throw new InterpreterError(
        "EXECUTOR_STATUS_UNSUPPORTED",
        `interpreter: step '${nodeId}.${k}' returned status '${res.status}' (suspend/challenge/loop 미지원 — 1단계)`,
      );
    }

    // 2) 흐름 전이.
    if (node.flow.kind === "terminal") {
      return { terminal: node.flow.terminal, visited, steps };
    }
    if (node.flow.kind === "next") {
      nodeId = node.flow.target;
      continue;
    }
    // on[]: PageState(flags) 산출(observe) → 분기. 무매칭/scope missing은 flow-control이 throw(전파).
    const pageState = await deps.resolver.resolvePageState(ctx);
    ctx = { ...ctx, pageState };
    nodeId = selectOnBranch(nodeId, node.flow.branches, { flags: pageState.flags });
  }

  throw new InterpreterError(
    "IR_LOOP_LIMIT",
    `interpreter: exceeded ${maxSteps} steps without reaching terminal (비종료 그래프 의심)`,
  );
}
