/**
 * Run 전 구간 파이프라인 — site-profile 모드 (D3 가동 2단계 증분2). 실 PostgreSQL + 실 Stagehand v3 + 로컬 Chrome.
 *
 * run-pipeline.int(마커 모드)와 동형이되, dev 콘솔이 실제로 타는 경로 + **DB 영속 라운드트립**을 검증한다:
 *   site_profiles.page_state_selectors(jsonb) 시드 → loadSitePageStateConfig 로 로드 → SitePageStateResolver →
 *   queued run → claim → driveClaimedRun → 실 Chrome으로 **마커 없는** 실 URL풍 페이지 navigate →
 *   DB에서 로드한 셀렉터로 PageState flags 산출 → on[] 분기 → completed. (serve.ts 시드와 동일 셀렉터/구조)
 *
 * 실행(temp PG15 게이트 + Chrome):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/run-pipeline-site.int.ts
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileScenario } from "../src/api/compile-pipeline";
import { createPool, withTenantTx } from "../src/db/pool";
import { applyRunTransition } from "../src/runtime/run-transition";
import { driveClaimedRun, type ClaimedRun } from "../src/runtime/run-step-driver";
import { createStagehandSession, SingleSessionProvider } from "../src/executor/cdp-session";
import { SitePageStateResolver, type SitePageStateConfig } from "../src/executor/site-page-state-resolver";
import { loadSitePageStateConfig } from "../src/executor/site-page-state-config";
import { UtilityExecutor } from "../src/executor/utility-executor";

const PORT = 39289;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_run_pipeline_site_int";
const TENANT = "00000000-0000-0000-0000-0000000000b1";
const SCEN = "72000000-0000-0000-0000-0000000000e1";
const SVER = "72000000-0000-0000-0000-0000000000e2";
const RUN = "73000000-0000-0000-0000-0000000000e1";
const SITE = "74000000-0000-0000-0000-0000000000e1";
const WORKER = "9a000000-0000-0000-0000-0000000000e2";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// serve.ts FIXTURE_HTML 과 동일한 마커 없는 실 URL풍 리뷰 페이지.
function reviewsPage(): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>상품 리뷰</title></head>
<body>
<header role="banner"><h1>상품</h1><div class="user-menu">내 계정</div></header>
<main role="main"><section class="reviews"><article class="review-item">좋아요</article><article class="review-item">별로</article><article class="review-item">보통</article></section>
<a class="next-page disabled" aria-disabled="true">다음</a></main>
<footer role="contentinfo"><small>©</small></footer></body></html>`;
}

function startServer(): Promise<Server> {
  const s = createServer((req, res) => {
    const url = new URL(req.url ?? "/", ORIGIN);
    if (url.pathname === "/fixture/reviews") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(reviewsPage());
    res.writeHead(404).end();
  });
  return new Promise((r) => s.listen(PORT, "127.0.0.1", () => r(s)));
}

// run-loop.ts DEMO_SITE_CONFIG 과 동일.
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

// serve.ts 데모 시나리오와 동형.
const scenarioIr = {
  meta: { name: "site-pipeline-test", version: 1 },
  start: "open",
  nodes: {
    open: { what: [{ action: "navigate", url_ref: `${ORIGIN}/fixture/reviews` }], next: "check" },
    check: {
      what: [{ action: "observe" }],
      on: [
        { when: "flags.not_found", target: "empty", priority: 2 },
        { when: "flags.reviews_visible", target: "done", priority: 1 },
      ],
    },
    done: { terminal: "success" },
    empty: { terminal: "success_empty" },
  },
};

async function main(): Promise<void> {
  const server = await startServer();
  const downloadDir = mkdtempSync(join(tmpdir(), "d3site-pipe-dl-"));
  const session = await createStagehandSession({ chromeExecutablePath: CHROME, downloadDir, headless: true });
  const provider = new SingleSessionProvider(session);
  const executor = new UtilityExecutor(provider);

  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
    } finally {
      setup.release();
    }

    const compiled = compileScenario(scenarioIr, {});
    check("scenario compiles", compiled.ok, compiled.ok ? "" : JSON.stringify(compiled.details));
    if (!compiled.ok) throw new Error("scenario did not compile");

    await withTenantTx(pool, TENANT, async (c) => {
      // site_profile 에 page_state_selectors(jsonb) 영속 — run 의 site_profile 이 PageState 산출 규칙의 진실원천.
      await c.query(
        `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, page_state_selectors)
         VALUES ($1,$2,'site-pipeline',$3,$4::jsonb)`,
        [SITE, TENANT, ORIGIN, JSON.stringify(siteConfig)],
      );
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'site-pipeline')`, [SCEN, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [SVER, TENANT, SCEN, JSON.stringify(compiled.ir), compiled.compiledAst],
      );
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, as_of)
         VALUES ($1,$2,$3,'queued',$1,1,'2026-06-16T00:00:00Z')`,
        [RUN, TENANT, SVER],
      );
    });

    // DB 영속 page_state_selectors 라운드트립: run 의 site_profile 에서 config 로드 → resolver 구성.
    const loaded = await withTenantTx(pool, TENANT, (c) => loadSitePageStateConfig(c, TENANT, SITE));
    check("DB page_state_selectors 라운드트립(loadSitePageStateConfig)", loaded.flags.reviews_visible?.kind === "min_count" && loaded.authenticatedWhen?.selector === ".user-menu");
    const resolver = new SitePageStateResolver(provider, loaded);

    const claimed = await withTenantTx(pool, TENANT, (c) =>
      applyRunTransition(c, {
        tenantId: TENANT,
        runId: RUN,
        fromStatus: "queued",
        event: { type: "worker.claimed" },
        guard: { leaseAcquired: true },
        correlationId: RUN,
        workerId: WORKER,
        eventIdempotencyKey: `${RUN}:worker.claimed`,
      }),
    );
    check("queued → claimed", claimed.applied && claimed.next === "claimed", JSON.stringify(claimed));

    const run: ClaimedRun = {
      runId: RUN,
      tenantId: TENANT,
      scenarioVersionId: SVER,
      correlationId: RUN,
      leaseId: "lease-1",
      siteProfileId: SITE,
      browserIdentityId: "bid-1",
      networkPolicyId: "np-1",
    };
    const result = await driveClaimedRun(run, { pool, executor, resolver, workerId: WORKER });

    check("driver returns completed", result.state === "completed", result.state);
    check("실 Chrome navigate(마커 없는 실 URL풍 페이지) 성공", result.outcome.steps.some((s) => s.action === "navigate" && s.status === "success"));
    check("site-profile flags로 reviews_visible→done 채택", result.outcome.visited.join(",") === "open,check,done", result.outcome.visited.join(","));

    const dbStatus = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [RUN]);
      return r.rows[0]?.status ?? null;
    });
    check("DB runs.status = completed (queued→…→completed, site-profile 모드)", dbStatus === "completed", String(dbStatus));
  } finally {
    await pool.end();
    await session.close();
    server.close();
    rmSync(downloadDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: Run 전 구간(site-profile) — queued→claim→SitePageStateResolver(실 Chrome, 마커 없는 페이지)→completed (D3 가동 2단계 증분2)");
  process.exit(0);
}

main().catch((e) => {
  console.error("run-pipeline-site int fatal:", e);
  process.exit(1);
});
