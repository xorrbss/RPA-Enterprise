/**
 * D6 통합 — sink_deliveries 전달(멱등키·attempt 원장·status CAS·DLQ·이벤트) — test_fake 포트.
 *
 * 실행(temp 게이트): `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app run test:int`
 * 검증(db/migration_concurrency_idempotency.sql sink_deliveries + event-payload-registry):
 *  - sink_idempotency_key = tenant:sink_config:schema_ref:natural_key(attempt_no 제외)
 *  - delivered → status delivered + sink.delivered(closed payload), 이미 delivered면 already_delivered 단락
 *  - transient_failed: attempt<max → failed, attempt>=max → dead_letter + sink.dead_lettered
 *  - 동일 레코드 재전달 시 attempt_no 증가(1,2) + 동일 멱등키, cross-tenant FK fail-closed
 * 실 네트워크 전송은 외부 경계(test_fake는 staging 증거 아님).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createPool, withTenantTx } from "../src/db/pool";
import { ingestRawItem } from "../src/runtime/pipeline/raw-ingest";
import { normalizeRecord } from "../src/runtime/pipeline/normalize";
import {
  deliverNormalizedRecord,
  sinkIdempotencyKey,
  type SinkDeliveryDeps,
} from "../src/runtime/pipeline/sink-delivery";
import {
  SINK_DELIVERY_LOCAL_TEST_SCHEMA_REF,
  type SinkDeliveryDecision,
  type SinkDeliveryPort,
  type SinkDeliveryRequest,
} from "../../ts/runtime-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_sink_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000a2";
const SINK_CONFIG = "50000000-0000-0000-0000-000000000001";
const SCHEMA_REF = "schemas/review@1";
const CORR = "60000000-0000-0000-0000-000000000001";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

class FakeSinkPort implements SinkDeliveryPort {
  readonly binding = {
    kind: "test_fake" as const,
    backendAlias: "local-test-fake" as const,
    evidenceSchemaRef: SINK_DELIVERY_LOCAL_TEST_SCHEMA_REF,
    testOnly: true as const,
  };
  readonly calls: SinkDeliveryRequest[] = [];
  constructor(private readonly behavior: (req: SinkDeliveryRequest) => SinkDeliveryDecision) {}
  async deliver(input: SinkDeliveryRequest): Promise<SinkDeliveryDecision> {
    this.calls.push(input);
    return this.behavior(input);
  }
}

async function seedNormalized(
  pool: ReturnType<typeof createPool>,
  tenant: string,
  naturalKey: string,
): Promise<string> {
  return withTenantTx(pool, tenant, async (c) => {
    const raw = await ingestRawItem(c, {
      tenantId: tenant, connectorId: "reviews", targetId: "20000000-0000-0000-0000-0000000000e1",
      sourceItemKey: naturalKey, collectionAttemptId: "40000000-0000-0000-0000-0000000000aa",
      rawPayload: { nk: naturalKey }, correlationId: CORR,
    });
    const norm = await normalizeRecord(c, {
      tenantId: tenant, rawItemId: raw.rawItemId, schemaRef: SCHEMA_REF, naturalKey,
      record: { nk: naturalKey }, dedupAction: "insert",
    });
    return norm.normalizedRecordId;
  });
}

async function statusRows(pool: ReturnType<typeof createPool>, nrId: string): Promise<{ attempt_no: number; status: string; sink_idempotency_key: string }[]> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ attempt_no: number; status: string; sink_idempotency_key: string }>(
      `SELECT attempt_no, status, sink_idempotency_key FROM sink_deliveries
        WHERE normalized_record_id=$1::uuid ORDER BY attempt_no`,
      [nrId],
    );
    return r.rows;
  });
}

async function eventCount(pool: ReturnType<typeof createPool>, eventType: string): Promise<number> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM events_outbox WHERE event_type=$1`, [eventType]);
    return Number(r.rows[0]!.n);
  });
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

    const policy = { source: "ops-defaults.md#sink.delivery" as const, maxAttempts: 2 };

    // 1) delivered path
    const nr1 = await seedNormalized(pool, TENANT, "nk-deliver");
    const okPort = new FakeSinkPort(() => ({ kind: "delivered", receiptRef: "rcpt-1" }));
    const deps1: SinkDeliveryDeps = { pool, port: okPort, policy };
    const out1 = await deliverNormalizedRecord(deps1, {
      tenantId: TENANT, normalizedRecordId: nr1, sinkConfigId: SINK_CONFIG, correlationId: CORR,
    });
    const expectedKey = sinkIdempotencyKey({ tenantId: TENANT, sinkConfigId: SINK_CONFIG, schemaRef: SCHEMA_REF, naturalKey: "nk-deliver" });
    check("delivered status", out1.status === "delivered");
    check("attempt_no = 1", out1.attemptNo === 1);
    check("idempotency key composition", out1.sinkIdempotencyKey === `${TENANT}:${SINK_CONFIG}:${SCHEMA_REF}:nk-deliver`);
    check("port received same idempotency key", okPort.calls[0]?.sinkIdempotencyKey === expectedKey);
    const rows1 = await statusRows(pool, nr1);
    check("1 delivered row", rows1.length === 1 && rows1[0]!.status === "delivered");
    check("sink.delivered emitted", (await eventCount(pool, "sink.delivered")) === 1);
    const deliveredPayload = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ payload: unknown }>(`SELECT payload FROM events_outbox WHERE event_type='sink.delivered'`);
      return JSON.stringify(r.rows[0]!.payload);
    });
    check("sink.delivered closed-empty payload", deliveredPayload === "{}");

    // 2) already_delivered 단락(새 attempt 안 만듦)
    const out1b = await deliverNormalizedRecord(deps1, {
      tenantId: TENANT, normalizedRecordId: nr1, sinkConfigId: SINK_CONFIG, correlationId: CORR,
    });
    check("already_delivered short-circuit", out1b.status === "already_delivered");
    check("no new attempt row", (await statusRows(pool, nr1)).length === 1);

    // 3) transient_failed: attempt 1 → failed, attempt 2 → dead_letter
    const nr2 = await seedNormalized(pool, TENANT, "nk-fail");
    const failPort = new FakeSinkPort(() => ({ kind: "transient_failed", reason: "503 upstream" }));
    const deps2: SinkDeliveryDeps = { pool, port: failPort, policy };
    const f1 = await deliverNormalizedRecord(deps2, {
      tenantId: TENANT, normalizedRecordId: nr2, sinkConfigId: SINK_CONFIG, correlationId: CORR,
    });
    check("attempt 1 → failed (below cap)", f1.status === "failed" && f1.attemptNo === 1);
    const f2 = await deliverNormalizedRecord(deps2, {
      tenantId: TENANT, normalizedRecordId: nr2, sinkConfigId: SINK_CONFIG, correlationId: CORR,
    });
    check("attempt 2 → dead_letter (cap reached)", f2.status === "dead_letter" && f2.attemptNo === 2);
    const rows2 = await statusRows(pool, nr2);
    check("2 attempt rows (1,2)", rows2.length === 2 && rows2[0]!.attempt_no === 1 && rows2[1]!.attempt_no === 2);
    check("both attempts share idempotency key", rows2[0]!.sink_idempotency_key === rows2[1]!.sink_idempotency_key);
    check("attempt rows statuses failed→dead_letter", rows2[0]!.status === "failed" && rows2[1]!.status === "dead_letter");
    check("sink.dead_lettered emitted once", (await eventCount(pool, "sink.dead_lettered")) === 1);

    // 4) cross-tenant: OTHER_TENANT로 TENANT 레코드 전달 시도 → tenant-scoped 행 미존재 fail-closed(throw)
    let crossThrew = false;
    try {
      await deliverNormalizedRecord({ pool, port: okPort, policy }, {
        tenantId: OTHER_TENANT, normalizedRecordId: nr1, sinkConfigId: SINK_CONFIG, correlationId: CORR,
      });
    } catch {
      crossThrew = true;
    }
    check("cross-tenant delivery fails closed (FK)", crossThrew);
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D6 sink-delivery (idempotency·attempt·CAS·DLQ·events) integration green");
  process.exit(0);
}

main().catch((e) => {
  console.error("int fatal:", e);
  process.exit(1);
});
