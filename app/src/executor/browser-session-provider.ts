/**
 * BrowserSessionProvider — worker 주입 포트 (A.1 step2). claim 시점에 DB browser_lease 에
 * 라이브 CdpSession 을 1회 바인딩(bind)하고, executor/resolver 가 매 step 호출하는 동기 forLease 는
 * LeaseKeyedSessionProvider 로 그대로 돌려준다(bind/forLease 분리 — async 기동은 worker 경계에서만,
 * 인터프리터 호출 경로 무변경). lease drain 시 release 로 라이브 세션을 teardown 한다.
 *
 * Phase 1 범위: lease 마다 fresh + clear_all(= "browser" 격리, lease 당 새 Chrome 프로세스). 미지원
 * 격리/정리(context/page·preserve_*)는 조용히 다운그레이드하지 않고 throw(warm-reuse 는 후속 증분).
 * 실 Chrome pool 크기/자격/식별자 프로비저닝은 deploy-time(주입형 포트라 test_fake 로 무-Chrome 검증).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LeaseCleanupPolicy, LeaseIsolation } from "../../../ts/runtime-contract";
import {
  LeaseKeyedSessionProvider,
  createStagehandSession,
  type CdpSession,
  type CdpSessionProvider,
  type CreateStagehandSessionDeps,
  type StagehandSessionOptions,
} from "./cdp-session";

/** claim 시 lease 에 라이브 세션을 바인딩하기 위한 입력(3-tuple identity + 격리/정리 정책 + 진입 URL). */
export interface BrowserSessionBindInput {
  readonly tenantId: string;
  readonly leaseId: string;
  readonly siteProfileId: string;
  readonly browserIdentityId: string;
  readonly networkPolicyId: string;
  /** 격리 수준(Phase 1: 'browser' 만 — lease 당 새 프로세스). resolver 가 공급(가정 금지). */
  readonly isolation: LeaseIsolation;
  /** 정리 정책(Phase 1: 'clear_all' 만 — release 시 통째 폐기). */
  readonly cleanupPolicy: LeaseCleanupPolicy;
  readonly initialUrl?: string;
}

/** bind 결과: executor/resolver 에 넘길 provider(forLease) + lease drain 시 호출할 release(세션 teardown). */
export interface BoundBrowserSession {
  readonly provider: CdpSessionProvider;
  /** 라이브 세션 teardown(clear_all: close + 격리 다운로드 디렉토리 제거). idempotent. */
  release(): Promise<void>;
}

/**
 * worker 주입 포트. binding.kind 로 test_fake 를 프로덕션에서 차단(runtime-worker 의
 * allowTestBrowserSessionProvider 게이트 — D6 sinkDeliveryPort 패턴과 동일).
 */
export interface BrowserSessionProvider {
  readonly binding: { readonly kind: "real" | "test_fake" };
  bind(input: BrowserSessionBindInput): Promise<BoundBrowserSession>;
}

/**
 * worker 주입 게이트(fail-closed). test_fake provider 는 명시 opt-in(allowTestBrowserSessionProvider) 없이는 거부
 * — 실 run 구동 위조 방지(D6 sinkDeliveryPort·artifact 포트와 동형). 미주입(undefined) → undefined(구동 안 함,
 * claimed 까지만 = 기존 worker 동작). real → opt-in 무관 통과.
 */
export function gateBrowserSessionProvider(
  provider: BrowserSessionProvider | undefined,
  allowTestProvider: boolean,
): BrowserSessionProvider | undefined {
  if (provider === undefined) return undefined;
  if (provider.binding.kind === "test_fake" && allowTestProvider !== true) {
    throw new Error(
      "RuntimeWorker: test_fake browser session provider requires explicit allowTestBrowserSessionProvider opt-in",
    );
  }
  return provider;
}

// Phase 1 지원 범위 가드: fresh-per-lease(=browser 격리) + clear_all 만. 그 외는 미지원 feature → loud throw.
function assertPhase1Supported(input: BrowserSessionBindInput): void {
  if (input.isolation !== "browser" || input.cleanupPolicy !== "clear_all") {
    throw new Error(
      `BrowserSessionProvider: Phase 1 은 isolation='browser'·cleanupPolicy='clear_all' 만 지원 ` +
        `(받음 isolation='${input.isolation}', cleanupPolicy='${input.cleanupPolicy}'). ` +
        `context/page·preserve_* 는 후속(warm-reuse) 증분 — 조용한 다운그레이드 금지.`,
    );
  }
}

// pool 에서 leaseId 를 해제하고 다운로드 디렉토리를 제거하는 공통 release(양 provider 공유, idempotent).
// rmSync force 는 이미 삭제된 디렉토리에 무해 → 중복 release 안전. 세션 close 는 미바운드면 skip.
function boundSession(
  pool: LeaseKeyedSessionProvider,
  leaseId: string,
  downloadDir: string,
): BoundBrowserSession {
  return {
    provider: pool,
    release: async () => {
      const session = pool.unbind(leaseId);
      if (session !== undefined) await session.close();
      rmSync(downloadDir, { recursive: true, force: true });
    },
  };
}

export interface StagehandBrowserSessionProviderOptions {
  /** 실 Chrome 실행 경로(deploy-time 제공). */
  readonly chromeExecutablePath: string;
  /** headless 정책(기본 true — createStagehandSession 기본값과 동일). */
  readonly headless?: boolean;
  /** per-lease 다운로드 디렉토리 루트(없으면 OS tmp). */
  readonly downloadRootDir?: string;
  /** 테스트 주입: 세션 팩토리(기본 createStagehandSession — RQ-001 DI 경계 재사용). */
  readonly createSession?: (
    opts: StagehandSessionOptions,
    deps?: CreateStagehandSessionDeps,
  ) => Promise<CdpSession>;
}

/**
 * 실 Stagehand 백엔드 BrowserSessionProvider (Phase 1: lease 마다 fresh Chrome + clear_all).
 * lease 당 createStagehandSession(새 프로세스) + 격리 다운로드 디렉토리. release 는 close + 디렉토리 제거.
 */
export class StagehandBrowserSessionProvider implements BrowserSessionProvider {
  readonly binding = { kind: "real" } as const;
  private readonly pool = new LeaseKeyedSessionProvider();
  private readonly createSession: NonNullable<StagehandBrowserSessionProviderOptions["createSession"]>;

  constructor(private readonly options: StagehandBrowserSessionProviderOptions) {
    this.createSession = options.createSession ?? createStagehandSession;
  }

  async bind(input: BrowserSessionBindInput): Promise<BoundBrowserSession> {
    assertPhase1Supported(input);
    const downloadDir = mkdtempSync(join(this.options.downloadRootDir ?? tmpdir(), `lease-${input.leaseId}-`));
    let session: CdpSession;
    try {
      session = await this.createSession({
        chromeExecutablePath: this.options.chromeExecutablePath,
        downloadDir,
        headless: this.options.headless,
        initialUrl: input.initialUrl,
      });
    } catch (e) {
      rmSync(downloadDir, { recursive: true, force: true }); // 기동 실패 시 디렉토리 누수 방지
      throw e; // CDP_DISCONNECTED 등 표면화 — 조용한 null 세션 금지
    }
    this.pool.register(input.leaseId, session);
    return boundSession(this.pool, input.leaseId, downloadDir);
  }
}

/** 결정형 in-memory CdpSession 스텁(실 Chrome 불요) — worker 통합 테스트용 test_fake 세션. */
export class FakeCdpSession implements CdpSession {
  private current = "about:blank";
  /** 테스트 단언용 close 호출 횟수. */
  closeCalls = 0;

  constructor(private readonly downloads: string) {}

  url(): string {
    return this.current;
  }
  async goto(url: string): Promise<void> {
    this.current = url;
  }
  async reload(): Promise<void> {}
  async evaluate<R = unknown>(): Promise<R> {
    return undefined as R;
  }
  async sendCDP<T = unknown>(): Promise<T> {
    return {} as T;
  }
  async click(): Promise<void> {}
  async fill(): Promise<void> {}
  async selectOption(): Promise<void> {}
  async setInputFiles(): Promise<void> {}
  downloadDir(): string {
    return this.downloads;
  }
  async waitForDownload(): Promise<boolean> {
    return false;
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

export interface TestFakeBrowserSessionProviderOptions {
  readonly downloadRootDir?: string;
  /** 통합 테스트가 시나리오를 구동할 수 있게 커스텀 세션 주입(기본 FakeCdpSession). */
  readonly makeSession?: (downloadDir: string, input: BrowserSessionBindInput) => CdpSession;
}

/** test_fake BrowserSessionProvider — 실 Chrome 없이 bind/forLease/release 를 검증(프로덕션 차단 대상). */
export class TestFakeBrowserSessionProvider implements BrowserSessionProvider {
  readonly binding = { kind: "test_fake" } as const;
  private readonly pool = new LeaseKeyedSessionProvider();

  constructor(private readonly options: TestFakeBrowserSessionProviderOptions = {}) {}

  async bind(input: BrowserSessionBindInput): Promise<BoundBrowserSession> {
    assertPhase1Supported(input);
    const downloadDir = mkdtempSync(join(this.options.downloadRootDir ?? tmpdir(), `fake-lease-${input.leaseId}-`));
    const session = this.options.makeSession
      ? this.options.makeSession(downloadDir, input)
      : new FakeCdpSession(downloadDir);
    this.pool.register(input.leaseId, session);
    return boundSession(this.pool, input.leaseId, downloadDir);
  }
}
