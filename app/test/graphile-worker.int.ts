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
import { EVENTS_OUTBOX_RETENTION_POLICY, emitOutboxEvent, type OutboxEmit } from "../src/runtime/outbox";
import { runOnceRuntimeWorker, RUNTIME_JOB_TASK } from "../src/worker/graphile-runner";
import type { BrowserLeasePlanResolver } from "../src/worker/runtime-worker";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_gw_int";
const TENANT = "00000000-0000-0000-0000-0000000000c3";
const CORRELATION = "20000000-0000-0000-0000-0000000000c3";
const SCENARIO = "30000000-0000-0000-0000-0000000000c3";
const SCENARIO_VERSION = "30000000-0000-0000-0000-0000000000c4";
const RUN_CLAIM = "30000000-0000-0000-0000-0000000000c5";
const WORKER = "40000000-0000-0000-0000-0000000000c3";
const SITE_PROFILE = "50000000-0000-0000-0000-0000000000c3";
const BROWSER_IDENTITY = "50000000-0000-0000-0000-0000000000c4";

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

const runClaimPlan: BrowserLeasePlanResolver = async () => ({
  siteProfileId: SITE_PROFILE,
  browserIdentityId: BROWSER_IDENTITY,
  ttlMs: 60_000,
  downloadDirRef: "lease://graphile-run-claim",
});

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

    await withTenantTx(pool, TENANT, async (c) => {
      try {
        await emitOutboxEvent(c, {
          tenantId: TENANT,
          eventType: "site.circuit_opened",
          correlationId: CORRELATION,
          idempotencyKey: "gw-int:missing-retention-policy",
        } as OutboxEmit);
        check("missing retention policy fails closed", false, "expected throw");
      } catch (err) {
        check(
          "missing retention policy fails closed",
          String(err).includes("retentionPolicy is required"),
          String(err),
        );
      }
      try {
        await emitOutboxEvent(c, {
          tenantId: TENANT,
          eventType: "site.circuit_opened",
          correlationId: CORRELATION,
          idempotencyKey: "gw-int:unsupported-retention-policy-source",
          retentionPolicy: {
            source: "external-policy@unknown" as typeof EVENTS_OUTBOX_RETENTION_POLICY.source,
            durationSeconds: EVENTS_OUTBOX_RETENTION_POLICY.durationSeconds,
          },
        });
        check("unsupported retention policy source fails closed", false, "expected throw");
      } catch (err) {
        check(
          "unsupported retention policy source fails closed",
          String(err).includes("unsupported retention policy source"),
          String(err),
        );
      }
      try {
        await emitOutboxEvent(c, {
          tenantId: TENANT,
          eventType: "site.circuit_opened",
          correlationId: CORRELATION,
          idempotencyKey: "gw-int:invalid-retention-policy",
          retentionPolicy: {
            source: EVENTS_OUTBOX_RETENTION_POLICY.source,
            durationSeconds: 0,
          },
        });
        check("invalid retention policy fails closed", false, "expected throw");
      } catch (err) {
        check(
          "invalid retention policy fails closed",
          String(err).includes("durationSeconds must be a positive finite number"),
          String(err),
        );
      }
      const failedRows = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM events_outbox
          WHERE idempotency_key IN (
            'gw-int:missing-retention-policy',
            'gw-int:unsupported-retention-policy-source',
            'gw-int:invalid-retention-policy'
          )`,
      );
      check("failed retention policy inserts no outbox rows", failedRows.rows[0]?.n === 0, `n=${failedRows.rows[0]?.n}`);
    });

    // run-less tenant 이벤트(site.circuit_opened) 미발행 1건 시드 — run FK 불필요.
    await withTenantTx(pool, TENANT, (c) =>
      emitOutboxEvent(c, {
        tenantId: TENANT,
        eventType: "site.circuit_opened",
        correlationId: CORRELATION,
        idempotencyKey: "gw-int:site.circuit_opened",
        occurredAt: new Date("2000-01-01T00:00:00.000Z"),
        retentionPolicy: EVENTS_OUTBOX_RETENTION_POLICY,
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
      const row = await c.query<{
        published_at: string | null;
        retention_until: Date | null;
        occurred_from_input: boolean;
        retention_from_tx_clock: boolean;
        retention_not_backdated: boolean;
      }>(
        `SELECT published_at,
                retention_until,
                occurred_at = '2000-01-01T00:00:00.000Z'::timestamptz AS occurred_from_input,
                retention_until > now() + interval '89 days' AS retention_from_tx_clock,
                retention_until > occurred_at + interval '365 days' AS retention_not_backdated
           FROM events_outbox
          WHERE tenant_id=$1 AND event_type='site.circuit_opened'`,
        [TENANT],
      );
      check("queue-driven relay published the event", row.rows[0]?.published_at != null, JSON.stringify(row.rows[0]));
      check("outbox retention_until set", row.rows[0]?.retention_until != null, JSON.stringify(row.rows[0]));
      check("outbox occurred_at accepts supplied occurredAt", row.rows[0]?.occurred_from_input === true, JSON.stringify(row.rows[0]));
      check(
        "outbox retention calculated from DB transaction clock",
        row.rows[0]?.retention_from_tx_clock === true,
        JSON.stringify(row.rows[0]),
      );
      check(
        "outbox retention is not backdated from supplied occurredAt",
        row.rows[0]?.retention_not_backdated === true,
        JSON.stringify(row.rows[0]),
      );
      const unpub = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM events_outbox WHERE published_at IS NULL`,
      );
      check("no unpublished rows after queue run", unpub.rows[0]?.n === 0, `n=${unpub.rows[0]?.n}`);
    });

    // TenantId 브랜드 정합(타입 경계 확인 — 런타임 무관, 컴파일 의미).
    await pool.query(
      `INSERT INTO workers (id, kind, status, circuit_state)
       VALUES ($1::uuid,'browser','active','closed')`,
      [WORKER],
    );
    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'graphile-runtime-claim')`, [
        SCENARIO,
        TENANT,
      ]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
         VALUES ($1,$2,$3,1,'draft','{"nodes":[]}'::jsonb)`,
        [SCENARIO_VERSION, TENANT, SCENARIO],
      );
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id)
         VALUES ($1,$2,$3,'queued',$4)`,
        [RUN_CLAIM, TENANT, SCENARIO_VERSION, CORRELATION],
      );
      await c.query(
        `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved)
         VALUES ($1,$2,'graphile-claim','https://graphile.example/*','green',false)`,
        [SITE_PROFILE, TENANT],
      );
      await c.query(
        `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label)
         VALUES ($1,$2,$3,'graphile-claim')`,
        [BROWSER_IDENTITY, TENANT, SITE_PROFILE],
      );
    });

    await quickAddJob({ connectionString: conn }, RUNTIME_JOB_TASK, {
      kind: "run_claim",
      tenantId: TENANT,
      runId: RUN_CLAIM,
      correlationId: CORRELATION,
    });
    await runOnceRuntimeWorker(conn, pool, {
      workerId: WORKER,
      browserLeasePlanResolver: runClaimPlan,
    });
    console.log("enqueued run_claim + ran configured queue once");

    await withTenantTx(pool, TENANT, async (c) => {
      const run = await c.query<{ status: string; worker_id: string | null }>(
        `SELECT status, worker_id::text FROM runs WHERE id=$1::uuid`,
        [RUN_CLAIM],
      );
      check("queue-driven run_claim sets claimed", run.rows[0]?.status === "claimed", JSON.stringify(run.rows[0]));
      check("queue-driven run_claim sets worker_id", run.rows[0]?.worker_id === WORKER, JSON.stringify(run.rows[0]));
      const leases = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM browser_leases
          WHERE tenant_id=$1::uuid
            AND run_id=$2::uuid
            AND owner_worker_id=$3::uuid
            AND state='active'
            AND expires_at >= now()`,
        [TENANT, RUN_CLAIM, WORKER],
      );
      check("queue-driven run_claim creates active BrowserLease", leases.rows[0]?.n === 1, `n=${leases.rows[0]?.n}`);
    });

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
