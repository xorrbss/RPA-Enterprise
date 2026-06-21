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
            assignee    = CASE WHEN $2::boolean THEN $3::text ELSE assignee END,
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

/**
 * run 종결(failed_system via terminalize / cancelled via abort) 시 연결된 비종결 human_task 를 H7(cancel→cancelled)로
 * 정리한다(state-machine.md H7 "run abort 연동, R16"). 종전엔 run 이 종결돼도 'open' human_task 가 인박스에 actionable 로
 * 남아(reads 가 run.status 미조인) 운영자 resolve→coupled R13 가 silent no-op(조용한 false: 운영자는 처리했다고 오인하나
 * run 은 이미 종결). H7 cancel 후엔 resolve 가 IllegalTransition 으로 거부된다. 호출자는 run 종결 전이와 동일 tx 에서
 * 호출(원자). 비종결 task 없으면 no-op. H7 은 side-effect 0(emitEvent/pending 없음, codegen r("cancelled",[])).
 */
export async function cancelLinkedHumanTasksForRunTerminal(
  client: PoolClient,
  input: { tenantId: string; runId: string; correlationId: string },
): Promise<void> {
  const tasks = await client.query<{ id: string; state: HumanTaskState }>(
    `SELECT id::text AS id, state FROM human_tasks
      WHERE tenant_id = $1::uuid AND run_id = $2::uuid
        AND state IN ('open','assigned','in_progress','escalated')
      FOR UPDATE`,
    [input.tenantId, input.runId],
  );
  for (const t of tasks.rows) {
    const out = await applyHumanTaskTransition(client, {
      tenantId: input.tenantId,
      humanTaskId: t.id,
      runId: input.runId,
      fromState: t.state,
      event: { type: "cancel" },
      guard: {},
      correlationId: input.correlationId,
      eventIdempotencyKey: `${t.id}:run_terminal_cancel`,
    });
    // 동시 변경(operator 가 막 resolve/escalate)면 CAS 실패 — 흡수(이미 다른 단말 도달).
    if (out.applied && out.pending.length > 0) {
      throw new Error(`cancelLinkedHumanTasksForRunTerminal: unexpected H7 pending: ${out.pending.map((p) => p.kind).join(",")}`);
    }
  }
}
