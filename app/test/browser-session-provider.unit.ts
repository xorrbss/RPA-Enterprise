/**
 * browser-session-provider 단위 테스트 (A.1 step2, 외부 의존 없음 — 실 Chrome 불요).
 *
 * 실 provider 는 createSession DI(FakeCdpSession 주입)로 bind/forLease/release 메커니즘을 검증한다:
 * bind → forLease 바운드 세션, 미지원 격리/정리 throw(조용한 다운그레이드 금지), release close 1회 + 미바운드
 * forLease typed throw, idempotent, 동시 다수 lease 가 공유 pool 에서 각자 세션. test_fake provider 동치 검증.
 * 실행: tsx test/browser-session-provider.unit.ts.
 */
import {
  FakeCdpSession,
  StagehandBrowserSessionProvider,
  TestFakeBrowserSessionProvider,
  gateBrowserSessionProvider,
  type BrowserSessionBindInput,
} from "../src/executor/browser-session-provider";
import type { CdpSession } from "../src/executor/cdp-session";
import { CdpDisconnectedError } from "../src/executor/raw-cdp";
import type { LeaseId, RunAbortDrainInput, WorkerId } from "../../ts/runtime-contract";
import type { CorrelationId, RunId, TenantId } from "../../ts/security-middleware-contract";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

function caughtSync(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e;
  }
}

const INPUT: BrowserSessionBindInput = {
  tenantId: "t1",
  leaseId: "lease-1",
  siteProfileId: "sp1",
  browserIdentityId: "bid1",
  networkPolicyId: "np1",
  isolation: "browser",
  cleanupPolicy: "clear_all",
};

// createStagehandSession 자리에 주입할 fake 팩토리(실 Chrome 미기동) — 매 호출 새 FakeCdpSession.
function fakeCreateSession(opts: { downloadDir: string }): Promise<CdpSession> {
  return Promise.resolve(new FakeCdpSession(opts.downloadDir));
}

function abortInput(leaseId = INPUT.leaseId, timeoutMs = 50): RunAbortDrainInput {
  return {
    tenantId: INPUT.tenantId as TenantId,
    runId: "run-1" as RunId,
    leaseId: leaseId as LeaseId,
    workerId: "worker-1" as WorkerId,
    correlationId: "corr-1" as CorrelationId,
    timeoutMs,
  };
}

class HangingCloseSession extends FakeCdpSession {
  async close(): Promise<void> {
    this.closeCalls += 1;
    return new Promise(() => undefined);
  }
}

class FailingOnceSession extends FakeCdpSession {
  closeAttempts = 0;

  async close(): Promise<void> {
    this.closeAttempts += 1;
    if (this.closeAttempts === 1) {
      throw new Error("close still in progress");
    }
    await super.close();
  }
}

async function main(): Promise<void> {
  // 1) 실 provider: bind → forLease 바운드 세션, binding.kind='real'.
  {
    const provider = new StagehandBrowserSessionProvider({ chromeExecutablePath: "/x/chrome", createSession: fakeCreateSession });
    check("binding.kind === 'real'", provider.binding.kind === "real");
    const bound = await provider.bind(INPUT);
    const session = bound.provider.forLease("lease-1");
    check("bind → forLease(leaseId) returns a live session (FakeCdpSession)", session instanceof FakeCdpSession);
    await bound.release();
  }

  // 2) Phase 1 격리/정리 범위: browser/context 수용(fresh-per-lease 가 만족, context=lease 기본값),
  //    page(형제 공유)·preserve_*(상태 유지)는 loud throw(조용한 다운그레이드 금지, mkdtemp 전 가드).
  {
    const provider = new StagehandBrowserSessionProvider({ chromeExecutablePath: "/x/chrome", createSession: fakeCreateSession });
    const ctxBound = await provider.bind({ ...INPUT, isolation: "context" });
    check("isolation='context' accepted (acquireBrowserLease 기본값)", ctxBound.provider.forLease(INPUT.leaseId) instanceof FakeCdpSession);
    await ctxBound.release();
    const ePage = await caught(provider.bind({ ...INPUT, leaseId: "L-page", isolation: "page" }));
    const ePreserve = await caught(provider.bind({ ...INPUT, leaseId: "L-pres", cleanupPolicy: "preserve_session" }));
    check("unsupported isolation='page' → throws", ePage instanceof Error, String(ePage));
    check("unsupported cleanupPolicy='preserve_session' → throws", ePreserve instanceof Error, String(ePreserve));
  }

  // 3) release: 세션 close 1회 + 이후 forLease typed throw(CDP_DISCONNECTED) + idempotent.
  {
    const provider = new StagehandBrowserSessionProvider({ chromeExecutablePath: "/x/chrome", createSession: fakeCreateSession });
    const bound = await provider.bind(INPUT);
    const session = bound.provider.forLease("lease-1") as FakeCdpSession;
    await bound.release();
    check("release closes the live session once", session.closeCalls === 1, `closeCalls=${session.closeCalls}`);
    const afterRelease = caughtSync(() => bound.provider.forLease("lease-1"));
    check(
      "forLease after release → CdpDisconnectedError (no silent null)",
      afterRelease instanceof CdpDisconnectedError && (afterRelease as CdpDisconnectedError).code === "CDP_DISCONNECTED",
      String(afterRelease),
    );
    await bound.release(); // idempotent — 중복 release 무해(double close 없음)
    check("release idempotent (no double close)", session.closeCalls === 1, `closeCalls=${session.closeCalls}`);
  }

  // 4) createSession 기동 실패 → bind reject(표면화), 세션 미등록.
  {
    const provider = new StagehandBrowserSessionProvider({
      chromeExecutablePath: "/x/chrome",
      createSession: () => Promise.reject(new CdpDisconnectedError("stagehand.init", "disconnected")),
    });
    const err = await caught(provider.bind(INPUT));
    check(
      "bind surfaces session-launch failure (CDP_DISCONNECTED), no silent null session",
      err instanceof CdpDisconnectedError && (err as CdpDisconnectedError).code === "CDP_DISCONNECTED",
      String(err),
    );
  }

  // 5) 동시 다수 lease: 공유 pool, 각자 자기 세션(cross-lease 공유 없음).
  {
    const provider = new StagehandBrowserSessionProvider({ chromeExecutablePath: "/x/chrome", createSession: fakeCreateSession });
    const bound = await provider.bind(INPUT);
    const session = bound.provider.forLease(INPUT.leaseId) as FakeCdpSession;
    const drained = await provider.drainAbort(abortInput());
    check("run_abort drain closes bound lease", drained.kind === "drained" && session.closeCalls === 1, JSON.stringify(drained));
    const afterDrain = caughtSync(() => bound.provider.forLease(INPUT.leaseId));
    check("run_abort drain unbinds lease", afterDrain instanceof CdpDisconnectedError, String(afterDrain));
    await bound.release();
    check("release after abort drain is idempotent", session.closeCalls === 1, `closeCalls=${session.closeCalls}`);
  }

  {
    const provider = new StagehandBrowserSessionProvider({ chromeExecutablePath: "/x/chrome", createSession: fakeCreateSession });
    const missing = await provider.drainAbort(abortInput("missing-lease"));
    check(
      "run_abort drain missing local lease -> transient_failed",
      missing.kind === "transient_failed" && missing.reason.includes("not bound"),
      JSON.stringify(missing),
    );
  }

  {
    let session: HangingCloseSession | undefined;
    const provider = new StagehandBrowserSessionProvider({
      chromeExecutablePath: "/x/chrome",
      createSession: (opts) => {
        session = new HangingCloseSession(opts.downloadDir);
        return Promise.resolve(session);
      },
    });
    const bound = await provider.bind({ ...INPUT, leaseId: "timeout-lease" });
    const timedOut = await provider.drainAbort(abortInput("timeout-lease", 1));
    check("run_abort drain close timeout -> timeout", timedOut.kind === "timeout", JSON.stringify(timedOut));
    check("run_abort drain timeout attempted close once", session?.closeCalls === 1, `closeCalls=${session?.closeCalls}`);
    const afterTimeout = caughtSync(() => bound.provider.forLease("timeout-lease"));
    check("run_abort drain timeout unbinds lease", afterTimeout instanceof CdpDisconnectedError, String(afterTimeout));
    await bound.release();
  }

  {
    let session: FailingOnceSession | undefined;
    const provider = new StagehandBrowserSessionProvider({
      chromeExecutablePath: "/x/chrome",
      createSession: (opts) => {
        session = new FailingOnceSession(opts.downloadDir);
        return Promise.resolve(session);
      },
    });
    const bound = await provider.bind({ ...INPUT, leaseId: "retry-lease" });
    const first = await provider.drainAbort(abortInput("retry-lease"));
    check("run_abort drain close failure -> transient_failed", first.kind === "transient_failed", JSON.stringify(first));
    check("run_abort drain close failure keeps lease bound", bound.provider.forLease("retry-lease") === session);
    const second = await provider.drainAbort(abortInput("retry-lease"));
    check("run_abort drain retry can close same lease", second.kind === "drained" && session?.closeCalls === 1, JSON.stringify(second));
    await bound.release();
  }

  {
    const provider = new StagehandBrowserSessionProvider({ chromeExecutablePath: "/x/chrome", createSession: fakeCreateSession });
    const b1 = await provider.bind({ ...INPUT, leaseId: "L1" });
    const b2 = await provider.bind({ ...INPUT, leaseId: "L2" });
    const s1 = b1.provider.forLease("L1");
    const s2 = b2.provider.forLease("L2");
    check("two leases → shared pool, distinct sessions per leaseId", b1.provider === b2.provider && s1 !== s2);
    await b1.release();
    await b2.release();
  }

  // 6) test_fake provider: 동치(bind/forLease/release) + binding.kind='test_fake'.
  {
    const provider = new TestFakeBrowserSessionProvider();
    check("test_fake binding.kind === 'test_fake'", provider.binding.kind === "test_fake");
    const bound = await provider.bind(INPUT);
    const session = bound.provider.forLease("lease-1");
    check("test_fake bind → FakeCdpSession", session instanceof FakeCdpSession);
    await bound.release();
    check("test_fake release closes session", (session as FakeCdpSession).closeCalls === 1);
  }

  // 7) gateBrowserSessionProvider — fail-closed test_fake opt-in 게이트(worker 주입 정책).
  {
    const real = new StagehandBrowserSessionProvider({ chromeExecutablePath: "/x/chrome", createSession: fakeCreateSession });
    const fake = new TestFakeBrowserSessionProvider();
    check("gate: undefined provider → undefined (no drive, claimed-only 기존 동작)", gateBrowserSessionProvider(undefined, false) === undefined);
    check("gate: real provider → opt-in 무관 통과", gateBrowserSessionProvider(real, false) === real && gateBrowserSessionProvider(real, true) === real);
    const denied = caughtSync(() => gateBrowserSessionProvider(fake, false));
    check("gate: test_fake without opt-in → throws (fail-closed)", denied instanceof Error, String(denied));
    check("gate: test_fake with opt-in → passes", gateBrowserSessionProvider(fake, true) === fake);
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: browser-session-provider unit green");
  process.exit(0);
}

main().catch((e) => {
  console.error("unit fatal:", e);
  process.exit(1);
});
