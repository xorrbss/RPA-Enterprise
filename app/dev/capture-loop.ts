/**
 * Dev 캡처 폴러 (운영자-보조 세션 캡처 — option b: dev:serve 가 noopEnqueuer/그래파일 워커 부재라 worker enqueue 경로가
 * 미발동하므로, 콘솔 버튼이 만든 capture_sessions(launching) 행을 dev 가 직접 폴링해 구동한다).
 *
 * tick: capture_sessions WHERE status='launching' 1행 →  **별도 headful Chrome**(run-loop 의 공유 headless 세션과 무관)으로
 *   login_url 을 띄움(awaiting_login) → 운영자가 직접 로그인 → authenticatedWhen 감지(deadline 까지 폴링) → origin-scoped
 *   쿠키 캡처 → browser_sessions 저장(captured) → close. deadline 초과 → expired. 모든 종료는 typed CAS(조용한 no-op 금지).
 *
 * 보안: tenant/site/browser_identity 는 capture_sessions 행(RLS 조회)에서 도출(payload 미신뢰). 자격증명은 우리 미경유
 *   (운영자가 실 사이트에 직접 입력) — 결과 쿠키만 봉투암호화 저장. 쿠키는 단명 지역변수(로그/직렬화 금지).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Pool } from "pg";

import type { RunContext } from "../../ts/core-types";
import { withTenantTx } from "../src/db/pool";
import { createStagehandSession, type CdpSession } from "../src/executor/cdp-session";
import { awaitLoginCookies, findChrome, DEFAULT_LOGIN_DEADLINE_MS } from "../src/executor/login-capture";
import { loadSitePageStateConfig } from "../src/executor/site-page-state-config";
import { PgBrowserSessionStore, DevPlaintextSessionEncryptor, sessionKey, type BrowserSessionStore } from "../src/runtime/browser-session-store";

// 운영자 로그인 대기 데드라인 — ops-defaults human_task.default_timeout(30m). dev 검증용 단축은 env override.
const LOGIN_DEADLINE_MS = Number(process.env.CAPTURE_LOGIN_TIMEOUT_MS ?? DEFAULT_LOGIN_DEADLINE_MS);

export interface CaptureLoop {
  stop(): Promise<void>;
}

interface LaunchingRow {
  id: string;
  site_profile_id: string;
  browser_identity_id: string;
  login_url: string;
  url_pattern: string;
}

function captureCtx(tenantId: string, siteProfileId: string, browserIdentityId: string): RunContext {
  return {
    runId: "capture",
    tenantId,
    nodeId: "capture",
    attempt: 0,
    siteProfileId,
    browserIdentityId,
    networkPolicyId: "dev-np",
    leaseId: "capture-lease",
    assetRefs: {},
    abortSignal: new AbortController().signal,
    pageState: {
      url: { raw: "about:blank", canonical: "about:blank", pattern: "about:blank" },
      dom: { structuralHash: "seed", visibleTextHash: "seed", landmarks: [], frames: [] },
      auth: "anonymous",
      flags: {},
      matchedWhere: [],
    },
  };
}

/**
 * 운영자 로그인 대기 → 인증 감지 시 origin-scoped 쿠키 캡처·**저장**. 반환='captured'|'expired'(typed). 캡처/재사용
 * 동일 sessionKey. 대기·캡처 코어는 awaitLoginCookies(src/executor/login-capture, agent 와 공유); 본 함수는 그 결과를
 * store.save 로 영속하는 dev 폴러 어댑터다(expired 시 미저장 — 조용한 캡처 금지). 별도 export — 단위검증이 동일 코어를 호출.
 */
export async function awaitLoginAndCapture(
  session: CdpSession,
  authSelector: string,
  store: BrowserSessionStore,
  ctx: RunContext,
  loginOrigin: string,
  deadlineMs = LOGIN_DEADLINE_MS,
): Promise<"captured" | "expired"> {
  const cookies = await awaitLoginCookies(session, authSelector, loginOrigin, deadlineMs);
  if (cookies === null) return "expired";
  await store.save(sessionKey(ctx.tenantId, ctx.siteProfileId, ctx.browserIdentityId), { cookies });
  return "captured";
}

/** capture_sessions 상태 CAS 전이(조용한 no-op 금지 — detail 은 메타만, 쿠키/자격증명 금지). */
async function setStatus(pool: Pool, tenantId: string, id: string, status: string, detail?: string): Promise<void> {
  await withTenantTx(pool, tenantId, (c) =>
    c.query(`UPDATE capture_sessions SET status=$1, detail=$2, updated_at=now() WHERE id=$3::uuid AND tenant_id=$4::uuid`, [
      status,
      detail ?? null,
      id,
      tenantId,
    ]),
  );
}

/**
 * 캡처 폴러 시작. Chrome 미발견 시 null(비활성). tenantId 스코프(dev 단일 테넌트).
 * 한 번에 하나의 캡처만 처리(headful 세션은 launch 당 별개; busy 로 직렬화).
 */
export async function startCaptureLoop(pool: Pool, tenantId: string, intervalMs = 2000): Promise<CaptureLoop | null> {
  const chrome = findChrome();
  if (chrome === null) {
    console.log("capture-loop: Chrome 미발견 → 세션 캡처 비활성(CHROME_PATH 설정 시 활성).");
    return null;
  }
  const store = new PgBrowserSessionStore({ pool, encryptor: new DevPlaintextSessionEncryptor() }, { allowDevPlaintext: true });
  console.log("capture-loop: 활성 — 콘솔 '세션 등록'(capture_sessions launching)을 폴링해 headful 로그인창을 띄운다.");

  let stopped = false;
  let busy = false;

  const tick = async (): Promise<void> => {
    if (stopped || busy) return;
    busy = true;
    let downloadDir: string | undefined;
    let session: CdpSession | undefined;
    let row: LaunchingRow | undefined;
    try {
      row = await withTenantTx(pool, tenantId, async (c) => {
        const r = await c.query<LaunchingRow>(
          `SELECT cs.id::text AS id, cs.site_profile_id::text AS site_profile_id, cs.browser_identity_id::text AS browser_identity_id,
                  cs.login_url, sp.url_pattern
             FROM capture_sessions cs JOIN site_profiles sp ON sp.id = cs.site_profile_id
            WHERE cs.status='launching' ORDER BY cs.created_at LIMIT 1`,
        );
        return r.rows[0];
      });
      if (row === undefined) return;

      const config = await withTenantTx(pool, tenantId, (c) => loadSitePageStateConfig(c, tenantId, row!.site_profile_id));
      const authSelector = config.authenticatedWhen?.selector;
      if (authSelector === undefined) {
        await setStatus(pool, tenantId, row.id, "failed", "site has no authenticatedWhen selector (capture cannot detect login)");
        console.error(`capture-loop: ${row.id.slice(0, 8)} site 에 authenticatedWhen 미설정 — 캡처 불가.`);
        return;
      }
      downloadDir = mkdtempSync(join(tmpdir(), "dev-capture-"));
      // **headful** 세션(별도) — initialUrl 로 로그인창을 바로 띄운다. 포트 기본 ephemeral 프로필(userDataDir 미사용 — 개인 프로필 미재사용).
      session = await createStagehandSession({ chromeExecutablePath: chrome, downloadDir, headless: false, initialUrl: row.login_url });
      const ctx = captureCtx(tenantId, row.site_profile_id, row.browser_identity_id);
      const loginOrigin = new URL(row.login_url).origin;

      await setStatus(pool, tenantId, row.id, "awaiting_login");
      console.log(`capture-loop: ${row.id.slice(0, 8)} headful 로그인창 오픈(${loginOrigin}) — 운영자 로그인 대기(authenticatedWhen=${authSelector}).`);

      const outcome = await awaitLoginAndCapture(session, authSelector, store, ctx, loginOrigin);
      await setStatus(pool, tenantId, row.id, outcome, outcome === "expired" ? "login deadline exceeded" : undefined);
      console.log(`capture-loop: ${row.id.slice(0, 8)} → ${outcome} (site ${row.site_profile_id.slice(0, 8)}).`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`capture-loop tick error: ${msg}`);
      if (row !== undefined) await setStatus(pool, tenantId, row.id, "failed", "capture error").catch(() => undefined);
    } finally {
      if (session !== undefined) await session.close().catch(() => undefined);
      if (downloadDir !== undefined) rmSync(downloadDir, { recursive: true, force: true });
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
