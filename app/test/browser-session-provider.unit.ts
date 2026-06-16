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

  // 2) 미지원 격리/정리(context/page·preserve_*) → loud throw(조용한 다운그레이드 금지, mkdtemp 전 가드).
  {
    const provider = new StagehandBrowserSessionProvider({ chromeExecutablePath: "/x/chrome", createSession: fakeCreateSession });
    const e1 = await caught(provider.bind({ ...INPUT, isolation: "context" }));
    const e2 = await caught(provider.bind({ ...INPUT, cleanupPolicy: "preserve_session" }));
    check("unsupported isolation='context' → throws", e1 instanceof Error, String(e1));
    check("unsupported cleanupPolicy='preserve_session' → throws", e2 instanceof Error, String(e2));
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
