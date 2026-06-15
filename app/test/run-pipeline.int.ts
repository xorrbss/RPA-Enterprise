/**
 * Run 전 구간 파이프라인 통합 (D3 가동 1단계 — 증분3a). 실 PostgreSQL + 실 Stagehand v3 + 로컬 Chrome.
 *
 * 증분1(인터프리터+실Chrome)·증분2(드라이버+DB)를 결합해 모든 구성요소가 실물로 함께 도는지 검증한다:
 *   queued run → 실 enqueuer 없이 claim 전이(queued→claimed) → driveClaimedRun(실 UtilityExecutor +
 *   CdpPageStateResolver) → 실 Chrome으로 마커 픽스처 페이지 navigate/PageState 산출/on[] 분기 → completed.
 * (임의 실사이트는 PageStateResolver가 마커 없는 페이지를 PAGE_STATE_UNRESOLVED로 막으므로 2단계 — 여기선 마커 픽스처.)
 *
 * 실행(temp PG15 게이트 + Chrome):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/run-pipeline.int.ts
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { compileScenario } from "../src/api/compile-pipeline";
import { createPool, withTenantTx } from "../src/db/pool";
import { applyRunTransition } from "../src/runtime/run-transition";
import { driveClaimedRun, type ClaimedRun } from "../src/runtime/run-step-driver";
import { createStagehandSession, SingleSessionProvider } from "../src/executor/cdp-session";
import { CdpPageStateResolver } from "../src/executor/page-state-resolver";
import { UtilityExecutor } from "../src/executor/utility-executor";

const PORT = 39285;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const CONTRACT_MARKER = "d3-dryrun-v1";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_run_pipeline_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const SCEN = "70000000-0000-0000-0000-0000000000e1";
const SVER = "70000000-0000-0000-0000-0000000000e2";
const RUN = "71000000-0000-0000-0000-0000000000e1";
const WORKER = "9a000000-0000-0000-0000-0000000000e1";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function reviewsPage(): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>리뷰</title></head>
<body data-page-state-contract="${CONTRACT_MARKER}" data-auth="authenticated">
<header role="banner"><h1>리뷰</h1></header>
<nav role="navigation" aria-label="메뉴"><a href="#">홈</a></nav>
<main role="main">
<ul data-landmark="reviews"><li class="review-item">A</li><li class="review-item">B</li></ul>
<a rel="next" href="#" role="link" aria-disabled="true">다음</a>
</main>
<footer role="contentinfo"><small>©</small></footer>
</body></html>`;
}

function startServer(): Promise<Server> {
  const s = createServer((req, res) => {
    const url = new URL(req.url ?? "/", ORIGIN);
    if (url.pathname === "/p/1") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(reviewsPage());
    res.writeHead(404).end();
  });
  return new Promise((r) => s.listen(PORT, "127.0.0.1", () => r(s)));
}

// 마커 픽스처(/p/1)로 navigate → observe → on[](reviews_visible) → 성공.
const scenarioIr = {
  meta: { name: "pipeline-test", version: 1 },
  start: "open",
  nodes: {
    open: { what: [{ action: "navigate", url_ref: `${ORIGIN}/p/1` }], next: "check" },
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
  const downloadDir = mkdtempSync(join(tmpdir(), "d3pipe-dl-"));
  const session = await createStagehandSession({ chromeExecutablePath: CHROME, downloadDir, headless: true });
  const provider = new SingleSessionProvider(session);
  const resolver = new CdpPageStateResolver(provider);
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
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'pipeline')`, [SCEN, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [SVER, TENANT, SCEN, JSON.stringify(compiled.ir), compiled.compiledAst],
      );
      // 실 enqueuer 없이 createRun과 동형으로 queued run 시드.
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, as_of)
         VALUES ($1,$2,$3,'queued',$1,1,'2026-06-16T00:00:00Z')`,
        [RUN, TENANT, SVER],
      );
    });

    // 1) queued → claimed (R1, worker.claimed) — 워커 claim 대역.
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

    // 2) driveClaimedRun: 실 UtilityExecutor + CdpPageStateResolver(실 Chrome) → completed.
    const run: ClaimedRun = {
      runId: RUN,
      tenantId: TENANT,
      scenarioVersionId: SVER,
      correlationId: RUN,
      leaseId: "lease-1",
      siteProfileId: "site-1",
      browserIdentityId: "bid-1",
      networkPolicyId: "np-1",
    };
    const result = await driveClaimedRun(run, { pool, executor, resolver, workerId: WORKER });

    check("driver returns completed", result.state === "completed", result.state);
    check("실 Chrome navigate 수행됨", result.outcome.steps.some((s) => s.action === "navigate" && s.status === "success"));
    check("on[]에서 reviews_visible→done 채택", result.outcome.visited.join(",") === "open,check,done", result.outcome.visited.join(","));

    const dbStatus = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [RUN]);
      return r.rows[0]?.status ?? null;
    });
    check("DB runs.status = completed (queued→…→completed 전 구간)", dbStatus === "completed", String(dbStatus));
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
  console.log("\nPASS: Run 전 구간 — queued→claim→인터프리터(실 Chrome)→completed (D3 가동 1단계 증분3a, 실물 결합)");
  process.exit(0);
}

main().catch((e) => {
  console.error("run-pipeline int fatal:", e);
  process.exit(1);
});
