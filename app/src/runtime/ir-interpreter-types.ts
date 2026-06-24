/**
 * IR 인터프리터 타입 — 컴파일된 시나리오 그래프(NodeFlow/ScenarioNode/CompiledScenario), 인터프리터 deps/step,
 * suspend 컨텍스트, scenario outcome. 분해 전 ir-interpreter.ts 내부였음(CLAUDE.md #7). 런타임 코드 없는 타입 전용.
 */
import type { IRELNode } from "../../../codegen/irel-compile";
import type { ArtifactRef, ClassifiedException, ExecutorPlugin, PageStateResolver, StepStatus } from "../../../ts/core-types";
import type { CompiledOnBranch } from "./flow-control";
import type { ExtractResultPage, MergedExtractResult } from "./extract-result-merge";

export type NodeFlow =
  | { readonly kind: "terminal"; readonly terminal: string }
  | { readonly kind: "next"; readonly target: string }
  | { readonly kind: "on"; readonly branches: readonly CompiledOnBranch<string>[] }
  // loop: body_target 서브그래프를 until=true 또는 max_iterations 도달까지 반복(둘 다 exit_target로 graceful 탈출,
  // ir.schema/V4). body 서브그래프는 loop 노드로 사이클백(V4: 사이클은 loop 노드 포함 시만 허용). until은 컴파일 AST.
  | { readonly kind: "loop"; readonly until: IRELNode; readonly bodyTarget: string; readonly exitTarget: string; readonly maxIterations: number }
  // fallback: 티어(T0→T3)를 순서대로 entry_node 부터 서브그래프 실행(sub-traversal), advance_when(true=전환) 또는 기본
  // (실패 시 전환)으로 다음 티어 시도. 채택 티어의 terminal이 노드 outcome(terminal-producing), tier 투영(ir-static-validation §4).
  | { readonly kind: "fallback"; readonly tiers: readonly { readonly tier: string; readonly entryNode: string; readonly advanceWhen?: IRELNode }[] }
  // reserved_handler: 복귀형 예약 핸들러 호출(@challenge/@human_task, reserved-handlers.md). next/on target 이 {handler,input,return_node}
  // 객체일 때. @human_task 는 항상 suspend(R5, 트리거 ii). @challenge(ChallengeResolutionPolicy)는 미구현 — dispatch 시 loud throw.
  | { readonly kind: "reserved_handler"; readonly handler: "@challenge" | "@human_task"; readonly input: Record<string, unknown>; readonly returnNode: string };

/** 인터프리터가 순회하는 노드. what 은 ExecutorPlugin.execute가 받는 액션(형 검증은 실행기 책임). */
export interface NodeVerify {
  /** verify.schema criteria[]. executor.verify 가 criterion 타입 권위(unknown 통과 — what 과 동일 패턴). */
  readonly criteria: readonly unknown[];
  /** verify 실패 시 라우팅(verify.schema on_fail, 기본 self_heal). self_heal: markSuspect+노드 재실행(read-only 한정). */
  readonly onFail: string;
  /** self-heal 재실행 상한(nodePolicy.max_self_heal, 기본 2). 소진 시 loud fail. */
  readonly maxSelfHeal: number;
}

export interface ScenarioNode {
  readonly what: readonly unknown[];
  readonly flow: NodeFlow;
  /** P0b: node.verify 투영. 미지정 시 verify 미실행(기존 동작 보존). 실패 시 loud fail terminal(self-heal 재시도는 후속 슬라이스). */
  readonly verify?: NodeVerify;
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
  /** resume 재진입 노드(ResumeToken.resumeNodeId). 미지정 시 scenario.start. 재개 시 드라이버가 주입(같은 노드 재진입). */
  readonly startNode?: string;
}

export interface InterpreterStep {
  readonly nodeId: string;
  readonly action: string;
  readonly status: StepStatus;
}

/**
 * suspend(중단) 컨텍스트 — terminal === "suspend" 일 때만 ScenarioOutcome.suspend 에 존재. driver 가 R4/R5+포트+R11 에 사용.
 * 두 트리거(kind 로 판별):
 *   - challenge(트리거 i): executor step status='suspended'. driver 가 R4(running→suspending, step.challenge_detected).
 *     resumeNodeId = 같은 노드 재진입(오너 결정: idempotent 재실행). pageStateRef = res.pageStateAfter.
 *   - human_task(트리거 ii, R5): IR @human_task 노드. driver 가 R5(running→suspending, human_task_required).
 *     resumeNodeId = @human_task input.return_node(해소 후 재개, reserved-handlers). pageStateRef = 현 페이지(재개 검증).
 */
interface SuspendContextBase {
  readonly stepId: string;
  readonly resumeNodeId: string;
  readonly attempt: number;
  readonly pageStateRef: string;
  readonly exception?: ClassifiedException;
}
export interface ChallengeSuspendContext extends SuspendContextBase {
  readonly kind: "challenge";
  readonly challengeKind: "captcha" | "mfa";
}
export interface HumanTaskSuspendContext extends SuspendContextBase {
  readonly kind: "human_task";
  readonly humanTaskKind: "approval" | "validation" | "exception";
  readonly assigneeRole: string;
  readonly onTimeout: "fail" | "escalate";
  readonly timeoutMs?: number;
  readonly payload?: Record<string, unknown>;
  readonly resultSchema?: Record<string, unknown>;
  readonly artifactRefs?: readonly string[];
}
export type SuspendContext = ChallengeSuspendContext | HumanTaskSuspendContext;

export interface ScenarioOutcome {
  readonly terminal: string; // success | success_empty | fail_business | fail_system | suspend
  readonly visited: readonly string[];
  readonly steps: readonly InterpreterStep[];
  readonly artifacts: readonly ArtifactRef[];
  readonly extractPages?: readonly ExtractResultPage[];
  readonly mergedExtract?: MergedExtractResult;
  readonly suspend?: SuspendContext; // terminal === "suspend" 일 때만(트리거 i)
  // fail_* terminal 의 사유 코드 — in-band 실패(실행기 step 실패가 fail terminal 로 반환) 시 마지막 실패 step 의
  //   exception.code 를 운반한다. driver 가 runs.failure_reason 으로 기록(UI 표시). 미설정이면 driver 가 throw 경로 사유로 폴백.
  readonly failureReason?: { readonly code: string; readonly message: string };
}
