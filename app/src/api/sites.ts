/**
 * 사이트 명령 라우트 (api-surface §6 — sites).
 *
 * `POST /v1/sites` — site_profile 신규 등록(자동화 대상 사이트 온보딩). body: name(필수)·url_pattern(필수, http(s)
 * origin)·optional risk(green default)·optional page_state_selectors(생성 시점 엄격 검증). operator+ 권한
 * (auth-rbac §2, rbacAction=site.create). Idempotency-Key 멱등. UNIQUE(tenant_id, name) → 중복 name 422.
 * url_pattern은 http(s) origin이어야 한다(runtime resolveSiteProfileId가 URL.origin 동일성으로 매칭) — 비-origin은
 * 매칭 불가 사이트라 생성 거부(조용한 false 방지). page_state_selectors는 parseSitePageStateConfig로 검증해 무효
 * config 사이트(런타임 PAGE_STATE_UNRESOLVED)를 선차단한다.
 *
 * `PATCH /v1/sites/{site_profile_id}` — site_profile 설정 수정(현재 name만; 콘솔 인라인 이름 편집). operator+ 권한
 * (auth-rbac §2, rbacAction=site.update). Idempotency-Key 멱등. UNIQUE(tenant_id, name) → 중복 name 422.
 * 미존재/타테넌트(RLS)/형식 무효 id → 404.
 *
 * `PATCH /v1/sites/{site_profile_id}/page-state` — site_profile page_state_selectors 수정. operator+ 권한
 * (rbacAction=site.update). Idempotency-Key 멱등. body.page_state_selectors 는 null(해제) 또는 SitePageStateConfig.
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

import { parseSitePageStateConfig } from "../executor/site-page-state-config";
import { originOf } from "../runtime/site-resolution";
import { isRecord, runIdempotentCommand, type CommandResponse } from "./command";
import { ApiResponseError } from "./errors";
import { type ApiServerDeps, requirePrincipal } from "./server";
import { summarizePageStateSelectors } from "./site-page-state-contract";

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

interface UpdateBody {
  readonly name: string;
}

interface PageStateUpdateBody {
  readonly pageStateSelectors: unknown | null;
}

/** PATCH body 선검사(키 소모 이전). name(필수 비공백)만 허용 — risk/url/selectors 등 다른 설정은 별도 라우트(YAGNI). */
function parseUpdateBody(raw: unknown): UpdateBody {
  if (!isRecord(raw)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  }
  for (const key of Object.keys(raw)) {
    if (key !== "name") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
    }
  }
  const name = raw.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_name" });
  }
  return { name: name.trim() };
}

/** PATCH /page-state body 선검사. page_state_selectors=null(해제) 또는 SitePageStateConfig만 허용. */
function parsePageStateUpdateBody(raw: unknown): PageStateUpdateBody {
  if (!isRecord(raw)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  }
  for (const key of Object.keys(raw)) {
    if (key !== "page_state_selectors") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
    }
  }
  if (!Object.prototype.hasOwnProperty.call(raw, "page_state_selectors")) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_page_state_selectors" });
  }
  const selectors = raw.page_state_selectors;
  if (selectors === null) return { pageStateSelectors: null };
  try {
    parseSitePageStateConfig(selectors);
  } catch {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_page_state_selectors" });
  }
  return { pageStateSelectors: selectors };
}

type SiteRisk = "green" | "amber" | "red";

interface CreateBody {
  readonly name: string;
  readonly urlPattern: string;
  readonly risk: SiteRisk;
  readonly pageStateSelectors: unknown;
}

/**
 * body 형상 선검사(키 소모 이전). name(필수 비공백)·url_pattern(필수 http(s) origin)·optional risk(green default)·
 * optional page_state_selectors(엄격 검증). 그 외 키/형 무효 → 422.
 */
function parseCreateBody(raw: unknown): CreateBody {
  if (!isRecord(raw)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  }
  for (const key of Object.keys(raw)) {
    if (key !== "name" && key !== "url_pattern" && key !== "risk" && key !== "page_state_selectors") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
    }
  }
  const name = raw.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_name" });
  }
  const urlPattern = raw.url_pattern;
  if (typeof urlPattern !== "string" || originOf(urlPattern) === null) {
    // http(s) origin이어야 runtime resolveSiteProfileId가 매칭 가능 — 비-origin은 매칭 불가 사이트라 생성 거부.
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_url_pattern" });
  }
  let risk: SiteRisk = "green";
  if (raw.risk !== undefined) {
    if (raw.risk !== "green" && raw.risk !== "amber" && raw.risk !== "red") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_risk" });
    }
    risk = raw.risk;
  }
  let pageStateSelectors: unknown;
  if (raw.page_state_selectors !== undefined) {
    try {
      parseSitePageStateConfig(raw.page_state_selectors); // 무효 config 사이트 생성 금지(런타임 PAGE_STATE_UNRESOLVED 선차단)
    } catch {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_page_state_selectors" });
    }
    pageStateSelectors = raw.page_state_selectors;
  }
  return { name: name.trim(), urlPattern, risk, pageStateSelectors };
}

export function registerSiteRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.post(
    "/v1/sites",
    { config: { rbacAction: "site.create" } },
    async (request: FastifyRequest, reply) => {
      requirePrincipal(request);
      const body = parseCreateBody(request.body); // 키 소모 이전 선검사(malformed→422)
      const result = await runIdempotentCommand(
        deps,
        request,
        "createSite",
        "/v1/sites",
        (client, tenantId) => applySiteCreate(client, tenantId, body),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/v1/sites/:id",
    { config: { rbacAction: "site.update" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const id = request.params.id;
      if (!UUID_RE.test(id)) {
        // 형식 무효 id는 존재할 수 없다 → 404(존재 비노출).
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      requirePrincipal(request);
      const body = parseUpdateBody(request.body); // 키 소모 이전 선검사(malformed→422)
      const result = await runIdempotentCommand(
        deps,
        request,
        "updateSite",
        `/v1/sites/${id}`,
        (client, tenantId) => applySiteUpdate(client, tenantId, id, body),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/v1/sites/:id/page-state",
    { config: { rbacAction: "site.update" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const id = request.params.id;
      if (!UUID_RE.test(id)) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      requirePrincipal(request);
      const body = parsePageStateUpdateBody(request.body);
      const result = await runIdempotentCommand(
        deps,
        request,
        "updateSitePageState",
        `/v1/sites/${id}/page-state`,
        (client, tenantId) => applySitePageStateUpdate(client, tenantId, id, body),
      );
      reply.code(result.status).send(result.body);
    },
  );

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

async function applySiteUpdate(
  client: PoolClient,
  tenantId: string,
  siteId: string,
  body: UpdateBody,
): Promise<CommandResponse> {
  // 존재 확인 + 이름 갱신을 한 UPDATE…RETURNING으로(RLS 스코프). 미존재/타테넌트 → 0행 → 404(존재 비노출).
  try {
    const updated = await client.query<{ id: string; name: string }>(
      `UPDATE site_profiles SET name = $1
        WHERE id = $2::uuid AND tenant_id = $3::uuid
        RETURNING id::text AS id, name`,
      [body.name, siteId, tenantId],
    );
    const row = updated.rows[0];
    if (row === undefined) {
      throw new ApiResponseError("RESOURCE_NOT_FOUND");
    }
    return { status: 200, body: { site_profile_id: row.id, name: row.name } };
  } catch (err) {
    // UNIQUE(tenant_id, name) 위반 → 테넌트 내 동일 이름 사이트 존재(입력 무효 422; 조용한 500 방지).
    if (isRecord(err) && (err as { code?: unknown }).code === "23505") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "site_name_already_exists", name: body.name });
    }
    throw err;
  }
}

async function applySitePageStateUpdate(
  client: PoolClient,
  tenantId: string,
  siteId: string,
  body: PageStateUpdateBody,
): Promise<CommandResponse> {
  const updated = await client.query<{ id: string; page_state_selectors: unknown }>(
    `UPDATE site_profiles
        SET page_state_selectors = $1::jsonb
      WHERE id = $2::uuid AND tenant_id = $3::uuid
      RETURNING id::text AS id, page_state_selectors`,
    [body.pageStateSelectors !== null ? JSON.stringify(body.pageStateSelectors) : null, siteId, tenantId],
  );
  const row = updated.rows[0];
  if (row === undefined) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND");
  }
  return {
    status: 200,
    body: {
      site_profile_id: row.id,
      page_state_selectors: row.page_state_selectors,
      page_state_summary: summarizePageStateSelectors(row.page_state_selectors),
    },
  };
}

async function applySiteCreate(
  client: PoolClient,
  tenantId: string,
  body: CreateBody,
): Promise<CommandResponse> {
  const id = randomUUID();
  const browserIdentityId = randomUUID();
  const networkPolicyId = randomUUID();
  const allowedDomain = hostOfUrlPattern(body.urlPattern);
  try {
    await client.query(
      `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, page_state_selectors)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb)`,
      [
        id,
        tenantId,
        body.name,
        body.urlPattern,
        body.risk,
        body.pageStateSelectors !== undefined ? JSON.stringify(body.pageStateSelectors) : null,
      ],
    );
    await client.query(
      `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label, version)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 1)`,
      [browserIdentityId, tenantId, id, `${body.name} default`],
    );
    await client.query(
      `INSERT INTO network_policies (id, tenant_id, allowed_domains)
       VALUES ($1::uuid, $2::uuid, $3::text[])`,
      [networkPolicyId, tenantId, [allowedDomain]],
    );
  } catch (err) {
    // UNIQUE(tenant_id, name) 위반 → 테넌트 내 동일 이름 사이트 존재(입력 무효 422; 조용한 500 방지).
    if (isRecord(err) && (err as { code?: unknown }).code === "23505") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "site_name_already_exists", name: body.name });
    }
    throw err;
  }
  // risk=green은 즉시 실행 가능(approved=false; SITE_PROFILE_BLOCKED는 red 미승인에만 적용).
  return {
    status: 201,
    body: {
      site_profile_id: id,
      name: body.name,
      url_pattern: body.urlPattern,
      risk: body.risk,
      approved: false,
      default_browser_identity_id: browserIdentityId,
      default_network_policy_id: networkPolicyId,
    },
  };
}

function hostOfUrlPattern(value: string): string {
  const origin = originOf(value);
  if (origin === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_url_pattern" });
  }
  return new URL(origin).hostname.toLowerCase();
}
