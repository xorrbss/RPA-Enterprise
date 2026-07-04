// run-step-driver.ts 에서 추출 — run abort 전파 폴러(동작 무변경). leaf — drive 가 역import.
import type { RunState } from "../../../ts/state-machine-types";

// run abort 전파(AUD-5) — abort 는 API 프로세스가 runs.status='aborting'으로만 바꾸고, driveScenario(워커 프로세스)는 그 신호를
//   직접 못 받는다. 폴러가 runs.status 를 주기 재조회해 abort 시 AbortController 발화 → ctx.abortSignal 이 실행기/
//   게이트웨이(gateway.call(req,signal))로 in-flight LLM 호출을 취소(종전 throwaway signal=LLM 완주, 비용 낭비).
//   terminalization CAS(WHERE status='running')는 aborting run 에 no-op 이라 run_abort 가 cancelled 종결 소유(레이스 없음).
const RUN_ABORT_POLL_MS = Math.max(250, Number(process.env.RUN_ABORT_POLL_MS) || 2000);

export function startRunAbortWatcher(
  readStatus: () => Promise<RunState | undefined>,
  controller: AbortController,
  pollMs: number = RUN_ABORT_POLL_MS,
): () => void {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped || controller.signal.aborted) return;
    try {
      const status = await readStatus();
      if (!stopped && (status === "aborting" || status === "cancelled")) controller.abort();
    } catch {
      // best-effort 폴 — DB 일시 오류는 다음 tick 재시도(미발화 시 기존 동작=세션 teardown 종결로 폴백).
    }
  };
  const timer = setInterval(() => void tick(), pollMs);
  (timer as { unref?: () => void }).unref?.(); // 폴러가 프로세스 종료를 막지 않게(keepalive 방지).
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
