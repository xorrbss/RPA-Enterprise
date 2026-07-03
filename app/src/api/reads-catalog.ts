// reads.ts 에서 추출 — scenario/gateway-policy/site 조회 라우트(동작 무변경, api-surface §1·§3).
import type { FastifyInstance } from "fastify";

import { withTenantTx } from "../db/pool";
import { ApiResponseError } from "./errors";
import { paginate, parsePageParams } from "./list-query";
import { UUID_RE } from "./reads-support";
import { mapScenarioCertification, type ScenarioCertificationRow } from "./scenario-certification";
import { requirePrincipal, type ApiServerDeps } from "./server";
import { summarizePageStateSelectors } from "./site-page-state-contract";

// ── gateway call-summary(B4): stagehand_calls 사용량/비용 집계 ──
interface GatewayCallSummaryRow {
  model: string;
  calls: string;
  input_tokens: string | null;
  output_tokens: string | null;
  cost: string | null;
}

// days 윈도우 → [1,90] 정수(기본 30). 무효는 조용히 클램프(표시 윈도우는 진실 주장이 아니라 조회 범위).
function callSummaryWindowDays(raw: unknown): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(n)) return 30;
  return Math.max(1, Math.min(90, Math.trunc(n)));
}

// 집계 행 → 응답 figure. 토큰=number(int 합), cost=string(numeric 정밀도 보존). sum 이 전부 NULL이면 null 유지(0 단정 금지).
function callSummaryFigures(
  row: { calls: string; input_tokens: string | null; output_tokens: string | null; cost: string | null } | undefined,
): { calls: number; input_tokens: number | null; output_tokens: number | null; cost: string | null } {
  if (row === undefined) return { calls: 0, input_tokens: null, output_tokens: null, cost: null };
  return {
    calls: Number(row.calls),
    input_tokens: row.input_tokens === null ? null : Number(row.input_tokens),
    output_tokens: row.output_tokens === null ? null : Number(row.output_tokens),
    cost: row.cost,
  };
}

interface ScenarioRow extends ScenarioCertificationRow {
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
  // 기간 한정 승인 표면화(A3-3): 만료 경과 시 approval_status=expired(런타임 SITE_PROFILE_BLOCKED 게이트와 동일 판정).
  approval_expired: boolean;
  approved_by: string | null;
  approved_at: Date | null;
  approval_expires_at: Date | null;
  circuit_state: string;
  url_pattern: string;
  // 운영자-보조 세션 캡처 가능 여부 — page_state_selectors.loginUrl 설정 사이트만 '세션 등록' 노출(미설정 사이트의 412 클릭 회피).
  login_capable: boolean;
  session_ready: boolean;
  session_expires_at: Date | null;
  enc_kid: string | null;
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

/** Site 행 → 계약 응답. approval_status: 미승인=pending, 승인 후 만료 경과=expired(게이트 복귀), 그 외=approved. */
function mapSite(r: SiteRow): Record<string, unknown> {
  return {
    site_profile_id: r.id,
    name: r.name,
    url_pattern: r.url_pattern,
    risk: r.risk,
    approval_status: !r.approved ? "pending" : r.approval_expired ? "expired" : "approved",
    approved_by: r.approved_by,
    approved_at: r.approved_at !== null ? r.approved_at.toISOString() : null,
    approval_expires_at: r.approval_expires_at !== null ? r.approval_expires_at.toISOString() : null,
    circuit_status: r.circuit_state,
    login_capable: r.login_capable,
    session_ready: r.session_ready,
    session_expires_at: r.session_expires_at !== null ? r.session_expires_at.toISOString() : null,
    enc_kid: r.enc_kid,
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
        `SELECT s.id, s.name, s.created_at, s.created_at::text AS cursor_at,
                sv.version, sv.id AS version_id, sv.promotion_status,
                sv.certification_status, sv.certified_by, sv.certified_at,
                sv.certification_expires_at, sv.certification_reason,
                sv.certification_revoked_by, sv.certification_revoked_at,
                sv.certification_revoke_reason, sv.governance_stage,
                sv.governance_reason, sv.governance_evidence_ref, sv.governance_metadata,
                sv.governance_updated_by, sv.governance_updated_at
           FROM scenarios s
           JOIN LATERAL (
             SELECT id, version, promotion_status, certification_status, certified_by, certified_at,
                     certification_expires_at, certification_reason, certification_revoked_by,
                     certification_revoked_at, certification_revoke_reason, governance_stage,
                     governance_reason, governance_evidence_ref, governance_metadata,
                     governance_updated_by, governance_updated_at
               FROM scenario_versions v
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
        certification: mapScenarioCertification(r),
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

  // GET /v1/gateway/call-summary — 테넌트-스코프 LLM 호출 사용량/비용 집계(stagehand_calls GROUP BY model, 기간 윈도우).
  //   모델별 호출수·입력/출력 토큰 합·비용 합 + 전체 합계. 토큰/비용이 전부 NULL이면 합도 null(0 단정 금지, "조용한
  //   false 금지"). 비용 DESC(NULL 마지막) 정렬. RLS 스코프, gateway_policy.read. days=조회 윈도우(기본 30, [1,90] 클램프).
  app.get("/v1/gateway/call-summary", { config: { rbacAction: "gateway_policy.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const windowDays = callSummaryWindowDays((request.query as Record<string, unknown>).days);
    const { modelRows, totalRow } = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const models = await c.query<GatewayCallSummaryRow>(
        `SELECT model, count(*)::text AS calls,
                sum(input_tokens)::text AS input_tokens,
                sum(output_tokens)::text AS output_tokens,
                sum(cost)::text AS cost
           FROM stagehand_calls
          WHERE tenant_id = $1::uuid AND created_at >= now() - ($2::int || ' days')::interval
          GROUP BY model
          ORDER BY sum(cost) DESC NULLS LAST, model ASC`,
        [principal.tenantId, windowDays],
      );
      const total = await c.query<Omit<GatewayCallSummaryRow, "model">>(
        `SELECT count(*)::text AS calls,
                sum(input_tokens)::text AS input_tokens,
                sum(output_tokens)::text AS output_tokens,
                sum(cost)::text AS cost
           FROM stagehand_calls
          WHERE tenant_id = $1::uuid AND created_at >= now() - ($2::int || ' days')::interval`,
        [principal.tenantId, windowDays],
      );
      return { modelRows: models.rows, totalRow: total.rows[0] };
    });
    reply.code(200).send({
      window_days: windowDays,
      total: callSummaryFigures(totalRow),
      by_model: modelRows.map((r) => ({ model: r.model, ...callSummaryFigures(r) })),
    });
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
                (s.approval_expires_at IS NOT NULL AND s.approval_expires_at <= now()) AS approval_expired,
                s.approved_by, s.approved_at, s.approval_expires_at,
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
                  SELECT bs.enc_kid
                    FROM browser_sessions bs
                   WHERE bs.tenant_id = s.tenant_id
                     AND bs.site_profile_id = s.id
                   ORDER BY bs.updated_at DESC, bs.created_at DESC
                   LIMIT 1
                ) AS enc_kid,
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
                  (s.approval_expires_at IS NOT NULL AND s.approval_expires_at <= now()) AS approval_expired,
                  s.approved_by, s.approved_at, s.approval_expires_at,
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
                    SELECT bs.enc_kid
                      FROM browser_sessions bs
                     WHERE bs.tenant_id = s.tenant_id
                       AND bs.site_profile_id = s.id
                     ORDER BY bs.updated_at DESC, bs.created_at DESC
                     LIMIT 1
                  ) AS enc_kid,
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

  // GET /v1/sites/{id}/approvals — 사이트 승인 이력(site_profile_approvals, 불변 감사 원장) 최신순.
  //   고위험 승인의 사후 감사(누가/언제/왜/만료)를 콘솔에서 닫는다(A3-7) — 이전에는 INSERT만 있고 조회 경로가 없어
  //   DB 직접 조회가 필요했다. 부재/cross-tenant(RLS) → 404(존재 비노출). idx_site_profile_approvals_site 커버.
  app.get<{ Params: { id: string } }>(
    "/v1/sites/:id/approvals",
    { config: { rbacAction: "site.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const id = request.params.id;
      if (!UUID_RE.test(id)) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const items = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
        const site = await c.query(`SELECT 1 FROM site_profiles WHERE id = $1::uuid`, [id]);
        if ((site.rowCount ?? 0) === 0) return null;
        const result = await c.query<{ approved_by: string; reason: string | null; expires_at: Date | null; created_at: Date }>(
          `SELECT approved_by, reason, expires_at, created_at
             FROM site_profile_approvals
            WHERE site_profile_id = $1::uuid
            ORDER BY created_at DESC
            LIMIT 20`,
          [id],
        );
        return result.rows;
      });
      if (items === null) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      reply.code(200).send({
        items: items.map((r) => ({
          approved_by: r.approved_by,
          reason: r.reason,
          expires_at: r.expires_at !== null ? r.expires_at.toISOString() : null,
          created_at: r.created_at.toISOString(),
        })),
        next_cursor: null,
      });
    },
  );
}
