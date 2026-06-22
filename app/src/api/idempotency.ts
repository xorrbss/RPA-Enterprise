/**
 * 제어평면 멱등 스토어 (D4.3 — control_plane_idempotency_keys + release-decisions #7).
 *
 * 계약:
 *  - api-surface §0.4: 부작용 명령형 POST는 (tenant_id, endpoint, Idempotency-Key)로 최초 결과를 보관하고,
 *    동일 키 재제출 시 부작용 재실행 없이 최초 응답을 반환한다.
 *  - release-decisions #7: request_hash mismatch→SCENARIO_VERSION_CONFLICT(412), in-flight→
 *    WORKITEM_CHECKOUT_CONFLICT(409, retryable). (missing key→IR_SCHEMA_INVALID/422는 핸들러측 선검사.)
 *  - db/migration_core_entities.sql control_plane_idempotency_keys: UNIQUE(tenant_id, endpoint, idempotency_key),
 *    status(processing|succeeded|failed), response_status/response_body 영속.
 *  - ts/control-plane-contract.ts ControlPlaneIdempotencyStore를 구현.
 *
 * 예약은 독립 트랜잭션으로 커밋해 'processing'을 동시 요청에 가시화한다(in-flight 409 판정 근거). 작업은
 * 별도 트랜잭션(실패해도 예약은 남아 saveFailure로 표시). recordId는 `${tenantId}:${rowId}`로 인코딩 —
 * saveResult/saveFailure가 RLS 바인딩에 필요한 tenant를 복원한다(컨트랙트 recordId는 불투명 문자열).
 */
import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type {
  ControlPlaneIdempotencyStore,
  IdempotencyReservation,
  IdempotencyReservationRequest,
  StoredIdempotentResponse,
} from "../../../ts/control-plane-contract";
import { ERROR_CATALOG, type ApiError } from "../../../ts/error-catalog";
import { withTenantTx } from "../db/pool";

/** canonical request hash(method+path+body, 정렬 직렬화). 동일 Idempotency-Key의 본문 변조(#7)를 탐지. */
export function canonicalRequestHash(method: string, path: string, body: unknown): string {
  return createHash("sha256").update(stableStringify({ method, path, body: body ?? null })).digest("hex");
}

interface IdempotencyRow {
  id: string;
  request_hash: string;
  status: "processing" | "succeeded" | "failed";
  response_status: number | null;
  response_body: unknown;
}

export class PgControlPlaneIdempotencyStore implements ControlPlaneIdempotencyStore {
  constructor(private readonly pool: Pool) {}

  async reserve(req: IdempotencyReservationRequest): Promise<IdempotencyReservation> {
    return withTenantTx(this.pool, req.tenantId, async (c) => {
      const rowId = randomUUID();
      const inserted = await c.query<{ id: string }>(
        `INSERT INTO control_plane_idempotency_keys
           (id, tenant_id, endpoint, idempotency_key, request_hash, status, expires_at, retention_until)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'processing', $6::timestamptz, $6::timestamptz)
         ON CONFLICT (tenant_id, endpoint, idempotency_key) DO NOTHING
         RETURNING id`,
        [rowId, req.tenantId, req.endpoint, req.key, req.requestHash, req.expiresAt],
      );
      if (inserted.rowCount === 1) {
        return { kind: "reserved", recordId: encodeRecordId(req.tenantId, rowId) };
      }
      // 충돌(UNIQUE) → 기존 레코드로 분기.
      const existing = await c.query<IdempotencyRow>(
        `SELECT id, request_hash, status, response_status, response_body
           FROM control_plane_idempotency_keys
          WHERE tenant_id=$1::uuid AND endpoint=$2 AND idempotency_key=$3`,
        [req.tenantId, req.endpoint, req.key],
      );
      const row = existing.rows[0];
      if (row === undefined) {
        // 드문 경합(만료 정리로 행 소멸). 조용한 통과 금지 — 재시도 가능 충돌로 표면화.
        return { kind: "in_flight", recordId: encodeRecordId(req.tenantId, rowId), status: "processing" };
      }
      if (row.request_hash !== req.requestHash) {
        return { kind: "blocked", reason: "request_hash_mismatch" };
      }
      if (row.status === "processing") {
        const reclaimed = await c.query<{ id: string }>(
          `UPDATE control_plane_idempotency_keys
              SET expires_at=$1::timestamptz, retention_until=$1::timestamptz, updated_at=now()
            WHERE tenant_id=$2::uuid
              AND id=$3::uuid
              AND status='processing'
              AND request_hash=$4
              AND expires_at <= now()
            RETURNING id`,
          [req.expiresAt, req.tenantId, row.id, req.requestHash],
        );
        if (reclaimed.rowCount === 1) {
          return { kind: "reserved", recordId: encodeRecordId(req.tenantId, row.id) };
        }
        return { kind: "in_flight", recordId: encodeRecordId(req.tenantId, row.id), status: "processing" };
      }
      // succeeded/failed → 저장된 최초 응답 재생(부작용 재실행 없음).
      if (row.response_status === null || row.response_body === null) {
        throw new Error(`idempotency record ${row.id} is ${row.status} without stored response`);
      }
      return { kind: "replay", response: { status: row.response_status, body: row.response_body } };
    });
  }

  async saveResult(recordId: string, response: StoredIdempotentResponse): Promise<void> {
    const { tenantId } = decodeRecordId(recordId);
    await withTenantTx(this.pool, tenantId, (c) => completeIdempotencyInTx(c, recordId, response));
  }

  async saveFailure(recordId: string, error: ApiError): Promise<void> {
    const { tenantId, rowId } = decodeRecordId(recordId);
    const httpStatus = ERROR_CATALOG[error.code].httpStatus;
    await withTenantTx(this.pool, tenantId, async (c) => {
      const updated = await c.query(
        `UPDATE control_plane_idempotency_keys
            SET status='failed', response_status=$1, response_body=$2::jsonb, updated_at=now()
          WHERE tenant_id=$3::uuid AND id=$4::uuid AND status='processing'
          RETURNING id`,
        [httpStatus, JSON.stringify(error), tenantId, rowId],
      );
      if (updated.rowCount !== 1) {
        throw new Error(`idempotency failure update expected 1 processing row, got ${updated.rowCount ?? 0}`);
      }
    });
  }

  // 일시적 버전 충돌(IFM-1)로 끝난 예약 회수 — processing 행만 삭제(이미 succeeded/failed 면 보존). 멱등(0행 무해).
  async release(recordId: string): Promise<void> {
    const { tenantId, rowId } = decodeRecordId(recordId);
    await withTenantTx(this.pool, tenantId, async (c) => {
      await c.query(
        `DELETE FROM control_plane_idempotency_keys WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='processing'`,
        [tenantId, rowId],
      );
    });
  }
}

/**
 * 멱등 레코드를 'succeeded'로 갱신(제공된 client = 호출측 트랜잭션에서 실행). run create는 작업(runs INSERT·
 * outbox·enqueue)과 동일 tx에서 호출해 부작용 커밋과 성공 기록을 원자화한다(별도 tx 불일치 창 제거).
 * tenant 바인딩은 호출측 tx가 이미 수행(RLS).
 */
export async function completeIdempotencyInTx(
  client: PoolClient,
  recordId: string,
  response: StoredIdempotentResponse,
): Promise<void> {
  const { tenantId, rowId } = decodeRecordId(recordId);
  const updated = await client.query(
    `UPDATE control_plane_idempotency_keys
        SET status='succeeded', response_status=$1, response_body=$2::jsonb, updated_at=now()
      WHERE tenant_id=$3::uuid AND id=$4::uuid AND status='processing'
      RETURNING id`,
    [response.status, JSON.stringify(response.body ?? null), tenantId, rowId],
  );
  if (updated.rowCount !== 1) {
    throw new Error(`idempotency success update expected 1 processing row, got ${updated.rowCount ?? 0}`);
  }
}

export function idempotencyRecordRowId(recordId: string): string {
  return decodeRecordId(recordId).rowId;
}

function encodeRecordId(tenantId: string, rowId: string): string {
  return `${tenantId}:${rowId}`;
}

function decodeRecordId(recordId: string): { tenantId: string; rowId: string } {
  const idx = recordId.indexOf(":");
  if (idx < 0) throw new Error(`invalid idempotency recordId: ${recordId}`);
  return { tenantId: recordId.slice(0, idx), rowId: recordId.slice(idx + 1) };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
    .join(",")}}`;
}
