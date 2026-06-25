import type { FastifyInstance } from "fastify";

import { withTenantTx } from "../db/pool";
import { isRecord, runIdempotentCommand } from "./command";
import { ApiResponseError } from "./errors";
import { requirePrincipal, type ApiServerDeps } from "./server";

// DG-3 전용 워커 풀 관리(admin `worker_pool.manage`). 풀 레지스트리(worker_pools, 인프라)와 테넌트 배정
// (worker_pool_assignments, RLS)을 콘솔에서 CRUD 한다. 라우팅은 enqueue 의 pool:<key> flag + 워커 forbiddenFlags
// 가 수행(이 라우트는 메타데이터만 관리). 'default'는 미배정 암묵 풀(예약어).
const POOL_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

function poolKeyInvalid(key: string): boolean {
  return !POOL_KEY_RE.test(key) || key === "default";
}

export function registerWorkerPoolRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  // 풀 목록 + 호출 테넌트의 현재 배정. RLS 로 배정은 테넌트 스코프, 풀 레지스트리는 인프라(전역).
  app.get("/v1/worker-pools", { config: { rbacAction: "worker_pool.manage" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const result = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
      const pools = await client.query<{ pool_key: string; description: string | null; created_at: Date }>(
        `SELECT pool_key, description, created_at FROM worker_pools ORDER BY pool_key`,
      );
      const assignment = await client.query<{ pool_key: string }>(
        `SELECT pool_key FROM worker_pool_assignments WHERE tenant_id = $1::uuid`,
        [principal.tenantId],
      );
      return {
        items: pools.rows.map((row) => ({
          pool_key: row.pool_key,
          description: row.description,
          created_at: row.created_at.toISOString(),
        })),
        assigned_pool_key: assignment.rows[0]?.pool_key ?? null,
      };
    });
    reply.code(200).send(result);
  });

  // 풀 생성/설명 갱신(upsert, 멱등). pool_key 형식: 소문자 영숫자+_-, 'default' 예약.
  app.post("/v1/worker-pools", { config: { rbacAction: "worker_pool.manage" } }, async (request, reply) => {
    const body = isRecord(request.body) ? request.body : {};
    const poolKey = typeof body.pool_key === "string" ? body.pool_key.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : null;
    if (poolKey.length === 0) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_pool_key", field: "pool_key" });
    }
    if (poolKeyInvalid(poolKey)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_pool_key", field: "pool_key" });
    }
    const result = await runIdempotentCommand(deps, request, "createWorkerPool", `/v1/worker-pools/${poolKey}`, async (client) => {
      await client.query(
        `INSERT INTO worker_pools (pool_key, description) VALUES ($1, $2)
         ON CONFLICT (pool_key) DO UPDATE SET description = EXCLUDED.description`,
        [poolKey, description],
      );
      return { status: 200, body: { pool_key: poolKey, description } };
    });
    reply.code(result.status).send(result.body);
  });

  // 풀 삭제. 배정이 참조 중이면 FK 위반 → 409(배정 먼저 해제). 미존재 → 404.
  app.delete<{ Params: { poolKey: string } }>(
    "/v1/worker-pools/:poolKey",
    { config: { rbacAction: "worker_pool.manage" } },
    async (request, reply) => {
      const poolKey = request.params.poolKey;
      const result = await runIdempotentCommand(deps, request, "deleteWorkerPool", `/v1/worker-pools/${poolKey}/delete`, async (client) => {
        try {
          const del = await client.query(`DELETE FROM worker_pools WHERE pool_key = $1`, [poolKey]);
          if (del.rowCount === 0) throw new ApiResponseError("RESOURCE_NOT_FOUND");
        } catch (err) {
          if (isRecord(err) && (err as { code?: unknown }).code === "23503") {
            throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", { reason: "pool_in_use" });
          }
          throw err;
        }
        return { status: 200, body: { pool_key: poolKey, deleted: true } };
      });
      reply.code(result.status).send(result.body);
    },
  );

  // 호출 테넌트를 풀에 배정(테넌트당 1풀, upsert). 풀이 없으면 FK 위반 → 404.
  app.put("/v1/worker-pool", { config: { rbacAction: "worker_pool.manage" } }, async (request, reply) => {
    const body = isRecord(request.body) ? request.body : {};
    const poolKey = typeof body.pool_key === "string" ? body.pool_key.trim() : "";
    if (poolKey.length === 0 || poolKeyInvalid(poolKey)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_pool_key", field: "pool_key" });
    }
    const result = await runIdempotentCommand(deps, request, "assignWorkerPool", `/v1/worker-pool/${poolKey}`, async (client, tenantId) => {
      try {
        await client.query(
          `INSERT INTO worker_pool_assignments (tenant_id, pool_key) VALUES ($1::uuid, $2)
           ON CONFLICT (tenant_id) DO UPDATE SET pool_key = EXCLUDED.pool_key`,
          [tenantId, poolKey],
        );
      } catch (err) {
        if (isRecord(err) && (err as { code?: unknown }).code === "23503") {
          throw new ApiResponseError("RESOURCE_NOT_FOUND");
        }
        throw err;
      }
      return { status: 200, body: { assigned_pool_key: poolKey } };
    });
    reply.code(result.status).send(result.body);
  });

  // 호출 테넌트 배정 해제(→ 'default' 풀). 멱등(이미 미배정이어도 200).
  app.delete("/v1/worker-pool", { config: { rbacAction: "worker_pool.manage" } }, async (request, reply) => {
    const result = await runIdempotentCommand(deps, request, "unassignWorkerPool", `/v1/worker-pool`, async (client, tenantId) => {
      await client.query(`DELETE FROM worker_pool_assignments WHERE tenant_id = $1::uuid`, [tenantId]);
      return { status: 200, body: { assigned_pool_key: null } };
    });
    reply.code(result.status).send(result.body);
  });
}
