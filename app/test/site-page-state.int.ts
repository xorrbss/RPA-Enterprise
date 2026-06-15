/**
 * SitePageStateResolver 통합 (D3 가동 2단계) — 마커 없는 실 페이지에서 site-profile 셀렉터로 flags 산출.
 *
 * 실 Stagehand v3 + 로컬 Chrome 으로, **data-page-state-contract 마커가 없는** 일반 리뷰 페이지에서
 * 사이트 프로파일 config(셀렉터→flag)로 PageState flags 를 산출하고, 인터프리터가 그 flags 로 on[] 분기해
 * terminal 까지 가는지 검증한다. (마커 제약을 site-profile 로 대체 — 위저드 실 URL 시나리오 가동의 토대)
 *
 * 실행: npm --prefix app exec -- tsx app/test/site-page-state.int.ts (로컬 Chrome 필요)
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PageState, RunContext } from "../../ts/core-types";
import { parseIrelExpression, type IRELNode } from "../../codegen/irel-compile";
import type { CompiledOnBranch } from "../src/runtime/flow-control";
import { runScenario, type CompiledScenario } from "../src/runtime/ir-interpreter";
import { createStagehandSession, SingleSessionProvider } from "../src/executor/cdp-session";
import { SitePageStateResolver, type SitePageStateConfig } from "../src/executor/site-page-state-resolver";
import { UtilityExecutor } from "../src/executor/utility-executor";

const PORT = 39287;
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

// 마커 없는 '일반' 리뷰 페이지(쿠팡류 흉내 — 평범한 class/구조). data-page-state-contract 없음.
function reviewsPage(): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>상품 리뷰</title></head>
<body>
<header role="banner"><h1>상품</h1><div class="user-menu">내 계정</div></header>
<main role="main">
  <section class="reviews">
    <article class="review-item">좋아요</article>
    <article class="review-item">별로</article>
    <article class="review-item">보통</article>
  </section>
  <a class="next-page disabled" aria-disabled="true">다음</a>
</main>
</body></html>`;
}

function startServer(): Promise<Server> {
  const s = createServer((req, res) => {
    const url = new URL(req.url ?? "/", ORIGIN);
    if (url.pathname === "/product/123/reviews") {
      return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(reviewsPage());
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

// 사이트 프로파일: 평범한 셀렉터로 닫힌 레지스트리 flags 산출(마커 불요).
const siteConfig: SitePageStateConfig = {
  authenticatedWhen: { selector: ".user-menu" },
  flags: {
    reviews_visible: { kind: "min_count", selector: ".review-item", n: 1 },
    not_found: { kind: "present", selector: ".empty-results" },
    no_next_page: { kind: "present", selector: "a.next-page.disabled" },
    login_required: { kind: "present", selector: ".login-form" },
    blocked: { kind: "present", selector: ".blocked-banner" },
  },
};

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
  const downloadDir = mkdtempSync(join(tmpdir(), "d3site-dl-"));
  const session = await createStagehandSession({ chromeExecutablePath: CHROME, downloadDir, headless: true });
  const provider = new SingleSessionProvider(session);
  const resolver = new SitePageStateResolver(provider, siteConfig);
  const executor = new UtilityExecutor(provider);

  // 직접 resolve 검증(마커 없는 페이지에서 flags 산출).
  await session.goto(`${ORIGIN}/product/123/reviews`);
  const ctx: RunContext = {
    runId: "run-site-0001",
    tenantId: "11111111-1111-1111-1111-111111111111",
    nodeId: "n",
    attempt: 0,
    siteProfileId: "site-1",
    browserIdentityId: "bid-1",
    networkPolicyId: "np-1",
    leaseId: "lease-1",
    assetRefs: {},
    abortSignal: new AbortController().signal,
    pageState: seedPageState(),
  };
  const ps = await resolver.resolvePageState(ctx);
  check("마커 없는 페이지에서 PageState 산출(PAGE_STATE_UNRESOLVED 없이)", ps.dom.structuralHash.length === 16);
  check("auth=authenticated (.user-menu)", ps.auth === "authenticated", ps.auth);
  check("reviews_visible=true (.review-item ≥1)", ps.flags.reviews_visible === true);
  check("not_found=false (.empty-results 부재)", ps.flags.not_found === false);
  check("no_next_page=true (a.next-page.disabled)", ps.flags.no_next_page === true);
  check("login_required=false / blocked=false", ps.flags.login_required === false && ps.flags.blocked === false);

  // 인터프리터로 site-profile resolver 사용해 구동: navigate → observe → on[] → terminal.
  const onBranches: CompiledOnBranch<string>[] = [
    { when: ast("flags.blocked"), target: "fail", priority: 40 },
    { when: ast("flags.login_required"), target: "fail", priority: 30 },
    { when: ast("flags.not_found"), target: "empty", priority: 20 },
    { when: ast("flags.reviews_visible"), target: "done", priority: 10 },
  ];
  const scenario: CompiledScenario = {
    start: "open",
    nodes: {
      open: { what: [{ type: "navigate", url: `${ORIGIN}/product/123/reviews` }], flow: { kind: "next", target: "check" } },
      check: { what: [], flow: { kind: "on", branches: onBranches } },
      done: { what: [], flow: { kind: "terminal", terminal: "success" } },
      empty: { what: [], flow: { kind: "terminal", terminal: "success_empty" } },
      fail: { what: [], flow: { kind: "terminal", terminal: "fail_system" } },
    },
  };
  const outcome = await runScenario(scenario, { ...ctx, nodeId: "open", pageState: seedPageState() }, { executor, resolver });
  check("인터프리터: 마커 없는 실페이지 시나리오 → terminal=success", outcome.terminal === "success", outcome.terminal);
  check("on[]에서 reviews_visible→done 채택", outcome.visited.join(",") === "open,check,done", outcome.visited.join(","));

  await session.close();
  server.close();
  rmSync(downloadDir, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: SitePageStateResolver — 마커 없는 실 페이지를 site-profile 셀렉터로 flags 산출·구동 (D3 가동 2단계)");
  process.exit(0);
}

main().catch((e) => {
  console.error("site-page-state int fatal:", e);
  process.exit(1);
});
