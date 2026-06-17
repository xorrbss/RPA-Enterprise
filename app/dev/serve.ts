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
 * (시드 로직은 seed.ts / seed-scenarios.ts / 공용 상수는 dev-constants.ts 로 분리 — 이 파일은 서버·부트스트랩만.)
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import { createPool } from "../src/db/pool";
import { FsObjectStore } from "../src/gateway/pg-gateway-artifact-sink";
import { startRunLoop, type RunLoop } from "./run-loop";
import { startCaptureLoop, type CaptureLoop } from "./capture-loop";
import { startRedactionLoop, type RedactionLoop } from "./redaction-loop";
import { seed } from "./seed";
import { PORT, TENANT, FIXTURE_PATH, LOGIN_FIXTURE_PATH } from "./dev-constants";
import { ContractDurableSecurityAuditWriter, InMemoryImmutableAuditLog } from "../../security/compliance-scaffold";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIST = join(ROOT, "web", "dist");
const SCHEMA = "rpa_dev_console";

// /fixture/reviews 응답 본문(마커 없는 실 URL풍 리뷰 페이지) — dev 런타임 루프가 SitePageStateResolver 로 PageState 산출.
const FIXTURE_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>상품 리뷰</title></head>
<body>
<header role="banner"><h1>상품</h1><div class="user-menu">내 계정</div></header>
<main role="main"><section class="reviews"><article class="review-item">좋아요</article><article class="review-item">별로</article><article class="review-item">보통</article></section>
<a class="next-page disabled" aria-disabled="true">다음</a></main>
<footer role="contentinfo"><small>©</small></footer></body></html>`;
// 쿠키 인식 픽스처(세션 재사용 방식 A). 로드 시 document.cookie 의 rpa_sess=1 유무로 분기:
//  - 쿠키 있음(복원됨) → 인증 DOM(.user-menu + .review-item) 렌더, 로그인 폼 없음 → login_required=false, reviews_visible=true.
//  - 쿠키 없음(cold) → 로그인 폼(.login-form) 렌더 → login_required=true. 로그인 성공 시 rpa_sess 쿠키를 set(다음 run 캡처 대상).
// driver 가 navigate 이전에 저장된 쿠키를 CDP 로 주입하므로, warm run 은 폼 없이 인증 상태로 진입한다(로그인 스킵 증명).
const LOGIN_FIXTURE_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>그룹웨어 로그인</title></head>
<body>
<header role="banner"><h1>그룹웨어</h1></header>
<main role="main" id="app"></main>
<footer role="contentinfo"><small>©</small></footer>
<script>
function authedHtml(){return '<div class="user-menu">내 계정</div><section class="reviews"><article class="review-item">받은편지함 12</article><article class="review-item">결재 대기 3</article><article class="review-item">오늘 일정 5</article></section>';}
function loginHtml(){return '<form class="login-form" id="login-form" onsubmit="return doLogin(event)"><label>아이디 <input id="username" name="username" type="text" autocomplete="username"></label><label>비밀번호 <input id="password" name="password" type="password" autocomplete="current-password"></label><button id="login-submit" type="submit">로그인</button></form>';}
function hasSession(){return /(^|;\\s*)rpa_sess=1(;|$)/.test(document.cookie);}
function render(){document.getElementById('app').innerHTML = hasSession() ? authedHtml() : loginHtml();}
function doLogin(e){
  e.preventDefault();
  var u=document.getElementById('username').value, p=document.getElementById('password').value;
  if(u && p){ document.cookie='rpa_sess=1; path=/'; render(); }
  return false;
}
render();
</script>
</body></html>`;
// dev 전용 HMAC 시크릿(프로덕션 사용 금지 — SecretStore 경계 밖, 시드 데이터에만 적용).
const SECRET = new TextEncoder().encode("dev-console-serve-secret-do-not-use-in-prod-0123456789");

// 전용 BYPASSRLS 역할(비-superuser) — redaction 승격 루프 전용(프로덕션 lifecycle 운영 역할 경계 미러, auth-rbac §4).
// pending/failed 아티팩트는 RLS(artifacts_visible_isolation)가 은닉 → 이 역할로만 읽어 redacted 로 승격한다
// (앱 역할 rpa_smoke 로는 UPDATE/SELECT 불가). 프로비저닝은 admin(postgres, trust) 연결로 1회(테스트 패턴 미러).
const LIFECYCLE_BYPASS_ROLE = "rpa_dev_lifecycle_bypass";
const LIFECYCLE_BYPASS_PASSWORD = "rpa_dev_lifecycle_bypass"; // CI 비밀번호 인증용; 로컬 temp-PG(trust)는 무시.

/** 전용 BYPASSRLS 역할 프로비저닝(admin=postgres). 마이그레이션 이후 1회 — GRANT 는 그 시점 테이블 스냅샷. */
async function createLifecycleBypassRole(): Promise<void> {
  const admin = createPool({
    host: process.env.PGHOST,
    port: process.env.PGPORT === undefined ? undefined : Number(process.env.PGPORT),
    database: process.env.PGDATABASE,
    user: "postgres",
    password: process.env.PGADMIN_PASSWORD, // 로컬 temp-PG(trust)는 무시.
    options: `-c search_path=${SCHEMA},public`,
  });
  try {
    await admin.query(`DROP ROLE IF EXISTS ${LIFECYCLE_BYPASS_ROLE}`);
    await admin.query(
      `CREATE ROLE ${LIFECYCLE_BYPASS_ROLE} LOGIN PASSWORD '${LIFECYCLE_BYPASS_PASSWORD}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${LIFECYCLE_BYPASS_ROLE}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${SCHEMA} TO ${LIFECYCLE_BYPASS_ROLE}`);
  } finally {
    await admin.end();
  }
}

/**
 * dev 전용 .env 로더(레포 루트). 코드에 dotenv 의존 없이 CODEX_·HIWORKS_ 변수를 process.env 로 주입(이미 설정된 키는
 * 보존). 시크릿 값은 process.env 에만 들어가고 로그에 안 찍는다. run-loop 의 Codex 게이트웨이/SecretStore 가 읽는다.
 */
function loadDotEnv(): void {
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

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

async function main(): Promise<void> {
  loadDotEnv(); // CODEX_*/HIWORKS_* 주입(run-loop Codex 게이트웨이/SecretStore 전에).
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
  await createLifecycleBypassRole(); // redaction 승격 루프 전용 BYPASSRLS 역할(테이블 존재 후).
  await seed(pool);
  console.log("seeded: 5 runs · 3 human-tasks · 4 workitems · 2 dead-letters · 2 gateway policies · 3 sites");

  // 아티팩트 object store(FS) — run-loop 의 실 sink(LLM 출력 영속)와 GET /v1/artifacts/{id} read 와 redaction
  // 승격 루프가 동일 디렉터리를 공유한다. securityAudit 는 artifact.read 본문 disclosure 의 fail-closed audit 경계
  // (security-contracts §10; artifactStore 와 짝 — 미주입 시 read 라우트 미등록). dev 는 in-memory audit 로 충분.
  const artifactDir = mkdtempSync(join(tmpdir(), "dev-artifacts-"));
  const objectStore = new FsObjectStore(artifactDir);
  const securityAudit = new ContractDurableSecurityAuditWriter(new InMemoryImmutableAuditLog());

  const noopEnqueuer: RunEnqueuer = { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} };
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
    artifactStore: objectStore, // GET /v1/artifacts/{id} 등록(인박스가 수집 아티팩트 본문을 읽음).
    securityAudit,
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
    if ((reqUrl.split("?")[0] ?? "") === LOGIN_FIXTURE_PATH) {
      // 로그인 자동화 픽스처(act fill→submit→authenticatedWhen 전이).
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(LOGIN_FIXTURE_HTML);
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
  // objectStore 공유 → 실 sink 가 LLM 출력을 이 디렉터리에 영속(redaction-loop 가 동일 store 로 읽어 승격).
  const runLoop: RunLoop | null = await startRunLoop(pool, TENANT, objectStore);
  // dev 캡처 폴러: 콘솔 '세션 등록'(capture_sessions launching)을 폴링해 별도 headful 로그인창을 띄운다(run-loop 의 공유 세션과 무관).
  const captureLoop: CaptureLoop | null = await startCaptureLoop(pool, TENANT);
  // dev redaction 승격 루프: 전용 BYPASSRLS 역할로 pending 아티팩트를 실 §4 변환 후 redacted 로 승격(RLS 노출).
  const bypassPool = createPool({
    host: process.env.PGHOST,
    port: process.env.PGPORT === undefined ? undefined : Number(process.env.PGPORT),
    database: process.env.PGDATABASE,
    user: LIFECYCLE_BYPASS_ROLE,
    password: LIFECYCLE_BYPASS_PASSWORD,
    options: `-c search_path=${SCHEMA},public`,
  });
  const redactionLoop: RedactionLoop = startRedactionLoop(bypassPool, objectStore, TENANT);

  const shutdown = (): void => {
    console.log("shutting down dev console…");
    void (async () => {
      try {
        await redactionLoop.stop();
      } catch {
        /* ignore */
      }
      try {
        await bypassPool.end();
      } catch {
        /* ignore */
      }
      if (captureLoop !== null) {
        try {
          await captureLoop.stop();
        } catch {
          /* ignore */
        }
      }
      if (runLoop !== null) {
        try {
          await runLoop.stop();
        } catch {
          /* ignore */
        }
      }
      rmSync(artifactDir, { recursive: true, force: true });
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
