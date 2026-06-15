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
  readonly retentionUntil: Date;
}

export interface EventsOutboxRetentionPolicy {
  readonly source: "ops-defaults.md#events_outbox.retention_default";
  readonly durationSeconds: number;
}

const SECONDS_PER_DAY = 24 * 60 * 60;

export const EVENTS_OUTBOX_RETENTION_POLICY: EventsOutboxRetentionPolicy = Object.freeze({
  source: "ops-defaults.md#events_outbox.retention_default",
  durationSeconds: 90 * SECONDS_PER_DAY,
});

export interface OutboxEmit {
  readonly tenantId: string;
  readonly eventType: EventEnvelopeType;
  readonly correlationId: string;
  readonly runId?: string;
  readonly workitemId?: string;
  readonly stepId?: string;
  readonly attempt?: number;
  readonly idempotencyKey: string;
  readonly occurredAt?: Date;
  readonly retentionPolicy: EventsOutboxRetentionPolicy;
}


/** outbox 행 1건 INSERT(호출측 트랜잭션 내). payload는 닫힌 빈 객체. */
export async function emitOutboxEvent(client: PoolClient, e: OutboxEmit): Promise<EmittedEvent> {
  // EventEnvelopeType ⊋ EventType: 닫힌 레지스트리 밖(worker.*)이면 조용히 null 넣지 않고 throw.
  const refs: Readonly<Record<string, string | undefined>> = EVENT_PAYLOAD_SCHEMA_REFS;
  const payloadSchemaRef = refs[e.eventType];
  if (payloadSchemaRef === undefined) {
    throw new Error(`emitOutboxEvent: no payload_schema_ref for event_type ${e.eventType}`);
  }
  validateStepReference(e);
  const retentionDurationSeconds = validateEventsOutboxRetentionPolicy(e.retentionPolicy);
  const eventId = randomUUID();
  const inserted = await client.query<{ retention_until: Date }>(
    `INSERT INTO events_outbox
       (event_id, event_type, event_version, tenant_id, run_id, workitem_id, step_id, attempt,
        correlation_id, ordering_key, occurred_at, idempotency_key, payload_schema_ref, payload,
        retention_until)
     VALUES ($1::uuid, $2, 1, $3::uuid, $4::uuid, $5::uuid, $6, $7::int,
             $8::uuid, $9, COALESCE($10::timestamptz, now()), $11, $12, '{}'::jsonb,
             now() + ($13::double precision * interval '1 second'))
     RETURNING retention_until`,
    [
      eventId,
      e.eventType,
      e.tenantId,
      e.runId ?? null,
      e.workitemId ?? null,
      e.stepId ?? null,
      e.attempt ?? null,
      e.correlationId,
      e.runId ?? e.workitemId ?? null, // ordering_key 기본 = run_id(없으면 workitem_id)
      e.occurredAt ?? null,
      e.idempotencyKey,
      payloadSchemaRef,
      retentionDurationSeconds,
    ],
  );
  const retentionUntil = inserted.rows[0]?.retention_until;
  if (retentionUntil === undefined) {
    throw new Error("emitOutboxEvent: insert did not return retention_until");
  }
  return { eventId, eventType: e.eventType, idempotencyKey: e.idempotencyKey, payloadSchemaRef, retentionUntil };
}

function validateStepReference(e: OutboxEmit): void {
  const hasAnyStepRef = e.stepId !== undefined || e.attempt !== undefined;
  if (e.eventType.startsWith("step.")) {
    if (
      e.runId === undefined ||
      typeof e.stepId !== "string" ||
      e.stepId.trim().length === 0 ||
      !Number.isInteger(e.attempt) ||
      (e.attempt ?? -1) < 0
    ) {
      throw new Error(`emitOutboxEvent: ${e.eventType} requires runId, stepId, and non-negative integer attempt`);
    }
    return;
  }
  if (hasAnyStepRef) {
    if (
      e.runId === undefined ||
      typeof e.stepId !== "string" ||
      e.stepId.trim().length === 0 ||
      !Number.isInteger(e.attempt) ||
      (e.attempt ?? -1) < 0
    ) {
      throw new Error("emitOutboxEvent: step reference requires runId, stepId, and non-negative integer attempt");
    }
  }
}

function validateEventsOutboxRetentionPolicy(policy: EventsOutboxRetentionPolicy | undefined): number {
  if (policy === undefined) {
    throw new Error("emitOutboxEvent: retentionPolicy is required for events_outbox.retention_until");
  }
  if (policy.source !== EVENTS_OUTBOX_RETENTION_POLICY.source) {
    throw new Error(`emitOutboxEvent: unsupported retention policy source ${String(policy.source)}`);
  }
  if (!Number.isFinite(policy.durationSeconds) || policy.durationSeconds <= 0) {
    throw new Error("emitOutboxEvent: retention policy durationSeconds must be a positive finite number");
  }
  return policy.durationSeconds;
}
