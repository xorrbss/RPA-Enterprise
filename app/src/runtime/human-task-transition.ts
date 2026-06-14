/**
 * DB 연결 HumanTask 전이 런타임 (D2 — state-machine.md §3 구현측).
 *
 * 주의: human_tasks의 상태 컬럼은 `state`(runs/workitems의 `status`와 다름).
 * 고유 컬럼: assignee(H1/H6 setField), resolved_at(→resolved 진입 시).
 * human_task.* 이벤트는 연관 run에 linkage(run_id)된다(human_tasks.run_id NOT NULL).
 */
import type { PoolClient } from "pg";

import { transitionHumanTask } from "../../../codegen/transitions";
import type {
  HumanTaskState,
  HumanTaskEvent,
  HumanTaskGuard,
  SideEffectCmd,
} from "../../../ts/state-machine-types";
import { EVENTS_OUTBOX_RETENTION_POLICY, emitOutboxEvent, type EmittedEvent } from "./outbox";

export interface HumanTaskTransitionContext {
  readonly tenantId: string;
  readonly humanTaskId: string;
  /** human_task.* 이벤트 linkage(human_tasks.run_id). */
  readonly runId: string;
  readonly fromState: HumanTaskState;
  readonly event: HumanTaskEvent;
  readonly guard: HumanTaskGuard;
  readonly correlationId: string;
  /** setField assignee(H1/H6)에 쓸 사용자. 해당 sideEffect가 있으면 필수. */
  readonly assignee?: string;
  readonly eventIdempotencyKey?: string;
  readonly occurredAt?: Date;
}

export type HumanTaskTransitionOutcome =
  | {
      readonly applied: true;
      readonly next: HumanTaskState;
      readonly emitted: readonly EmittedEvent[];
      readonly pending: readonly SideEffectCmd[];
    }
  | { readonly applied: false; readonly reason: "cas_conflict"; readonly observed: HumanTaskState | null };

export async function applyHumanTaskTransition(
  client: PoolClient,
  ctx: HumanTaskTransitionContext,
): Promise<HumanTaskTransitionOutcome> {
  const { next, sideEffects } = transitionHumanTask(ctx.fromState, ctx.event, ctx.guard);

  const setsAssignee = sideEffects.some(
    (s) => s.kind === "setField" && s.entity === "human_task" && s.field === "assignee",
  );
  const resolving = next === "resolved";
  const emitEvents = sideEffects.filter(
    (s): s is Extract<SideEffectCmd, { kind: "emitEvent" }> => s.kind === "emitEvent",
  );
  const pending = sideEffects.filter((s) => s.kind !== "emitEvent" && s.kind !== "setField");

  if (setsAssignee && ctx.assignee === undefined) {
    throw new Error(
      `applyHumanTaskTransition: transition ${ctx.fromState}->${next} sets assignee but none provided`,
    );
  }

  const updated = await client.query<{ state: HumanTaskState }>(
    `UPDATE human_tasks
        SET state       = $1,
            updated_at  = now(),
            assignee    = CASE WHEN $2::boolean THEN $3::uuid ELSE assignee END,
            resolved_at = CASE WHEN $4::boolean THEN now() ELSE resolved_at END
      WHERE id = $5::uuid AND tenant_id = $6::uuid AND state = $7
    RETURNING state`,
    [next, setsAssignee, ctx.assignee ?? null, resolving, ctx.humanTaskId, ctx.tenantId, ctx.fromState],
  );

  if (updated.rowCount === 0) {
    const observed = await client.query<{ state: HumanTaskState }>(
      `SELECT state FROM human_tasks WHERE id = $1::uuid AND tenant_id = $2::uuid`,
      [ctx.humanTaskId, ctx.tenantId],
    );
    return { applied: false, reason: "cas_conflict", observed: observed.rows[0]?.state ?? null };
  }

  const anchor = ctx.eventIdempotencyKey ?? ctx.humanTaskId;
  const emitted: EmittedEvent[] = [];
  for (const cmd of emitEvents) {
    emitted.push(
      await emitOutboxEvent(client, {
        tenantId: ctx.tenantId,
        eventType: cmd.event,
        correlationId: ctx.correlationId,
        runId: ctx.runId,
        idempotencyKey: `${anchor}:${cmd.event}`,
        occurredAt: ctx.occurredAt,
        retentionPolicy: EVENTS_OUTBOX_RETENTION_POLICY,
      }),
    );
  }

  return { applied: true, next, emitted, pending };
}
