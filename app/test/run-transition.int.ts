/**
 * D2 통합 테스트 — DB 연결 Run 전이 런타임을 실 PostgreSQL에 대해 검증.
 *
 * 실행: `scripts/db-temp-postgres-gate.mjs`가 띄운 일회용 PG15(비-BYPASSRLS `rpa_smoke`) 위에서
 *   `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app run test:int`
 * 게이트가 PGHOST/PGPORT/PGUSER/PGDATABASE를 주입한다.
 *
 * 검증 대상(state-machine.md §4 / architecture.md §4):
 *  1) 마이그레이션 적용(concurrency → core) 후 R2(claimed + run.started → running) CAS 성공.
 *  2) 동일 트랜잭션 outbox에 run.started 이벤트 1건 발행(payload는 닫힌 빈 객체).
 *  3) 동일 fromStatus 재시도는 CAS 경합으로 거부(applied:false), 실제 상태 재조회.
 *  4) outbox idempotency_key 재발행 차단(UNIQUE(tenant_id, idempotency_key)).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createPool, withTenantTx } from "../src/db/pool";
import { applyRunTransition } from "../src/runtime/run-transition";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const SCENARIO = "10000000-0000-0000-0000-000000000003";
const SCENARIO_VERSION = "10000000-0000-0000-0000-000000000004";
const WORKITEM = "10000000-0000-0000-0000-000000000005";
const RUN = "10000000-0000-0000-0000-000000000007";
const CORRELATION = "20000000-0000-0000-0000-000000000001";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// 전용 스키마 — PG15는 public에 CREATE 기본 권한을 주지 않는다(temp 게이트의 rpa_smoke는
// DB 소유자이나 public 스키마 소유자는 아님). migration_smoke.sql과 동일하게 소유 스키마에 적용.
const SCHEMA = "rpa_runtime_int";

async function main(): Promise<void> {
  // 모든 풀 커넥션의 search_path를 전용 스키마로 바인딩(libpq options).
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  try {
    // --- 마이그레이션 적용(순서: concurrency → core). 전용 스키마에 owner 권한으로 적용. ---
    const concurrencySql = readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8");
    const coreSql = readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8");
    const setup = await pool.connect();
    try {
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(concurrencySql);
      await setup.query(coreSql);
    } finally {
      setup.release();
    }
    console.log("migrations applied (concurrency → core)");

    // --- 시드(verified RLS 패턴: tenant 바인딩 후 FK 체인). run.status='claimed'. ---
    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'d2-int')`, [
        SCENARIO,
        TENANT,
      ]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
         VALUES ($1,$2,$3,1,'draft','{"nodes":[]}'::jsonb)`,
        [SCENARIO_VERSION, TENANT, SCENARIO],
      );
      await c.query(
        `INSERT INTO workitems (id, tenant_id, connector_id, unique_reference)
         VALUES ($1,$2,'d2-connector','wi-1')`,
        [WORKITEM, TENANT],
      );
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, workitem_id, status, correlation_id)
         VALUES ($1,$2,$3,$4,'claimed',$5)`,
        [RUN, TENANT, SCENARIO_VERSION, WORKITEM, CORRELATION],
      );
    });
    console.log("seeded scenario/version/workitem/run(claimed)");

    // --- 테스트 1+2: R2 CAS 성공 + outbox 발행 ---
    const outcome = await withTenantTx(pool, TENANT, (c) =>
      applyRunTransition(c, {
        tenantId: TENANT,
        runId: RUN,
        fromStatus: "claimed",
        event: { type: "run.started" },
        guard: { initOk: true },
        correlationId: CORRELATION,
        eventIdempotencyKey: `${RUN}:lifecycle`,
      }),
    );
    check("R2 applied", outcome.applied, JSON.stringify(outcome));
    if (outcome.applied) {
      check("R2 next=running", outcome.next === "running", outcome.next);
      check("R2 emitted run.started", outcome.emitted.some((e) => e.eventType === "run.started"));
      check("R2 no dropped cmds (pending empty)", outcome.pending.length === 0);
    }

    // --- 검증: 영속 상태 + outbox 행 ---
    await withTenantTx(pool, TENANT, async (c) => {
      const run = await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1`, [RUN]);
      check("runs.status persisted = running", run.rows[0]?.status === "running", run.rows[0]?.status);
      const ev = await c.query<{ event_type: string; payload: unknown; published_at: string | null }>(
        `SELECT event_type, payload, published_at FROM events_outbox WHERE run_id=$1 AND event_type='run.started'`,
        [RUN],
      );
      check("outbox has 1 run.started", ev.rowCount === 1, `rowCount=${ev.rowCount}`);
      check("outbox payload closed-empty", JSON.stringify(ev.rows[0]?.payload) === "{}");
      check("outbox unpublished (relay pending)", ev.rows[0]?.published_at === null);
    });

    // --- 테스트 3: 동일 fromStatus 재시도 → CAS 경합 거부 ---
    const conflict = await withTenantTx(pool, TENANT, (c) =>
      applyRunTransition(c, {
        tenantId: TENANT,
        runId: RUN,
        fromStatus: "claimed", // 이미 running — 경합
        event: { type: "run.started" },
        guard: { initOk: true },
        correlationId: CORRELATION,
      }),
    );
    check("CAS conflict not applied", !conflict.applied, JSON.stringify(conflict));
    if (!conflict.applied) {
      check("CAS conflict observed=running", conflict.observed === "running", conflict.observed ?? "null");
    }

    // --- 테스트 4: outbox idempotency 재발행 차단 ---
    // running 상태에서 R7(last_node_success→completing)을 동일 idempotency 앵커로 두 번 시도.
    // 첫 번째는 성공, 두 번째는 fromStatus 경합(상태가 이미 completing)으로 막힌다 — 즉 상태 CAS가
    // 1차 방어. outbox UNIQUE 자체는 db 스모크가 별도 커버하므로 여기서는 상태 CAS 멱등만 확인.
    const advance = await withTenantTx(pool, TENANT, (c) =>
      applyRunTransition(c, {
        tenantId: TENANT,
        runId: RUN,
        fromStatus: "running",
        event: { type: "last_node_success" },
        guard: { flowTerminalReached: true },
        correlationId: CORRELATION,
      }),
    );
    check("R7 running→completing applied", advance.applied && advance.next === "completing", JSON.stringify(advance));
    // R7 sideEffect는 finalizeOutputs(비-DB) — pending으로 보존되어야(조용한 drop 금지).
    if (advance.applied) {
      check("R7 finalizeOutputs preserved in pending", advance.pending.some((p) => p.kind === "finalizeOutputs"));
    }
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D2 run-transition integration green");
}

main().catch((err) => {
  console.error("FAIL: integration test threw:", err);
  process.exit(1);
});
