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
 *
 * Phase 0 "지켜보는 데모"(운영자 동선): 콘솔 → 제작 > 테스트 실행(playground)에서 자동화 선택 → '실행 시작'을 누르면
 *   그 run 의 라이브 트레이스(#runTrace?run=<id>)로 자동 이동하고, 단계 트레이스에서 자동 복구 신호(재시도·캐시 계획
 *   재생·비정상 응답 종료)가 상단 요약으로 한눈에 보인다. act/extract(LLM 경유) 모먼트는 CODEX_*(또는 OPENAI) env +
 *   Chrome 이 있어야 실제로 구동된다(미설정 시 run 은 queued 대기 — run-loop 비활성).
 * 세션 재사용(로그인 스킵) 모먼트는 단계 신호가 아니라 분기로만 관찰된다(짧은 트레이스 = 로그인 단계 부재). 실제로 보려면
 *   고급 설정 > 보안에서 사이트 '세션 등록'(운영자-보조 캡처)을 1회 수행한 뒤 같은 시나리오를 재실행한다. ⚠ dev:serve 는
 *   temp PG 라 재기동(=reseed)하면 캡처 세션이 소실되므로 재시연마다 재캡처가 필요하다 — 실 로그인/실 시크릿은 오너 실행 영역.
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
import { createPool } from "../src/db/pool";
import { startRunLoop, type RunLoop } from "./run-loop";
import { startCaptureLoop, type CaptureLoop } from "./capture-loop";
import { seed } from "./seed";
import { PORT, TENANT, FIXTURE_PATH, LOGIN_FIXTURE_PATH } from "./dev-constants";
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
  await seed(pool);
  console.log("seeded: 5 runs · 3 human-tasks · 4 workitems · 2 dead-letters · 2 gateway policies · 3 sites");

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
  const runLoop: RunLoop | null = await startRunLoop(pool, TENANT);
  // dev 캡처 폴러: 콘솔 '세션 등록'(capture_sessions launching)을 폴링해 별도 headful 로그인창을 띄운다(run-loop 의 공유 세션과 무관).
  const captureLoop: CaptureLoop | null = await startCaptureLoop(pool, TENANT);

  const shutdown = (): void => {
    console.log("shutting down dev console…");
    void (async () => {
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
