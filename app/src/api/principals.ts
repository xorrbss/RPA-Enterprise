/**
 * Principal 디렉터리 관리 라우트 (api-surface §3 — principals admin CRUD).
 *
 * 담당자 name-picker 디렉터리(`principals` 테이블)의 admin 수동 쓰기 경로(source='manual'). 조회는 reads.ts
 * `GET /v1/principals`, JWT `name` 클레임 자동 동기화는 principal-directory.ts(source='jwt')가 담당하며, 본 모듈은
 * 운영자(admin)가 미로그인 담당자를 사전 등록하거나 표시이름을 교정하는 경로다.
 *
 * - `POST /v1/principals` — 신규 등록(source='manual'). body: sub(필수)·display_name(필수)·optional email.
 *   UNIQUE(tenant_id, sub) 위반(이미 디렉터리에 있음) → IR_SCHEMA_INVALID(422; sites 동형, 전용 conflict 코드 미발명).
 * - `PATCH /v1/principals/{principal_id}` — 표시이름/이메일 수정(부분 갱신; email은 null 명시로 제거 가능). sub는 자연키라
 *   불변(수정=다른 principal). 미존재/타테넌트(RLS)/형식 무효 id → 404.
 * - `DELETE /v1/principals/{principal_id}` — 디렉터리 항목 삭제. human_tasks.assignee는 자유형 text(FK 없음)라 기존
 *   배정에 영향 없음(picker 후보에서만 제거). 미존재 → 404.
 *
 * 전부 admin 권한(auth-rbac §2, rbacAction=principal.manage; 미보유→AUTHZ_FORBIDDEN) + Idempotency-Key 멱등.
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { isRecord, runIdempotentCommand, type CommandResponse } from "./command";
import { ApiResponseError } from "./errors";
import { type ApiServerDeps, requirePrincipal } from "./server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DISPLAY_NAME = 256;
const MAX_EMAIL = 320;

interface CreateBody {
  readonly sub: string;
  readonly displayName: string;
  readonly email: string | null;
}

/** POST body 선검사(키 소모 이전). sub·display_name(필수 비공백)·optional email. 그 외 키/형 무효 → 422. */
function parseCreateBody(raw: unknown): CreateBody {
  if (!isRecord(raw)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  }
  for (const key of Object.keys(raw)) {
    if (key !== "sub" && key !== "display_name" && key !== "email") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
    }
  }
  const sub = raw.sub;
  if (typeof sub !== "string" || sub.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_sub" });
  }
  const displayName = raw.display_name;
  if (typeof displayName !== "string" || displayName.trim().length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_display_name" });
  }
  return { sub, displayName: displayName.trim().slice(0, MAX_DISPLAY_NAME), email: parseEmail(raw.email) };
}

interface UpdateBody {
  readonly displayNameProvided: boolean;
  readonly displayName: string | null;
  readonly emailProvided: boolean;
  readonly email: string | null;
}

/** PATCH body 선검사(키 소모 이전). display_name(비공백)·email(string|null) 중 최소 1개. sub는 불변(자연키). */
function parseUpdateBody(raw: unknown): UpdateBody {
  if (!isRecord(raw)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  }
  for (const key of Object.keys(raw)) {
    if (key !== "display_name" && key !== "email") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
    }
  }
  const displayNameProvided = "display_name" in raw;
  let displayName: string | null = null;
  if (displayNameProvided) {
    if (typeof raw.display_name !== "string" || raw.display_name.trim().length === 0) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_display_name" });
    }
    displayName = raw.display_name.trim().slice(0, MAX_DISPLAY_NAME);
  }
  const emailProvided = "email" in raw;
  const email = emailProvided ? parseEmail(raw.email) : null;
  if (!displayNameProvided && !emailProvided) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "empty_update" });
  }
  return { displayNameProvided, displayName, emailProvided, email };
}

/** email: 미지정(undefined)·null·비공백 string만 허용. null/빈문자는 '이메일 없음'(제거)으로 정규화. */
function parseEmail(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_email" });
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, MAX_EMAIL);
}

export function registerPrincipalRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.post(
    "/v1/principals",
    { config: { rbacAction: "principal.manage" } },
    async (request: FastifyRequest, reply) => {
      requirePrincipal(request);
      const body = parseCreateBody(request.body); // 키 소모 이전 선검사(malformed→422)
      const result = await runIdempotentCommand(
        deps,
        request,
        "createPrincipal",
        "/v1/principals",
        (client, tenantId) => applyPrincipalCreate(client, tenantId, body),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/v1/principals/:id",
    { config: { rbacAction: "principal.manage" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const id = request.params.id;
      if (!UUID_RE.test(id)) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND"); // 형식 무효 id는 존재 불가 → 404(존재 비노출)
      }
      requirePrincipal(request);
      const body = parseUpdateBody(request.body);
      const result = await runIdempotentCommand(
        deps,
        request,
        "updatePrincipal",
        `/v1/principals/${id}`,
        (client, tenantId) => applyPrincipalUpdate(client, tenantId, id, body),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/v1/principals/:id",
    { config: { rbacAction: "principal.manage" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const id = request.params.id;
      if (!UUID_RE.test(id)) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      requirePrincipal(request);
      const result = await runIdempotentCommand(
        deps,
        request,
        "deletePrincipal",
        `/v1/principals/${id}`,
        (client, tenantId) => applyPrincipalDelete(client, tenantId, id),
      );
      reply.code(result.status).send(result.body);
    },
  );
}

async function applyPrincipalCreate(
  client: PoolClient,
  tenantId: string,
  body: CreateBody,
): Promise<CommandResponse> {
  const id = randomUUID();
  try {
    await client.query(
      `INSERT INTO principals (id, tenant_id, sub, display_name, email, source)
       VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, 'manual')`,
      [id, tenantId, body.sub, body.displayName, body.email],
    );
  } catch (err) {
    // UNIQUE(tenant_id, sub) 위반 → 테넌트 내 동일 sub 이미 등록(입력 무효 422; 조용한 500 방지).
    if (isRecord(err) && (err as { code?: unknown }).code === "23505") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "principal_already_exists", sub: body.sub });
    }
    throw err;
  }
  return {
    status: 201,
    body: {
      principal_id: id,
      sub: body.sub,
      display_name: body.displayName,
      email: body.email,
      source: "manual",
      external_id: null,
      idp_provider: null,
      lifecycle_source: "local",
    },
  };
}

async function applyPrincipalUpdate(
  client: PoolClient,
  tenantId: string,
  id: string,
  body: UpdateBody,
): Promise<CommandResponse> {
  // 존재 확인 + 부분 갱신을 한 UPDATE…RETURNING으로(RLS 스코프). 0행 → 404(존재 비노출). email은 null 명시로 제거.
  const updated = await client.query<{
    id: string;
    sub: string;
    display_name: string;
    email: string | null;
    source: string;
    external_id: string | null;
    idp_provider: string | null;
    lifecycle_source: string;
  }>(
    `UPDATE principals
        SET display_name = CASE WHEN $1::boolean THEN $2::text ELSE display_name END,
            email        = CASE WHEN $3::boolean THEN $4::text ELSE email END,
            updated_at   = now()
      WHERE id = $5::uuid AND tenant_id = $6::uuid
      RETURNING id::text AS id, sub, display_name, email, source, external_id, idp_provider, lifecycle_source`,
    [body.displayNameProvided, body.displayName, body.emailProvided, body.email, id, tenantId],
  );
  const row = updated.rows[0];
  if (row === undefined) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND");
  }
  return {
    status: 200,
    body: {
      principal_id: row.id,
      sub: row.sub,
      display_name: row.display_name,
      email: row.email,
      source: row.source,
      external_id: row.external_id,
      idp_provider: row.idp_provider,
      lifecycle_source: row.lifecycle_source,
    },
  };
}

async function applyPrincipalDelete(client: PoolClient, tenantId: string, id: string): Promise<CommandResponse> {
  // human_tasks.assignee는 자유형 text(FK 없음)라 삭제가 기존 배정을 깨지 않는다(picker 후보에서만 제거).
  const deleted = await client.query<{ id: string }>(
    `DELETE FROM principals WHERE id = $1::uuid AND tenant_id = $2::uuid RETURNING id::text AS id`,
    [id, tenantId],
  );
  if (deleted.rows[0] === undefined) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND");
  }
  return { status: 200, body: { principal_id: id, deleted: true } };
}
