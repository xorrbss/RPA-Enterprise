/**
 * raw_items → normalized_records 정규화 (D6 — db/migration_concurrency_idempotency.sql).
 *
 * `UNIQUE (tenant_id, schema_ref, natural_key)` 자연키 dedup. 동일 자연키 충돌은 dedup_action으로 해소:
 *  - insert        : 신규 영속(충돌 시 멱등 흡수 → keep_existing로 보고, 행 중복 안 만듦)
 *  - keep_existing : 기존 행 유지(DO NOTHING)
 *  - update_latest : 최신 record로 교체(DO UPDATE)
 *  - merge         : 기존 || 신규 shallow jsonb 병합(신규 우선) — v1 결정형 병합 의미(문서화)
 *
 * 재처리(같은 pipeline_run_id 라운드)는 자연키 UNIQUE에 멱등 — 중복 normalized 행을 만들지 않는다.
 * raw→record 매핑·natural_key 산출은 커넥터/시나리오 설정(순수 입력)이며 본 함수는 dedup만 책임진다.
 * "조용한 unknown 금지": 충돌인데 자연키로 기존 행을 못 찾으면 throw.
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import {
  EVENTS_OUTBOX_RETENTION_POLICY,
  emitOutboxEvent,
  type EmittedEvent,
} from "../outbox";

export type DedupAction = "insert" | "keep_existing" | "update_latest" | "merge";

export interface NormalizeInput {
  readonly tenantId: string;
  readonly rawItemId: string;
  readonly schemaRef: string;
  readonly naturalKey: string;
  readonly record: unknown;
  /** 기본 true(마스킹 적용). normalized_records.masked. */
  readonly masked?: boolean;
  readonly dedupAction: DedupAction;
  readonly retentionUntil?: Date | null;
}

export interface NormalizeResult {
  readonly normalizedRecordId: string;
  /** 실제로 수행된 동작(신규 영속이면 insert, 충돌 해소면 선언된 action). */
  readonly action: DedupAction;
}

export async function normalizeRecord(client: PoolClient, input: NormalizeInput): Promise<NormalizeResult> {
  const masked = input.masked ?? true;
  const insertCols = [
    randomUUID(),
    input.tenantId,
    input.rawItemId,
    input.schemaRef,
    input.naturalKey,
    JSON.stringify(input.record),
    masked,
    input.retentionUntil ?? null,
  ];

  if (input.dedupAction === "update_latest" || input.dedupAction === "merge") {
    const setRecord =
      input.dedupAction === "merge"
        ? "normalized_records.record || excluded.record" // shallow merge, 신규 우선
        : "excluded.record";
    const res = await client.query<{ id: string; updated: boolean }>(
      `INSERT INTO normalized_records
         (id, tenant_id, raw_item_id, schema_ref, natural_key, record, masked, retention_until, dedup_action)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb,$7,$8::timestamptz,'insert')
       ON CONFLICT (tenant_id, schema_ref, natural_key) DO UPDATE
         SET record = ${setRecord},
             raw_item_id = excluded.raw_item_id,
             masked = excluded.masked,
             dedup_action = $9
       RETURNING id, (xmax <> 0) AS updated`,
      [...insertCols, input.dedupAction],
    );
    const row = res.rows[0]!;
    // xmax<>0 = 충돌로 UPDATE된 행. 신규 INSERT면 dedup_action='insert'로 보고.
    return { normalizedRecordId: row.id, action: row.updated ? input.dedupAction : "insert" };
  }

  // insert / keep_existing → DO NOTHING(멱등 흡수)
  const ins = await client.query<{ id: string }>(
    `INSERT INTO normalized_records
       (id, tenant_id, raw_item_id, schema_ref, natural_key, record, masked, retention_until, dedup_action)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb,$7,$8::timestamptz,'insert')
     ON CONFLICT (tenant_id, schema_ref, natural_key) DO NOTHING
     RETURNING id`,
    insertCols,
  );
  if (ins.rowCount === 1) {
    return { normalizedRecordId: ins.rows[0]!.id, action: "insert" };
  }
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM normalized_records WHERE tenant_id=$1::uuid AND schema_ref=$2 AND natural_key=$3`,
    [input.tenantId, input.schemaRef, input.naturalKey],
  );
  const existingId = existing.rows[0]?.id;
  if (existingId === undefined) {
    throw new Error("normalizeRecord: ON CONFLICT but natural key not found (unexpected)");
  }
  return { normalizedRecordId: existingId, action: "keep_existing" };
}

export interface PipelineStageCompletedEmit {
  readonly tenantId: string;
  readonly correlationId: string;
  readonly runId?: string;
  /** 스테이지 경계 멱등키(예: `${pipelineRunId}:normalize:stage`). UNIQUE(tenant,idempotency_key) dedup. */
  readonly idempotencyKey: string;
  readonly occurredAt?: Date;
}

/** pipeline.stage.completed 발행(닫힌 빈 payload, run-less 가능). 스테이지 경계에서 호출측이 1회 호출. */
export async function emitPipelineStageCompleted(
  client: PoolClient,
  e: PipelineStageCompletedEmit,
): Promise<EmittedEvent> {
  return emitOutboxEvent(client, {
    tenantId: e.tenantId,
    eventType: "pipeline.stage.completed",
    correlationId: e.correlationId,
    runId: e.runId,
    idempotencyKey: e.idempotencyKey,
    occurredAt: e.occurredAt,
    retentionPolicy: EVENTS_OUTBOX_RETENTION_POLICY,
  });
}
