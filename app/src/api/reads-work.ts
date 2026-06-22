// reads.ts 에서 추출 — workitem/DLQ 조회 라우트(동작 무변경, api-surface §1·§3).
import type { FastifyInstance } from "fastify";

import type { WorkitemState } from "../../../ts/state-machine-types";
import { withTenantTx } from "../db/pool";
import { ApiResponseError } from "./errors";
import { paginate, parsePageParams, workitemStateFilter } from "./list-query";
import { UUID_RE } from "./reads-support";
import { requirePrincipal, type ApiServerDeps } from "./server";

interface WorkitemRow {
  id: string;
  status: WorkitemState;
  attempts: number;
  unique_reference: string | null;
  checked_out_by: string | null;
  checked_out_at: Date | null;
  run_id: string | null;
  created_at: Date;
  cursor_at: string; // created_at::text(전정밀도) — keyset 커서 전용(PAG-01)
}

interface DeadLetterRow {
  id: string;
  workitem_id: string | null;
  reason_code: string;
  created_at: Date;
  cursor_at: string; // created_at::text(전정밀도) — keyset 커서 전용(PAG-01)
}

interface SinkDlqRow {
  id: string;
  normalized_record_id: string;
  sink_idempotency_key: string;
  attempted_at: Date;
  cursor_at: string; // attempted_at::text(전정밀도) — keyset 커서 전용(PAG-01)
}


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

export function registerWorkReadRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
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
        `SELECT w.id, w.status, w.attempts, w.unique_reference, w.checked_out_by, w.checked_out_at, w.created_at, w.created_at::text AS cursor_at,
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

    reply.code(200).send(paginate(rows, limit, (r) => ({ createdAt: r.cursor_at, id: r.id }), mapWorkitem));
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
          `SELECT w.id, w.status, w.attempts, w.unique_reference, w.checked_out_by, w.checked_out_at, w.created_at, w.created_at::text AS cursor_at,
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
          `SELECT id, normalized_record_id, sink_idempotency_key, attempted_at, attempted_at::text AS cursor_at
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
        paginate(sinkRows, limit, (r) => ({ createdAt: r.cursor_at, id: r.id }), (r) => ({
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
        `SELECT id, workitem_id, reason_code, created_at, created_at::text AS cursor_at
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
      paginate(rows, limit, (r) => ({ createdAt: r.cursor_at, id: r.id }), (r) => ({
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

}
