/**
 * 단위 — startBrowserLeaseHeartbeat: drive(Phase B/C) 동안 browser_lease 주기 갱신 루프 (상태머신 감사 클러스터 A).
 *
 * 결함: production drive 경로가 browser_lease(ttl 5분)를 갱신하지 않아, 5분 초과 run 은 lease_sweeper 가 lease 를
 * 만료시키고 라이브 세션을 drain → failed_system 으로 좌초. 수정: drive 동안 heartbeat_interval(30s)로 renew.
 * renewBrowserLease SQL 자체는 runtime-worker-claim.int 에서 검증되므로, 여기선 루프 거동만 검증한다:
 *   (1) 주기적으로 renew 호출 + stop() 후 정지, (2) lost(만료/drain/타워커) → 재예약 없이 정지 + onLost, (3) 일시 throw → 재시도 지속.
 *
 * 실행: tsx app/test/browser-lease-heartbeat.unit.ts
 */
import { startBrowserLeaseHeartbeat } from "../src/worker/runtime-worker-browser-lease";
import type { LeaseRenewResult } from "../../ts/runtime-contract";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

const RENEWED = { kind: "renewed", expiresAt: "2030-01-01T00:00:00.000Z" } as LeaseRenewResult;
const LOST = { kind: "lost", code: "BROWSER_LEASE_EXPIRED", reason: "test-lost" } as LeaseRenewResult;

async function main(): Promise<void> {
  // (1) 주기 갱신 + stop() 정지
  {
    let calls = 0;
    const hb = startBrowserLeaseHeartbeat({ intervalMs: 10, renew: async () => { calls += 1; return RENEWED; } });
    await sleep(110);
    const afterRun = calls;
    check("주기 갱신: drive 동안 여러 비트 발생", afterRun >= 3, `calls=${afterRun}`);
    hb.stop();
    await sleep(60);
    check("stop() 후 추가 비트 없음(누수 방지)", calls === afterRun, `before=${afterRun} after=${calls}`);
  }

  // (2) lost → 재예약 없이 정지 + onLost 1회
  {
    let calls = 0;
    let lostReason: string | undefined;
    startBrowserLeaseHeartbeat({ intervalMs: 10, renew: async () => { calls += 1; return LOST; }, onLost: (r) => { lostReason = r; } });
    await sleep(80);
    check("lost(sweeper 승) 시 비트 1회 후 정지(재생성 금지)", calls === 1, `calls=${calls}`);
    check("onLost 사유 전달", lostReason === "test-lost", String(lostReason));
  }

  // (3) renew 일시 throw → 루프 죽지 않고 다음 비트 재시도
  {
    let calls = 0;
    const hb = startBrowserLeaseHeartbeat({ intervalMs: 10, renew: async () => { calls += 1; throw new Error("transient"); } });
    await sleep(80);
    hb.stop();
    check("일시 DB 오류에도 재시도 지속", calls >= 3, `calls=${calls}`);
  }
}

main().then(() => {
  if (failures > 0) { console.error(`\nFAIL: ${failures} check(s) failed`); process.exit(1); }
  console.log("\nPASS: browser-lease heartbeat 루프(주기/stop/lost/throw) — 감사 클러스터 A");
  process.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });
