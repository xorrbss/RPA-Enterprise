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
import { startRunLoop, DEV_BROWSER_IDENTITY_ID, type RunLoop } from "./run-loop";
import { startCaptureLoop, type CaptureLoop } from "./capture-loop";
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

// 로그인 픽스처(/fixture/login) — 그룹웨어풍 로그인 폼. 초기엔 .login-form 만 존재(.user-menu/.review-item 부재)라
// SitePageStateResolver 가 login_required=true·reviews_visible=false 로 산출. 로그인 버튼 클릭 시 JS 가 폼을 제거하고
// .user-menu + .review-item 들을 DOM 에 주입 → 재-observe 시 authenticatedWhen/reviews_visible=true. 자격증명은 실제
// 검증하지 않는다(픽스처) — 비어있지 않으면 로그인 성공 처리. (실 시크릿은 SecretStore→CDP fill 로만 흐른다.)
const LOGIN_FIXTURE_PATH = "/fixture/login";
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

const TENANT = "00000000-0000-0000-0000-0000000000d1";
const ASSIGNEE = "70000000-0000-0000-0000-0000000000c1";
const SCEN = "70000000-0000-0000-0000-00000000d101";
const SVER1 = "70000000-0000-0000-0000-00000000d102";
const SVER2 = "70000000-0000-0000-0000-00000000d103";
const DEMO_SCEN = "70000000-0000-0000-0000-00000000d201";
const DEMO_SVER = "70000000-0000-0000-0000-00000000d202";
const DEMO_SITE = "70000000-0000-0000-0000-00000000d203";
const LOGIN_SCEN = "70000000-0000-0000-0000-00000000d301";
const LOGIN_SVER = "70000000-0000-0000-0000-00000000d302";
const SESS_SCEN = "70000000-0000-0000-0000-00000000d401";
const SESS_SVER = "70000000-0000-0000-0000-00000000d402";
// 실 하이웍스(운영자-보조 캡처 데모): 로그인=login.office.hiworks.com, 로그인 후 office=dashboard.office.hiworks.com.
const HIWORKS_SITE = "70000000-0000-0000-0000-00000000d501";
const HIWORKS_BID = "9b000000-0000-0000-0000-0000000000b2";
const HIWORKS_SCEN = "70000000-0000-0000-0000-00000000d502";
const HIWORKS_SVER = "70000000-0000-0000-0000-00000000d503";
const HIWORKS_LOGIN_URL = "https://login.office.hiworks.com/ibizsoftware.net";
const HIWORKS_OFFICE_ORIGIN = "https://dashboard.office.hiworks.com";
// 삼성디스플레이 게스트 공지(route B 데모, 실측 recon 기반): bbsHPNO.do 그리드(getBbsList.json), 봇차단/로그인 없음.
const SAMSUNG_SITE = "70000000-0000-0000-0000-00000000d601";
const SAMSUNG_SCEN = "70000000-0000-0000-0000-00000000d602";
const SAMSUNG_SVER = "70000000-0000-0000-0000-00000000d603";
const SAMSUNG_NOTICE_URL = "https://guest.samsungdisplay.com/bbs/bbsHPNO.do";
const SAMSUNG_ORIGIN = "https://guest.samsungdisplay.com";
// 데모 사이트 프로파일의 PageState 산출 규칙(마커 없는 /fixture/reviews 셀렉터 매핑) — page_state_selectors 로 영속.
// loginUrl: 운영자-보조 캡처가 headful 로 띄울 로그인 페이지(사이트별 — resolver 는 무시, capture API 가 읽음).
const DEMO_PAGE_STATE_SELECTORS = {
  authenticatedWhen: { selector: ".user-menu" },
  loginUrl: `http://127.0.0.1:${PORT}/fixture/login`,
  flags: {
    reviews_visible: { kind: "min_count", selector: ".review-item", n: 1 },
    not_found: { kind: "present", selector: ".empty-results" },
    no_next_page: { kind: "present", selector: "a.next-page.disabled" },
    login_required: { kind: "present", selector: ".login-form" },
    blocked: { kind: "present", selector: ".blocked-banner" },
  },
};
// 삼성 공지 그리드 PageState(route B 데모): 행 렌더(.grid-row-rendered)=reviews_visible. observe 게이트가 이 flag 로
// 비동기 그리드 렌더를 settle 폴링 대기한다(아래 시나리오 ready 노드). ⚠ .grid-row-rendered 는 실 그리드의 행 클래스여야
// 한다(capture-grid-dom recon 으로 확정) — 불일치면 run 이 IR_NO_BRANCH_MATCHED 로 loud 실패(무음 빈 추출 아님). 로그인 없음 → flags 만.
const SAMSUNG_PAGE_STATE_SELECTORS = {
  flags: {
    reviews_visible: { kind: "min_count", selector: ".grid-row-rendered", n: 1 },
  },
};
const ts = (i: number) => `2026-06-15T10:0${i}:00Z`;

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

// 큐 run 시드 — scenario_version 이 실제로 시드된 경우에만 INSERT 한다. 시나리오 compile 실패 시(위에서 console.error 로
// 표면화) 해당 version 행이 없으므로, 무가드 INSERT 면 NOT NULL FK 위반으로 시드 전체가 크래시한다. EXISTS 가드로 그 run 만
// no-op 으로 건너뛴다(컴파일 실패는 이미 loud 로그됨 — 은폐 아님).
async function seedQueuedRun(
  pool: Pool,
  run: { id: string; sver: string; entryUrl: string; createdAt: string },
): Promise<void> {
  await withTenantTx(pool, TENANT, (c) =>
    c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, params, as_of, created_at)
       SELECT $1::uuid,$2::uuid,$3::uuid,'queued',$1::uuid,1,$4::jsonb,'2026-06-15T00:00:00Z',$5::timestamptz
       WHERE EXISTS (SELECT 1 FROM scenario_versions WHERE id=$3::uuid AND tenant_id=$2::uuid)`,
      [run.id, TENANT, run.sver, JSON.stringify({ entry_url: run.entryUrl }), run.createdAt],
    ),
  );
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
          open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "check" },
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
      // 데모 site_profile + page_state_selectors(jsonb) 영속 — run-loop가 entry URL origin으로 이 사이트를 해소해
      // 산출 규칙을 DB에서 로드. url_pattern은 canonical origin(scheme://host:port) — 매칭은 URL.origin 동일성.
      await c.query(
        `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, page_state_selectors)
         VALUES ($1,$2,'데모 사이트(리뷰)',$3,$4::jsonb)`,
        [DEMO_SITE, TENANT, `http://127.0.0.1:${PORT}`, JSON.stringify(DEMO_PAGE_STATE_SELECTORS)],
      );
      // dev 브라우저 정체성 — 세션 재사용(browser_sessions) 의 browser_identity_id FK 대상. run-loop 가 이 id 를 ClaimedRun 에 주입.
      await c.query(
        `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label, version) VALUES ($1,$2,$3,'dev-identity',1)`,
        [DEV_BROWSER_IDENTITY_ID, TENANT, DEMO_SITE],
      );
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'데모 — 리뷰 수집(실행 가능)')`, [DEMO_SCEN, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
         VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
        [DEMO_SVER, TENANT, DEMO_SCEN, JSON.stringify(demo.ir), demo.compiledAst],
      );

      // 로그인 자동화 시나리오: navigate → act(fill 아이디) → act(fill 비밀번호) → act(클릭 로그인) →
      // observe+on[](authenticatedWhen/reviews_visible 분기) → extract. 자격증명 fill 은 act.vars(meta.assets)→
      // secretRef→SecretStore→CDP fill 로만 흐른다(LLM 미경유). DEMO_SITE(동일 origin)의 page_state_selectors 재사용.
      const login = compileScenario(
        {
          meta: { name: "그룹웨어 로그인 + 메일 수집(실행 가능)", version: 1 },
          assets: ["login.username", "login.password"],
          start: "open",
          nodes: {
            open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "fill_user" },
            fill_user: {
              what: [
                {
                  action: "act",
                  instruction:
                    '로그인 폼의 아이디(username) 입력 필드를 채우는 동작. 반드시 JSON 한 줄로만 응답: {"operation":"fill","selector":"<아이디 입력칸 CSS 셀렉터>"}',
                  vars: ["login.username"],
                },
              ],
              next: "fill_pw",
            },
            fill_pw: {
              what: [
                {
                  action: "act",
                  instruction:
                    '로그인 폼의 비밀번호(password) 입력 필드를 채우는 동작. 반드시 JSON 한 줄로만 응답: {"operation":"fill","selector":"<비밀번호 입력칸 CSS 셀렉터>"}',
                  vars: ["login.password"],
                  sensitive: true,
                },
              ],
              next: "submit",
            },
            submit: {
              what: [
                {
                  action: "act",
                  instruction:
                    '로그인 제출 버튼을 클릭하는 동작. 반드시 JSON 한 줄로만 응답: {"operation":"click","selector":"<로그인 버튼 CSS 셀렉터>"}',
                },
              ],
              next: "check_auth",
            },
            check_auth: {
              what: [{ action: "observe" }],
              on: [
                { when: "flags.reviews_visible", target: "collect", priority: 2 },
                { when: "flags.login_required", target: "login_failed", priority: 1 },
              ],
            },
            collect: {
              what: [
                {
                  action: "extract",
                  instruction:
                    '로그인 후 보이는 항목들(.review-item)의 텍스트를 추출. 반드시 JSON 으로만 응답: {"rows":[{"text":"..."}]}',
                  schema_ref: "mail_rows",
                },
              ],
              next: "done",
            },
            done: { terminal: "success" },
            login_failed: { terminal: "fail_business" },
          },
        },
        {},
      );
      if (login.ok) {
        await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'그룹웨어 로그인 + 메일 수집(실행 가능)')`, [LOGIN_SCEN, TENANT]);
        await c.query(
          `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
           VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
          [LOGIN_SVER, TENANT, LOGIN_SCEN, JSON.stringify(login.ir), login.compiledAst],
        );
      } else {
        console.error("LOGIN scenario compile FAILED:", JSON.stringify(login));
      }

      // 세션 재사용(방식 A) 데모: 로그인 서브플로를 precheck(observe)+on[] 으로 **게이트**한다(LOGIN_SVER 는 login 노드가
      // observe 전에 next-체인이라 스킵 증명 불가). warm(쿠키 복원)이면 precheck 에서 reviews_visible→collect 로 바로 가
      // 로그인 노드(fill_user/fill_pw/submit)를 건너뛴다. cold 면 login_required→로그인 서브플로→recheck→collect.
      const sess = compileScenario(
        {
          meta: { name: "그룹웨어 세션 재사용 데모(실행 가능)", version: 1 },
          assets: ["login.username", "login.password"],
          start: "open",
          nodes: {
            open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "precheck" },
            precheck: {
              what: [{ action: "observe" }],
              on: [
                { when: "flags.reviews_visible", target: "collect", priority: 2 }, // 이미 인증(세션 복원됨) → 로그인 스킵
                { when: "flags.login_required", target: "fill_user", priority: 1 }, // 미인증 → 로그인 서브플로
              ],
            },
            fill_user: {
              what: [
                {
                  action: "act",
                  instruction:
                    '로그인 폼의 아이디(username) 입력 필드를 채우는 동작. 반드시 JSON 한 줄로만 응답: {"operation":"fill","selector":"<아이디 입력칸 CSS 셀렉터>"}',
                  vars: ["login.username"],
                },
              ],
              next: "fill_pw",
            },
            fill_pw: {
              what: [
                {
                  action: "act",
                  instruction:
                    '로그인 폼의 비밀번호(password) 입력 필드를 채우는 동작. 반드시 JSON 한 줄로만 응답: {"operation":"fill","selector":"<비밀번호 입력칸 CSS 셀렉터>"}',
                  vars: ["login.password"],
                  sensitive: true,
                },
              ],
              next: "submit",
            },
            submit: {
              what: [
                {
                  action: "act",
                  instruction:
                    '로그인 제출 버튼을 클릭하는 동작. 반드시 JSON 한 줄로만 응답: {"operation":"click","selector":"<로그인 버튼 CSS 셀렉터>"}',
                },
              ],
              next: "recheck",
            },
            recheck: {
              what: [{ action: "observe" }],
              on: [
                { when: "flags.reviews_visible", target: "collect", priority: 2 },
                { when: "flags.login_required", target: "login_failed", priority: 1 },
              ],
            },
            collect: {
              what: [
                {
                  action: "extract",
                  instruction:
                    '로그인 후 보이는 항목들(.review-item)의 텍스트를 추출. 반드시 JSON 으로만 응답: {"rows":[{"text":"..."}]}',
                  schema_ref: "mail_rows",
                },
              ],
              next: "done",
            },
            done: { terminal: "success" },
            login_failed: { terminal: "fail_business" },
          },
        },
        {},
      );
      if (sess.ok) {
        await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'그룹웨어 세션 재사용 데모(실행 가능)')`, [SESS_SCEN, TENANT]);
        await c.query(
          `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
           VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
          [SESS_SVER, TENANT, SESS_SCEN, JSON.stringify(sess.ir), sess.compiledAst],
        );
      } else {
        console.error("SESSION-REUSE scenario compile FAILED:", JSON.stringify(sess));
      }

      // 실 하이웍스 — 운영자-보조 캡처 데모. site_profile(office origin) + browser_identity + page_state_selectors
      // (authenticatedWhen=.new_header 오피스홈, login_required=로그인 ID 입력칸, loginUrl=login.office.hiworks.com).
      // '세션 등록' 버튼 → headful 로그인창 → 운영자 직접 로그인 → 세션 저장. 재사용 run 은 office 로 navigate → 인증 유지 확인.
      const HW_SELECTORS = {
        authenticatedWhen: { selector: ".new_header" },
        loginUrl: HIWORKS_LOGIN_URL,
        flags: {
          reviews_visible: { kind: "present", selector: ".new_header" }, // 오피스홈(로그인됨) 표시
          login_required: { kind: "present", selector: "input[placeholder='로그인 ID']" }, // 로그인 폼 표시
        },
      };
      await c.query(
        `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, page_state_selectors)
         VALUES ($1,$2,'하이웍스(ibizsoftware.net)',$3,'green',$4::jsonb)`,
        [HIWORKS_SITE, TENANT, HIWORKS_OFFICE_ORIGIN, JSON.stringify(HW_SELECTORS)],
      );
      await c.query(
        `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label, version) VALUES ($1,$2,$3,'hiworks-identity',1)`,
        [HIWORKS_BID, TENANT, HIWORKS_SITE],
      );
      // 재사용 검증 시나리오: office 로 navigate → observe → on[](reviews_visible=인증유지→done / login_required=세션만료→fail).
      const hw = compileScenario(
        {
          meta: { name: "하이웍스 세션 재사용 확인", version: 1 },
          start: "open",
          nodes: {
            open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "check" },
            check: {
              what: [{ action: "observe" }],
              on: [
                { when: "flags.reviews_visible", target: "done", priority: 2 }, // 오피스홈 보임 = 세션 재사용 성공(로그인 스킵)
                { when: "flags.login_required", target: "session_expired", priority: 1 }, // 로그인 폼 = 세션 없음/만료
              ],
            },
            done: { terminal: "success" },
            session_expired: { terminal: "fail_business" },
          },
        },
        {},
      );
      if (hw.ok) {
        await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'하이웍스 세션 재사용 확인')`, [HIWORKS_SCEN, TENANT]);
        await c.query(
          `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
           VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
          [HIWORKS_SVER, TENANT, HIWORKS_SCEN, JSON.stringify(hw.ir), hw.compiledAst],
        );
      } else {
        console.error("HIWORKS scenario compile FAILED:", JSON.stringify(hw));
      }

      // 삼성디스플레이 공지 수집(route B 데모) — navigate(bbsHPNO.do) → observe(그리드 렌더 대기) → extract. 봇차단/로그인 없음(실측).
      const samsung = compileScenario(
        {
          meta: { name: "삼성디스플레이 공지 수집", version: 1 },
          start: "open",
          nodes: {
            open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "ready" },
            // 비동기 그리드(getBbsList.json AJAX) 렌더 게이트 — observe 가 SitePageStateResolver 의 settle 폴링(≤10s)을 돌려
            // .grid-row-rendered 가 나타날 때까지 대기한 뒤 extract 로 진행한다(navigate 직후 즉시 extract 시 빈 그리드 경합 방지).
            // 끝까지 미렌더면 on[] 무매칭 → IR_NO_BRANCH_MATCHED 로 표면화(빈 그리드 무음 추출 금지 — "조용한 false 금지").
            ready: {
              what: [{ action: "observe" }],
              on: [{ when: "flags.reviews_visible", target: "collect", priority: 1 }],
            },
            collect: {
              what: [
                {
                  action: "extract",
                  instruction: "공지사항 목록 그리드의 각 행에서 제목, 작성자, 작성일, 조회수를 추출하라.",
                  schema_ref: "notice_rows",
                },
              ],
              next: "done",
            },
            done: { terminal: "success" },
          },
        },
        {},
      );
      if (samsung.ok) {
        await c.query(
          `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, page_state_selectors)
           VALUES ($1,$2,'삼성디스플레이(게스트 공지)',$3,$4::jsonb)`,
          [SAMSUNG_SITE, TENANT, SAMSUNG_ORIGIN, JSON.stringify(SAMSUNG_PAGE_STATE_SELECTORS)],
        );
        await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'삼성디스플레이 공지 수집')`, [SAMSUNG_SCEN, TENANT]);
        await c.query(
          `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast)
           VALUES ($1,$2,$3,1,'prod',$4::jsonb,$5)`,
          [SAMSUNG_SVER, TENANT, SAMSUNG_SCEN, JSON.stringify(samsung.ir), samsung.compiledAst],
        );
      } else {
        console.error("SAMSUNG scenario compile FAILED:", JSON.stringify(samsung));
      }
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

  // 실행 가능 데모 run: queued + params.entry_url(navigate.url_ref 가 이 키로 해소) → 부팅 시 run-loop가 구동.
  // (콘솔 '실행' 버튼은 params:{} 를 보내므로 파라미터 시나리오엔 부족 — web 측 params 입력은 후속, 아래 TODO 참조)
  await seedQueuedRun(pool, {
    id: "71000000-0000-0000-0000-0000000000d6",
    sver: DEMO_SVER,
    entryUrl: `http://127.0.0.1:${PORT}${FIXTURE_PATH}`,
    createdAt: ts(6),
  });

  // 삼성 공지 수집 run(queued, route B 데모) — 부팅 시 run-loop가 실 Chrome로 navigate(bbsHPNO.do)→observe→extract 구동.
  await seedQueuedRun(pool, {
    id: "71000000-0000-0000-0000-0000000000d9",
    sver: SAMSUNG_SVER,
    entryUrl: SAMSUNG_NOTICE_URL,
    createdAt: ts(9),
  });

  // (LOGIN_SVER 데모 시나리오는 콘솔 참조용으로 시드돼 있으나 auto-run 하지 않는다 — SESS_SVER 와 세션 키
  //  (tenant/site/bid)를 공유해 먼저 캡처하면 아래 세션 재사용 cold 증명을 오염시키기 때문. 로그인 경로는 d8 cold 가 검증.)

  // 세션 재사용 cold-start run(Run 1): 저장된 세션 없음 → precheck 에서 login_required → 로그인 서브플로 → 성공 후 캡처.
  // 이후 warm run(API 생성)은 복원으로 로그인 스킵. (게이트 시나리오 SESS_SVER)
  await seedQueuedRun(pool, {
    id: "71000000-0000-0000-0000-0000000000d8",
    sver: SESS_SVER,
    entryUrl: `http://127.0.0.1:${PORT}${LOGIN_FIXTURE_PATH}`,
    createdAt: ts(8),
  });

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

  // gateway_policies: 2 모델. gpt-4o-mini=테넌트 기본(is_default) — 콘솔 '실행'(model 미지정)이 기본 정책으로
  // 자동 해소되게(부재 시 다정책 테넌트는 model_required 422). 실 Codex 게이트웨이가 gpt-4o-mini 라 기본 적합.
  for (const [id, model, isDefault] of [
    ["79000000-0000-0000-0000-0000000000d1", "gpt-4o-mini", true],
    ["79000000-0000-0000-0000-0000000000d2", "claude-haiku", false],
  ] as const) {
    await withTenantTx(pool, TENANT, (c) =>
      c.query(
        `INSERT INTO gateway_policies (id, tenant_id, model, version, is_default, capabilities, budget, fallback_config)
         VALUES ($1,$2,$3,1,$4,'{"jsonMode":true,"vision":false}'::jsonb,'{"maxInputTokens":1000}'::jsonb,'{"model":"fallback"}'::jsonb)`,
        [id, TENANT, model, isDefault],
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
