/**
 * 통합 — 운영자-로컬 캡처 에이전트(src/agent/capture-agent) end-to-end. 실 PostgreSQL + 실 listen 서버.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npx tsx app/test/capture-agent.int.ts
 * 검증: capture-start → (fake 헤드풀 캡처) → capture-complete 왕복으로 browser_sessions 봉투 저장 + capture_sessions
 *       status=captured. 에이전트가 서버에서 받은 login_url/auth_selector 를 캡처 코어로 전달. 로그인 타임아웃(null)→
 *       login_timeout 결과·capture-complete 미호출·세션 미저장. auth_selector 미설정 사이트→loud throw.
 *
 * 헤드풀 Chrome 캡처 코어(awaitLoginCookies)는 capture-core.unit + 실 하이웍스 e2e 로 별도 증명됨 — 본 테스트는 신규 위험인
 * HTTP 오케스트레이션(토큰·멱등키·응답 파싱·전송)을 fake captureCookies 로 격리 검증한다.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import { createPool, withTenantTx } from "../src/db/pool";
import { runCaptureAgent, type CaptureAgentDeps } from "../src/agent/capture-agent";
import type { RawCookie } from "../src/executor/raw-cdp";
import { PgBrowserSessionStore, DevPlaintextSessionEncryptor, sessionKey } from "../src/runtime/browser-session-store";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_capture_agent_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const SITE = "70000000-0000-0000-0000-0000000000c1"; // auth_selector 있음
const SITE_NOAUTH = "70000000-0000-0000-0000-0000000000c9"; // auth_selector 없음
const BID = "9b000000-0000-0000-0000-0000000000c2";
const BID2 = "9b000000-0000-0000-0000-0000000000ca";
const LOGIN_URL = "https://login.x.example/signin";
const AUTH_SELECTOR = ".user-menu";

const SECRET = new TextEncoder().encode("capture-agent-int-secret-do-not-use-in-prod-0123456789");
const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return { kind: "available", snapshot: { sourceRef: "secret://staging/registry" as SecretRef, commands: [] } };
  },
};

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const mint = (claims: Record<string, unknown>): Promise<string> =>
  new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m").sign(SECRET);

type Pool = ReturnType<typeof createPool>;

const CANNED: RawCookie[] = [
  { name: "sess", value: "cookie-v1", domain: ".x.example", path: "/" } as RawCookie,
  { name: "csrf", value: "cookie-v2", domain: ".x.example", path: "/" } as RawCookie,
];

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const store = new PgBrowserSessionStore({ pool, encryptor: new DevPlaintextSessionEncryptor() }, { allowDevPlaintext: true });
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
    await withTenantTx(pool, TENANT, async (c) => {
      const selectors = JSON.stringify({ authenticatedWhen: { selector: AUTH_SELECTOR }, loginUrl: LOGIN_URL, flags: {} });
      await c.query(`INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, page_state_selectors) VALUES ($1,$2,'x site','https://x.example','green',$3::jsonb)`, [SITE, TENANT, selectors]);
      await c.query(`INSERT INTO browser_identities (id, tenant_id, site_profile_id, label, version) VALUES ($1,$2,$3,'id',1)`, [BID, TENANT, SITE]);
      // auth_selector 미설정 사이트(loginUrl 만).
      await c.query(`INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, page_state_selectors) VALUES ($1,$2,'y site','https://y.example','green',$3::jsonb)`, [SITE_NOAUTH, TENANT, JSON.stringify({ loginUrl: "https://login.y.example/in", flags: {} })]);
      await c.query(`INSERT INTO browser_identities (id, tenant_id, site_profile_id, label, version) VALUES ($1,$2,$3,'id-y',1)`, [BID2, TENANT, SITE_NOAUTH]);
    });

    const noopEnqueuer: RunEnqueuer = { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} };
    const app = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer: noopEnqueuer,
      signedCommandRegistry,
      sessionStore: store,
    });
    await app.ready();
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const addr = app.server.address();
      if (addr === null || typeof addr === "string") throw new Error("no addr");
      const apiBase = `http://127.0.0.1:${addr.port}`;
      const token = await mint({ sub: "11111111-0000-0000-0000-000000000001", tenant_id: TENANT, roles: ["operator"] });

      // 1) captured 경로 — fake 가 받은 login_url/auth_selector 기록 + CANNED 반환.
      let seen: { loginUrl: string; authSelector: string } | undefined;
      const okDeps: CaptureAgentDeps = {
        async captureCookies(loginUrl, authSelector) {
          seen = { loginUrl, authSelector };
          return CANNED;
        },
      };
      const r1 = await runCaptureAgent({ apiBase, siteId: SITE, token }, okDeps);
      check("captured 결과 + cookieCount=2", r1.kind === "captured" && r1.cookieCount === 2, JSON.stringify(r1));
      check("에이전트가 서버 login_url/auth_selector 를 캡처 코어로 전달", seen?.loginUrl === LOGIN_URL && seen?.authSelector === AUTH_SELECTOR, JSON.stringify(seen));

      // 2) browser_sessions 봉투 저장 + load 라운드트립.
      const loaded = await withTenantTx(pool, TENANT, () => store.load(sessionKey(TENANT, SITE, BID)));
      check("browser_sessions 저장·load(쿠키 2개 라운드트립)", loaded !== null && loaded.cookies.length === 2 && loaded.cookies.some((c) => c.value === "cookie-v1"), JSON.stringify(loaded?.cookies.length));

      // 3) capture_sessions status=captured.
      const st = await withTenantTx(pool, TENANT, async (c) => (await c.query<{ status: string }>(`SELECT status FROM capture_sessions WHERE site_profile_id=$1::uuid ORDER BY created_at DESC LIMIT 1`, [SITE])).rows[0]?.status);
      check("capture_sessions status=captured", st === "captured", st);

      // 4) 로그인 타임아웃(null) → login_timeout, capture-complete 미호출(세션 미저장·새 행 active 유지).
      const timeoutDeps: CaptureAgentDeps = { async captureCookies() { return null; } };
      const r2 = await runCaptureAgent({ apiBase, siteId: SITE, token }, timeoutDeps);
      check("login_timeout 결과", r2.kind === "login_timeout", JSON.stringify(r2));
      const st2 = await withTenantTx(pool, TENANT, async (c) => (await c.query<{ status: string }>(`SELECT status FROM capture_sessions WHERE site_profile_id=$1::uuid ORDER BY created_at DESC LIMIT 1`, [SITE])).rows[0]?.status);
      check("타임아웃 → 새 capture_session active 유지(captured 아님)", st2 !== "captured", st2);
      const loaded2 = await withTenantTx(pool, TENANT, () => store.load(sessionKey(TENANT, SITE, BID)));
      check("타임아웃 시 browser_sessions 미변경(이전 쿠키 보존)", loaded2 !== null && loaded2.cookies.length === 2);

      // 5) auth_selector 미설정 사이트 → loud throw(자동 감지 불가).
      let threw = false;
      try {
        await runCaptureAgent({ apiBase, siteId: SITE_NOAUTH, token }, okDeps);
      } catch (e) {
        threw = e instanceof Error && e.message.includes("authenticatedWhen");
      }
      check("auth_selector 미설정 → loud throw", threw);

      // 6) 보안: non-loopback http apiBase → loud throw(쿠키 평문 전송 차단; 캡처/전송 이전).
      let httpsGuard = false;
      let captureCalled = false;
      try {
        await runCaptureAgent({ apiBase: "http://remote.example", siteId: SITE, token }, { async captureCookies() { captureCalled = true; return CANNED; } });
      } catch (e) {
        httpsGuard = e instanceof Error && e.message.includes("https");
      }
      check("non-loopback http → loud throw(캡처/전송 이전)", httpsGuard && !captureCalled);
    } finally {
      await app.close();
    }

    if (failures > 0) {
      console.error(`\nFAIL: ${failures} check(s) failed`);
      process.exit(1);
    }
    console.log("\nPASS: 운영자-로컬 캡처 에이전트 통합 green");
    process.exit(0);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error("capture-agent int fatal:", e);
  process.exit(1);
});
