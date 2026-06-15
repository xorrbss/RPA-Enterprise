/**
 * D6 통합 — outbox→bus relay 순서/중복(architecture §4 "outbox → event bus", at-least-once).
 *
 * 실행(temp 게이트): `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app run test:int`
 * 검증:
 *  - relayOutbox는 미발행(published_at IS NULL) 행을 created_at 순으로 발행(ORDER BY created_at)
 *  - 발행 후 두 번째 패스는 0행 재발행(CAS WHERE published_at IS NULL — 중복 발행 금지)
 *  - 동일 (tenant_id, idempotency_key) 재인큐는 UNIQUE로 차단(소비자 멱등)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createPool, withTenantTx } from "../src/db/pool";
import { relayOutbox } from "../src/runtime/outbox-relay";
import { emitPipelineStageCompleted } from "../src/runtime/pipeline/normalize";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_relay_int";
const TENANT = "00000000-0000-0000-0000-0000000000c1";
const CORR = "61000000-0000-0000-0000-000000000001";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  try {
    const concurrencySql = readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8");
    const coreSql = readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8");
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(concurrencySql);
      await setup.query(coreSql);
    } finally {
      setup.release();
    }
    console.log("migrations applied (concurrency → core)");

    // 3개 이벤트를 발행하고 created_at을 의도적으로 어긋나게 세팅(발행 순서 결정성 검증).
    const ids = await withTenantTx(pool, TENANT, async (c) => {
      const e1 = await emitPipelineStageCompleted(c, { tenantId: TENANT, correlationId: CORR, idempotencyKey: "k1" });
      const e2 = await emitPipelineStageCompleted(c, { tenantId: TENANT, correlationId: CORR, idempotencyKey: "k2" });
      const e3 = await emitPipelineStageCompleted(c, { tenantId: TENANT, correlationId: CORR, idempotencyKey: "k3" });
      // created_at: k2(가장 이름) < k3 < k1 → 발행 순서 = k2, k3, k1
      await c.query(`UPDATE events_outbox SET created_at='2026-06-15T10:02:00Z' WHERE event_id=$1::uuid`, [e1.eventId]);
      await c.query(`UPDATE events_outbox SET created_at='2026-06-15T10:00:00Z' WHERE event_id=$1::uuid`, [e2.eventId]);
      await c.query(`UPDATE events_outbox SET created_at='2026-06-15T10:01:00Z' WHERE event_id=$1::uuid`, [e3.eventId]);
      return { k1: e1.eventId, k2: e2.eventId, k3: e3.eventId };
    });

    // relay #1: created_at 순서로 발행
    const pass1 = await withTenantTx(pool, TENANT, (c) => relayOutbox(c));
    check("relay #1 published 3", pass1.publishedEventIds.length === 3, JSON.stringify(pass1.publishedEventIds));
    check(
      "relay #1 order = created_at asc (k2,k3,k1)",
      pass1.publishedEventIds[0] === ids.k2 && pass1.publishedEventIds[1] === ids.k3 && pass1.publishedEventIds[2] === ids.k1,
      JSON.stringify(pass1.publishedEventIds),
    );
    const unpublished = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM events_outbox WHERE published_at IS NULL`);
      return Number(r.rows[0]!.n);
    });
    check("all published (0 unpublished)", unpublished === 0);

    // relay #2: 재발행 없음(CAS WHERE published_at IS NULL)
    const pass2 = await withTenantTx(pool, TENANT, (c) => relayOutbox(c));
    check("relay #2 republishes 0 (idempotent)", pass2.publishedEventIds.length === 0, JSON.stringify(pass2.publishedEventIds));

    // 동일 (tenant, idempotency_key) 재인큐 → UNIQUE 차단
    let dupThrew = false;
    try {
      await withTenantTx(pool, TENANT, (c) =>
        emitPipelineStageCompleted(c, { tenantId: TENANT, correlationId: CORR, idempotencyKey: "k1" }));
    } catch {
      dupThrew = true;
    }
    check("duplicate idempotency_key re-enqueue blocked", dupThrew);
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D6 outbox relay (order + idempotent republish) integration green");
  process.exit(0);
}

main().catch((e) => {
  console.error("int fatal:", e);
  process.exit(1);
});
