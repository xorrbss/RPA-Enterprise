// reads.ts 에서 추출 — run 조회 라우트(list/summary/trends; steps·artifacts 는 reads-runs-steps/reads-runs-artifacts 로 분리, 동작 무변경, api-surface §1·§5).
import type { FastifyInstance } from "fastify";

import type { RunState } from "../../../ts/state-machine-types";
import { withTenantTx } from "../db/pool";
import { ApiResponseError } from "../runtime/errors";
import { paginate, parsePageParams, runStateFilter, uuidFilter } from "./list-query";
import { registerRunArtifactReadRoutes } from "./reads-runs-artifacts";
import { registerRunStepReadRoutes } from "./reads-runs-steps";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";
import type { RunMode } from "./server-create-run";

interface RunListRow {
  id: string;
  status: RunState;
  priority: string;
  run_mode: RunMode;
  scenario_id: string;
  scenario_name: string;
  scenario_version_id: string;
  worker_id: string | null;
  attempts: number;
  as_of: Date | null;
  workitem_id: string | null;
  failure_reason: unknown;
  started_at: Date | null; // runs.started_at(R2 run.started) — 표시 전용 투영, 커서 무관
  ended_at: Date | null; // runs.ended_at(terminal 진입) — 표시 전용 투영, 커서 무관
  created_at: Date;
  cursor_at: string; // created_at::text(전정밀도) — keyset 커서 전용(PAG-01)
  updated_at: Date;
}

function runModeFilter(raw: unknown): RunMode | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (raw === "test" || raw === "prod") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_run_mode" });
}

function normalizeFailureReason(value: unknown): { code: string; message: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const code = typeof record.code === "string" && record.code.length > 0 ? record.code : "RUN_FAILED";
  const message = typeof record.message === "string" && record.message.length > 0 ? record.message : code;
  return { code, message };
}

// days 쿼리 파라미터 → [1,90] 정수(기본 30). 무효/범위초과는 조용히 클램프 — 표시 윈도우는 진실 주장이 아니라
// 분석 화면의 조회 범위이므로 파싱 실패로 화면을 막지 않는다(반환 데이터 자체는 윈도우에 대해 정직하다).
function trendWindowDays(raw: unknown): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(n)) return 30;
  return Math.max(1, Math.min(90, Math.trunc(n)));
}

export function registerRunReadRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  // GET /v1/runs — 커서 페이지(items=Run). filter: status(RunState)·scenario_version_id·scenario_id(전 버전 관통).
  //   scenarios JOIN 으로 자동화 이름을 함께 투영(실행 식별성 — 목록에서 어떤 자동화의 실행인지 식별). RLS 스코프.
  app.get("/v1/runs", { config: { rbacAction: "run.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);
    const status = runStateFilter(query.status);
    const runMode = runModeFilter(query.run_mode);
    const scenarioVersionId = uuidFilter(query.scenario_version_id, "invalid_scenario_version_id");
    const scenarioId = uuidFilter(query.scenario_id, "invalid_scenario_id");

    const rows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const result = await c.query<RunListRow>(
        `SELECT r.id, r.status, r.priority, r.run_mode, sv.scenario_id, s.name AS scenario_name, r.scenario_version_id,
                r.worker_id, r.attempts, r.as_of, r.workitem_id, r.failure_reason, r.started_at, r.ended_at, r.created_at,
                r.created_at::text AS cursor_at, r.updated_at
           FROM runs r
           JOIN scenario_versions sv ON sv.tenant_id = r.tenant_id AND sv.id = r.scenario_version_id
           JOIN scenarios s ON s.tenant_id = sv.tenant_id AND s.id = sv.scenario_id
          WHERE r.tenant_id = $1::uuid
            AND ($2::text IS NULL OR r.status = $2)
            AND ($3::text IS NULL OR r.run_mode = $3)
            AND ($4::uuid IS NULL OR r.scenario_version_id = $4::uuid)
            AND ($5::uuid IS NULL OR sv.scenario_id = $5::uuid)
            AND ($6::timestamptz IS NULL OR (r.created_at, r.id) < ($6::timestamptz, $7::uuid))
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT $8`,
        [
          principal.tenantId,
          status ?? null,
          runMode ?? null,
          scenarioVersionId ?? null,
          scenarioId ?? null,
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
        (r) => ({ createdAt: r.cursor_at, id: r.id }),
        (r) => ({
          run_id: r.id,
          status: r.status,
          priority: r.priority,
          run_mode: r.run_mode,
          scenario_id: r.scenario_id,
          scenario_name: r.scenario_name,
          scenario_version_id: r.scenario_version_id,
          worker_id: r.worker_id,
          attempts: r.attempts,
          as_of: r.as_of !== null ? r.as_of.toISOString() : null,
          workitem_id: r.workitem_id,
          failure_reason: normalizeFailureReason(r.failure_reason),
          // 소요 시간 표면화(F5) — 미시작/미종결은 null(클라이언트가 경과를 추정하지 않는다).
          started_at: r.started_at !== null ? r.started_at.toISOString() : null,
          ended_at: r.ended_at !== null ? r.ended_at.toISOString() : null,
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
  //   ?run_mode=test|prod(선택) — 대시보드 요약 카드와 드릴다운 목록(run_mode=prod)의 모집단 통일(A1-1).
  //   run_steps 에는 run_mode 가 없어 runs 조인으로 동일 모집단을 유지한다.
  app.get("/v1/runs/summary", { config: { rbacAction: "run.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const runMode = runModeFilter((request.query as Record<string, unknown>).run_mode);
    const { statusRows, cacheRows } = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const statuses = await c.query<{ status: string; n: string }>(
        `SELECT status, count(*)::text AS n FROM runs
          WHERE tenant_id = $1::uuid AND ($2::text IS NULL OR run_mode = $2)
          GROUP BY status`,
        [principal.tenantId, runMode],
      );
      const caches = await c.query<{ cache_mode: string; n: string }>(
        `SELECT rs.cache_mode, count(*)::text AS n
           FROM run_steps rs
           JOIN runs r ON r.id = rs.run_id AND r.tenant_id = rs.tenant_id
          WHERE rs.tenant_id = $1::uuid AND ($2::text IS NULL OR r.run_mode = $2)
          GROUP BY rs.cache_mode`,
        [principal.tenantId, runMode],
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

  // GET /v1/runs/trends — 테넌트-스코프 일별 run outcome 추세(분석: summary 스냅샷을 시계열로 확장). Asia/Seoul
  //   일 경계로 버킷팅하고 윈도우 내 모든 날을 포함한다(0건 날도 연속 시리즈 — 스파크라인 x축 연속). per-day
  //   success_rate = completed/(completed+failed_business+failed_system), 그 날 평가 대상 run 0이면 null(0/0 단정
  //   금지, "조용한 false 금지"). total=그 날 생성된 run 수(처리량). cancelled/queued/running 은 분모 제외(summary 동형).
  //   RLS 스코프, run.read. days=조회 윈도우(기본 30, [1,90] 클램프).
  //   ?run_mode=test|prod(선택) — summary 와 동일 모집단 정합(A1-1; 카드만 prod 면 스파크라인이 새 불일치가 된다).
  app.get("/v1/runs/trends", { config: { rbacAction: "run.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const windowDays = trendWindowDays(query.days);
    const runMode = runModeFilter(query.run_mode);
    const rows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const result = await c.query<{
        day: string;
        completed: number;
        failed_business: number;
        failed_system: number;
        total: number;
      }>(
        `WITH win AS (
           SELECT (now() AT TIME ZONE 'Asia/Seoul')::date AS today, ($2::int - 1) AS span
         ),
         days AS (
           SELECT generate_series(win.today - win.span, win.today, interval '1 day')::date AS day FROM win
         ),
         agg AS (
           SELECT (created_at AT TIME ZONE 'Asia/Seoul')::date AS day, status, count(*)::int AS n
             FROM runs, win
            WHERE tenant_id = $1::uuid
              AND ($3::text IS NULL OR run_mode = $3)
              AND (created_at AT TIME ZONE 'Asia/Seoul')::date >= win.today - win.span
            GROUP BY 1, 2
         )
         SELECT d.day::text AS day,
                COALESCE(SUM(a.n) FILTER (WHERE a.status = 'completed'), 0)::int AS completed,
                COALESCE(SUM(a.n) FILTER (WHERE a.status = 'failed_business'), 0)::int AS failed_business,
                COALESCE(SUM(a.n) FILTER (WHERE a.status = 'failed_system'), 0)::int AS failed_system,
                COALESCE(SUM(a.n), 0)::int AS total
           FROM days d
           LEFT JOIN agg a ON a.day = d.day
          GROUP BY d.day
          ORDER BY d.day`,
        [principal.tenantId, windowDays, runMode],
      );
      return result.rows;
    });
    reply.code(200).send({
      window_days: windowDays,
      timezone: "Asia/Seoul",
      points: rows.map((r) => {
        const rated = r.completed + r.failed_business + r.failed_system;
        return {
          day: r.day,
          completed: r.completed,
          failed_business: r.failed_business,
          failed_system: r.failed_system,
          total: r.total,
          success_rate: rated > 0 ? r.completed / rated : null,
        };
      }),
    });
  });

  registerRunStepReadRoutes(app, deps);
  registerRunArtifactReadRoutes(app, deps);
}
