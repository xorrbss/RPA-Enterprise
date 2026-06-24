import type pg from "pg";

import type { EventId, RuntimeJobResult, RuntimeWorkerJob } from "../../../ts/runtime-contract";
import type { HumanTaskState, RunState, SideEffectCmd } from "../../../ts/state-machine-types";
import { requireString } from "./runtime-worker-parse";
import { withTenantTx } from "../db/pool";
import { applyHumanTaskTransition } from "../runtime/human-task-transition";
import { HUMAN_TASK_DEFAULT_TIMEOUT_MS } from "../runtime/human-task-timeout-policy";
import { applyRunTransition } from "../runtime/run-transition";
import { settleLinkedWorkitemForRunTerminal } from "../runtime/workitem-settlement";

const HUMAN_TASK_TIMEOUT_SWEEP_LIMIT = 100;

interface DueHumanTaskRow {
  readonly id: string;
  readonly run_id: string;
  readonly state: HumanTaskState;
  readonly on_timeout: "fail" | "escalate";
  readonly expires_at: Date;
  readonly run_status: RunState | null;
  readonly run_correlation_id: string | null;
  readonly workitem_id: string | null;
}

export async function handleHumanTaskTimeoutSweeper(pool: pg.Pool, job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
  const tenantId = requireString(job.tenantId, "human_task_timeout_sweeper.tenantId");
  const correlationId = requireString(job.correlationId, "human_task_timeout_sweeper.correlationId");
  const emittedEvents: EventId[] = [];

  await withTenantTx(pool, tenantId, async (client) => {
    const due = await client.query<DueHumanTaskRow>(
      `SELECT ht.id::text AS id,
              ht.run_id::text AS run_id,
              ht.state,
              ht.on_timeout,
              ht.expires_at,
              r.status AS run_status,
              r.correlation_id::text AS run_correlation_id,
              r.workitem_id::text AS workitem_id
         FROM human_tasks ht
         LEFT JOIN runs r ON r.tenant_id = ht.tenant_id AND r.id = ht.run_id
        WHERE ht.tenant_id = $1::uuid
          AND ht.state IN ('open','assigned','in_progress','escalated')
          AND ht.expires_at IS NOT NULL
          AND ht.expires_at <= now()
        ORDER BY ht.expires_at ASC, ht.id ASC
        LIMIT $2
        FOR UPDATE OF ht SKIP LOCKED`,
      [tenantId, HUMAN_TASK_TIMEOUT_SWEEP_LIMIT],
    );

    for (const task of due.rows) {
      const humanTaskOutcome = await applyHumanTaskTransition(client, {
        tenantId,
        humanTaskId: task.id,
        runId: task.run_id,
        fromState: task.state,
        event: { type: "timeout" },
        guard: task.state === "escalated" ? {} : { onTimeout: task.on_timeout },
        correlationId,
        eventIdempotencyKey: `${task.id}:timeout:${task.expires_at.toISOString()}`,
      });
      if (!humanTaskOutcome.applied) continue;
      assertHumanTaskTimeoutPendingHandled(humanTaskOutcome.pending);
      emittedEvents.push(...humanTaskOutcome.emitted.map((event) => event.eventId as EventId));

      if (humanTaskOutcome.next === "escalated") {
        await extendEscalatedDeadline(client, tenantId, task.id);
        await applySuspendedRunEscalation(client, tenantId, task, correlationId);
        continue;
      }

      if (humanTaskOutcome.next === "expired") {
        await applySuspendedRunExpiry(client, tenantId, task, correlationId, emittedEvents);
      }
    }
  });

  return { kind: "completed", emittedEvents };
}

async function extendEscalatedDeadline(client: pg.PoolClient, tenantId: string, humanTaskId: string): Promise<void> {
  await client.query(
    `UPDATE human_tasks
        SET expires_at = now() + ($3::bigint * interval '1 millisecond'),
            updated_at = now()
      WHERE tenant_id = $1::uuid AND id = $2::uuid AND state = 'escalated'`,
    [tenantId, humanTaskId, HUMAN_TASK_DEFAULT_TIMEOUT_MS],
  );
}

async function applySuspendedRunEscalation(
  client: pg.PoolClient,
  tenantId: string,
  task: DueHumanTaskRow,
  fallbackCorrelationId: string,
): Promise<void> {
  if (task.run_status !== "suspended") return;
  const runOutcome = await applyRunTransition(client, {
    tenantId,
    runId: task.run_id,
    fromStatus: "suspended",
    event: { type: "human_task.escalated" },
    guard: {},
    correlationId: task.run_correlation_id ?? fallbackCorrelationId,
    eventIdempotencyKey: `${task.run_id}:${task.id}:human_task_escalated`,
  });
  if (!runOutcome.applied) return;
  assertRunEscalationPendingHandled(runOutcome.pending);
}

async function applySuspendedRunExpiry(
  client: pg.PoolClient,
  tenantId: string,
  task: DueHumanTaskRow,
  fallbackCorrelationId: string,
  emittedEvents: EventId[],
): Promise<void> {
  if (task.run_status !== "suspended") return;
  const correlationId = task.run_correlation_id ?? fallbackCorrelationId;
  const runOutcome = await applyRunTransition(client, {
    tenantId,
    runId: task.run_id,
    fromStatus: "suspended",
    event: { type: "human_task.expired" },
    guard: {},
    correlationId,
    eventIdempotencyKey: `${task.run_id}:${task.id}:human_task_expired`,
  });
  if (!runOutcome.applied) return;
  assertRunExpiryPendingHandled(runOutcome.pending);
  emittedEvents.push(...runOutcome.emitted.map((event) => event.eventId as EventId));
  await settleLinkedWorkitemForRunTerminal(client, task.workitem_id, {
    tenantId,
    runId: task.run_id,
    correlationId,
    terminal: "business",
    eventIdempotencyKey: `${task.run_id}:${task.id}:workitem-human-task-expired`,
  });
}

function assertHumanTaskTimeoutPendingHandled(pending: readonly SideEffectCmd[]): void {
  if (pending.length > 0) {
    throw new Error(`human_task_timeout_sweeper: unexpected human_task pending ${pending.map((p) => p.kind).join(",")}`);
  }
}

function assertRunEscalationPendingHandled(pending: readonly SideEffectCmd[]): void {
  assertOnlyPending(pending, ["reassignAssignee"], "R15");
}

function assertRunExpiryPendingHandled(pending: readonly SideEffectCmd[]): void {
  assertOnlyPending(pending, ["evaluateDeadLetter", "notify"], "R14");
}

function assertOnlyPending(
  pending: readonly SideEffectCmd[],
  allowedKinds: readonly SideEffectCmd["kind"][],
  label: string,
): void {
  const allowed = new Set<string>(allowedKinds);
  for (const cmd of pending) {
    if (!allowed.has(cmd.kind)) {
      throw new Error(`human_task_timeout_sweeper: ${label} unexpected pending side effect ${cmd.kind}`);
    }
  }
  for (const kind of allowedKinds) {
    if (!pending.some((cmd) => cmd.kind === kind)) {
      throw new Error(`human_task_timeout_sweeper: ${label} missing pending side effect ${kind}`);
    }
  }
}
