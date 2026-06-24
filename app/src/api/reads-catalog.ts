// reads.ts 에서 추출 — scenario/gateway-policy/site 조회 라우트(동작 무변경, api-surface §1·§3).
import type { FastifyInstance } from "fastify";

import { withTenantTx } from "../db/pool";
import { ApiResponseError } from "./errors";
import { paginate, parsePageParams } from "./list-query";
import { UUID_RE } from "./reads-support";
import { requirePrincipal, type ApiServerDeps } from "./server";
import { summarizePageStateSelectors } from "./site-page-state-contract";

interface ScenarioRow {
  id: string;
  name: string;
  version: number;
  version_id: string;
  promotion_status: string;
  created_at: Date;
  cursor_at: string; // created_at::text(전정밀도) — keyset 커서(PAG-01)
}

interface GatewayPolicyRow {
  model: string;
  version: number;
  capabilities: unknown;
  budget: unknown;
  fallback_config: unknown;
  is_default: boolean;
}

interface SiteRow {
  id: string;
  name: string;
  risk: string;
  approved: boolean;
  circuit_state: string;
  url_pattern: string;
  // 운영자-보조 세션 캡처 가능 여부 — page_state_selectors.loginUrl 설정 사이트만 '세션 등록' 노출(미설정 사이트의 412 클릭 회피).
  login_capable: boolean;
  session_ready: boolean;
  session_expires_at: Date | null;
  default_browser_identity_id: string | null;
  default_network_policy_id: string | null;
  page_state_selectors: unknown;
  created_at: Date;
  cursor_at: string; // created_at::text(전정밀도) — keyset 커서(PAG-01)
}

function siteRiskFilter(raw: unknown): "green" | "amber" | "red" | undefined {
  if (raw === undefined) return undefined;
  if (raw === "green" || raw === "amber" || raw === "red") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_risk" });
}

/** GatewayPolicy 행 → 계약 응답. capabilities/budget/fallback은 jsonb(파싱됨). */
function mapGatewayPolicy(r: GatewayPolicyRow): Record<string, unknown> {
  return {
    model: r.model,
    capabilities: r.capabilities,
    budget: r.budget,
    fallback: r.fallback_config,
    is_default: r.is_default,
  };
}

/** Site 행 → 계약 응답. approval_status는 approved 불리언에서 도출. circuit_status=circuit_state. */
function mapSite(r: SiteRow): Record<string, unknown> {
  return {
    site_profile_id: r.id,
    name: r.name,
    url_pattern: r.url_pattern,
    risk: r.risk,
    approval_status: r.approved ? "approved" : "pending",
    circuit_status: r.circuit_state,
    login_capable: r.login_capable,
    session_ready: r.session_ready,
    session_expires_at: r.session_expires_at !== null ? r.session_expires_at.toISOString() : null,
    default_browser_identity_id: r.default_browser_identity_id,
    default_network_policy_id: r.default_network_policy_id,
    page_state_selectors: r.page_state_selectors,
    page_state_summary: summarizePageStateSelectors(r.page_state_selectors),
  };
}

/** dlq kind 필터(workitem|sink). 무효→422. */

export function registerCatalogReadRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  // GET /v1/scenarios — 커서 페이지(items=Scenario: 메타 + 최신 version). RLS 스코프.
  //   list는 ir 본문 미포함(과다 렌더 금지) — 상세/편집은 getScenario.
  app.get("/v1/scenarios", { config: { rbacAction: "scenario.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);

    const rows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const result = await c.query<ScenarioRow>(
        `SELECT s.id, s.name, s.created_at, s.created_at::text AS cursor_at, sv.version, sv.id AS version_id, sv.promotion_status
           FROM scenarios s
           JOIN LATERAL (
             SELECT id, version, promotion_status FROM scenario_versions v
              WHERE v.tenant_id = s.tenant_id AND v.scenario_id = s.id
              ORDER BY v.version DESC LIMIT 1
          ) sv ON true
          WHERE s.tenant_id = $1::uuid
            AND s.archived_at IS NULL
            AND ($2::timestamptz IS NULL OR (s.created_at, s.id) < ($2::timestamptz, $3::uuid))
          ORDER BY s.created_at DESC, s.id DESC
          LIMIT $4`,
        [principal.tenantId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );
      return result.rows;
    });

    reply.code(200).send(
      paginate(rows, limit, (r) => ({ createdAt: r.cursor_at, id: r.id }), (r) => ({
        scenario_id: r.id,
        name: r.name,
        version: r.version,
        latest_version_id: r.version_id,
        promotion_status: r.promotion_status,
      })),
    );
  });

  // GET /v1/gateway/policies — 모델 정책 목록. 기본 정책과 version을 함께 노출해 콘솔 CRUD의 기준 목록으로 쓴다.
  app.get("/v1/gateway/policies", { config: { rbacAction: "gateway_policy.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const rows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const result = await c.query<GatewayPolicyRow>(
        `SELECT model, version, capabilities, budget, fallback_config, is_default
           FROM gateway_policies
          WHERE tenant_id = $1::uuid
          ORDER BY is_default DESC, model ASC`,
        [principal.tenantId],
      );
      return result.rows;
    });
    reply.code(200).send({ items: rows.map((r) => ({ ...mapGatewayPolicy(r), version: r.version })), next_cursor: null });
  });

  // GET /v1/gateway/policy — 모델 정책(model/capabilities/budget/fallback). RLS 스코프.
  //   ?model= 지정 시 그 모델(부재 404). 미지정 시: 단일 정책이면 반환, 다건이면 기본 정책 우선, 기본 없으면 model 필수(422).
  //   (기본 정책이 있는 테넌트는 run 생성 해소 규칙과 콘솔 조회 규칙을 맞춘다.)
  app.get("/v1/gateway/policy", { config: { rbacAction: "gateway_policy.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const model = query.model;
    if (model !== undefined && (typeof model !== "string" || model.length === 0)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_model" });
    }

    const rows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const result = await c.query<GatewayPolicyRow>(
        `SELECT model, version, capabilities, budget, fallback_config, is_default
           FROM gateway_policies
          WHERE tenant_id = $1::uuid AND ($2::text IS NULL OR model = $2)
          ORDER BY model ASC`,
        [principal.tenantId, model ?? null],
      );
      return result.rows;
    });

    if (rows.length === 0) {
      throw new ApiResponseError("RESOURCE_NOT_FOUND");
    }
    let selected = rows[0];
    if (model === undefined && rows.length > 1) {
      const defaults = rows.filter((r) => r.is_default);
      if (defaults.length === 1) {
        selected = defaults[0];
      } else {
        // model 미지정 + 다건 + 기본 없음 → 단수 응답으로 임의 선택 불가(가정 금지).
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "model_required", available: rows.length });
      }
    } else if (rows.length > 1) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "model_required", available: rows.length });
    }
    // ETag = gateway_policies.version(api-surface §6/§0.3, PUT와 동일 ETag 대상). PUT If-Match의 선행 read.
    reply.header("ETag", String(selected.version));
    reply.code(200).send(mapGatewayPolicy(selected));
  });

  // GET /v1/sites — 커서 페이지(items=Site). filter: risk(green|amber|red). RLS 스코프.
  app.get("/v1/sites", { config: { rbacAction: "site.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);
    const risk = siteRiskFilter(query.risk);

    const rows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const result = await c.query<SiteRow>(
        `SELECT s.id, s.name, s.risk, s.approved, s.circuit_state, s.url_pattern, s.page_state_selectors,
                (s.page_state_selectors->>'loginUrl') IS NOT NULL AS login_capable,
                EXISTS (
                  SELECT 1 FROM browser_sessions bs
                   WHERE bs.tenant_id = s.tenant_id
                     AND bs.site_profile_id = s.id
                     AND (bs.expires_at IS NULL OR bs.expires_at > now())
                ) AS session_ready,
                (
                  SELECT max(bs.expires_at)
                    FROM browser_sessions bs
                   WHERE bs.tenant_id = s.tenant_id
                     AND bs.site_profile_id = s.id
                ) AS session_expires_at,
                (
                  SELECT bi.id::text
                    FROM browser_identities bi
                   WHERE bi.tenant_id = s.tenant_id
                     AND bi.site_profile_id = s.id
                   ORDER BY bi.version DESC, bi.created_at DESC, bi.id DESC
                   LIMIT 1
                ) AS default_browser_identity_id,
                (
                  SELECT np.id::text
                    FROM network_policies np
                   WHERE np.tenant_id = s.tenant_id
                   ORDER BY np.created_at DESC, np.id DESC
                   LIMIT 1
                ) AS default_network_policy_id,
                s.created_at, s.created_at::text AS cursor_at
           FROM site_profiles s
          WHERE s.tenant_id = $1::uuid
            AND ($2::text IS NULL OR s.risk = $2)
            AND ($3::timestamptz IS NULL OR (s.created_at, s.id) < ($3::timestamptz, $4::uuid))
          ORDER BY s.created_at DESC, s.id DESC
          LIMIT $5`,
        [principal.tenantId, risk ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );
      return result.rows;
    });

    reply.code(200).send(paginate(rows, limit, (r) => ({ createdAt: r.cursor_at, id: r.id }), mapSite));
  });

  // GET /v1/sites/{id} — 상세. 부재/cross-tenant → RESOURCE_NOT_FOUND(404).
  app.get<{ Params: { id: string } }>(
    "/v1/sites/:id",
    { config: { rbacAction: "site.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const id = request.params.id;
      if (!UUID_RE.test(id)) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const row = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
        const result = await c.query<SiteRow>(
          `SELECT s.id, s.name, s.risk, s.approved, s.circuit_state, s.url_pattern, s.page_state_selectors,
                  (s.page_state_selectors->>'loginUrl') IS NOT NULL AS login_capable,
                  EXISTS (
                    SELECT 1 FROM browser_sessions bs
                     WHERE bs.tenant_id = s.tenant_id
                       AND bs.site_profile_id = s.id
                       AND (bs.expires_at IS NULL OR bs.expires_at > now())
                  ) AS session_ready,
                  (
                    SELECT max(bs.expires_at)
                      FROM browser_sessions bs
                     WHERE bs.tenant_id = s.tenant_id
                       AND bs.site_profile_id = s.id
                  ) AS session_expires_at,
                  (
                    SELECT bi.id::text
                      FROM browser_identities bi
                     WHERE bi.tenant_id = s.tenant_id
                       AND bi.site_profile_id = s.id
                     ORDER BY bi.version DESC, bi.created_at DESC, bi.id DESC
                     LIMIT 1
                  ) AS default_browser_identity_id,
                  (
                    SELECT np.id::text
                      FROM network_policies np
                     WHERE np.tenant_id = s.tenant_id
                     ORDER BY np.created_at DESC, np.id DESC
                     LIMIT 1
                  ) AS default_network_policy_id,
                  s.created_at, s.created_at::text AS cursor_at
             FROM site_profiles s WHERE s.id = $1::uuid`,
          [id],
        );
        return result.rows[0] ?? null;
      });
      if (row === null) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      reply.code(200).send(mapSite(row));
    },
  );
}
