export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
export const WORKER_STALE_THRESHOLD_MS = 120_000;

export function workerStaleThresholdSeconds(): number {
  return Math.floor(WORKER_STALE_THRESHOLD_MS / 1000);
}
