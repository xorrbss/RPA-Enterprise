/**
 * 단위 — createDomUtilityExecutorFactory(P5b). worker executorFactory seam 용 production 팩토리 빌더가
 * CompositeExecutor(StagehandDomExecutor(gateway), UtilityExecutor) 를 올바로 배선하는지 검증. 외부 의존 없음(fake gateway,
 * fake CDP). 실행: tsx test/dom-executor-factory.unit.ts.
 *
 * 검증: capabilities=dom+utility 합성 · extract(dom) → network capture install + DOM snapshot + challenge probe + 게이트웨이 1회 + success(policy.model 전달 확인) · navigate(utility)
 *  → forLease(provider) 경유(게이트웨이 미호출) = composite 라우팅 분리. run-scoped 컨텍스트(scenarioVersionId/
 *  browserIdentityVersion) 의 seam 전달은 worker int(runtime-worker-drive.int)가 핀고정.
 */
import type { ExecutorPlugin, PageState, RunContext } from "../../ts/core-types";
import type { AuthenticatedPrincipal, LLMRequest, LLMResponse, SecretStoreBoundary } from "../../ts/security-middleware-contract";
import type { CdpSession, CdpSessionProvider } from "../src/executor/cdp-session";
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
let lastUserMessage = "";
const fakeGateway: LlmGatewayCaller = {
  call: async (req: LLMRequest): Promise<LLMResponse> => {
    gatewayCalls += 1;
    lastModel = (req as { model?: string }).model;
    const content = req.messages.find((m) => m.role === "user")?.content;
    lastUserMessage = typeof content === "string" ? content : JSON.stringify(content ?? "");
    return {
      outputRef: "art://out",
      usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
      finishReason: "stop",
      parsedJson: { rows: [1, 2], row_count: 2 },
    } as unknown as LLMResponse;
  },
};

const policy = { model: "codex", promptTemplateVersion: "v1", budget: { maxInputTokens: 10000, maxOutputTokens: 4096, maxCost: 0.85 } };

let evaluateCalls = 0;
let gotoCalls = 0;
const fakeSession: CdpSession = {
  url: () => "https://x.example/",
  goto: async () => {
    gotoCalls += 1;
    throw new Error("goto-called");
  },
  reload: async () => {},
  evaluate: async () => {
    evaluateCalls += 1;
    return "<body><table><tr><td>Review A</td></tr></table></body>" as never;
  },
  sendCDP: async () => undefined as never,
  click: async () => {},
  fill: async () => {},
  selectOption: async () => {},
  setInputFiles: async () => {},
  downloadDir: () => "/tmp",
  waitForDownload: async () => true,
  close: async () => {},
};
const fakeProvider = {
  forLease: () => fakeSession,
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
  const executor: ExecutorPlugin = factory(fakeProvider, { scenarioVersionId: "sv-1", browserIdentityVersion: 3 });

  // 1) capabilities = dom(StagehandDom) + utility(Utility) 합성.
  const caps = executor.capabilities();
  check("capabilities dom:true·vision:false·utility:true (composite)", caps.dom === true && caps.vision === false && caps.utility === true, JSON.stringify(caps));

  // 2) extract(dom) → composite 가 dom 으로 라우팅 → dom 이 게이트웨이 호출(policy.model 전달) → success.
  const res = await executor.execute(
    "n.0",
    { type: "extract", instruction: "get rows", output: { schemaRef: "reviews", schemaVersion: "1", strict: true } },
    ctx(),
  );
  check("extract → network capture install + DOM snapshot + challenge probe evaluate 3회", evaluateCalls === 3, String(evaluateCalls));
  check("extract → DOM snapshot included in gateway user message", lastUserMessage.includes("Review A"));
  check("extract → dom executor → 게이트웨이 1회 호출", gatewayCalls === 1, String(gatewayCalls));
  check("extract → policy.model('codex') 게이트웨이 요청에 전달", lastModel === "codex", String(lastModel));
  check("extract → success StepResult(action=extract)", res.status === "success" && res.action === "extract", JSON.stringify({ status: res.status, action: res.action }));

  lastModel = undefined;
  const overrideExecutor: ExecutorPlugin = factory(fakeProvider, {
    scenarioVersionId: "sv-2",
    browserIdentityVersion: 3,
    model: "codex-run-override",
  });
  await overrideExecutor.execute("n.override", { type: "observe", instruction: "inspect current page" }, ctx());
  check("run.model override → gateway request model", lastModel === "codex-run-override", String(lastModel));

  // 3) navigate(utility) → composite 가 utility 로 라우팅 → UtilityExecutor 가 forLease(provider) 호출(throw) — 게이트웨이 미경유.
  const gatewayCallsBeforeNavigate = gatewayCalls;
  let utilityRouted = false;
  try {
    await executor.execute("n.1", { type: "navigate", url: "https://x.example/" }, ctx());
  } catch (e) {
    utilityRouted = /goto-called/.test(String(e));
  }
  check("navigate → utility 로 라우팅(goto 경유, 게이트웨이 미경유)", utilityRouted && gotoCalls === 1 && gatewayCalls === gatewayCallsBeforeNavigate, `utilityRouted=${utilityRouted} gatewayCalls=${gatewayCalls} before=${gatewayCallsBeforeNavigate} gotoCalls=${gotoCalls}`);

  // 4) deps.extractArtifactSink 가 executor 로 스레드돼 extract.rowAnchor 강화 행을 typed artifact 로 영속하는가(P1 prod 배선).
  {
    const puts: string[] = [];
    const sink = { put: async (content: string) => { puts.push(content); return "art://inbox" as never; } };
    const gw: LlmGatewayCaller = {
      call: async () => ({ outputRef: "art://o", usage: { inputTokens: 1, outputTokens: 1, cost: 0 }, finishReason: "stop", parsedJson: { rows: [{ approval_id: "IB-1" }] } }) as unknown as LLMResponse,
    };
    const sess: CdpSession = { ...fakeSession, evaluate: async (expr: string) => (String(expr).includes("getAttribute") ? [{ k: "IB-1", v: "ApprovalDocument.getView('999')" }] : "<body>x</body>") as never };
    const prov = { forLease: () => sess } as unknown as CdpSessionProvider;
    const ex2 = createDomUtilityExecutorFactory(gw, policy, { extractArtifactSink: sink })(prov, { scenarioVersionId: "sv", browserIdentityVersion: 1 });
    const anchor = { selector: "td.docu-num", matchField: "approval_id", field: "doc_ref", attribute: "data-href", pattern: "getView\\('(\\d+)'", template: "https://x/view/$1" };
    const r2 = await ex2.execute("n.2", { type: "extract", instruction: "x", output: { schemaRef: "approval_inbox_rows", schemaVersion: "1", strict: true }, rowAnchor: anchor }, ctx());
    const enriched = (r2.extracted as { rows: Array<{ doc_ref: string }> }).rows;
    check("deps.extractArtifactSink: rowAnchor 강화행 영속(sink put 1회·docId 999)", puts.length === 1 && puts[0]!.includes("999") && enriched[0]?.doc_ref === "https://x/view/999", `puts=${puts.length} ref=${enriched[0]?.doc_ref}`);
  }

  // 5) deps.secrets+executorPrincipal 주입 시 자격증명 fill 의 principal.tenantId 가 run 테넌트로 per-run override(P2 prod 배선).
  {
    let capturedTenant: string | undefined;
    const fakeSecrets = { resolveAuthorized: async (req: { principal: { tenantId: string } }) => { capturedTenant = req.principal.tenantId; return "pw-plain" as never; } } as unknown as SecretStoreBoundary;
    const principalTemplate = { subjectId: "w", tenantId: "PLACEHOLDER", roles: ["admin"], source: "jwt", claims: { runtime_identity: "runtime-worker" } } as unknown as AuthenticatedPrincipal;
    const gw: LlmGatewayCaller = { call: async () => ({ outputRef: "o", usage: { inputTokens: 1, outputTokens: 1, cost: 0 }, finishReason: "stop", parsedJson: { operation: "fill", selector: "#pw" } }) as unknown as LLMResponse };
    let filled = "";
    const sess: CdpSession = { ...fakeSession, evaluate: async () => "<body>x</body>" as never, fill: async (_s: string, v: string) => void (filled = v) };
    const ex5 = createDomUtilityExecutorFactory(gw, policy, { secrets: fakeSecrets, executorPrincipal: principalTemplate })({ forLease: () => sess } as unknown as CdpSessionProvider, { scenarioVersionId: "sv", browserIdentityVersion: 1, tenantId: "RUN-TENANT" });
    const c: RunContext = { ...ctx(), assetRefs: { "login.password": "ref://pw" as never } };
    await ex5.execute("n.3", { type: "act", instruction: "fill pw", secretRef: "login.password" }, c);
    check("deps.secrets+principal: 자격증명 fill principal.tenantId=run 테넌트(per-run override)·평문 fill", capturedTenant === "RUN-TENANT" && filled === "pw-plain", `tenant=${capturedTenant} filled=${filled}`);
  }

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
