/**
 * 인터프리터 ↔ LLM dom act/extract 통합 (D3 가동 3단계 증분1, OFFLINE). 실 Stagehand v3 + 로컬 Chrome, **fake gateway**.
 *
 * 라이브 LLM(Codex)은 사용자 자격증명 의존이라 이 환경 미실행 — fake LlmGatewayCaller 로 act plan/extract data 를
 * 주입해 **인터프리터→composite→dom→CDP 배선**을 검증한다(plan 품질이 아니라 배선). composite 가 type 으로
 * navigate→utility, act/extract→dom 라우팅; act 는 fake plan 을 실 CDP fill 로 적용(페이지 실제 변이).
 *
 * 검증: navigate→act(fill #q)→extract→on[](flags.reviews_visible)→completed; act 가 실 DOM 변이; extract success;
 *  node.* 분기는 인터프리터 flags-only 스코프라 IREL_RUNTIME_MISSING 로 loud(RQ-002 — node 스코프 미배선, 결함 연기).
 *
 * 실행: npm --prefix app exec -- tsx app/test/interpreter-llm.int.ts (로컬 Chrome 필요; DB·네트워크 egress 없음)
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PageState, RunContext } from "../../ts/core-types";
import type { LLMResponse } from "../../ts/security-middleware-contract";
import { parseIrelExpression, type IRELNode } from "../../codegen/irel-compile";
import { compileScenario } from "../src/api/compile-pipeline";
import type { CompiledOnBranch } from "../src/runtime/flow-control";
import { compiledScenarioFrom } from "../src/runtime/ir-translate";
import { runScenario, type CompiledScenario } from "../src/runtime/ir-interpreter";
import { CompositeExecutor } from "../src/runtime/composite-executor";
import { createStagehandSession, SingleSessionProvider } from "../src/executor/cdp-session";
import { SitePageStateResolver } from "../src/executor/site-page-state-resolver";
import { StagehandDomExecutor, type LlmGatewayCaller } from "../src/executor/stagehand-dom-executor";
import { UtilityExecutor } from "../src/executor/utility-executor";

const PORT = 39297;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function fixturePage(): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>리뷰</title></head>
<body><header role="banner"><div class="user-menu">계정</div></header>
<main role="main">
  <input id="q" type="text" value="" />
  <section class="reviews"><article class="review-item">A</article><article class="review-item">B</article></section>
</main></body></html>`;
}

function startServer(): Promise<Server> {
  const s = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(fixturePage()));
  return new Promise((r) => s.listen(PORT, "127.0.0.1", () => r(s)));
}

function ast(expr: string): IRELNode {
  const p = parseIrelExpression(expr);
  if (!p.ok) throw new Error(`parse failed: ${expr}`);
  return p.ast;
}

// fake gateway: act(responseFormat.schemaRef='action_plan') → fill plan; extract → 구조화 data.
const fakeGateway: LlmGatewayCaller = {
  call: async (req) => {
    const rf = (req as { responseFormat?: { schemaRef?: string } }).responseFormat;
    const parsedJson =
      rf?.schemaRef === "action_plan" ? { operation: "fill", selector: "#q", value: "hello" } : { rows: [1, 2, 3], row_count: 3 };
    return { outputRef: "art://out", usage: { inputTokens: 1, outputTokens: 1, cost: 0 }, finishReason: "stop", parsedJson } as unknown as LLMResponse;
  },
};

const domCfg = { model: "codex", promptTemplateVersion: "v1", budget: { maxInputTokens: 10000, maxOutputTokens: 4096, maxCost: 0.85 }, scenarioVersionId: "sv-1", browserIdentityVersion: 1 };

function seedPageState(): PageState {
  return {
    url: { raw: "about:blank", canonical: "about:blank", pattern: "about:blank" },
    dom: { structuralHash: "seed", visibleTextHash: "seed", landmarks: [], frames: [] },
    auth: "anonymous",
    flags: {},
    matchedWhere: [],
  };
}

async function main(): Promise<void> {
  const server = await startServer();
  const downloadDir = mkdtempSync(join(tmpdir(), "d3llm-dl-"));
  const session = await createStagehandSession({ chromeExecutablePath: CHROME, downloadDir, headless: true });
  const provider = new SingleSessionProvider(session);
  const composite = new CompositeExecutor(
    new StagehandDomExecutor(fakeGateway, provider, domCfg),
    new UtilityExecutor(provider),
  );
  const resolver = new SitePageStateResolver(provider, { flags: { reviews_visible: { kind: "min_count", selector: ".review-item", n: 1 } } });

  const ctx: RunContext = {
    runId: "run-llm-1",
    tenantId: "11111111-1111-1111-1111-111111111111",
    nodeId: "open",
    attempt: 0,
    siteProfileId: "site-1",
    browserIdentityId: "bid-1",
    networkPolicyId: "np-1",
    leaseId: "lease-1",
    assetRefs: {},
    abortSignal: new AbortController().signal,
    pageState: seedPageState(),
  };

  try {
    // navigate(url_ref=entry_url) → act(fill) → extract → on[](flags.reviews_visible) → done.
    const compiled = compileScenario(
      {
        meta: { name: "llm-act-extract", version: 1 },
        start: "open",
        nodes: {
          open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "doact" },
          doact: { what: [{ action: "act", instruction: "fill the query box" }], next: "grab" },
          grab: { what: [{ action: "extract", instruction: "get reviews", schema_ref: "reviews" }], next: "check" },
          check: {
            what: [{ action: "observe" }],
            on: [{ when: "flags.reviews_visible", target: "done", priority: 1 }],
          },
          done: { terminal: "success" },
        },
      },
      {},
    );
    check("act/extract 시나리오 컴파일", compiled.ok, compiled.ok ? "" : JSON.stringify(compiled.details));
    if (!compiled.ok) throw new Error("compile 실패");

    // ir-translate 가 act/extract 를 DomAction 으로 매핑(params.entry_url 로 navigate 해소). compiledAst 는 JSON 문자열.
    const scenario = compiledScenarioFrom(compiled.ir, JSON.parse(compiled.compiledAst) as unknown, { entry_url: `${ORIGIN}/p` });
    const outcome = await runScenario(scenario, { ...ctx, pageState: seedPageState() }, { executor: composite, resolver });

    check("terminal=success (navigate→act→extract→on[]→done)", outcome.terminal === "success", outcome.terminal);
    check("visited 경로 open→doact→grab→check→done", outcome.visited.join(",") === "open,doact,grab,check,done", outcome.visited.join(","));
    check("act step success (composite→dom 라우팅)", outcome.steps.some((s) => s.action === "act" && s.status === "success"));
    check("extract step success (composite→dom 라우팅)", outcome.steps.some((s) => s.action === "extract" && s.status === "success"));

    // act 가 실 CDP fill 로 페이지를 실제 변이했는가(fake plan #q='hello').
    const filled = await session.evaluate<string>('(() => { const el = document.querySelector("#q"); return el ? el.value : ""; })()');
    check("act 가 실 DOM 변이(#q='hello')", filled === "hello", filled);

    // node.* 분기는 인터프리터 flags-only 스코프라 loud (RQ-002 — node 스코프 미배선, 결함 연기).
    const nodeBranch: CompiledOnBranch<string>[] = [{ when: ast("node.grab.row_count >= 1"), target: "done", priority: 1 }];
    const nodeScenario: CompiledScenario = {
      start: "check",
      nodes: {
        check: { what: [], flow: { kind: "on", branches: nodeBranch } },
        done: { what: [], flow: { kind: "terminal", terminal: "success" } },
      },
    };
    let nodeErr: unknown;
    try {
      await runScenario(nodeScenario, { ...ctx, nodeId: "check", pageState: seedPageState() }, { executor: composite, resolver });
    } catch (e) {
      nodeErr = e;
    }
    check(
      "on[] node.* 참조 → IREL_RUNTIME_MISSING (flags-only 스코프, 조용한 false 아님)",
      nodeErr instanceof Error && (nodeErr as { code?: string }).code === "IREL_RUNTIME_MISSING",
      nodeErr instanceof Error ? `${(nodeErr as { code?: string }).code ?? ""}: ${nodeErr.message}` : String(nodeErr),
    );
  } finally {
    await session.close();
    server.close();
    rmSync(downloadDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: 인터프리터 LLM dom — navigate→act(실 CDP)→extract→completed + node.* loud (D3 가동 3단계 증분1, fake gateway)");
  process.exit(0);
}

main().catch((e) => {
  console.error("interpreter-llm int fatal:", e);
  process.exit(1);
});
