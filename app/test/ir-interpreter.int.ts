/**
 * IR 인터프리터 통합 (D3 가동 1단계) — executor-dryrun 의 수동 루프를 인터프리터(runScenario)로 일반화.
 *
 * 실 Stagehand v3 + 로컬 Chrome 으로, 컴파일된 시나리오(navigate→on[]→navigate→on[]→download→terminal)를
 * 인터프리터가 자율 순회해 terminal=success 에 도달하는지 검증한다. (executor-dryrun.int.ts 와 동일 픽스처)
 *
 * 실행: `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app run test:interpreter` 불필요(DB 미사용) —
 *   `npm --prefix app exec -- tsx app/test/ir-interpreter.int.ts` (로컬 Chrome 필요; CHROME_PATH 재정의 가능).
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
import { CdpPageStateResolver } from "../src/executor/page-state-resolver";
import { UtilityExecutor } from "../src/executor/utility-executor";

const PORT = 39283;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const CONTRACT_MARKER = "d3-dryrun-v1";

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
<body data-page-state-contract="${CONTRACT_MARKER}" data-auth="authenticated">
<header role="banner"><h1>리뷰</h1></header>
<nav role="navigation" aria-label="메뉴"><a href="#">홈</a></nav>
<main role="main">
<ul data-landmark="reviews"><li class="review-item">A</li><li class="review-item">B</li></ul>
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

// observe 노드 분기(flow-control.unit / dry-run 과 동형): blocked > login > not_found > reviews_visible.
function observeBranches(read: string): CompiledOnBranch<string>[] {
  return [
    { when: ast("flags.blocked"), target: "fail", priority: 40 },
    { when: ast("flags.login_required"), target: "fail", priority: 30 },
    { when: ast("flags.not_found"), target: "empty", priority: 20 },
    { when: ast("flags.reviews_visible"), target: read, priority: 10 },
  ];
}

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
  const downloadDir = mkdtempSync(join(tmpdir(), "d3interp-dl-"));
  const session = await createStagehandSession({ chromeExecutablePath: CHROME, downloadDir, headless: true });
  const provider = new SingleSessionProvider(session);
  const resolver = new CdpPageStateResolver(provider);
  const executor = new UtilityExecutor(provider);

  // 컴파일된 2-페이지 선형 시나리오: 열기 → 확인 → 다음페이지 → 확인 → 받기 → 성공.
  const scenario: CompiledScenario = {
    start: "open",
    nodes: {
      open: { what: [{ type: "navigate", url: `${ORIGIN}/p/1` }], flow: { kind: "next", target: "check1" } },
      check1: { what: [], flow: { kind: "on", branches: observeBranches("read1") } },
      read1: { what: [{ type: "navigate", url: `${ORIGIN}/p/2` }], flow: { kind: "next", target: "check2" } },
      check2: { what: [], flow: { kind: "on", branches: observeBranches("read2") } },
      read2: {
        what: [{ type: "download", trigger: { selector: "#dl" }, fileName: "report.csv" }],
        flow: { kind: "next", target: "done" },
      },
      done: { what: [], flow: { kind: "terminal", terminal: "success" } },
      empty: { what: [], flow: { kind: "terminal", terminal: "success_empty" } },
      fail: { what: [], flow: { kind: "terminal", terminal: "fail_system" } },
    },
  };

  const ctx: RunContext = {
    runId: "run-interp-0001",
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

  const outcome = await runScenario(scenario, ctx, { executor, resolver });

  check("terminal = success", outcome.terminal === "success", outcome.terminal);
  check(
    "노드 순회 = open→check1→read1→check2→read2→done",
    outcome.visited.join(",") === "open,check1,read1,check2,read2,done",
    outcome.visited.join(","),
  );
  check("navigate 2회 success", outcome.steps.filter((s) => s.action === "navigate" && s.status === "success").length === 2);
  check("download 1회 success", outcome.steps.filter((s) => s.action === "download" && s.status === "success").length === 1);
  check("on[] 분기로 reviews_visible→read 경로 채택", outcome.visited.includes("read1") && outcome.visited.includes("read2"));

  await session.close();
  server.close();
  rmSync(downloadDir, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: IR 인터프리터가 결정형 시나리오를 자율 순회해 terminal=success 도달 (D3 가동 1단계)");
  process.exit(0);
}

main().catch((e) => {
  console.error("interpreter int fatal:", e);
  process.exit(1);
});
