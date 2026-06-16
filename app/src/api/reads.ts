/**
 * 운영 콘솔(D7) 조회(read) 라우트 (D6.5 — api-surface §1·§3 list/detail).
 *
 * command 라우트는 도메인별 모듈(scenarios/human-tasks/dlq)·server.ts에 있고, server.ts가 이미 500라인
 * 한도를 넘었으며 human-tasks.ts는 병렬 수정 중이라, 커서 페이지네이션 read 라우트는 본 모듈로 합친다
 * (functional cohesion = 콘솔 조회). RLS(withTenantTx) + read RBAC + list-query.ts(커서/필터) 재사용.
 *
 * 포함: listRuns, listHumanTasks, getHumanTask. (workitems/dlq/scenarios/sites/gateway read는 후속.)
 */
import type { FastifyInstance } from "fastify";

import type { HumanTaskKind, HumanTaskState, RunState, WorkitemState } from "../../../ts/state-machine-types";
import { withTenantTx } from "../db/pool";
import { ApiResponseError } from "./errors";
import {
  humanTaskKindFilter,
  humanTaskStateFilter,
  paginate,
  parsePageParams,
  runStateFilter,
  uuidFilter,
  workitemStateFilter,
} from "./list-query";
import { requirePrincipal, type ApiServerDeps } from "./server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RunListRow {
  id: string;
  status: RunState;
  scenario_version_id: string;
  worker_id: string | null;
  attempts: number;
  as_of: Date | null;
  workitem_id: string | null;
  created_at: Date;
}

interface HumanTaskRow {
  id: string;
  state: HumanTaskState;
  kind: HumanTaskKind;
  assignee: string | null;
  expires_at: Date | null;
  on_timeout: string;
  run_id: string;
  created_at: Date;
}

interface WorkitemRow {
  id: string;
  status: WorkitemState;
  attempts: number;
  unique_reference: string | null;
  checked_out_by: string | null;
  checked_out_at: Date | null;
  run_id: string | null;
  created_at: Date;
}

interface DeadLetterRow {
  id: string;
  workitem_id: string | null;
  created_at: Date;
}

interface SinkDlqRow {
  id: string;
  normalized_record_id: string;
  sink_idempotency_key: string;
  attempted_at: Date;
}

interface ScenarioRow {
  id: string;
  name: string;
  version: number;
  version_id: string;
  promotion_status: string;
  created_at: Date;
}

interface GatewayPolicyRow {
  model: string;
  version: number;
  capabilities: unknown;
  budget: unknown;
  fallback_config: unknown;
}

interface SiteRow {
  id: string;
  risk: string;
  approved: boolean;
  circuit_state: string;
  created_at: Date;
}

export function registerReadRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  // GET /v1/runs — 커서 페이지(items=Run). filter: status(RunState)·scenario_version_id. RLS 스코프.
  app.get("/v1/runs", { config: { rbacAction: "run.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);
    const status = runStateFilter(query.status);
    const scenarioVersionId = uuidFilter(query.scenario_version_id, "invalid_scenario_version_id");

    const rows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const result = await c.query<RunListRow>(
        `SELECT id, status, scenario_version_id, worker_id, attempts, as_of, workitem_id, created_at
           FROM runs
          WHERE tenant_id = $1::uuid
            AND ($2::text IS NULL OR status = $2)
            AND ($3::uuid IS NULL OR scenario_version_id = $3::uuid)
            AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT $6`,
        [
          principal.tenantId,
          status ?? null,
          scenarioVersionId ?? null,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          limit + 1,
        ],
      );
      return result.rows;
    });

    reply.code(200).send(
      paginate(
        rows,
        limit,
        (r) => ({ createdAt: r.created_at, id: r.id }),
        (r) => ({
          run_id: r.id,
          status: r.status,
          scenario_version_id: r.scenario_version_id,
          worker_id: r.worker_id,
          attempts: r.attempts,
          as_of: r.as_of !== null ? r.as_of.toISOString() : null,
          workitem_id: r.workitem_id,
          // runs에 진행-노드 컬럼 없음(계약 미약속) → null. 과다 렌더 금지.
          current_node: null,
        }),
      ),
    );
  });

  // GET /v1/human-tasks — 커서 페이지(items=HumanTask). filter: status·kind·assignee. RLS 스코프.
  app.get("/v1/human-tasks", { config: { rbacAction: "human_task.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);
    const status = humanTaskStateFilter(query.status);
    const kind = humanTaskKindFilter(query.kind);
    const assignee = uuidFilter(query.assignee, "invalid_assignee");

    const rows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const result = await c.query<HumanTaskRow>(
        `SELECT id, state, kind, assignee, expires_at, on_timeout, run_id, created_at
           FROM human_tasks
          WHERE tenant_id = $1::uuid
            AND ($2::text IS NULL OR state = $2)
            AND ($3::text IS NULL OR kind = $3)
            AND ($4::uuid IS NULL OR assignee = $4::uuid)
            AND ($5::timestamptz IS NULL OR (created_at, id) < ($5::timestamptz, $6::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT $7`,
        [
          principal.tenantId,
          status ?? null,
          kind ?? null,
          assignee ?? null,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          limit + 1,
        ],
      );
      return result.rows;
    });

    reply.code(200).send(paginate(rows, limit, (r) => ({ createdAt: r.created_at, id: r.id }), mapHumanTask));
  });

  // GET /v1/human-tasks/{id} — 상세. 부재/cross-tenant → RESOURCE_NOT_FOUND(404).
  app.get<{ Params: { id: string } }>(
    "/v1/human-tasks/:id",
    { config: { rbacAction: "human_task.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const id = request.params.id;
      if (!UUID_RE.test(id)) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const row = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
        const result = await c.query<HumanTaskRow>(
          `SELECT id, state, kind, assignee, expires_at, on_timeout, run_id, created_at
             FROM human_tasks WHERE id = $1::uuid`,
          [id],
        );
        return result.rows[0] ?? null;
      });
      if (row === null) {
        // RLS가 타테넌트 row를 숨기므로 cross-tenant도 동일하게 not-found(존재 비노출).
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      reply.code(200).send(mapHumanTask(row));
    },
  );

  // GET /v1/workitems — 커서 페이지(items=Workitem). filter: status(WorkitemState). RLS 스코프.
  //   target_id 필터/필드는 workitems에 컬럼 부재(connector target 테이블 미도입, release-decisions #6) →
  //   target_id 필터 제공 시 IR_SCHEMA_INVALID(조용한 무시 금지), 응답 target_id는 null.
  app.get("/v1/workitems", { config: { rbacAction: "workitem.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);
    const status = workitemStateFilter(query.status);
    if (query.target_id !== undefined) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "target_id_filter_unsupported" });
    }

    const rows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const result = await c.query<WorkitemRow>(
        `SELECT w.id, w.status, w.attempts, w.unique_reference, w.checked_out_by, w.checked_out_at, w.created_at,
                (SELECT r.id FROM runs r WHERE r.tenant_id = w.tenant_id AND r.workitem_id = w.id LIMIT 1) AS run_id
           FROM workitems w
          WHERE w.tenant_id = $1::uuid
            AND ($2::text IS NULL OR w.status = $2)
            AND ($3::timestamptz IS NULL OR (w.created_at, w.id) < ($3::timestamptz, $4::uuid))
          ORDER BY w.created_at DESC, w.id DESC
          LIMIT $5`,
        [principal.tenantId, status ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );
      return result.rows;
    });

    reply.code(200).send(paginate(rows, limit, (r) => ({ createdAt: r.created_at, id: r.id }), mapWorkitem));
  });

  // GET /v1/workitems/{id} — 상세. 부재/cross-tenant → RESOURCE_NOT_FOUND(404).
  app.get<{ Params: { id: string } }>(
    "/v1/workitems/:id",
    { config: { rbacAction: "workitem.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const id = request.params.id;
      if (!UUID_RE.test(id)) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const row = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
        const result = await c.query<WorkitemRow>(
          `SELECT w.id, w.status, w.attempts, w.unique_reference, w.checked_out_by, w.checked_out_at, w.created_at,
                  (SELECT r.id FROM runs r WHERE r.tenant_id = w.tenant_id AND r.workitem_id = w.id LIMIT 1) AS run_id
             FROM workitems w WHERE w.id = $1::uuid`,
          [id],
        );
        return result.rows[0] ?? null;
      });
      if (row === null) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      reply.code(200).send(mapWorkitem(row));
    },
  );

  // GET /v1/dlq — 데드레터 인박스(items 상태는 DEAD_LETTER 통지, ApiError 아님). RLS 스코프.
  //   본 엔드포인트는 두 소스를 분리 제공한다(api-surface §4, 병합 안 함):
  //     kind=workitem(기본) → dead_letter 테이블(미복원 replayed_at IS NULL)
  //     kind=sink          → 데이터평면 sink_deliveries.status='dead_letter'
  //   RBAC: 조회는 read(workitem.read, viewer+). replay 명령만 dlq.replay/sink_dlq.replay(operator+).
  app.get("/v1/dlq", { config: { rbacAction: "workitem.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);
    const kind = dlqKindFilter(query.kind);

    if (kind === "sink") {
      // sink DLQ(데이터평면): sink_deliveries.status='dead_letter'. DEAD_LETTER 상태 통지(ApiError 아님).
      // workitem dead_letter 테이블과 별개 소스(api-surface §4) — 병합하지 않는다.
      const sinkRows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
        const result = await c.query<SinkDlqRow>(
          `SELECT id, normalized_record_id, sink_idempotency_key, attempted_at
             FROM sink_deliveries
            WHERE tenant_id = $1::uuid
              AND status = 'dead_letter'
              AND ($2::timestamptz IS NULL OR (attempted_at, id) < ($2::timestamptz, $3::uuid))
            ORDER BY attempted_at DESC, id DESC
            LIMIT $4`,
          [principal.tenantId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
        );
        return result.rows;
      });
      reply.code(200).send(
        paginate(sinkRows, limit, (r) => ({ createdAt: r.attempted_at, id: r.id }), (r) => ({
          dead_letter_id: r.id,
          kind: "sink",
          status: "DEAD_LETTER",
          source_id: r.normalized_record_id,
          sink_idempotency_key: r.sink_idempotency_key,
        })),
      );
      return;
    }

    const rows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const result = await c.query<DeadLetterRow>(
        `SELECT id, workitem_id, created_at
           FROM dead_letter
          WHERE tenant_id = $1::uuid
            AND replayed_at IS NULL
            AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT $4`,
        [principal.tenantId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );
      return result.rows;
    });

    reply.code(200).send(
      paginate(rows, limit, (r) => ({ createdAt: r.created_at, id: r.id }), (r) => ({
        dead_letter_id: r.id,
        kind: "workitem",
        status: "DEAD_LETTER",
        source_id: r.workitem_id,
      })),
    );
  });

  // GET /v1/scenarios — 커서 페이지(items=Scenario: 메타 + 최신 version). RLS 스코프.
  //   list는 ir 본문 미포함(과다 렌더 금지) — 상세/편집은 getScenario.
  app.get("/v1/scenarios", { config: { rbacAction: "scenario.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);

    const rows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const result = await c.query<ScenarioRow>(
        `SELECT s.id, s.name, s.created_at, sv.version, sv.id AS version_id, sv.promotion_status
           FROM scenarios s
           JOIN LATERAL (
             SELECT id, version, promotion_status FROM scenario_versions v
              WHERE v.tenant_id = s.tenant_id AND v.scenario_id = s.id
              ORDER BY v.version DESC LIMIT 1
           ) sv ON true
          WHERE s.tenant_id = $1::uuid
            AND ($2::timestamptz IS NULL OR (s.created_at, s.id) < ($2::timestamptz, $3::uuid))
          ORDER BY s.created_at DESC, s.id DESC
          LIMIT $4`,
        [principal.tenantId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );
      return result.rows;
    });

    reply.code(200).send(
      paginate(rows, limit, (r) => ({ createdAt: r.created_at, id: r.id }), (r) => ({
        scenario_id: r.id,
        name: r.name,
        version: r.version,
        latest_version_id: r.version_id,
        promotion_status: r.promotion_status,
      })),
    );
  });

  // GET /v1/gateway/policy — 모델 정책(model/capabilities/budget/fallback). RLS 스코프.
  //   ?model= 지정 시 그 모델(부재 404). 미지정 시: 단일 정책이면 반환, 0건 404, 다건이면 model 필수(422).
  //   (계약상 model optional + 응답 단수 → 모호성을 명시적으로 해소; 조용한 임의선택 금지.)
  app.get("/v1/gateway/policy", { config: { rbacAction: "gateway_policy.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const model = query.model;
    if (model !== undefined && (typeof model !== "string" || model.length === 0)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_model" });
    }

    const rows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const result = await c.query<GatewayPolicyRow>(
        `SELECT model, version, capabilities, budget, fallback_config
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
    if (rows.length > 1) {
      // model 미지정 + 다건 → 단수 응답으로 임의 선택 불가(가정 금지).
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "model_required", available: rows.length });
    }
    // ETag = gateway_policies.version(api-surface §6/§0.3, PUT와 동일 ETag 대상). PUT If-Match의 선행 read.
    reply.header("ETag", String(rows[0].version));
    reply.code(200).send(mapGatewayPolicy(rows[0]));
  });

  // GET /v1/sites — 커서 페이지(items=Site). filter: risk(green|amber|red). RLS 스코프.
  app.get("/v1/sites", { config: { rbacAction: "site.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);
    const risk = siteRiskFilter(query.risk);

    const rows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const result = await c.query<SiteRow>(
        `SELECT id, risk, approved, circuit_state, created_at
           FROM site_profiles
          WHERE tenant_id = $1::uuid
            AND ($2::text IS NULL OR risk = $2)
            AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT $5`,
        [principal.tenantId, risk ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );
      return result.rows;
    });

    reply.code(200).send(paginate(rows, limit, (r) => ({ createdAt: r.created_at, id: r.id }), mapSite));
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
          `SELECT id, risk, approved, circuit_state, created_at FROM site_profiles WHERE id = $1::uuid`,
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

/** site risk 필터(green|amber|red). 무효→422. */
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
  };
}

/** Site 행 → 계약 응답. approval_status는 approved 불리언에서 도출. circuit_status=circuit_state. */
function mapSite(r: SiteRow): Record<string, unknown> {
  return {
    site_profile_id: r.id,
    risk: r.risk,
    approval_status: r.approved ? "approved" : "pending",
    circuit_status: r.circuit_state,
  };
}

/** dlq kind 필터(workitem|sink). 무효→422. */
function dlqKindFilter(raw: unknown): "workitem" | "sink" | undefined {
  if (raw === undefined) return undefined;
  if (raw === "workitem" || raw === "sink") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_kind" });
}

/** Workitem 행 → 계약 Workitem 응답. target_id는 컬럼 부재(release-decisions #6) → null. */
function mapWorkitem(r: WorkitemRow): Record<string, unknown> {
  return {
    workitem_id: r.id,
    status: r.status,
    attempts: r.attempts,
    unique_reference: r.unique_reference,
    target_id: null,
    checked_out_by: r.checked_out_by,
    checked_out_at: r.checked_out_at !== null ? r.checked_out_at.toISOString() : null,
    run_id: r.run_id,
  };
}

/** HumanTask 행 → 계약 HumanTask 응답. payload(kind별 본문)는 inline 저장 부재(payload_ref만) → v1 미포함. */
function mapHumanTask(r: HumanTaskRow): Record<string, unknown> {
  return {
    human_task_id: r.id,
    state: r.state,
    kind: r.kind,
    assignee: r.assignee,
    timeout: r.expires_at !== null ? r.expires_at.toISOString() : null,
    on_timeout: r.on_timeout,
    run_id: r.run_id,
  };
}
