/**
 * StagehandDomExecutor — dom 실행기(act/observe/extract) ↔ LLM Gateway 연결 (D3 LLM 절반 / architecture §9.1 step2).
 *
 * 계약(llm-gateway-adapter.md §1): **Executor 는 Gateway 만 호출하고 adapter 를 직접 모른다.** dom 프리미티브는
 * PageState 컨텍스트로 `LLMRequest` 를 만들어 `LlmGateway.call` 로 보낸다.
 *  - observe/extract: read-only. extract 는 LLMResponse.parsedJson 을 StepResult.extracted 로.
 *  - **act: LLM 이 구조화 ActionPlan(operation/selector/value)을 반환 → CDP 로 실제 mutation 적용(click/fill/select).**
 *    architecture §2 의 ActionPlanCache 재생: familyKey(structuralHash+instruction) hit 시 LLM 미호출로 plan 재생(결정형),
 *    miss 시 LLM plan → 적용 → 캐시 저장. cache 포트는 옵션(미주입 시 항상 LLM, mode=bypass).
 *
 * capability = {dom:true, vision:false, utility:false}. utility/비브라우저 액션은 명시적 throw(조용한 no-op 금지).
 * GatewayError 종결 실패는 error-catalog exceptionClass 로 분류해 실패 StepResult 로 환원(조용한 흡수 금지).
 */
import { createHash } from "node:crypto";

import { ERROR_CATALOG, type ErrorCode } from "../../../ts/error-catalog";
import type {
  ExceptionClass,
  ExecutorPlugin,
  RunContext,
  SideEffectKind,
  StepResult,
  StepStatus,
  VerifyResult,
} from "../../../ts/core-types";
import type { LLMRequest, LLMResponse } from "../../../ts/security-middleware-contract";
import { GatewayError } from "../gateway/llm-gateway";
import { parseActionPlan, type ActionPlan, type ActionPlanCache, type ActionPlanCacheKey } from "./action-plan-cache";
import type { CdpSession, CdpSessionProvider } from "./cdp-session";
import { pageStateRef } from "./page-state-resolver";

/** Gateway 호출 경계(LlmGateway 가 구조적으로 충족). Executor 는 adapter 가 아니라 이 포트만 본다. */
export interface LlmGatewayCaller {
  call(req: LLMRequest, signal: AbortSignal): Promise<LLMResponse>;
}

// 캐시 계약(ActionPlan/Key/포트)은 공용 action-plan-cache.ts — PgActionPlanCache 가 동일 포트를 구현.
export type { ActionPlan, ActionPlanCache, ActionPlanCacheKey } from "./action-plan-cache";

/** dom 실행기가 지원하는 LLM 프리미티브 액션(IRActionType 의 dom 부분집합). */
export type DomAction =
  | { type: "act"; instruction: string; sideEffect?: SideEffectKind }
  | { type: "observe"; instruction: string }
  | { type: "extract"; instruction: string; output: { schemaRef: string; schemaVersion: string; strict: boolean } };

export type DomExecutorErrorCode = "EXECUTOR_CAPABILITY_MISMATCH" | "IR_SCHEMA_INVALID" | "RUN_ABORTED";

export class StagehandDomExecutorError extends Error {
  constructor(
    readonly code: DomExecutorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StagehandDomExecutorError";
  }
}

export interface StagehandDomExecutorConfig {
  model: string;
  promptTemplateVersion: string;
  budget: LLMRequest["budget"];
  // ActionPlanCache 키 스코프(run-scoped — 오케스트레이터가 run 단위로 주입). url_pattern/structuralHash 는 ctx.pageState 에서.
  scenarioVersionId: string;
  browserIdentityVersion: number;
}

const UTILITY_ACTIONS = new Set(["navigate", "download", "upload", "api_call", "file", "shell"]);
const ACTION_PLAN_SCHEMA = { type: "json_schema", schemaRef: "action_plan", schemaVersion: "1", strict: true } as const;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 32);
const nowIso = (): string => new Date().toISOString();

/** error-catalog exceptionClass → StepStatus + StepResult.exception.class(4종 고정; none→system). */
function classify(code: ErrorCode): { status: StepStatus; cls: ExceptionClass } {
  switch (ERROR_CATALOG[code].exceptionClass) {
    case "business":
      return { status: "failed_business", cls: "business" };
    case "challenge":
      return { status: "failed_challenge", cls: "challenge" };
    case "security":
      return { status: "failed_security", cls: "security" };
    default: // system | none → system
      return { status: "failed_system", cls: "system" };
  }
}

export class StagehandDomExecutor implements ExecutorPlugin {
  constructor(
    private readonly gateway: LlmGatewayCaller,
    private readonly sessions: CdpSessionProvider,
    private readonly cfg: StagehandDomExecutorConfig,
    private readonly cache?: ActionPlanCache,
  ) {}

  capabilities(): { dom: boolean; vision: boolean; utility: boolean } {
    return { dom: true, vision: false, utility: false };
  }

  async execute(stepId: string, action: unknown, ctx: RunContext): Promise<StepResult> {
    if (ctx.abortSignal.aborted) {
      throw new StagehandDomExecutorError("RUN_ABORTED", `step '${stepId}' aborted before execute`);
    }
    const a = this.assertDomAction(stepId, action);
    return a.type === "act" ? this.executeAct(stepId, a, ctx) : this.executeReadOnly(stepId, a, ctx);
  }

  /** observe/extract — read-only LLM 호출(mutation 없음). */
  private async executeReadOnly(
    stepId: string,
    a: Extract<DomAction, { type: "observe" | "extract" }>,
    ctx: RunContext,
  ): Promise<StepResult> {
    const before = pageStateRef(ctx.pageState);
    const startedAt = nowIso();
    const req = this.buildRequest(stepId, a, ctx);
    const callIds = [String(req.idempotencyKey)];

    let res: LLMResponse;
    try {
      res = await this.gateway.call(req, ctx.abortSignal);
    } catch (e) {
      if (e instanceof GatewayError) return this.failResult(stepId, a.type, before, startedAt, e.code, callIds);
      throw e; // GatewayAbortedError 등 제어 신호 전파.
    }

    const endedAt = nowIso();
    return {
      stepId,
      action: a.type,
      status: "success",
      output: { outputRef: res.outputRef, finishReason: res.finishReason },
      extracted: a.type === "extract" ? res.parsedJson : undefined,
      pageStateBefore: before,
      pageStateAfter: before, // 다음 observe 노드가 PageState 갱신(UtilityExecutor 와 동일 패턴).
      artifacts: [res.outputRef],
      stagehandCallIds: callIds,
      cache: { mode: "bypass" },
      sideEffect: { kind: "read_only", committed: true },
      timings: { startedAt, endedAt, durationMs: Date.parse(endedAt) - Date.parse(startedAt) },
    };
  }

  /** act — LLM ActionPlan(또는 캐시 재생) → CDP 로 실제 mutation 적용. */
  private async executeAct(
    stepId: string,
    a: Extract<DomAction, { type: "act" }>,
    ctx: RunContext,
  ): Promise<StepResult> {
    const session = this.sessions.forLease(ctx.leaseId);
    const before = pageStateRef(ctx.pageState);
    const startedAt = nowIso();
    // 캐시 키 = action_plan_cache UNIQUE 7컬럼 + tenant(§D family=(url_pattern, dom_structural_hash)).
    const cacheKey: ActionPlanCacheKey = {
      tenantId: ctx.tenantId,
      scenarioVersionId: this.cfg.scenarioVersionId,
      stepId,
      urlPattern: ctx.pageState.url.pattern,
      domStructuralHash: ctx.pageState.dom.structuralHash,
      model: this.cfg.model,
      promptTemplateVersion: this.cfg.promptTemplateVersion,
      browserIdentityVersion: this.cfg.browserIdentityVersion,
    };

    let plan: ActionPlan | undefined;
    let cacheMode: StepResult["cache"]["mode"] = "bypass";
    let callIds: string[] = [];

    if (this.cache) {
      plan = await this.cache.get(cacheKey);
      cacheMode = plan ? "hit" : "miss";
    }

    if (!plan) {
      // miss/bypass → LLM 으로 plan 산출(Gateway 경유, action_plan 스키마 strict).
      const req = this.buildRequest(stepId, a, ctx);
      callIds = [String(req.idempotencyKey)];
      let res: LLMResponse;
      try {
        res = await this.gateway.call(req, ctx.abortSignal);
      } catch (e) {
        if (e instanceof GatewayError) return this.failResult(stepId, "act", before, startedAt, e.code, callIds);
        throw e;
      }
      const parsed = parseActionPlan(res.parsedJson);
      if (!parsed) return this.failResult(stepId, "act", before, startedAt, "LLM_MALFORMED_OUTPUT", callIds);
      plan = parsed;
      if (this.cache) await this.cache.put(cacheKey, plan);
    }

    // 적용: CDP 로 실제 mutation(click/fill/select). 적용 실패는 런타임 예외로 전파(분류는 상위).
    await this.applyPlan(plan, session);

    const endedAt = nowIso();
    return {
      stepId,
      action: "act",
      status: "success",
      output: { plan },
      pageStateBefore: before,
      pageStateAfter: before,
      artifacts: [],
      stagehandCallIds: callIds,
      cache: { mode: cacheMode, ...(this.cache ? { actionPlanCacheId: cacheKey.domStructuralHash } : {}) },
      // act 는 페이지를 바꾼다 — sideEffect.kind 는 시나리오(IR)가 선언(submit/login 등); 미지정 시 update.
      sideEffect: { kind: a.sideEffect ?? "update", committed: true },
      timings: { startedAt, endedAt, durationMs: Date.parse(endedAt) - Date.parse(startedAt) },
    };
  }

  private async applyPlan(plan: ActionPlan, session: CdpSession): Promise<void> {
    switch (plan.operation) {
      case "click":
        await session.click(plan.selector);
        return;
      case "fill":
        await session.fill(plan.selector, plan.value);
        return;
      case "select":
        await session.selectOption(plan.selector, plan.value);
        return;
    }
  }

  async verify(_criteria: unknown, _ctx: RunContext): Promise<VerifyResult> {
    throw new StagehandDomExecutorError(
      "EXECUTOR_CAPABILITY_MISMATCH",
      "VLM verify requires the vision executor, not the dom executor",
    );
  }

  private failResult(
    stepId: string,
    action: DomAction["type"],
    before: string,
    startedAt: string,
    code: ErrorCode,
    stagehandCallIds: string[],
  ): StepResult {
    const { status, cls } = classify(code);
    const endedAt = nowIso();
    return {
      stepId,
      action,
      status,
      pageStateBefore: before,
      pageStateAfter: before,
      artifacts: [],
      stagehandCallIds,
      cache: { mode: "bypass" },
      exception: { class: cls, code, message: `dom executor ${action} failed: ${code}` as never },
      timings: { startedAt, endedAt, durationMs: Date.parse(endedAt) - Date.parse(startedAt) },
    };
  }

  private buildRequest(stepId: string, a: DomAction, ctx: RunContext): LLMRequest {
    const ps = ctx.pageState;
    // 페이지 컨텍스트는 user 역할로만(신뢰영역 분리, §2). 본 골격은 PageState 파생 신호(비민감)만 싣는다 —
    // 원문 DOM/텍스트 + Gateway redaction(§4) 통합은 후속.
    const context = JSON.stringify({
      url: ps.url.pattern,
      auth: ps.auth,
      structuralHash: ps.dom.structuralHash,
      landmarks: ps.dom.landmarks,
      flags: ps.flags,
    });
    const key = sha(
      `${ctx.tenantId}|${ctx.runId}|${stepId}|${a.type}|${this.cfg.promptTemplateVersion}|${a.instruction}|${ps.dom.structuralHash}`,
    );

    const responseFormat =
      a.type === "extract"
        ? { type: "json_schema" as const, schemaRef: a.output.schemaRef, schemaVersion: a.output.schemaVersion, strict: a.output.strict }
        : a.type === "act"
          ? ACTION_PLAN_SCHEMA
          : undefined;

    return {
      model: this.cfg.model,
      promptTemplateVersion: this.cfg.promptTemplateVersion,
      messages: [
        { role: "system", content: `Deterministic web automation ${a.type} planner.` },
        { role: "user", content: `${a.instruction}\n[page]${context}` },
      ],
      ...(responseFormat ? { responseFormat } : {}),
      metadata: { tenantId: ctx.tenantId, runId: ctx.runId, stepId, primitive: a.type, correlationId: ctx.runId },
      budget: this.cfg.budget,
      idempotencyKey: key,
      requestHash: key,
    } as unknown as LLMRequest;
  }

  private assertDomAction(stepId: string, action: unknown): DomAction {
    if (typeof action !== "object" || action === null || !("type" in action)) {
      throw new StagehandDomExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' action missing 'type'`);
    }
    const type = (action as { type: unknown }).type;
    if (typeof type === "string" && UTILITY_ACTIONS.has(type)) {
      throw new StagehandDomExecutorError(
        "EXECUTOR_CAPABILITY_MISMATCH",
        `step '${stepId}' action '${type}' is utility/non-browser — not a dom primitive`,
      );
    }
    if (type !== "act" && type !== "observe" && type !== "extract") {
      throw new StagehandDomExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' unknown dom action '${String(type)}'`);
    }
    const instruction = (action as { instruction?: unknown }).instruction;
    if (typeof instruction !== "string" || instruction.trim().length === 0) {
      throw new StagehandDomExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' ${type}.instruction must be a non-empty string`);
    }
    if (type === "extract") {
      const out = (action as { output?: unknown }).output;
      if (typeof out !== "object" || out === null) {
        throw new StagehandDomExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' extract.output(schema) required`);
      }
      const o = out as { schemaRef?: unknown; schemaVersion?: unknown; strict?: unknown };
      if (typeof o.schemaRef !== "string" || typeof o.schemaVersion !== "string" || typeof o.strict !== "boolean") {
        throw new StagehandDomExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' extract.output must be {schemaRef,schemaVersion,strict}`);
      }
      return { type, instruction, output: { schemaRef: o.schemaRef, schemaVersion: o.schemaVersion, strict: o.strict } };
    }
    if (type === "act") {
      const se = (action as { sideEffect?: unknown }).sideEffect;
      return { type, instruction, ...(typeof se === "string" ? { sideEffect: se as SideEffectKind } : {}) };
    }
    return { type, instruction };
  }
}
