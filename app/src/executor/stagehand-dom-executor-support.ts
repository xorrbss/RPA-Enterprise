// stagehand-dom-executor.ts 에서 추출 — DOM executor 보조(상수·DOM 주입 스크립트·challenge 파싱·
// 에러 분류·stagehand call-id 추출, 동작 무변경). 전부 leaf(클래스 미참조). 클래스가 역import.
import { createHash } from "node:crypto";

import { ERROR_CATALOG, type ErrorCode } from "../../../ts/error-catalog";
import type { ChallengeSummary, ExceptionClass, RedactedString, StepStatus } from "../../../ts/core-types";
import type { LLMResponse, PromptInspectionTextRun } from "../../../ts/security-middleware-contract";
import { GatewayError } from "../gateway/llm-gateway";

export const UTILITY_ACTIONS = new Set(["navigate", "download", "upload", "api_call", "file", "shell"]);
// act LLM-plan 의 구조화 출력 스키마 — inline schema 동반이라 Gateway(llm-gateway.ts:321)가 bypass 대신 ajv 로
//   강제한다(LLM 이 {operation,selector,value?,valueRef?} 형태로 수렴 — 모호객체 {action,target,criteria} 거부).
//   shape 는 parseActionPlan(action-plan-cache.ts) 계약과 1:1(operation enum·non-empty selector). strict + 1회 repair.
export const ACTION_PLAN_SCHEMA = {
  type: "json_schema",
  schemaRef: "action_plan",
  schemaVersion: "1",
  strict: true,
  schema: {
    type: "object",
    required: ["operation", "selector"],
    additionalProperties: false,
    properties: {
      operation: { enum: ["click", "select", "fill"] },
      selector: { type: "string", minLength: 1 },
      value: { type: "string" },
      valueRef: { type: "string", minLength: 1 },
    },
  },
} as const;
// 결정형 클릭(click_selector) settle — 무거운 SPA 상세/async 모달 렌더 대응. 미존재 시 deadline 까지 폴 후 loud(은폐 금지).
// 동적 읽기(매 호출): 테스트가 DET_CLICK_SETTLE_MS 로 단축할 수 있게 함(모듈 로드 시점 고정 회피).
export const clickSettleMs = (): number => Number(process.env.DET_CLICK_SETTLE_MS ?? 15000);
export const CLICK_POLL_MS = 500;
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
// LLM 이 셀렉터를 정하려면 원문 DOM 이 필요(PageState 파생 신호만으론 #password 등 타깃 불가). user 메시지로 실어
// Gateway redaction(§4) 경계가 redact/injection-탐지하게 한다. 토큰 예산 보호용 상한(초과분 절단).
export const NETWORK_JSON_CAPTURE_SCRIPT = `(() => {
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
export const CHALLENGE_DETECTION_SCRIPT = `(() => {
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
export const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 32);
export const nowIso = (): string => new Date().toISOString();
export type HumanAssistChallenge = ChallengeSummary & { type: "captcha" | "mfa" };
export type NormalizedDomSnapshot = { text?: string; textRuns?: readonly PromptInspectionTextRun[] };

export function humanAssistChallenge(challenge: ChallengeSummary | undefined): HumanAssistChallenge | undefined {
  if (challenge?.type === "captcha" || challenge?.type === "mfa") return challenge as HumanAssistChallenge;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseHumanAssistChallenge(value: unknown): HumanAssistChallenge | undefined {
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
export function classify(code: ErrorCode): { status: StepStatus; cls: ExceptionClass } {
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

export function stagehandCallIdsFromResponse(response: LLMResponse): string[] {
  return typeof response.stagehandCallId === "string" && response.stagehandCallId.trim().length > 0
    ? [response.stagehandCallId]
    : [];
}

export function stagehandCallIdsFromError(error: GatewayError): string[] {
  return typeof error.stagehandCallId === "string" && error.stagehandCallId.trim().length > 0
    ? [error.stagehandCallId]
    : [];
}

export function promptInspectionTextRuns(snapshot: unknown): readonly PromptInspectionTextRun[] {
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

