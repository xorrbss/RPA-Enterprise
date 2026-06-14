/**
 * D2.5 통합 테스트 — Graphile Worker 큐 → RuntimeWorker.handle → DB 효과.
 *
 * 실 PG15(temp 게이트)에서 큐 enqueue → runOnce 소비 → outbox 발행 효과를 검증한다.
 * graphile-worker는 자체 graphile_worker 스키마를 쓰고, app 테이블은 전용 스키마에 적용.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { quickAddJob, runMigrations } from "graphile-worker";

import type { TenantId } from "../../ts/security-middleware-contract";

import { createPool, withTenantTx } from "../src/db/pool";
import { emitOutboxEvent } from "../src/runtime/outbox";
import { runOnceRuntimeWorker, RUNTIME_JOB_TASK } from "../src/worker/graphile-runner";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_gw_int";
const TENANT = "00000000-0000-0000-0000-0000000000c3";
const CORRELATION = "20000000-0000-0000-0000-0000000000c3";

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
  return `postgres://${user}@${host}:${port}/${db}`;
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const conn = connectionString();
  try {
    // app 테이블을 전용 스키마에 적용.
    const setup = await pool.connect();
    try {
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
    } finally {
      setup.release();
    }
    // graphile-worker 자체 스키마 설치.
    await runMigrations({ connectionString: conn });
    console.log("migrations applied (app schema + graphile_worker)");

    // run-less tenant 이벤트(site.circuit_opened) 미발행 1건 시드 — run FK 불필요.
    await withTenantTx(pool, TENANT, (c) =>
      emitOutboxEvent(c, {
        tenantId: TENANT,
        eventType: "site.circuit_opened",
        correlationId: CORRELATION,
        idempotencyKey: "gw-int:site.circuit_opened",
      }),
    );

    // 큐에 outbox_relay 잡 enqueue → runOnce 소비.
    await quickAddJob({ connectionString: conn }, RUNTIME_JOB_TASK, {
      kind: "outbox_relay",
      tenantId: TENANT,
    });
    await runOnceRuntimeWorker(conn, pool);
    console.log("enqueued outbox_relay + ran queue once");

    // 효과: 큐 소비 task가 relay를 돌려 이벤트가 발행됨.
    await withTenantTx(pool, TENANT, async (c) => {
      const row = await c.query<{ published_at: string | null }>(
        `SELECT published_at FROM events_outbox WHERE tenant_id=$1 AND event_type='site.circuit_opened'`,
        [TENANT],
      );
      check("queue-driven relay published the event", row.rows[0]?.published_at !== null, JSON.stringify(row.rows[0]));
      const unpub = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM events_outbox WHERE published_at IS NULL`,
      );
      check("no unpublished rows after queue run", unpub.rows[0]?.n === 0, `n=${unpub.rows[0]?.n}`);
    });

    // TenantId 브랜드 정합(타입 경계 확인 — 런타임 무관, 컴파일 의미).
    const _typed: TenantId = TENANT as TenantId;
    void _typed;
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D2 graphile-worker queue integration green");
}

main().catch((err) => {
  console.error("FAIL: graphile-worker integration threw:", err);
  process.exit(1);
});
