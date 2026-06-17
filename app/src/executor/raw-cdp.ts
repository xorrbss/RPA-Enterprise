/**
 * Raw CDP 보완 레이어 (D3 — architecture.md §9.2/§9.5).
 *
 * Stagehand v3 고수준 page API 가 커버하지 못하는 결정형 utility 프리미티브를 raw CDP 도메인 호출로
 * 보완한다(동일 세션, `page.sendCDP` 경유 — PoC 10/10 검증). 산재된 인라인 sendCDP 를 본 모듈 1곳으로
 * 모아 **폴백 경로를 기록**하고(§9.5 "갭→raw CDP 보완 경로 기록·가정 금지"), CDP 레벨 실패를
 * `CDP_DISCONNECTED`(error-catalog, retryable/system)로 분류한다(조용한 전파 금지).
 *
 * 폴백 레지스트리(§9.2 — 고수준 page API 부재분만 raw CDP):
 *  | 항목 | 고수준 미지원 사유 | raw CDP 도메인 |
 *  |---|---|---|
 *  | #2/#3 landmarks·structuralHash | Stagehand page 에 a11y 트리 접근자 없음 | `Accessibility.getFullAXTree` |
 *  | #5 download dir 격리 | page API 에 다운로드 경로 격리 옵션 없음(browser_leases.download_dir_ref) | `Browser.setDownloadBehavior` |
 *  | 세션 재사용 캡처/복원 | page API 에 쿠키 스냅샷/주입 접근자 없음(browser_sessions 재사용) | `Storage.getCookies` / `Storage.setCookies`(대칭) |
 *  나머지(#1 navigate·#4 selector·#6 upload·#7 click/type·#8 auth·#9 flags)는 고수준 page 메서드/evaluate 로 충족 — raw CDP 불요.
 */
import type { CdpSession } from "./cdp-session";

/** a11y 노드(필요 필드만 — role/name 의 value). */
export type AxNode = { role?: { value?: unknown }; name?: { value?: unknown } };

/**
 * CDP Cookie 객체. `Storage.getCookies` 출력이 `Storage.setCookies` 입력으로 무변형 라운드트립한다(index 시그니처로
 * size/session/priority/sourceScheme 등 부가 필드 보존). **value 는 인증 자료** — 호출측은 단명 지역변수로만 다루고
 * 로그/직렬화/LLM/audit 에 절대 싣지 않는다(browser-session-store 가 봉투암호화로만 영속).
 */
export interface RawCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  [k: string]: unknown;
}

const RAW_CDP_TIMEOUT_MS = 5000;

export type RawCdpFailureKind = "disconnected" | "timeout" | "protocol_error";

/**
 * Raw CDP 실패. 현재 error-catalog 의 CDP 계열 공개 코드는 `CDP_DISCONNECTED`뿐이므로
 * `failureKind` 로 세부 원인을 보존하되, 사용자/로그 메시지에는 원 예외 문자열을 싣지 않는다.
 */
export class RawCdpError extends Error {
  readonly code = "CDP_DISCONNECTED" as const;

  constructor(
    readonly method: string,
    readonly failureKind: RawCdpFailureKind,
  ) {
    super(`raw CDP '${method}' failed (${failureKind})`);
    this.name = "RawCdpError";
  }
}

/** CDP 세션 단절/타임아웃 계열 실패. error-catalog `CDP_DISCONNECTED` 매핑. */
export class CdpDisconnectedError extends RawCdpError {
  constructor(method: string, failureKind: Extract<RawCdpFailureKind, "disconnected" | "timeout">) {
    super(method, failureKind);
    this.name = "CdpDisconnectedError";
  }
}

/** raw CDP 응답이 계약 shape 와 맞지 않는 경우. PageState 를 조용히 만들지 않는다. */
export class RawCdpMalformedResponseError extends Error {
  readonly code = "PAGE_STATE_UNRESOLVED" as const;

  constructor(readonly method: string, message: string) {
    super(`raw CDP '${method}' returned malformed response: ${message}`);
    this.name = "RawCdpMalformedResponseError";
  }
}

type RawCdpOptions = { timeoutMs?: number };

function classifyFailure(cause: unknown): RawCdpFailureKind {
  const text = cause instanceof Error ? `${cause.name} ${cause.message}` : String(cause);
  return /closed|disconnect|detached|target closed|session closed|browser has disconnected/i.test(text)
    ? "disconnected"
    : "protocol_error";
}

/** sendCDP 를 CDP_DISCONNECTED 매핑으로 감싼다(원 예외를 조용히 흡수하지 않고 분류·전파). */
async function rawCdp<T>(
  session: CdpSession,
  method: string,
  params?: object,
  opts: RawCdpOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? RAW_CDP_TIMEOUT_MS;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new CdpDisconnectedError(method, "timeout")), timeoutMs);
  });

  try {
    return await Promise.race([session.sendCDP<T>(method, params), timeoutPromise]);
  } catch (cause) {
    if (cause instanceof RawCdpError) throw cause;
    const failureKind = classifyFailure(cause);
    if (failureKind === "disconnected") throw new CdpDisconnectedError(method, failureKind);
    throw new RawCdpError(method, failureKind);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * #2/#3: 전체 a11y 트리. Stagehand page 에 접근자가 없어 raw CDP 로 보완한다.
 * nodes 미반환/비배열 응답은 malformed 로 실패시킨다. 빈 배열 자체만 "landmark 0개"로 유효하다.
 */
export async function getAccessibilityTree(session: CdpSession, opts: RawCdpOptions = {}): Promise<AxNode[]> {
  const res = await rawCdp<{ nodes?: unknown }>(session, "Accessibility.getFullAXTree", undefined, opts);
  if (!Array.isArray(res.nodes)) {
    throw new RawCdpMalformedResponseError("Accessibility.getFullAXTree", "nodes must be an array");
  }
  return res.nodes as AxNode[];
}

/**
 * #5: 다운로드를 격리 디렉토리로 라우팅. page API 에 경로 격리 옵션이 없어 raw CDP 로 보완한다
 * (browser_leases.download_dir_ref 격리, eventsEnabled 로 진행 이벤트 활성).
 */
export async function setDownloadBehavior(
  session: CdpSession,
  downloadPath: string,
  opts: RawCdpOptions = {},
): Promise<void> {
  await rawCdp(session, "Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath,
    eventsEnabled: true,
  }, opts);
}

/**
 * 세션 재사용 — 현재 컨텍스트의 전체 쿠키 스냅샷(post-login 캡처). Stagehand v3 가 쿠키를 Storage.* 로 다루므로 대칭(get/set)으로
 * 맞춘다(Network.setCookies 는 page 세션에서 Network.enable 선행을 요구할 수 있어 회피). 비배열 응답은 malformed 로 실패
 * (빈 스냅샷 묵인 금지). 반환 쿠키 value 는 인증 자료 — 단명 지역변수로만, 로그/직렬화 금지.
 */
export async function getAllCookies(session: CdpSession, opts: RawCdpOptions = {}): Promise<RawCookie[]> {
  const res = await rawCdp<{ cookies?: unknown }>(session, "Storage.getCookies", undefined, opts);
  if (!Array.isArray(res.cookies)) {
    throw new RawCdpMalformedResponseError("Storage.getCookies", "cookies must be an array");
  }
  return res.cookies as RawCookie[];
}

/**
 * 세션 재사용 — 쿠키 배치 주입(pre-navigate 복원). 쿠키는 origin-load 비의존이라 goto 이전 호출 가능.
 * Storage.getCookies 출력을 무변형으로 수용(reshaping 없음). 빈 배열이면 no-op(cold start).
 */
export async function setCookies(session: CdpSession, cookies: readonly RawCookie[], opts: RawCdpOptions = {}): Promise<void> {
  await rawCdp(session, "Storage.setCookies", { cookies }, opts);
}

/**
 * 세션 재사용 — 현재 컨텍스트의 전체 쿠키 제거(복원 직전). 세션 상태를 저장소가 권위적으로 결정하게 하고, run/lease 간
 * 잔여 쿠키(특히 dev 단일세션 재사용·prod 풀 재할당) 누수를 막는다. 빈 컨텍스트에 호출해도 안전(no-op).
 */
export async function clearCookies(session: CdpSession, opts: RawCdpOptions = {}): Promise<void> {
  await rawCdp(session, "Storage.clearCookies", undefined, opts);
}
