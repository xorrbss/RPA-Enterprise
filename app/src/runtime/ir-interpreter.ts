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
 *   - suspend: executor step status='suspended' → "suspend" terminal + SuspendContext 산출(트리거 i, driver 가 R4+포트+R11 구동).
 *     예약핸들러(@challenge/@human_task IR 노드)·기타 미처리 status(challenge/uncertain/skipped)는 조용히 흘리지 않고
 *     InterpreterError로 표면화한다("조용한 false/unknown 금지").
 */
import type { IRELNode, IRELScope } from "../../../codegen/irel-compile";
import type { ArtifactRef, ClassifiedException, ExecutorPlugin, HttpResponseSnapshot, PageStateResolver, RunContext, StepResult, StepStatus, VerifyResult } from "../../../ts/core-types";
import { SPAN, withSpan, spanCommonFromContext } from "../observability/telemetry";
import { evaluateCondition, selectOnBranch, NoBranchMatchedError, SessionRegistrationRequiredError, type CompiledOnBranch } from "./flow-control";
import { mergeExtractOutputs, type ExtractResultPage, type MergedExtractResult } from "./extract-result-merge";
import {
  HUMAN_TASK_MAX_TIMEOUT_MS,
  HUMAN_TASK_MIN_TIMEOUT_MS,
  parseHumanTaskTimeoutMs,
} from "./human-task-timeout-policy";
import type {
  CompiledScenario,
  InterpreterDeps,
  InterpreterStep,
  ScenarioOutcome,
  SuspendContext,
} from "./ir-interpreter-types";

export type {
  ChallengeSuspendContext,
  CompiledScenario,
  HumanTaskSuspendContext,
  InterpreterDeps,
  InterpreterStep,
  NodeFlow,
  NodeVerify,
  ScenarioNode,
  ScenarioOutcome,
  SuspendContext,
} from "./ir-interpreter-types";

/** §E executor.execute span 의 `executor` 속성 — 플러그인 활성 capability 라벨(dom/vision/utility). 미활성=none. */
function executorCapabilityLabel(caps: { dom: boolean; vision: boolean; utility: boolean }): string {
  const active = (["dom", "vision", "utility"] as const).filter((kind) => caps[kind]);
  return active.length > 0 ? active.join("+") : "none";
}

/** 표준 노드 출력 필드(IREL node.<id>.*). 미투영 필드는 부재 → 참조 시 IREL_RUNTIME_MISSING(loud). */
interface NodeOutput {
  // status 는 실행 노드(StepResult 투영)에만 부착. @human_task 해소 출력은 StepStatus 가 없어 status 부재(decision/correction 만, ir-expression §2).
  readonly status?: StepStatus;
  readonly row_count?: number;
  readonly extracted_ref?: string;
  readonly http_status?: number;
  readonly http_ok?: boolean;
  readonly http_body?: unknown;
  // tier: fallback_chain 노드가 채택한 티어(T0..T3). fallback 노드 출력에만 부착(ir-expression §2). 비-fallback은 부재(loud).
  readonly tier?: string;
  // @human_task 해소 출력(resume nodeScope 시드): decision(닫힌 enum)·correction(business_form 교정값). reserved-handlers.md.
  readonly decision?: string;
  readonly correction?: Record<string, unknown>;
}

/** StepResult → 표준 노드 출력 투영(ir-expression §2). status는 항상; row_count/extracted_ref는 extract 액션만. */
function projectNodeOutput(res: StepResult): NodeOutput {
  if (res.action === "api_call") {
    const http = httpResponseFromStep(res);
    return {
      status: res.status,
      ...(http !== undefined ? {
        http_status: http.status,
        http_ok: http.ok,
        ...(http.body !== undefined ? { http_body: http.body } : {}),
      } : {}),
    };
  }
  if (res.action !== "extract") return { status: res.status };
  const rowCount = res.output !== null && typeof res.output === "object" ? (res.output as { rowCount?: unknown }).rowCount : undefined;
  const ref = res.artifacts[0];
  return {
    status: res.status,
    ...(typeof rowCount === "number" ? { row_count: rowCount } : {}),
    ...(typeof ref === "string" ? { extracted_ref: ref } : {}),
  };
}

function httpResponseFromStep(res: StepResult): HttpResponseSnapshot | undefined {
  if (res.action !== "api_call" || res.output === undefined || typeof res.output !== "object" || res.output === null) return undefined;
  const output = res.output as Partial<HttpResponseSnapshot>;
  if (typeof output.status !== "number" || typeof output.ok !== "boolean" || typeof output.contentType !== "string" || typeof output.finalUrl !== "string" || typeof output.bodyTruncated !== "boolean") return undefined;
  return {
    status: output.status,
    ok: output.ok,
    contentType: output.contentType,
    finalUrl: output.finalUrl,
    redirected: output.redirected === true,
    ...(typeof output.redirectLocation === "string" ? { redirectLocation: output.redirectLocation } : {}),
    ...(Object.prototype.hasOwnProperty.call(output, "body") ? { body: output.body } : {}),
    bodyTruncated: output.bodyTruncated,
  };
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
  readonly artifacts: ArtifactRef[];
  readonly extractPages: ExtractResultPage[];
  readonly budget: { remaining: number };
  // suspend 컨텍스트 운반 박스(budget 과 동형 가변 박스) — traverse 가 set, runScenario 가 read.
  readonly suspendBox: { current?: SuspendContext };
  // 실패 운반 박스 — 실행기 step 실패가 fail terminal 로 반환될 때 그 exception 을 담아 runScenario 가 outcome.failureReason 으로 노출.
  readonly failureBox: { current?: ClassifiedException };
}

/** IRELScope.node 캐스트(NodeOutput record → IREL 평가용). */
function nodeScopeRef(state: TraversalState): Record<string, Record<string, unknown>> {
  return state.nodeScope as unknown as Record<string, Record<string, unknown>>;
}

/** terminal 문자열 → StepStatus(fallback 노드 출력의 status 도출 — 채택 티어 entry_node 출력 부재 시). */
function collectExtractPage(state: TraversalState, nodeId: string, stepId: string, res: StepResult): void {
  if (res.action !== "extract" || res.status !== "success") return;
  const output = res.extracted ?? res.output;
  if (output === undefined) return;
  const artifactRef = res.artifacts[0];
  state.extractPages.push({
    nodeId,
    stepId,
    output,
    ...(typeof artifactRef === "string" ? { artifactRef } : {}),
  });
}

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
 * @human_task input(reserved-handlers) → 타입 검증된 산출. 미정/오류는 조용히 흘리지 않고 IR_SCHEMA_INVALID 로 표면화.
 * kind 미지정→exception 기본(R5), on_timeout 미지정→fail 기본(reserved-handlers/DDL). assignee_role 은 필수(미할당 task 금지).
 * payload·timeout(둘 다 optional)은 v1 의도적 미투영(은폐 아님, 명시 deferral): payload 는 inline 저장 부재(read 측 v1
 * 미포함, payload_ref 만) · timeout→expires_at 은 human_task timeout 스위퍼(H4/H8)가 미구현이라 발화 소비자 없음
 * (challenge 경로도 expires_at 미설정 동일). 스위퍼 증분에서 timeout 파싱+expires_at+payload_ref 를 함께 배선.
 */
function parseHumanTaskInput(
  nodeId: string,
  input: Record<string, unknown>,
): {
  humanTaskKind: "approval" | "validation" | "exception";
  assigneeRole: string;
  onTimeout: "fail" | "escalate";
  timeoutMs?: number;
  payload?: Record<string, unknown>;
  resultSchema?: Record<string, unknown>;
  artifactRefs?: readonly string[];
} {
  const kindRaw = input.kind;
  let humanTaskKind: "approval" | "validation" | "exception";
  if (kindRaw === undefined) humanTaskKind = "exception";
  else if (kindRaw === "approval" || kindRaw === "validation" || kindRaw === "exception") humanTaskKind = kindRaw;
  else
    throw new InterpreterError(
      "IR_SCHEMA_INVALID",
      `@human_task node '${nodeId}': input.kind '${String(kindRaw)}' 무효(approval|validation|exception)`,
    );
  const assigneeRole = input.assignee_role;
  if (typeof assigneeRole !== "string" || assigneeRole.trim().length === 0) {
    throw new InterpreterError("IR_SCHEMA_INVALID", `@human_task node '${nodeId}': input.assignee_role 필수(비어있지 않은 string)`);
  }
  const onTimeoutRaw = input.on_timeout;
  let onTimeout: "fail" | "escalate";
  if (onTimeoutRaw === undefined) onTimeout = "fail";
  else if (onTimeoutRaw === "fail" || onTimeoutRaw === "escalate") onTimeout = onTimeoutRaw;
  else
    throw new InterpreterError(
      "IR_SCHEMA_INVALID",
      `@human_task node '${nodeId}': input.on_timeout '${String(onTimeoutRaw)}' 무효(fail|escalate)`,
    );
  const timeoutRaw = input.timeout;
  let timeoutMs: number | undefined;
  if (timeoutRaw !== undefined) {
    if (typeof timeoutRaw !== "string") {
      throw new InterpreterError("IR_SCHEMA_INVALID", `@human_task node '${nodeId}': input.timeout must be a duration string`);
    }
    const parsed = parseHumanTaskTimeoutMs(timeoutRaw);
    if (parsed === null) {
      throw new InterpreterError(
        "IR_SCHEMA_INVALID",
        `@human_task node '${nodeId}': input.timeout '${timeoutRaw}' invalid (ms|s|m|h|d, ${HUMAN_TASK_MIN_TIMEOUT_MS}-${HUMAN_TASK_MAX_TIMEOUT_MS}ms)`,
      );
    }
    timeoutMs = parsed;
  }
  const payload = optionalRecordInput(nodeId, input.payload, "payload");
  const resultSchema = optionalRecordInput(nodeId, input.result_schema, "result_schema");
  const artifactRefs = optionalStringArrayInput(nodeId, input.artifact_refs, "artifact_refs");
  return {
    humanTaskKind,
    assigneeRole,
    onTimeout,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(payload !== undefined ? { payload } : {}),
    ...(resultSchema !== undefined ? { resultSchema } : {}),
    ...(artifactRefs !== undefined ? { artifactRefs } : {}),
  };
}

function optionalRecordInput(nodeId: string, value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new InterpreterError("IR_SCHEMA_INVALID", `@human_task node '${nodeId}': input.${field} 는 object 여야 함`);
}

function optionalStringArrayInput(nodeId: string, value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)) {
    return value;
  }
  throw new InterpreterError("IR_SCHEMA_INVALID", `@human_task node '${nodeId}': input.${field} 는 non-empty string[] 이어야 함`);
}

/**
 * startNode 부터 terminal 까지 순회하며 terminal 문자열을 반환한다(가변 state 공유, ctx 원본 불변).
 * fallback 티어는 본 함수를 재귀 호출(sub-traversal)해 같은 state(nodeScope/loopState/budget) 위에서 실행한다.
 */
async function runNodeVerify(state: TraversalState, criteria: readonly unknown[], ctx: RunContext): Promise<VerifyResult> {
  // P0b: node.verify criteria[] 를 결정형 executor.verify 로 평가. 첫 non-pass 의 VerifyResult 반환, 전부 pass 면 pass.
  //   각 호출은 §E verify.run span 으로 래핑. 미지원 criterion 은 executor.verify 가 loud throw(조용한 통과 금지).
  let last: VerifyResult = { status: "pass", confidence: 1, failedCriteria: [], evidenceRefs: [], recommendation: "continue" };
  for (const criterion of criteria) {
    const vr = await withSpan(
      SPAN.verifyRun,
      spanCommonFromContext(ctx),
      { node_id: ctx.nodeId },
      async (span) => {
        const r = await state.deps.executor.verify(criterion, ctx);
        span.setAttribute("status", r.status);
        span.setAttribute("recommendation", r.recommendation);
        return r;
      },
    );
    if (vr.status !== "pass") return vr;
    last = vr;
  }
  return last;
}

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
    // @end_no_data 는 노드가 아니라 데이터-없음 terminal(success_empty)이다(ir.schema endNoDataTarget·reserved-handlers·V1/V7).
    //   next/on[].target 으로 도달하면 노드 조회 전에 가로채 success_empty 로 종료한다 — 아니면 unknown node →
    //   IR_SCHEMA_INVALID throw → failed_system 으로 오분류된다(IREL 감사). 노드 id 패턴(^[a-zA-Z_])상 "@end_no_data" 와 충돌 불가.
    if (nodeId === "@end_no_data") return "success_empty";
    const node = state.scenario.nodes[nodeId];
    if (node === undefined) {
      throw new InterpreterError("IR_SCHEMA_INVALID", `interpreter: unknown node '${nodeId}'`);
    }
    state.visited.push(nodeId);
    ctx = { ...ctx, nodeId };

    const pause = await state.deps.pauseRequested?.(ctx);
    if (pause !== undefined && pause !== null) {
      state.suspendBox.current = {
        kind: "operator_pause",
        stepId: `${nodeId}.operator_pause`,
        resumeNodeId: nodeId,
        attempt: ctx.attempt,
        pageStateRef: `ps_${ctx.pageState.dom.structuralHash}`,
        pauseRequestId: pause.pauseRequestId,
        ...(pause.reason !== undefined ? { reason: pause.reason } : {}),
      };
      return "suspend";
    }

    // 1) 결정형 what 액션 실행 + (있으면) node.verify 검증. verify 실패 시 self-heal(markSuspect+노드 재실행) 또는 loud fail.
    //    self-heal 은 read-only 노드만(쓰기 커밋 노드 재실행=double-commit 금지) + max_self_heal 한도 + budget 소비.
    let lastResult: StepResult | undefined;
    let selfHealCount = 0;
    let execCtx = ctx; // 재시도 시 selfHealRetry=true + attempt bump(run_steps UNIQUE 충돌 회피); flow 는 원본 ctx 사용.
    for (;;) {
      lastResult = undefined;
      let nodeCommittedSideEffect = false;
      for (let k = 0; k < node.what.length; k += 1) {
        const stepId = `${nodeId}.${k}`;
        // §E 필수 span: executor.execute. 예외는 withSpan 이 record+ERROR 후 재던져 driveScenario system-failsafe 가 흡수.
        const res = await withSpan(
          SPAN.executorExecute,
          spanCommonFromContext(execCtx),
          { node_id: nodeId, executor: executorCapabilityLabel(state.deps.executor.capabilities()) },
          async (span) => {
            const r = await state.deps.executor.execute(stepId, node.what[k], execCtx);
            span.setAttribute("action", r.action);
            span.setAttribute("status", r.status);
            return r;
          },
        );
        state.steps.push({ nodeId, action: res.action, status: res.status });
        state.artifacts.push(...res.artifacts);
        lastResult = res;
        {
          const http = httpResponseFromStep(res);
          if (http !== undefined) execCtx = { ...execCtx, lastHttpResponse: http };
        }
        if (res.status === "success") {
          collectExtractPage(state, nodeId, stepId, res);
          // 쓰기 커밋 추적 — self-heal 재실행 금지 판정(double-commit 안전): 비-read_only 커밋 노드는 재시도하지 않는다.
          if (res.sideEffect?.committed === true && res.sideEffect.kind !== "read_only") nodeCommittedSideEffect = true;
          continue;
        }
        // 실패 노드도 status 투영(ir-expression §2). fallback advance_when 이 실패 status 를 관측하므로 terminal 반환 전 기록.
        const failOut = projectNodeOutput(res);
        state.nodeScope[nodeId] = currentTier !== undefined ? { ...failOut, tier: currentTier } : failOut;
        const term = failureTerminal(res.status);
        if (term !== null) {
          // 실패 사유(step exception)를 outcome 으로 운반 — driver 가 runs.failure_reason 으로 기록(조용한 사유유실 금지).
          if (res.exception !== undefined) state.failureBox.current = res.exception;
          return term;
        }
        // suspend(트리거 i): status='suspended' → SuspendContext + "suspend" terminal. challengeKind 는 executor 신호(하드코딩 금지),
        //   human-assist 가능군은 captcha|mfa 뿐 — 그 외는 계약 위반으로 표면화(조용한 captcha 폴백 금지).
        if (res.status === "suspended") {
          const detected = res.challenge?.type;
          if (detected !== "captcha" && detected !== "mfa") {
            throw new InterpreterError(
              "EXECUTOR_STATUS_UNSUPPORTED",
              `interpreter: step '${nodeId}.${k}' status='suspended' 인데 challenge.type='${detected ?? "none"}' (human-assist=captcha|mfa 아님)`,
            );
          }
          state.suspendBox.current = {
            kind: "challenge",
            stepId: `${nodeId}.${k}`,
            resumeNodeId: nodeId,
            attempt: execCtx.attempt,
            challengeKind: detected,
            pageStateRef: res.pageStateAfter,
            ...(res.exception !== undefined ? { exception: res.exception } : {}),
          };
          return "suspend";
        }
        throw new InterpreterError(
          "EXECUTOR_STATUS_UNSUPPORTED",
          `interpreter: step '${nodeId}.${k}' returned status '${res.status}' (challenge/uncertain/skipped 미지원)`,
        );
      }
      if (lastResult !== undefined) {
        const out = projectNodeOutput(lastResult);
        state.nodeScope[nodeId] = currentTier !== undefined ? { ...out, tier: currentTier } : out;
      }

      // 1b) P0b: node.verify 결정형 검증(what 성공 후, 흐름 전 — verify-every-iteration). 미지정 노드는 스킵(기존 동작 보존).
      if (node.verify === undefined) break;
      const verdict = await runNodeVerify(state, node.verify.criteria, execCtx);
      if (verdict.status === "pass") break;
      // 검증 실패 → self-heal(on_fail=self_heal·read-only·budget·한도 내): markSuspect+노드 재실행(=cache miss→재해소).
      //   쓰기 커밋 노드/한도 소진/비-self_heal → loud fail_business(조용한 통과 금지).
      if (
        node.verify.onFail === "self_heal" &&
        !nodeCommittedSideEffect &&
        selfHealCount < node.verify.maxSelfHeal &&
        state.budget.remaining > 0
      ) {
        selfHealCount += 1;
        state.budget.remaining -= 1;
        execCtx = { ...ctx, selfHealRetry: true, attempt: ctx.attempt + selfHealCount };
        continue;
      }
      return "fail_business";
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
    if (node.flow.kind === "reserved_handler") {
      const rh = node.flow;
      if (rh.handler !== "@human_task") {
        // @challenge: ChallengeResolutionPolicy(PRD §10.6)·ChallengeDetector 미구현 — 조용히 흘리지 않고 표면화.
        throw new InterpreterError(
          "RESERVED_HANDLER_UNSUPPORTED",
          `interpreter: reserved-handler '${rh.handler}' node '${nodeId}' 미구현(@challenge ResolutionPolicy 후속)`,
        );
      }
      // R5(트리거 ii): @human_task → 항상 suspend. kind/assignee_role/on_timeout 을 input 에서 파싱(하드코딩 금지, reserved-handlers).
      const ht = parseHumanTaskInput(nodeId, rh.input);
      // pageStateRef: what 실행 시 마지막 StepResult.pageStateAfter(challenge 와 동일 출처), what-less 면 현 페이지뷰 ref
      //   (page-state-resolver.pageStateRef 규약 `ps_${structuralHash}` 와 일치 — resume 검증이 양측 일치 의존).
      const pageRef = lastResult !== undefined ? lastResult.pageStateAfter : `ps_${ctx.pageState.dom.structuralHash}`;
      state.suspendBox.current = {
        kind: "human_task",
        nodeId,
        stepId: `${nodeId}.@human_task`,
        resumeNodeId: rh.returnNode,
        attempt: ctx.attempt,
        humanTaskKind: ht.humanTaskKind,
        assigneeRole: ht.assigneeRole,
        onTimeout: ht.onTimeout,
        ...(ht.timeoutMs !== undefined ? { timeoutMs: ht.timeoutMs } : {}),
        ...(ht.payload !== undefined ? { payload: ht.payload } : {}),
        ...(ht.resultSchema !== undefined ? { resultSchema: ht.resultSchema } : {}),
        ...(ht.artifactRefs !== undefined ? { artifactRefs: ht.artifactRefs } : {}),
        pageStateRef: pageRef,
      };
      return "suspend";
    }
    // on[]: PageState(flags) 산출(observe) → 분기. scope = flags + params + 누적 node.
    // 주의: on[].when 이 참조하는 node.<id> 는 컴파일 시 graph-ancestor 보장이나 런타임 도달 보장은 dominator 뿐 —
    // diamond DAG 에서 분기로 건너뛴 ancestor 참조는 IREL_RUNTIME_MISSING(loud, 정상).
    const pageState = await state.deps.resolver.resolvePageState(ctx);
    ctx = { ...ctx, pageState };
    try {
      nodeId = selectOnBranch(nodeId, node.flow.branches, {
        flags: pageState.flags,
        params: state.deps.params,
        node: nodeScopeRef(state),
      });
    } catch (e) {
      // login_required 페이지인데 그것을 받는 분기가 없으면, 모호한 IR_NO_BRANCH_MATCHED 대신 세션 등록 필요로 분류한다.
      //   (self-login 시나리오는 login_required 분기가 매칭돼 여기 도달 안 함 → 오탐 0. 조용한 false 금지: loud throw.)
      if (e instanceof NoBranchMatchedError && pageState.flags.login_required === true) {
        throw new SessionRegistrationRequiredError(nodeId);
      }
      throw e;
    }
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
    // resume 시 해소된 @human_task 출력(node.<id>.decision/correction)을 시드(드라이버 주입). 정상 시작은 빈 스코프.
    nodeScope: { ...(deps.resumeNodeOutputs ?? {}) },
    loopState: new Map(),
    visited: [],
    steps: [],
    artifacts: [],
    extractPages: [],
    budget: { remaining: maxSteps },
    suspendBox: {},
    failureBox: {},
  };
  // resume: deps.startNode(ResumeToken.resumeNodeId)부터 재진입. 미지정 시 scenario.start(정상 시작). traverse 는 임의 노드 시작 지원(fallback sub-traversal과 동일).
  const terminal = await traverse(state, deps.startNode ?? scenario.start, initialCtx);
  return {
    terminal,
    visited: state.visited,
    steps: state.steps,
    artifacts: state.artifacts,
    ...(state.extractPages.length > 0
      ? {
          extractPages: state.extractPages,
          mergedExtract: mergeExtractOutputs(state.extractPages.map((page) => page.output)),
        }
      : {}),
    ...(state.suspendBox.current !== undefined ? { suspend: state.suspendBox.current } : {}),
    ...(state.failureBox.current !== undefined ? { failureReason: { code: state.failureBox.current.code, message: "" } } : {}),
  };
}
