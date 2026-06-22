// reads.ts 에서 추출 — human-task/principal 조회 라우트(동작 무변경, api-surface §1).
import type { FastifyInstance } from "fastify";

import type { HumanTaskKind, HumanTaskState } from "../../../ts/state-machine-types";
import { withTenantTx } from "../db/pool";
import { ApiResponseError } from "./errors";
import {
  humanTaskKindFilter,
  humanTaskStateFilter,
  paginate,
  parsePageParams,
  principalIdFilter,
  uuidFilter,
} from "./list-query";
import { UUID_RE } from "./reads-support";
import { requirePrincipal, type ApiServerDeps } from "./server";

interface HumanTaskRow {
  id: string;
  state: HumanTaskState;
  kind: HumanTaskKind;
  assignee: string | null;
  expires_at: Date | null;
  on_timeout: string;
  run_id: string;
  created_at: Date;
  cursor_at: string; // created_at::text(전정밀도) — keyset 커서(PAG-01)
}

interface PrincipalRow {
  id: string;
  sub: string;
  display_name: string;
  email: string | null;
  source: string;
  created_at: Date;
  cursor_at: string; // created_at::text(전정밀도) — keyset 커서(PAG-01)
}


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

export function registerPeopleReadRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
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
        `SELECT id, state, kind, assignee, expires_at, on_timeout, run_id, created_at, created_at::text AS cursor_at
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

    reply.code(200).send(paginate(rows, limit, (r) => ({ createdAt: r.cursor_at, id: r.id }), mapHumanTask));
  });

  // GET /v1/principals — 테넌트 담당자 디렉터리 커서 페이지(name-picker용). RLS 스코프. principal.read(viewer+).
  app.get("/v1/principals", { config: { rbacAction: "principal.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);

    const rows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const result = await c.query<PrincipalRow>(
        `SELECT id, sub, display_name, email, source, created_at, created_at::text AS cursor_at
           FROM principals
          WHERE tenant_id = $1::uuid
            AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT $4`,
        [principal.tenantId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );
      return result.rows;
    });

    reply.code(200).send(paginate(rows, limit, (r) => ({ createdAt: r.cursor_at, id: r.id }), mapPrincipal));
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
          `SELECT id, state, kind, assignee, expires_at, on_timeout, run_id, created_at, created_at::text AS cursor_at
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

}
