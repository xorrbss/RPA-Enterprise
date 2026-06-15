/**
 * Dev 풀스택 서버 (테스트용, 프로덕션 아님).
 *
 * console-live.e2e.ts의 검증된 배선을 lift: temp-PG에 마이그레이션 적용 → 단일 테넌트 시드 →
 * 실 buildServer(Fastify 제어평면) listen → web/dist 정적 + /api/* 역프록시(same-origin, CORS 불요).
 * 차이: 브라우저(puppeteer)를 띄우지 않고 상주하며, dev JWT를 index.html에 자동 주입해
 * 사용자가 URL만 열면 read/명령이 바로 동작한다.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app run dev:serve
 *
 * 주의: 시드/스키마는 일회용. 게이트 종료 시 temp 클러스터가 회수된다. 시크릿/RLS/RBAC 경계는 실코드 그대로다.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import { createPool, withTenantTx } from "../src/db/pool";
import { compileScenario } from "../src/api/compile-pipeline";
import { startRunLoop, type RunLoop } from "./run-loop";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIST = join(ROOT, "web", "dist");
const SCHEMA = "rpa_dev_console";
const PORT = Number(process.env.DEV_CONSOLE_PORT ?? 8080);
// site-profile 픽스처(/fixture/reviews) — 마커 없는 실 URL풍 리뷰 페이지.
// dev 런타임 루프가 SitePageStateResolver(셀렉터→flag)로 PageState를 산출해 completed까지 구동한다(2단계).
const FIXTURE_PATH = "/fixture/reviews";
const FIXTURE_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>상품 리뷰</title></head>
<body>
<header role="banner"><h1>상품</h1><div class="user-menu">내 계정</div></header>
<main role="main"><section class="reviews"><article class="review-item">좋아요</article><article class="review-item">별로</article><article class="review-item">보통</article></section>
<a class="next-page disabled" aria-disabled="true">다음</a></main>
<footer role="contentinfo"><small>©</small></footer></body></html>`;
// dev 전용 HMAC 시크릿(프로덕션 사용 금지 — SecretStore 경계 밖, 시드 데이터에만 적용).
const SECRET = new TextEncoder().encode("dev-console-serve-secret-do-not-use-in-prod-0123456789");

const TENANT = "00000000-0000-0000-0000-0000000000d1";
const ASSIGNEE = "70000000-0000-0000-0000-0000000000c1";
const SCEN = "70000000-0000-0000-0000-00000000d101";
const SVER1 = "70000000-0000-0000-0000-00000000d102";
const SVER2 = "70000000-0000-0000-0000-00000000d103";
const DEMO_SCEN = "70000000-0000-0000-0000-00000000d201";
const DEMO_SVER = "70000000-0000-0000-0000-00000000d202";
const ts = (i: number) => `2026-06-15T10:0${i}:00Z`;

type Pool = ReturnType<typeof createPool>;

function contentType(ext: string): string {
  switch (ext) {
    case ".js":
      return "text/javascript";
    case ".css":
      return "text/css";
    case ".html":
      return "text/html";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json";
    case ".ico":
      return "image/x-icon";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

async function seed(pool: Pool): Promise<void> {
  await withTenantTx(pool, TENANT, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'주문 수집 자동화')`, [SCEN, TENANT]);
    // 실행 계획이 있는 IR(테스트 실행/편집 prefill 데모용). raw seed라 compile은 건너뜀(promote 시 재검증).
    const seedIr = JSON.stringify({
      meta: { name: "주문 수집 자동화", version: 1 },
      start: "n1",
      nodes: {
        n1: { what: [{ action: "navigate", url_ref: "orders_url" }], next: "n2" },
        n2: {
          what: [{ action: "observe" }],
          on: [
            { when: "flags.reviews_visible", target: "n3", priority: 2 },
            { when: "flags.not_found", target: "n4", priority: 1 },
          ],
        },
        n3: { what: [{ action: "extract", schema_ref: "order_rows" }], next: "n4" },
        n4: { terminal: "success" },
      },
    });
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'prod',$5::jsonb), ($4,$2,$3,2,'draft',$5::jsonb)`,
      [SVER1, TENANT, SCEN, SVER2, seedIr],
    );

    // 데모 자동화: site-profile 픽스처(/fixture/reviews, 마커 없음)를 가리켜 dev 런타임 루프가
    // SitePageStateResolver로 실제 completed까지 구동 가능(compiled_ast 포함).
    const demo = compileScenario(
      {
        meta: { name: "데모 — 리뷰 수집(실행 가능)", version: 1 },
        start: "open",
        nodes: {
          open: { what: [{ action: "navigate", url_ref: `http://127.0.0.1:${PORT}${FIXTURE_PATH}` }], next: "check" },
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
      },
      {},
    );
    if (demo.ok) {
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'데모 — 리뷰 수집(실행 가능)')`, [DEMO_SCEN, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [DEMO_SVER, TENANT, DEMO_SCEN, JSON.stringify(demo.ir), demo.compiledAst],
      );
    }
  });

  // runs: running×3 / completed / suspended.
  const RUNS: ReadonlyArray<readonly [string, string, string, number]> = [
    ["71000000-0000-0000-0000-0000000000d1", "running", SVER1, 0],
    ["71000000-0000-0000-0000-0000000000d2", "running", SVER1, 1],
    ["71000000-0000-0000-0000-0000000000d3", "completed", SVER2, 2],
    ["71000000-0000-0000-0000-0000000000d4", "suspended", SVER1, 3],
    ["71000000-0000-0000-0000-0000000000d5", "running", SVER2, 4],
  ];
  for (const [id, status, sver, i] of RUNS) {
    await withTenantTx(pool, TENANT, (c) =>
      c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, as_of, created_at)
         VALUES ($1,$2,$3,$4,$1,1,'2026-06-15T00:00:00Z',$5::timestamptz)`,
        [id, TENANT, sver, status, ts(i)],
      ),
    );
  }
  const SUSPENDED_RUN = RUNS[3][0];

  // human_tasks: open(exception) / assigned(approval) / open(approval) — assign·start·resolve·escalate 테스트용.
  const HTS: ReadonlyArray<readonly [string, string, string, string | null, number]> = [
    ["73000000-0000-0000-0000-0000000000d1", "open", "exception", null, 0],
    ["73000000-0000-0000-0000-0000000000d2", "assigned", "approval", ASSIGNEE, 1],
    ["73000000-0000-0000-0000-0000000000d3", "open", "approval", null, 2],
  ];
  for (const [id, state, kind, assignee, i] of HTS) {
    await withTenantTx(pool, TENANT, (c) =>
      c.query(
        `INSERT INTO human_tasks (id, tenant_id, run_id, kind, state, assignee, expires_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6::uuid,'2026-07-01T00:00:00Z',$7::timestamptz)`,
        [id, TENANT, SUSPENDED_RUN, kind, state, assignee, ts(i)],
      ),
    );
  }

  // workitems: new / processing / abandoned×2.
  const WIS: ReadonlyArray<readonly [string, string, string, number]> = [
    ["75000000-0000-0000-0000-0000000000d1", "wi-1", "new", 0],
    ["75000000-0000-0000-0000-0000000000d2", "wi-2", "processing", 1],
    ["75000000-0000-0000-0000-0000000000d3", "wi-3", "abandoned", 2],
    ["75000000-0000-0000-0000-0000000000d4", "wi-4", "abandoned", 3],
  ];
  for (const [id, ref, status, i] of WIS) {
    await withTenantTx(pool, TENANT, (c) =>
      c.query(
        `INSERT INTO workitems (id, tenant_id, connector_id, unique_reference, status, attempts, created_at)
         VALUES ($1,$2,'reviews',$3,$4,2,$5::timestamptz)`,
        [id, TENANT, ref, status, ts(i)],
      ),
    );
  }

  // dead_letter: 2 미복원(재처리 W10 테스트용).
  const DLS: ReadonlyArray<readonly [string, string, number]> = [
    ["77000000-0000-0000-0000-0000000000d1", WIS[2][0], 0],
    ["77000000-0000-0000-0000-0000000000d2", WIS[3][0], 1],
  ];
  for (const [id, wi, i] of DLS) {
    await withTenantTx(pool, TENANT, (c) =>
      c.query(
        `INSERT INTO dead_letter (id, tenant_id, workitem_id, reason_code, replayable, created_at, replayed_at)
         VALUES ($1,$2,$3,'WORKITEM_CHECKOUT_CONFLICT',true,$4::timestamptz,null)`,
        [id, TENANT, wi, ts(i)],
      ),
    );
  }

  // gateway_policies: 2 모델.
  for (const [id, model] of [
    ["79000000-0000-0000-0000-0000000000d1", "gpt-4o-mini"],
    ["79000000-0000-0000-0000-0000000000d2", "claude-haiku"],
  ]) {
    await withTenantTx(pool, TENANT, (c) =>
      c.query(
        `INSERT INTO gateway_policies (id, tenant_id, model, version, capabilities, budget, fallback_config)
         VALUES ($1,$2,$3,1,'{"jsonMode":true,"vision":false}'::jsonb,'{"maxInputTokens":1000}'::jsonb,'{"model":"fallback"}'::jsonb)`,
        [id, TENANT, model],
      ),
    );
  }

  // site_profiles: risk/approval/circuit 혼합 3건.
  const SITES: ReadonlyArray<readonly [string, string, string, boolean, string, number]> = [
    ["7a000000-0000-0000-0000-0000000000d1", "red-site", "red", true, "open", 0],
    ["7a000000-0000-0000-0000-0000000000d2", "green-site", "green", false, "closed", 1],
    ["7a000000-0000-0000-0000-0000000000d3", "amber-site", "amber", false, "half_open", 2],
  ];
  for (const [id, name, risk, approved, circuit, i] of SITES) {
    await withTenantTx(pool, TENANT, (c) =>
      c.query(
        `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved, circuit_state, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)`,
        [id, TENANT, name, `https://${name}.example/*`, risk, approved, circuit, ts(i)],
      ),
    );
  }
}

async function main(): Promise<void> {
  if (!existsSync(join(DIST, "index.html"))) {
    console.error("FAIL: web/dist 없음 — 먼저 `npm --prefix web run build`");
    process.exit(1);
  }

  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });

  const setup = await pool.connect();
  try {
    await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await setup.query(`CREATE SCHEMA ${SCHEMA}`);
    await setup.query(`SET search_path = ${SCHEMA}, public`);
    await setup.query(readFileSync(join(ROOT, "db", "migration_concurrency_idempotency.sql"), "utf8"));
    await setup.query(readFileSync(join(ROOT, "db", "migration_core_entities.sql"), "utf8"));
  } finally {
    setup.release();
  }
  console.log("migrations applied (concurrency → core)");
  await seed(pool);
  console.log("seeded: 5 runs · 3 human-tasks · 4 workitems · 2 dead-letters · 2 gateway policies · 3 sites");

  const noopEnqueuer: RunEnqueuer = { async enqueueRunClaim() {}, async enqueueRunAbort() {} };
  const signedCommandRegistry: SignedCommandRegistry = {
    async listAllowedCommandRefs() {
      return { kind: "available", snapshot: { sourceRef: "secret://dev/registry" as SecretRef, commands: [] } };
    },
  };
  const api = buildServer({
    pool,
    auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
    rbac: new RoleMatrixRbacMiddleware(),
    idempotency: new PgControlPlaneIdempotencyStore(pool),
    enqueuer: noopEnqueuer,
    signedCommandRegistry,
  });
  await api.ready();
  await api.listen({ port: 0, host: "127.0.0.1" });
  const apiAddr = api.server.address();
  if (apiAddr === null || typeof apiAddr === "string") throw new Error("api addr");
  const apiPort = apiAddr.port;

  // dev 토큰: 전 역할 union(최대 권한)이 기본. ?role=<viewer|operator|reviewer|approver|admin>로 단일 역할
  // 토큰을 주입해 RBAC UI 게이팅(권한 없는 명령 버튼 숨김)을 시연한다. 12h.
  const SUBJECT = "00000000-0000-0000-0000-0000000000de";
  const mintToken = (roles: readonly string[]): Promise<string> =>
    new SignJWT({ sub: SUBJECT, tenant_id: TENANT, roles })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("12h")
      .sign(SECRET);
  const ROLE_SETS: Record<string, readonly string[]> = {
    all: ["viewer", "operator", "reviewer", "approver", "admin"],
    viewer: ["viewer"],
    operator: ["operator"],
    reviewer: ["reviewer"],
    approver: ["approver"],
    admin: ["admin"],
  };

  // index.html에 역할별 토큰 부트스트랩 주입(모듈 스크립트 이전) → 브라우저만 열면 인증됨.
  const indexRaw = readFileSync(join(DIST, "index.html"), "utf8");
  // 토큰 부트스트랩(head) + dev 역할 전환 위젯(body, 고정 위치 드롭다운 → ?role= 이동). dev 전용, React 앱 무관.
  const injectHtml = (roleName: string, tk: string): string => {
    const bootstrap = `<script>try{localStorage.setItem("rpa.token",${JSON.stringify(tk)})}catch(e){}</script>`;
    const opts = ["all", "viewer", "operator", "reviewer", "approver", "admin"]
      .map((r) => `<option value="${r}"${r === roleName ? " selected" : ""}>${r}</option>`)
      .join("");
    const widget =
      `<div style="position:fixed;top:8px;right:8px;z-index:99999;background:#fff;border:1px solid #ccc;border-radius:6px;padding:4px 8px;font:12px sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.15)">` +
      `dev 역할 <select onchange="location.href='/?role='+this.value" style="font:12px sans-serif">${opts}</select></div>`;
    let html = indexRaw.includes("</head>") ? indexRaw.replace("</head>", `${bootstrap}</head>`) : bootstrap + indexRaw;
    html = html.includes("</body>") ? html.replace("</body>", `${widget}</body>`) : html + widget;
    return html;
  };
  const htmlByRole: Record<string, string> = {};
  for (const [name, roles] of Object.entries(ROLE_SETS)) htmlByRole[name] = injectHtml(name, await mintToken(roles));
  const indexHtml = htmlByRole.all ?? injectHtml("all", await mintToken(ROLE_SETS.all ?? []));

  const server = http.createServer((req, res) => {
    const reqUrl = req.url ?? "/";
    if (reqUrl.startsWith("/api/")) {
      const upstreamPath = reqUrl.slice("/api".length); // /api/v1/.. → /v1/..
      const headers = { ...req.headers };
      delete headers.host;
      const pReq = http.request(
        { host: "127.0.0.1", port: apiPort, method: req.method, path: upstreamPath, headers },
        (pRes) => {
          res.writeHead(pRes.statusCode ?? 502, pRes.headers);
          pRes.pipe(res);
        },
      );
      pReq.on("error", () => {
        res.writeHead(502);
        res.end("proxy error");
      });
      req.pipe(pReq);
      return;
    }
    if ((reqUrl.split("?")[0] ?? "") === FIXTURE_PATH) {
      // PageState 계약 마커 픽스처(데모 자동화 대상). 실행기가 flags를 산출할 수 있는 유일한 페이지.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(FIXTURE_HTML);
      return;
    }
    const [pathPart, queryPart] = reqUrl.split("?");
    const p = (pathPart ?? "/").replace(/^\/+/, "");
    const file = p === "" ? "" : join(DIST, p);
    if (p === "" || !existsSync(file) || statSync(file).isDirectory()) {
      // ?role=<role>이면 단일 역할 토큰 주입(게이팅 시연), 아니면 전 역할 기본.
      const roleParam = new URLSearchParams(queryPart ?? "").get("role");
      const html = roleParam !== null && htmlByRole[roleParam] !== undefined ? htmlByRole[roleParam] : indexHtml;
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html); // SPA fallback + 토큰 주입
      return;
    }
    res.writeHead(200, { "content-type": contentType(extname(file)) });
    res.end(readFileSync(file));
  });

  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${PORT}/`;
  console.log("\n────────────────────────────────────────────────────────");
  console.log(`  RPA 운영 콘솔 dev 서버 (실 Fastify → PostgreSQL)`);
  console.log(`  URL:    ${url}`);
  console.log(`  tenant: ${TENANT}`);
  console.log(`  roles:  전 역할 자동 주입 (기본). ?role=viewer|operator|reviewer|approver|admin 로 단일 역할 시연`);
  console.log(`  api:    127.0.0.1:${apiPort} (내부, /api/* 프록시)`);
  console.log("  종료: Ctrl-C (temp-PG 게이트가 클러스터 회수)");
  console.log("────────────────────────────────────────────────────────\n");

  // dev 런타임 루프: queued run을 claim→실행기 구동(실 Chrome). 마커 픽스처 데모 시나리오만 completed까지 간다.
  const runLoop: RunLoop | null = await startRunLoop(pool, TENANT);

  const shutdown = (): void => {
    console.log("shutting down dev console…");
    void (async () => {
      if (runLoop !== null) {
        try {
          await runLoop.stop();
        } catch {
          /* ignore */
        }
      }
      server.close(() => {
        void api.close().then(() => pool.end()).then(() => process.exit(0));
      });
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("dev serve fatal:", e);
  process.exit(1);
});
