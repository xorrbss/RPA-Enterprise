import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import { requirePrincipal, type ApiServerDeps } from "./server";

type OpsHealthStatus = "ok" | "warning" | "critical";

interface QueueDepth {
  readonly available: boolean;
  readonly pending_jobs: number | null;
}

interface BrowserLeaseStats {
  readonly reserved: number;
  readonly active: number;
  readonly draining: number;
  readonly expired: number;
  readonly expired_open: number;
  readonly next_expiry_at: string | null;
}

interface StaleRuns {
  readonly nonterminal_over_15m: number;
  readonly oldest_updated_at: string | null;
}

interface LeaseStatsRow {
  readonly reserved_count: string;
  readonly active_count: string;
  readonly draining_count: string;
  readonly expired_count: string;
  readonly expired_open_count: string;
  readonly next_expiry_at: Date | null;
}

interface StaleRunsRow {
  readonly nonterminal_over_15m: string;
  readonly oldest_updated_at: Date | null;
}

export function registerOpsHealthRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/ops/health", { config: { rbacAction: "ops_alert.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const health = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
      const queue = await readQueueDepth(client, principal.tenantId);
      const leases = await readBrowserLeaseStats(client, principal.tenantId);
      const staleRuns = await readStaleRuns(client, principal.tenantId);

      const status = opsHealthStatus(queue, leases, staleRuns);
      return {
        status,
        detected_at: new Date().toISOString(),
        queue,
        browser_leases: leases,
        stale_runs: staleRuns,
      };
    });
    reply.code(200).send(health);
  });
}

async function readQueueDepth(client: PoolClient, tenantId: string): Promise<QueueDepth> {
  const view = await client.query<{ regclass: string | null }>(
    `SELECT to_regclass('graphile_worker.jobs')::text AS regclass`,
  );
  if (view.rows[0]?.regclass === null) {
    return { available: false, pending_jobs: null };
  }

  const payloadColumn = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'graphile_worker'
          AND table_name = 'jobs'
          AND column_name = 'payload'
     ) AS exists`,
  );
  if (payloadColumn.rows[0]?.exists !== true) {
    return { available: false, pending_jobs: null };
  }

  const count = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM graphile_worker.jobs
      WHERE locked_at IS NULL
        AND payload ->> 'tenantId' = $1`,
    [tenantId],
  );
  return { available: true, pending_jobs: count.rows[0]?.n ?? 0 };
}

async function readBrowserLeaseStats(client: PoolClient, tenantId: string): Promise<BrowserLeaseStats> {
  const result = await client.query<LeaseStatsRow>(
    `SELECT
        count(*) FILTER (WHERE state = 'reserved')::text AS reserved_count,
        count(*) FILTER (WHERE state = 'active')::text AS active_count,
        count(*) FILTER (WHERE state = 'draining')::text AS draining_count,
        count(*) FILTER (WHERE state = 'expired')::text AS expired_count,
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
    expired: Number(row?.expired_count ?? 0),
    expired_open: Number(row?.expired_open_count ?? 0),
    next_expiry_at: row?.next_expiry_at?.toISOString() ?? null,
  };
}

async function readStaleRuns(client: PoolClient, tenantId: string): Promise<StaleRuns> {
  const result = await client.query<StaleRunsRow>(
    `SELECT count(*)::text AS nonterminal_over_15m,
            min(updated_at) AS oldest_updated_at
       FROM runs
      WHERE tenant_id = $1::uuid
        AND status IN ('queued','claimed','running','suspending','suspended','resume_requested','resuming','completing')
        AND updated_at <= now() - interval '15 minutes'`,
    [tenantId],
  );
  const row = result.rows[0];
  return {
    nonterminal_over_15m: Number(row?.nonterminal_over_15m ?? 0),
    oldest_updated_at: row?.oldest_updated_at?.toISOString() ?? null,
  };
}

function opsHealthStatus(
  queue: QueueDepth,
  leases: BrowserLeaseStats,
  staleRuns: StaleRuns,
): OpsHealthStatus {
  if (leases.expired_open > 0) return "critical";
  if (staleRuns.nonterminal_over_15m > 0) return "warning";
  if (queue.available && queue.pending_jobs !== null && queue.pending_jobs >= 100) return "warning";
  return "ok";
}
