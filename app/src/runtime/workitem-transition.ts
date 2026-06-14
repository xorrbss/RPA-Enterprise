/**
 * DB 연결 Workitem 전이 런타임 (D2 — state-machine.md §2 구현측).
 *
 * runs와 동일 패턴: 순수 전이(codegen) → CAS UPDATE(WHERE status=cur) + 동일 tx outbox.
 * Workitem 고유 컬럼: checked_out_by/checked_out_at(W1/W8), attempts 리셋(W10).
 */
import type { PoolClient } from "pg";

import { transitionWorkitem } from "../../../codegen/transitions";
import type {
  WorkitemState,
  WorkitemEvent,
  WorkitemGuard,
  SideEffectCmd,
} from "../../../ts/state-machine-types";
import { emitOutboxEvent, type EmittedEvent } from "./outbox";

export interface WorkitemTransitionContext {
  readonly tenantId: string;
  readonly workitemId: string;
  readonly fromStatus: WorkitemState;
  readonly event: WorkitemEvent;
  readonly guard: WorkitemGuard;
  readonly correlationId: string;
  /** 연관 run(이벤트 linkage·ordering). 옵셔널. */
  readonly runId?: string;
  /** setField checked_out_by(W1/W8)에 쓸 worker. 해당 sideEffect가 있으면 필수. */
  readonly workerId?: string;
  readonly eventIdempotencyKey?: string;
  readonly occurredAt?: Date;
}

export type WorkitemTransitionOutcome =
  | {
      readonly applied: true;
      readonly next: WorkitemState;
      readonly emitted: readonly EmittedEvent[];
      readonly pending: readonly SideEffectCmd[];
    }
  | { readonly applied: false; readonly reason: "cas_conflict"; readonly observed: WorkitemState | null };

export async function applyWorkitemTransition(
  client: PoolClient,
  ctx: WorkitemTransitionContext,
): Promise<WorkitemTransitionOutcome> {
  const { next, sideEffects } = transitionWorkitem(ctx.fromStatus, ctx.event, ctx.guard);

  const setsCheckedBy = hasSetField(sideEffects, "checked_out_by");
  const setsCheckedAt = hasSetField(sideEffects, "checked_out_at");
  const resetsAttempts = hasSetField(sideEffects, "attempts"); // W10: attempts 리셋
  const emitEvents = sideEffects.filter(
    (s): s is Extract<SideEffectCmd, { kind: "emitEvent" }> => s.kind === "emitEvent",
  );
  const pending = sideEffects.filter((s) => s.kind !== "emitEvent" && s.kind !== "setField");

  if (setsCheckedBy && ctx.workerId === undefined) {
    throw new Error(
      `applyWorkitemTransition: transition ${ctx.fromStatus}->${next} sets checked_out_by but no workerId provided`,
    );
  }

  const updated = await client.query<{ status: WorkitemState }>(
    `UPDATE workitems
        SET status         = $1,
            updated_at     = now(),
            checked_out_by = CASE WHEN $2::boolean THEN $3::uuid ELSE checked_out_by END,
            checked_out_at = CASE WHEN $4::boolean THEN now() ELSE checked_out_at END,
            attempts       = CASE WHEN $5::boolean THEN 0 ELSE attempts END
      WHERE id = $6::uuid AND tenant_id = $7::uuid AND status = $8
    RETURNING status`,
    [next, setsCheckedBy, ctx.workerId ?? null, setsCheckedAt, resetsAttempts, ctx.workitemId, ctx.tenantId, ctx.fromStatus],
  );

  if (updated.rowCount === 0) {
    const observed = await client.query<{ status: WorkitemState }>(
      `SELECT status FROM workitems WHERE id = $1::uuid AND tenant_id = $2::uuid`,
      [ctx.workitemId, ctx.tenantId],
    );
    return { applied: false, reason: "cas_conflict", observed: observed.rows[0]?.status ?? null };
  }

  const anchor = ctx.eventIdempotencyKey ?? ctx.workitemId;
  const emitted: EmittedEvent[] = [];
  for (const cmd of emitEvents) {
    emitted.push(
      await emitOutboxEvent(client, {
        tenantId: ctx.tenantId,
        eventType: cmd.event,
        correlationId: ctx.correlationId,
        runId: ctx.runId,
        workitemId: ctx.workitemId,
        idempotencyKey: `${anchor}:${cmd.event}`,
        occurredAt: ctx.occurredAt,
      }),
    );
  }

  return { applied: true, next, emitted, pending };
}

function hasSetField(sideEffects: readonly SideEffectCmd[], field: string): boolean {
  return sideEffects.some((s) => s.kind === "setField" && s.entity === "workitem" && s.field === field);
}
