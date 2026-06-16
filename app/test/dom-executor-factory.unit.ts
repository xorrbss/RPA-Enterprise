/**
 * 단위 — createDomUtilityExecutorFactory(P5b). worker executorFactory seam 용 production 팩토리 빌더가
 * CompositeExecutor(StagehandDomExecutor(gateway), UtilityExecutor) 를 올바로 배선하는지 검증. 외부 의존 없음(fake gateway,
 * CDP 미사용 — extract 는 게이트웨이 전용). 실행: tsx test/dom-executor-factory.unit.ts.
 *
 * 검증: capabilities=dom+utility 합성 · extract(dom) → 게이트웨이 1회 + success(policy.model 전달 확인) · navigate(utility)
 *  → forLease(provider) 경유(게이트웨이 미호출) = composite 라우팅 분리. run-scoped 컨텍스트(scenarioVersionId/
 *  browserIdentityVersion) 의 seam 전달은 worker int(runtime-worker-drive.int)가 핀고정.
 */
import type { ExecutorPlugin, PageState, RunContext } from "../../ts/core-types";
import type { LLMRequest, LLMResponse } from "../../ts/security-middleware-contract";
import type { CdpSessionProvider } from "../src/executor/cdp-session";
import type { LlmGatewayCaller } from "../src/executor/stagehand-dom-executor";
import { createDomUtilityExecutorFactory } from "../src/runtime/dom-executor-factory";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

let gatewayCalls = 0;
let lastModel: string | undefined;
const fakeGateway: LlmGatewayCaller = {
  call: async (req: LLMRequest): Promise<LLMResponse> => {
    gatewayCalls += 1;
    lastModel = (req as { model?: string }).model;
    return {
      outputRef: "art://out",
      usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
      finishReason: "stop",
      parsedJson: { rows: [1, 2], row_count: 2 },
    } as unknown as LLMResponse;
  },
};

const policy = { model: "codex", promptTemplateVersion: "v1", budget: { maxInputTokens: 10000, maxOutputTokens: 4096, maxCost: 0.85 } };

// extract(read-only)는 forLease 미사용 → throwing provider 로 "CDP 미경유" 보장. navigate(utility)는 forLease 호출 → throw 로 라우팅 증명.
const throwingProvider = {
  forLease: () => {
    throw new Error("forLease-called");
  },
} as unknown as CdpSessionProvider;

const cannedPageState: PageState = {
  url: { raw: "about:blank", canonical: "about:blank", pattern: "about:blank" },
  dom: { structuralHash: "seed", visibleTextHash: "seed", landmarks: [], frames: [] },
  auth: "anonymous",
  flags: {},
  matchedWhere: [],
};
function ctx(): RunContext {
  return {
    runId: "r", tenantId: "11111111-1111-1111-1111-111111111111", nodeId: "n", attempt: 0,
    siteProfileId: "s", browserIdentityId: "b", networkPolicyId: "np", leaseId: "l",
    assetRefs: {}, abortSignal: new AbortController().signal, pageState: cannedPageState,
  };
}

async function main(): Promise<void> {
  const factory = createDomUtilityExecutorFactory(fakeGateway, policy);
  const executor: ExecutorPlugin = factory(throwingProvider, { scenarioVersionId: "sv-1", browserIdentityVersion: 3 });

  // 1) capabilities = dom(StagehandDom) + utility(Utility) 합성.
  const caps = executor.capabilities();
  check("capabilities dom:true·vision:false·utility:true (composite)", caps.dom === true && caps.vision === false && caps.utility === true, JSON.stringify(caps));

  // 2) extract(dom) → composite 가 dom 으로 라우팅 → dom 이 게이트웨이 호출(policy.model 전달) → success.
  const res = await executor.execute(
    "n.0",
    { type: "extract", instruction: "get rows", output: { schemaRef: "reviews", schemaVersion: "1", strict: true } },
    ctx(),
  );
  check("extract → dom executor → 게이트웨이 1회 호출", gatewayCalls === 1, String(gatewayCalls));
  check("extract → policy.model('codex') 게이트웨이 요청에 전달", lastModel === "codex", String(lastModel));
  check("extract → success StepResult(action=extract)", res.status === "success" && res.action === "extract", JSON.stringify({ status: res.status, action: res.action }));

  // 3) navigate(utility) → composite 가 utility 로 라우팅 → UtilityExecutor 가 forLease(provider) 호출(throw) — 게이트웨이 미경유.
  let utilityRouted = false;
  try {
    await executor.execute("n.1", { type: "navigate", url: "https://x.example/" }, ctx());
  } catch (e) {
    utilityRouted = /forLease-called/.test(String(e));
  }
  check("navigate → utility 로 라우팅(forLease 경유, 게이트웨이 미경유)", utilityRouted && gatewayCalls === 1, `utilityRouted=${utilityRouted} gatewayCalls=${gatewayCalls}`);

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: createDomUtilityExecutorFactory — composite(dom gateway + utility) 배선·라우팅 (P5b)");
  process.exit(0);
}

main().catch((e) => {
  console.error("dom-executor-factory unit fatal:", e);
  process.exit(1);
});
