/**
 * D3 dry-run 통합 — architecture.md §9.4 수용 기준.
 *
 * 실제 Stagehand v3(@browserbasehq/stagehand) + 로컬 Chrome CDP 로, **Stagehand act 없이**:
 *  1) UtilityExecutor(navigate/download) + CdpPageStateResolver(flags·structuralHash) 산출
 *  2) flow-control selectOnBranch 로 IREL `on[]` 분기 평가(resolver flags 소비)
 *  3) codegen transitionRun(순수) 으로 Run lifecycle(queued→claimed→running→completing→completed) 연결
 *  4) 최소 시나리오(observe_reviews → collect/download → next_page) **dry-run**(DB/outbox/네트워크 전송 차단) 통과
 *
 * 실행: `npm --prefix app run test:executor` (로컬 Chrome 필요; CHROME_PATH 로 경로 재정의 가능).
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { transitionRun } from "../../codegen/transitions";
import type { RunGuard, RunState } from "../../ts/state-machine-types";
import type { PageState, RunContext } from "../../ts/core-types";
import { parseIrelExpression, type IRELNode } from "../../codegen/irel-compile";
import { selectOnBranch, evaluateCondition, type CompiledOnBranch } from "../src/runtime/flow-control";
import { createStagehandSession, SingleSessionProvider } from "../src/executor/cdp-session";
import { CdpPageStateResolver } from "../src/executor/page-state-resolver";
import { UtilityExecutor } from "../src/executor/utility-executor";

const PORT = 39281;
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

function page(n: number, hasNext: boolean): string {
  const next = hasNext
    ? `<a rel="next" href="/p/${n + 1}" role="link">다음</a>`
    : `<a rel="next" href="#" role="link" aria-disabled="true">다음</a>`;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>p${n}</title></head>
<body data-auth="authenticated">
<header role="banner"><h1>리뷰</h1></header>
<nav role="navigation" aria-label="메뉴"><a href="#">홈</a></nav>
<main role="main">
<ul data-landmark="reviews"><li class="review-item">A</li><li class="review-item">B</li><li class="review-item">C</li></ul>
${next}
<p><a id="dl" href="/download/report.csv" download>받기</a></p>
</main>
<footer role="contentinfo"><small>©</small></footer>
</body></html>`;
}

function startServer(): Promise<Server> {
  const s = createServer((req, res) => {
    const url = new URL(req.url ?? "/", ORIGIN);
    if (url.pathname === "/p/1") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(1, true));
    if (url.pathname === "/p/2") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(2, false));
    if (url.pathname === "/download/report.csv") {
      const body = "id,score\n1,5\n";
      return void res
        .writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="report.csv"', "content-length": Buffer.byteLength(body) })
        .end(body);
    }
    res.writeHead(404).end();
  });
  return new Promise((r) => s.listen(PORT, "127.0.0.1", () => r(s)));
}

function ast(expr: string): IRELNode {
  const p = parseIrelExpression(expr);
  if (!p.ok) throw new Error(`parse failed: ${expr}`);
  return p.ast;
}

// observe_reviews 노드 분기(flow-control.unit 과 동형): blocked > login > not_found > reviews_visible.
const onReviews: CompiledOnBranch<string>[] = [
  { when: ast("flags.blocked"), target: "challenge", priority: 40 },
  { when: ast("flags.login_required"), target: "login", priority: 30 },
  { when: ast("flags.not_found"), target: "end_no_data", priority: 20 },
  { when: ast("flags.reviews_visible"), target: "collect", priority: 10 },
];

/** dry-run: Run lifecycle 를 순수 transitionRun 으로 전진(DB 미사용). */
function step(cur: RunState, ev: Parameters<typeof transitionRun>[1], g: RunGuard): RunState {
  return transitionRun(cur, ev, g).next;
}

async function main(): Promise<void> {
  const server = await startServer();
  const downloadDir = mkdtempSync(join(tmpdir(), "d3exec-dl-"));
  const session = await createStagehandSession({ chromeExecutablePath: CHROME, downloadDir, headless: true });
  const provider = new SingleSessionProvider(session);
  const resolver = new CdpPageStateResolver(provider);
  const executor = new UtilityExecutor(provider);

  // ── Run lifecycle: queued → claimed → running (transitions.ts 연결) ──────────
  let runState: RunState = "queued";
  runState = step(runState, { type: "worker.claimed" }, { leaseAcquired: true });
  check("queued → claimed", runState === "claimed");
  runState = step(runState, { type: "run.started" }, { initOk: true });
  check("claimed → running", runState === "running");

  // ── RunContext (dry-run 상수 + seed PageState) ──────────────────────────────
  const ctx: RunContext = {
    runId: "run-dry-0001",
    tenantId: "11111111-1111-1111-1111-111111111111",
    nodeId: "node-1",
    siteProfileId: "site-1",
    browserIdentityId: "bid-1",
    networkPolicyId: "np-1",
    leaseId: "lease-1",
    assetRefs: {},
    abortSignal: new AbortController().signal,
    pageState: undefined as unknown as PageState, // seed 직후 채움
  };
  ctx.pageState = await resolver.resolvePageState(ctx); // about:blank seed

  // ── 시나리오 루프: navigate → observe(resolve) → on[] → collect/download → next_page ──
  const nav = await executor.execute("navigate_p1", { type: "navigate", url: `${ORIGIN}/p/1` }, ctx);
  check("navigate p1 success", nav.status === "success" && nav.action === "navigate");

  let pagesVisited = 0;
  let downloads = 0;
  let route = "";
  for (let guard = 0; guard < 5; guard += 1) {
    ctx.pageState = await resolver.resolvePageState(ctx);
    pagesVisited += 1;

    // structuralHash·flags 산출 입증(§9.4 #1)
    check(`page${pagesVisited}: structuralHash present`, ctx.pageState.dom.structuralHash.length === 16);
    check(`page${pagesVisited}: auth=authenticated`, ctx.pageState.auth === "authenticated");

    // IREL on[] 분기(resolver flags 소비)
    route = selectOnBranch("observe_reviews", onReviews, { flags: ctx.pageState.flags });
    check(`page${pagesVisited}: on[] → collect`, route === "collect", `got ${route}`);

    // 결정형 verify(min_rows)
    const v = await executor.verify({ type: "min_rows", selector: ".review-item", min: 1 }, ctx);
    check(`page${pagesVisited}: verify reviews pass`, v.status === "pass");

    // loop.until 대역: no_next_page true → terminal
    const terminal = evaluateCondition(ast("flags.no_next_page"), { flags: ctx.pageState.flags });
    if (terminal) {
      const dl = await executor.execute("collect", { type: "download", trigger: { selector: "#dl" }, fileName: "report.csv" }, ctx);
      downloads += 1;
      check("terminal page: download captured", dl.status === "success" && dl.sideEffect?.committed === true);
      break;
    }
    // next_page: 결정형으로 next href 추출 후 navigate
    const href = await session.evaluate<string>(`document.querySelector('a[rel="next"]').getAttribute('href')`);
    const r = await executor.execute("next_page", { type: "navigate", url: `${ORIGIN}${href}` }, ctx);
    check(`page${pagesVisited}: next_page navigate`, r.status === "success");
  }

  check("visited 2 pages", pagesVisited === 2, `visited=${pagesVisited}`);
  check("downloaded once", downloads === 1, `downloads=${downloads}`);

  // ── Run lifecycle: running → completing → completed ─────────────────────────
  runState = step(runState, { type: "last_node_success" }, { flowTerminalReached: true });
  check("running → completing", runState === "completing");
  runState = step(runState, { type: "finalize_ok" }, { finalizeOk: true });
  check("completing → completed (terminal)", runState === "completed");

  // ── dom 액션은 utility 실행기 소관 아님 → 명시적 throw(조용한 no-op 금지) ─────
  let threw = false;
  try {
    await executor.execute("act_step", { type: "act", instruction: "click" }, ctx);
  } catch (e) {
    threw = (e as { code?: string }).code === "EXECUTOR_CAPABILITY_MISMATCH";
  }
  check("dom action 'act' → EXECUTOR_CAPABILITY_MISMATCH", threw);

  // ── teardown(전송/저장 없었음 — DB·outbox·pg 미임포트) ──────────────────────
  await session.close();
  server.close();
  rmSync(downloadDir, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D3 executor dry-run integration green (§9.4)");
  process.exit(0);
}

main().catch((e) => {
  console.error("dry-run fatal:", e);
  process.exit(1);
});
