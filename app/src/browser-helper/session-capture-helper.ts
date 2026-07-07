/**
 * 운영자 브라우저 세션 캡처 helper (P3 Option B) — 운영자가 명시적으로 실행하는 **최소권한** CLI.
 *
 * DB/암호화키 접근이 전혀 없다. 신뢰는 중앙 API 에 둔다(helper는 캡처+전송만). 흐름:
 *   1) POST /v1/sites/{id}/session/capture  (Bearer + Idempotency-Key) → { capture_session_id, login_url, auth_selector }.
 *   2) headful Chrome 로 login_url 오픈 → **운영자가 직접 로그인**(MFA 포함; 자격증명은 본 helper 미경유) → auth_selector 감지.
 *   3) origin-scoped 쿠키 캡처(단명) → POST .../session/capture/complete (Bearer + Idempotency-Key) → 중앙 API 가 봉투암호화 저장.
 *
 * 보안: 자격증명은 운영자가 실 사이트에 직접 입력(helper 미경유). 캡처 쿠키는 **단명 지역변수** — 로그/직렬화/파일 금지,
 *   HTTPS 본문으로만 전송(중앙 API 가 신뢰경계에서 봉투암호화). 토큰은 env(RPA_OPERATOR_TOKEN)로만 받는다(argv/히스토리 노출 회피).
 *
 * 실행: RPA_OPERATOR_TOKEN=<operator JWT> tsx src/browser-helper/session-capture-helper.ts --api https://rpa.example --site <uuid>
 *   (운영자 배포는 단일 실행파일 — scripts/build-session-capture-exe.mjs 가 본 CLI 를 Node SEA 로 패키징,
 *    브라우저 계층은 capture-chrome-session(puppeteer-core 직결)이라 Stagehand/LLM SDK 가 번들에 없음)
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { launchCaptureChromeSession, type CaptureChromeSession } from "./capture-chrome-session";
import { awaitLoginCookies, findChrome, DEFAULT_LOGIN_DEADLINE_MS } from "../executor/login-capture";
import type { RawCookie } from "../executor/raw-cdp";

export class SessionCaptureHelperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionCaptureHelperError";
  }
}

export interface SessionCaptureHelperOptions {
  /** 제어평면 API 베이스 URL(예: https://rpa.example) — 끝 슬래시 유무 무관. */
  readonly apiBase: string;
  /** 대상 사이트 UUID. */
  readonly siteId: string;
  /** operator(이상) JWT. */
  readonly token: string;
  /** 운영자 로그인 대기 데드라인(ms). 미지정 시 코어 기본(30m). */
  readonly loginTimeoutMs?: number;
}

/** 캡처 코어/네트워크 주입(테스트는 captureCookies 를 fake 로 대체해 헤드풀 Chrome 없이 HTTP 오케스트레이션 검증). */
export interface SessionCaptureHelperDeps {
  /** login_url 헤드풀 오픈 → 운영자 로그인 → 쿠키 반환(null=데드라인 초과). */
  captureCookies(loginUrl: string, authSelector: string, deadlineMs: number): Promise<RawCookie[] | null>;
  fetchImpl?: typeof fetch;
  newKey?: () => string;
}

export type SessionCaptureHelperResult =
  | { readonly kind: "captured"; readonly captureSessionId: string; readonly cookieCount: number }
  | { readonly kind: "login_timeout"; readonly captureSessionId: string };

interface CaptureStartResponse {
  capture_session_id: string;
  login_url: string;
  auth_selector?: string;
  status: string;
}

function trimBase(apiBase: string): string {
  return apiBase.replace(/\/+$/, "");
}

/**
 * 보안 — 쿠키(PlainSecret급)는 전송 중 평문 누출을 막아야 하므로 apiBase 는 **https 강제**. 단 localhost/루프백은
 * dev/테스트용 http 허용(네트워크 미경유). 그 외 http/비표준 스킴은 loud throw(조용한 평문 전송 금지).
 */
function assertSecureBase(apiBase: string): void {
  let u: URL;
  try {
    u = new URL(apiBase);
  } catch {
    throw new SessionCaptureHelperError(`잘못된 --api URL: ${apiBase}`);
  }
  const isLoopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1" || u.hostname === "[::1]";
  if (u.protocol === "https:") return;
  if (u.protocol === "http:" && isLoopback) return;
  throw new SessionCaptureHelperError(
    `보안: --api 는 https 여야 합니다(쿠키 평문 전송 방지; loopback 만 http 허용). 받은 값: ${u.protocol}//${u.hostname}`,
  );
}

async function readText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<no body>";
  }
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  key: string,
  body: unknown,
): Promise<Response> {
  return fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
}

/**
 * 세션 캡처 helper 실행 — capture-start → 헤드풀 캡처 → capture-complete. 쿠키는 단명(반환값/로그에 미포함). 비-2xx 는 loud throw.
 */
export async function runSessionCaptureHelper(opts: SessionCaptureHelperOptions, deps: SessionCaptureHelperDeps): Promise<SessionCaptureHelperResult> {
  assertSecureBase(opts.apiBase); // 쿠키 평문 전송 방지(https 강제, loopback 예외) — 첫 fetch 이전.
  const fetchImpl = deps.fetchImpl ?? fetch;
  const newKey = deps.newKey ?? ((): string => randomUUID());
  const base = trimBase(opts.apiBase);

  // 1) capture-start — capture_session 확보(또는 in-flight 재사용) + login_url/auth_selector 수령(비밀 아님).
  const startRes = await postJson(fetchImpl, `${base}/v1/sites/${opts.siteId}/session/capture`, opts.token, newKey(), {});
  if (!startRes.ok) {
    throw new SessionCaptureHelperError(`capture-start 실패: HTTP ${startRes.status} ${await readText(startRes)}`);
  }
  const start = (await startRes.json()) as CaptureStartResponse;
  if (typeof start.capture_session_id !== "string" || typeof start.login_url !== "string") {
    throw new SessionCaptureHelperError("capture-start 응답에 capture_session_id/login_url 누락");
  }
  if (typeof start.auth_selector !== "string" || start.auth_selector.length === 0) {
    throw new SessionCaptureHelperError(
      "사이트에 authenticatedWhen 셀렉터가 없어 로그인 완료를 자동 감지할 수 없습니다 — 사이트 설정에 authenticatedWhen 추가 후 재시도하세요.",
    );
  }

  // 2) 헤드풀 캡처 — 운영자가 직접 로그인. 쿠키는 단명 지역변수.
  const cookies = await deps.captureCookies(
    start.login_url,
    start.auth_selector,
    opts.loginTimeoutMs ?? DEFAULT_LOGIN_DEADLINE_MS,
  );
  if (cookies === null) {
    return { kind: "login_timeout", captureSessionId: start.capture_session_id };
  }

  // 3) capture-complete — 중앙 API 가 봉투암호화 저장 + status CAS=captured. 쿠키는 본문으로만 전송 후 폐기.
  const compRes = await postJson(fetchImpl, `${base}/v1/sites/${opts.siteId}/session/capture/complete`, opts.token, newKey(), {
    capture_session_id: start.capture_session_id,
    cookies,
  });
  if (!compRes.ok) {
    throw new SessionCaptureHelperError(`capture-complete 실패: HTTP ${compRes.status} ${await readText(compRes)}`);
  }
  return { kind: "captured", captureSessionId: start.capture_session_id, cookieCount: cookies.length };
}

/** 헤드풀 Chrome 기본 캡처 구현 — findChrome → launchCaptureChromeSession(헤드풀) → awaitLoginCookies → close. */
export function defaultSessionCaptureDeps(chromePath?: string): SessionCaptureHelperDeps {
  return {
    async captureCookies(loginUrl: string, authSelector: string, deadlineMs: number): Promise<RawCookie[] | null> {
      const chrome = chromePath ?? findChrome();
      if (chrome === null) {
        throw new SessionCaptureHelperError("Chrome 미발견 — --chrome <path> 지정 또는 CHROME_PATH 설정 후 재시도");
      }
      let session: CaptureChromeSession | undefined;
      try {
        session = await launchCaptureChromeSession({ chromeExecutablePath: chrome, initialUrl: loginUrl });
        const loginOrigin = new URL(loginUrl).origin;
        return await awaitLoginCookies(session, authSelector, loginOrigin, deadlineMs);
      } finally {
        if (session !== undefined) await session.close().catch(() => undefined);
      }
    },
  };
}

interface CliArgs {
  api?: string;
  site?: string;
  chrome?: string;
  loginTimeoutMs?: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new SessionCaptureHelperError(`${a} 에 값이 필요합니다`);
      i += 1;
      return v;
    };
    if (a === "--api") out.api = next();
    else if (a === "--site") out.site = next();
    else if (a === "--chrome") out.chrome = next();
    else if (a === "--login-timeout-ms") out.loginTimeoutMs = Number(next());
  }
  return out;
}

const USAGE =
  "사용법: RPA_OPERATOR_TOKEN=<operator JWT> rpa-session-capture.exe --api <base-url> --site <uuid> [--chrome <path>] [--login-timeout-ms <n>]\n" +
  "  (개발 환경: RPA_OPERATOR_TOKEN=<operator JWT> tsx src/browser-helper/session-capture-helper.ts <동일 인자>)";

async function cli(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.RPA_OPERATOR_TOKEN?.trim();
  if (args.api === undefined || args.site === undefined || token === undefined || token.length === 0) {
    console.error(USAGE);
    process.exit(2);
    return;
  }
  console.log(`세션 캡처 시작 — site=${args.site.slice(0, 8)} api=${trimBase(args.api)}. 로그인 창이 열리면 직접 로그인하세요(자격증명은 본 도구를 거치지 않습니다).`);
  const result = await runSessionCaptureHelper(
    {
      apiBase: args.api,
      siteId: args.site,
      token,
      ...(args.loginTimeoutMs !== undefined ? { loginTimeoutMs: args.loginTimeoutMs } : {}),
    },
    defaultSessionCaptureDeps(args.chrome),
  );
  // ⚠ Chrome 기동 이후 경로는 process.exit() 금지 — puppeteer 자식프로세스/undici keep-alive 핸들 teardown 과
  // 경쟁하면 Windows libuv assertion(!(handle->flags & UV_HANDLE_CLOSING), exit 0xC0000409)로 성공 직후
  // 크래시한다(단일 실행파일 실증에서 실측). exitCode 를 지정하고 이벤트루프가 자연 drain 하게 둔다.
  if (result.kind === "captured") {
    console.log(`✓ 세션 캡처 완료 — capture_session=${result.captureSessionId.slice(0, 8)}, 쿠키 ${result.cookieCount}개 봉투암호화 저장됨.`);
    process.exitCode = 0;
    return;
  }
  console.error(`로그인 대기 시간 초과 — 캡처 미완료(capture_session=${result.captureSessionId.slice(0, 8)}). 다시 실행해 재시도하세요.`);
  process.exitCode = 1;
}

/** CLI 기동 + 최상위 예외 처리. run-as-main 가드(tsx 직접 실행)와 SEA 번들 엔트리(session-capture-helper-main)가 공용. */
export function runCliMain(): void {
  cli().catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`세션 캡처 helper 오류: ${msg}`);
    process.exitCode = 1; // Chrome 기동 후 예외 가능 — process.exit() 경쟁 회피(위 주석)
  });
}

// run-as-main 가드 — 테스트가 runSessionCaptureHelper 를 import 해도 cli()가 실행되지 않도록.
// (CJS 번들에서는 import.meta.url 이 비어 이 가드가 항상 false — 번들 기동은 session-capture-helper-main 담당.)
const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  runCliMain();
}
