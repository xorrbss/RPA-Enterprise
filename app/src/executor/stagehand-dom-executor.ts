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
  ArtifactRef,
  ChallengeSummary,
  ExceptionClass,
  ExecutorPlugin,
  PlainSecret,
  RedactedString,
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
  PromptInspectionTextRun,
  SecretStoreBoundary,
} from "../../../ts/security-middleware-contract";
import { GatewayError, type GatewayArtifactSink } from "../gateway/llm-gateway";
import { parseActionPlan, type ActionPlan, type ActionPlanCache, type ActionPlanCacheKey } from "./action-plan-cache";
import type { CdpSession, CdpSessionProvider } from "./cdp-session";
import { pageStateRef } from "./page-state-resolver";
import { normalizePageSnapshot } from "./page-snapshot";
import { StagehandDomExecutorError, type DomExecutorErrorCode } from "./dom-executor-error";
import { applyRowAnchor, coerceRowAnchor, type ExtractRowAnchor } from "./extract-row-anchor";
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

const UTILITY_ACTIONS = new Set(["navigate", "download", "upload", "api_call", "file", "shell"]);
const ACTION_PLAN_SCHEMA = { type: "json_schema", schemaRef: "action_plan", schemaVersion: "1", strict: true } as const;
// 결정형 클릭(click_selector) settle — 무거운 SPA 상세/async 모달 렌더 대응. 미존재 시 deadline 까지 폴 후 loud(은폐 금지).
// 동적 읽기(매 호출): 테스트가 DET_CLICK_SETTLE_MS 로 단축할 수 있게 함(모듈 로드 시점 고정 회피).
const clickSettleMs = (): number => Number(process.env.DET_CLICK_SETTLE_MS ?? 15000);
const CLICK_POLL_MS = 500;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
// LLM 이 셀렉터를 정하려면 원문 DOM 이 필요(PageState 파생 신호만으론 #password 등 타깃 불가). user 메시지로 실어
// Gateway redaction(§4) 경계가 redact/injection-탐지하게 한다. 토큰 예산 보호용 상한(초과분 절단).
const NETWORK_JSON_CAPTURE_SCRIPT = `(() => {
  const w = window;
  if (w.__RPA_NETWORK_CAPTURE_INSTALLED__ === true) return { installed: true, already: true };
  w.__RPA_NETWORK_CAPTURE_INSTALLED__ = true;
  const maxEntries = 20;
  const maxBodyChars = 120000;
  const ensureStore = () => {
    if (!Array.isArray(w.__RPA_NETWORK_JSON__)) w.__RPA_NETWORK_JSON__ = [];
    return w.__RPA_NETWORK_JSON__;
  };
  const looksJson = (text) => {
    const s = String(text || "").trim();
    return s.startsWith("{") || s.startsWith("[");
  };
  const pushJson = (source, url, status, body) => {
    try {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      if (!looksJson(text)) return;
      const store = ensureStore();
      store.push({
        source,
        url: String(url || ""),
        status: typeof status === "number" ? status : undefined,
        capturedAt: new Date().toISOString(),
        body: text.length > maxBodyChars ? text.slice(0, maxBodyChars) : text
      });
      if (store.length > maxEntries) store.splice(0, store.length - maxEntries);
      w.__RPA_RECENT_JSON__ = store;
      w.__rpaNetworkJson = store;
    } catch (_) {}
  };
  const shouldCapture = (contentType, text) => {
    const ct = String(contentType || "").toLowerCase();
    return ct.includes("json") || looksJson(text);
  };
  if (typeof w.fetch === "function" && w.__RPA_ORIGINAL_FETCH__ === undefined) {
    const originalFetch = w.fetch.bind(w);
    w.__RPA_ORIGINAL_FETCH__ = originalFetch;
    w.fetch = async (...args) => {
      const response = await originalFetch(...args);
      try {
        const clone = response.clone();
        const url = response.url || (args[0] && (typeof args[0] === "string" ? args[0] : args[0].url));
        clone.text().then((text) => {
          const contentType = clone.headers && clone.headers.get ? clone.headers.get("content-type") : "";
          if (shouldCapture(contentType, text)) pushJson("fetch", url, response.status, text);
        }).catch(() => {});
      } catch (_) {}
      return response;
    };
  }
  if (typeof w.XMLHttpRequest === "function" && w.XMLHttpRequest.prototype.__RPA_CAPTURE_PATCHED__ !== true) {
    const proto = w.XMLHttpRequest.prototype;
    const originalOpen = proto.open;
    const originalSend = proto.send;
    proto.__RPA_CAPTURE_PATCHED__ = true;
    proto.open = function(method, url, ...rest) {
      this.__rpaRequestUrl = url;
      return originalOpen.call(this, method, url, ...rest);
    };
    proto.send = function(...args) {
      try {
        this.addEventListener("loadend", () => {
          try {
            const text = typeof this.responseText === "string" ? this.responseText : "";
            const contentType = this.getResponseHeader ? this.getResponseHeader("content-type") : "";
            if (shouldCapture(contentType, text)) pushJson("xhr", this.__rpaRequestUrl || this.responseURL, this.status, text);
          } catch (_) {}
        });
      } catch (_) {}
      return originalSend.apply(this, args);
    };
  }
  ensureStore();
  return { installed: true, already: false };
})()`;
const CHALLENGE_DETECTION_SCRIPT = `(() => {
  const marker = "rpa_challenge_detector_v1";
  const visible = (el) => {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (el instanceof HTMLInputElement && el.type === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return (rect.width > 0 && rect.height > 0) || el.getClientRects().length > 0;
  };
  const visibleMatches = (selector) => Array.from(document.querySelectorAll(selector)).some(visible);
  const visibleInputs = () => Array.from(document.querySelectorAll("input, textarea")).filter(visible);
  const text = ((document.body && document.body.innerText) || "").replace(/\\s+/g, " ").trim();
  const attrText = (el) => [
    el.id,
    el.getAttribute("name"),
    el.getAttribute("autocomplete"),
    el.getAttribute("placeholder"),
    el.getAttribute("aria-label"),
    el.getAttribute("title"),
  ].filter(Boolean).join(" ");
  const iframeChallenge = Array.from(document.querySelectorAll("iframe")).some((el) => {
    if (!visible(el)) return false;
    const s = [
      el.getAttribute("src"),
      el.getAttribute("title"),
      el.getAttribute("name"),
      el.id,
      el.className,
    ].filter(Boolean).join(" ");
    return /recaptcha|hcaptcha|captcha/i.test(s);
  });
  const mfaInput = visibleInputs().some((el) => /one-time-code|otp|mfa|2fa|two-factor|verification|인증번호|2단계|보안코드/i.test(attrText(el)));
  const captchaWidget = visibleMatches(".g-recaptcha, .h-captcha, [data-sitekey], [data-captcha], [id*='captcha'], [class*='captcha'], [id*='Captcha'], [class*='Captcha']");
  if (mfaInput || /\\b(otp|mfa|2fa)\\b|one[- ]?time code|two[- ]?factor|인증번호|2단계 인증|보안코드/i.test(text)) {
    return { type: "mfa", detectedBy: "dom", confidence: 0.93, marker };
  }
  if (captchaWidget || iframeChallenge || /captcha challenge|complete (the )?captcha|로봇이 아닙니다|자동 입력 방지|보안문자/i.test(text)) {
    return { type: "captcha", detectedBy: "dom", confidence: 0.93, marker };
  }
  return null;
})()`;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 32);
const nowIso = (): string => new Date().toISOString();
type HumanAssistChallenge = ChallengeSummary & { type: "captcha" | "mfa" };
type NormalizedDomSnapshot = { text?: string; textRuns?: readonly PromptInspectionTextRun[] };

function humanAssistChallenge(challenge: ChallengeSummary | undefined): HumanAssistChallenge | undefined {
  if (challenge?.type === "captcha" || challenge?.type === "mfa") return challenge as HumanAssistChallenge;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHumanAssistChallenge(value: unknown): HumanAssistChallenge | undefined {
  if (!isRecord(value)) return undefined;
  const type = value.type;
  const detectedBy = value.detectedBy;
  const confidence = value.confidence;
  if ((type !== "captcha" && type !== "mfa") || detectedBy !== "dom" || typeof confidence !== "number") {
    return undefined;
  }
  return {
    type,
    detectedBy,
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

// ChallengeDetector v1: captcha/mfa only. Those are the only challenge classes
// the interpreter/driver can route to human assist without guessing policy.
// block_page/rate_limit/login_loop/access_denied/session_expired remain explicit
// failure/branch signals until their resolution policies exist.
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

function stagehandCallIdsFromResponse(response: LLMResponse): string[] {
  return typeof response.stagehandCallId === "string" && response.stagehandCallId.trim().length > 0
    ? [response.stagehandCallId]
    : [];
}

function stagehandCallIdsFromError(error: GatewayError): string[] {
  return typeof error.stagehandCallId === "string" && error.stagehandCallId.trim().length > 0
    ? [error.stagehandCallId]
    : [];
}

function promptInspectionTextRuns(snapshot: unknown): readonly PromptInspectionTextRun[] {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.textRuns)) return [];
  const runs: PromptInspectionTextRun[] = [];
  for (const item of snapshot.textRuns) {
    if (!isRecord(item)) continue;
    const text = item.text;
    const visibility = item.visibility;
    const source = item.source;
    if (typeof text !== "string" || text.trim().length === 0) continue;
    if (visibility !== "hidden" && visibility !== "offscreen" && visibility !== "zero_opacity") continue;
    if (source !== "dom" && source !== "network" && source !== "screenshot" && source !== "artifact") continue;
    runs.push({ text: text.slice(0, 2000) as RedactedString, visibility, source });
    if (runs.length >= 120) break;
  }
  return runs;
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
    const a = this.assertDomAction(stepId, action);
    const challenge = humanAssistChallenge(ctx.pageState.challenge);
    if (challenge !== undefined) {
      return this.suspendForChallenge(stepId, a.type, ctx, challenge);
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
    if (a.type === "extract") await this.ensureNetworkJsonCapture(session);
    const domSnapshot = a.type === "extract" ? await this.snapshotDom(session) : undefined;
    const challenge = await this.detectDomChallenge(session);
    if (challenge !== undefined) {
      return this.suspendForChallenge(stepId, a.type, ctx, challenge);
    }
    const req = this.buildRequest(stepId, a, ctx, domSnapshot);
    let callIds: string[] = [];

    let res: LLMResponse;
    try {
      res = await this.gateway.call(req, ctx.abortSignal);
    } catch (e) {
      if (e instanceof GatewayError) {
        callIds = stagehandCallIdsFromError(e);
        return this.failResult(stepId, a.type, before, startedAt, e.code, callIds);
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
    const preChallenge = await this.detectDomChallenge(session);
    if (preChallenge !== undefined) {
      return this.suspendForChallenge(stepId, "act", ctx, preChallenge);
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
    await this.ensureNetworkJsonCapture(session);
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
      const cache = this.cache;
      plan = await withSpan(SPAN.actionPlanCacheLookup, spanCommonFromContext(ctx), {}, () => cache.get(cacheKey));
      cacheMode = plan ? "hit" : "miss";
    }

    let fromLlm = false;
    if (!plan) {
      // miss/bypass → LLM 으로 plan 산출(Gateway 경유, action_plan 스키마 strict). 원문 DOM 동봉(셀렉터 타깃팅).
      const req = this.buildRequest(stepId, a, ctx, await this.snapshotDom(session));
      let res: LLMResponse;
      try {
        res = await this.gateway.call(req, ctx.abortSignal);
      } catch (e) {
        if (e instanceof GatewayError) {
          callIds = stagehandCallIdsFromError(e);
          return this.failResult(stepId, "act", before, startedAt, e.code, callIds);
        }
        throw e;
      }
      callIds = stagehandCallIdsFromResponse(res);
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
    await this.applyPlan(plan, session, ctx);
    const postChallenge = await this.detectDomChallenge(session);
    if (postChallenge !== undefined) {
      return this.suspendForChallenge(stepId, "act", ctx, postChallenge, {
        stagehandCallIds: callIds,
        cache: { mode: cacheMode, ...(this.cache ? { actionPlanCacheId: cacheKey.domStructuralHash } : {}) },
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
      cache: { mode: cacheMode, ...(this.cache ? { actionPlanCacheId: cacheKey.domStructuralHash } : {}) },
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
    await this.waitForSelectorState(session, selector, stepId, ctx, true);
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
    const postChallenge = await this.detectDomChallenge(session);
    if (postChallenge !== undefined) {
      return this.suspendForChallenge(stepId, "act", ctx, postChallenge, {
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
    await this.waitForSelectorState(session, selector, stepId, ctx, false);
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
  private async waitForSelectorState(session: CdpSession, selector: string, stepId: string, ctx: RunContext, wantPresent: boolean): Promise<void> {
    const settleMs = clickSettleMs();
    const deadline = Date.now() + settleMs;
    const probe = `document.querySelector(${JSON.stringify(selector)}) ${wantPresent ? "!==" : "==="} null`;
    for (;;) {
      if (ctx.abortSignal.aborted) {
        throw new StagehandDomExecutorError("RUN_ABORTED", `step '${stepId}' aborted while awaiting selector '${selector}' (${wantPresent ? "present" : "absent"})`);
      }
      let ok = false;
      try {
        ok = await session.evaluate<boolean>(probe);
      } catch {
        // 네비게이션/일시 단절 — 다음 폴에서 재시도. deadline 까지 미충족이면 loud.
      }
      if (ok) return;
      if (Date.now() >= deadline) {
        throw new StagehandDomExecutorError(
          "IR_SCHEMA_INVALID",
          `step '${stepId}' selector '${selector}' ${wantPresent ? "미존재" : "잔존"}(settle ${settleMs}ms 초과) — 조용한 false 금지`,
        );
      }
      await sleep(CLICK_POLL_MS);
    }
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

  private suspendForChallenge(
    stepId: string,
    action: DomAction["type"],
    ctx: RunContext,
    challenge: HumanAssistChallenge,
    observed?: {
      readonly stagehandCallIds?: readonly string[];
      readonly cache?: StepResult["cache"];
      readonly sideEffect?: StepResult["sideEffect"];
    },
  ): StepResult {
    const startedAt = nowIso();
    const endedAt = nowIso();
    const pageState = pageStateRef(ctx.pageState);
    return {
      stepId,
      action,
      status: "suspended",
      output: { challenge },
      pageStateBefore: pageState,
      pageStateAfter: pageState,
      artifacts: [],
      stagehandCallIds: [...(observed?.stagehandCallIds ?? [])],
      cache: observed?.cache ?? { mode: "bypass" },
      ...(observed?.sideEffect !== undefined ? { sideEffect: observed.sideEffect } : {}),
      challenge,
      exception: {
        class: "challenge",
        code: "CHALLENGE_UNRESOLVED",
        message: `dom executor ${action} suspended for ${challenge.type}` as RedactedString,
      },
      timings: { startedAt, endedAt, durationMs: Date.parse(endedAt) - Date.parse(startedAt) },
    };
  }

  private async detectDomChallenge(session: CdpSession): Promise<HumanAssistChallenge | undefined> {
    try {
      return parseHumanAssistChallenge(await session.evaluate<unknown>(CHALLENGE_DETECTION_SCRIPT));
    } catch {
      return undefined;
    }
  }

  /** Install page-side fetch/XHR JSON capture before actions that can trigger paginated grids. */
  private async ensureNetworkJsonCapture(session: CdpSession): Promise<void> {
    try {
      await session.evaluate<unknown>(NETWORK_JSON_CAPTURE_SCRIPT);
    } catch {
      // Capture is evidence enrichment only. Keep the DOM/PageState path alive if injection is blocked.
    }
  }

  /** 페이지 스냅샷(best-effort, 절단). 실패 시 undefined — 신호만으로 진행(loud 아님; 셀렉터 품질 저하 가능). */
  private async snapshotDom(session: CdpSession): Promise<NormalizedDomSnapshot | undefined> {
    try {
      const snapshot = await session.evaluate<unknown>(
        `(() => {
          const root = document.body || document.documentElement;
          const w = window;
          const rawNetworkJson = Array.isArray(w.__RPA_NETWORK_JSON__)
            ? w.__RPA_NETWORK_JSON__
            : Array.isArray(w.__RPA_RECENT_JSON__)
              ? w.__RPA_RECENT_JSON__
              : Array.isArray(w.__rpaNetworkJson)
                ? w.__rpaNetworkJson
                : [];
          const networkJson = rawNetworkJson.slice(-8).map((entry) => {
            if (typeof entry === "string") return entry;
            try { return JSON.stringify(entry); } catch { return ""; }
          }).filter(Boolean).join("\\n");
          const textForHiddenElement = (el) => {
            const out = [];
            const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
            if (text) out.push(text);
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
              const value = String(el.value || "").trim();
              if (value) out.push(value);
            }
            for (const field of Array.from(el.querySelectorAll("input, textarea, select"))) {
              if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) {
                const value = String(field.value || "").trim();
                if (value) out.push(value);
              }
            }
            return out.join(" ").replace(/\\s+/g, " ").trim();
          };
          const hiddenReason = (el) => {
            if (!(el instanceof Element)) return "";
            if (el.getAttribute("aria-hidden") === "true") return "aria-hidden";
            if (el instanceof HTMLInputElement && el.type === "hidden") return "input-hidden";
            const style = window.getComputedStyle(el);
            if (style.display === "none") return "display-none";
            if (style.visibility === "hidden" || style.visibility === "collapse") return "visibility-hidden";
            const opacity = Number(style.opacity);
            if (Number.isFinite(opacity) && opacity <= 0.001) return "zero-opacity";
            const rect = el.getBoundingClientRect();
            const vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
            const vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
            if (
              rect.width > 0 &&
              rect.height > 0 &&
              (rect.right < -32 || rect.bottom < -32 || rect.left > vw + 2048 || rect.top > vh + 2048)
            ) {
              return "offscreen";
            }
            return "";
          };
          const collectHiddenTextRuns = (start) => {
            if (!start) return [];
            const runs = [];
            const visit = (el, ancestorHidden) => {
              if (!(el instanceof Element) || runs.length >= 120) return;
              const reason = ancestorHidden || hiddenReason(el);
              if (reason) {
                if (!ancestorHidden) {
                  const text = textForHiddenElement(el);
                  const visibility = reason === "offscreen" ? "offscreen" : reason === "zero-opacity" ? "zero_opacity" : "hidden";
                  if (text) runs.push({ text, visibility, source: "dom" });
                }
                return;
              }
              for (const child of Array.from(el.children)) visit(child, "");
            };
            visit(start, "");
            return runs;
          };
          return {
            networkJson,
            visibleText: document.body ? document.body.innerText : (root ? root.textContent : ""),
            textRuns: collectHiddenTextRuns(root),
            html: root ? root.outerHTML : ""
          };
        })()`,
      );
      const text = normalizePageSnapshot(snapshot);
      const textRuns = promptInspectionTextRuns(snapshot);
      if (text === undefined && textRuns.length === 0) return undefined;
      return {
        ...(text !== undefined ? { text } : {}),
        ...(textRuns.length > 0 ? { textRuns } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private buildRequest(stepId: string, a: DomAction, ctx: RunContext, domSnapshot?: NormalizedDomSnapshot): LLMRequest {
    const ps = ctx.pageState;
    // 페이지 컨텍스트는 user 역할로만(신뢰영역 분리, §2). PageState 파생 신호 + 원문 DOM(절단) — Gateway redaction(§4)
    // 경계가 user 메시지를 redact/injection-탐지한다. DOM 은 셀렉터 타깃팅에 필요(act/extract).
    const context = JSON.stringify({
      url: ps.url.pattern,
      auth: ps.auth,
      structuralHash: ps.dom.structuralHash,
      landmarks: ps.dom.landmarks,
      flags: ps.flags,
      ...(domSnapshot?.text !== undefined ? { dom: domSnapshot.text } : {}),
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

    const systemContent =
      a.type === "extract"
        ? "Deterministic web automation extract worker. Extract actual records from [page].dom and return only the requested JSON data. Prefer [network_json] for virtualized grids or API-backed tables, then [visible_text], then [html]. Use only values present in [network_json], [visible_text], or [html]. If no matching records are present, return an empty collection that fits the requested schema. Never synthesize placeholder/example rows. Do not return an extraction plan, selector plan, or prose."
        : `Deterministic web automation ${a.type} planner. Respond with a single minified JSON object only.`;

    const request = {
      model: this.cfg.model,
      promptTemplateVersion: this.cfg.promptTemplateVersion,
      messages: [
        // system 은 redaction 비대상(Gateway 는 user 메시지만 redact) — JSON 지시를 여기 둬 native json_object 모드의
        // "messages 에 'json' 포함" 요구를 충족하고(user 메시지가 redact 돼도), 플래너 출력 형식을 고정한다.
        { role: "system", content: systemContent },
        { role: "user", content: `${a.instruction}\n[page]${context}` },
      ],
      ...(responseFormat ? { responseFormat } : {}),
      metadata: { tenantId: ctx.tenantId, runId: ctx.runId, stepId, attempt: ctx.attempt, primitive: a.type, correlationId: ctx.runId },
      budget: this.cfg.budget,
      idempotencyKey: key,
      requestHash: key,
    } as unknown as LLMRequest;
    return domSnapshot?.textRuns !== undefined ? { ...request, promptInspection: { textRuns: domSnapshot.textRuns } } : request;
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
      const rowAnchor = coerceRowAnchor((action as { rowAnchor?: unknown }).rowAnchor, stepId);
      return {
        type,
        instruction,
        output: { schemaRef: o.schemaRef, schemaVersion: o.schemaVersion, strict: o.strict, ...(schema !== undefined ? { schema } : {}) },
        ...(rowAnchor !== undefined ? { rowAnchor } : {}),
      };
    }
    if (type === "act") {
      const se = (action as { sideEffect?: unknown }).sideEffect;
      const sr = (action as { secretRef?: unknown }).secretRef;
      const vr = (action as { valueRef?: unknown }).valueRef;
      const val = (action as { value?: unknown }).value;
      const cs = (action as { clickSelector?: unknown }).clickSelector;
      const aa = (action as { assertAbsent?: unknown }).assertAbsent;
      return {
        type,
        instruction,
        ...(typeof se === "string" ? { sideEffect: se as SideEffectKind } : {}),
        ...(typeof sr === "string" && sr.length > 0 ? { secretRef: sr } : {}),
        ...(typeof vr === "string" && vr.length > 0 ? { valueRef: vr } : {}),
        ...(typeof val === "string" ? { value: val } : {}),
        ...(typeof cs === "string" && cs.length > 0 ? { clickSelector: cs } : {}),
        ...(typeof aa === "string" && aa.length > 0 ? { assertAbsent: aa } : {}),
      };
    }
    return { type, instruction };
  }
}
