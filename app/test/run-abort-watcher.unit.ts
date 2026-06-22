/**
 * startRunAbortWatcher 단위 테스트 (AUD-5) — 실행: tsx test/run-abort-watcher.unit.ts.
 * run abort 전파 폴러: runs.status='aborting'/'cancelled' 감지 시 AbortController 발화, stop() 후 미발화, readStatus
 * 일시 오류는 best-effort(다음 tick 재시도). DB/PG 없이 readStatus 주입으로 검증.
 */
import { startRunAbortWatcher } from "../src/runtime/run-step-driver";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // 1) status 가 'aborting' 으로 바뀌면 controller.abort() 발화.
  {
    const controller = new AbortController();
    let n = 0;
    const stop = startRunAbortWatcher(async () => { n += 1; return n >= 2 ? "aborting" : "running"; }, controller, 10);
    await sleep(80);
    stop();
    check("aborting status → controller aborted", controller.signal.aborted === true, `n=${n}`);
  }

  // 2) 계속 running + stop() → 영구 미발화(폴러 정지).
  {
    const controller = new AbortController();
    const stop = startRunAbortWatcher(async () => "running", controller, 10);
    await sleep(40);
    stop();
    await sleep(40);
    check("running + stop → not aborted (watcher stopped)", controller.signal.aborted === false);
  }

  // 3) readStatus 일시 throw → best-effort(크래시 없이 다음 tick 재시도), 회복 후 발화.
  {
    const controller = new AbortController();
    let n = 0;
    const stop = startRunAbortWatcher(async () => { n += 1; if (n < 3) throw new Error("db hiccup"); return "aborting"; }, controller, 10);
    await sleep(100);
    stop();
    check("readStatus throws then recovers → eventually aborts (best-effort)", controller.signal.aborted === true && n >= 3, `n=${n}`);
  }

  // 4) 'cancelled' 도 발화(워커가 cancelled 전 도달 가능).
  {
    const controller = new AbortController();
    const stop = startRunAbortWatcher(async () => "cancelled", controller, 10);
    await sleep(40);
    stop();
    check("cancelled status → controller aborted", controller.signal.aborted === true);
  }

  // 5) stop() 후엔 readStatus 가 aborting 이어도 미발화(정지 보장 — 댕글링 tick 무해).
  {
    const controller = new AbortController();
    let calls = 0;
    const stop = startRunAbortWatcher(async () => { calls += 1; return "running"; }, controller, 10);
    await sleep(25);
    stop();
    const callsAtStop = calls;
    await sleep(40);
    check("stop() halts polling (no further readStatus calls)", calls === callsAtStop, `before=${callsAtStop} after=${calls}`);
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: run-abort-watcher unit green (AUD-5)");
  process.exit(0);
}

main().catch((e) => {
  console.error("unit fatal:", e);
  process.exit(1);
});
