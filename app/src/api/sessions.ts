/**
 * 운영자-보조 세션 캡처 명령/상태 라우트 (UI '세션 등록'). server.ts(>500라인) 비대화 방지로 별도 모듈(global #7).
 *
 * POST /v1/sites/{id}/session/capture (rbacAction=session.capture, Idempotency-Key 멱등): site 검증(404/SITE_PROFILE_BLOCKED)
 *   → 동일 (tenant,site) 비종결 캡처 in-flight 가드(이중 launch 방지) → browser_identity 해소 → capture_sessions(launching) INSERT.
 *   dev 는 캡처 폴러가 이 행을 직접 폴링해 headful 브라우저로 구동한다(prod 는 worker enqueue — dev:serve noopEnqueuer 라 미발동).
 * GET /v1/sites/{id}/session/capture: 최근 capture_sessions 상태 목록(폴링 대상). **쿠키/자격증명 절대 미반환**(상태·메타만).
 *
 * 보안: tenant_id 는 JWT(principal)에서만. 캡처 행/쿠키는 RLS 스코프. 자격증명은 우리 저장소 미경유(운영자가 실 사이트에 직접
 * 로그인) — 캡처는 결과 쿠키만 봉투암호화 저장(browser_sessions). 캡처 메커니즘은 dev 캡처 폴러/worker 소관(여기선 행만 생성).
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";

import { withTenantTx } from "../db/pool";
import { sessionKey, type BrowserSessionStore } from "../runtime/browser-session-store";
import type { RawCookie } from "../executor/raw-cdp";
import { isRecord, runIdempotentCommand, type CommandResponse } from "./command";
import { ApiResponseError } from "./errors";
import { type ApiServerDeps, requirePrincipal } from "./server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CaptureBody {
  loginUrl?: string; // 미지정 시 site_profile.page_state_selectors.loginUrl 에서 해소(사이트별 로그인 URL 설정).
}

/** 절대 http(s) URL 검증. */
function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "login_url_must_be_absolute" });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "login_url_must_be_http" });
  }
}

/** 캡처 시작 body 선검사 — login_url 선택(없으면 사이트 설정에서). 멱등 키 소모 이전(malformed→422). */
function parseCaptureBody(raw: unknown): CaptureBody {
  if (!isRecord(raw)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  }
  for (const key of Object.keys(raw)) {
    if (key !== "login_url") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
    }
  }
  const loginUrl = (raw as { login_url?: unknown }).login_url;
  if (loginUrl === undefined) return {};
  if (typeof loginUrl !== "string" || loginUrl.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_login_url" });
  }
  assertHttpUrl(loginUrl);
  return { loginUrl };
}

export function registerSessionRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.post<{ Params: { id: string } }>(
    "/v1/sites/:id/session/capture",
    { config: { rbacAction: "session.capture" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const id = request.params.id;
      if (!UUID_RE.test(id)) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND"); // 형식 무효 id → 404(존재 비노출)
      }
      requirePrincipal(request);
      const body = parseCaptureBody(request.body); // 키 소모 이전 선검사
      const result = await runIdempotentCommand(
        deps,
        request,
        "captureSession",
        `/v1/sites/${id}/session/capture`,
        (client, tenantId) => applyCaptureStart(client, tenantId, id, body),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/sites/:id/session/capture",
    { config: { rbacAction: "session.capture" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const id = request.params.id;
      if (!UUID_RE.test(id)) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const principal = requirePrincipal(request);
      const items = await withTenantTx(deps.pool, String(principal.tenantId), async (c) => {
        const site = await c.query<{ id: string }>(
          `SELECT id::text AS id FROM site_profiles WHERE tenant_id=$1::uuid AND id=$2::uuid`,
          [String(principal.tenantId), id],
        );
        if (site.rows[0] === undefined) {
          throw new ApiResponseError("RESOURCE_NOT_FOUND");
        }
        const r = await c.query<{ capture_session_id: string; status: string; detail: string | null; updated_at: Date }>(
          `SELECT id::text AS capture_session_id, status, detail, updated_at
             FROM capture_sessions
            WHERE tenant_id=$1::uuid AND site_profile_id=$2::uuid
            ORDER BY created_at DESC LIMIT 10`,
          [String(principal.tenantId), id],
        );
        return r.rows;
      });
      // 쿠키/자격증명 미포함(capture_sessions 는 상태·메타만 보유).
      reply.code(200).send({ items, next_cursor: null });
    },
  );

  // POST /v1/sites/{id}/session/capture/complete (P3, rbacAction=session.capture, 멱등): 운영자-로컬 캡처 에이전트가
  //   headful MFA 로 캡처한 origin-scoped 쿠키를 받아, **중앙 API 가 신뢰경계에서** 봉투암호화(주입된 encryptor)하고
  //   browser_sessions 에 저장(세션 재사용 키 = capture_sessions 행의 site/browser_identity, 바디 불신)한 뒤 status CAS=captured.
  //   sessionStore 주입 시에만 등록(미주입=미등록, fail-closed). 쿠키 평문은 단명 — 로그/직렬화/이벤트 금지(암호화기로만).
  if (deps.sessionStore !== undefined) {
    const store = deps.sessionStore;
    app.post<{ Params: { id: string } }>(
      "/v1/sites/:id/session/capture/complete",
      { config: { rbacAction: "session.capture" } },
      async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
        const id = request.params.id;
        if (!UUID_RE.test(id)) {
          throw new ApiResponseError("RESOURCE_NOT_FOUND");
        }
        requirePrincipal(request);
        const body = parseCaptureCompleteBody(request.body); // 키 소모 이전 선검사(malformed→422)
        const result = await runIdempotentCommand(
          deps,
          request,
          "captureSessionComplete",
          `/v1/sites/${id}/session/capture/complete`,
          (client, tenantId) => applyCaptureComplete(client, tenantId, id, body, store),
        );
        reply.code(result.status).send(result.body);
      },
    );
  }
}

interface CaptureCompleteBody {
  readonly captureSessionId: string;
  readonly cookies: RawCookie[];
}

const MAX_CAPTURE_COOKIES = 300; // 봉투 크기 상한(악의적 대량 쿠키 방지).

/** capture/complete body 선검사 — capture_session_id(uuid) + cookies(비빈 배열, name/value 문자열). 멱등 키 소모 이전(malformed→422). */
function parseCaptureCompleteBody(raw: unknown): CaptureCompleteBody {
  if (!isRecord(raw)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  }
  const csid = (raw as { capture_session_id?: unknown }).capture_session_id;
  if (typeof csid !== "string" || !UUID_RE.test(csid)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_capture_session_id" });
  }
  const cookies = (raw as { cookies?: unknown }).cookies;
  if (!Array.isArray(cookies) || cookies.length === 0 || cookies.length > MAX_CAPTURE_COOKIES) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_cookies" });
  }
  for (const c of cookies) {
    if (!isRecord(c) || typeof (c as { name?: unknown }).name !== "string" || typeof (c as { value?: unknown }).value !== "string") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "cookie_name_value_required" });
    }
  }
  return { captureSessionId: csid, cookies: cookies as RawCookie[] };
}

/**
 * 캡처 완료 — capture_session(RLS) 검증 → browser_identity 도출(바디 불신) → 쿠키 봉투암호화 저장 → status CAS=captured.
 * 멱등: 이미 captured 면 200 재반환. expired/failed 등 비-active 면 거부(조용한 덮어쓰기 금지). 쿠키 평문은 store(암호화기)로만.
 */
async function applyCaptureComplete(
  client: import("pg").PoolClient,
  tenantId: string,
  siteId: string,
  body: CaptureCompleteBody,
  store: BrowserSessionStore,
): Promise<CommandResponse> {
  const cap = await client.query<{ id: string; browser_identity_id: string; status: string }>(
    `SELECT id::text AS id, browser_identity_id::text AS browser_identity_id, status
       FROM capture_sessions WHERE id=$1::uuid AND tenant_id=$2::uuid AND site_profile_id=$3::uuid`,
    [body.captureSessionId, tenantId, siteId],
  );
  const row = cap.rows[0];
  if (row === undefined) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND"); // 미존재/타사이트/타테넌트 → 존재 비노출
  }
  if (row.status === "captured") {
    return { status: 200, body: { capture_session_id: row.id, site_profile_id: siteId, status: "captured" } }; // 멱등 — 이미 완료
  }
  if (row.status !== "launching" && row.status !== "awaiting_login" && row.status !== "capturing") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "capture_not_active", status: row.status }); // expired/failed → 거부
  }
  // 봉투암호화 저장(store 자체 tx, 주입 encryptor). 키=capture_session 행의 browser_identity(바디 불신). 쿠키 평문은 여기서만.
  await store.save(sessionKey(tenantId, siteId, row.browser_identity_id), { cookies: body.cookies });
  await client.query(
    `UPDATE capture_sessions SET status='captured', updated_at=now()
      WHERE id=$1::uuid AND tenant_id=$2::uuid AND status IN ('launching','awaiting_login','capturing')`,
    [body.captureSessionId, tenantId],
  );
  return { status: 200, body: { capture_session_id: row.id, site_profile_id: siteId, status: "captured" } };
}

async function applyCaptureStart(
  client: import("pg").PoolClient,
  tenantId: string,
  siteId: string,
  body: CaptureBody,
): Promise<CommandResponse> {
  // 1) 사이트 존재 + red-risk 승인 게이트(RLS 스코프). 미존재/타테넌트 → 404(존재 비노출).
  const site = await client.query<{ risk: string; approved: boolean; page_state_selectors: unknown }>(
    `SELECT risk, approved, page_state_selectors FROM site_profiles WHERE id=$1::uuid AND tenant_id=$2::uuid`,
    [siteId, tenantId],
  );
  const row = site.rows[0];
  if (row === undefined) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND");
  }
  if (row.risk === "red" && row.approved !== true) {
    throw new ApiResponseError("SITE_PROFILE_BLOCKED");
  }

  // login_url 해소 — body 우선, 없으면 사이트 설정(page_state_selectors.loginUrl). 둘 다 없으면 412(사이트 로그인 URL 미설정).
  const cfg = isRecord(row.page_state_selectors)
    ? (row.page_state_selectors as { loginUrl?: unknown; authenticatedWhen?: unknown })
    : {};
  const loginUrl = body.loginUrl ?? (typeof cfg.loginUrl === "string" ? cfg.loginUrl : undefined);
  if (loginUrl === undefined) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "no_login_url_configured" });
  }
  assertHttpUrl(loginUrl);
  // auth_selector — 운영자-로컬 캡처 에이전트가 로그인 완료를 감지할 셀렉터(site 설정 authenticatedWhen.selector). 비밀 아님.
  //   미설정이면 응답에서 생략(JSON 직렬화가 undefined 필드 제거) → 에이전트가 명시적 실패(자동 감지 불가). dev 폴러는 별도 late-fail.
  const authSelector =
    isRecord(cfg.authenticatedWhen) && typeof (cfg.authenticatedWhen as { selector?: unknown }).selector === "string"
      ? (cfg.authenticatedWhen as { selector: string }).selector
      : undefined;

  // 2) in-flight 가드 — 같은 (tenant,site) 비종결 캡처가 있으면 새로 launch 하지 않고 그 행 재반환(이중 headful 브라우저 방지).
  const inflight = await client.query<{ id: string; status: string; login_url: string }>(
    `SELECT id::text AS id, status, login_url FROM capture_sessions
      WHERE tenant_id=$1::uuid AND site_profile_id=$2::uuid AND status IN ('launching','awaiting_login','capturing')
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId, siteId],
  );
  if (inflight.rows[0] !== undefined) {
    const f = inflight.rows[0];
    return { status: 200, body: { capture_session_id: f.id, site_profile_id: siteId, status: f.status, login_url: f.login_url, auth_selector: authSelector } };
  }

  // 3) browser_identity 해소 — 캡처/재사용 키 정합(browser_sessions 와 동일 browser_identity_id). 사이트에 미설정이면 412.
  const ident = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM browser_identities WHERE tenant_id=$1::uuid AND site_profile_id=$2::uuid ORDER BY version DESC LIMIT 1`,
    [tenantId, siteId],
  );
  const browserIdentityId = ident.rows[0]?.id;
  if (browserIdentityId === undefined) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "no_browser_identity_for_site" });
  }

  // 4) capture_sessions(launching) INSERT — dev 캡처 폴러가 이 행을 폴링해 headful 구동(prod 는 worker enqueue).
  const captureId = randomUUID();
  await client.query(
    `INSERT INTO capture_sessions (id, tenant_id, site_profile_id, browser_identity_id, login_url, status)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'launching')`,
    [captureId, tenantId, siteId, browserIdentityId, loginUrl],
  );
  return { status: 201, body: { capture_session_id: captureId, site_profile_id: siteId, status: "launching", login_url: loginUrl, auth_selector: authSelector } };
}
