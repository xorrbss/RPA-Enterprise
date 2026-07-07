// human-tasks.ts 에서 추출 — HumanTask 명령 적용 계층(전이 CAS·결과/에스컬레이션 영속·Run 교차 전이, 동작 무변경).
import type { PoolClient } from "pg";

import {
  HUMANTASK_TERMINAL,
  IllegalTransition,
  type HumanTaskEvent,
  type HumanTaskKind,
  type HumanTaskState,
  type RunEvent,
  type RunGuard,
  type RunState,
  type SideEffectCmd,
} from "../../../ts/state-machine-types";
import type { PrincipalId } from "../../../ts/security-middleware-contract";
import { applyHumanTaskTransition } from "../runtime/human-task-transition";
import { applyRunTransition } from "../runtime/run-transition";
import type { CommandResponse } from "./command";
import { ApiResponseError } from "../runtime/errors";
import type { RunEnqueuer } from "../runtime/run-queue";

/** resolve/escalate가 동반하는 Run 교차 전이(state-machine R13/R15). run이 suspended일 때만 적용. */
export interface RunCoupling {
  readonly event: RunEvent;
  readonly guard: RunGuard;
}

interface HumanTaskRow {
  state: HumanTaskState;
  run_id: string;
}

interface HumanTaskResponseRow {
  id: string;
  state: HumanTaskState;
  kind: HumanTaskKind;
  assignee: string | null;
  expires_at: Date | null;
  on_timeout: string;
  run_id: string | null;
  payload: unknown;
  result_schema: unknown;
  artifact_refs: unknown;
  result: unknown;
  escalation_reason: string | null;
  escalated_by: string | null;
  escalated_at: Date | null;
}

export type ResolutionDecision = "approve" | "reject" | "correct" | "retry";

export interface HumanTaskResolution {
  readonly decision: ResolutionDecision;
  readonly corrections?: Record<string, unknown>;
  readonly reason?: string;
  readonly confidence?: number;
  readonly notes?: string;
}

/**
 * HumanTask 명령 적용(작업 tx). 재조회 후 CAS로 경합 해소. 종결→HUMAN_TASK_EXPIRED,
 * 정의되지 않은 명령(IllegalTransition)→IR_SCHEMA_INVALID. assign은 assignee 필수(H1/H6 setField).
 */
export async function applyHumanTaskCommand(
  client: PoolClient,
  tenantId: string,
  humanTaskId: string,
  correlationId: string,
  event: HumanTaskEvent,
  assignee: string | undefined,
  runCoupling?: RunCoupling,
  enqueuer?: RunEnqueuer,
  resolveResult?: HumanTaskResolution,
  resolvedBy?: PrincipalId,
  escalation?: { reason: string | undefined; escalatedBy: PrincipalId | undefined },
): Promise<CommandResponse> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const cur = await client.query<HumanTaskRow>(
      `SELECT state, run_id::text AS run_id FROM human_tasks WHERE id=$1::uuid AND tenant_id=$2::uuid`,
      [humanTaskId, tenantId],
    );
    const row = cur.rows[0] ?? null;
    if (row === null) {
      // RLS가 타테넌트 row를 숨기므로 cross-tenant도 동일하게 not-found(존재 비노출).
      throw new ApiResponseError("RESOURCE_NOT_FOUND");
    }
    if ((HUMANTASK_TERMINAL as readonly string[]).includes(row.state)) {
      throw new ApiResponseError("HUMAN_TASK_EXPIRED", { state: row.state });
    }

    let outcome;
    try {
      outcome = await applyHumanTaskTransition(client, {
        tenantId,
        humanTaskId,
        runId: row.run_id,
        fromState: row.state,
        event,
        guard: {},
        correlationId,
        assignee,
      });
    } catch (err) {
      if (err instanceof IllegalTransition) {
        // 비종결이나 현재 상태에 정의되지 않은 명령(out-of-order) — 조용한 false 금지, 422로 표면화.
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_state_for_command", state: row.state });
      }
      throw err;
    }
    if (!outcome.applied) continue; // cas_conflict → 재조회

    // 교차 전이(R13/R15): human_task 전이 직후 동일 tx에서 연관 run 전이 적용.
    assertHumanTaskPendingHandled(event, assignee, outcome.pending);
    if (event.type === "resolve") {
      await storeHumanTaskResolution(client, tenantId, humanTaskId, resolveResult, resolvedBy);
    }
    if (event.type === "escalate") {
      // 담당자 해제 모델: H5 reassignAssignee 를 '담당자 비움'으로 소비(추정 라우팅 아님) + 사유 영속.
      await storeHumanTaskEscalation(client, tenantId, humanTaskId, escalation?.reason, escalation?.escalatedBy);
    }
    if (runCoupling !== undefined) {
      await applyCoupledRunTransition(client, tenantId, row.run_id, humanTaskId, correlationId, runCoupling, enqueuer);
    }
    return { status: 200, body: await readHumanTaskResponse(client, tenantId, humanTaskId) };
  }
  // CAS 경합 3회 — 조용한 false 금지: 재시도 가능 충돌로 표면화.
  throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", { reason: "human_task_cas_contention" });
}

async function storeHumanTaskResolution(
  client: PoolClient,
  tenantId: string,
  humanTaskId: string,
  resolveResult: HumanTaskResolution | undefined,
  resolvedBy: PrincipalId | undefined,
): Promise<void> {
  const updated = await client.query(
    `UPDATE human_tasks
        SET result = $3::jsonb,
            resolved_by = $4::text,
            updated_at = now()
      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [tenantId, humanTaskId, resolveResult === undefined ? null : JSON.stringify(resolveResult), resolvedBy ?? null],
  );
  if (updated.rowCount !== 1) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND");
  }
}

// H5 담당자 해제 모델: escalate 시 assignee 를 비우고(escalated 큐 개방) 사유/주체/시각을 영속한다.
// assignee=NULL 이 reassignAssignee side effect 의 명시 소비(추정 admin queue 매핑 아님).
async function storeHumanTaskEscalation(
  client: PoolClient,
  tenantId: string,
  humanTaskId: string,
  reason: string | undefined,
  escalatedBy: PrincipalId | undefined,
): Promise<void> {
  const updated = await client.query(
    `UPDATE human_tasks
        SET assignee = NULL,
            escalation_reason = $3::text,
            escalated_by = $4::text,
            escalated_at = now(),
            updated_at = now()
      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [tenantId, humanTaskId, reason ?? null, escalatedBy ?? null],
  );
  if (updated.rowCount !== 1) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND");
  }
}

async function readHumanTaskResponse(
  client: PoolClient,
  tenantId: string,
  humanTaskId: string,
): Promise<Record<string, unknown>> {
  const result = await client.query<HumanTaskResponseRow>(
    `SELECT id::text AS id, state, kind, assignee, expires_at, on_timeout, run_id::text AS run_id,
            payload, result_schema, artifact_refs, result,
            escalation_reason, escalated_by, escalated_at
       FROM human_tasks
      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [tenantId, humanTaskId],
  );
  const row = result.rows[0] ?? null;
  if (row === null) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND");
  }
  return {
    human_task_id: row.id,
    state: row.state,
    kind: row.kind,
    assignee: row.assignee,
    timeout: row.expires_at !== null ? row.expires_at.toISOString() : null,
    on_timeout: row.on_timeout,
    run_id: row.run_id,
    payload: recordOrEmpty(row.payload),
    result_schema: recordOrEmpty(row.result_schema),
    artifact_refs: stringArray(row.artifact_refs),
    result: recordOrNull(row.result),
    escalation_reason: row.escalation_reason,
    escalated_by: row.escalated_by,
    escalated_at: row.escalated_at !== null ? row.escalated_at.toISOString() : null,
  };
}

/**
 * resolve/escalate가 동반하는 Run 전이(R13/R15). 연관 run이 `suspended`일 때만 적용한다 — 정상 흐름에서
 * 미해소 human_task는 run suspended를 함의(R4/R5). run이 이미 다른 상태(abort로 aborting/cancelled 등)면
 * 더 이상 이 task를 대기하지 않으므로 run 전이를 건너뛴다(human_task.* 이벤트는 이미 발행됨). 상태를 명시적으로
 * 확인해 건너뛰므로 조용한 false가 아니다.
 */
function assertHumanTaskPendingHandled(
  event: HumanTaskEvent,
  assignee: string | undefined,
  pending: readonly SideEffectCmd[],
): void {
  if (pending.length === 0) return;
  // reassignAssignee 소비 규칙(state-machine.md §3 routing): H6 assign 은 명시 assignee 로,
  // H5 escalate 는 '담당자 해제'(escalated 큐 개방)로 소비한다 — 둘 다 추정 매핑이 아닌 명시 routing.
  if (event.type === "assign" && assignee !== undefined && pending.every((cmd) => cmd.kind === "reassignAssignee")) {
    return;
  }
  if (event.type === "escalate" && pending.every((cmd) => cmd.kind === "reassignAssignee")) {
    return;
  }
  throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", {
    reason: "human_task_pending_side_effects_unsupported",
    pending: pending.map((cmd) => cmd.kind),
  });
}

function assertRunCouplingPendingHandled(pending: readonly SideEffectCmd[]): void {
  if (pending.length === 0) return;
  // R15(human_task.escalated) 의 run-레벨 reassignAssignee 는 task-레벨 담당자 해제로 이미 소비됐다
  // (run 은 suspended 유지, run-레벨 assignee 개념 없음). 그 외 미지원 pending 은 fail-closed.
  if (pending.every((cmd) => cmd.kind === "reassignAssignee")) return;
  throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", {
    reason: "human_task_run_coupling_pending_side_effects_unsupported",
    pending: pending.map((cmd) => cmd.kind),
  });
}

async function applyCoupledRunTransition(
  client: PoolClient,
  tenantId: string,
  runId: string,
  humanTaskId: string,
  fallbackCorrelationId: string,
  coupling: RunCoupling,
  enqueuer?: RunEnqueuer,
): Promise<void> {
  const cur = await client.query<{ status: RunState; correlation_id: string | null }>(
    `SELECT status, correlation_id::text AS correlation_id FROM runs WHERE id=$1::uuid AND tenant_id=$2::uuid`,
    [runId, tenantId],
  );
  const run = cur.rows[0] ?? null;
  if (run === null || run.status !== "suspended") {
    return; // run이 더 이상 suspended가 아님 → 대기 종료, 전이 건너뜀.
  }
  const outcome = await applyRunTransition(client, {
    tenantId,
    runId,
    fromStatus: "suspended",
    event: coupling.event,
    guard: coupling.guard,
    correlationId: run.correlation_id ?? fallbackCorrelationId,
    // R13/R15 run 이벤트(run.resume_requested 등) outbox 멱등키를 per-suspend-cycle 로 스코프 — humanTaskId 는 사이클별 고유
    //   (R11 suspend·R17/R18 resume 의 per-cycle 키와 대칭). per-run 고정이면 다중 suspend/resume 2회차 R13 이
    //   events_outbox UNIQUE(tenant,idempotency_key) 충돌→resolve tx 롤백→이벤트 유실+run suspended 영구 stuck(감사 EPL-01).
    eventIdempotencyKey: `${runId}:${humanTaskId}`,
  });
  if (!outcome.applied) {
    throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", { reason: "human_task_run_coupling_cas_contention" });
  }
  assertRunCouplingPendingHandled(outcome.pending);

  // R13(human_task.resolved → resume_requested): run_resume 잡을 같은 tx 로 인큐(원자). 미인큐 시 run 이 resume_requested 에
  // 영구 stuck — 조용한 stuck 금지: resolve 가 R13 을 발화했는데 enqueuer 가 run_resume 미지원이면 loud throw. (escalate R15 는 비해당.)
  if (coupling.event.type === "human_task.resolved") {
    if (enqueuer?.enqueueRunResume === undefined) {
      throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "run_resume_enqueuer_not_configured" });
    }
    await enqueuer.enqueueRunResume(client, {
      tenantId,
      runId,
      correlationId: run.correlation_id ?? fallbackCorrelationId,
    });
  }
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
