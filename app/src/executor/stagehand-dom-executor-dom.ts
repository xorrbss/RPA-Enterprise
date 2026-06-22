// stagehand-dom-executor.ts 에서 추출 — DOM 상호작용 헬퍼(selector 대기·challenge 탐지·DOM 스냅샷·
// LLM 요청 빌드·action 검증·실패/suspend 결과 생성, 동작 무변경). 전부 무상태(cfg는 인자) — 클래스가 역import.
import type { ErrorCode } from "../../../ts/error-catalog";
import type { RedactedString, RunContext, SideEffectKind, StepResult } from "../../../ts/core-types";
import type { LLMRequest } from "../../../ts/security-middleware-contract";
import type { CdpSession } from "./cdp-session";
import { coerceRowAnchor } from "./extract-row-anchor";
import { StagehandDomExecutorError } from "./dom-executor-error";
import { normalizePageSnapshot } from "./page-snapshot";
import { pageStateRef } from "./page-state-resolver";
import type { DomAction, StagehandDomExecutorConfig } from "./stagehand-dom-executor";
import {
  ACTION_PLAN_SCHEMA,
  CHALLENGE_DETECTION_SCRIPT,
  CLICK_POLL_MS,
  NETWORK_JSON_CAPTURE_SCRIPT,
  UTILITY_ACTIONS,
  classify,
  clickSettleMs,
  nowIso,
  parseHumanAssistChallenge,
  promptInspectionTextRuns,
  sha,
  sleep,
  type HumanAssistChallenge,
  type NormalizedDomSnapshot,
} from "./stagehand-dom-executor-support";

export async function waitForSelectorState(session: CdpSession, selector: string, stepId: string, ctx: RunContext, wantPresent: boolean): Promise<void> {
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


export function failResult(
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

export function suspendForChallenge(
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

export async function detectDomChallenge(session: CdpSession): Promise<HumanAssistChallenge | undefined> {
  try {
    return parseHumanAssistChallenge(await session.evaluate<unknown>(CHALLENGE_DETECTION_SCRIPT));
  } catch {
    return undefined;
  }
}

/** Install page-side fetch/XHR JSON capture before actions that can trigger paginated grids. */
export async function ensureNetworkJsonCapture(session: CdpSession): Promise<void> {
  try {
    await session.evaluate<unknown>(NETWORK_JSON_CAPTURE_SCRIPT);
  } catch {
    // Capture is evidence enrichment only. Keep the DOM/PageState path alive if injection is blocked.
  }
}

/** 페이지 스냅샷(best-effort, 절단). 실패 시 undefined — 신호만으로 진행(loud 아님; 셀렉터 품질 저하 가능). */
export async function snapshotDom(session: CdpSession): Promise<NormalizedDomSnapshot | undefined> {
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

export function buildRequest(cfg: StagehandDomExecutorConfig, stepId: string, a: DomAction, ctx: RunContext, domSnapshot?: NormalizedDomSnapshot): LLMRequest {
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
  // 멱등키는 worker-retry dedup 용으로 안정적이어야 한다(죽은 워커 재시도가 같은 LLM 호출을 재청구/재실행하지 않게 replay).
  //   그러나 self-heal 재해소(ctx.selfHealRetry)는 verify 실패한 stale 플랜의 replay 가 아니라 **fresh LLM 호출**이어야
  //   한다 — 같은 페이지(structuralHash 불변)에서 self-heal 이 동일 키로 단락되면 gateway 멱등 store 가 직전 stale
  //   parsed_json 을 replay 해 자가복구가 영원히 무력화된다(GW-SSE-02). self-heal 세대(attempt 는 self-heal 마다 증가)만
  //   키에 섞어 self-heal 만 새 reservation 이 되게 하고, 일반/worker-retry 경로의 안정 키(dedup)는 보존한다.
  const baseKey = `${ctx.tenantId}|${ctx.runId}|${stepId}|${a.type}|${cfg.promptTemplateVersion}|${a.instruction}|${ps.dom.structuralHash}`;
  const key = sha(ctx.selfHealRetry === true ? `${baseKey}|self_heal:${ctx.attempt}` : baseKey);

  const responseFormat =
    a.type === "extract"
      ? { type: "json_schema" as const, schemaRef: a.output.schemaRef, schemaVersion: a.output.schemaVersion, strict: a.output.strict, ...(a.output.schema !== undefined ? { schema: a.output.schema } : {}) }
      : a.type === "act"
        ? ACTION_PLAN_SCHEMA
        : undefined;

  const systemContent =
    a.type === "extract"
      ? "Deterministic web automation extract worker. Extract actual records from [page].dom and return only the requested JSON data. Prefer [network_json] for virtualized grids or API-backed tables, then [visible_text], then [html]. Use only values present in [network_json], [visible_text], or [html]. If no matching records are present, return an empty collection that fits the requested schema. Never synthesize placeholder/example rows. Do not return an extraction plan, selector plan, or prose."
      : a.type === "act"
        ? // act 플래너 shape 을 system 프롬프트에 직접 고정 — §7 프롬프트-스키마 주입은 jsonMode=false(prod)에서만
          //   발화하므로(dev 는 jsonMode=true), 모드 무관하게 {operation,selector} 로 수렴시키려면 여기서 지시해야 한다.
          //   ACTION_PLAN_SCHEMA(ajv §5)와 동형. CSS 셀렉터만(text=/:has-text/:contains 는 결정형 click_text 의 몫).
          'Deterministic web automation act planner. Respond with ONLY a single minified JSON object: {"operation":"click"|"select"|"fill","selector":"<a CSS selector that targets exactly one element>","value":"<string, only for select/fill>"}. The selector must be a concrete CSS selector (no text=, :has-text, or :contains). No prose, no markdown, no code fences.'
        : `Deterministic web automation ${a.type} planner. Respond with a single minified JSON object only.`;

  const request = {
    model: cfg.model,
    promptTemplateVersion: cfg.promptTemplateVersion,
    messages: [
      // system 은 redaction 비대상(Gateway 는 user 메시지만 redact) — JSON 지시를 여기 둬 native json_object 모드의
      // "messages 에 'json' 포함" 요구를 충족하고(user 메시지가 redact 돼도), 플래너 출력 형식을 고정한다.
      { role: "system", content: systemContent },
      { role: "user", content: `${a.instruction}\n[page]${context}` },
    ],
    ...(responseFormat ? { responseFormat } : {}),
    metadata: { tenantId: ctx.tenantId, runId: ctx.runId, stepId, attempt: ctx.attempt, primitive: a.type, correlationId: ctx.runId },
    budget: cfg.budget,
    idempotencyKey: key,
    requestHash: key,
  } as unknown as LLMRequest;
  return domSnapshot?.textRuns !== undefined ? { ...request, promptInspection: { textRuns: domSnapshot.textRuns } } : request;
}

export function assertDomAction(stepId: string, action: unknown): DomAction {
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
    const ct = (action as { clickText?: unknown }).clickText;
    const aa = (action as { assertAbsent?: unknown }).assertAbsent;
    return {
      type,
      instruction,
      ...(typeof se === "string" ? { sideEffect: se as SideEffectKind } : {}),
      ...(typeof sr === "string" && sr.length > 0 ? { secretRef: sr } : {}),
      ...(typeof vr === "string" && vr.length > 0 ? { valueRef: vr } : {}),
      ...(typeof val === "string" ? { value: val } : {}),
      ...(typeof cs === "string" && cs.length > 0 ? { clickSelector: cs } : {}),
      ...(typeof ct === "string" && ct.length > 0 ? { clickText: ct } : {}),
      ...(typeof aa === "string" && aa.length > 0 ? { assertAbsent: aa } : {}),
    };
  }
  return { type, instruction };
}
