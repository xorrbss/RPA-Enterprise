import type { FastifyInstance } from "fastify";

import { withTenantTx } from "../db/pool";
import { requirePrincipal, type ApiServerDeps } from "./server";

type SearchType = "run" | "scenario" | "human_task" | "principal" | "credential";

interface SearchItem {
  readonly type: SearchType;
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
  readonly route: string;
  readonly matched_field: string;
}

interface SearchRow {
  readonly type: SearchType;
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
  readonly route: string;
  readonly matched_field: string;
  readonly rank_bucket: number;
}

export function registerSearchRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get<{ Querystring: { q?: string; limit?: string } }>(
    "/v1/search",
    { config: { rbacAction: "run.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const q = typeof request.query.q === "string" ? request.query.q.trim() : "";
      const limit = parseLimit(request.query.limit);
      if (q.length < 2) {
        reply.code(200).send({ items: [], next_cursor: null });
        return;
      }
      const items = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
        const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
        const result = await client.query<SearchRow>(
          `
          SELECT * FROM (
            SELECT 'run'::text AS type,
                   r.id::text AS id,
                   'Run ' || left(r.id::text, 8) AS label,
                   r.status || COALESCE(' · ' || sv.scenario_id::text, '') AS description,
                   '/runs/' || r.id::text AS route,
                   CASE WHEN r.id::text ILIKE $2 THEN 'run_id' ELSE 'status' END AS matched_field,
                   1 AS rank_bucket
              FROM runs r
              JOIN scenario_versions sv ON sv.tenant_id = r.tenant_id AND sv.id = r.scenario_version_id
             WHERE r.tenant_id = $1::uuid
               AND (r.id::text ILIKE $2 OR r.status ILIKE $2 OR sv.scenario_id::text ILIKE $2)
            UNION ALL
            SELECT 'scenario'::text AS type,
                   s.id::text AS id,
                   s.name AS label,
                   CASE WHEN s.archived_at IS NULL THEN 'active' ELSE 'archived' END || COALESCE(' · v' || latest.version::text, '') AS description,
                   '/scenarios/' || s.id::text AS route,
                   CASE WHEN s.name ILIKE $2 THEN 'name' ELSE 'scenario_id' END AS matched_field,
                   2 AS rank_bucket
              FROM scenarios s
              LEFT JOIN LATERAL (
                SELECT max(version) AS version
                  FROM scenario_versions sv
                 WHERE sv.tenant_id = s.tenant_id
                   AND sv.scenario_id = s.id
              ) latest ON true
             WHERE s.tenant_id = $1::uuid
               AND (s.id::text ILIKE $2 OR s.name ILIKE $2)
            UNION ALL
            SELECT 'human_task'::text AS type,
                   h.id::text AS id,
                   'Human task ' || left(h.id::text, 8) AS label,
                   h.kind || ' · ' || h.state || COALESCE(' · ' || h.assignee, '') AS description,
                   '/human-tasks/' || h.id::text AS route,
                   CASE WHEN h.id::text ILIKE $2 THEN 'human_task_id' WHEN h.run_id::text ILIKE $2 THEN 'run_id' ELSE 'state' END AS matched_field,
                   3 AS rank_bucket
              FROM human_tasks h
             WHERE h.tenant_id = $1::uuid
               AND (h.id::text ILIKE $2 OR h.run_id::text ILIKE $2 OR h.kind ILIKE $2 OR h.state ILIKE $2 OR h.assignee ILIKE $2)
            UNION ALL
            SELECT 'principal'::text AS type,
                   p.id::text AS id,
                   p.display_name AS label,
                   COALESCE(p.email, p.sub) AS description,
                   '/principals/' || p.id::text AS route,
                   CASE WHEN p.display_name ILIKE $2 THEN 'display_name' WHEN p.email ILIKE $2 THEN 'email' ELSE 'sub' END AS matched_field,
                   4 AS rank_bucket
              FROM principals p
             WHERE p.tenant_id = $1::uuid
               AND (p.id::text ILIKE $2 OR p.sub ILIKE $2 OR p.display_name ILIKE $2 OR p.email ILIKE $2)
            UNION ALL
            SELECT 'credential'::text AS type,
                   c.site_profile_id::text || ':' || c.credential_ref AS id,
                   COALESCE(c.label, c.credential_ref) AS label,
                   c.status || ' · ' || c.site_profile_id::text AS description,
                   '/credentials/' || c.site_profile_id::text || '/' || c.credential_ref AS route,
                   CASE WHEN c.credential_ref ILIKE $2 THEN 'credential_ref' ELSE 'label' END AS matched_field,
                   5 AS rank_bucket
              FROM credential_concurrency_policies c
             WHERE c.tenant_id = $1::uuid
               AND (c.credential_ref ILIKE $2 OR c.label ILIKE $2 OR c.owner_sub ILIKE $2 OR c.site_profile_id::text ILIKE $2)
          ) search_rows
          ORDER BY rank_bucket, label
          LIMIT $3::int
          `,
          [principal.tenantId, like, limit],
        );
        return result.rows.map(mapSearchRow);
      });
      reply.code(200).send({ items, next_cursor: null });
    },
  );
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 20;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return 20;
  return Math.min(parsed, 50);
}

function mapSearchRow(row: SearchRow): SearchItem {
  return {
    type: row.type,
    id: row.id,
    label: row.label,
    description: row.description,
    route: row.route,
    matched_field: row.matched_field,
  };
}
