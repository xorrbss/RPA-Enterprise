import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import { isRecord, runIdempotentCommand } from "./command";
import { ApiResponseError } from "./errors";
import { appendGovernanceAudit } from "./role-assignments";
import { requirePrincipal, type ApiServerDeps } from "./server";
import { UUID_RE } from "./server-shared";

const POOL_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const WORKER_POOL_STATUSES = ["active", "draining", "disabled"] as const;
const WORKER_POOL_PRIORITIES = ["low", "medium", "high", "critical"] as const;

type WorkerPoolStatus = (typeof WORKER_POOL_STATUSES)[number];
type WorkerPoolPriority = (typeof WORKER_POOL_PRIORITIES)[number];

interface WorkerPoolRow {
  readonly pool_key: string;
  readonly description: string | null;
  readonly status: WorkerPoolStatus;
  readonly max_concurrency: number;
  readonly priority: WorkerPoolPriority;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly updated_by: string | null;
}

interface WorkerPoolMemberSummary {
  readonly total: number;
  readonly active: number;
  readonly stale: number;
  readonly worker_ids: readonly string[];
}

interface WorkerPoolMemberSummaryRow {
  readonly pool_key: string;
  readonly total_count: string;
  readonly active_count: string;
  readonly stale_count: string;
  readonly worker_ids: readonly string[] | string;
}

interface WorkerPoolInput {
  readonly description: string | null;
  readonly status: WorkerPoolStatus;
  readonly maxConcurrency: number;
  readonly priority: WorkerPoolPriority;
}

interface WorkerPoolPatch {
  readonly hasDescription: boolean;
  readonly description: string | null;
  readonly status?: WorkerPoolStatus;
  readonly maxConcurrency?: number;
  readonly priority?: WorkerPoolPriority;
  readonly reason?: string;
}

function poolKeyInvalid(key: string): boolean {
  return !POOL_KEY_RE.test(key) || key === "default";
}

export function registerWorkerPoolRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/worker-pools", { config: { rbacAction: "worker_pool.manage" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const result = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
      const pools = await client.query<WorkerPoolRow>(
        `SELECT pool_key, description, status, max_concurrency, priority, created_at, updated_at, updated_by
           FROM worker_pools
          ORDER BY pool_key`,
      );
      const memberSummaries = await readWorkerPoolMemberSummaries(client);
      const assignment = await client.query<{ pool_key: string }>(
        `SELECT pool_key FROM worker_pool_assignments WHERE tenant_id = $1::uuid`,
        [principal.tenantId],
      );
      const pending = await client.query<{ queued_runs: string; oldest_queued_at: Date | null }>(
        `SELECT count(*)::text AS queued_runs, min(created_at) AS oldest_queued_at
           FROM runs
          WHERE tenant_id = $1::uuid
            AND status = 'queued'`,
        [principal.tenantId],
      );
      return {
        items: pools.rows.map((row) => mapPoolRow(row, memberSummaries.get(row.pool_key))),
        assigned_pool_key: assignment.rows[0]?.pool_key ?? null,
        pending: {
          queued_runs: Number(pending.rows[0]?.queued_runs ?? "0"),
          oldest_queued_at: pending.rows[0]?.oldest_queued_at?.toISOString() ?? null,
        },
      };
    });
    reply.code(200).send(result);
  });

  app.post("/v1/worker-pools", { config: { rbacAction: "worker_pool.manage" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = isRecord(request.body) ? request.body : {};
    const poolKey = typeof body.pool_key === "string" ? body.pool_key.trim() : "";
    if (poolKey.length === 0) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_pool_key", field: "pool_key" });
    }
    if (poolKeyInvalid(poolKey)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_pool_key", field: "pool_key" });
    }
    const input = parseWorkerPoolInput(body);
    const result = await runIdempotentCommand(deps, request, "createWorkerPool", `/v1/worker-pools/${poolKey}`, async (client) => {
      const saved = await client.query<WorkerPoolRow>(
        `INSERT INTO worker_pools
            (pool_key, description, status, max_concurrency, priority, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (pool_key) DO UPDATE SET
            description = EXCLUDED.description,
            status = EXCLUDED.status,
            max_concurrency = EXCLUDED.max_concurrency,
            priority = EXCLUDED.priority,
            updated_at = now(),
            updated_by = EXCLUDED.updated_by
         RETURNING pool_key, description, status, max_concurrency, priority, created_at, updated_at, updated_by`,
        [poolKey, input.description, input.status, input.maxConcurrency, input.priority, principal.subjectId],
      );
      const row = mustRow(saved.rows[0]);
      await appendWorkerPoolAudit(client, request, "worker_pool_upserted", {
        pool_key: poolKey,
        status: row.status,
        max_concurrency: row.max_concurrency,
        priority: row.priority,
      });
      return { status: 200, body: mapPoolRow(row) };
    });
    reply.code(result.status).send(result.body);
  });

  app.patch<{ Params: { poolKey: string } }>(
    "/v1/worker-pools/:poolKey",
    { config: { rbacAction: "worker_pool.manage" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const poolKey = request.params.poolKey;
      if (poolKeyInvalid(poolKey)) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const patch = parseWorkerPoolPatch(isRecord(request.body) ? request.body : {});
      const result = await runIdempotentCommand(deps, request, "updateWorkerPool", `/v1/worker-pools/${poolKey}`, async (client) => {
        const saved = await updateWorkerPool(client, poolKey, principal.subjectId, patch);
        if (saved === null) throw new ApiResponseError("RESOURCE_NOT_FOUND");
        await appendWorkerPoolAudit(client, request, "worker_pool_updated", {
          pool_key: poolKey,
          status: saved.status,
          max_concurrency: saved.max_concurrency,
          priority: saved.priority,
          operator_reason: patch.reason ?? null,
        });
        return { status: 200, body: mapPoolRow(saved) };
      });
      reply.code(result.status).send(result.body);
    },
  );

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
        await appendWorkerPoolAudit(client, request, "worker_pool_deleted", { pool_key: poolKey });
        return { status: 200, body: { pool_key: poolKey, deleted: true } };
      });
      reply.code(result.status).send(result.body);
    },
  );

  app.put("/v1/worker-pool", { config: { rbacAction: "worker_pool.manage" } }, async (request, reply) => {
    const body = isRecord(request.body) ? request.body : {};
    const poolKey = typeof body.pool_key === "string" ? body.pool_key.trim() : "";
    if (poolKey.length === 0 || poolKeyInvalid(poolKey)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_pool_key", field: "pool_key" });
    }
    const result = await runIdempotentCommand(deps, request, "assignWorkerPool", `/v1/worker-pool/${poolKey}`, async (client, tenantId) => {
      try {
        await client.query(
          `INSERT INTO worker_pool_assignments (tenant_id, pool_key)
           VALUES ($1::uuid, $2)
           ON CONFLICT (tenant_id) DO UPDATE SET pool_key = EXCLUDED.pool_key`,
          [tenantId, poolKey],
        );
      } catch (err) {
        if (isRecord(err) && (err as { code?: unknown }).code === "23503") {
          throw new ApiResponseError("RESOURCE_NOT_FOUND");
        }
        throw err;
      }
      await appendWorkerPoolAudit(client, request, "worker_pool_assigned", { pool_key: poolKey });
      return { status: 200, body: { assigned_pool_key: poolKey } };
    });
    reply.code(result.status).send(result.body);
  });

  app.delete("/v1/worker-pool", { config: { rbacAction: "worker_pool.manage" } }, async (request, reply) => {
    const result = await runIdempotentCommand(deps, request, "unassignWorkerPool", `/v1/worker-pool`, async (client, tenantId) => {
      await client.query(`DELETE FROM worker_pool_assignments WHERE tenant_id = $1::uuid`, [tenantId]);
      await appendWorkerPoolAudit(client, request, "worker_pool_unassigned", { pool_key: null });
      return { status: 200, body: { assigned_pool_key: null } };
    });
    reply.code(result.status).send(result.body);
  });

  app.put<{ Params: { poolKey: string; workerId: string } }>(
    "/v1/worker-pools/:poolKey/workers/:workerId",
    { config: { rbacAction: "worker_pool.manage" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const { poolKey, workerId } = request.params;
      if (poolKeyInvalid(poolKey)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
      if (!UUID_RE.test(workerId)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
      const result = await runIdempotentCommand(
        deps,
        request,
        "assignWorkerPoolWorker",
        `/v1/worker-pools/${poolKey}/workers/${workerId}`,
        async (client) => {
          await ensureBrowserWorker(client, workerId);
          try {
            await client.query(
              `INSERT INTO worker_pool_memberships (worker_id, pool_key, assigned_by)
               VALUES ($1::uuid, $2, $3)
               ON CONFLICT (worker_id) DO UPDATE SET
                  pool_key = EXCLUDED.pool_key,
                  assigned_by = EXCLUDED.assigned_by,
                  updated_at = now()`,
              [workerId, poolKey, principal.subjectId],
            );
          } catch (err) {
            if (isRecord(err) && (err as { code?: unknown }).code === "23503") {
              throw new ApiResponseError("RESOURCE_NOT_FOUND");
            }
            throw err;
          }
          await appendWorkerPoolAudit(client, request, "worker_pool_worker_assigned", {
            pool_key: poolKey,
            worker_id: workerId,
          });
          return { status: 200, body: { pool_key: poolKey, worker_id: workerId, assigned: true } };
        },
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.delete<{ Params: { poolKey: string; workerId: string } }>(
    "/v1/worker-pools/:poolKey/workers/:workerId",
    { config: { rbacAction: "worker_pool.manage" } },
    async (request, reply) => {
      const { poolKey, workerId } = request.params;
      if (poolKeyInvalid(poolKey)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
      if (!UUID_RE.test(workerId)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
      const result = await runIdempotentCommand(
        deps,
        request,
        "removeWorkerPoolWorker",
        `/v1/worker-pools/${poolKey}/workers/${workerId}`,
        async (client) => {
          const deleted = await client.query(
            `DELETE FROM worker_pool_memberships
              WHERE worker_id = $1::uuid
                AND pool_key = $2`,
            [workerId, poolKey],
          );
          if (deleted.rowCount === 0) throw new ApiResponseError("RESOURCE_NOT_FOUND");
          await appendWorkerPoolAudit(client, request, "worker_pool_worker_removed", {
            pool_key: poolKey,
            worker_id: workerId,
          });
          return { status: 200, body: { pool_key: poolKey, worker_id: workerId, assigned: false } };
        },
      );
      reply.code(result.status).send(result.body);
    },
  );
}

function mapPoolRow(row: WorkerPoolRow, members?: WorkerPoolMemberSummary): Record<string, unknown> {
  return {
    pool_key: row.pool_key,
    description: row.description,
    status: row.status,
    max_concurrency: row.max_concurrency,
    priority: row.priority,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    updated_by: row.updated_by,
    workers: members ?? { total: 0, active: 0, stale: 0, worker_ids: [] },
  };
}

function parseWorkerPoolInput(body: Record<string, unknown>): WorkerPoolInput {
  return {
    description: parseDescription(body.description, "description"),
    status: parseStatus(body.status, "status") ?? "active",
    maxConcurrency: parseMaxConcurrency(body.max_concurrency, "max_concurrency") ?? 1,
    priority: parsePriority(body.priority, "priority") ?? "medium",
  };
}

function parseWorkerPoolPatch(body: Record<string, unknown>): WorkerPoolPatch {
  const hasDescription = Object.prototype.hasOwnProperty.call(body, "description");
  const status = parseStatus(body.status, "status");
  const maxConcurrency = parseMaxConcurrency(body.max_concurrency, "max_concurrency");
  const priority = parsePriority(body.priority, "priority");
  const reason = parseReason(body.reason);
  if (!hasDescription && status === undefined && maxConcurrency === undefined && priority === undefined) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "empty_update" });
  }
  return {
    hasDescription,
    description: hasDescription ? parseDescription(body.description, "description") : null,
    ...(status !== undefined ? { status } : {}),
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

async function updateWorkerPool(
  client: PoolClient,
  poolKey: string,
  actorSub: string,
  patch: WorkerPoolPatch,
): Promise<WorkerPoolRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [poolKey];
  if (patch.hasDescription) {
    values.push(patch.description);
    sets.push(`description = $${values.length}`);
  }
  if (patch.status !== undefined) {
    values.push(patch.status);
    sets.push(`status = $${values.length}`);
  }
  if (patch.maxConcurrency !== undefined) {
    values.push(patch.maxConcurrency);
    sets.push(`max_concurrency = $${values.length}`);
  }
  if (patch.priority !== undefined) {
    values.push(patch.priority);
    sets.push(`priority = $${values.length}`);
  }
  values.push(actorSub);
  sets.push(`updated_by = $${values.length}`, `updated_at = now()`);

  const result = await client.query<WorkerPoolRow>(
    `UPDATE worker_pools
        SET ${sets.join(", ")}
      WHERE pool_key = $1
      RETURNING pool_key, description, status, max_concurrency, priority, created_at, updated_at, updated_by`,
    values,
  );
  return result.rows[0] ?? null;
}

async function readWorkerPoolMemberSummaries(client: PoolClient): Promise<Map<string, WorkerPoolMemberSummary>> {
  const result = await client.query<WorkerPoolMemberSummaryRow>(
    `SELECT m.pool_key,
            count(*)::text AS total_count,
            count(*) FILTER (
              WHERE w.status = 'active'
                AND w.kind = 'browser'
                AND w.circuit_state = 'closed'
                AND w.heartbeat_at > now() - interval '2 minutes'
            )::text AS active_count,
            count(*) FILTER (
              WHERE w.status = 'active'
                AND w.kind = 'browser'
                AND w.heartbeat_at <= now() - interval '2 minutes'
            )::text AS stale_count,
            array_agg(m.worker_id::text ORDER BY m.worker_id::text) AS worker_ids
       FROM worker_pool_memberships m
       JOIN workers w ON w.id = m.worker_id
      WHERE w.kind = 'browser'
      GROUP BY m.pool_key`,
  );
  const out = new Map<string, WorkerPoolMemberSummary>();
  for (const row of result.rows) {
    out.set(row.pool_key, {
      total: Number(row.total_count),
      active: Number(row.active_count),
      stale: Number(row.stale_count),
      worker_ids: Array.isArray(row.worker_ids) ? row.worker_ids : [],
    });
  }
  return out;
}

async function ensureBrowserWorker(client: PoolClient, workerId: string): Promise<void> {
  const worker = await client.query<{ id: string }>(
    `SELECT id::text
       FROM workers
      WHERE id = $1::uuid
        AND kind = 'browser'`,
    [workerId],
  );
  if (worker.rows[0] === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
}

async function appendWorkerPoolAudit(
  client: PoolClient,
  request: Parameters<typeof appendGovernanceAudit>[1],
  reason: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await appendGovernanceAudit(client, request, "worker_pool.manage", "allow", reason, payload);
}

function parseDescription(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_description", field });
  const trimmed = value.trim();
  if (trimmed.length > 500) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "description_too_long", field });
  return trimmed.length > 0 ? trimmed : null;
}

function parseStatus(value: unknown, field: string): WorkerPoolStatus | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !WORKER_POOL_STATUSES.includes(value as WorkerPoolStatus)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_status", field });
  }
  return value as WorkerPoolStatus;
}

function parsePriority(value: unknown, field: string): WorkerPoolPriority | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !WORKER_POOL_PRIORITIES.includes(value as WorkerPoolPriority)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_priority", field });
  }
  return value as WorkerPoolPriority;
}

function parseMaxConcurrency(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_max_concurrency", field });
  }
  return value;
}

function parseReason(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_reason", field: "reason" });
  const trimmed = value.trim();
  if (trimmed.length > 500) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "reason_too_long", field: "reason" });
  return trimmed.length > 0 ? trimmed : undefined;
}

function mustRow(row: WorkerPoolRow | undefined): WorkerPoolRow {
  if (row === undefined) throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "worker_pool_write_missing" });
  return row;
}
