/**
 * cdp-session 모듈 단위 테스트 (외부 의존 없음) — 실행: tsx test/cdp-session.unit.ts.
 *
 * (1) RQ-001 createStagehandSession CDP 기동 retry/backoff: attemptInit DI로 기동 결과를 주입해 검증 —
 *     연결거부(ECONNREFUSED) 재시도 후 성공, 소진 시 CDP_DISCONNECTED 분류(원 텍스트 미노출), 비-연결거부 즉시 전파.
 * (2) LeaseKeyedSessionProvider: leaseId 키 세션 레지스트리 — forLease 바운드 반환·미바운드 typed throw(조용한 null 금지)·
 *     idempotent, register 중복 throw, unbind 해제.
 */
import { createStagehandSession, LeaseKeyedSessionProvider, type CdpSession } from "../src/executor/cdp-session";
import { CdpDisconnectedError } from "../src/executor/raw-cdp";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const OPTS = { chromeExecutablePath: "/x/chrome", downloadDir: "/tmp/dl" };
const FAKE_SESSION = { __fake: true } as unknown as CdpSession;
function connRefused(): Error {
  return Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9222"), { code: "ECONNREFUSED" });
}
// Stagehand 기동 타임아웃 변종(websocket 미수락) — ECONNREFUSED와 별개지만 동일 기동 레이스.
function connTimeout(): Error {
  const e = new Error("Connection timeout: Timed out waiting for CDP websocket to accept connections at ws://127.0.0.1:45893/devtools/browser/x");
  e.name = "ConnectionTimeoutError";
  return e;
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

async function main(): Promise<void> {
  // 1) 연결거부 2회 후 성공 → 재시도해 세션 반환(attemptInit 3회 호출).
  {
    let n = 0;
    const attemptInit = async (): Promise<CdpSession> => {
      n += 1;
      if (n < 3) throw connRefused();
      return FAKE_SESSION;
    };
    const s = await createStagehandSession(OPTS, { attemptInit, baseDelayMs: 1, maxAttempts: 5 });
    check("conn-refused twice then success → retried to success", s === FAKE_SESSION && n === 3, `n=${n}`);
  }

  // 2) 연결거부 계속 → 재시도 소진 → CdpDisconnectedError(CDP_DISCONNECTED), 원 텍스트 미노출.
  {
    let n = 0;
    const attemptInit = async (): Promise<CdpSession> => {
      n += 1;
      throw connRefused();
    };
    const err = await caught(createStagehandSession(OPTS, { attemptInit, baseDelayMs: 1, maxAttempts: 3 }));
    check(
      "conn-refused exhausted → CdpDisconnectedError(CDP_DISCONNECTED), 3 attempts",
      err instanceof CdpDisconnectedError && (err as CdpDisconnectedError).code === "CDP_DISCONNECTED" && n === 3,
      `n=${n} err=${String(err)}`,
    );
    check(
      "classified launch failure does not leak original ECONNREFUSED text",
      err instanceof Error && !/ECONNREFUSED/.test(err.message),
      err instanceof Error ? err.message : String(err),
    );
  }

  // 2b) 연결 타임아웃 변종(ConnectionTimeoutError / "Timed out waiting for CDP websocket") → 동일 기동 레이스로 재시도.
  {
    let n = 0;
    const attemptInit = async (): Promise<CdpSession> => {
      n += 1;
      if (n < 2) throw connTimeout();
      return FAKE_SESSION;
    };
    const s = await createStagehandSession(OPTS, { attemptInit, baseDelayMs: 1, maxAttempts: 5 });
    check("conn-timeout variant → retried to success", s === FAKE_SESSION && n === 2, `n=${n}`);
  }

  // 3) 비-연결거부 예외 → 즉시 전파(재시도 안 함, 원 예외 보존).
  {
    let n = 0;
    const boom = new Error("boom-not-retryable");
    const attemptInit = async (): Promise<CdpSession> => {
      n += 1;
      throw boom;
    };
    const err = await caught(createStagehandSession(OPTS, { attemptInit, baseDelayMs: 1, maxAttempts: 5 }));
    check("non-conn-refused → immediate rethrow (no retry), original preserved", err === boom && n === 1, `n=${n}`);
  }

  // 4) LeaseKeyedSessionProvider — leaseId 키 세션 레지스트리(SingleSessionProvider 일반화).
  {
    const provider = new LeaseKeyedSessionProvider();
    const sA = { __lease: "A" } as unknown as CdpSession;
    const sB = { __lease: "B" } as unknown as CdpSession;
    provider.register("lease-A", sA);
    provider.register("lease-B", sB);

    check(
      "forLease returns the bound session per leaseId (no cross-lease share)",
      provider.forLease("lease-A") === sA && provider.forLease("lease-B") === sB,
    );
    check("forLease idempotent (repeat → same session)", provider.forLease("lease-A") === sA);

    const unbound = caughtSync(() => provider.forLease("lease-Z"));
    check(
      "forLease(unbound) → CdpDisconnectedError(CDP_DISCONNECTED), no silent null",
      unbound instanceof CdpDisconnectedError && (unbound as CdpDisconnectedError).code === "CDP_DISCONNECTED",
      String(unbound),
    );

    const dup = caughtSync(() => provider.register("lease-A", sB));
    check(
      "register(duplicate leaseId) → throws (no silent overwrite/leak), existing binding intact",
      dup instanceof Error && provider.forLease("lease-A") === sA,
      String(dup),
    );

    const removed = provider.unbind("lease-A");
    const afterUnbind = caughtSync(() => provider.forLease("lease-A"));
    check(
      "unbind removes binding (returns session for caller close; forLease then throws)",
      removed === sA && afterUnbind instanceof CdpDisconnectedError,
      `removed=${String(removed)}`,
    );
    check("unbind(absent) → undefined (idempotent)", provider.unbind("lease-A") === undefined);
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: cdp-session unit green (RQ-001 launch retry + LeaseKeyedSessionProvider)");
  process.exit(0);
}

main().catch((e) => {
  console.error("unit fatal:", e);
  process.exit(1);
});
