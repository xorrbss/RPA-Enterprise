/**
 * D3 LLM 절반 단위 테스트 — StagehandDomExecutor ↔ LLM Gateway 연결(architecture §9.1 step2 / llm-gateway §1).
 *
 * 주입형 fake Gateway 로 키/네트워크 없이 검증: act/observe/extract → Gateway.call → StepResult 매핑,
 * 비-dom 액션 거부, GatewayError 분류 환원. 실행: `tsx test/stagehand-dom-executor.unit.ts`.
 */
import type { ArtifactRef, PageState, RunContext, StepResult } from "../../ts/core-types";
import type { ErrorCode } from "../../ts/error-catalog";
import type { LLMResponse } from "../../ts/security-middleware-contract";
import { GatewayError } from "../src/gateway/llm-gateway";
import { StagehandDomExecutor, StagehandDomExecutorError, type LlmGatewayCaller } from "../src/executor/stagehand-dom-executor";

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
    runId: "run-1",
    tenantId: "t-1",
    nodeId: "n-1",
    siteProfileId: "site-1",
    browserIdentityId: "bid-1",
    networkPolicyId: "np-1",
    leaseId: "lease-1",
    assetRefs: {},
    abortSignal: new AbortController().signal,
    pageState: ps,
    ...over,
  };
}

const cfg = { model: "codex", promptTemplateVersion: "v1", budget: { maxInputTokens: 10000, maxOutputTokens: 4096, maxCost: 0.85 } };

const okGateway = (resp: Partial<LLMResponse> = {}): LlmGatewayCaller => ({
  call: async () => ({ outputRef: "art://out" as ArtifactRef, usage: { inputTokens: 1, outputTokens: 1, cost: 0 }, finishReason: "stop", ...resp }),
});
const errGateway = (code: ErrorCode): LlmGatewayCaller => ({
  call: async () => {
    throw new GatewayError(code, "boom");
  },
});

const EXTRACT_OUT = { schemaRef: "reviews", schemaVersion: "1", strict: true };

async function caught(p: Promise<unknown>): Promise<StagehandDomExecutorError | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e instanceof StagehandDomExecutorError ? e : undefined;
  }
}

async function main(): Promise<void> {
  // capabilities
  check("capabilities: {dom:true, vision:false, utility:false}", (() => {
    const c = new StagehandDomExecutor(okGateway(), cfg).capabilities();
    return c.dom === true && c.vision === false && c.utility === false;
  })());

  // extract → Gateway.call → StepResult.extracted
  {
    const ex = new StagehandDomExecutor(okGateway({ parsedJson: { rows: [1, 2, 3] } }), cfg);
    const r: StepResult = await ex.execute("s1", { type: "extract", instruction: "get reviews", output: EXTRACT_OUT }, makeCtx());
    check("extract: success + extracted set", r.status === "success" && r.action === "extract" && (r.extracted as { rows: number[] }).rows.length === 3);
    check("extract: artifacts+stagehandCallIds linked", r.artifacts[0] === "art://out" && (r.stagehandCallIds?.length ?? 0) === 1);
  }

  // act → success, read_only, no extracted
  {
    const r = await new StagehandDomExecutor(okGateway(), cfg).execute("s2", { type: "act", instruction: "click login" }, makeCtx());
    check("act: success read_only, no extracted", r.status === "success" && r.sideEffect?.kind === "read_only" && r.extracted === undefined);
  }

  // observe → success
  {
    const r = await new StagehandDomExecutor(okGateway(), cfg).execute("s3", { type: "observe", instruction: "find next page" }, makeCtx());
    check("observe: success", r.status === "success" && r.action === "observe");
  }

  // 비-dom 액션(navigate=utility) → EXECUTOR_CAPABILITY_MISMATCH
  {
    const err = await caught(new StagehandDomExecutor(okGateway(), cfg).execute("s4", { type: "navigate", url: "https://x" }, makeCtx()));
    check("utility action 'navigate' → EXECUTOR_CAPABILITY_MISMATCH", err?.code === "EXECUTOR_CAPABILITY_MISMATCH");
  }

  // instruction 누락 → IR_SCHEMA_INVALID
  {
    const err = await caught(new StagehandDomExecutor(okGateway(), cfg).execute("s5", { type: "act" }, makeCtx()));
    check("act without instruction → IR_SCHEMA_INVALID", err?.code === "IR_SCHEMA_INVALID");
  }

  // 사전 abort → RUN_ABORTED
  {
    const ac = new AbortController();
    ac.abort();
    const err = await caught(new StagehandDomExecutor(okGateway(), cfg).execute("s6", { type: "act", instruction: "x" }, makeCtx({ abortSignal: ac.signal })));
    check("pre-abort → RUN_ABORTED", err?.code === "RUN_ABORTED");
  }

  // GatewayError(business) → failed_business StepResult(분류 보존)
  {
    const r = await new StagehandDomExecutor(errGateway("EXTRACT_SCHEMA_INVALID"), cfg).execute("s7", { type: "extract", instruction: "x", output: EXTRACT_OUT }, makeCtx());
    check("GatewayError EXTRACT_SCHEMA_INVALID → failed_business + exception", r.status === "failed_business" && r.exception?.code === "EXTRACT_SCHEMA_INVALID" && r.exception?.class === "business");
  }

  // GatewayError(system) → failed_system
  {
    const r = await new StagehandDomExecutor(errGateway("LLM_BUDGET_EXCEEDED"), cfg).execute("s8", { type: "act", instruction: "x" }, makeCtx());
    check("GatewayError LLM_BUDGET_EXCEEDED → failed_system", r.status === "failed_system" && r.exception?.class === "system");
  }

  // verify → 비대상 throw
  {
    const err = await caught(new StagehandDomExecutor(okGateway(), cfg).verify({ type: "vlm" }, makeCtx()));
    check("verify → EXECUTOR_CAPABILITY_MISMATCH (vision executor 소관)", err?.code === "EXECUTOR_CAPABILITY_MISMATCH");
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D3 StagehandDomExecutor ↔ Gateway unit green");
  process.exit(0);
}

main().catch((e) => {
  console.error("unit fatal:", e);
  process.exit(1);
});
