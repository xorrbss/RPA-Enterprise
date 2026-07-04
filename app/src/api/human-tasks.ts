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

import type { HumanTaskKind } from "../../../ts/state-machine-types";
import type { PrincipalId, RbacAction, Role } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { runIdempotentCommand, isRecord, type CommandResponse } from "./command";
import { ApiResponseError } from "../runtime/errors";
import { validateResolutionAgainstBusinessForm } from "./human-task-form-schema";
import {
  applyHumanTaskCommand,
  type HumanTaskResolution,
  type ResolutionDecision,
} from "./human-tasks-command";
import { requirePrincipal, type ApiServerDeps, UUID_RE } from "./server-shared";


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
      const escalationReason = requireReasonBody(request);
      const principal = requirePrincipal(request);
      const result = await runIdempotentCommand(
        deps,
        request,
        "escalateHumanTask",
        `/v1/human-tasks/${id}/escalate`,
        (client, tenantId) =>
          applyHumanTaskCommand(
            client,
            tenantId,
            id,
            request.correlationId,
            { type: "escalate" },
            undefined,
            {
              // R15: suspended + human_task.escalated → suspended(reassignAssignee). run 상태 불변.
              event: { type: "human_task.escalated" },
              guard: {},
            },
            undefined,
            undefined,
            undefined,
            // 담당자 해제 모델(routing): escalate는 assignee를 비우고 escalated 큐에 올린다(H6 assign으로 재배정).
            { reason: escalationReason, escalatedBy: principal.subjectId },
          ),
      );
      reply.code(result.status).send(result.body);
    },
  );
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

/** escalate body: optional `reason`(string)만 허용. reason은 escalation_reason 으로 영속(H5). */
function requireReasonBody(request: FastifyRequest): string | undefined {
  if (request.body === undefined || request.body === null) return undefined;
  if (!isRecord(request.body) || Object.keys(request.body).some((k) => k !== "reason")) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_escalate_request" });
  }
  if (request.body.reason === undefined) return undefined;
  if (typeof request.body.reason !== "string") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_escalate_reason" });
  }
  return request.body.reason;
}
