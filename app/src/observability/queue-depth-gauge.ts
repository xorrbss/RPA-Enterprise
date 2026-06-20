/**
 * queue_depth(§E) — graphile-worker 대기(미잠금) 작업 수를 ObservableGauge 로 노출한다.
 *
 * 수집 시점에 DB를 조회하는 ObservableGauge 로, worker 부트스트랩에서 1회 등록한다. graphile_worker.jobs 뷰 기준
 * (api/run-queue.ts 의 graphile_worker.add_job 과 동일 스키마 가정 — 기본 GRAPHILE_WORKER_SCHEMA). 전역(테넌트리스
 * jobs 테이블)이라 attribute 는 없다. 조회 실패는 거짓 0 을 보고하지 않고 관측을 생략한다("조용한 false 금지" — 빈 큐로
 * 오인 방지)+로그. bootstrapObservability 전(전역 MeterProvider 미등록)이면 no-op meter 라 콜백 자체가 호출되지 않는다.
 */
import type { Pool } from "pg";

import { getMeter, METRIC } from "./telemetry";

export function registerQueueDepthGauge(pool: Pool): void {
  const gauge = getMeter().createObservableGauge(METRIC.queueDepth, {
    description: "graphile-worker 대기(미잠금) 작업 수",
  });
  gauge.addCallback(async (result) => {
    try {
      const r = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE locked_at IS NULL`,
      );
      const n = r.rows[0]?.n;
      if (typeof n === "number") result.observe(n);
    } catch (e) {
      console.error(`queue-depth-gauge: 대기 작업 수 조회 실패 — ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}
