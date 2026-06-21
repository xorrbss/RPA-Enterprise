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
  principalIdFilter,
  runStateFilter,
  uuidFilter,
  workitemStateFilter,
} from "./list-query";
import { requirePrincipal, type ApiServerDeps } from "./server";
import { UUID_RE } from "./reads-support";
import { registerArtifactReadRoutes } from "./reads-artifacts";


interface RunListRow {
  id: string;
  status: RunState;
  scenario_version_id: string;
  worker_id: string | null;
  attempts: number;
  as_of: Date | null;
  workitem_id: string | null;
  failure_reason: unknown;
  created_at: Date;
  updated_at: Date;
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

interface PrincipalRow {
  id: string;
  sub: string;
  display_name: string;
  email: string | null;
  source: string;
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
  reason_code: string;
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
  created_at: Date;
}

interface RunStepRow {
  id: string;
  step_id: string;
  node_id: string;
  attempt: number;
  action: string;
  status: string;
  cache_mode: string;
  artifacts: string[];
  exception: { class?: unknown; code?: unknown } | null;
  started_at: Date | null;
  ended_at: Date | null;
  duration_ms: number | null;
  created_at: Date;
  stagehand_calls: unknown; // LATERAL json_agg(StagehandSummary[])
}

// run_steps.exception(jsonb)에서 분류만 노출 — message(RedactedString)·evidenceRefs는 평문/증빙이라 미노출(평문 차단).
function stepExceptionSummary(ex: { class?: unknown; code?: unknown } | null): { class: string; code: string } | null {
  if (ex === null || typeof ex !== "object") return null;
  const cls = typeof ex.class === "string" ? ex.class : "system";
  const code = typeof ex.code === "string" ? ex.code : "UNKNOWN";
  return { class: cls, code };
}

function normalizeFailureReason(value: unknown): { code: string; message: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const code = typeof record.code === "string" && record.code.length > 0 ? record.code : "RUN_FAILED";
  const message = typeof record.message === "string" && record.message.length > 0 ? record.message : code;
  return { code, message };
}

interface RunArtifactRow {
  id: string;
  step_id: string | null;
  attempt: number | null;
  type: string;
  media_type: string | null;
  filename: string | null;
  byte_size: string | null;
  duration_ms: number | null;
  redaction_status: string;
  retention_until: Date | null;
  legal_hold: boolean;
  created_at: Date;
}

function artifactListPage(rows: readonly RunArtifactRow[], limit: number) {
  return paginate(
    rows,
    limit,
    (r) => ({ createdAt: r.created_at, id: r.id }),
    (r) => ({
      artifact_id: r.id,
      step_id: r.step_id,
      attempt: r.attempt,
      type: r.type,
      media_type: r.media_type,
      filename: r.filename,
      byte_size: r.byte_size !== null ? Number(r.byte_size) : null,
      duration_ms: r.duration_ms,
      redaction_status: r.redaction_status,
      retention_until: r.retention_until !== null ? r.retention_until.toISOString() : null,
      legal_hold: r.legal_hold,
      created_at: r.created_at.toISOString(),
    }),
  );
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
        `SELECT id, status, scenario_version_id, worker_id, attempts, as_of, workitem_id, failure_reason, created_at, updated_at
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
          failure_reason: normalizeFailureReason(r.failure_reason),
          updated_at: r.updated_at.toISOString(),
          // runs에 진행-노드 컬럼 없음(계약 미약속) → null. 과다 렌더 금지.
          current_node: null,
        }),
      ),
    );
  });

  // GET /v1/runs/summary — 테넌트-스코프 run outcome 집계(관찰성 §E run_success_rate 의 DB 원천 재집계;
  //   OTel 메트릭은 백엔드 부재로 쿼리 불가). status별 정확 카운트 + 성공률. RLS 스코프, run.read.
  //   성공률 = completed / (completed+failed_business+failed_system) — 분모 0이면 null(0/0 단정 금지,
  //   "조용한 false 금지"). cancelled(사용자 취소)는 분모 제외(telemetry run_success_rate 와 동형).
  app.get("/v1/runs/summary", { config: { rbacAction: "run.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const { statusRows, cacheRows } = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const statuses = await c.query<{ status: string; n: string }>(
        `SELECT status, count(*)::text AS n FROM runs WHERE tenant_id = $1::uuid GROUP BY status`,
        [principal.tenantId],
      );
      const caches = await c.query<{ cache_mode: string; n: string }>(
        `SELECT cache_mode, count(*)::text AS n FROM run_steps WHERE tenant_id = $1::uuid GROUP BY cache_mode`,
        [principal.tenantId],
      );
      return { statusRows: statuses.rows, cacheRows: caches.rows };
    });
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of statusRows) {
      const n = Number(row.n);
      byStatus[row.status] = n;
      total += n;
    }
    const rated = (byStatus.completed ?? 0) + (byStatus.failed_business ?? 0) + (byStatus.failed_system ?? 0);
    const successRate = rated > 0 ? (byStatus.completed ?? 0) / rated : null;
    // cache_hit_rate(§E) — ActionPlanCache 조회 적중률. 분모=조회한 스텝(cache_mode != 'bypass'); bypass 는
    //   캐시 미조회(기본값/비대상 스텝)라 제외. hit/조회수, 조회 0이면 null(0/0 단정 금지). suspect/stale/
    //   quarantined 는 조회했으나 재사용 불가 → 분모 포함·비적중(telemetry recordCacheLookup 과 동형).
    const byMode: Record<string, number> = {};
    let consulted = 0;
    for (const row of cacheRows) {
      const n = Number(row.n);
      byMode[row.cache_mode] = n;
      if (row.cache_mode !== "bypass") consulted += n;
    }
    const hitRate = consulted > 0 ? (byMode.hit ?? 0) / consulted : null;
    reply.code(200).send({
      by_status: byStatus,
      success_rate: successRate,
      total,
      cache: { by_mode: byMode, hit_rate: hitRate },
    });
  });

  // GET /v1/runs/{run_id}/steps — run 하위 단계 트레이스(api-surface §1). 비민감 요약+참조만 노출(본문/증빙은
  //   GET /v1/artifacts/{id} 게이트 경유). 민감 컬럼(output·output_ref·input_redacted_ref·exception.message·
  //   page_state 본문)은 미노출(평문 차단). RLS 스코프 + run.read. 시간 오름차순(실행 순서) 커서 페이지.
  app.get<{ Params: { id: string } }>(
    "/v1/runs/:id/steps",
    { config: { rbacAction: "run.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const runId = request.params.id;
      if (!UUID_RE.test(runId)) {
        // 형식 무효 run_id는 존재 불가 → 404. 보이지 않는/없는 run은 빈 트레이스로 수렴(RLS, 존재 비노출).
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const { limit, cursor } = parsePageParams(request.query as Record<string, unknown>);

      const rows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
        const result = await c.query<RunStepRow>(
          `SELECT s.id, s.step_id, s.node_id, s.attempt, s.action, s.status, s.cache_mode,
                  s.artifacts, s.exception, s.started_at, s.ended_at, s.duration_ms, s.created_at,
                  COALESCE(sc.calls, '[]'::json) AS stagehand_calls
             FROM run_steps s
             LEFT JOIN LATERAL (
               SELECT json_agg(json_build_object(
                        'model', c2.model, 'transport', c2.transport, 'stream_status', c2.stream_status,
                        'ttfb_ms', c2.ttfb_ms, 'input_tokens', c2.input_tokens,
                        'output_tokens', c2.output_tokens, 'cost', c2.cost
                      ) ORDER BY c2.created_at) AS calls
                 FROM stagehand_calls c2
                WHERE c2.tenant_id = s.tenant_id AND c2.run_id = s.run_id
                  AND c2.step_id = s.step_id AND c2.attempt = s.attempt
             ) sc ON true
            WHERE s.tenant_id = $1::uuid AND s.run_id = $2::uuid
              AND ($3::timestamptz IS NULL OR (s.created_at, s.id) > ($3::timestamptz, $4::uuid))
            ORDER BY s.created_at ASC, s.id ASC
            LIMIT $5`,
          [principal.tenantId, runId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
        );
        return result.rows;
      });

      reply.code(200).send(
        paginate(
          rows,
          limit,
          (r) => ({ createdAt: r.created_at, id: r.id }),
          (r) => ({
            step_id: r.step_id,
            node_id: r.node_id,
            attempt: r.attempt,
            action: r.action,
            status: r.status,
            cache_mode: r.cache_mode,
            artifact_ids: r.artifacts,
            stagehand_calls: r.stagehand_calls,
            started_at: r.started_at !== null ? r.started_at.toISOString() : null,
            ended_at: r.ended_at !== null ? r.ended_at.toISOString() : null,
            duration_ms: r.duration_ms,
            exception: stepExceptionSummary(r.exception),
          }),
        ),
      );
    },
  );

  // GET /v1/runs/{run_id}/artifacts — run 하위 artifact 목록(api-surface §5). **metadata-only** — step provenance와
  //   media hints만 노출하고 content 본문·object_ref·sha256(원본 무결성 해시=fingerprint)은 미노출. 본문 열람은 GET /v1/artifacts/{id}(§10 audit 게이트). 목록은
  //   content를 read하지 않아 disclosure 경로 아님 → audit 불요. RLS artifacts_visible_isolation이 가시성(redacted/
  //   not_required·미삭제·비격리·동tenant) 강제. artifact.read RBAC(deny→SECRET_ACCESS_DENIED).
  app.get<{ Params: { id: string } }>(
    "/v1/runs/:id/artifacts",
    { config: { rbacAction: "artifact.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const runId = request.params.id;
      if (!UUID_RE.test(runId)) {
        // 형식 무효 run_id는 존재 불가 → 404. 보이지 않는/없는 run은 빈 목록으로 수렴(RLS, 존재 비노출).
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const { limit, cursor } = parsePageParams(request.query as Record<string, unknown>);

      const rows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
        const result = await c.query<RunArtifactRow>(
          `SELECT id, step_id, attempt, type, media_type, filename, byte_size::text AS byte_size, duration_ms,
                  redaction_status, retention_until, legal_hold, created_at
             FROM artifacts
            WHERE tenant_id = $1::uuid AND run_id = $2::uuid
              AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
            ORDER BY created_at DESC, id DESC
            LIMIT $5`,
          [principal.tenantId, runId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
        );
        return result.rows;
      });

      reply.code(200).send(artifactListPage(rows, limit));
    },
  );

  // GET /v1/scenario-generations/{generation_id}/artifacts — run 생성 전 planner artifact 목록.
  // run artifact 목록과 같은 disclosure 모델: metadata-only, 본문/blob는 /v1/artifacts/{id} 감사 게이트로 조회.
  app.get<{ Params: { id: string } }>(
    "/v1/scenario-generations/:id/artifacts",
    { config: { rbacAction: "artifact.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const generationId = request.params.id;
      if (!UUID_RE.test(generationId)) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const { limit, cursor } = parsePageParams(request.query as Record<string, unknown>);

      const rows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
        const result = await c.query<RunArtifactRow>(
          `SELECT id, step_id, attempt, type, media_type, filename, byte_size::text AS byte_size, duration_ms,
                  redaction_status, retention_until, legal_hold, created_at
             FROM artifacts
            WHERE tenant_id = $1::uuid AND generation_id = $2::uuid
              AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
            ORDER BY created_at DESC, id DESC
            LIMIT $5`,
          [principal.tenantId, generationId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
        );
        return result.rows;
      });

      reply.code(200).send(artifactListPage(rows, limit));
    },
  );

  // GET /v1/scenario-generations/{generation_id}/result-artifacts -- generation에 연결된 run 실행 결과 artifact 목록.
  // planner/output artifact와 분리해 자연어 생성 원장에서 screenshot/video 실행 결과를 바로 찾는다. metadata-only 목록이며
  // 본문/blob는 /v1/artifacts/{id} 감사 게이트로만 조회한다.
  app.get<{ Params: { id: string } }>(
    "/v1/scenario-generations/:id/result-artifacts",
    { config: { rbacAction: "artifact.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const generationId = request.params.id;
      if (!UUID_RE.test(generationId)) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const { limit, cursor } = parsePageParams(request.query as Record<string, unknown>);

      const rows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
        const generation = await c.query<{ run_id: string | null }>(
          `SELECT run_id
             FROM scenario_generations
            WHERE tenant_id = $1::uuid AND id = $2::uuid`,
          [principal.tenantId, generationId],
        );
        if (generation.rows.length === 0) {
          throw new ApiResponseError("RESOURCE_NOT_FOUND");
        }
        const runId = generation.rows[0].run_id;
        if (runId === null) {
          return [];
        }
        const result = await c.query<RunArtifactRow>(
          `SELECT id, step_id, attempt, type, media_type, filename, byte_size::text AS byte_size, duration_ms,
                  redaction_status, retention_until, legal_hold, created_at
             FROM artifacts
            WHERE tenant_id = $1::uuid AND run_id = $2::uuid
              AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
            ORDER BY created_at DESC, id DESC
            LIMIT $5`,
          [principal.tenantId, runId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
        );
        return result.rows;
      });

      reply.code(200).send(artifactListPage(rows, limit));
    },
  );

  // GET /v1/human-tasks — 커서 페이지(items=HumanTask). filter: status·kind·assignee. RLS 스코프.
  app.get("/v1/human-tasks", { config: { rbacAction: "human_task.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);
    const status = humanTaskStateFilter(query.status);
    const kind = humanTaskKindFilter(query.kind);
    const assignee = principalIdFilter(query.assignee, "invalid_assignee");
    const runId = uuidFilter(query.run_id, "invalid_run_id");

    const rows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const result = await c.query<HumanTaskRow>(
        `SELECT id, state, kind, assignee, expires_at, on_timeout, run_id, created_at
           FROM human_tasks
          WHERE tenant_id = $1::uuid
            AND ($2::text IS NULL OR state = $2)
            AND ($3::text IS NULL OR kind = $3)
            AND ($4::text IS NULL OR assignee = $4::text)
            AND ($5::uuid IS NULL OR run_id = $5::uuid)
            AND ($6::timestamptz IS NULL OR (created_at, id) < ($6::timestamptz, $7::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT $8`,
        [
          principal.tenantId,
          status ?? null,
          kind ?? null,
          assignee ?? null,
          runId ?? null,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          limit + 1,
        ],
      );
      return result.rows;
    });

    reply.code(200).send(paginate(rows, limit, (r) => ({ createdAt: r.created_at, id: r.id }), mapHumanTask));
  });

  // GET /v1/principals — 테넌트 담당자 디렉터리 커서 페이지(name-picker용). RLS 스코프. principal.read(viewer+).
  app.get("/v1/principals", { config: { rbacAction: "principal.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);

    const rows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const result = await c.query<PrincipalRow>(
        `SELECT id, sub, display_name, email, source, created_at
           FROM principals
          WHERE tenant_id = $1::uuid
            AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT $4`,
        [principal.tenantId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );
      return result.rows;
    });

    reply.code(200).send(paginate(rows, limit, (r) => ({ createdAt: r.created_at, id: r.id }), mapPrincipal));
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
  //     kind=sink          → 데이터평면 sink_deliveries.status='dead_letter'(미재처리 requeued_at IS NULL)
  //   RBAC: 조회는 read(workitem.read, viewer+). replay 명령만 dlq.replay/sink_dlq.replay(operator+).
  app.get("/v1/dlq", { config: { rbacAction: "workitem.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);
    const kind = dlqKindFilter(query.kind);

    if (kind === "sink") {
      // sink DLQ(데이터평면): sink_deliveries.status='dead_letter' 중 미재처리(requeued_at IS NULL).
      // DEAD_LETTER 상태 통지(ApiError 아님). workitem dead_letter(replayed_at IS NULL)와 동형 소거 필터 — 별개
      // 소스(api-surface §4, 병합 안 함). replay가 requeued_at을 마킹하면 다음 폴링부터 목록에서 빠진다.
      const sinkRows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
        const result = await c.query<SinkDlqRow>(
          `SELECT id, normalized_record_id, sink_idempotency_key, attempted_at
             FROM sink_deliveries
            WHERE tenant_id = $1::uuid
              AND status = 'dead_letter'
              AND requeued_at IS NULL
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
        `SELECT id, workitem_id, reason_code, created_at
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
        // reason_code(error-catalog ErrorCode)·created_at은 workitem DLQ만 투영(sink는 부재 — api-surface §4).
        reason_code: r.reason_code,
        created_at: r.created_at.toISOString(),
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
            AND s.archived_at IS NULL
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
        `SELECT s.id, s.name, s.risk, s.approved, s.circuit_state, s.url_pattern,
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
                s.created_at
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
          `SELECT s.id, s.name, s.risk, s.approved, s.circuit_state, s.url_pattern,
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
                  s.created_at
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

  // GET /v1/artifacts/{id} — 산출물 본문 조회(api-surface §5; release-decisions D8-A1). artifact.read RBAC + RLS 2단 게이트.
  registerArtifactReadRoutes(app, deps);
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

/** Principal 행 → 계약 Principal 응답(디렉터리 항목; name-picker용 메타데이터만). */
function mapPrincipal(r: PrincipalRow): Record<string, unknown> {
  return {
    principal_id: r.id,
    sub: r.sub,
    display_name: r.display_name,
    email: r.email,
    source: r.source,
  };
}
