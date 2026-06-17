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
  PlainSecret,
  RunContext,
  SecretRef,
  SideEffectKind,
  StepResult,
  StepStatus,
  VerifyResult,
} from "../../../ts/core-types";
import type {
  AuthenticatedPrincipal,
  LLMRequest,
  LLMResponse,
  SecretStoreBoundary,
} from "../../../ts/security-middleware-contract";
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
  // secretRef: 자격증명 fill 슬롯(IR act.vars 에서 ir-translate 가 스레딩). 있으면 실행기가 ctx.assetRefs 에서
  //   SecretRef 를 SecretStore 경유로 해소해 LLM 미경유로 채운다(비밀 대상은 LLM 출력이 아니라 IR 선언 — 결정형).
  // value: 비-secret 결정형 fill 값(IR act.args.value_ref → ir-translate 가 run params 에서 해소). secretRef 와 상호배타 —
  //   LLM 은 selector 만 책임지고 채울 값은 IR/params 에서 온다(LLM 추측 value 무시). 평문 비밀 아님(반려 사유 등 운영자 입력).
  | { type: "act"; instruction: string; sideEffect?: SideEffectKind; secretRef?: string; value?: string }
  | { type: "observe"; instruction: string }
  | { type: "extract"; instruction: string; output: { schemaRef: string; schemaVersion: string; strict: boolean; schema?: Record<string, unknown> } };

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
// LLM 이 셀렉터를 정하려면 원문 DOM 이 필요(PageState 파생 신호만으론 #password 등 타깃 불가). user 메시지로 실어
// Gateway redaction(§4) 경계가 redact/injection-탐지하게 한다. 토큰 예산 보호용 상한(초과분 절단).
const MAX_DOM_CHARS = 12000;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 32);
const nowIso = (): string => new Date().toISOString();

// ① ChallengeDetector 미구현 (RQ-016 — codex/D3 executor 스트림 소유; repo 릴리스 블로커 아님, open-issues.md 추적).
//   현황(은폐 금지): challenge 는 여기서 항상 failed_challenge 로만 분류되고, status='suspended' + res.challenge(ChallengeSummary)
//     를 내보내는 production 경로가 없다 — suspend 배관(인터프리터 res.challenge.type→transitions→port→resolve.<kind>)은
//     완비됐고 본 executor 가 신호를 안 줄 뿐이다(②③ 참조).
//   미정: ChallengeSummary.type 을 captcha|mfa 로 판정할 신호(dom|network|screenshot|vlm)가 미정 — 라이브 provider 행동
//     의존이라 추측 구현은 오라벨링 위험. 도입 시 captcha|mfa 감지→status='suspended' + challenge={type,detectedBy,confidence}
//     반환하면 mfa 까지 무수정으로 흐른다(+ coordinator→driveSuspend production 재배선).
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
    // 자격증명 fill(secretRef) 경계 — 둘 다 주입돼야 fill 의 valueRef 를 해소한다(미주입 시 loud throw, 조용한 빈 fill 금지).
    private readonly secrets?: SecretStoreBoundary,
    private readonly executorPrincipal?: AuthenticatedPrincipal,
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
    // read-only(observe/extract)는 게이트웨이 전용 — CDP 세션(forLease) 미경유(architecture: extract 는 게이트웨이 호출).
    //   원문 DOM 동봉은 mutation 을 적용하는 act 경로에만(executeAct, 이미 forLease 보유). dom-executor-factory 계약.
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
    // 표준 노드 출력 row_count(ir-expression §2): extract 출력 봉투 {rows:[...]}의 rows 길이. rows 부재 시 미산출(미투영).
    const rows =
      a.type === "extract" && res.parsedJson !== null && typeof res.parsedJson === "object"
        ? (res.parsedJson as { rows?: unknown }).rows
        : undefined;
    const rowCount = Array.isArray(rows) ? rows.length : undefined;
    return {
      stepId,
      action: a.type,
      status: "success",
      output: { outputRef: res.outputRef, finishReason: res.finishReason, ...(rowCount !== undefined ? { rowCount } : {}) },
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

    let fromLlm = false;
    if (!plan) {
      // miss/bypass → LLM 으로 plan 산출(Gateway 경유, action_plan 스키마 strict). 원문 DOM 동봉(셀렉터 타깃팅).
      const req = this.buildRequest(stepId, a, ctx, await this.snapshotDom(session));
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
      fromLlm = true;
    }

    // 자격증명 fill: secretRef 선언 시 plan 의 secret 대상을 IR 선언으로 결정형 고정(LLM 출력 value 무시).
    //   plan = {fill, selector, valueRef} — value(LLM 추측)는 버리고 ref-only 로 만들어 캐시·output 에 평문이 안 실린다.
    //   LLM 은 selector 만 책임진다. fill 이 아니면 loud 오류(자격증명 act 는 fill 이어야 함, 조용한 무시 금지).
    if (a.secretRef !== undefined) {
      if (plan.operation !== "fill") {
        throw new StagehandDomExecutorError(
          "IR_SCHEMA_INVALID",
          `step '${stepId}' credential act(secretRef) must yield a 'fill' plan, got '${plan.operation}'`,
        );
      }
      plan = { operation: "fill", selector: plan.selector, valueRef: a.secretRef };
    } else if (a.value !== undefined) {
      // 비-secret 결정형 fill: 채울 값을 IR/params 선언으로 고정(LLM 출력 value 무시). secretRef 와 상호배타.
      //   LLM 은 selector 만 책임진다. fill 이 아니면 loud(조용한 무시 금지). 캐시 hit 에도 현재 run 의 a.value 로
      //   재고정(params 가변 — selector 만 캐시 재사용; stale value 미사용). value 는 비밀 아님(평문 경로 허용).
      if (plan.operation !== "fill") {
        throw new StagehandDomExecutorError(
          "IR_SCHEMA_INVALID",
          `step '${stepId}' value act must yield a 'fill' plan, got '${plan.operation}'`,
        );
      }
      plan = { operation: "fill", selector: plan.selector, value: a.value };
    }

    // miss(LLM 해석)만 캐시에 저장 — 저장 plan 은 override 반영된 ref-bearing plan(평문 미저장).
    if (fromLlm && this.cache) await this.cache.put(cacheKey, plan);

    // 적용: CDP 로 실제 mutation(click/fill/select). 적용 실패는 런타임 예외로 전파(분류는 상위).
    await this.applyPlan(plan, session, ctx);

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

  private async applyPlan(plan: ActionPlan, session: CdpSession, ctx: RunContext): Promise<void> {
    switch (plan.operation) {
      case "click":
        await session.click(plan.selector);
        return;
      case "fill": {
        if (plan.valueRef !== undefined) {
          // 자격증명 fill: SecretStore 경유 평문 해소 → CDP fill 에만 흘린다. plain 은 반환/로그/output 에 절대 미흐름(주통제).
          const plain = await this.resolveSecretForFill(plan.valueRef, ctx);
          await session.fill(plan.selector, plain);
          return;
        }
        if (typeof plan.value !== "string") {
          throw new StagehandDomExecutorError("IR_SCHEMA_INVALID", `fill plan for '${plan.selector}' has neither value nor valueRef`);
        }
        await session.fill(plan.selector, plan.value);
        return;
      }
      case "select":
        await session.selectOption(plan.selector, plan.value);
        return;
    }
  }

  /**
   * valueRef(에셋 키) → ctx.assetRefs[key](SecretRef) → SecretStoreBoundary.resolveAuthorized(purpose:'executor') → PlainSecret.
   * 반환 PlainSecret 의 수명은 호출측 applyPlan 의 지역변수(→ session.fill) 하나뿐 — 여기서 직렬화/로그/반환 금지.
   * 가드(loud, 조용한 빈 fill 금지): 에셋 키 미바인딩 / 경계·principal 미주입 → throw. (런타임엔 SecretRef vs 평문 판별 불가 —
   *   브랜드는 컴파일타임 전용 소거형. 비밀/에셋 구분은 assetRefs 주입 지점(run-loop)이 권위; resolveAuthorized 가 최종 권위.)
   */
  private async resolveSecretForFill(valueRef: string, ctx: RunContext): Promise<PlainSecret> {
    const ref = ctx.assetRefs[valueRef];
    if (ref === undefined) {
      throw new StagehandDomExecutorError("IR_SCHEMA_INVALID", `credential fill: asset key '${valueRef}' not bound in ctx.assetRefs`);
    }
    if (this.secrets === undefined || this.executorPrincipal === undefined) {
      throw new StagehandDomExecutorError("IR_SCHEMA_INVALID", `credential fill: SecretStoreBoundary/principal not injected (asset key '${valueRef}')`);
    }
    return this.secrets.resolveAuthorized({
      principal: this.executorPrincipal,
      ref: ref as SecretRef,
      purpose: "executor",
    });
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

  /** 원문 DOM 스냅샷(best-effort, 절단). 실패 시 undefined — 신호만으로 진행(loud 아님; 셀렉터 품질 저하 가능). */
  private async snapshotDom(session: CdpSession): Promise<string | undefined> {
    try {
      const html = await session.evaluate<string>(
        "document.body ? document.body.outerHTML : document.documentElement.outerHTML",
      );
      return typeof html === "string" && html.length > 0 ? html.slice(0, MAX_DOM_CHARS) : undefined;
    } catch {
      return undefined;
    }
  }

  private buildRequest(stepId: string, a: DomAction, ctx: RunContext, domSnapshot?: string): LLMRequest {
    const ps = ctx.pageState;
    // 페이지 컨텍스트는 user 역할로만(신뢰영역 분리, §2). PageState 파생 신호 + 원문 DOM(절단) — Gateway redaction(§4)
    // 경계가 user 메시지를 redact/injection-탐지한다. DOM 은 셀렉터 타깃팅에 필요(act/extract).
    const context = JSON.stringify({
      url: ps.url.pattern,
      auth: ps.auth,
      structuralHash: ps.dom.structuralHash,
      landmarks: ps.dom.landmarks,
      flags: ps.flags,
      ...(domSnapshot !== undefined ? { dom: domSnapshot } : {}),
    });
    const key = sha(
      `${ctx.tenantId}|${ctx.runId}|${stepId}|${a.type}|${this.cfg.promptTemplateVersion}|${a.instruction}|${ps.dom.structuralHash}`,
    );

    const responseFormat =
      a.type === "extract"
        ? { type: "json_schema" as const, schemaRef: a.output.schemaRef, schemaVersion: a.output.schemaVersion, strict: a.output.strict, ...(a.output.schema !== undefined ? { schema: a.output.schema } : {}) }
        : a.type === "act"
          ? ACTION_PLAN_SCHEMA
          : undefined;

    return {
      model: this.cfg.model,
      promptTemplateVersion: this.cfg.promptTemplateVersion,
      messages: [
        // system 은 redaction 비대상(Gateway 는 user 메시지만 redact) — JSON 지시를 여기 둬 native json_object 모드의
        // "messages 에 'json' 포함" 요구를 충족하고(user 메시지가 redact 돼도), 플래너 출력 형식을 고정한다.
        { role: "system", content: `Deterministic web automation ${a.type} planner. Respond with a single minified JSON object only.` },
        { role: "user", content: `${a.instruction}\n[page]${context}` },
      ],
      ...(responseFormat ? { responseFormat } : {}),
      metadata: { tenantId: ctx.tenantId, runId: ctx.runId, stepId, attempt: ctx.attempt, primitive: a.type, correlationId: ctx.runId },
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
      const o = out as { schemaRef?: unknown; schemaVersion?: unknown; strict?: unknown; schema?: unknown };
      if (typeof o.schemaRef !== "string" || typeof o.schemaVersion !== "string" || typeof o.strict !== "boolean") {
        throw new StagehandDomExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' extract.output must be {schemaRef,schemaVersion,strict}`);
      }
      const schema = typeof o.schema === "object" && o.schema !== null ? (o.schema as Record<string, unknown>) : undefined;
      return { type, instruction, output: { schemaRef: o.schemaRef, schemaVersion: o.schemaVersion, strict: o.strict, ...(schema !== undefined ? { schema } : {}) } };
    }
    if (type === "act") {
      const se = (action as { sideEffect?: unknown }).sideEffect;
      const sr = (action as { secretRef?: unknown }).secretRef;
      const val = (action as { value?: unknown }).value;
      return {
        type,
        instruction,
        ...(typeof se === "string" ? { sideEffect: se as SideEffectKind } : {}),
        ...(typeof sr === "string" && sr.length > 0 ? { secretRef: sr } : {}),
        ...(typeof val === "string" ? { value: val } : {}),
      };
    }
    return { type, instruction };
  }
}
