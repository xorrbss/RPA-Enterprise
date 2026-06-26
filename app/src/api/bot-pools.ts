import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import { requirePrincipal, type ApiServerDeps } from "./server";

type BotPoolHealth = "ok" | "warning" | "critical";

interface WorkerStatsRow {
  readonly total_count: string;
  readonly active_count: string;
  readonly draining_count: string;
  readonly dead_count: string;
  readonly stale_count: string;
  readonly open_circuit_count: string;
}

interface LeaseStatsRow {
  readonly reserved_count: string;
  readonly active_count: string;
  readonly draining_count: string;
  readonly expired_open_count: string;
  readonly next_expiry_at: Date | null;
}

interface PendingRow {
  readonly pending_runs: string;
  readonly queued_runs: string;
  readonly claimed_runs: string;
  readonly oldest_queued_at: Date | null;
  readonly due_triggers: string;
}

interface BotPoolItem {
  readonly bot_pool_id: string;
  readonly name: string;
  readonly kind: "browser";
  readonly capacity_slots: number;
  readonly workers: {
    readonly total: number;
    readonly active: number;
    readonly draining: number;
    readonly dead: number;
    readonly stale: number;
    readonly open_circuit: number;
  };
  readonly leases: {
    readonly reserved: number;
    readonly active: number;
    readonly draining: number;
    readonly expired_open: number;
    readonly next_expiry_at: string | null;
  };
  readonly queue: {
    readonly pending_runs: number;
    readonly queued_runs: number;
    readonly claimed_runs: number;
    readonly oldest_queued_at: string | null;
    readonly due_triggers: number;
  };
  readonly capacity: {
    readonly occupied_slots: number;
    readonly available_slots: number;
    readonly capacity_gap: number;
    readonly queue_pressure: number | null;
    readonly live_capacity: {
      readonly available: true;
      readonly pool_key: string;
      readonly source: "worker_pool_memberships";
    };
  };
  readonly health: BotPoolHealth;
  readonly health_reason: string;
}

export function registerBotPoolRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/bot-pools", { config: { rbacAction: "ops_alert.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const item = await withTenantTx(deps.pool, principal.tenantId, async (client) =>
      readBrowserBotPool(client, principal.tenantId),
    );
    reply.code(200).send({ items: [item], next_cursor: null });
  });
}

async function readBrowserBotPool(client: PoolClient, tenantId: string): Promise<BotPoolItem> {
  const poolKey = await readTenantPoolKey(client, tenantId);
  const workerStats = await readWorkerStats(client, poolKey);
  const leaseStats = await readLeaseStats(client, tenantId);
  const pending = await readPending(client, tenantId);
  const capacitySlots = workerStats.active;
  const capacity = botPoolCapacity(pending, leaseStats, capacitySlots, poolKey);
  const health = botPoolHealth(workerStats, leaseStats, pending, capacity);
  return {
    bot_pool_id: `browser-${poolKey}`,
    name: "브라우저 실행 풀",
    kind: "browser",
    capacity_slots: capacitySlots,
    workers: workerStats,
    leases: leaseStats,
    queue: pending,
    capacity,
    health,
    health_reason: botPoolHealthReason(health, workerStats, leaseStats, pending, capacity),
  };
}

async function readTenantPoolKey(client: PoolClient, tenantId: string): Promise<string> {
  const assignment = await client.query<{ pool_key: string }>(
    `SELECT pool_key FROM worker_pool_assignments WHERE tenant_id = $1::uuid`,
    [tenantId],
  );
  return assignment.rows[0]?.pool_key ?? "default";
}

async function readWorkerStats(client: PoolClient, poolKey: string): Promise<BotPoolItem["workers"]> {
  const result = await client.query<WorkerStatsRow>(
    `SELECT
        count(*) FILTER (WHERE w.kind = 'browser')::text AS total_count,
        count(*) FILTER (
          WHERE w.kind = 'browser'
            AND w.status = 'active'
            AND w.circuit_state = 'closed'
            AND w.heartbeat_at > now() - interval '2 minutes'
        )::text AS active_count,
        count(*) FILTER (WHERE w.kind = 'browser' AND w.status = 'draining')::text AS draining_count,
        count(*) FILTER (WHERE w.kind = 'browser' AND w.status = 'dead')::text AS dead_count,
        count(*) FILTER (
          WHERE w.kind = 'browser'
            AND w.status = 'active'
            AND w.heartbeat_at <= now() - interval '2 minutes'
        )::text AS stale_count,
        count(*) FILTER (WHERE w.kind = 'browser' AND w.circuit_state IN ('open','half_open'))::text AS open_circuit_count
       FROM workers w
       LEFT JOIN worker_pool_memberships m ON m.worker_id = w.id
      WHERE ($1 = 'default' AND m.worker_id IS NULL)
         OR m.pool_key = $1`,
    [poolKey],
  );
  const row = result.rows[0];
  return {
    total: Number(row?.total_count ?? 0),
    active: Number(row?.active_count ?? 0),
    draining: Number(row?.draining_count ?? 0),
    dead: Number(row?.dead_count ?? 0),
    stale: Number(row?.stale_count ?? 0),
    open_circuit: Number(row?.open_circuit_count ?? 0),
  };
}

async function readLeaseStats(client: PoolClient, tenantId: string): Promise<BotPoolItem["leases"]> {
  const result = await client.query<LeaseStatsRow>(
    `SELECT
        count(*) FILTER (WHERE state = 'reserved')::text AS reserved_count,
        count(*) FILTER (WHERE state = 'active')::text AS active_count,
        count(*) FILTER (WHERE state = 'draining')::text AS draining_count,
        count(*) FILTER (WHERE state IN ('reserved','active') AND expires_at < now())::text AS expired_open_count,
        min(expires_at) FILTER (WHERE state IN ('reserved','active')) AS next_expiry_at
       FROM browser_leases
      WHERE tenant_id = $1::uuid`,
    [tenantId],
  );
  const row = result.rows[0];
  return {
    reserved: Number(row?.reserved_count ?? 0),
    active: Number(row?.active_count ?? 0),
    draining: Number(row?.draining_count ?? 0),
    expired_open: Number(row?.expired_open_count ?? 0),
    next_expiry_at: row?.next_expiry_at?.toISOString() ?? null,
  };
}

async function readPending(client: PoolClient, tenantId: string): Promise<BotPoolItem["queue"]> {
  const result = await client.query<PendingRow>(
    `SELECT
        (SELECT count(*)::text
           FROM runs
          WHERE tenant_id = $1::uuid
            AND status IN ('queued','claimed')) AS pending_runs,
        (SELECT count(*)::text
           FROM runs
          WHERE tenant_id = $1::uuid
            AND status = 'queued') AS queued_runs,
        (SELECT count(*)::text
           FROM runs
          WHERE tenant_id = $1::uuid
            AND status = 'claimed') AS claimed_runs,
        (SELECT min(created_at)
           FROM runs
          WHERE tenant_id = $1::uuid
            AND status = 'queued') AS oldest_queued_at,
        (SELECT count(*)::text
           FROM run_triggers
          WHERE tenant_id = $1::uuid
            AND trigger_type = 'cron'
            AND status = 'enabled'
            AND next_fire_at IS NOT NULL
            AND next_fire_at <= now()) AS due_triggers`,
    [tenantId],
  );
  const row = result.rows[0];
  return {
    pending_runs: Number(row?.pending_runs ?? 0),
    queued_runs: Number(row?.queued_runs ?? 0),
    claimed_runs: Number(row?.claimed_runs ?? 0),
    oldest_queued_at: row?.oldest_queued_at?.toISOString() ?? null,
    due_triggers: Number(row?.due_triggers ?? 0),
  };
}

function botPoolCapacity(
  pending: BotPoolItem["queue"],
  leases: BotPoolItem["leases"],
  capacitySlots: number,
  poolKey: string,
): BotPoolItem["capacity"] {
  const occupiedSlots = leases.active + leases.reserved;
  const availableSlots = Math.max(capacitySlots - occupiedSlots, 0);
  const queuedDemand = pending.queued_runs;
  return {
    occupied_slots: occupiedSlots,
    available_slots: availableSlots,
    capacity_gap: Math.max(queuedDemand - availableSlots, 0),
    queue_pressure: capacitySlots > 0 ? queuedDemand / capacitySlots : null,
    live_capacity: {
      available: true,
      pool_key: poolKey,
      source: "worker_pool_memberships",
    },
  };
}

function botPoolHealth(
  workers: BotPoolItem["workers"],
  leases: BotPoolItem["leases"],
  pending: BotPoolItem["queue"],
  capacity: BotPoolItem["capacity"],
): BotPoolHealth {
  if (leases.expired_open > 0) return "critical";
  if (workers.active === 0 && (pending.queued_runs > 0 || pending.due_triggers > 0)) return "critical";
  if (workers.total === 0 || workers.stale > 0 || workers.open_circuit > 0) return "warning";
  if (capacity.capacity_gap > 0) return "warning";
  return "ok";
}

function botPoolHealthReason(
  health: BotPoolHealth,
  workers: BotPoolItem["workers"],
  leases: BotPoolItem["leases"],
  pending: BotPoolItem["queue"],
  capacity: BotPoolItem["capacity"],
): string {
  if (leases.expired_open > 0) return `만료된 활성 브라우저 lease ${leases.expired_open}건을 회수해야 합니다.`;
  if (workers.active === 0 && (pending.queued_runs > 0 || pending.due_triggers > 0)) return "대기 중인 실행이 있지만 사용 가능한 브라우저 worker가 없습니다.";
  if (workers.total === 0) return "등록된 브라우저 worker가 없습니다.";
  if (workers.stale > 0) return `브라우저 worker ${workers.stale}개가 2분 이상 heartbeat를 보내지 않았습니다.`;
  if (workers.open_circuit > 0) return `브라우저 worker ${workers.open_circuit}개의 circuit 상태를 확인해야 합니다.`;
  if (health === "warning") return `대기 실행이 가용 슬롯보다 ${capacity.capacity_gap}건 많습니다.`;
  return "브라우저 실행 용량이 정상 범위입니다.";
}
