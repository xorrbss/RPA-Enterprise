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

import type {
  ArtifactRef,
  ExecutorPlugin,
  PlainSecret,
  RunContext,
  SecretRef,
  SideEffectKind,
  StepResult,
  VerifyResult,
} from "../../../ts/core-types";
import type {
  AuthenticatedPrincipal,
  LLMRequest,
  LLMResponse,
  SecretStoreBoundary,
} from "../../../ts/security-middleware-contract";
import { GatewayError, type GatewayArtifactSink } from "../gateway/llm-gateway";
import { parseActionPlan, type ActionPlan, type ActionPlanCache, type ActionPlanCacheKey } from "./action-plan-cache";
import type { CdpSession, CdpSessionProvider } from "./cdp-session";
import { pageStateRef } from "./page-state-resolver";
import { StagehandDomExecutorError, type DomExecutorErrorCode } from "./dom-executor-error";
import {
  humanAssistChallenge,
  nowIso,
  stagehandCallIdsFromError,
  stagehandCallIdsFromResponse,
} from "./stagehand-dom-executor-support";
import {
  assertDomAction,
  buildRequest,
  detectDomChallenge,
  ensureNetworkJsonCapture,
  failResult,
  snapshotDom,
  suspendForChallenge,
  waitForSelectorState,
} from "./stagehand-dom-executor-dom";
import { applyRowAnchor, type ExtractRowAnchor } from "./extract-row-anchor";
import { SPAN, withSpan, spanCommonFromContext } from "../observability/telemetry";

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
  // valueRef: 비-secret 결정형 fill 의 INTENT 마커(IR act.args.value_ref = run params 키). 선언되면 실행기가 selector
  //   만 LLM 에 맡기고 value(해소된 평문)로 채운다(LLM 추측 value 무시). value 미해소면 LLM/캐시 값 무음 fill 거부 → loud.
  //   value: valueRef 가 run params 에서 해소된 평문(미해소면 부재). secretRef 와 상호배타. 평문 비밀 아님(반려 사유 등).
  // clickSelector: 결정형 클릭 타깃(IR act.args.click_selector). 선언되면 실행기가 LLM 을 **전혀** 경유하지 않고 그 셀렉터를
  //   settle 폴링 후 클릭한다(LLM 의 셀렉터 환각 차단 — 예 하이웍스 결재 버튼은 class/id 없는 onclick 속성 매칭). value/secret 와
  //   상호배타(클릭 전용). 미존재면 loud(조용한 false 금지).
  // assertAbsent: 결정형 부재 단언(IR act.args.assert_absent). 셀렉터가 사라질 때까지 settle 폴링 — 비가역 커밋의 효과
  //   witness(예 확인 클릭 후 결재 버튼 소멸=실제 커밋). deadline 까지 잔존 시 loud. click/fill 과 상호배타(검증 전용).
  | { type: "act"; instruction: string; sideEffect?: SideEffectKind; secretRef?: string; valueRef?: string; value?: string; clickSelector?: string; assertAbsent?: string }
  | { type: "observe"; instruction: string }
  | { type: "extract"; instruction: string; output: { schemaRef: string; schemaVersion: string; strict: boolean; schema?: Record<string, unknown> }; rowAnchor?: ExtractRowAnchor };

// 결정형 행별 필드 추출(LLM 속성 환각 차단)은 extract-row-anchor.ts(의미 단위 분리, CLAUDE.md #7) — 타입/에러 재export(호환).
export { StagehandDomExecutorError, type DomExecutorErrorCode };
export type { ExtractRowAnchor };

export interface StagehandDomExecutorConfig {
  model: string;
  promptTemplateVersion: string;
  budget: LLMRequest["budget"];
  // ActionPlanCache 키 스코프(run-scoped — 오케스트레이터가 run 단위로 주입). url_pattern/structuralHash 는 ctx.pageState 에서.
  scenarioVersionId: string;
  browserIdentityVersion: number;
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
    // extract.rowAnchor 로 결정형 강화한 행을 인박스용 typed artifact(type=approval_inbox 등 sink cfg)로 영속하는 옵션 sink.
    // prod/dev composition root가 동일 sink seam을 주입하면 강화된 StepResult.extracted 본문도 별도 typed artifact로
    // 영속한다. 미주입 시에는 기존 gateway outputRef(강화 전 LLM 원문)만 artifacts[0]에 남는다.
    private readonly extractArtifactSink?: GatewayArtifactSink,
  ) {}

  capabilities(): { dom: boolean; vision: boolean; utility: boolean } {
    return { dom: true, vision: false, utility: false };
  }

  async execute(stepId: string, action: unknown, ctx: RunContext): Promise<StepResult> {
    if (ctx.abortSignal.aborted) {
      throw new StagehandDomExecutorError("RUN_ABORTED", `step '${stepId}' aborted before execute`);
    }
    const a = assertDomAction(stepId, action);
    const challenge = humanAssistChallenge(ctx.pageState.challenge);
    if (challenge !== undefined) {
      return suspendForChallenge(stepId, a.type, ctx, challenge);
    }
    return a.type === "act" ? this.executeAct(stepId, a, ctx) : this.executeReadOnly(stepId, a, ctx);
  }

  /** observe/extract — read-only LLM 호출(mutation 없음). extract는 같은 lease의 DOM을 읽어 실제 데이터 추출 근거로 동봉한다. */
  private async executeReadOnly(
    stepId: string,
    a: Extract<DomAction, { type: "observe" | "extract" }>,
    ctx: RunContext,
  ): Promise<StepResult> {
    const before = pageStateRef(ctx.pageState);
    const startedAt = nowIso();
    // observe는 PageState 파생 신호만으로 충분하지만, extract는 실데이터를 뽑으려면 현재 DOM 원문이 필요하다.
    // 같은 lease의 CDP 세션에서 읽기 전용 snapshot만 수행하고 mutation은 하지 않는다.
    const session = this.sessions.forLease(ctx.leaseId);
    if (a.type === "extract") await ensureNetworkJsonCapture(session);
    const domSnapshot = a.type === "extract" ? await snapshotDom(session) : undefined;
    const challenge = await detectDomChallenge(session);
    if (challenge !== undefined) {
      return suspendForChallenge(stepId, a.type, ctx, challenge);
    }
    const req = buildRequest(this.cfg, stepId, a, ctx, domSnapshot);
    let callIds: string[] = [];

    let res: LLMResponse;
    try {
      res = await this.gateway.call(req, ctx.abortSignal);
    } catch (e) {
      if (e instanceof GatewayError) {
        callIds = stagehandCallIdsFromError(e);
        return failResult(stepId, a.type, before, startedAt, e.code, callIds);
      }
      throw e; // GatewayAbortedError 등 제어 신호 전파.
    }
    callIds = stagehandCallIdsFromResponse(res);

    const endedAt = nowIso();
    // extract.rowAnchor: LLM 추출 후 DOM 에서 결정형으로 특정 필드(doc_ref 등)를 권위 세팅(LLM 속성 환각 차단). 강화된
    // 봉투를 StepResult.extracted 로 쓰고, sink 주입 시 인박스용 typed artifact 로도 영속한다. rowAnchor 미선언 시 기존 경로.
    let extracted: unknown = a.type === "extract" ? res.parsedJson : undefined;
    const artifacts: ArtifactRef[] = [res.outputRef];
    if (a.type === "extract" && a.rowAnchor !== undefined && res.parsedJson !== null && typeof res.parsedJson === "object") {
      extracted = await applyRowAnchor(stepId, a.rowAnchor, res.parsedJson, this.sessions.forLease(ctx.leaseId));
      if (this.extractArtifactSink !== undefined) {
        // meta 브랜드 타입(TenantId/RunId/StepId)은 buildRequest 와 동일 캐스트 패턴 — RunContext 는 평문 string 으로 보유.
        const meta = { tenantId: ctx.tenantId, runId: ctx.runId, stepId, attempt: ctx.attempt } as unknown as Parameters<GatewayArtifactSink["put"]>[1];
        artifacts.push(await this.extractArtifactSink.put(JSON.stringify(extracted), meta));
      }
    }
    // 표준 노드 출력 row_count(ir-expression §2): extract 출력 봉투 {rows:[...]}의 rows 길이. rows 부재 시 미산출(미투영).
    const rows = extracted !== null && typeof extracted === "object" ? (extracted as { rows?: unknown }).rows : undefined;
    const rowCount = Array.isArray(rows) ? rows.length : undefined;
    return {
      stepId,
      action: a.type,
      status: "success",
      output: { outputRef: res.outputRef, finishReason: res.finishReason, ...(rowCount !== undefined ? { rowCount } : {}) },
      extracted,
      pageStateBefore: before,
      pageStateAfter: before, // 다음 observe 노드가 PageState 갱신(UtilityExecutor 와 동일 패턴).
      artifacts,
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
    const preChallenge = await detectDomChallenge(session);
    if (preChallenge !== undefined) {
      return suspendForChallenge(stepId, "act", ctx, preChallenge);
    }
    // 결정형 클릭(click_selector): LLM 을 전혀 경유하지 않고 IR 선언 셀렉터를 settle 후 클릭(셀렉터 환각 차단).
    // value/secret 와 상호배타(ir-translate 가 강제). 미존재 시 loud(조용한 false 금지).
    if (a.clickSelector !== undefined) {
      return this.executeDeterministicClick(stepId, a.clickSelector, a.sideEffect, ctx, session, before, startedAt);
    }
    // 결정형 부재 단언(assert_absent): 셀렉터 소멸까지 settle — 비가역 커밋 효과 witness(잔존 시 loud).
    if (a.assertAbsent !== undefined) {
      return this.executeAssertAbsent(stepId, a.assertAbsent, a.sideEffect, ctx, session, before, startedAt);
    }
    await ensureNetworkJsonCapture(session);
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

    // P0b self-heal 재시도(ctx.selfHealRetry): 인터프리터가 verify 실패로 같은 노드를 재실행할 때 직전 의심 plan 을 강등.
    //   markSuspect(active→suspect) → 아래 cache.get 이 miss → LLM 재해소. best-effort(강등 실패해도 재해소는 진행).
    if (this.cache && ctx.selfHealRetry === true) {
      await this.cache.markSuspect(cacheKey).catch(() => undefined);
    }

    let plan: ActionPlan | undefined;
    let cacheMode: StepResult["cache"]["mode"] = "bypass";
    let callIds: string[] = [];

    if (this.cache) {
      const cache = this.cache;
      plan = await withSpan(SPAN.actionPlanCacheLookup, spanCommonFromContext(ctx), {}, async (span) => {
        const found = await cache.get(cacheKey);
        // §E 필수 속성 cache.mode(hit/miss) — span 에 기록(impl-contracts-bundle.md §E action_plan_cache.lookup).
        cacheMode = found ? "hit" : "miss";
        span.setAttribute("cache.mode", cacheMode);
        return found;
      });
    }

    let fromLlm = false;
    if (!plan) {
      // miss/bypass → LLM 으로 plan 산출(Gateway 경유, action_plan 스키마 strict). 원문 DOM 동봉(셀렉터 타깃팅).
      const req = buildRequest(this.cfg, stepId, a, ctx, await snapshotDom(session));
      let res: LLMResponse;
      try {
        res = await this.gateway.call(req, ctx.abortSignal);
      } catch (e) {
        if (e instanceof GatewayError) {
          callIds = stagehandCallIdsFromError(e);
          return failResult(stepId, "act", before, startedAt, e.code, callIds);
        }
        throw e;
      }
      callIds = stagehandCallIdsFromResponse(res);
      const parsed = parseActionPlan(res.parsedJson);
      if (!parsed) return failResult(stepId, "act", before, startedAt, "LLM_MALFORMED_OUTPUT", callIds);
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
    } else if (a.valueRef !== undefined) {
      // 비-secret 결정형 fill(intent=valueRef): 채울 값을 IR/params 의 a.value 로 고정(LLM 추측 value 무시).
      //   LLM 은 selector 만 책임진다. fill 이 아니면 loud(조용한 무시 금지). value 미해소(run params 부재)면 LLM/캐시 값으로
      //   무음 fill 하지 않고 loud throw — 결정형 슬롯 보장("조용한 false 금지", break-it finding). 캐시 hit 에도 현재 run 의
      //   a.value 로 재고정(params 가변; selector 만 캐시 재사용). value 는 비밀 아님(평문 경로 허용).
      if (plan.operation !== "fill") {
        throw new StagehandDomExecutorError(
          "IR_SCHEMA_INVALID",
          `step '${stepId}' value act(valueRef='${a.valueRef}') must yield a 'fill' plan, got '${plan.operation}'`,
        );
      }
      if (a.value === undefined) {
        throw new StagehandDomExecutorError(
          "IR_SCHEMA_INVALID",
          `step '${stepId}' value act(valueRef='${a.valueRef}') has no resolved value from run params — refusing LLM/cache value (deterministic fill)`,
        );
      }
      plan = { operation: "fill", selector: plan.selector, value: a.value };
    }

    // miss(LLM 해석)만 캐시에 저장. 평문 미저장: secretRef=ref-bearing({fill,selector,valueRef}), valueRef(비-secret)=
    //   selector-only(value 스트립 — 매 실행 override 가 현재 run value 로 재고정하므로 캐시 value 불요; 평문 영속·stale 재생 차단).
    if (fromLlm && this.cache) {
      const cachePlan: ActionPlan = a.valueRef !== undefined ? { operation: "fill", selector: plan.selector } : plan;
      await this.cache.put(cacheKey, cachePlan);
    }

    // 적용: CDP 로 실제 mutation(click/fill/select). 적용 실패는 런타임 예외로 전파(분류는 상위).
    // P0a+ self-heal: 캐시된 plan(hit, 또는 이번 run 에 put 된 miss) 적용이 실패하면 드리프트 의심 →
    //   markSuspect 로 강등(active→suspect)해 다음 run 이 같은 깨진 셀렉터를 재생하지 않고 재해석하게 한다
    //   (§7.2 failed plan never active, 조용한 false 금지). 강등은 best-effort — 원 적용 예외를 보존해 상위 분류로 전파.
    try {
      await this.applyPlan(plan, session, ctx);
    } catch (applyError) {
      if (this.cache) {
        await this.cache.markSuspect(cacheKey).catch(() => undefined);
      }
      throw applyError;
    }
    const postChallenge = await detectDomChallenge(session);
    if (postChallenge !== undefined) {
      return suspendForChallenge(stepId, "act", ctx, postChallenge, {
        stagehandCallIds: callIds,
        cache: { mode: cacheMode },
        sideEffect: { kind: a.sideEffect ?? "update", committed: true },
      });
    }

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
      cache: { mode: cacheMode },
      // act 는 페이지를 바꾼다 — sideEffect.kind 는 시나리오(IR)가 선언(submit/login 등); 미지정 시 update.
      sideEffect: { kind: a.sideEffect ?? "update", committed: true },
      timings: { startedAt, endedAt, durationMs: Date.parse(endedAt) - Date.parse(startedAt) },
    };
  }

  /**
   * 결정형 클릭 — IR 선언 셀렉터(click_selector)를 settle 폴링 후 CDP 클릭. LLM 미경유(셀렉터 환각 차단). 무거운 SPA 상세/
   * async 모달(예 하이웍스 결재 레이어)을 위해 존재 폴링 후 클릭한다. 비가역 결재 안전:
   *  - settle 직후~클릭 직전 abort 재확인(TOCTOU — 취소된 run 이 비가역 커밋을 발사하지 않게).
   *  - radio/checkbox 타깃이면 클릭 후 checked read-back(무효 클릭/페이지 JS 재설정으로 의도와 다른 값 커밋 방지).
   *  - click 자체는 Playwright actionability(visible/enabled/stable)를 검사해 비액셔너블 시 throw(=loud).
   */
  private async executeDeterministicClick(
    stepId: string,
    selector: string,
    sideEffect: SideEffectKind | undefined,
    ctx: RunContext,
    session: CdpSession,
    before: ReturnType<typeof pageStateRef>,
    startedAt: string,
  ): Promise<StepResult> {
    await waitForSelectorState(session, selector, stepId, ctx, true);
    if (ctx.abortSignal.aborted) {
      throw new StagehandDomExecutorError("RUN_ABORTED", `step '${stepId}' aborted before deterministic click '${selector}'`);
    }
    await session.click(selector);
    // radio/checkbox 클릭 후 실제 선택(checked) read-back — 무효 클릭이면 loud(비가역 커밋 전 의도된 값 보장).
    const checkState = await session.evaluate<string>(
      `(function(){var e=document.querySelector(${JSON.stringify(selector)});if(!e||(e.type!=="radio"&&e.type!=="checkbox"))return "na";return e.checked?"checked":"unchecked";})()`,
    );
    if (checkState === "unchecked") {
      throw new StagehandDomExecutorError(
        "IR_SCHEMA_INVALID",
        `step '${stepId}' click_selector '${selector}'(radio/checkbox) 클릭 후 미선택(checked=false) — 무효 클릭, 조용한 false 금지`,
      );
    }
    const postChallenge = await detectDomChallenge(session);
    if (postChallenge !== undefined) {
      return suspendForChallenge(stepId, "act", ctx, postChallenge, {
        sideEffect: { kind: sideEffect ?? "update", committed: true },
      });
    }
    const endedAt = nowIso();
    return {
      stepId,
      action: "act",
      status: "success",
      output: { plan: { operation: "click", selector } },
      pageStateBefore: before,
      pageStateAfter: before,
      artifacts: [],
      stagehandCallIds: [],
      cache: { mode: "bypass" },
      sideEffect: { kind: sideEffect ?? "update", committed: true },
      timings: { startedAt, endedAt, durationMs: Date.parse(endedAt) - Date.parse(startedAt) },
    };
  }

  /**
   * 결정형 부재 단언(assert_absent) — 셀렉터가 사라질 때까지 settle 폴링. 비가역 커밋의 **효과 witness**(예 확인 클릭 후
   * 결재 버튼 소멸 = 실제 커밋됨)로 쓴다. deadline 까지 잔존하면 loud(효과 미반영=커밋 실패를 success 로 은폐 금지).
   */
  private async executeAssertAbsent(
    stepId: string,
    selector: string,
    sideEffect: SideEffectKind | undefined,
    ctx: RunContext,
    session: CdpSession,
    before: ReturnType<typeof pageStateRef>,
    startedAt: string,
  ): Promise<StepResult> {
    await waitForSelectorState(session, selector, stepId, ctx, false);
    const endedAt = nowIso();
    return {
      stepId,
      action: "act",
      status: "success",
      output: { plan: { operation: "assert_absent", selector } },
      pageStateBefore: before,
      pageStateAfter: before,
      artifacts: [],
      stagehandCallIds: [],
      cache: { mode: "bypass" },
      sideEffect: { kind: sideEffect ?? "read_only", committed: true },
      timings: { startedAt, endedAt, durationMs: Date.parse(endedAt) - Date.parse(startedAt) },
    };
  }

  /**
   * 셀렉터 존재(wantPresent=true)/부재(false) settle 폴링. 매 폴 abort 재확인, deadline 초과 시 loud throw(조용한 미클릭/
   * 미검증 금지). 존재 판정은 querySelector!==null(액셔너빌리티는 click 이 별도 검사); 부재는 ===null.
   */
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

}
