/**
 * Human Task 상태명령 라우트 (D4.5 — api-surface §3).
 *
 * 인박스 명령을 D2 HumanTask 전이(state-machine §3, H1..H8)에 연결한다. assign(H1/H6)·start(H2)는
 * 단일 엔티티 전이(이벤트/run 연계 없음). resolve(H3)·escalate(H5)는 run 교차 전이(R13/R15)를 동반하므로
 * 별도 슬라이스에서 추가한다.
 *
 * 에러 매핑(api-surface §3):
 *  - 태스크 미존재 → RESOURCE_NOT_FOUND(404).
 *  - 종결(resolved/expired/cancelled) 태스크 명령 → HUMAN_TASK_EXPIRED(410, business).
 *  - 비종결이나 현재 상태에 정의되지 않은 명령(out-of-order) → IR_SCHEMA_INVALID(422, invalid_state_for_command).
 *  - 역할 미보유 → AUTHZ_FORBIDDEN(403, RBAC preHandler). 담당자-식별 스코프는 Phase 2(역할 레지스트리).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";

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
import type { PrincipalId, RbacAction, Role } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { applyHumanTaskTransition } from "../runtime/human-task-transition";
import { applyRunTransition } from "../runtime/run-transition";
import { runIdempotentCommand, isRecord, type CommandResponse } from "./command";
import { ApiResponseError } from "./errors";
import { validateResolutionAgainstBusinessForm } from "./human-task-form-schema";
import { requirePrincipal, type ApiServerDeps } from "./server";
import type { RunEnqueuer } from "./run-queue";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerHumanTaskRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  // POST /v1/human-tasks/{id}/assign — H1(open→assigned) / H6(escalated→assigned). body: { assignee }.
  app.post<{ Params: { id: string } }>(
    "/v1/human-tasks/:id/assign",
    { config: { rbacAction: "human_task.assign" } },
    async (request, reply) => {
      const id = requireTaskId(request.params.id);
      const assignee = requireAssignee(request);
      const result = await runIdempotentCommand(
        deps,
        request,
        "assignHumanTask",
        `/v1/human-tasks/${id}/assign`,
        (client, tenantId) =>
          applyHumanTaskCommand(client, tenantId, id, request.correlationId, { type: "assign" }, assignee),
      );
      reply.code(result.status).send(result.body);
    },
  );

  // POST /v1/human-tasks/{id}/start — H2(assigned→in_progress). body 없음(닫힌 shape).
  app.post<{ Params: { id: string } }>(
    "/v1/human-tasks/:id/start",
    { config: { rbacAction: "human_task.start" } },
    async (request, reply) => {
      const id = requireTaskId(request.params.id);
      requireEmptyBody(request);
      const result = await runIdempotentCommand(
        deps,
        request,
        "startHumanTask",
        `/v1/human-tasks/${id}/start`,
        (client, tenantId) =>
          applyHumanTaskCommand(client, tenantId, id, request.correlationId, { type: "start" }, undefined),
      );
      reply.code(result.status).send(result.body);
    },
  );

  // POST /v1/human-tasks/{id}/resolve — H3(in_progress→resolved) + Run R13(suspended→resume_requested).
  //   RBAC는 task kind에 의존(human_task.resolve.<kind>, auth-rbac §2)하므로 preHandler는 coarse
  //   human_task.read로 fail-closed 게이트만 두고, 정확한 인가는 kind 조회 후 핸들러에서 평가한다.
  app.post<{ Params: { id: string } }>(
    "/v1/human-tasks/:id/resolve",
    { config: { rbacAction: "human_task.read" } },
    async (request, reply) => {
      const result = await resolveHumanTask(deps, request);
      reply.code(result.status).send(result.body);
    },
  );

  // POST /v1/human-tasks/{id}/escalate — H5(open/assigned/in_progress→escalated) + Run R15(suspended 유지, 재배정).
  //   reassignAssignee routing owner가 없으면 assert*에서 fail-closed rollback한다(조용한 admin queue 추정 금지).
  app.post<{ Params: { id: string } }>(
    "/v1/human-tasks/:id/escalate",
    { config: { rbacAction: "human_task.escalate" } },
    async (request, reply) => {
      const id = requireTaskId(request.params.id);
      requireReasonBody(request);
      const result = await runIdempotentCommand(
        deps,
        request,
        "escalateHumanTask",
        `/v1/human-tasks/${id}/escalate`,
        (client, tenantId) =>
          applyHumanTaskCommand(client, tenantId, id, request.correlationId, { type: "escalate" }, undefined, {
            // R15: suspended + human_task.escalated → suspended(reassignAssignee). run 상태 불변.
            event: { type: "human_task.escalated" },
            guard: {},
          }),
      );
      reply.code(result.status).send(result.body);
    },
  );
}

/** resolve/escalate가 동반하는 Run 교차 전이(state-machine R13/R15). run이 suspended일 때만 적용. */
interface RunCoupling {
  readonly event: RunEvent;
  readonly guard: RunGuard;
}

/** auth-rbac §2: resolve는 task kind별 액션으로 인가(approval은 approver+, 그 외 reviewer+). */
const RESOLVE_ACTION: Readonly<Record<HumanTaskKind, RbacAction>> = {
  approval: "human_task.resolve.approval",
  validation: "human_task.resolve.validation",
  exception: "human_task.resolve.exception",
  captcha: "human_task.resolve.captcha",
  mfa: "human_task.resolve.mfa",
};

/**
 * resolve 핸들러: kind 의존 RBAC를 평가한 뒤 멱등 명령으로 위임. kind는 불변이라 멱등 예약 이전 선조회가
 * 안전하다(인가 실패 시 키 미소모). H3(in_progress→resolved) + Run R13.
 */
async function resolveHumanTask(
  deps: ApiServerDeps,
  request: FastifyRequest<{ Params: { id: string } }>,
): Promise<CommandResponse> {
  const principal = requirePrincipal(request);
  const id = requireTaskId(request.params.id);
  const resolveResult = requireResolveBody(request);

  const authRow = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
    const r = await c.query<ResolveTaskAuthRow>(
      `SELECT kind, assignee::text AS assignee, assignee_role, result_schema
         FROM human_tasks
        WHERE id=$1::uuid`,
      [id],
    );
    return r.rows[0] ?? null;
  });
  if (authRow === null) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND");
  }
  const decision = await deps.rbac.authorize(principal, {
    action: RESOLVE_ACTION[authRow.kind],
    tenantId: principal.tenantId,
    resource: { kind: "human_task", id },
    humanTask: {
      kind: authRow.kind,
      assigneeId: authRow.assignee === null ? undefined : (authRow.assignee as PrincipalId),
      assigneeRole: toRole(authRow.assignee_role),
    },
  });
  if (decision.kind === "deny") {
    // 내부 사유는 로그에만(보안 경계). 응답엔 code(AUTHZ_FORBIDDEN 등)만.
    request.log.warn(
      { action: decision.action, code: decision.code, correlation_id: request.correlationId },
      "human_task.resolve denied",
    );
    throw new ApiResponseError(decision.code);
  }
  validateResolutionAgainstBusinessForm(authRow.result_schema, resolveResult);

  return runIdempotentCommand(
    deps,
    request,
    "resolveHumanTask",
    `/v1/human-tasks/${id}/resolve`,
    (client, tenantId) =>
      applyHumanTaskCommand(
        client,
        tenantId,
        id,
        request.correlationId,
        { type: "resolve" },
        undefined,
        {
          // R13: suspended + human_task.resolved && humanTaskValid → resume_requested.
          event: { type: "human_task.resolved" },
          guard: { humanTaskValid: true },
        },
        deps.enqueuer,
        resolveResult,
        principal.subjectId,
      ),
  );
}

interface ResolveTaskAuthRow {
  kind: HumanTaskKind;
  assignee: string | null;
  assignee_role: string | null;
  result_schema: unknown;
}

const ROLES: ReadonlySet<string> = new Set<Role>(["viewer", "operator", "reviewer", "approver", "admin"]);

function toRole(value: string | null): Role | undefined {
  if (value !== null && ROLES.has(value)) return value as Role;
  return undefined;
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
}

type ResolutionDecision = "approve" | "reject" | "correct" | "retry";

interface HumanTaskResolution {
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
async function applyHumanTaskCommand(
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

async function readHumanTaskResponse(
  client: PoolClient,
  tenantId: string,
  humanTaskId: string,
): Promise<Record<string, unknown>> {
  const result = await client.query<HumanTaskResponseRow>(
    `SELECT id::text AS id, state, kind, assignee, expires_at, on_timeout, run_id::text AS run_id,
            payload, result_schema, artifact_refs, result
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
  if (event.type === "assign" && assignee !== undefined && pending.every((cmd) => cmd.kind === "reassignAssignee")) {
    return;
  }
  throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", {
    reason: "human_task_pending_side_effects_unsupported",
    pending: pending.map((cmd) => cmd.kind),
  });
}

function assertRunCouplingPendingHandled(pending: readonly SideEffectCmd[]): void {
  if (pending.length === 0) return;
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

function requireTaskId(id: string): string {
  if (!UUID_RE.test(id)) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND");
  }
  return id;
}

/**
 * assign body: { assignee: PrincipalId } 만 허용(닫힌 shape). 키 소모 이전 선검사.
 * assignee = JWT sub(PrincipalId) 로 자유형 string(UUID 보장 없음: OIDC sub auth0|… 등) — decided_by/created_by 와
 * 동일 정책(비-빈 string). 빈 값/비-string 은 여전히 거부.
 */
function requireAssignee(request: FastifyRequest): string {
  if (!isRecord(request.body) || Object.keys(request.body).some((k) => k !== "assignee")) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_assign_request" });
  }
  const assignee = request.body.assignee;
  if (typeof assignee !== "string" || assignee.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_assignee" });
  }
  return assignee;
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

/** start 등 본문 없는 명령: 비어있거나 닫힌 빈 객체만 허용. */
function requireEmptyBody(request: FastifyRequest): void {
  if (request.body === undefined || request.body === null) return;
  if (!isRecord(request.body) || Object.keys(request.body).length > 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_body" });
  }
}

/**
 * resolve body: optional `result`만 허용. V2 result는 인박스/검증 워크벤치 표면으로 영속한다.
 * 런타임 재개 컨텍스트 자동 주입은 별도 IREL/reserved-handler versioned 변경 전까지 비활성.
 */
function requireResolveBody(request: FastifyRequest): HumanTaskResolution | undefined {
  if (request.body === undefined || request.body === null) return undefined;
  if (!isRecord(request.body) || Object.keys(request.body).some((k) => k !== "result")) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_resolve_request" });
  }
  if (request.body.result === undefined) return undefined;
  if (!isRecord(request.body.result)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_resolve_result" });
  }
  return requireResolutionResult(request.body.result);
}

const RESOLUTION_DECISIONS = new Set<ResolutionDecision>(["approve", "reject", "correct", "retry"]);

function requireResolutionResult(value: Record<string, unknown>): HumanTaskResolution {
  const allowed = new Set(["decision", "corrections", "reason", "confidence", "notes"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_resolve_result_key" });
  }
  const decision = value.decision;
  if (typeof decision !== "string" || !RESOLUTION_DECISIONS.has(decision as ResolutionDecision)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_resolve_decision" });
  }
  const corrections = value.corrections;
  if (corrections !== undefined && !isRecord(corrections)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_resolve_corrections" });
  }
  const reason = value.reason;
  if (reason !== undefined && typeof reason !== "string") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_resolve_reason" });
  }
  const confidence = value.confidence;
  if (confidence !== undefined && (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_resolve_confidence" });
  }
  const notes = value.notes;
  if (notes !== undefined && typeof notes !== "string") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_resolve_notes" });
  }
  return {
    decision: decision as ResolutionDecision,
    ...(corrections !== undefined ? { corrections } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

/** escalate body: optional `reason`(string)만 허용. reason은 v1 비영속(수신만). */
function requireReasonBody(request: FastifyRequest): void {
  if (request.body === undefined || request.body === null) return;
  if (!isRecord(request.body) || Object.keys(request.body).some((k) => k !== "reason")) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_escalate_request" });
  }
  if (request.body.reason !== undefined && typeof request.body.reason !== "string") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_escalate_reason" });
  }
}
