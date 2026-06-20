/**
 * checkout-expiry sweeper 통합 (C2 — state-machine.md W1/W6/W7). 실 PostgreSQL.
 *
 * 검증:
 *  - W1 checkout 시 checkout_expires_at = now() + ops-defaults #workitem.checkout_timeout 설정.
 *  - sweeper: 만료(checkout_expires_at < now()) processing → attempts<max W6 retry / attempts>=max W7 abandoned+dead_letter.
 *  - W9 pause(checkout_paused_at IS NOT NULL) 및 미만료(future)는 제외.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/workitem-checkout-sweeper.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CorrelationId, RunId, TenantId } from "../../ts/security-middleware-contract";
import type { WorkitemId } from "../../ts/runtime-contract";
import { createPool, withTenantTx } from "../src/db/pool";
import { PgRuntimeWorker } from "../src/worker/runtime-worker";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_checkout_sweeper_int";
const TENANT = "00000000-0000-0000-0000-0000000000f1";
const WORKER = "9a000000-0000-0000-0000-0000000000f1";
const CORRELATION = "20000000-0000-0000-0000-0000000000f1";
const WI_NEW = "72000000-0000-0000-0000-0000000000f1";
const WI_RETRY = "72000000-0000-0000-0000-0000000000f2";
const WI_ABANDON = "72000000-0000-0000-0000-0000000000f3";
const WI_PAUSED = "72000000-0000-0000-0000-0000000000f4";
const WI_FRESH = "72000000-0000-0000-0000-0000000000f5";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function wi(pool: ReturnType<typeof createPool>, id: string): Promise<{ status: string; attempts: number; expires: Date | null }> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ status: string; attempts: number; checkout_expires_at: Date | null }>(
      `SELECT status, attempts, checkout_expires_at FROM workitems WHERE id=$1::uuid`,
      [id],
    );
    const row = r.rows[0];
    return { status: row?.status ?? "missing", attempts: row?.attempts ?? -1, expires: row?.checkout_expires_at ?? null };
  });
}

async function deadLetterCount(pool: ReturnType<typeof createPool>, id: string): Promise<number> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM dead_letter WHERE workitem_id=$1::uuid`, [id]);
    return r.rows[0]?.n ?? 0;
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
      await setup.query(`INSERT INTO workers (id, kind, status, circuit_state) VALUES ($1::uuid,'browser','active','closed')`, [WORKER]);
    } finally {
      setup.release();
    }

    await withTenantTx(pool, TENANT, async (c) => {
      // WI_NEW: checkout(W1) 대상.
      await c.query(`INSERT INTO workitems (id, tenant_id, connector_id, unique_reference, status, attempts) VALUES ($1,$2,'sw','wi-new','new',0)`, [WI_NEW, TENANT]);
      // 만료 processing(attempts<max → W6 retry / >=max → W7 abandoned).
      await c.query(
        `INSERT INTO workitems (id, tenant_id, connector_id, unique_reference, status, attempts, checkout_expires_at)
         VALUES ($1,$2,'sw','wi-retry','processing',0, now() - interval '1 hour')`, [WI_RETRY, TENANT]);
      await c.query(
        `INSERT INTO workitems (id, tenant_id, connector_id, unique_reference, status, attempts, checkout_expires_at)
         VALUES ($1,$2,'sw','wi-abandon','processing',2, now() - interval '1 hour')`, [WI_ABANDON, TENANT]);
      // pause(W9) 중 — 만료여도 제외.
      await c.query(
        `INSERT INTO workitems (id, tenant_id, connector_id, unique_reference, status, attempts, checkout_expires_at, checkout_paused_at)
         VALUES ($1,$2,'sw','wi-paused','processing',0, now() - interval '1 hour', now())`, [WI_PAUSED, TENANT]);
      // 미만료(future) — 제외.
      await c.query(
        `INSERT INTO workitems (id, tenant_id, connector_id, unique_reference, status, attempts, checkout_expires_at)
         VALUES ($1,$2,'sw','wi-fresh','processing',0, now() + interval '1 hour')`, [WI_FRESH, TENANT]);
    });

    const worker = new PgRuntimeWorker(pool, { workerId: WORKER });

    // 1) W1 checkout → processing + checkout_expires_at 설정(미래).
    const checkedOut = await worker.handle({ kind: "workitem_checkout", tenantId: TENANT as TenantId, workitemId: WI_NEW as WorkitemId, correlationId: CORRELATION as CorrelationId, runId: undefined as unknown as RunId });
    check("workitem_checkout → completed", checkedOut.kind === "completed", JSON.stringify(checkedOut));
    {
      const w = await wi(pool, WI_NEW);
      check("checkout → status processing", w.status === "processing", w.status);
      check("checkout → checkout_expires_at 설정(미래)", w.expires !== null && w.expires.getTime() > Date.now(), String(w.expires));
    }

    // 2) sweep.
    const swept = await worker.handle({ kind: "workitem_checkout_sweeper", tenantId: TENANT as TenantId, correlationId: CORRELATION as CorrelationId });
    check("workitem_checkout_sweeper → completed", swept.kind === "completed", JSON.stringify(swept));

    const retry = await wi(pool, WI_RETRY);
    check("만료+attempts<max → W6 retry", retry.status === "retry", retry.status);
    check("W6 retry → attempts 증가(0→1)", retry.attempts === 1, String(retry.attempts));

    const abandon = await wi(pool, WI_ABANDON);
    check("만료+attempts>=max → W7 abandoned", abandon.status === "abandoned", abandon.status);
    check("W7 → dead_letter 1건", (await deadLetterCount(pool, WI_ABANDON)) === 1, String(await deadLetterCount(pool, WI_ABANDON)));

    check("pause(W9) 중 workitem 은 제외(processing 유지)", (await wi(pool, WI_PAUSED)).status === "processing", (await wi(pool, WI_PAUSED)).status);
    check("미만료(future) workitem 은 제외(processing 유지)", (await wi(pool, WI_FRESH)).status === "processing", (await wi(pool, WI_FRESH)).status);
    check("WI_NEW(방금 checkout, 미래만료) 은 sweep 제외", (await wi(pool, WI_NEW)).status === "processing", (await wi(pool, WI_NEW)).status);
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: checkout-expiry sweeper — W1 TTL 설정 + W6 retry / W7 abandoned+dead_letter, pause/미만료 제외 (C2)");
  process.exit(0);
}

main().catch((e) => {
  console.error("workitem-checkout-sweeper int fatal:", e);
  process.exit(1);
});
