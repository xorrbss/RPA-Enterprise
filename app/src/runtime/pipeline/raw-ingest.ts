/**
 * raw_items 멱등 인입 (D6 — db/migration_concurrency_idempotency.sql #11, §9 파이프라인).
 *
 * 기본 정책 dedup_by_hash: `UNIQUE NULLS NOT DISTINCT (tenant_id, connector_id, target_id,
 * source_item_key, raw_hash)` 위에 `INSERT ... ON CONFLICT DO NOTHING`. 동일 내용 재수집은
 * 0행으로 흡수(에러 아님 — 재시도/replay 멱등). 0행이면 기존 행 id를 조회해 반환.
 *
 * raw_hash는 raw-hash.ts(FIX#6 canonicalization). 커서 커밋은 raw 영속 직후 호출측 트랜잭션에서
 * 수행한다(§9: cursor commit은 raw 영속화 성공 직후). 본 함수는 raw 영속만 책임진다.
 *
 * "조용한 false/unknown 금지": conflict인데 dedup 키로 기존 행을 못 찾으면 throw(다른 unique 정책
 * 적용 등 비정상 상태를 흘리지 않는다). DB 영속 실패는 호출측(worker)이 RAW_PERSIST_FAILED로 매핑.
 *
 * (tenant_id, connector_id, target_id)는 connector target 자연키(Decision v1) — FK 없음. raw_payload·
 * source_item_key·collection_attempt_id의 생산자(connector/extractor)는 D6 범위 밖이며 입력으로 받는다.
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { SPAN, withSpan } from "../../observability/telemetry";
import { computeRawHash } from "./raw-hash";

export interface RawIngestInput {
  readonly tenantId: string;
  readonly connectorId: string;
  readonly targetId: string;
  readonly sourceItemKey?: string | null;
  readonly sourcePageKey?: string | null;
  readonly collectionAttemptId: string;
  readonly rawPayload: unknown;
  /** 커넥터 설정상 휘발 필드(이름 기준 재귀 제외). raw_hash 산출에서 제외. */
  readonly volatileFields?: readonly string[];
  readonly collectTier?: string | null;
  readonly pipelineRunId?: string | null;
  /** inline retention(release-decisions #5). 미지정 시 NULL(보존정책 미산출 — sweeper 대상 아님). */
  readonly retentionUntil?: Date | null;
  readonly correlationId: string;
}

export interface RawIngestResult {
  readonly rawItemId: string;
  readonly rawHash: string;
  /** true = 이번 호출이 INSERT(신규 영속), false = 동일 (item, hash) 이미 존재(dedup 흡수). */
  readonly persisted: boolean;
}

export async function ingestRawItem(client: PoolClient, input: RawIngestInput): Promise<RawIngestResult> {
  const rawHash = computeRawHash(input.rawPayload, input.volatileFields);
  return withSpan(
    SPAN.pipelineRawPersist,
    { tenant_id: input.tenantId, correlation_id: input.correlationId },
    { connector_id: input.connectorId, target_id: input.targetId },
    async () => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO raw_items
           (id, tenant_id, connector_id, target_id, source_item_key, source_page_key,
            collection_attempt_id, raw_hash, raw_payload, retention_until, collect_tier, pipeline_run_id)
         VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5,$6,$7::uuid,$8,$9::jsonb,$10::timestamptz,$11,$12::uuid)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          randomUUID(),
          input.tenantId,
          input.connectorId,
          input.targetId,
          input.sourceItemKey ?? null,
          input.sourcePageKey ?? null,
          input.collectionAttemptId,
          rawHash,
          JSON.stringify(input.rawPayload),
          input.retentionUntil ?? null,
          input.collectTier ?? null,
          input.pipelineRunId ?? null,
        ],
      );
      if (inserted.rowCount === 1) {
        return { rawItemId: inserted.rows[0]!.id, rawHash, persisted: true };
      }
      // dedup 흡수: 동일 dedup 키가 이미 존재. NULLS NOT DISTINCT이므로 NULL source_item_key도 매칭.
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM raw_items
          WHERE tenant_id=$1::uuid AND connector_id=$2 AND target_id=$3::uuid
            AND source_item_key IS NOT DISTINCT FROM $4 AND raw_hash=$5`,
        [input.tenantId, input.connectorId, input.targetId, input.sourceItemKey ?? null, rawHash],
      );
      const existingId = existing.rows[0]?.id;
      if (existingId === undefined) {
        throw new Error("ingestRawItem: ON CONFLICT but no row matched dedup key (unexpected unique policy)");
      }
      return { rawItemId: existingId, rawHash, persisted: false };
    },
  );
}
