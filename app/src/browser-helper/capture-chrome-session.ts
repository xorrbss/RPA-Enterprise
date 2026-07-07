/**
 * 캡처 helper 전용 경량 Chrome 세션 — puppeteer-core 직접 기동(Stagehand 미경유).
 *
 * 왜 별도인가: 캡처 경로는 evaluate(로그인 감지)·sendCDP(Storage.getCookies 1회)·close 만 쓴다. 실행기
 * 포트(executor/cdp-session)의 Stagehand 어댑터를 쓰면 단일 실행파일 패키징 시 LLM SDK·pino 워커·native
 * 모듈이 번들 그래프에 정적으로 끌려 들어와(런타임 미사용인데) 패키징이 불가능해진다. Stagehand v3 의
 * 전송 계층이 peer puppeteer-core 이므로 동일 엔진을 직접 기동한다(동작 등가, 의존 최소). 실행기 경로는
 * 계속 cdp-session(Stagehand)을 쓴다 — 본 모듈은 browser-helper 전용 leaf.
 *
 * 보안: 신선한 임시 프로필(userDataDir)로 기동해 운영자 개인 브라우저 프로필/쿠키와 격리하고 close 시
 * 폐기한다. 쿠키는 호출측(awaitLoginCookies)이 단명 지역변수로만 다룬다.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import puppeteer, { type Browser, type CDPSession, type Page } from "puppeteer-core";

import type { LoginCaptureSession } from "../executor/login-capture";

// cdp-session 의 NAV_TIMEOUT_MS 와 동일 규칙 — 무거운 SPA 로그인 페이지는 load 대기가 타임아웃되므로
// domcontentloaded 까지만 대기하고 env(NAV_TIMEOUT_MS, 기본 45s)로 상향 가능. 0/비정상값은 기본값으로 흡수.
const NAV_TIMEOUT_MS = Math.max(1000, Number(process.env.NAV_TIMEOUT_MS) || 45_000);

/** 캡처 helper 가 쓰는 세션 표면 — 캡처 코어 표면 + close. */
export interface CaptureChromeSession extends LoginCaptureSession {
  close(): Promise<void>;
}

export interface CaptureChromeOptions {
  chromeExecutablePath: string;
  /** 로그인 URL — 기동 직후 이동(운영자가 로그인할 페이지). */
  initialUrl: string;
}

/** 헤드풀 Chrome 기동 + 로그인 URL 오픈. 부분 기동 실패 시 브라우저/임시 프로필 정리 후 재던진다. */
export async function launchCaptureChromeSession(opts: CaptureChromeOptions): Promise<CaptureChromeSession> {
  const userDataDir = mkdtempSync(join(tmpdir(), "op-capture-profile-"));
  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch({
      executablePath: opts.chromeExecutablePath,
      headless: false,
      defaultViewport: null, // 운영자가 실제 창 크기로 로그인(고정 뷰포트 clamp 제거)
      userDataDir,
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    const page: Page = (await browser.pages())[0] ?? (await browser.newPage());
    await page.goto(opts.initialUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    return new PuppeteerCaptureSession(browser, page, userDataDir);
  } catch (e) {
    if (browser !== undefined) await browser.close().catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
    throw e;
  }
}

class PuppeteerCaptureSession implements CaptureChromeSession {
  constructor(
    private readonly browser: Browser,
    private readonly page: Page,
    private readonly userDataDir: string,
  ) {}

  async evaluate<R = unknown>(expression: string): Promise<R> {
    return (await this.page.evaluate(expression)) as R;
  }

  /**
   * page 타깃에 1회용 CDP 세션을 붙여 전송 — 실 로그인은 cross-origin 리다이렉트가 흔해 미리 붙인 세션이
   * detach 될 수 있으므로 호출 시점에 attach 한다. 캡처 경로의 sendCDP 는 로그인 감지 후 Storage.getCookies
   * 1회뿐이라 per-call attach 비용은 무시 가능.
   */
  async sendCDP<T = unknown>(method: string, params?: object): Promise<T> {
    const cdp: CDPSession = await this.page.createCDPSession();
    try {
      // puppeteer 의 send 는 프로토콜 매핑으로 메서드명이 잠겨 있어 문자열 메서드는 좁힘 캐스트가 필요하다
      // (응답 shape 검증은 호출측 raw-cdp 가 수행 — malformed 는 loud throw).
      return (await cdp.send(method as Parameters<CDPSession["send"]>[0], params as never)) as T;
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    await this.browser.close().catch(() => undefined);
    // Windows 는 브라우저 종료 직후 프로필 파일 잠금이 짧게 남을 수 있어 재시도로 흡수.
    rmSync(this.userDataDir, { recursive: true, force: true, maxRetries: 3 });
  }
}
