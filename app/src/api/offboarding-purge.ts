// 테넌트 오프보딩 삭제 원장 + maker-checker(설계 rpa-offboarding-data-export-deletion-design O2).
// 2단계 삭제의 제어면: pending → approved(soft: purge_after=now()+grace) | rejected, approved → cancelled(유예 중 복구).
// 비가역 삭제(hard)는 O4 purge sweeper 가 purge_after 경과 원장을 purging→purged 로 진행한다.
// 모든 상태 전이는 tenant_data.purge.* security-audit 를 전이와 같은 tx 안에서 fail-closed 기록(append 실패=전이 롤백).
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { withTenantTx } from "../db/pool";
import { isRecord, runIdempotentCommand } from "./command";
import { ApiResponseError } from "./errors";
import { recordOffboardingAudit, requireOffboardingSecurityAudit } from "./offboarding-export";
import { UUID_RE } from "./reads-support";
import { requirePrincipal, type ApiServerDeps } from "./server";

// ops-defaults `offboarding.purge_grace_default` — 승인 후 비가역 삭제까지의 복구 창(반출 완료 + 오조작 복구).
const OFFBOARDING_PURGE_GRACE_DEFAULT_DAYS = 7;

interface PurgeRequestRow {
  readonly id: string;
  readonly status: string;
  readonly reason: string;
  readonly requested_by: string;
  readonly decided_by: string | null;
  readonly decision_reason: string | null;
  readonly decided_at: Date | null;
  readonly purge_after: Date | null;
  readonly purged_at: Date | null;
  readonly held_rows: unknown;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const ROW_COLUMNS = `id, status, reason, requested_by, decided_by, decision_reason, decided_at,
              purge_after, purged_at, held_rows, created_at, updated_at`;

function rowToBody(row: PurgeRequestRow): Record<string, unknown> {
  return {
    request_id: row.id,
    status: row.status,
    reason: row.reason,
    requested_by: row.requested_by,
    decided_by: row.decided_by,
    decision_reason: row.decision_reason,
    decided_at: row.decided_at === null ? null : row.decided_at.toISOString(),
    purge_after: row.purge_after === null ? null : row.purge_after.toISOString(),
    purged_at: row.purged_at === null ? null : row.purged_at.toISOString(),
    held_rows: row.held_rows ?? {},
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function registerOffboardingPurgeRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  const graceDays = deps.offboardingPurgeGraceDays ?? OFFBOARDING_PURGE_GRACE_DEFAULT_DAYS;

  // 원장 조회 — read 스코프는 오프보딩 조회 권한(tenant_data.export) 재사용(액션 증식 회피, 설계 O2).
  app.get("/v1/offboarding/purge-requests", { config: { rbacAction: "tenant_data.export" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const rows = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
      const result = await client.query<PurgeRequestRow>(
        `SELECT ${ROW_COLUMNS}
           FROM tenant_offboarding_requests
          WHERE tenant_id = $1::uuid
          ORDER BY created_at DESC
          LIMIT 50`,
        [principal.tenantId],
      );
      return result.rows;
    });
    reply.code(200).send({ items: rows.map(rowToBody), grace_days: graceDays });
  });

  // 삭제 요청(maker) — 활성(pending/approved/purging) 요청은 테넌트당 1건(부분 UNIQUE → 409).
  app.post("/v1/offboarding/purge-requests", { config: { rbacAction: "tenant_data.purge.request" } }, async (request, reply) => {
    const securityAudit = requireOffboardingSecurityAudit(deps);
    const principal = requirePrincipal(request);
    const body = isRecord(request.body) ? request.body : {};
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length === 0) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_reason", field: "reason" });
    }
    const result = await runIdempotentCommand(
      deps,
      request,
      "createOffboardingPurgeRequest",
      "/v1/offboarding/purge-requests",
      async (c, tenantId) => {
        let row: PurgeRequestRow;
        try {
          const inserted = await c.query<PurgeRequestRow>(
            `INSERT INTO tenant_offboarding_requests (id, tenant_id, status, reason, requested_by)
             VALUES ($1::uuid, $2::uuid, 'pending', $3, $4)
             RETURNING ${ROW_COLUMNS}`,
            [randomUUID(), tenantId, reason, principal.subjectId],
          );
          const first = inserted.rows[0];
          if (first === undefined) throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR");
          row = first;
        } catch (err) {
          if (isRecord(err) && (err as { code?: unknown }).code === "23505") {
            throw new ApiResponseError("TENANT_OFFBOARDING", { reason: "purge_request_active" });
          }
          throw err;
        }
        // 전이와 같은 tx 에서 fail-closed 감사 — append 실패 시 요청 자체가 롤백된다(설계 §4-4).
        await recordOffboardingAudit(securityAudit, request, principal, "tenant_data.purge.request", "offboarding_purge_requested", {
          decision_kind: "tenant_data.purge.request",
          request_id: row.id,
          status: "pending",
        });
        return { status: 201, body: rowToBody(row) };
      },
    );
    reply.code(result.status).send(result.body);
  });

  // 승인/반려(checker) — SoD: 요청자 본인은 결정 불가(scenario_promotion_requests 선례).
  app.post<{ Params: { requestId: string } }>(
    "/v1/offboarding/purge-requests/:requestId/decide",
    { config: { rbacAction: "tenant_data.purge.approve" } },
    async (request, reply) => {
      const securityAudit = requireOffboardingSecurityAudit(deps);
      const principal = requirePrincipal(request);
      const { requestId } = request.params;
      if (!UUID_RE.test(requestId)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
      const body = isRecord(request.body) ? request.body : {};
      const decision = body.decision === "approved" || body.decision === "rejected" ? body.decision : null;
      if (decision === null) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_decision", field: "decision" });
      }
      const decisionReason = typeof body.reason === "string" && body.reason.trim().length > 0 ? body.reason.trim() : null;
      const result = await runIdempotentCommand(
        deps,
        request,
        "decideOffboardingPurgeRequest",
        `/v1/offboarding/purge-requests/${requestId}/decide`,
        async (c, tenantId) => {
          const pending = await c.query<{ requested_by: string }>(
            `SELECT requested_by FROM tenant_offboarding_requests
              WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'pending'`,
            [tenantId, requestId],
          );
          const req = pending.rows[0];
          if (req === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
          // SoD: 요청자 본인은 승인/반려 불가(maker≠checker) — 비가역 삭제 게이트의 핵심 불변.
          if (req.requested_by === principal.subjectId) {
            throw new ApiResponseError("AUTHZ_FORBIDDEN", { reason: "self_approval_forbidden" });
          }
          const updated = await c.query<PurgeRequestRow>(
            decision === "approved"
              ? `UPDATE tenant_offboarding_requests
                    SET status = 'approved', decided_by = $3, decision_reason = $4, decided_at = now(),
                        purge_after = now() + make_interval(days => $5::int), updated_at = now()
                  WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'pending'
                  RETURNING ${ROW_COLUMNS}`
              : `UPDATE tenant_offboarding_requests
                    SET status = 'rejected', decided_by = $3, decision_reason = $4, decided_at = now(), updated_at = now()
                  WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'pending'
                  RETURNING ${ROW_COLUMNS}`,
            decision === "approved"
              ? [tenantId, requestId, principal.subjectId, decisionReason, graceDays]
              : [tenantId, requestId, principal.subjectId, decisionReason],
          );
          const row = updated.rows[0];
          if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
          await recordOffboardingAudit(
            securityAudit,
            request,
            principal,
            "tenant_data.purge.approve",
            decision === "approved" ? "offboarding_purge_approved" : "offboarding_purge_rejected",
            {
              decision_kind: "tenant_data.purge.approve",
              request_id: requestId,
              decision,
              purge_after: row.purge_after === null ? null : row.purge_after.toISOString(),
            },
          );
          return { status: 200, body: rowToBody(row) };
        },
      );
      reply.code(result.status).send(result.body);
    },
  );

  // 취소 — 유예 창의 존재 이유(반출 완료 + 오조작 복구). admin 누구나(요청자·승인자 무관, Open Decision D3).
  //   pending(요청 철회)·approved(유예 중 복구)만 취소 가능. purging 진입 후엔 삭제가 진행 중이라 불가.
  app.post<{ Params: { requestId: string } }>(
    "/v1/offboarding/purge-requests/:requestId/cancel",
    { config: { rbacAction: "tenant_data.purge.request" } },
    async (request, reply) => {
      const securityAudit = requireOffboardingSecurityAudit(deps);
      const principal = requirePrincipal(request);
      const { requestId } = request.params;
      if (!UUID_RE.test(requestId)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
      const result = await runIdempotentCommand(
        deps,
        request,
        "cancelOffboardingPurgeRequest",
        `/v1/offboarding/purge-requests/${requestId}/cancel`,
        async (c, tenantId) => {
          const existing = await c.query<{ status: string }>(
            `SELECT status FROM tenant_offboarding_requests WHERE tenant_id = $1::uuid AND id = $2::uuid`,
            [tenantId, requestId],
          );
          const current = existing.rows[0];
          if (current === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
          if (current.status !== "pending" && current.status !== "approved") {
            throw new ApiResponseError("TENANT_OFFBOARDING", { reason: "not_cancellable", status: current.status });
          }
          const updated = await c.query<PurgeRequestRow>(
            `UPDATE tenant_offboarding_requests
                SET status = 'cancelled', updated_at = now()
              WHERE tenant_id = $1::uuid AND id = $2::uuid AND status IN ('pending','approved')
              RETURNING ${ROW_COLUMNS}`,
            [tenantId, requestId],
          );
          const row = updated.rows[0];
          if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
          await recordOffboardingAudit(securityAudit, request, principal, "tenant_data.purge.request", "offboarding_purge_cancelled", {
            decision_kind: "tenant_data.purge.request",
            request_id: requestId,
            previous_status: current.status,
          });
          return { status: 200, body: rowToBody(row) };
        },
      );
      reply.code(result.status).send(result.body);
    },
  );
}
