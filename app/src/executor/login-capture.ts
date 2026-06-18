/**
 * 헤드풀 로그인 대기 → origin-scoped 쿠키 캡처 코어. **dev 캡처 폴러(dev/capture-loop)와 운영자-로컬 캡처
 * 에이전트(src/agent/capture-agent)가 공유**한다. store/DB 의존이 없어 레이어 중립 — 쿠키 배열만 반환하고
 * (null=로그인 데드라인 초과) 저장(dev=store.save)·전송(agent=POST)은 호출자 책임이다.
 *
 * 보안: 반환 쿠키는 인증 자료(PlainSecret급) — 단명 지역변수로만 다루고 로그/직렬화/파일에 절대 흘리지 않는다.
 */
import { existsSync } from "node:fs";

import type { CdpSession } from "./cdp-session";
import { getCookiesForOrigins, type RawCookie } from "./raw-cdp";

/** 인증 상태 폴 간격. */
export const CAPTURE_POLL_AUTH_MS = 1500;
/** 운영자 로그인 대기 기본 데드라인 — ops-defaults human_task.default_timeout(30m). */
export const DEFAULT_LOGIN_DEADLINE_MS = 30 * 60 * 1000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 운영자 로그인 대기 → 인증 감지 시 origin-scoped 쿠키 반환. 데드라인 초과 시 null(조용한 캡처 금지 — 호출자가
 * 분기). 감지는 **가벼운 querySelector evaluate**(authSelector). 실 사이트 로그인은 cross-origin 리다이렉트가
 * 흔해 그 순간 CDP 타깃이 일시 단절되므로 **poll 에러는 catch 후 재시도**한다(창이 닫히면 deadline 까지 폴 후 null).
 */
export async function awaitLoginCookies(
  session: CdpSession,
  authSelector: string,
  loginOrigin: string,
  deadlineMs = DEFAULT_LOGIN_DEADLINE_MS,
  pollMs = CAPTURE_POLL_AUTH_MS,
): Promise<RawCookie[] | null> {
  const start = Date.now();
  const probe = `!!document.querySelector(${JSON.stringify(authSelector)})`;
  for (;;) {
    let authed = false;
    try {
      authed = await session.evaluate<boolean>(probe);
    } catch {
      // 네비게이션/일시 CDP 단절 — 다음 폴에서 재시도(리다이렉트 settle 후 성공). 창이 닫혔으면 deadline 까지 폴 후 null.
    }
    if (authed) {
      // origin-scoped 캡처(over-capture 차단) → 단명 배열로 반환.
      return await getCookiesForOrigins(session, [loginOrigin]);
    }
    if (Date.now() - start >= deadlineMs) return null;
    await sleep(pollMs);
  }
}

/** 로컬 Chrome 실행파일 탐색(CHROME_PATH 우선, 없으면 표준 설치 경로). 미발견 시 null. */
export function findChrome(): string | null {
  const env = process.env.CHROME_PATH?.trim();
  if (env !== undefined && env.length > 0 && existsSync(env)) return env;
  return (
    [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
    ].find((c) => existsSync(c)) ?? null
  );
}
