// offboarding-export.ts 의 sibling — 원문(raw) JSONL 반출 라우트(설계 O1). metadata CSV(전량 동기)와 달리
// 원문 행은 jsonb 본문을 실어 크므로 keyset 커서로 나눈다. 공유 경계(감사·날짜 필터)는 offboarding-export 에서 가져온다.
import type { FastifyInstance } from "fastify";

import { withTenantTx } from "../db/pool";
import { ApiResponseError } from "./errors";
import { decodeCursor, paginate, type PageCursor } from "./list-query";
import {
  dateTimeFilter,
  iso,
  nullableIso,
  recordOffboardingAudit,
  requireOffboardingSecurityAudit,
} from "./offboarding-export";
import { requirePrincipal, type ApiServerDeps } from "./server";

const RAW_EXPORT_DEFAULT_LIMIT = 1000;
const RAW_EXPORT_MAX_LIMIT = 5000;

type RawExportSection = "runs" | "human_tasks";

interface RawRunRow {
  readonly run_id: string;
  readonly scenario_id: string;
  readonly scenario_name: string;
  readonly created_at: Date;
  readonly cursor_at: string;
  readonly params: unknown;
}

interface RawHumanTaskRow {
  readonly human_task_id: string;
  readonly run_id: string;
  readonly kind: string;
  readonly state: string;
  readonly created_at: Date;
  readonly cursor_at: string;
  readonly resolved_at: Date | null;
  readonly payload: unknown;
  readonly result: unknown;
  readonly result_schema: unknown;
  readonly payload_ref: string | null;
}

export function registerOffboardingRawExportRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  // 원문(raw) 반출 — runs.params / human task payload·result 원문을 JSONL(기계 재수입 가능)로 반출한다(설계 O1).
  // resume_token/bookmark/failure_reason.message/자격·쿠키·SecretRef 해석값은 어떤 반출에도 미포함(§2 전제).
  // artifact 본문은 본 라우트가 아니라 기존 GET /v1/artifacts/{id}/blob(RLS redaction 게이트+개별 audit) 재사용.
  app.get("/v1/offboarding/export/raw", { config: { rbacAction: "tenant_data.export" } }, async (request, reply) => {
    const securityAudit = requireOffboardingSecurityAudit(deps);
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const section = rawExportSectionFilter(query.section);
    const createdAtFrom = dateTimeFilter(query.created_at_from, "invalid_created_at_from");
    const createdAtTo = dateTimeFilter(query.created_at_to, "invalid_created_at_to");
    if (createdAtFrom !== null && createdAtTo !== null && createdAtFrom.getTime() > createdAtTo.getTime()) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_created_at_range" });
    }
    const limit = parseRawExportLimit(query.limit);
    const cursor = decodeCursor(query.cursor);

    const page = section === "runs"
      ? await selectRawRunsPage(deps, principal.tenantId, createdAtFrom, createdAtTo, cursor, limit)
      : await selectRawHumanTasksPage(deps, principal.tenantId, createdAtFrom, createdAtTo, cursor, limit);

    await recordOffboardingAudit(securityAudit, request, principal, "tenant_data.export", "offboarding_raw_export_disclosed", {
      decision_kind: "tenant_data.export",
      delivery: "raw_jsonl",
      section,
      created_at_from: nullableIso(createdAtFrom),
      created_at_to: nullableIso(createdAtTo),
      row_count: page.items.length,
      has_more: page.next_cursor !== null,
    });

    const filename = `offboarding-raw-${section}-${new Date().toISOString().slice(0, 10)}.jsonl`;
    reply
      .code(200)
      .header("content-type", "application/x-ndjson; charset=utf-8")
      .header("content-disposition", `attachment; filename="${filename}"`);
    if (page.next_cursor !== null) {
      // 커서 체이닝은 응답 헤더로 — 본문은 순수 데이터 행만(재수입 시 제어행 오염 금지).
      reply.header("x-next-cursor", page.next_cursor);
    }
    reply.send(page.items.length === 0 ? "" : `${page.items.map((item) => JSON.stringify(item)).join("\n")}\n`);
  });
}

function rawExportSectionFilter(raw: unknown): RawExportSection {
  if (raw === "runs" || raw === "human_tasks") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_section" });
}

/** raw 반출 전용 limit(기본 1000, 상한 5000 캡) — 공용 parseLimit(기본 50/상한 200)과 운영 한도가 다르다. */
function parseRawExportLimit(raw: unknown): number {
  if (raw === undefined) return RAW_EXPORT_DEFAULT_LIMIT;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_limit" });
  }
  const n = Number.parseInt(raw, 10);
  if (n < 1) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_limit" });
  }
  return Math.min(n, RAW_EXPORT_MAX_LIMIT);
}

async function selectRawRunsPage(
  deps: ApiServerDeps,
  tenantId: string,
  createdAtFrom: Date | null,
  createdAtTo: Date | null,
  cursor: PageCursor | null,
  limit: number,
): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
  const rows = await withTenantTx(deps.pool, tenantId, async (client) => {
    const result = await client.query<RawRunRow>(
      `SELECT r.id AS run_id, sv.scenario_id, s.name AS scenario_name,
              r.created_at, r.created_at::text AS cursor_at, r.params
         FROM runs r
         JOIN scenario_versions sv ON sv.tenant_id = r.tenant_id AND sv.id = r.scenario_version_id
         JOIN scenarios s ON s.tenant_id = sv.tenant_id AND s.id = sv.scenario_id
        WHERE r.tenant_id = $1::uuid
          AND ($2::timestamptz IS NULL OR r.created_at >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR r.created_at <= $3::timestamptz)
          AND ($4::timestamptz IS NULL OR (r.created_at, r.id) < ($4::timestamptz, $5::uuid))
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT $6`,
      [tenantId, createdAtFrom, createdAtTo, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
    );
    return result.rows;
  });
  return paginate(rows, limit, (row) => ({ createdAt: row.cursor_at, id: row.run_id }), (row) => ({
    run_id: row.run_id,
    scenario_id: row.scenario_id,
    scenario_name: row.scenario_name,
    created_at: iso(row.created_at),
    params: row.params ?? null,
  }));
}

async function selectRawHumanTasksPage(
  deps: ApiServerDeps,
  tenantId: string,
  createdAtFrom: Date | null,
  createdAtTo: Date | null,
  cursor: PageCursor | null,
  limit: number,
): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
  const rows = await withTenantTx(deps.pool, tenantId, async (client) => {
    const result = await client.query<RawHumanTaskRow>(
      `SELECT id AS human_task_id, run_id, kind, state,
              created_at, created_at::text AS cursor_at, resolved_at,
              payload, result, result_schema, payload_ref
         FROM human_tasks
        WHERE tenant_id = $1::uuid
          AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR created_at <= $3::timestamptz)
          AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $6`,
      [tenantId, createdAtFrom, createdAtTo, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
    );
    return result.rows;
  });
  return paginate(rows, limit, (row) => ({ createdAt: row.cursor_at, id: row.human_task_id }), (row) => ({
    human_task_id: row.human_task_id,
    run_id: row.run_id,
    kind: row.kind,
    state: row.state,
    created_at: iso(row.created_at),
    resolved_at: nullableIso(row.resolved_at),
    payload: row.payload ?? null,
    result: row.result ?? null,
    result_schema: row.result_schema ?? null,
    payload_ref: row.payload_ref,
  }));
}
