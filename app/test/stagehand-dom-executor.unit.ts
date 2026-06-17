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
import type { LLMResponse } from "../../ts/security-middleware-contract";
import type { CdpSession, CdpSessionProvider } from "../src/executor/cdp-session";
import { GatewayError } from "../src/gateway/llm-gateway";
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
  const gw: LlmGatewayCaller = {
    call: async () => {
      n += 1;
      return { outputRef: "art://out" as ArtifactRef, usage: { inputTokens: 1, outputTokens: 1, cost: 0 }, finishReason: "stop", ...resp };
    },
  };
  return { gw, calls: () => n };
}
const errGateway = (code: ErrorCode): LlmGatewayCaller => ({ call: async () => { throw new GatewayError(code, "boom"); } });

function fakeSessions() {
  const ops: string[] = [];
  const session: CdpSession = {
    url: () => "u",
    goto: async () => {},
    reload: async () => {},
    evaluate: async () => undefined as never,
    sendCDP: async () => undefined as never,
    click: async (s) => void ops.push(`click:${s}`),
    fill: async (s, v) => void ops.push(`fill:${s}=${v}`),
    selectOption: async (s, v) => void ops.push(`select:${s}=${v}`),
    setInputFiles: async () => {},
    downloadDir: () => "/tmp",
    waitForDownload: async () => true,
    close: async () => {},
  };
  return { provider: { forLease: () => session } as CdpSessionProvider, ops };
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

async function main(): Promise<void> {
  const sess = () => fakeSessions().provider;

  check("capabilities: {dom:true, vision:false, utility:false}", (() => {
    const c = new StagehandDomExecutor(countingGateway().gw, sess(), cfg).capabilities();
    return c.dom === true && c.vision === false && c.utility === false;
  })());

  // extract → read-only, extracted set, output.rowCount = {rows} 길이(표준 노드 출력 투영, ir-expression §2)
  {
    const ex = new StagehandDomExecutor(countingGateway({ parsedJson: { rows: [1, 2, 3] } }).gw, sess(), cfg);
    const r = await ex.execute("s1", { type: "extract", instruction: "get reviews", output: EXTRACT_OUT }, makeCtx());
    check(
      "extract: success + extracted + artifacts + output.rowCount=3",
      r.status === "success" && (r.extracted as { rows: number[] }).rows.length === 3 && r.artifacts[0] === "art://out" && (r.output as { rowCount?: number }).rowCount === 3,
    );
  }

  // extract: rows 봉투 없으면 rowCount 미산출(→ node.row_count 미투영, loud).
  {
    const ex = new StagehandDomExecutor(countingGateway({ parsedJson: { product: "x" } }).gw, sess(), cfg);
    const r = await ex.execute("s1b", { type: "extract", instruction: "get product", output: EXTRACT_OUT }, makeCtx());
    check("extract: rows 부재 → output.rowCount 미산출", (r.output as { rowCount?: number }).rowCount === undefined);
  }

  // observe → success
  {
    const r = await new StagehandDomExecutor(countingGateway().gw, sess(), cfg).execute("s2", { type: "observe", instruction: "find next" }, makeCtx());
    check("observe: success read_only", r.status === "success" && r.sideEffect?.kind === "read_only");
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

  // act value(비-secret 결정형 fill): LLM 은 selector 만, 채울 값은 IR/params 의 a.value 로 고정(LLM 추측 value 무시).
  {
    const s = fakeSessions();
    // LLM 이 다른 value("llm-guess")를 줘도 a.value("반려 사유")로 override 되어 fill 된다(결정형).
    await new StagehandDomExecutor(countingGateway({ parsedJson: { operation: "fill", selector: "#reason", value: "llm-guess" } }).gw, s.provider, cfg)
      .execute("s5b", { type: "act", instruction: "fill reason", value: "반려 사유" }, makeCtx());
    check("act value: filled literal value (LLM value overridden)", s.ops.includes("fill:#reason=반려 사유") && !s.ops.includes("fill:#reason=llm-guess"), s.ops.join(","));
  }

  // act value 인데 LLM plan 이 fill 아님(click) → IR_SCHEMA_INVALID(조용한 무시 금지, secretRef 와 대칭).
  {
    const err = await caught(
      new StagehandDomExecutor(countingGateway({ parsedJson: CLICK_PLAN }).gw, sess(), cfg)
        .execute("s5c", { type: "act", instruction: "fill reason", value: "x" }, makeCtx()),
    );
    check("act value: non-fill plan → IR_SCHEMA_INVALID", err?.code === "IR_SCHEMA_INVALID");
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
    check("act cache hit: LLM NOT called, replayed click, mode=hit", g.calls() === 0 && r.cache.mode === "hit" && s.ops.includes("click:#login") && (r.cache.actionPlanCacheId?.length ?? 0) > 0);
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
