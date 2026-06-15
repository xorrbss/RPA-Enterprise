/**
 * D6 통합 — raw_items 멱등 인입 + normalized_records 자연키 dedup + pipeline.stage.completed.
 *
 * 실행(temp 게이트): `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app run test:int`
 * 검증(db/migration_concurrency_idempotency.sql + event-payload-registry):
 *  A) raw-ingest: 동일 내용 재수집 → 1행(persisted=false), NULL source_item_key NULLS NOT DISTINCT,
 *     collect_tier 무관 dedup, 내용 변경 → 신규 행
 *  B) normalize: 다른 raw 두 건이 같은 자연키 → 1 normalized 행, dedup_action(insert/keep_existing/
 *     update_latest/merge), 재처리 멱등
 *  C) pipeline.stage.completed: 닫힌 빈 payload 발행, 동일 멱등키 재발행은 UNIQUE로 차단(throw)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createPool, withTenantTx } from "../src/db/pool";
import { ingestRawItem } from "../src/runtime/pipeline/raw-ingest";
import { normalizeRecord, emitPipelineStageCompleted } from "../src/runtime/pipeline/normalize";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_pipeline_int";
const TENANT = "00000000-0000-0000-0000-0000000000d1";
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000d2";
const CONNECTOR = "reviews";
const TARGET = "20000000-0000-0000-0000-0000000000e1";
const CORR = "30000000-0000-0000-0000-0000000000f1";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function countRaw(pool: ReturnType<typeof createPool>, tenant = TENANT): Promise<number> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM raw_items`);
    return Number(r.rows[0]!.n);
  });
}
async function countNormalized(pool: ReturnType<typeof createPool>): Promise<number> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM normalized_records`);
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

    const payload = { review_id: 1, text: "good", collected_at: "2026-06-15T00:00:00Z" };
    const volatile = ["collected_at"];

    // A) raw-ingest 멱등
    const r1 = await withTenantTx(pool, TENANT, (c) =>
      ingestRawItem(c, {
        tenantId: TENANT, connectorId: CONNECTOR, targetId: TARGET, sourceItemKey: "i1",
        collectionAttemptId: "40000000-0000-0000-0000-000000000001",
        rawPayload: payload, volatileFields: volatile, collectTier: "fast", correlationId: CORR,
      }));
    check("ingest #1 persisted=true", r1.persisted);

    // 동일 내용 재수집(volatile 변동 + collect_tier 변동) → dedup 흡수
    const r2 = await withTenantTx(pool, TENANT, (c) =>
      ingestRawItem(c, {
        tenantId: TENANT, connectorId: CONNECTOR, targetId: TARGET, sourceItemKey: "i1",
        collectionAttemptId: "40000000-0000-0000-0000-000000000002",
        rawPayload: { ...payload, collected_at: "2026-06-15T09:09:09Z" },
        volatileFields: volatile, collectTier: "full", correlationId: CORR,
      }));
    check("ingest #2 dedup persisted=false", !r2.persisted);
    check("ingest #2 same rawItemId", r2.rawItemId === r1.rawItemId, `${r2.rawItemId} vs ${r1.rawItemId}`);
    check("ingest #2 same raw_hash", r2.rawHash === r1.rawHash);
    check("raw count == 1 after dedup", (await countRaw(pool)) === 1);

    // NULL source_item_key NULLS NOT DISTINCT: 두 번 인입 → 1행
    const n1 = await withTenantTx(pool, TENANT, (c) =>
      ingestRawItem(c, {
        tenantId: TENANT, connectorId: CONNECTOR, targetId: TARGET, sourceItemKey: null,
        collectionAttemptId: "40000000-0000-0000-0000-000000000003",
        rawPayload: { page: 1, text: "p" }, correlationId: CORR,
      }));
    const n2 = await withTenantTx(pool, TENANT, (c) =>
      ingestRawItem(c, {
        tenantId: TENANT, connectorId: CONNECTOR, targetId: TARGET, sourceItemKey: null,
        collectionAttemptId: "40000000-0000-0000-0000-000000000004",
        rawPayload: { page: 1, text: "p" }, correlationId: CORR,
      }));
    check("NULL source_item_key persisted then dedup", n1.persisted && !n2.persisted && n1.rawItemId === n2.rawItemId);

    // 내용 변경 → 신규 행
    const d1 = await withTenantTx(pool, TENANT, (c) =>
      ingestRawItem(c, {
        tenantId: TENANT, connectorId: CONNECTOR, targetId: TARGET, sourceItemKey: "i1",
        collectionAttemptId: "40000000-0000-0000-0000-000000000005",
        rawPayload: { review_id: 1, text: "BAD" }, correlationId: CORR,
      }));
    check("content change → new row", d1.persisted && d1.rawItemId !== r1.rawItemId);
    check("raw count == 3", (await countRaw(pool)) === 3);

    // cross-tenant 격리: 다른 테넌트는 위 raw가 안 보임
    check("cross-tenant raw count == 0", (await countRaw(pool, OTHER_TENANT)) === 0);

    // B) normalize 자연키 dedup — 다른 raw 두 건(i1, null) → 같은 natural_key "nk1"
    const SCHEMA_REF = "schemas/review@1";
    const nrA = await withTenantTx(pool, TENANT, (c) =>
      normalizeRecord(c, { tenantId: TENANT, rawItemId: r1.rawItemId, schemaRef: SCHEMA_REF, naturalKey: "nk1", record: { v: 1 }, dedupAction: "insert" }));
    check("normalize A → insert", nrA.action === "insert");
    const nrB = await withTenantTx(pool, TENANT, (c) =>
      normalizeRecord(c, { tenantId: TENANT, rawItemId: n1.rawItemId, schemaRef: SCHEMA_REF, naturalKey: "nk1", record: { v: 2 }, dedupAction: "keep_existing" }));
    check("normalize B keep_existing → same row", nrB.action === "keep_existing" && nrB.normalizedRecordId === nrA.normalizedRecordId);
    check("normalized count == 1", (await countNormalized(pool)) === 1);

    // update_latest → record 교체
    const nrU = await withTenantTx(pool, TENANT, (c) =>
      normalizeRecord(c, { tenantId: TENANT, rawItemId: n1.rawItemId, schemaRef: SCHEMA_REF, naturalKey: "nk1", record: { v: 9 }, dedupAction: "update_latest" }));
    check("update_latest → same row, action update_latest", nrU.action === "update_latest" && nrU.normalizedRecordId === nrA.normalizedRecordId);
    const recAfterUpdate = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ record: { v: number } }>(`SELECT record FROM normalized_records WHERE id=$1::uuid`, [nrA.normalizedRecordId]);
      return r.rows[0]!.record.v;
    });
    check("update_latest replaced record (v=9)", recAfterUpdate === 9);

    // merge → shallow 병합(신규 우선)
    const nrM = await withTenantTx(pool, TENANT, (c) =>
      normalizeRecord(c, { tenantId: TENANT, rawItemId: n1.rawItemId, schemaRef: SCHEMA_REF, naturalKey: "nk1", record: { extra: true }, dedupAction: "merge" }));
    check("merge → same row, action merge", nrM.action === "merge");
    const merged = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ record: { v?: number; extra?: boolean } }>(`SELECT record FROM normalized_records WHERE id=$1::uuid`, [nrA.normalizedRecordId]);
      return r.rows[0]!.record;
    });
    check("merge kept v=9 + added extra", merged.v === 9 && merged.extra === true);

    // 재처리 멱등: insert 재호출 → keep_existing, 행 수 불변
    const nrReproc = await withTenantTx(pool, TENANT, (c) =>
      normalizeRecord(c, { tenantId: TENANT, rawItemId: r1.rawItemId, schemaRef: SCHEMA_REF, naturalKey: "nk1", record: { v: 1 }, dedupAction: "insert" }));
    check("reprocess insert → keep_existing idempotent", nrReproc.action === "keep_existing" && (await countNormalized(pool)) === 1);

    // C) pipeline.stage.completed
    const ev = await withTenantTx(pool, TENANT, (c) =>
      emitPipelineStageCompleted(c, { tenantId: TENANT, correlationId: CORR, idempotencyKey: "pr1:normalize:stage" }));
    check("stage event type", ev.eventType === "pipeline.stage.completed");
    check("stage event schema_ref", ev.payloadSchemaRef === "events/pipeline.stage.completed@1");
    const evRow = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ payload: unknown; event_type: string }>(`SELECT payload, event_type FROM events_outbox WHERE event_id=$1::uuid`, [ev.eventId]);
      return r.rows[0]!;
    });
    check("stage event closed-empty payload", JSON.stringify(evRow.payload) === "{}");

    // 동일 멱등키 재발행 → UNIQUE(tenant_id, idempotency_key) 차단(throw)
    let dupThrew = false;
    try {
      await withTenantTx(pool, TENANT, (c) =>
        emitPipelineStageCompleted(c, { tenantId: TENANT, correlationId: CORR, idempotencyKey: "pr1:normalize:stage" }));
    } catch {
      dupThrew = true;
    }
    check("duplicate stage emit blocked by UNIQUE", dupThrew);
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D6 pipeline (raw-ingest + normalize + stage event) integration green");
  process.exit(0);
}

main().catch((e) => {
  console.error("int fatal:", e);
  process.exit(1);
});
