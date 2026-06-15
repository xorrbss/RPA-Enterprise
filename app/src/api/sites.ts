/**
 * 사이트 승인 명령 라우트 (api-surface §6 — sites).
 *
 * `POST /v1/sites/{site_profile_id}/approve` — risk=red 사이트 실행 승인 워크플로우의 제어평면 진입점.
 * 승인 시 site_profiles.approved=true(SITE_PROFILE_BLOCKED 런타임 게이트 해제) + site_profile_approvals 감사 행.
 * approver+ 권한(auth-rbac §2, rbacAction=site.approve; 미보유→AUTHZ_FORBIDDEN). Idempotency-Key 멱등.
 *
 * 에러: 형식 무효 id/미존재(RLS 포함)→RESOURCE_NOT_FOUND(404), body 형상 무효→IR_SCHEMA_INVALID(422),
 * 멱등 키 누락→422. 승인은 flip-to-true라 멱등 안전(재승인은 reason/expires 갱신 + 200).
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { isRecord, runIdempotentCommand, type CommandResponse } from "./command";
import { ApiResponseError } from "./errors";
import { type ApiServerDeps, requirePrincipal } from "./server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ApproveBody {
  readonly reason?: string;
  readonly expiresAt?: string;
}

/** body 형상 선검사(키 소모 이전). optional reason(string)·expires_at(ISO-8601). 그 외 키/형 무효→422. */
function parseApproveBody(raw: unknown): ApproveBody {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  }
  for (const key of Object.keys(raw)) {
    if (key !== "reason" && key !== "expires_at") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
    }
  }
  const reason = raw.reason;
  if (reason !== undefined && typeof reason !== "string") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_reason" });
  }
  const expiresAt = raw.expires_at;
  if (expiresAt !== undefined) {
    if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_expires_at" });
    }
  }
  return { reason, expiresAt: expiresAt as string | undefined };
}

export function registerSiteRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.post<{ Params: { id: string } }>(
    "/v1/sites/:id/approve",
    { config: { rbacAction: "site.approve" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const id = request.params.id;
      if (!UUID_RE.test(id)) {
        // 형식 무효 id는 존재할 수 없다 → 404(존재 비노출, 500 크래시 금지).
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const principal = requirePrincipal(request);
      const body = parseApproveBody(request.body); // 키 소모 이전 선검사(malformed→422)
      const result = await runIdempotentCommand(
        deps,
        request,
        "approveSite",
        `/v1/sites/${id}/approve`,
        (client, tenantId) => applySiteApproval(client, tenantId, id, principal.subjectId, body),
      );
      reply.code(result.status).send(result.body);
    },
  );
}

async function applySiteApproval(
  client: PoolClient,
  tenantId: string,
  siteId: string,
  approvedBy: string,
  body: ApproveBody,
): Promise<CommandResponse> {
  // 사이트 존재 확인(RLS 스코프). 미존재/타테넌트 → 404(존재 비노출).
  const site = await client.query<{ id: string }>(
    `SELECT id FROM site_profiles WHERE id=$1::uuid AND tenant_id=$2::uuid`,
    [siteId, tenantId],
  );
  if ((site.rowCount ?? 0) === 0) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND");
  }
  // 승인 반영(flip-to-true, 멱등 안전): approved + approver/시각/사유/만료.
  await client.query(
    `UPDATE site_profiles
        SET approved = true, approved_by = $1::uuid, approved_at = now(),
            approval_reason = $2, approval_expires_at = $3::timestamptz
      WHERE id = $4::uuid AND tenant_id = $5::uuid`,
    [approvedBy, body.reason ?? null, body.expiresAt ?? null, siteId, tenantId],
  );
  // 감사 행(불변 이력) — 매 승인마다 1행.
  await client.query(
    `INSERT INTO site_profile_approvals (id, tenant_id, site_profile_id, approved_by, reason, expires_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::timestamptz)`,
    [randomUUID(), tenantId, siteId, approvedBy, body.reason ?? null, body.expiresAt ?? null],
  );
  return { status: 200, body: { site_profile_id: siteId, approved: true, approved_by: approvedBy } };
}
