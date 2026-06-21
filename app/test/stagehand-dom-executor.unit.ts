/**
 * D3 LLM 절반 단위 테스트 — StagehandDomExecutor ↔ Gateway + act mutation 적용 경로.
 *
 * 주입형 fake(Gateway·CdpSessionProvider·ActionPlanCache)로 키/브라우저 없이 검증:
 * act/observe/extract → Gateway.call → StepResult, **act → ActionPlan → CDP 적용(click/fill/select)**,
 * ActionPlanCache hit(LLM 미호출 재생)/miss, 비-dom 거부, GatewayError 분류 환원.
 * 실행: `tsx test/stagehand-dom-executor.unit.ts`.
 */
import type { ArtifactRef, PageState, RunContext, StepResult } from "../../ts/core-types";
import type { ErrorCode } from "../../ts/error-catalog";
import type { LLMRequest, LLMResponse } from "../../ts/security-middleware-contract";
import type { CdpSession, CdpSessionProvider } from "../src/executor/cdp-session";
import { GatewayError, type GatewayArtifactSink } from "../src/gateway/llm-gateway";
import {
  StagehandDomExecutor,
  StagehandDomExecutorError,
  type ActionPlan,
  type ActionPlanCache,
  type LlmGatewayCaller,
} from "../src/executor/stagehand-dom-executor";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function makeCtx(over: Partial<RunContext> = {}): RunContext {
  const ps: PageState = {
    url: { raw: "https://x/p/1", canonical: "https://x/p/1", pattern: "https://x/p/:id" },
    dom: { structuralHash: "abc", visibleTextHash: "def", landmarks: [], frames: [] },
    auth: "authenticated",
    flags: { reviews_visible: true },
    matchedWhere: [],
  };
  return {
    runId: "run-1", tenantId: "t-1", nodeId: "n-1", attempt: 0, siteProfileId: "site-1",
    browserIdentityId: "bid-1", networkPolicyId: "np-1", leaseId: "lease-1",
    assetRefs: {}, abortSignal: new AbortController().signal, pageState: ps,
    ...over,
  };
}

const cfg = { model: "codex", promptTemplateVersion: "v1", budget: { maxInputTokens: 10000, maxOutputTokens: 4096, maxCost: 0.85 }, scenarioVersionId: "sv-1", browserIdentityVersion: 1 };

function countingGateway(resp: Partial<LLMResponse> = {}) {
  let n = 0;
  let lastReq: LLMRequest | undefined;
  const gw: LlmGatewayCaller = {
    call: async (req) => {
      n += 1;
      lastReq = req;
      return { outputRef: "art://out" as ArtifactRef, usage: { inputTokens: 1, outputTokens: 1, cost: 0 }, finishReason: "stop", ...resp };
    },
  };
  return { gw, calls: () => n, lastReq: () => lastReq };
}
const errGateway = (code: ErrorCode): LlmGatewayCaller => ({ call: async () => { throw new GatewayError(code, "boom"); } });

function fakeSessions(dom: unknown = "<body><main>hello</main></body>", opts?: { clickThrows?: boolean }) {
  const ops: string[] = [];
  const evals: string[] = [];
  const session: CdpSession = {
    url: () => "u",
    goto: async () => {},
    reload: async () => {},
    evaluate: async (expr) => {
      evals.push(String(expr));
      return dom as never;
    },
    sendCDP: async () => undefined as never,
    click: async (s) => {
      ops.push(`click:${s}`);
      if (opts?.clickThrows) throw new Error(`click drift: ${s} no longer matches`);
    },
    fill: async (s, v) => void ops.push(`fill:${s}=${v}`),
    selectOption: async (s, v) => void ops.push(`select:${s}=${v}`),
    setInputFiles: async () => {},
    downloadDir: () => "/tmp",
    waitForDownload: async () => true,
    close: async () => {},
  };
  return { provider: { forLease: () => session } as CdpSessionProvider, ops, evals };
}

// extract.rowAnchor 테스트용 세션 — anchor evaluate(getAttribute 포함식)는 pairs, snapshotDom evaluate 는 dom 을 반환.
function anchorSessions(pairs: Array<{ k: string; v: string | null }>, snapshotDom: unknown = "<body><table>list</table></body>") {
  const ops: string[] = [];
  const session: CdpSession = {
    url: () => "u",
    goto: async () => {},
    reload: async () => {},
    evaluate: async (expr: string) => (String(expr).includes("getAttribute") ? pairs : snapshotDom) as never,
    sendCDP: async () => undefined as never,
    click: async (s) => void ops.push(`click:${s}`),
    fill: async (s, v) => void ops.push(`fill:${s}=${v}`),
    selectOption: async () => {},
    setInputFiles: async () => {},
    downloadDir: () => "/tmp",
    waitForDownload: async () => true,
    close: async () => {},
  };
  return { provider: { forLease: () => session } as CdpSessionProvider, ops };
}

// 결정형 클릭(click_selector) 테스트용 세션 — evaluate(settle 존재 프로브)는 present(boolean) 반환, click 은 ops 기록.
function clickSessions(present: boolean) {
  const ops: string[] = [];
  const session: CdpSession = {
    url: () => "u",
    goto: async () => {},
    reload: async () => {},
    evaluate: async () => present as never,
    sendCDP: async () => undefined as never,
    click: async (s) => void ops.push(`click:${s}`),
    fill: async () => {},
    selectOption: async () => {},
    setInputFiles: async () => {},
    downloadDir: () => "/tmp",
    waitForDownload: async () => true,
    close: async () => {},
  };
  return { provider: { forLease: () => session } as CdpSessionProvider, ops };
}

// 결정형 클릭/부재단언 — expr 별 응답 분기(존재 !==null / 부재 ===null / radio checked read-back).
function detSessions(opts: { present?: boolean; absent?: boolean; checkState?: string }) {
  const ops: string[] = [];
  const session: CdpSession = {
    url: () => "u",
    goto: async () => {},
    reload: async () => {},
    evaluate: async (expr: string) => {
      const s = String(expr);
      if (s.includes('"radio"') || s.includes(".checked")) return (opts.checkState ?? "na") as never;
      if (s.includes("=== null")) return (opts.absent ?? true) as never;
      return (opts.present ?? true) as never;
    },
    sendCDP: async () => undefined as never,
    click: async (sel) => void ops.push(`click:${sel}`),
    fill: async () => {},
    selectOption: async () => {},
    setInputFiles: async () => {},
    downloadDir: () => "/tmp",
    waitForDownload: async () => true,
    close: async () => {},
  };
  return { provider: { forLease: () => session } as CdpSessionProvider, ops };
}

// 강화된 추출 행을 영속하는 fake typed-artifact sink(인박스 artifact). put content/meta 를 캡처.
function fakeExtractSink() {
  const puts: Array<{ content: string; meta: unknown }> = [];
  const sink: GatewayArtifactSink = {
    put: async (content, meta) => {
      puts.push({ content, meta });
      return `art://inbox-${puts.length}` as ArtifactRef;
    },
  };
  return { sink, puts };
}

function fakeCache(seed?: ActionPlan) {
  let stored = seed;
  const calls = { get: 0, put: 0, suspect: 0 };
  const cache: ActionPlanCache = {
    get: async () => { calls.get += 1; return stored; },
    put: async (_key, plan) => { calls.put += 1; stored = plan; },
    markSuspect: async () => { calls.suspect += 1; },
  };
  return { cache, calls };
}

const EXTRACT_OUT = { schemaRef: "reviews", schemaVersion: "1", strict: true };
const CLICK_PLAN: ActionPlan = { operation: "click", selector: "#login" };

async function caught(p: Promise<unknown>): Promise<StagehandDomExecutorError | undefined> {
  try { await p; return undefined; } catch (e) { return e instanceof StagehandDomExecutorError ? e : undefined; }
}

function humanChallenge(type: "captcha" | "mfa") {
  return { type, detectedBy: "dom" as const, confidence: 0.93 };
}

function challengeSessions(opts: { pre?: "captcha" | "mfa"; post?: "captcha" | "mfa" }) {
  const ops: string[] = [];
  const evals: string[] = [];
  let challengeProbeCount = 0;
  const session: CdpSession = {
    url: () => "u",
    goto: async () => {},
    reload: async () => {},
    evaluate: async (expr: string) => {
      const s = String(expr);
      evals.push(s);
      if (s.includes("rpa_challenge_detector_v1")) {
        challengeProbeCount += 1;
        const kind = challengeProbeCount === 1 ? opts.pre : opts.post;
        return (kind !== undefined ? humanChallenge(kind) : null) as never;
      }
      if (s.includes('"radio"') || s.includes(".checked")) return "na" as never;
      if (s.includes("document.querySelector")) return true as never;
      if (s.includes("__RPA_NETWORK_CAPTURE_INSTALLED__")) return { installed: true } as never;
      return "<body><main>challenge test</main></body>" as never;
    },
    sendCDP: async () => undefined as never,
    click: async (s) => void ops.push(`click:${s}`),
    fill: async (s, v) => void ops.push(`fill:${s}=${v}`),
    selectOption: async (s, v) => void ops.push(`select:${s}=${v}`),
    setInputFiles: async () => {},
    downloadDir: () => "/tmp",
    waitForDownload: async () => true,
    close: async () => {},
  };
  return { provider: { forLease: () => session } as CdpSessionProvider, ops, evals };
}

async function main(): Promise<void> {
  const sess = () => fakeSessions().provider;

  check("capabilities: {dom:true, vision:false, utility:false}", (() => {
    const c = new StagehandDomExecutor(countingGateway().gw, sess(), cfg).capabilities();
    return c.dom === true && c.vision === false && c.utility === false;
  })());

  {
    const g = countingGateway();
    const s = fakeSessions();
    const base = makeCtx();
    const r = await new StagehandDomExecutor(g.gw, s.provider, cfg).execute(
      "s0-challenge-state",
      { type: "act", instruction: "continue after auth" },
      makeCtx({ pageState: { ...base.pageState, challenge: humanChallenge("mfa") } }),
    );
    check(
      "challenge: PageState.challenge(mfa) -> suspended without gateway/session probe",
      r.status === "suspended" &&
        r.challenge?.type === "mfa" &&
        r.exception?.class === "challenge" &&
        r.exception.code === "CHALLENGE_UNRESOLVED" &&
        g.calls() === 0 &&
        s.evals.length === 0,
      JSON.stringify(r),
    );
  }

  {
    const g = countingGateway({ parsedJson: { rows: [] } });
    const s = challengeSessions({ pre: "captcha" });
    const r = await new StagehandDomExecutor(g.gw, s.provider, cfg).execute(
      "s0-captcha-dom",
      { type: "extract", instruction: "get rows", output: EXTRACT_OUT },
      makeCtx(),
    );
    check(
      "challenge: DOM captcha before extract -> suspended and gateway skipped",
      r.status === "suspended" && r.challenge?.type === "captcha" && g.calls() === 0,
      JSON.stringify(r),
    );
  }

  {
    const g = countingGateway();
    const s = challengeSessions({ post: "mfa" });
    const r = await new StagehandDomExecutor(g.gw, s.provider, cfg).execute(
      "s0-post-click-mfa",
      { type: "act", instruction: "click login", clickSelector: "#login", sideEffect: "login" },
      makeCtx(),
    );
    check(
      "challenge: post-click MFA -> suspended after committed deterministic click",
      r.status === "suspended" &&
        r.challenge?.type === "mfa" &&
        s.ops.includes("click:#login") &&
        g.calls() === 0 &&
        r.sideEffect?.kind === "login" &&
        r.sideEffect.committed === true,
      JSON.stringify(r),
    );
  }

  // extract → read-only, extracted set, output.rowCount = {rows} 길이(표준 노드 출력 투영, ir-expression §2)
  {
    const g = countingGateway({ parsedJson: { rows: [1, 2, 3] } });
    const ex = new StagehandDomExecutor(g.gw, fakeSessions("<body><table><tr><td>Alice</td></tr></table></body>").provider, cfg);
    const r = await ex.execute("s1", { type: "extract", instruction: "get reviews", output: EXTRACT_OUT }, makeCtx());
    check(
      "extract: success + extracted + artifacts + output.rowCount=3",
      r.status === "success" && (r.extracted as { rows: number[] }).rows.length === 3 && r.artifacts[0] === "art://out" && (r.output as { rowCount?: number }).rowCount === 3,
    );
    const userContent = g.lastReq()?.messages.find((m) => m.role === "user")?.content;
    const systemContent = g.lastReq()?.messages.find((m) => m.role === "system")?.content;
    const userMessage = typeof userContent === "string" ? userContent : JSON.stringify(userContent ?? "");
    const systemMessage = typeof systemContent === "string" ? systemContent : JSON.stringify(systemContent ?? "");
    check("extract: gateway request includes current DOM snapshot", userMessage.includes("Alice"));
    check("extract: prompt forbids plan-only output", systemMessage.includes("Do not return an extraction plan"));
    check("extract: prompt forbids placeholder/example rows", systemMessage.includes("Never synthesize placeholder/example rows"));
  }

  // extract: visible text is prioritized over long raw HTML so rendered grid rows reach the gateway.
  {
    const g = countingGateway({ parsedJson: { rows: [{ title: "Actual rendered notice" }] } });
    const snapshot = {
      visibleText: "Notice list\n55\tCard access\tActual rendered notice\tKim\t2026-06-05\t493",
      html: `<body>${"x".repeat(30000)}<table><tr><td>Actual rendered notice</td></tr></table></body>`,
    };
    const ex = new StagehandDomExecutor(g.gw, fakeSessions(snapshot).provider, cfg);
    await ex.execute("s1-visible", { type: "extract", instruction: "get notices", output: EXTRACT_OUT }, makeCtx());
    const userContent = g.lastReq()?.messages.find((m) => m.role === "user")?.content;
    const userMessage = typeof userContent === "string" ? userContent : JSON.stringify(userContent ?? "");
    check("extract: gateway request marks visible text snapshot", userMessage.includes("[visible_text]"));
    check("extract: visible rendered row survives long HTML snapshot", userMessage.includes("Actual rendered notice"));
  }

  // extract: network JSON evidence is included before DOM text for API-backed/virtualized grids.
  {
    const g = countingGateway({ parsedJson: { rows: [{ title: "Network notice" }] } });
    const snapshot = {
      networkJson: JSON.stringify({ rows: [{ title: "Network notice", author: "Lee" }] }),
      visibleText: "grid rendered shell",
      html: "<body><div id=\"grid\"></div></body>",
    };
    const s = fakeSessions(snapshot);
    const ex = new StagehandDomExecutor(g.gw, s.provider, cfg);
    await ex.execute("s1-network-json", { type: "extract", instruction: "get notices", output: EXTRACT_OUT }, makeCtx());
    const userContent = g.lastReq()?.messages.find((m) => m.role === "user")?.content;
    const systemContent = g.lastReq()?.messages.find((m) => m.role === "system")?.content;
    const userMessage = typeof userContent === "string" ? userContent : JSON.stringify(userContent ?? "");
    const systemMessage = typeof systemContent === "string" ? systemContent : JSON.stringify(systemContent ?? "");
    check("extract: auto-installs network JSON capture before snapshot", s.evals[0]?.includes("__RPA_NETWORK_CAPTURE_INSTALLED__") === true && s.evals[1]?.includes("__RPA_NETWORK_JSON__") === true);
    check("extract: gateway request marks network JSON snapshot", userMessage.includes("[network_json]"));
    check("extract: network JSON row survives snapshot", userMessage.includes("Network notice"));
    check("extract: prompt prefers network_json for virtualized grids", systemMessage.includes("Prefer [network_json]"));
  }

  // extract: hidden DOM text is carried as promptInspection side-channel without changing the prompt sections.
  {
    const g = countingGateway({ parsedJson: { rows: [{ title: "Visible notice" }] } });
    const snapshot = {
      visibleText: "Notice list\nVisible notice",
      textRuns: [
        { text: "Collapsed help drawer copy", visibility: "hidden", source: "dom" },
        { text: "Screen-reader shortcut hint", visibility: "offscreen", source: "dom" },
      ],
      html: "<body><main>Visible notice</main><aside style=\"display:none\">Collapsed help drawer copy</aside></body>",
    };
    const ex = new StagehandDomExecutor(g.gw, fakeSessions(snapshot).provider, cfg);
    await ex.execute("s1-hidden-text", { type: "extract", instruction: "get notices", output: EXTRACT_OUT }, makeCtx());
    const userContent = g.lastReq()?.messages.find((m) => m.role === "user")?.content;
    const userMessage = typeof userContent === "string" ? userContent : JSON.stringify(userContent ?? "");
    const textRuns = g.lastReq()?.promptInspection?.textRuns ?? [];
    check("extract: prompt keeps existing visible/html sections only", userMessage.includes("[visible_text]") && !userMessage.includes("[hidden_text]"));
    check("extract: hidden textRuns are attached for gateway inspection", textRuns.length === 2 && textRuns[0]?.visibility === "hidden" && textRuns[1]?.visibility === "offscreen");
  }

  // extract: rows 봉투 없으면 rowCount 미산출(→ node.row_count 미투영, loud).
  {
    const ex = new StagehandDomExecutor(countingGateway({ parsedJson: { product: "x" } }).gw, sess(), cfg);
    const r = await ex.execute("s1b", { type: "extract", instruction: "get product", output: EXTRACT_OUT }, makeCtx());
    check("extract: rows 부재 → output.rowCount 미산출", (r.output as { rowCount?: number }).rowCount === undefined);
  }

  // extract.rowAnchor: 결정형 doc_ref — DOM 앵커(td.docu-num data-href docId)를 approval_id 키-조인으로 권위 세팅(LLM 환각 override),
  //   강화 행을 typed artifact(인박스) 로 영속.
  const ROW_ANCHOR = { selector: "td.docu-num", matchField: "approval_id", field: "doc_ref", attribute: "data-href", pattern: "getView\\(['\"](\\d+)['\"]", template: "https://x/view/$1" };
  {
    const g = countingGateway({ parsedJson: { rows: [
      { approval_id: "IB-001", title: "A", doc_ref: "https://x/view/1234" }, // LLM 환각 doc_ref
      { approval_id: "IB-002", title: "B" }, // LLM doc_ref 없음
    ] } });
    const pairs = [
      { k: "IB-001", v: "javascript:ApprovalDocument.getView('984261', 'W');" },
      { k: "IB-002", v: "javascript:ApprovalDocument.getView('955055', 'W');" },
    ];
    const sink = fakeExtractSink();
    const ex = new StagehandDomExecutor(g.gw, anchorSessions(pairs).provider, cfg, undefined, undefined, undefined, sink.sink);
    const r = await ex.execute("sA", { type: "extract", instruction: "get rows", output: EXTRACT_OUT, rowAnchor: ROW_ANCHOR }, makeCtx());
    const rows = (r.extracted as { rows: Array<{ approval_id: string; doc_ref: string }> }).rows;
    check("rowAnchor: doc_ref 결정형 override(환각 1234→984261)", rows[0]?.doc_ref === "https://x/view/984261", rows[0]?.doc_ref);
    check("rowAnchor: doc_ref 없던 행도 결정형 세팅(955055)", rows[1]?.doc_ref === "https://x/view/955055", rows[1]?.doc_ref);
    check("rowAnchor: 강화 행을 typed artifact 로 영속(sink 1회, docId 포함)", sink.puts.length === 1 && sink.puts[0]!.content.includes("984261"));
    check("rowAnchor: 인박스 artifact ref 가 StepResult.artifacts 에 추가", r.artifacts.length === 2 && r.artifacts.includes("art://inbox-1" as ArtifactRef), r.artifacts.join(","));
  }

  // extract.rowAnchor: 매칭 없는(환각) 행 drop — DOM 에 없는 approval_id 는 제거(가짜 doc_ref 노출 금지). sink 미주입이어도 강화 동작.
  {
    const g = countingGateway({ parsedJson: { rows: [
      { approval_id: "IB-REAL", title: "real" },
      { approval_id: "IB-FAKE", title: "hallucinated whole row" }, // DOM 에 없음
    ] } });
    const pairs = [{ k: "IB-REAL", v: "javascript:ApprovalDocument.getView('111111','W');" }];
    const r = await new StagehandDomExecutor(g.gw, anchorSessions(pairs).provider, cfg).execute("sB", { type: "extract", instruction: "x", output: EXTRACT_OUT, rowAnchor: ROW_ANCHOR }, makeCtx());
    const rows = (r.extracted as { rows: Array<{ approval_id: string; doc_ref: string }> }).rows;
    check("rowAnchor: 매칭 없는 환각 행 drop(1행만 유지, doc_ref=111111)", rows.length === 1 && rows[0]?.approval_id === "IB-REAL" && rows[0]?.doc_ref === "https://x/view/111111", JSON.stringify(rows));
  }

  // extract.rowAnchor: 셀렉터 0매칭 → loud(IR_SCHEMA_INVALID; DOM 미settle/오셀렉터 — 조용한 false 금지).
  {
    const g = countingGateway({ parsedJson: { rows: [{ approval_id: "IB-001" }] } });
    const err = await caught(new StagehandDomExecutor(g.gw, anchorSessions([]).provider, cfg).execute("sC", { type: "extract", instruction: "x", output: EXTRACT_OUT, rowAnchor: ROW_ANCHOR }, makeCtx()));
    check("rowAnchor: 셀렉터 0매칭 → IR_SCHEMA_INVALID(loud)", err?.code === "IR_SCHEMA_INVALID");
  }

  // extract.rowAnchor 검증(coerceRowAnchor): 필드 누락 → loud.
  {
    const g = countingGateway({ parsedJson: { rows: [] } });
    const bad = { selector: "td.docu-num", matchField: "approval_id", attribute: "data-href", pattern: "x", template: "y" }; // field 누락
    const err = await caught(new StagehandDomExecutor(g.gw, anchorSessions([{ k: "a", v: "x" }]).provider, cfg).execute("sD", { type: "extract", instruction: "x", output: EXTRACT_OUT, rowAnchor: bad as never }, makeCtx()));
    check("rowAnchor: 필드 누락(field) → IR_SCHEMA_INVALID", err?.code === "IR_SCHEMA_INVALID");
  }

  // extract.rowAnchor 검증(coerceRowAnchor): 무효 정규식 → loud.
  {
    const g = countingGateway({ parsedJson: { rows: [] } });
    const bad = { selector: "td", matchField: "approval_id", field: "doc_ref", attribute: "data-href", pattern: "getView\\((", template: "y" }; // 무효 regex
    const err = await caught(new StagehandDomExecutor(g.gw, anchorSessions([{ k: "a", v: "x" }]).provider, cfg).execute("sE", { type: "extract", instruction: "x", output: EXTRACT_OUT, rowAnchor: bad }, makeCtx()));
    check("rowAnchor: 무효 정규식 → IR_SCHEMA_INVALID", err?.code === "IR_SCHEMA_INVALID");
  }

  // (재검증3 보완) rowAnchor: 행 측 빈/누락 approval_id(LLM 잡음)는 drop·오조인 안 함. 앵커가 깨끗하면 throw 없음(실 손실 아님).
  {
    const g = countingGateway({ parsedJson: { rows: [
      { approval_id: "IB-001", title: "ok" },
      { approval_id: "", title: "llm junk no id" },
    ] } });
    const pairs = [{ k: "IB-001", v: "javascript:ApprovalDocument.getView('111111','W');" }];
    const r = await new StagehandDomExecutor(g.gw, anchorSessions(pairs).provider, cfg).execute("sF", { type: "extract", instruction: "x", output: EXTRACT_OUT, rowAnchor: ROW_ANCHOR }, makeCtx());
    const rows = (r.extracted as { rows: Array<{ approval_id: string; doc_ref: string }> }).rows;
    check("rowAnchor: 행 측 빈 approval_id drop(앵커 클린→throw 없음, 오조인 없음)", rows.length === 1 && rows[0]?.approval_id === "IB-001" && rows[0]?.doc_ref.endsWith("111111"), JSON.stringify(rows));
  }

  // (재검증3 보완) rowAnchor: 빈 textContent 앵커(유효 href=실 문서) 배제 → 손실 → loud(coverage 가드 우회 차단).
  {
    const g = countingGateway({ parsedJson: { rows: [{ approval_id: "IB-001", title: "ok" }] } });
    const pairs = [
      { k: "", v: "javascript:ApprovalDocument.getView('777777','W');" }, // 빈키 앵커(실 문서)
      { k: "IB-001", v: "javascript:ApprovalDocument.getView('111111','W');" },
    ];
    const err = await caught(new StagehandDomExecutor(g.gw, anchorSessions(pairs).provider, cfg).execute("sFa", { type: "extract", instruction: "x", output: EXTRACT_OUT, rowAnchor: ROW_ANCHOR }, makeCtx()));
    check("rowAnchor: 빈키 앵커(실 문서) 손실 → IR_SCHEMA_INVALID(조용한 누락 금지)", err?.code === "IR_SCHEMA_INVALID");
  }

  // (재검증3 보완) rowAnchor: 중복 문서번호키(같은 키 다른 docId=둘 다 실 문서) 모호 배제 → 손실 → loud(WRONG doc_ref·조용한 누락 둘 다 금지).
  {
    const g = countingGateway({ parsedJson: { rows: [
      { approval_id: "IB-DUP", title: "dup" },
      { approval_id: "IB-OK", title: "ok" },
    ] } });
    const pairs = [
      { k: "IB-DUP", v: "javascript:ApprovalDocument.getView('111','W');" },
      { k: "IB-DUP", v: "javascript:ApprovalDocument.getView('222','W');" }, // 같은 키 다른 docId → 모호(둘 다 실 문서)
      { k: "IB-OK", v: "javascript:ApprovalDocument.getView('333','W');" },
    ];
    const err = await caught(new StagehandDomExecutor(g.gw, anchorSessions(pairs).provider, cfg).execute("sG", { type: "extract", instruction: "x", output: EXTRACT_OUT, rowAnchor: ROW_ANCHOR }, makeCtx()));
    check("rowAnchor: 중복키 모호(실 문서 2건) 손실 → IR_SCHEMA_INVALID", err?.code === "IR_SCHEMA_INVALID");
  }

  // (break-it 보완) rowAnchor: 전 행 키-조인 실패(포맷 드리프트) → loud(빈 인박스로 진성 결함 은폐 금지).
  {
    const g = countingGateway({ parsedJson: { rows: [{ approval_id: "IB-ZZZ" }] } });
    const pairs = [{ k: "IB-AAA", v: "javascript:ApprovalDocument.getView('111','W');" }];
    const err = await caught(new StagehandDomExecutor(g.gw, anchorSessions(pairs).provider, cfg).execute("sH", { type: "extract", instruction: "x", output: EXTRACT_OUT, rowAnchor: ROW_ANCHOR }, makeCtx()));
    check("rowAnchor: 전 행 키-조인 실패 → IR_SCHEMA_INVALID(loud)", err?.code === "IR_SCHEMA_INVALID");
  }

  // (break-it 보완) rowAnchor: attribute/pattern 전면 실패(byKey 0) → loud(드리프트 은폐 금지).
  {
    const g = countingGateway({ parsedJson: { rows: [{ approval_id: "IB-A" }] } });
    const pairs = [{ k: "IB-A", v: null }]; // attribute null(데이터 href 드리프트)
    const err = await caught(new StagehandDomExecutor(g.gw, anchorSessions(pairs).provider, cfg).execute("sI", { type: "extract", instruction: "x", output: EXTRACT_OUT, rowAnchor: ROW_ANCHOR }, makeCtx()));
    check("rowAnchor: attribute 전면 null(byKey 0) → IR_SCHEMA_INVALID(loud)", err?.code === "IR_SCHEMA_INVALID");
  }

  // (break-it 보완) rowAnchor: template 의 $ 시퀀스 리터럴 치환($& 미해석 — 결정형 값 보존).
  {
    const g = countingGateway({ parsedJson: { rows: [{ approval_id: "IB-A" }] } });
    const pairs = [{ k: "IB-A", v: "ref=a$&b" }];
    const dollarAnchor = { selector: "td.docu-num", matchField: "approval_id", field: "doc_ref", attribute: "data-href", pattern: "ref=(.+)", template: "https://x/view/$1" };
    const r = await new StagehandDomExecutor(g.gw, anchorSessions(pairs).provider, cfg).execute("sJ", { type: "extract", instruction: "x", output: EXTRACT_OUT, rowAnchor: dollarAnchor }, makeCtx());
    const rows = (r.extracted as { rows: Array<{ doc_ref: string }> }).rows;
    check("rowAnchor: template $ 리터럴 치환($& 미해석)", rows[0]?.doc_ref === "https://x/view/a$&b", rows[0]?.doc_ref);
  }

  // (재검증 보완) rowAnchor: LLM 이 rows:[] 인데 권위 앵커는 존재 → loud(빈 인박스로 추출 실패 은폐 금지).
  {
    const g = countingGateway({ parsedJson: { rows: [] } });
    const pairs = [{ k: "IB-A", v: "javascript:ApprovalDocument.getView('111','W');" }];
    const err = await caught(new StagehandDomExecutor(g.gw, anchorSessions(pairs).provider, cfg).execute("sK", { type: "extract", instruction: "x", output: EXTRACT_OUT, rowAnchor: ROW_ANCHOR }, makeCtx()));
    check("rowAnchor: LLM rows:[] + 앵커 존재 → IR_SCHEMA_INVALID(빈 인박스 은폐 금지)", err?.code === "IR_SCHEMA_INVALID");
  }

  // (재검증4 보완) rowAnchor: 빈 캡처(operator 가 \d* 등 빈-매치 가능 패턴 저작) → id 없는 doc_ref 방지 → 해소 불가 → loud.
  {
    const g = countingGateway({ parsedJson: { rows: [{ approval_id: "IB-A" }] } });
    const pairs = [{ k: "IB-A", v: "view/" }]; // 캡처 그룹이 빈 매치
    const emptyCapAnchor = { selector: "td.docu-num", matchField: "approval_id", field: "doc_ref", attribute: "data-href", pattern: "view/(\\d*)", template: "https://x/view/$1" };
    const err = await caught(new StagehandDomExecutor(g.gw, anchorSessions(pairs).provider, cfg).execute("sM", { type: "extract", instruction: "x", output: EXTRACT_OUT, rowAnchor: emptyCapAnchor }, makeCtx()));
    check("rowAnchor: 빈 캡처(id 없음) → IR_SCHEMA_INVALID(id-less doc_ref 방지)", err?.code === "IR_SCHEMA_INVALID");
  }

  // (재검증 보완) rowAnchor: 부분 under-coverage(권위 앵커 2 중 1만 행에 매칭) → loud(불완전 인박스 은폐 금지).
  {
    const g = countingGateway({ parsedJson: { rows: [{ approval_id: "IB-A" }] } });
    const pairs = [
      { k: "IB-A", v: "javascript:ApprovalDocument.getView('111','W');" },
      { k: "IB-B", v: "javascript:ApprovalDocument.getView('222','W');" }, // 권위 앵커지만 LLM 누락
    ];
    const err = await caught(new StagehandDomExecutor(g.gw, anchorSessions(pairs).provider, cfg).execute("sL", { type: "extract", instruction: "x", output: EXTRACT_OUT, rowAnchor: ROW_ANCHOR }, makeCtx()));
    check("rowAnchor: 부분 under-coverage(앵커 2/1 누락) → IR_SCHEMA_INVALID(누락 은폐 금지)", err?.code === "IR_SCHEMA_INVALID");
  }

  // observe → success
  {
    const r = await new StagehandDomExecutor(countingGateway({ stagehandCallId: "90000000-0000-0000-0000-000000000001" }).gw, sess(), cfg).execute("s2", { type: "observe", instruction: "find next" }, makeCtx());
    check(
      "observe: success read_only + durable call id",
      r.status === "success" && r.sideEffect?.kind === "read_only" && r.stagehandCallIds?.[0] === "90000000-0000-0000-0000-000000000001",
    );
  }

  // act (no cache) → LLM plan → CDP click 적용
  {
    const s = fakeSessions();
    const r = await new StagehandDomExecutor(countingGateway({ parsedJson: CLICK_PLAN }).gw, s.provider, cfg).execute("s3", { type: "act", instruction: "click login" }, makeCtx());
    check("act: applied click via CDP", r.status === "success" && s.ops.includes("click:#login"));
    check("act: sideEffect default=update, cache=bypass", r.sideEffect?.kind === "update" && r.cache.mode === "bypass");
  }

  // act with declared sideEffect=submit
  {
    const s = fakeSessions();
    const r = await new StagehandDomExecutor(countingGateway({ parsedJson: CLICK_PLAN }).gw, s.provider, cfg).execute("s4", { type: "act", instruction: "submit", sideEffect: "submit" }, makeCtx());
    check("act: declared sideEffect=submit honored", r.sideEffect?.kind === "submit");
  }

  // act fill plan → CDP fill
  {
    const s = fakeSessions();
    await new StagehandDomExecutor(countingGateway({ parsedJson: { operation: "fill", selector: "#q", value: "hello" } }).gw, s.provider, cfg).execute("s5", { type: "act", instruction: "type query" }, makeCtx());
    check("act: applied fill via CDP", s.ops.includes("fill:#q=hello"));
  }

  // act valueRef(비-secret 결정형 fill): LLM 은 selector 만, 채울 값은 IR/params 의 a.value 로 고정(LLM 추측 value 무시).
  {
    const s = fakeSessions();
    // LLM 이 다른 value("llm-guess")를 줘도 valueRef intent + a.value("반려 사유")로 override 되어 fill 된다(결정형).
    await new StagehandDomExecutor(countingGateway({ parsedJson: { operation: "fill", selector: "#reason", value: "llm-guess" } }).gw, s.provider, cfg)
      .execute("s5b", { type: "act", instruction: "fill reason", valueRef: "reason", value: "반려 사유" }, makeCtx());
    check("act valueRef: filled literal value (LLM value overridden)", s.ops.includes("fill:#reason=반려 사유") && !s.ops.includes("fill:#reason=llm-guess"), s.ops.join(","));
  }

  // act valueRef 인데 LLM plan 이 fill 아님(click) → IR_SCHEMA_INVALID(조용한 무시 금지, secretRef 와 대칭).
  {
    const err = await caught(
      new StagehandDomExecutor(countingGateway({ parsedJson: CLICK_PLAN }).gw, sess(), cfg)
        .execute("s5c", { type: "act", instruction: "fill reason", valueRef: "reason", value: "x" }, makeCtx()),
    );
    check("act valueRef: non-fill plan → IR_SCHEMA_INVALID", err?.code === "IR_SCHEMA_INVALID");
  }

  // act valueRef intent 인데 value 미해소(run params 부재) + LLM 이 환각 value 를 줘도 → loud throw(무음 fill 거부, break-it 후속).
  {
    const s = fakeSessions();
    const err = await caught(
      new StagehandDomExecutor(countingGateway({ parsedJson: { operation: "fill", selector: "#reason", value: "llm-hallucinated" } }).gw, s.provider, cfg)
        .execute("s5d", { type: "act", instruction: "fill reason", valueRef: "reason" }, makeCtx()),
    );
    check("act valueRef + value 미해소 → IR_SCHEMA_INVALID(LLM 환각 value 무음 fill 거부)", err?.code === "IR_SCHEMA_INVALID" && !s.ops.some((o) => o.startsWith("fill:")), `${err?.code} ops=${s.ops.join(",")}`);
  }

  // act click_selector: 결정형 클릭(LLM 전혀 미경유) — settle 통과 후 그 셀렉터 클릭, gateway 미호출.
  {
    const g = countingGateway({ parsedJson: { operation: "click", selector: "#never" } });
    const s = clickSessions(true);
    const r = await new StagehandDomExecutor(g.gw, s.provider, cfg).execute("c1", { type: "act", instruction: "결재 클릭", clickSelector: 'button[onclick*="getApprovalLayer"]' }, makeCtx());
    check("act click_selector: 결정형 클릭(LLM 미경유, gateway 0)", r.status === "success" && g.calls() === 0 && s.ops.includes('click:button[onclick*="getApprovalLayer"]'), `calls=${g.calls()} ops=${s.ops.join(",")}`);
  }

  // act click_selector 미존재 → settle 초과 loud(IR_SCHEMA_INVALID, 클릭 0 — 조용한 무성공 금지).
  {
    const prev = process.env.DET_CLICK_SETTLE_MS;
    process.env.DET_CLICK_SETTLE_MS = "60";
    const s = clickSessions(false);
    const err = await caught(new StagehandDomExecutor(countingGateway().gw, s.provider, cfg).execute("c2", { type: "act", instruction: "click", clickSelector: "#missing" }, makeCtx()));
    process.env.DET_CLICK_SETTLE_MS = prev;
    check("act click_selector 미존재 → IR_SCHEMA_INVALID(settle 초과 loud, 클릭 0)", err?.code === "IR_SCHEMA_INVALID" && s.ops.length === 0, `${err?.code} ops=${s.ops.join(",")}`);
  }

  // (break-it 보완) click_selector(radio): 클릭 후 checked → 성공.
  {
    const s = detSessions({ present: true, checkState: "checked" });
    const r = await new StagehandDomExecutor(countingGateway().gw, s.provider, cfg).execute("c3", { type: "act", instruction: "승인 라디오", clickSelector: 'input[name="approval_value"][value="2"]' }, makeCtx());
    check("click_selector radio: 클릭 후 checked → success", r.status === "success" && s.ops.includes('click:input[name="approval_value"][value="2"]'), s.ops.join(","));
  }

  // (break-it 보완) click_selector(radio): 클릭 후 미선택(unchecked, 무효 클릭) → loud(잘못된 값 커밋 방지).
  {
    const s = detSessions({ present: true, checkState: "unchecked" });
    const err = await caught(new StagehandDomExecutor(countingGateway().gw, s.provider, cfg).execute("c4", { type: "act", instruction: "승인 라디오", clickSelector: 'input[name="approval_value"][value="2"]' }, makeCtx()));
    check("click_selector radio 미선택 → IR_SCHEMA_INVALID(무효 클릭 loud)", err?.code === "IR_SCHEMA_INVALID");
  }

  // (break-it 보완) assert_absent: 셀렉터 부재 → 성공(커밋 witness 충족).
  {
    const s = detSessions({ absent: true });
    const r = await new StagehandDomExecutor(countingGateway().gw, s.provider, cfg).execute("c5", { type: "act", instruction: "커밋 witness", assertAbsent: 'button[onclick*="getApprovalLayer"]' }, makeCtx());
    check("assert_absent: 셀렉터 부재 → success(커밋됨)", r.status === "success" && s.ops.length === 0, s.ops.join(","));
  }

  // (break-it 보완) assert_absent: 셀렉터 잔존 → settle 초과 loud(효과 미반영=커밋 실패를 success 로 은폐 금지).
  {
    const prev = process.env.DET_CLICK_SETTLE_MS;
    process.env.DET_CLICK_SETTLE_MS = "60";
    const s = detSessions({ absent: false });
    const err = await caught(new StagehandDomExecutor(countingGateway().gw, s.provider, cfg).execute("c6", { type: "act", instruction: "커밋 witness", assertAbsent: "button.x" }, makeCtx()));
    process.env.DET_CLICK_SETTLE_MS = prev;
    check("assert_absent 잔존 → IR_SCHEMA_INVALID(거짓 성공 차단)", err?.code === "IR_SCHEMA_INVALID");
  }

  // ActionPlanCache MISS → LLM 호출 + put + mode=miss
  {
    const s = fakeSessions();
    const g = countingGateway({ parsedJson: CLICK_PLAN });
    const c = fakeCache();
    const r = await new StagehandDomExecutor(g.gw, s.provider, cfg, c.cache).execute("s6", { type: "act", instruction: "click login" }, makeCtx());
    check("act cache miss: LLM called + put + mode=miss", g.calls() === 1 && c.calls.put === 1 && r.cache.mode === "miss" && s.ops.includes("click:#login"));
  }

  // ActionPlanCache HIT → LLM 미호출, plan 재생, mode=hit
  {
    const s = fakeSessions();
    const g = countingGateway({ parsedJson: { operation: "fill", selector: "#never", value: "x" } }); // 호출되면 안 됨
    const c = fakeCache(CLICK_PLAN);
    const r = await new StagehandDomExecutor(g.gw, s.provider, cfg, c.cache).execute("s7", { type: "act", instruction: "click login" }, makeCtx());
    check("act cache hit: LLM NOT called, replayed click, mode=hit", g.calls() === 0 && r.cache.mode === "hit" && s.ops.includes("click:#login") && r.cache.actionPlanCacheId === undefined);
    check("act cache hit: auto-installs network JSON capture before replay", s.evals.some((expr) => expr.includes("__RPA_NETWORK_CAPTURE_INSTALLED__")));
  }

  // P0a+ self-heal: 캐시 HIT plan 적용 실패 → markSuspect 강등 + 조용한 성공 금지(원 예외 전파, 다음 run 재해석)
  {
    const s = fakeSessions("<body><main>hello</main></body>", { clickThrows: true });
    const g = countingGateway({ parsedJson: { operation: "fill", selector: "#never", value: "x" } }); // 호출되면 안 됨
    const c = fakeCache(CLICK_PLAN); // hit
    let failed = false;
    try {
      const r = await new StagehandDomExecutor(g.gw, s.provider, cfg, c.cache).execute("s7b", { type: "act", instruction: "click login" }, makeCtx());
      failed = r.status !== "success";
    } catch {
      failed = true;
    }
    check("act cache hit apply-fail: markSuspect demote + no silent success + LLM not called", c.calls.suspect === 1 && failed && g.calls() === 0);
  }

  // P0b self-heal 재시도: ctx.selfHealRetry → executeAct 가 markSuspect 강등(실 캐시면 다음 get 이 miss → 재해소).
  {
    const s = fakeSessions();
    const c = fakeCache(CLICK_PLAN);
    await new StagehandDomExecutor(countingGateway({ parsedJson: CLICK_PLAN }).gw, s.provider, cfg, c.cache).execute("s7c", { type: "act", instruction: "click login" }, makeCtx({ selfHealRetry: true }));
    check("act selfHealRetry: markSuspect 강등 호출", c.calls.suspect === 1);
  }
  // 회귀: 정상(비-재시도) hit 은 markSuspect 호출 안 함(강등은 selfHealRetry 시에만).
  {
    const s = fakeSessions();
    const c = fakeCache(CLICK_PLAN);
    await new StagehandDomExecutor(countingGateway({ parsedJson: CLICK_PLAN }).gw, s.provider, cfg, c.cache).execute("s7d", { type: "act", instruction: "click login" }, makeCtx());
    check("act 정상 hit: markSuspect 미호출", c.calls.suspect === 0);
  }

  // act malformed plan → failed_system(LLM_MALFORMED_OUTPUT)
  {
    const r = await new StagehandDomExecutor(countingGateway({ parsedJson: { nope: true } }).gw, sess(), cfg).execute("s8", { type: "act", instruction: "x" }, makeCtx());
    check("act malformed plan → failed_system", r.status === "failed_system" && r.exception?.code === "LLM_MALFORMED_OUTPUT");
  }

  // 비-dom 액션 → EXECUTOR_CAPABILITY_MISMATCH
  check("utility 'navigate' → EXECUTOR_CAPABILITY_MISMATCH", (await caught(new StagehandDomExecutor(countingGateway().gw, sess(), cfg).execute("s9", { type: "navigate", url: "u" }, makeCtx())))?.code === "EXECUTOR_CAPABILITY_MISMATCH");

  // instruction 누락 → IR_SCHEMA_INVALID
  check("act without instruction → IR_SCHEMA_INVALID", (await caught(new StagehandDomExecutor(countingGateway().gw, sess(), cfg).execute("s10", { type: "act" }, makeCtx())))?.code === "IR_SCHEMA_INVALID");

  // 사전 abort → RUN_ABORTED
  {
    const ac = new AbortController(); ac.abort();
    check("pre-abort → RUN_ABORTED", (await caught(new StagehandDomExecutor(countingGateway().gw, sess(), cfg).execute("s11", { type: "act", instruction: "x" }, makeCtx({ abortSignal: ac.signal }))))?.code === "RUN_ABORTED");
  }

  // GatewayError(business) → failed_business / (system) → failed_system
  {
    const rb = await new StagehandDomExecutor(errGateway("EXTRACT_SCHEMA_INVALID"), sess(), cfg).execute("s12", { type: "extract", instruction: "x", output: EXTRACT_OUT }, makeCtx());
    check("GatewayError EXTRACT_SCHEMA_INVALID → failed_business", rb.status === "failed_business" && rb.exception?.class === "business");
    const rs = await new StagehandDomExecutor(errGateway("LLM_BUDGET_EXCEEDED"), sess(), cfg).execute("s13", { type: "act", instruction: "x" }, makeCtx());
    check("GatewayError LLM_BUDGET_EXCEEDED → failed_system", rs.status === "failed_system" && rs.exception?.class === "system");
  }

  // verify → 비대상 throw
  check("verify → EXECUTOR_CAPABILITY_MISMATCH", (await caught(new StagehandDomExecutor(countingGateway().gw, sess(), cfg).verify({ type: "vlm" }, makeCtx())))?.code === "EXECUTOR_CAPABILITY_MISMATCH");

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D3 StagehandDomExecutor act-apply + Gateway unit green");
  process.exit(0);
}

main().catch((e) => {
  console.error("unit fatal:", e);
  process.exit(1);
});
