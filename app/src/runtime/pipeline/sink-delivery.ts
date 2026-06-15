/**
 * normalized_records → 외부 sink 전달 (D6 — db/migration_concurrency_idempotency.sql sink_deliveries).
 *
 * 흐름(claim→port→finalize, artifact lifecycle와 동형):
 *  tx A: 이미 delivered면 멱등 단락 / 아니면 attempt_no = MAX+1 로 pending 행 INSERT
 *        (UNIQUE(normalized_record_id, sink_config_id, attempt_no)가 동시 워커를 직렬화)
 *  port: 주입형 SinkDeliveryPort.deliver()를 트랜잭션 밖에서 호출(네트워크 I/O — 실 전송은 외부 경계)
 *  tx B: status CAS pending→delivered / failed / dead_letter + sink.delivered/sink.dead_lettered 발행
 *
 * 멱등키 sink_idempotency_key = `tenant_id:sink_config_id:schema_ref:natural_key`(attempt_no 제외 —
 * 모든 attempt가 동일 키를 보내 외부가 1건으로 흡수). 상한은 SinkDeliveryPolicy(ops-defaults #sink.delivery,
 * release-decisions #14) — 코드 하드코딩 금지. attempt_no >= maxAttempts 실패 → dead_letter(SINK_DELIVERY_FAILED
 * 재시도 소진). "조용한 false/unknown 금지": CAS 0행/미지원 status는 throw로 표면화.
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { SinkDeliveryPolicy, SinkDeliveryPort } from "../../../../ts/runtime-contract";
import type { CorrelationId, TenantId } from "../../../../ts/security-middleware-contract";
import { withTenantTx, type PgPool } from "../../db/pool";
import { SPAN, withSpan } from "../../observability/telemetry";
import {
  EVENTS_OUTBOX_RETENTION_POLICY,
  emitOutboxEvent,
  type EmittedEvent,
} from "../outbox";

export interface SinkDeliveryDeps {
  readonly pool: PgPool;
  readonly port: SinkDeliveryPort;
  readonly policy: SinkDeliveryPolicy;
}

export interface DeliverInput {
  readonly tenantId: string;
  readonly normalizedRecordId: string;
  readonly sinkConfigId: string;
  readonly correlationId: string;
}

export type DeliverStatus = "delivered" | "failed" | "dead_letter" | "already_delivered";

export interface DeliverOutcome {
  readonly status: DeliverStatus;
  readonly attemptNo: number;
  readonly sinkIdempotencyKey: string;
  readonly sinkDeliveryId?: string;
  readonly emitted?: EmittedEvent;
}

/** sink_idempotency_key 규약(FIX#7). attempt_no는 의도적으로 제외. */
export function sinkIdempotencyKey(input: {
  tenantId: string;
  sinkConfigId: string;
  schemaRef: string;
  naturalKey: string;
}): string {
  return `${input.tenantId}:${input.sinkConfigId}:${input.schemaRef}:${input.naturalKey}`;
}

export async function deliverNormalizedRecord(deps: SinkDeliveryDeps, input: DeliverInput): Promise<DeliverOutcome> {
  // tx A: 멱등키 산출(권위 행에서) + 멱등 단락 + pending attempt 생성
  const claim = await withTenantTx(deps.pool, input.tenantId, async (c) => {
    // FIX#7: sink_idempotency_key는 normalized_records 행의 schema_ref/natural_key에서 산출한다 —
    // 호출 페이로드를 신뢰하면 stale/오타 잡이 같은 레코드에 다른 외부 키를 보내 다운스트림 dedup이 깨진다.
    // 행은 (tenant_id, schema_ref, natural_key) UNIQUE이므로 키는 행의 순수 함수다. 미존재면 throw(조용한 skip 금지).
    const rec = await c.query<{ schema_ref: string; natural_key: string }>(
      `SELECT schema_ref, natural_key FROM normalized_records WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [input.tenantId, input.normalizedRecordId],
    );
    const row = rec.rows[0];
    if (row === undefined) {
      throw new Error("deliverNormalizedRecord: normalized_records row not found (tenant-scoped) — cannot derive sink_idempotency_key");
    }
    const key = sinkIdempotencyKey({
      tenantId: input.tenantId,
      sinkConfigId: input.sinkConfigId,
      schemaRef: row.schema_ref,
      naturalKey: row.natural_key,
    });

    const delivered = await c.query(
      `SELECT 1 FROM sink_deliveries
        WHERE tenant_id=$1::uuid AND normalized_record_id=$2::uuid AND sink_config_id=$3::uuid AND status='delivered'
        LIMIT 1`,
      [input.tenantId, input.normalizedRecordId, input.sinkConfigId],
    );
    if (delivered.rowCount && delivered.rowCount > 0) {
      return { alreadyDelivered: true as const, key };
    }
    const next = await c.query<{ n: string }>(
      `SELECT COALESCE(MAX(attempt_no), 0) + 1 AS n FROM sink_deliveries
        WHERE tenant_id=$1::uuid AND normalized_record_id=$2::uuid AND sink_config_id=$3::uuid`,
      [input.tenantId, input.normalizedRecordId, input.sinkConfigId],
    );
    const attemptNo = Number(next.rows[0]!.n);
    const id = randomUUID();
    // UNIQUE(normalized_record_id, sink_config_id, attempt_no)가 동시 워커 직렬화(충돌 워커는 unique 위반→재시도).
    await c.query(
      `INSERT INTO sink_deliveries
         (id, tenant_id, normalized_record_id, sink_config_id, attempt_no, sink_idempotency_key, status)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::int,$6,'pending')`,
      [id, input.tenantId, input.normalizedRecordId, input.sinkConfigId, attemptNo, key],
    );
    return { alreadyDelivered: false as const, attemptNo, id, key };
  });

  const key = claim.key;
  if (claim.alreadyDelivered) {
    return { status: "already_delivered", attemptNo: 0, sinkIdempotencyKey: key };
  }

  return withSpan(
    SPAN.sinkDeliver,
    { tenant_id: input.tenantId, correlation_id: input.correlationId },
    { sink: input.sinkConfigId, attempt_no: claim.attemptNo, status: "pending" },
    async (span) => {
      // port: 트랜잭션 밖 네트워크 전송(실 전송은 외부 경계). 멱등키를 외부 Idempotency-Key로 전달.
      const decision = await deps.port.deliver({
        tenantId: input.tenantId as TenantId,
        correlationId: input.correlationId as CorrelationId,
        sinkConfigId: input.sinkConfigId,
        sinkIdempotencyKey: key,
        normalizedRecordId: input.normalizedRecordId,
        attemptNo: claim.attemptNo,
        portBinding: deps.port.binding,
      });

      // tx B: status CAS finalize + 이벤트
      const outcome = await withTenantTx(deps.pool, input.tenantId, async (c) => {
        if (decision.kind === "delivered") {
          await casFinalize(c, input.tenantId, claim.id, "delivered", decision.receiptRef ?? null);
          const emitted = await emitSinkEvent(c, "sink.delivered", input, claim.id, key);
          return { status: "delivered" as const, emitted };
        }
        // transient_failed → 상한 도달 판정
        const terminal = claim.attemptNo >= deps.policy.maxAttempts;
        if (terminal) {
          await casFinalize(c, input.tenantId, claim.id, "dead_letter", decision.reason);
          const emitted = await emitSinkEvent(c, "sink.dead_lettered", input, claim.id, key);
          return { status: "dead_letter" as const, emitted };
        }
        await casFinalize(c, input.tenantId, claim.id, "failed", decision.reason);
        return { status: "failed" as const, emitted: undefined };
      });

      span.setAttribute("status", outcome.status);
      return {
        status: outcome.status,
        attemptNo: claim.attemptNo,
        sinkIdempotencyKey: key,
        sinkDeliveryId: claim.id,
        emitted: outcome.emitted,
      };
    },
  );
}

async function casFinalize(
  client: PoolClient,
  tenantId: string,
  id: string,
  status: "delivered" | "failed" | "dead_letter",
  responseRef: string | null,
): Promise<void> {
  const res = await client.query(
    `UPDATE sink_deliveries SET status=$1, response_ref=$2
      WHERE id=$3::uuid AND tenant_id=$4::uuid AND status='pending'`,
    [status, responseRef, id, tenantId],
  );
  if (res.rowCount !== 1) {
    // 조용한 false 금지: pending이 아니면(다른 워커가 이미 종결) 표면화.
    throw new Error(`sink finalize CAS expected pending row, updated ${res.rowCount}`);
  }
}

async function emitSinkEvent(
  client: PoolClient,
  eventType: "sink.delivered" | "sink.dead_lettered",
  input: DeliverInput,
  sinkDeliveryId: string,
  key: string,
): Promise<EmittedEvent> {
  return emitOutboxEvent(client, {
    tenantId: input.tenantId,
    eventType,
    correlationId: input.correlationId,
    // sink.* 이벤트는 run-less 가능(데이터평면). 멱등키는 전달 행 단위.
    idempotencyKey: `${sinkDeliveryId}:${eventType}`,
    retentionPolicy: EVENTS_OUTBOX_RETENTION_POLICY,
  });
}

// re-export: 테스트/와이어링이 동일 경로에서 포트/정책 타입을 받도록.
export type { SinkDeliveryPort, SinkDeliveryPolicy, SinkDeliveryPortBinding } from "../../../../ts/runtime-contract";
