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
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIST = join(ROOT, "web", "dist");
const SCHEMA = "rpa_dev_console";
const PORT = Number(process.env.DEV_CONSOLE_PORT ?? 8080);
// dev 전용 HMAC 시크릿(프로덕션 사용 금지 — SecretStore 경계 밖, 시드 데이터에만 적용).
const SECRET = new TextEncoder().encode("dev-console-serve-secret-do-not-use-in-prod-0123456789");

const TENANT = "00000000-0000-0000-0000-0000000000d1";
const ASSIGNEE = "70000000-0000-0000-0000-0000000000c1";
const SCEN = "70000000-0000-0000-0000-00000000d101";
const SVER1 = "70000000-0000-0000-0000-00000000d102";
const SVER2 = "70000000-0000-0000-0000-00000000d103";
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

  // dev 토큰: 전 역할 union(최대 권한) → read + 모든 운영자 명령 클릭 테스트. 12h.
  const token = await new SignJWT({ sub: "00000000-0000-0000-0000-0000000000de", tenant_id: TENANT, roles: ["viewer", "operator", "reviewer", "approver", "admin"] })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(SECRET);

  // index.html에 토큰 부트스트랩 주입(모듈 스크립트 이전) → 브라우저만 열면 인증됨.
  const indexRaw = readFileSync(join(DIST, "index.html"), "utf8");
  const bootstrap = `<script>try{localStorage.setItem("rpa.token",${JSON.stringify(token)})}catch(e){}</script>`;
  const indexHtml = indexRaw.includes("</head>") ? indexRaw.replace("</head>", `${bootstrap}</head>`) : bootstrap + indexRaw;

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
    const p = (reqUrl.split("?")[0] ?? "/").replace(/^\/+/, "");
    const file = p === "" ? "" : join(DIST, p);
    if (p === "" || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(indexHtml); // SPA fallback + 토큰 주입
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
  console.log(`  roles:  viewer, operator, reviewer, approver, admin (dev 토큰 자동 주입)`);
  console.log(`  api:    127.0.0.1:${apiPort} (내부, /api/* 프록시)`);
  console.log("  종료: Ctrl-C (temp-PG 게이트가 클러스터 회수)");
  console.log("────────────────────────────────────────────────────────\n");

  const shutdown = (): void => {
    console.log("shutting down dev console…");
    server.close(() => {
      void api.close().then(() => pool.end()).then(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("dev serve fatal:", e);
  process.exit(1);
});
