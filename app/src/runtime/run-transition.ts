/**
 * DB 연결 Run 전이 런타임 (D2 — state-machine.md §4 구현측).
 *
 * 책임 경계(transitions.ts 주석): 전이 로직(순수 함수)은 codegen이, **DB 반영(CAS UPDATE +
 * 동일 트랜잭션 outbox)**은 런타임이 담당한다. 본 모듈이 그 런타임이다.
 *
 * 계약:
 *  - state-machine.md §4: 모든 전이의 DB 반영은 `UPDATE ... WHERE id=? AND status=<cur>`(CAS).
 *    0 rows면 경합 → 재조회(silent no-op 금지).
 *  - architecture.md §4 / README §결정2: 상태 변경과 이벤트 발행은 **동일 트랜잭션 outbox**.
 *  - release-decisions.md #2: `events/{event_type}@1` payload body는 v1에서 닫힌 빈 객체(`{}`);
 *    식별/상관은 envelope 필드(correlation_id/run_id/ordering_key 등)로 유지.
 *  - "조용한 false 금지": 전이가 만든 sideEffect 중 DB 외 명령(브라우저 drain·SSE close·
 *    human_task 생성 등 후속 단계 dispatcher 소관)은 **버리지 않고** `pending`으로 반환한다.
 *
 * 본 모듈은 호출측(Worker 잡)이 트랜잭션과 테넌트 바인딩을 이미 연 client를 받는다(db/pool.ts).
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { transitionRun } from "../../../codegen/transitions";
import { EVENT_PAYLOAD_SCHEMA_REFS } from "../../../codegen/event-payload-registry";
import type {
  RunState,
  RunEvent,
  RunGuard,
  SideEffectCmd,
  EventEnvelopeType,
} from "../../../ts/state-machine-types";

/** state-machine.md §1: Run 종결 상태 — 진입 시 ended_at 확정. */
const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "completed",
  "cancelled",
  "failed_business",
  "failed_system",
]);

export interface RunTransitionContext {
  readonly tenantId: string;
  readonly runId: string;
  /** CAS 기대 현재 상태(state-machine §4). 0 rows면 경합으로 판정. */
  readonly fromStatus: RunState;
  readonly event: RunEvent;
  readonly guard: RunGuard;
  /** envelope 상관키(runs.correlation_id와 일치해야 함). */
  readonly correlationId: string;
  /** setField run.worker_id(R1/R17)에 쓸 worker. 해당 sideEffect가 있으면 필수. */
  readonly workerId?: string;
  /**
   * outbox idempotency_key 앵커(소비자 멱등). 동일 전이의 재실행은 동일 키를 만들어
   * `UNIQUE(tenant_id, idempotency_key)`로 중복 인큐를 차단한다(랜덤 금지).
   * 미지정 시 `${runId}` 사용(run-once 생명주기 이벤트 기준). 다중 이벤트는 eventType으로 접미.
   */
  readonly eventIdempotencyKey?: string;
  /** 결정론/테스트용 발생 시각 주입. 미지정 시 DB now(). */
  readonly occurredAt?: Date;
}

export interface EmittedEvent {
  readonly eventId: string;
  readonly eventType: EventEnvelopeType;
  readonly idempotencyKey: string;
  readonly payloadSchemaRef: string;
}

export type RunTransitionOutcome =
  | {
      readonly applied: true;
      readonly next: RunState;
      /** outbox에 INSERT된 이벤트(동일 트랜잭션). */
      readonly emitted: readonly EmittedEvent[];
      /** DB 외 후속 명령(다음 단계 dispatcher 소관) — 버리지 않고 반환. */
      readonly pending: readonly SideEffectCmd[];
    }
  | {
      readonly applied: false;
      readonly reason: "cas_conflict";
      /** 경합으로 재조회한 실제 현재 상태(없으면 row 부재). */
      readonly observed: RunState | null;
    };

/**
 * Run 전이를 DB에 반영한다(CAS UPDATE + 동일 트랜잭션 outbox).
 *
 * 정의되지 않은 (상태,이벤트) 조합은 transitionRun이 `IllegalTransition`을 throw한다(여기서 흡수 안 함).
 */
export async function applyRunTransition(
  client: PoolClient,
  ctx: RunTransitionContext,
): Promise<RunTransitionOutcome> {
  // 1) 순수 전이 계산(codegen). 미정의 조합은 IllegalTransition throw.
  const { next, sideEffects } = transitionRun(ctx.fromStatus, ctx.event, ctx.guard);

  // 2) sideEffect를 DB 반영분과 후속 명령으로 분리.
  const setsWorkerId = sideEffects.some(
    (s) => s.kind === "setField" && s.entity === "run" && s.field === "worker_id",
  );
  const requeue = sideEffects.some((s) => s.kind === "requeue");
  const emitEvents = sideEffects.filter(
    (s): s is Extract<SideEffectCmd, { kind: "emitEvent" }> => s.kind === "emitEvent",
  );
  // DB 반영 종류(emitEvent/setField worker_id/requeue) 외 전부 후속 dispatcher 명령.
  const pending = sideEffects.filter(
    (s) =>
      s.kind !== "emitEvent" &&
      s.kind !== "requeue" &&
      !(s.kind === "setField" && s.entity === "run" && s.field === "worker_id"),
  );

  if (setsWorkerId && ctx.workerId === undefined) {
    // 가정 금지: worker_id를 set해야 하는 전이인데 worker가 없으면 진행 불가.
    throw new Error(
      `applyRunTransition: transition ${ctx.fromStatus}->${next} requires workerId but none was provided`,
    );
  }

  const enteringRunningFromClaimed = next === "running" && ctx.fromStatus === "claimed"; // R2: started_at
  const enteringTerminal = TERMINAL_RUN_STATES.has(next);

  // 3) CAS UPDATE. WHERE status=<fromStatus>로 경합 방지. 0 rows면 재조회.
  const updated = await client.query<{ status: RunState }>(
    `UPDATE runs
        SET status     = $1,
            updated_at = now(),
            worker_id  = CASE WHEN $2::boolean THEN $3::uuid ELSE worker_id END,
            attempts   = attempts + CASE WHEN $4::boolean THEN 1 ELSE 0 END,
            started_at = CASE WHEN $5::boolean THEN now() ELSE started_at END,
            ended_at   = CASE WHEN $6::boolean THEN now() ELSE ended_at END
      WHERE id = $7::uuid AND tenant_id = $8::uuid AND status = $9
    RETURNING status`,
    [
      next,
      setsWorkerId,
      ctx.workerId ?? null,
      requeue,
      enteringRunningFromClaimed,
      enteringTerminal,
      ctx.runId,
      ctx.tenantId,
      ctx.fromStatus,
    ],
  );

  if (updated.rowCount === 0) {
    // 경합: 다른 워커가 이미 상태를 바꿨거나 row 부재. 실제 상태 재조회(silent no-op 금지).
    const observed = await client.query<{ status: RunState }>(
      `SELECT status FROM runs WHERE id = $1::uuid AND tenant_id = $2::uuid`,
      [ctx.runId, ctx.tenantId],
    );
    return {
      applied: false,
      reason: "cas_conflict",
      observed: observed.rows[0]?.status ?? null,
    };
  }

  // 4) emitEvent → events_outbox INSERT(동일 트랜잭션).
  const anchor = ctx.eventIdempotencyKey ?? ctx.runId;
  const emitted: EmittedEvent[] = [];
  for (const cmd of emitEvents) {
    const eventType = cmd.event;
    // EventEnvelopeType ⊋ EventType: worker.*(인프라 텔레메트리)는 레지스트리/outbox 키 밖.
    // 전이는 worker.*를 emit하지 않지만 인덱싱은 방어적으로 — 부재 시 조용히 null 넣지 않고 throw.
    const refs: Readonly<Record<string, string | undefined>> = EVENT_PAYLOAD_SCHEMA_REFS;
    const payloadSchemaRef = refs[eventType];
    if (payloadSchemaRef === undefined) {
      throw new Error(`applyRunTransition: no payload_schema_ref for event_type ${eventType}`);
    }
    const eventId = randomUUID();
    const idempotencyKey = `${anchor}:${eventType}`;
    await client.query(
      `INSERT INTO events_outbox
         (event_id, event_type, event_version, tenant_id, run_id,
          correlation_id, ordering_key, occurred_at, idempotency_key, payload_schema_ref, payload)
       VALUES ($1::uuid, $2, 1, $3::uuid, $4::uuid,
               $5::uuid, $6, COALESCE($7::timestamptz, now()), $8, $9, '{}'::jsonb)`,
      [
        eventId,
        eventType,
        ctx.tenantId,
        ctx.runId,
        ctx.correlationId,
        ctx.runId, // ordering_key 기본 = run_id (events_outbox DDL)
        ctx.occurredAt ?? null,
        idempotencyKey,
        payloadSchemaRef,
      ],
    );
    emitted.push({ eventId, eventType, idempotencyKey, payloadSchemaRef });
  }

  return { applied: true, next, emitted, pending };
}
