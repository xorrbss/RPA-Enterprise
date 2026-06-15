/**
 * 멀티사이트 run→site_profile 해소 통합 (D3 가동 2단계). 실 PostgreSQL + 실 Stagehand v3 + 로컬 Chrome.
 *
 * dev 런타임 루프의 per-run 해소 경로를 그대로 검증한다: 서로 다른 origin을 가리키는 2개 시나리오가 각자
 * entry navigate URL의 origin으로 자기 site_profile을 해소하고(resolveSiteProfileId), 그 사이트의 page_state_selectors
 * (서로 다른 닫힌 flag 키)를 로드해 구동 → 둘 다 completed. + 0-match/ambiguity는 loud(SiteResolutionError).
 *
 * 실행(temp PG15 게이트 + Chrome):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/run-multisite-resolution.int.ts
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
import { extractEntryNavigateUrlRef, resolveSiteProfileId, SiteResolutionError } from "../src/runtime/site-resolution";
import { createStagehandSession, SingleSessionProvider } from "../src/executor/cdp-session";
import { SitePageStateResolver } from "../src/executor/site-page-state-resolver";
import { loadSitePageStateConfig } from "../src/executor/site-page-state-config";
import { UtilityExecutor } from "../src/executor/utility-executor";

const PORT_A = 39291;
const PORT_B = 39293;
const ORIGIN_A = `http://127.0.0.1:${PORT_A}`;
const ORIGIN_B = `http://127.0.0.1:${PORT_B}`;
const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_multisite_int";
const TENANT = "00000000-0000-0000-0000-0000000000c1";
const SITE_A = "75000000-0000-0000-0000-0000000000a1";
const SITE_B = "75000000-0000-0000-0000-0000000000b1";
const SCEN_A = "76000000-0000-0000-0000-0000000000a1";
const SVER_A = "76000000-0000-0000-0000-0000000000a2";
const RUN_A = "77000000-0000-0000-0000-0000000000a1";
const SCEN_B = "76000000-0000-0000-0000-0000000000b1";
const SVER_B = "76000000-0000-0000-0000-0000000000b2";
const RUN_B = "77000000-0000-0000-0000-0000000000b1";
const WORKER = "9a000000-0000-0000-0000-0000000000c1";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// 사이트 A: 리뷰 있음(.review-item) → reviews_visible. 사이트 B: 리뷰 없음(.no-reviews) → no_review_message_visible.
function pageA(): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>A 리뷰</title></head>
<body><header role="banner"><div class="user-menu">계정</div></header>
<main role="main"><section class="reviews"><article class="review-item">좋아요</article><article class="review-item">별로</article></section></main></body></html>`;
}
function pageB(): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>B 리뷰</title></head>
<body><header role="banner"><div class="user-menu">계정</div></header>
<main role="main"><p class="no-reviews">등록된 리뷰가 없습니다.</p></main></body></html>`;
}

function startServer(port: number, html: () => string): Promise<Server> {
  const s = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html()));
  return new Promise((r) => s.listen(port, "127.0.0.1", () => r(s)));
}

// 사이트별 page_state_selectors — 서로 다른 닫힌 flag 키(reviews_visible vs no_review_message_visible).
const selectorsA = { authenticatedWhen: { selector: ".user-menu" }, flags: { reviews_visible: { kind: "min_count", selector: ".review-item", n: 1 } } };
const selectorsB = { authenticatedWhen: { selector: ".user-menu" }, flags: { no_review_message_visible: { kind: "present", selector: ".no-reviews" } } };

function scenarioIr(origin: string, flag: string): unknown {
  return {
    meta: { name: `multisite-${flag}`, version: 1 },
    start: "open",
    nodes: {
      open: { what: [{ action: "navigate", url_ref: `${origin}/p` }], next: "check" },
      check: { what: [{ action: "observe" }], on: [{ when: `flags.${flag}`, target: "done", priority: 1 }] },
      done: { terminal: "success" },
    },
  };
}

async function main(): Promise<void> {
  const serverA = await startServer(PORT_A, pageA);
  const serverB = await startServer(PORT_B, pageB);
  const downloadDir = mkdtempSync(join(tmpdir(), "d3multisite-dl-"));
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

    const compA = compileScenario(scenarioIr(ORIGIN_A, "reviews_visible"), {});
    const compB = compileScenario(scenarioIr(ORIGIN_B, "no_review_message_visible"), {});
    check("두 시나리오 컴파일", compA.ok && compB.ok);
    if (!compA.ok || !compB.ok) throw new Error("scenario compile 실패");

    await withTenantTx(pool, TENANT, async (c) => {
      // 2개 site_profile — url_pattern = canonical origin(서로 다름), 서로 다른 page_state_selectors.
      await c.query(`INSERT INTO site_profiles (id,tenant_id,name,url_pattern,page_state_selectors) VALUES ($1,$2,'A',$3,$4::jsonb)`, [SITE_A, TENANT, ORIGIN_A, JSON.stringify(selectorsA)]);
      await c.query(`INSERT INTO site_profiles (id,tenant_id,name,url_pattern,page_state_selectors) VALUES ($1,$2,'B',$3,$4::jsonb)`, [SITE_B, TENANT, ORIGIN_B, JSON.stringify(selectorsB)]);
      for (const [scen, sver, comp] of [[SCEN_A, SVER_A, compA] as const, [SCEN_B, SVER_B, compB] as const]) {
        await c.query(`INSERT INTO scenarios (id,tenant_id,name) VALUES ($1,$2,$3)`, [scen, TENANT, `s-${scen.slice(-4)}`]);
        await c.query(
          `INSERT INTO scenario_versions (id,tenant_id,scenario_id,version,promotion_status,ir,compiled_ast) VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
          [sver, TENANT, scen, JSON.stringify(comp.ir), comp.compiledAst],
        );
      }
      for (const [run, sver] of [[RUN_A, SVER_A] as const, [RUN_B, SVER_B] as const]) {
        await c.query(`INSERT INTO runs (id,tenant_id,scenario_version_id,status,correlation_id,attempts,as_of) VALUES ($1,$2,$3,'queued',$1,1,'2026-06-16T00:00:00Z')`, [run, TENANT, sver]);
      }
    });

    // run-loop의 per-run 해소 경로를 그대로 재현.
    async function driveRun(runId: string, sver: string, ir: unknown): Promise<{ siteId: string; flagKeys: string[]; state: string; dbStatus: string | null }> {
      const resolved = await withTenantTx(pool, TENANT, async (c) => {
        const entryUrlRef = extractEntryNavigateUrlRef(ir);
        const siteId = await resolveSiteProfileId(c, { tenantId: TENANT, entryUrlRef });
        const config = await loadSitePageStateConfig(c, TENANT, siteId);
        return { siteId, config };
      });
      const resolver = new SitePageStateResolver(provider, resolved.config);
      await withTenantTx(pool, TENANT, (c) =>
        applyRunTransition(c, { tenantId: TENANT, runId, fromStatus: "queued", event: { type: "worker.claimed" }, guard: { leaseAcquired: true }, correlationId: runId, workerId: WORKER, eventIdempotencyKey: `${runId}:worker.claimed` }),
      );
      const run: ClaimedRun = { runId, tenantId: TENANT, scenarioVersionId: sver, correlationId: runId, leaseId: "lease", siteProfileId: resolved.siteId, browserIdentityId: "bid", networkPolicyId: "np" };
      const result = await driveClaimedRun(run, { pool, executor, resolver, workerId: WORKER });
      const dbStatus = await withTenantTx(pool, TENANT, async (c) => {
        const r = await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [runId]);
        return r.rows[0]?.status ?? null;
      });
      return { siteId: resolved.siteId, flagKeys: Object.keys(resolved.config.flags), state: result.state, dbStatus };
    }

    const a = await driveRun(RUN_A, SVER_A, compA.ir);
    const b = await driveRun(RUN_B, SVER_B, compB.ir);

    check("run A → site A로 해소(entry origin A)", a.siteId === SITE_A, a.siteId);
    check("run B → site B로 해소(entry origin B)", b.siteId === SITE_B, b.siteId);
    check("두 run이 서로 다른 셀렉터셋 로드(reviews_visible vs no_review_message_visible)", a.flagKeys.join() === "reviews_visible" && b.flagKeys.join() === "no_review_message_visible", `A=${a.flagKeys} B=${b.flagKeys}`);
    check("run A: site별 flag로 completed", a.state === "completed" && a.dbStatus === "completed", `${a.state}/${a.dbStatus}`);
    check("run B: site별 flag로 completed", b.state === "completed" && b.dbStatus === "completed", `${b.state}/${b.dbStatus}`);

    // 음성: 0-match(미시드 origin) → SITE_PROFILE_UNRESOLVED.
    await withTenantTx(pool, TENANT, async (c) => {
      try {
        await resolveSiteProfileId(c, { tenantId: TENANT, entryUrlRef: "http://nowhere.invalid/x" });
        check("0-match → SITE_PROFILE_UNRESOLVED", false, "throw 기대");
      } catch (e) {
        check("0-match → SITE_PROFILE_UNRESOLVED", e instanceof SiteResolutionError && e.code === "SITE_PROFILE_UNRESOLVED", e instanceof Error ? e.message : String(e));
      }
    });

    // 음성: 같은 origin 다중 → SITE_PROFILE_AMBIGUOUS (origin C에 2개 시드).
    const ORIGIN_C = "http://127.0.0.1:39295";
    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO site_profiles (id,tenant_id,name,url_pattern) VALUES ($1,$2,'C1',$3)`, ["75000000-0000-0000-0000-0000000000c1", TENANT, ORIGIN_C]);
      await c.query(`INSERT INTO site_profiles (id,tenant_id,name,url_pattern) VALUES ($1,$2,'C2',$3)`, ["75000000-0000-0000-0000-0000000000c2", TENANT, `${ORIGIN_C}/other`]);
      try {
        await resolveSiteProfileId(c, { tenantId: TENANT, entryUrlRef: `${ORIGIN_C}/p` });
        check("같은 origin 다중 → SITE_PROFILE_AMBIGUOUS", false, "throw 기대");
      } catch (e) {
        check("같은 origin 다중 → SITE_PROFILE_AMBIGUOUS", e instanceof SiteResolutionError && e.code === "SITE_PROFILE_AMBIGUOUS", e instanceof Error ? e.message : String(e));
      }
    });
  } finally {
    await pool.end();
    await session.close();
    serverA.close();
    serverB.close();
    rmSync(downloadDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: 멀티사이트 run→site 해소 — 2 origin/2 셀렉터셋/2 시나리오가 각자 사이트로 해소·completed + 0-match/ambiguity loud (D3 가동 2단계)");
  process.exit(0);
}

main().catch((e) => {
  console.error("run-multisite-resolution int fatal:", e);
  process.exit(1);
});
