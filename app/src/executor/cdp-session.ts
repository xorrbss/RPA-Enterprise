/**
 * CDP 세션 포트 + Stagehand v3 어댑터 (D3 — architecture.md §2/§9).
 *
 * 책임: 결정형(비-LLM) 브라우저 프리미티브를 단일 포트(`CdpSession`)로 노출해 PageStateResolver·
 * UtilityExecutor 가 Stagehand 구현 세부에 결합되지 않게 한다(저결합·단방향 의존). raw CDP 보완은
 * Stagehand 공개 `page.sendCDP()`(동일 세션, §9.5)로 흡수 — 별도 드라이버 없음(D3 PoC 10/10 검증).
 *
 * Stagehand v3 는 CDP-native(peer puppeteer-core 전송). `V3Options.model` optional → LLM 없이
 * LOCAL init 가능(§9.1 "act 없이 결정형 우선"). 본 어댑터는 `act`/`observe`/`extract` 를 호출하지 않는다.
 */
import { readdirSync } from "node:fs";

import { Stagehand } from "@browserbasehq/stagehand";

/** 결정형 브라우저 프리미티브 — resolver/executor 가 의존하는 최소 표면. */
export interface CdpSession {
  url(): string;
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  evaluate<R = unknown>(expression: string): Promise<R>;
  /** Stagehand 공개 raw CDP(동일 세션). 예: Accessibility.getFullAXTree, Browser.setDownloadBehavior. */
  sendCDP<T = unknown>(method: string, params?: object): Promise<T>;
  click(selector: string): Promise<void>;
  setInputFiles(selector: string, files: string | string[]): Promise<void>;
  /** 격리 다운로드 디렉토리(browser_leases.download_dir_ref 대응). */
  downloadDir(): string;
  waitForDownload(fileName: string, timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
}

/** leaseId → 세션 바인딩(브라우저 워커 풀의 lease 경계, architecture §5). */
export interface CdpSessionProvider {
  forLease(leaseId: string): CdpSession;
}

// ── Stagehand 구조적 타입(딥 임포트 회피, 저결합) ──────────────────────────────
interface ShLocator {
  click(opts?: object): Promise<void>;
  setInputFiles(files: string | string[]): Promise<void>;
}
interface ShPage {
  goto(url: string, opts?: object): Promise<unknown>;
  reload(opts?: object): Promise<unknown>;
  url(): string;
  evaluate<R = unknown>(fn: string | ((arg: unknown) => unknown), arg?: unknown): Promise<R>;
  sendCDP<T = unknown>(method: string, params?: object): Promise<T>;
  locator(selector: string): ShLocator;
}
interface ShContext {
  newPage(url?: string): Promise<ShPage>;
  close(): Promise<void>;
}
interface ShInstance {
  init(): Promise<void>;
  readonly context: ShContext;
  close(opts?: object): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stagehand v3 page 를 CdpSession 으로 감싸는 어댑터. */
export class StagehandCdpSession implements CdpSession {
  constructor(
    private readonly sh: ShInstance,
    private readonly page: ShPage,
    private readonly downloads: string,
  ) {}

  url(): string {
    return this.page.url();
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url);
  }

  async reload(): Promise<void> {
    await this.page.reload();
  }

  evaluate<R = unknown>(expression: string): Promise<R> {
    return this.page.evaluate<R>(expression);
  }

  sendCDP<T = unknown>(method: string, params?: object): Promise<T> {
    return this.page.sendCDP<T>(method, params);
  }

  async click(selector: string): Promise<void> {
    await this.page.locator(selector).click();
  }

  async setInputFiles(selector: string, files: string | string[]): Promise<void> {
    await this.page.locator(selector).setInputFiles(files);
  }

  downloadDir(): string {
    return this.downloads;
  }

  async waitForDownload(fileName: string, timeoutMs: number): Promise<boolean> {
    // 경과시간(wall-clock) 기준 폴링. 매 폴에서 확인하고, 남은 시간만큼만 sleep 한 뒤 루프 상단에서
    // 다시 확인한다 → 마지막 sleep 직후 떨어지는 파일도 놓치지 않는다(반복횟수=타임아웃 혼동 제거).
    const start = Date.now();
    for (;;) {
      if (readdirSync(this.downloads).includes(fileName)) return true;
      const remaining = timeoutMs - (Date.now() - start);
      if (remaining <= 0) return false;
      await sleep(Math.min(150, remaining));
    }
  }

  async close(): Promise<void> {
    // ctx 가 이미 닫혔어도(abort 경로) 무응답 hang 가능 → 타임아웃 race(§9.2 PoC 발견).
    await Promise.race([this.sh.close().catch(() => undefined), sleep(3000)]);
  }
}

export interface StagehandSessionOptions {
  chromeExecutablePath: string;
  downloadDir: string;
  headless?: boolean;
  initialUrl?: string;
}

/** Stagehand v3 LOCAL 세션을 띄워 CdpSession 을 만든다(LLM 미사용). */
export async function createStagehandSession(opts: StagehandSessionOptions): Promise<CdpSession> {
  const sh = new Stagehand({
    env: "LOCAL",
    verbose: 0,
    disablePino: true,
    localBrowserLaunchOptions: {
      executablePath: opts.chromeExecutablePath,
      headless: opts.headless ?? true,
      acceptDownloads: true,
      downloadsPath: opts.downloadDir,
    },
  } as unknown as ConstructorParameters<typeof Stagehand>[0]) as unknown as ShInstance;

  await sh.init();
  const page = await sh.context.newPage(opts.initialUrl);
  return new StagehandCdpSession(sh, page, opts.downloadDir);
}

/** 단일 세션을 모든 lease 에 바인딩(dry-run/단일 워커). 다중 lease 풀은 D3 lease(DB) 단계. */
export class SingleSessionProvider implements CdpSessionProvider {
  constructor(private readonly session: CdpSession) {}

  forLease(_leaseId: string): CdpSession {
    return this.session;
  }
}
