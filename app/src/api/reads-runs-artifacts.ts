// reads-runs.ts 에서 추출 — run/scenario-generation artifact 목록 라우트(동작 무변경, api-surface §5).
import type { FastifyInstance } from "fastify";

import { withTenantTx } from "../db/pool";
import { ApiResponseError } from "../runtime/errors";
import { paginate, parsePageParams } from "./list-query";
import { UUID_RE } from "./reads-support";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";

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

export function registerRunArtifactReadRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
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
