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
 *  나머지(#1 navigate·#4 selector·#6 upload·#7 click/type·#8 auth·#9 flags)는 고수준 page 메서드/evaluate 로 충족 — raw CDP 불요.
 */
import type { CdpSession } from "./cdp-session";

/** a11y 노드(필요 필드만 — role/name 의 value). */
export type AxNode = { role?: { value?: unknown }; name?: { value?: unknown } };

/** CDP 레벨 실패. error-catalog `CDP_DISCONNECTED`(retryable/system) 매핑 — lease sweeper 회수(§9.5). */
export class CdpDisconnectedError extends Error {
  readonly code = "CDP_DISCONNECTED" as const;

  constructor(method: string, cause: unknown) {
    super(`raw CDP '${method}' failed (session disconnected): ${String(cause)}`);
    this.name = "CdpDisconnectedError";
  }
}

/** sendCDP 를 CDP_DISCONNECTED 매핑으로 감싼다(원 예외를 조용히 흡수하지 않고 분류·전파). */
async function rawCdp<T>(session: CdpSession, method: string, params?: object): Promise<T> {
  try {
    return await session.sendCDP<T>(method, params);
  } catch (cause) {
    throw new CdpDisconnectedError(method, cause);
  }
}

/**
 * #2/#3: 전체 a11y 트리. Stagehand page 에 접근자가 없어 raw CDP 로 보완한다.
 * nodes 미반환(빈 응답)도 빈 배열로 정규화 — landmark 0개 PageState 는 유효(조용한 크래시 금지).
 */
export async function getAccessibilityTree(session: CdpSession): Promise<AxNode[]> {
  const res = await rawCdp<{ nodes?: AxNode[] }>(session, "Accessibility.getFullAXTree");
  return res.nodes ?? [];
}

/**
 * #5: 다운로드를 격리 디렉토리로 라우팅. page API 에 경로 격리 옵션이 없어 raw CDP 로 보완한다
 * (browser_leases.download_dir_ref 격리, eventsEnabled 로 진행 이벤트 활성).
 */
export async function setDownloadBehavior(session: CdpSession, downloadPath: string): Promise<void> {
  await rawCdp(session, "Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath,
    eventsEnabled: true,
  });
}
