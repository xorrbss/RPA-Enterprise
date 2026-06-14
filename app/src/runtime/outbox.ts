/**
 * events_outbox 발행 헬퍼 (D2 — 상태변경과 동일 트랜잭션).
 *
 * 계약:
 *  - schema/event-envelope.schema.json + db/migration_core_entities.sql events_outbox:
 *    event_id/event_type/event_version/tenant_id/correlation_id/occurred_at/idempotency_key/
 *    payload_schema_ref/payload 필수. run_id/workitem_id/step_id는 옵셔널(run-less 이벤트 허용).
 *  - release-decisions.md #2: payload body는 v1에서 닫힌 빈 객체(`{}`).
 *  - release-decisions.md #12: worker.*는 tenant outbox 밖(EventType 레지스트리 제외) — 부재 시 throw.
 *  - UNIQUE(tenant_id, idempotency_key): 동일 키 재발행은 소비자 멱등으로 차단.
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { EVENT_PAYLOAD_SCHEMA_REFS } from "../../../codegen/event-payload-registry";
import type { EventEnvelopeType } from "../../../ts/state-machine-types";

export interface EmittedEvent {
  readonly eventId: string;
  readonly eventType: EventEnvelopeType;
  readonly idempotencyKey: string;
  readonly payloadSchemaRef: string;
}

export interface OutboxEmit {
  readonly tenantId: string;
  readonly eventType: EventEnvelopeType;
  readonly correlationId: string;
  readonly runId?: string;
  readonly workitemId?: string;
  readonly idempotencyKey: string;
  readonly occurredAt?: Date;
}

// TODO: [BLOCKED]
//   Required decision: Contract/runtime owners must define the repo-owned events_outbox retention duration/source for emitOutboxEvent before the app-runtime delta can claim staging readiness.
//   required_change: once decided, emitOutboxEvent must set events_outbox.retention_until from that source or fail closed instead of persisting an unknown retention boundary.

/** outbox 행 1건 INSERT(호출측 트랜잭션 내). payload는 닫힌 빈 객체. */
export async function emitOutboxEvent(client: PoolClient, e: OutboxEmit): Promise<EmittedEvent> {
  // EventEnvelopeType ⊋ EventType: 닫힌 레지스트리 밖(worker.*)이면 조용히 null 넣지 않고 throw.
  const refs: Readonly<Record<string, string | undefined>> = EVENT_PAYLOAD_SCHEMA_REFS;
  const payloadSchemaRef = refs[e.eventType];
  if (payloadSchemaRef === undefined) {
    throw new Error(`emitOutboxEvent: no payload_schema_ref for event_type ${e.eventType}`);
  }
  const eventId = randomUUID();
  await client.query(
    `INSERT INTO events_outbox
       (event_id, event_type, event_version, tenant_id, run_id, workitem_id,
        correlation_id, ordering_key, occurred_at, idempotency_key, payload_schema_ref, payload)
     VALUES ($1::uuid, $2, 1, $3::uuid, $4::uuid, $5::uuid,
             $6::uuid, $7, COALESCE($8::timestamptz, now()), $9, $10, '{}'::jsonb)`,
    [
      eventId,
      e.eventType,
      e.tenantId,
      e.runId ?? null,
      e.workitemId ?? null,
      e.correlationId,
      e.runId ?? e.workitemId ?? null, // ordering_key 기본 = run_id(없으면 workitem_id)
      e.occurredAt ?? null,
      e.idempotencyKey,
      payloadSchemaRef,
    ],
  );
  return { eventId, eventType: e.eventType, idempotencyKey: e.idempotencyKey, payloadSchemaRef };
}
