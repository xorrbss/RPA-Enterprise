import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { withTenantTx } from "../db/pool";
import { runIdempotentCommand } from "./command";
import { compileScenario } from "./compile-pipeline";
import { ApiResponseError } from "../runtime/errors";
import { requirePrincipal, type ApiServerDeps, UUID_RE } from "./server-shared";
import { isRecord, signedCommandRefsFor } from "./scenarios-support";

export function registerScenarioPromotionRequestRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  // ── maker-checker prod 승격 게이트(D4) — 직접 POST /promote(admin)와 별개의 인간 승격 경로(요청자≠승인자 SoD) ──
  // POST /v1/scenarios/:scenarioId/promotion-requests — operator+(scenario.update) 가 버전 prod 승격을 요청(사유 필수, pending 1건).
  app.post<{ Params: { scenarioId: string } }>(
    "/v1/scenarios/:scenarioId/promotion-requests",
    { config: { rbacAction: "scenario.update" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const scenarioId = request.params.scenarioId;
      if (!UUID_RE.test(scenarioId)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
      const body = isRecord(request.body) ? request.body : {};
      const version = typeof body.version === "number" && Number.isInteger(body.version) ? body.version : null;
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (version === null) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_version", field: "version" });
      if (reason.length === 0) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_reason", field: "reason" });
      const result = await runIdempotentCommand(
        deps,
        request,
        "createScenarioPromotionRequest",
        `/v1/scenarios/${scenarioId}/promotion-requests`,
        async (c, tenantId) => {
          const ver = await c.query<{ promotion_status: string }>(
            `SELECT sv.promotion_status
               FROM scenario_versions sv JOIN scenarios s ON s.tenant_id=sv.tenant_id AND s.id=sv.scenario_id
              WHERE sv.tenant_id=$1::uuid AND sv.scenario_id=$2::uuid AND sv.version=$3 AND s.archived_at IS NULL`,
            [tenantId, scenarioId, version],
          );
          const verRow = ver.rows[0];
          if (verRow === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
          if (verRow.promotion_status === "prod") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "already_prod", version });
          let row: { id: string; created_at: Date };
          try {
            const inserted = await c.query<{ id: string; created_at: Date }>(
              `INSERT INTO scenario_promotion_requests (id, tenant_id, scenario_id, version, reason, requested_by)
               VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6) RETURNING id, created_at`,
              [randomUUID(), tenantId, scenarioId, version, reason, principal.subjectId],
            );
            const first = inserted.rows[0];
            if (first === undefined) throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR");
            row = first;
          } catch (err) {
            if (isRecord(err) && (err as { code?: unknown }).code === "23505") {
              throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "promotion_request_pending", version });
            }
            throw err;
          }
          return {
            status: 201,
            body: { request_id: row.id, scenario_id: scenarioId, version, status: "pending", reason, requested_by: principal.subjectId, created_at: row.created_at.toISOString() },
          };
        },
      );
      reply.code(result.status).send(result.body);
    },
  );

  // POST /v1/scenarios/:scenarioId/promotion-requests/:requestId/decide — approver+(scenario.promote.approve) 승인/반려.
  //   요청자≠승인자(SoD) 강제. approve 시 해당 버전 prod 승격(직접 promote 와 동일 compile+CAS). reject 는 사유 기록.
  app.post<{ Params: { scenarioId: string; requestId: string } }>(
    "/v1/scenarios/:scenarioId/promotion-requests/:requestId/decide",
    { config: { rbacAction: "scenario.promote.approve" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const { scenarioId, requestId } = request.params;
      if (!UUID_RE.test(scenarioId) || !UUID_RE.test(requestId)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
      const body = isRecord(request.body) ? request.body : {};
      const decision = body.decision === "approve" || body.decision === "reject" ? body.decision : null;
      if (decision === null) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_decision", field: "decision" });
      const decisionReason = typeof body.reason === "string" && body.reason.trim().length > 0 ? body.reason.trim() : null;
      const signedCommandRefs = await signedCommandRefsFor(deps, principal, "scenario.promote");
      const result = await runIdempotentCommand(
        deps,
        request,
        "decideScenarioPromotionRequest",
        `/v1/scenarios/${scenarioId}/promotion-requests/${requestId}/decide`,
        async (c, tenantId) => {
          const reqRes = await c.query<{ version: number; requested_by: string }>(
            `SELECT version, requested_by FROM scenario_promotion_requests
              WHERE tenant_id=$1::uuid AND id=$2::uuid AND scenario_id=$3::uuid AND status='pending'`,
            [tenantId, requestId, scenarioId],
          );
          const req = reqRes.rows[0];
          if (req === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
          // SoD: 요청자 본인은 승인/반려 불가(maker≠checker).
          if (req.requested_by === principal.subjectId) {
            throw new ApiResponseError("AUTHZ_FORBIDDEN", { reason: "self_approval_forbidden" });
          }
          if (decision === "approve") {
            const verRes = await c.query<{ version_id: string; ir: unknown }>(
              `SELECT sv.id AS version_id, sv.ir
                 FROM scenario_versions sv JOIN scenarios s ON s.tenant_id=sv.tenant_id AND s.id=sv.scenario_id
                WHERE sv.tenant_id=$1::uuid AND sv.scenario_id=$2::uuid AND sv.version=$3 AND s.archived_at IS NULL`,
              [tenantId, scenarioId, req.version],
            );
            const ver = verRes.rows[0];
            if (ver === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
            const outcome = compileScenario(ver.ir, { promote: true, signedCommandRefs });
            if (!outcome.ok) throw new ApiResponseError(outcome.code, outcome.details);
            await c.query(
              `UPDATE scenario_versions SET promotion_status='draft', promoted_at=NULL
                WHERE tenant_id=$1::uuid AND scenario_id=$2::uuid AND id <> $3::uuid AND promotion_status='prod'`,
              [tenantId, scenarioId, ver.version_id],
            );
            await c.query(
              `UPDATE scenario_versions SET promotion_status='prod', compiled_ast=$1, promoted_at=now()
                WHERE tenant_id=$2::uuid AND id=$3::uuid`,
              [outcome.compiledAst, tenantId, ver.version_id],
            );
          }
          const newStatus = decision === "approve" ? "approved" : "rejected";
          await c.query(
            `UPDATE scenario_promotion_requests
                SET status=$4, decided_by=$5, decision_reason=$6, decided_at=now()
              WHERE tenant_id=$1::uuid AND id=$2::uuid AND scenario_id=$3::uuid AND status='pending'`,
            [tenantId, requestId, scenarioId, newStatus, principal.subjectId, decisionReason],
          );
          return {
            status: 200,
            body: { request_id: requestId, scenario_id: scenarioId, version: req.version, status: newStatus, decided_by: principal.subjectId, decision_reason: decisionReason },
          };
        },
      );
      reply.code(result.status).send(result.body);
    },
  );

  // GET /v1/scenarios/promotion-requests — approver 인박스(pending 요청 목록). 정적 라우트(파라메트릭 :scenarioId 에 비가려짐). RLS 스코프.
  app.get("/v1/scenarios/promotion-requests", { config: { rbacAction: "scenario.promote.approve" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const rows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const result = await c.query<{ id: string; scenario_id: string; scenario_name: string; version: number; reason: string; requested_by: string; created_at: Date }>(
        `SELECT pr.id, pr.scenario_id, s.name AS scenario_name, pr.version, pr.reason, pr.requested_by, pr.created_at
           FROM scenario_promotion_requests pr JOIN scenarios s ON s.tenant_id=pr.tenant_id AND s.id=pr.scenario_id
          WHERE pr.tenant_id=$1::uuid AND pr.status='pending'
          ORDER BY pr.created_at DESC LIMIT 50`,
        [principal.tenantId],
      );
      return result.rows;
    });
    reply.code(200).send({
      items: rows.map((r) => ({
        request_id: r.id,
        scenario_id: r.scenario_id,
        scenario_name: r.scenario_name,
        version: r.version,
        reason: r.reason,
        requested_by: r.requested_by,
        created_at: r.created_at.toISOString(),
      })),
      next_cursor: null,
    });
  });
}
