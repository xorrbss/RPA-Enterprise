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

import { CdpDisconnectedError } from "./raw-cdp";

/** 결정형 브라우저 프리미티브 — resolver/executor 가 의존하는 최소 표면. */
export interface CdpSession {
  url(): string;
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  evaluate<R = unknown>(expression: string): Promise<R>;
  /** Stagehand 공개 raw CDP(동일 세션). 예: Accessibility.getFullAXTree, Browser.setDownloadBehavior. */
  sendCDP<T = unknown>(method: string, params?: object): Promise<T>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  selectOption(selector: string, value: string): Promise<void>;
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
  fill(value: string): Promise<void>;
  selectOption(values: string | string[]): Promise<string[]>;
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

  async fill(selector: string, value: string): Promise<void> {
    await this.page.locator(selector).fill(value);
  }

  async selectOption(selector: string, value: string): Promise<void> {
    await this.page.locator(selector).selectOption(value);
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

// CDP 기동 레이스(재시도 대상): 연결거부 + 연결 타임아웃/websocket 미수락(Stagehand ConnectionTimeoutError).
// 둘 다 Chrome CDP 엔드포인트가 아직 연결을 받지 못한 비결정적 기동 상태다(코드/이름/메시지 어느 쪽으로든 매칭).
const LAUNCH_RETRYABLE_RE = /ECONNREFUSED|ECONNRESET|connection refused|connection timeout|timed out waiting for cdp|ConnectionTimeoutError/i;

/** CDP 기동 레이스(재시도 대상)인지. 원 예외 텍스트는 분류에만 쓰고 로그/응답엔 싣지 않는다. */
function isRetryableLaunchError(e: unknown): boolean {
  const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code?: unknown }).code) : "";
  const name = e instanceof Error ? e.name : "";
  const msg = e instanceof Error ? e.message : String(e);
  return LAUNCH_RETRYABLE_RE.test(`${code} ${name} ${msg}`);
}

/** Stagehand LOCAL 세션 1회 기동(빌드+init+newPage). 부분 실패 시 좀비 세션 정리 후 재던진다. */
async function attemptStagehandSession(opts: StagehandSessionOptions): Promise<CdpSession> {
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
  try {
    await sh.init();
    const page = await sh.context.newPage(opts.initialUrl);
    return new StagehandCdpSession(sh, page, opts.downloadDir);
  } catch (e) {
    // 부분 기동(좀비 Chrome) 정리 — 다음 시도 전. close 무응답은 타임아웃으로 무시.
    await Promise.race([sh.close().catch(() => undefined), sleep(2000)]);
    throw e;
  }
}

/** 테스트 주입/튜닝용. attemptInit 기본=실 Stagehand 기동(RQ-001 단위검증을 위한 DI 경계). */
export interface CreateStagehandSessionDeps {
  attemptInit?: (opts: StagehandSessionOptions) => Promise<CdpSession>;
  maxAttempts?: number;
  baseDelayMs?: number;
}

/**
 * Stagehand v3 LOCAL 세션을 띄워 CdpSession 을 만든다(LLM 미사용).
 * CDP 기동 레이스(ECONNREFUSED)는 비결정적이라 bounded retry/backoff 로 흡수한다(RQ-001 — CI 안정).
 * 비-연결거부 예외는 즉시 전파(가정 금지), 연결거부 재시도 소진은 CDP_DISCONNECTED 로 분류(원 텍스트 미노출).
 */
export async function createStagehandSession(
  opts: StagehandSessionOptions,
  deps: CreateStagehandSessionDeps = {},
): Promise<CdpSession> {
  const attemptInit = deps.attemptInit ?? attemptStagehandSession;
  const maxAttempts = Math.max(1, deps.maxAttempts ?? 5);
  const baseDelayMs = deps.baseDelayMs ?? 200;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await attemptInit(opts);
    } catch (e) {
      if (!isRetryableLaunchError(e)) throw e; // 비-기동-레이스 → 즉시 전파(원 예외 보존)
      if (attempt === maxAttempts - 1) break;
      await sleep(baseDelayMs * 2 ** attempt); // 200·400·800·1600 ms
    }
  }
  // 연결거부 재시도 소진 → CDP_DISCONNECTED 분류(error-catalog, retryable). 원 예외 텍스트 미노출.
  throw new CdpDisconnectedError("stagehand.init", "disconnected");
}

/** 단일 세션을 모든 lease 에 바인딩(dry-run/단일 워커). 다중 lease 풀은 LeaseKeyedSessionProvider. */
export class SingleSessionProvider implements CdpSessionProvider {
  constructor(private readonly session: CdpSession) {}

  forLease(_leaseId: string): CdpSession {
    return this.session;
  }
}

/**
 * leaseId → 세션 다중 바인딩. SingleSessionProvider 의 일반화(브라우저 워커 풀의 in-process 레지스트리):
 * 동시 다수 lease 가 각자 자기 세션을 받고, lease 간 세션 공유는 없다(cross-lease 상태 누수 = 정확성·보안 위반).
 * 세션 생성/close 는 소유하지 않는다(저결합) — register 는 호출측이 만든 세션을 등록하고, unbind 는 호출측이
 * close 하도록 세션을 돌려준다. forLease 는 run 당 여러 번(execute/verify/resolvePageState) 호출되므로 동기·idempotent.
 */
export class LeaseKeyedSessionProvider implements CdpSessionProvider {
  private readonly sessions = new Map<string, CdpSession>();

  /** lease 에 세션을 등록. 이미 바인딩된 leaseId 면 throw — 조용한 덮어쓰기는 이전 세션을 고아로 누수시킨다. */
  register(leaseId: string, session: CdpSession): void {
    if (this.sessions.has(leaseId)) {
      throw new Error(`LeaseKeyedSessionProvider: leaseId '${leaseId}' already bound (중복 bind — 세션 누수 방지)`);
    }
    this.sessions.set(leaseId, session);
  }

  /** 바인딩된 세션 반환. 미바인딩(미등록·해제·sweep)이면 typed throw — 조용한 null 금지. CDP_DISCONNECTED(재시도/lease 회수). */
  forLease(leaseId: string): CdpSession {
    const session = this.sessions.get(leaseId);
    if (session === undefined) {
      throw new CdpDisconnectedError(`LeaseKeyedSessionProvider.forLease(${leaseId})`, "disconnected");
    }
    return session;
  }

  /** lease 바인딩 해제 후 세션 반환(호출측이 close 책임 — 레지스트리는 lifecycle 비소유). 미바인딩이면 undefined(idempotent). */
  unbind(leaseId: string): CdpSession | undefined {
    const session = this.sessions.get(leaseId);
    this.sessions.delete(leaseId);
    return session;
  }
}
