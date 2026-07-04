// reads-runs.ts 에서 추출 — run 단계 트레이스 라우트(steps/steps stream, 동작 무변경, api-surface §1).
import { Readable } from "node:stream";

import type { FastifyInstance } from "fastify";

import { withTenantTx } from "../db/pool";
import { ApiResponseError } from "../runtime/errors";
import { paginate, parsePageParams } from "./list-query";
import { UUID_RE } from "./reads-support";
import { requirePrincipal, type ApiServerDeps, isRecord } from "./server-shared";

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

const SECRETISH_RE = /\b(secret|password|passwd|token|bearer|authorization|cookie|api[_-]?key|credential|otp|mfa)\b/i;

function safeSummaryText(value: unknown, maxLength = 160): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (SECRETISH_RE.test(trimmed)) return "[redacted]";
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

function firstSummaryText(record: Readonly<Record<string, unknown>>, keys: readonly string[], maxLength?: number): string | null {
  for (const key of keys) {
    const value = safeSummaryText(record[key], maxLength);
    if (value !== null) return value;
  }
  return null;
}

function stagehandActionSummary(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const operation = firstSummaryText(value, ["operation", "method", "action"], 48);
  const selector = firstSummaryText(value, ["selector", "target_selector", "selector_ref"], 160);
  const instruction = firstSummaryText(value, ["instruction", "goal", "description"], 160);
  if (operation === null && selector === null && instruction === null) return null;

  const parts: string[] = [];
  if (operation !== null) parts.push(operation);
  if (selector !== null) parts.push(selector);
  if (instruction !== null) parts.push(`instruction: ${instruction}`);
  if (operation === "fill" || operation === "select" || Object.prototype.hasOwnProperty.call(value, "value") || Object.prototype.hasOwnProperty.call(value, "valueRef") || Object.prototype.hasOwnProperty.call(value, "value_ref")) {
    parts.push("value redacted");
  }
  return parts.join(" · ");
}

function normalizeStagehandCalls(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((call) => ({
    model: typeof call.model === "string" ? call.model : null,
    transport: typeof call.transport === "string" ? call.transport : null,
    stream_status: typeof call.stream_status === "string" ? call.stream_status : null,
    ttfb_ms: typeof call.ttfb_ms === "number" ? call.ttfb_ms : null,
    input_tokens: typeof call.input_tokens === "number" ? call.input_tokens : null,
    output_tokens: typeof call.output_tokens === "number" ? call.output_tokens : null,
    cost: typeof call.cost === "string" ? call.cost : call.cost !== null && call.cost !== undefined ? String(call.cost) : null,
    action_summary: stagehandActionSummary(call.parsed_json),
  }));
}

export function registerRunStepReadRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
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
                        'output_tokens', c2.output_tokens, 'cost', c2.cost,
                        'parsed_json', c2.parsed_json
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
            stagehand_calls: normalizeStagehandCalls(r.stagehand_calls),
            started_at: r.started_at !== null ? r.started_at.toISOString() : null,
            ended_at: r.ended_at !== null ? r.ended_at.toISOString() : null,
            duration_ms: r.duration_ms,
            exception: stepExceptionSummary(r.exception),
          }),
        ),
      );
    },
  );

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
}
