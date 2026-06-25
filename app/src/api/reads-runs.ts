// reads.ts 에서 추출 — run 조회 라우트(list/summary/steps/artifacts, 동작 무변경, api-surface §1·§5).
import { Readable } from "node:stream";

import type { FastifyInstance } from "fastify";

import type { RunState } from "../../../ts/state-machine-types";
import { withTenantTx } from "../db/pool";
import { ApiResponseError } from "./errors";
import { paginate, parsePageParams, runStateFilter, uuidFilter } from "./list-query";
import { UUID_RE } from "./reads-support";
import { requirePrincipal, type ApiServerDeps } from "./server";

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
  cursor_at: string; // created_at::text(전정밀도) — keyset 커서 전용(PAG-01)
  updated_at: Date;
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
  cursor_at: string; // created_at::text(전정밀도) — keyset 커서 전용(PAG-01)
  stagehand_calls: unknown; // LATERAL json_agg(StagehandSummary[])
}

interface RunStepStreamSnapshot {
  readonly status: string | null;
  readonly step_count: number;
  readonly last_step_at: string | null;
  readonly run_updated_at: string | null;
}

const RUN_STEP_STREAM_POLL_MS = 1_000;
const RUN_STEP_STREAM_TERMINAL = new Set(["completed", "cancelled", "failed_business", "failed_system"]);

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
  cursor_at: string; // created_at::text(전정밀도) — keyset 커서 전용(PAG-01)
}

function artifactListPage(rows: readonly RunArtifactRow[], limit: number) {
  return paginate(
    rows,
    limit,
    (r) => ({ createdAt: r.cursor_at, id: r.id }),
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

// days 쿼리 파라미터 → [1,90] 정수(기본 30). 무효/범위초과는 조용히 클램프 — 표시 윈도우는 진실 주장이 아니라
// 분석 화면의 조회 범위이므로 파싱 실패로 화면을 막지 않는다(반환 데이터 자체는 윈도우에 대해 정직하다).
function trendWindowDays(raw: unknown): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(n)) return 30;
  return Math.max(1, Math.min(90, Math.trunc(n)));
}

export function registerRunReadRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  // GET /v1/runs — 커서 페이지(items=Run). filter: status(RunState)·scenario_version_id. RLS 스코프.
  app.get("/v1/runs", { config: { rbacAction: "run.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);
    const status = runStateFilter(query.status);
    const scenarioVersionId = uuidFilter(query.scenario_version_id, "invalid_scenario_version_id");

    const rows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const result = await c.query<RunListRow>(
        `SELECT id, status, scenario_version_id, worker_id, attempts, as_of, workitem_id, failure_reason, created_at, created_at::text AS cursor_at, updated_at
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
        (r) => ({ createdAt: r.cursor_at, id: r.id }),
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

  // GET /v1/runs/trends — 테넌트-스코프 일별 run outcome 추세(분석: summary 스냅샷을 시계열로 확장). Asia/Seoul
  //   일 경계로 버킷팅하고 윈도우 내 모든 날을 포함한다(0건 날도 연속 시리즈 — 스파크라인 x축 연속). per-day
  //   success_rate = completed/(completed+failed_business+failed_system), 그 날 평가 대상 run 0이면 null(0/0 단정
  //   금지, "조용한 false 금지"). total=그 날 생성된 run 수(처리량). cancelled/queued/running 은 분모 제외(summary 동형).
  //   RLS 스코프, run.read. days=조회 윈도우(기본 30, [1,90] 클램프).
  app.get("/v1/runs/trends", { config: { rbacAction: "run.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const windowDays = trendWindowDays((request.query as Record<string, unknown>).days);
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
        [principal.tenantId, windowDays],
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
                  s.artifacts, s.exception, s.started_at, s.ended_at, s.duration_ms, s.created_at, s.created_at::text AS cursor_at,
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
          (r) => ({ createdAt: r.cursor_at, id: r.id }),
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
    "/v1/runs/:id/steps/stream",
    { config: { rbacAction: "run.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const runId = request.params.id;
      if (!UUID_RE.test(runId)) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }

      const stream = new Readable({ read() {} });
      let closed = false;
      let lastSignature: string | null = null;
      let timer: ReturnType<typeof setInterval> | null = null;

      function pushEvent(event: string, data: unknown): void {
        if (closed) return;
        stream.push(`event: ${event}\n`);
        stream.push(`data: ${JSON.stringify(data)}\n\n`);
      }

      function closeStream(): void {
        if (closed) return;
        closed = true;
        if (timer !== null) clearInterval(timer);
        stream.push(null);
      }
      stream.on("close", () => {
        closed = true;
        if (timer !== null) clearInterval(timer);
      });

      async function snapshot(): Promise<RunStepStreamSnapshot> {
        return withTenantTx(deps.pool, principal.tenantId, async (c) => {
          const result = await c.query<{
            status: string | null;
            step_count: string;
            last_step_at: string | null;
            run_updated_at: string | null;
          }>(
            `SELECT r.status::text AS status,
                    count(s.id)::text AS step_count,
                    max(s.created_at)::text AS last_step_at,
                    r.updated_at::text AS run_updated_at
               FROM runs r
               LEFT JOIN run_steps s ON s.tenant_id = r.tenant_id AND s.run_id = r.id
              WHERE r.tenant_id = $1::uuid AND r.id = $2::uuid
              GROUP BY r.status, r.updated_at`,
            [principal.tenantId, runId],
          );
          const row = result.rows[0];
          if (row === undefined) return { status: null, step_count: 0, last_step_at: null, run_updated_at: null };
          return {
            status: row.status,
            step_count: Number(row.step_count),
            last_step_at: row.last_step_at,
            run_updated_at: row.run_updated_at,
          };
        });
      }

      async function tick(): Promise<void> {
        if (closed) return;
        try {
          const next = await snapshot();
          const signature = `${next.status ?? "missing"}:${next.step_count}:${next.last_step_at ?? ""}:${next.run_updated_at ?? ""}`;
          if (signature !== lastSignature) {
            lastSignature = signature;
            pushEvent("run_steps_changed", {
              run_id: runId,
              status: next.status,
              step_count: next.step_count,
              last_step_at: next.last_step_at,
              run_updated_at: next.run_updated_at,
            });
          }
          if (next.status === null || RUN_STEP_STREAM_TERMINAL.has(next.status)) {
            pushEvent("run_steps_closed", { run_id: runId, status: next.status });
            closeStream();
          }
        } catch (err) {
          request.log.warn({ err, run_id: runId, correlation_id: request.correlationId }, "run steps stream failed");
          pushEvent("run_steps_error", { run_id: runId });
          closeStream();
        }
      }

      stream.push(`retry: ${RUN_STEP_STREAM_POLL_MS}\n\n`);
      reply
        .code(200)
        .header("Content-Type", "text/event-stream; charset=utf-8")
        .header("Cache-Control", "no-cache, no-transform")
        .header("Connection", "keep-alive")
        .send(stream);
      await tick();
      if (!closed) {
        timer = setInterval(() => void tick(), RUN_STEP_STREAM_POLL_MS);
      }
    },
  );

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
                  redaction_status, retention_until, legal_hold, created_at, created_at::text AS cursor_at
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
                  redaction_status, retention_until, legal_hold, created_at, created_at::text AS cursor_at
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
                  redaction_status, retention_until, legal_hold, created_at, created_at::text AS cursor_at
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

}
