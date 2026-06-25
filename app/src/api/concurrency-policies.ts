import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import { requirePrincipal, type ApiServerDeps } from "./server";

interface ConcurrencyPolicyRow {
  readonly credential_ref: string;
  readonly site_profile_id: string;
  readonly site_name: string | null;
  readonly max_concurrency: number;
  readonly active_leases: string;
}

interface ConcurrencyPolicyItem {
  readonly credential_ref: string;
  readonly site_profile_id: string;
  readonly site_name: string | null;
  readonly max_concurrency: number;
  readonly active_leases: number;
}

export function registerConcurrencyPolicyRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  // 자격증명 동시성 정책 + 현재 사용량(거버넌스 가시화, D5). 정책당 max_concurrency 와 status='active' 또한
  // 만료 전(locked_until>now) lease 수를 합산해 운영자가 동시성 한도 대비 사용률을 본다. 정책 미설정 시 빈 목록.
  app.get("/v1/credentials/concurrency", { config: { rbacAction: "ops_alert.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const items = await withTenantTx(deps.pool, principal.tenantId, async (client) =>
      readConcurrencyPolicies(client, principal.tenantId),
    );
    reply.code(200).send({ items, next_cursor: null });
  });
}

async function readConcurrencyPolicies(client: PoolClient, tenantId: string): Promise<readonly ConcurrencyPolicyItem[]> {
  const result = await client.query<ConcurrencyPolicyRow>(
    `SELECT
        p.credential_ref,
        p.site_profile_id::text AS site_profile_id,
        sp.name AS site_name,
        p.max_concurrency,
        COALESCE(l.active_leases, 0)::text AS active_leases
       FROM credential_concurrency_policies p
       LEFT JOIN site_profiles sp ON sp.tenant_id = p.tenant_id AND sp.id = p.site_profile_id
       LEFT JOIN (
         SELECT credential_ref, site_profile_id, count(*) AS active_leases
           FROM credential_leases
          WHERE tenant_id = $1::uuid AND status = 'active' AND locked_until > now()
          GROUP BY credential_ref, site_profile_id
       ) l ON l.credential_ref = p.credential_ref AND l.site_profile_id = p.site_profile_id
      WHERE p.tenant_id = $1::uuid
      ORDER BY sp.name NULLS LAST, p.credential_ref`,
    [tenantId],
  );
  return result.rows.map((row) => ({
    credential_ref: row.credential_ref,
    site_profile_id: row.site_profile_id,
    site_name: row.site_name,
    max_concurrency: row.max_concurrency,
    active_leases: Number(row.active_leases),
  }));
}
