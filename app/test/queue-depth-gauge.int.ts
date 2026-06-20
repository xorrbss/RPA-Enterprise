/**
 * queue_depth ObservableGauge 통합 (C4 §E). 실 PostgreSQL + graphile-worker 스키마.
 *
 * runMigrations 로 graphile_worker.jobs 뷰 생성 → add_job N회(미잠금) → gauge 콜백이 미잠금 작업 수 N 을 관측하는지
 * (PeriodicExportingMetricReader.forceFlush 가 collect→export 트리거, InMemoryMetricExporter 로 캡처) 검증한다.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/queue-depth-gauge.int.ts
 */
import { quickAddJob, runMigrations } from "graphile-worker";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";

import { bootstrapMetrics } from "../src/observability/bootstrap";
import { registerQueueDepthGauge } from "../src/observability/queue-depth-gauge";
import { METRIC } from "../src/observability/telemetry";
import { createPool } from "../src/db/pool";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function connectionString(): string {
  const host = process.env.PGHOST ?? "127.0.0.1";
  const port = process.env.PGPORT ?? "5432";
  const user = process.env.PGUSER ?? "postgres";
  const db = process.env.PGDATABASE ?? "postgres";
  const pw = process.env.PGPASSWORD;
  const auth = pw !== undefined && pw !== "" ? `${encodeURIComponent(user)}:${encodeURIComponent(pw)}` : encodeURIComponent(user);
  return `postgres://${auth}@${host}:${port}/${db}`;
}

async function observedQueueDepth(reader: PeriodicExportingMetricReader, exporter: InMemoryMetricExporter): Promise<number | undefined> {
  exporter.reset();
  await reader.forceFlush();
  for (const rm of exporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        if (m.descriptor.name === METRIC.queueDepth) {
          const dp = m.dataPoints[m.dataPoints.length - 1];
          return dp?.value as number | undefined;
        }
      }
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const conn = connectionString();
  const pool = createPool();
  try {
    await runMigrations({ connectionString: conn });
    // temp PG는 갓 migration 된 빈 큐 — 별도 정리 불요(graphile_worker.jobs 는 뷰라 쓰기 불가).

    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
    bootstrapMetrics(reader);
    registerQueueDepthGauge(pool);

    const empty = await observedQueueDepth(reader, exporter);
    check("queue_depth observes 0 when queue empty", empty === 0, String(empty));

    for (let i = 0; i < 3; i += 1) await quickAddJob({ connectionString: conn }, "noop", { i });
    const three = await observedQueueDepth(reader, exporter);
    check("queue_depth observes pending job count (3)", three === 3, String(three));

    await reader.shutdown();
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: queue_depth ObservableGauge — graphile_worker.jobs 미잠금 작업 수 관측 (C4 §E)");
  process.exit(0);
}

main().catch((e) => {
  console.error("queue-depth-gauge int fatal:", e);
  process.exit(1);
});
