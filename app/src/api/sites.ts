/**
 * Site risk 승인 라우트 (api-surface §7).
 *
 * `POST /v1/sites/{site_profile_id}/approve` — risk=red 사이트 실행 승인의 제어평면 진입점.
 * Idempotency-Key 필수, 승인 권한(site.approve = approver/admin, auth-rbac §2). body: optional reason/expires_at.
 * 효과: site_profiles.approved=true(+ approved_at/by/reason/expires) CAS + site_profile_approvals 감사행.
 * GET /v1/sites가 approval_status='approved'로 반영(reads.ts). SITE_PROFILE_BLOCKED(런타임 실행 차단)와 별개.
 *
 * 에러: site 미존재/타테넌트 → RESOURCE_NOT_FOUND(404, RLS 비노출). 승인 권한 미보유 → AUTHZ_FORBIDDEN(403, RBAC preHandler).
 *   body malformed → IR_SCHEMA_INVALID(422, 키 소모 이전).
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import { isRecord, runIdempotentCommand, type CommandResponse } from "./command";
import { ApiResponseError } from "./errors";
import { requirePrincipal, type ApiServerDeps } from "./server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerSiteRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.post<{ Params: { siteId: string } }>(
    "/v1/sites/:siteId/approve",
    { config: { rbacAction: "site.approve" } },
    async (request, reply) => {
      const siteId = request.params.siteId;
      if (!UUID_RE.test(siteId)) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }

      // body 형상 선검사(멱등키 소모 이전, malformed→422). reason/expires_at는 선택.
      const body = request.body;
      if (body !== undefined && body !== null && !isRecord(body)) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_body" });
      }
      const reason = isRecord(body) ? body.reason : undefined;
      const expiresAt = isRecord(body) ? body.expires_at : undefined;
      if (reason !== undefined && typeof reason !== "string") {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "reason_must_be_string" });
      }
      if (expiresAt !== undefined && (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt)))) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "expires_at_invalid" });
      }

      // approved_by는 uuid 컬럼 — subject(sub claim)가 uuid가 아니면 조용한 500 대신 fail-closed.
      const principal = requirePrincipal(request);
      if (!UUID_RE.test(principal.subjectId)) {
        throw new ApiResponseError("AUTHZ_FORBIDDEN", { reason: "subject_not_uuid" });
      }
      const approverId = principal.subjectId;
      const reasonValue = reason ?? null;
      const expiresValue = expiresAt ?? null;

      const result = await runIdempotentCommand(deps, request, "approveSite", `/v1/sites/${siteId}/approve`, (client, tenantId) =>
        applyApprove(client, tenantId, siteId, approverId, reasonValue, expiresValue),
      );
      reply.code(result.status).send(result.body);
    },
  );
}

async function applyApprove(
  client: PoolClient,
  tenantId: string,
  siteId: string,
  approverId: string,
  reason: string | null,
  expiresAt: string | null,
): Promise<CommandResponse> {
  const site = await client.query<{ id: string }>(
    `SELECT id FROM site_profiles WHERE id=$1::uuid AND tenant_id=$2::uuid`,
    [siteId, tenantId],
  );
  if (site.rows[0] === undefined) {
    // RLS가 타테넌트 row를 숨기므로 cross-tenant도 동일하게 not-found(존재 비노출).
    throw new ApiResponseError("RESOURCE_NOT_FOUND");
  }
  await client.query(
    `UPDATE site_profiles
        SET approved=true, approved_at=now(), approved_by=$3::uuid, approval_reason=$4, approval_expires_at=$5::timestamptz
      WHERE tenant_id=$2::uuid AND id=$1::uuid`,
    [siteId, tenantId, approverId, reason, expiresAt],
  );
  await client.query(
    `INSERT INTO site_profile_approvals (id, tenant_id, site_profile_id, approved_by, reason, expires_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::timestamptz)`,
    [randomUUID(), tenantId, siteId, approverId, reason, expiresAt],
  );
  return { status: 200, body: { site_profile_id: siteId, approval_status: "approved" } };
}
