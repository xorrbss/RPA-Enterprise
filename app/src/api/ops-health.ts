import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import { tenantFlagFor } from "../runtime/pool-forbidden-flags";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";

export type OpsHealthStatus = "ok" | "warning" | "critical";

export interface QueueDepth {
  readonly available: boolean;
  readonly pending_jobs: number | null;
}

export interface BrowserLeaseStats {
  readonly reserved: number;
  readonly active: number;
  readonly draining: number;
  readonly expired: number;
  readonly expired_open: number;
  readonly next_expiry_at: string | null;
}

export interface StaleRuns {
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
    const health = await withTenantTx(deps.pool, principal.tenantId, async (client) =>
      readOpsHealth(client, principal.tenantId),
    );
    reply.code(200).send(health);
  });
}

export interface OpsHealthSnapshot {
  readonly status: OpsHealthStatus;
  readonly detected_at: string;
  readonly queue: QueueDepth;
  readonly browser_leases: BrowserLeaseStats;
  readonly stale_runs: StaleRuns;
}

export async function readOpsHealth(client: PoolClient, tenantId: string): Promise<OpsHealthSnapshot> {
  const queue = await readQueueDepth(client, tenantId);
  const leases = await readBrowserLeaseStats(client, tenantId);
  const staleRuns = await readStaleRuns(client, tenantId);

  return {
    status: opsHealthStatus(queue, leases, staleRuns),
    detected_at: new Date().toISOString(),
    queue,
    browser_leases: leases,
    stale_runs: staleRuns,
  };
}

/**
 * 테넌트별 미처리 job 수. graphile-worker 0.16 의 공개 뷰 `graphile_worker.jobs` 만 읽는다 — 그 뷰가 런타임
 * 역할(rpa_app, NOBYPASSRLS)이 큐를 볼 수 있는 유일한 표면이기 때문이다. 실 payload 가 있는 `_private_jobs` 는
 * RLS 가 켜져 있어(relrowsecurity) 뷰 소유자만 행을 보므로 rpa_app 이 직접 읽으면 항상 0 건이다.
 * 뷰는 payload 를 노출하지 않으므로 테넌트 스코프는 flags(jsonb)로 판별한다 — runtime/run-queue.ts 가 모든
 * add_job 에 `tenant:<uuid>` flag 를 부착한다(runtime/pool-forbidden-flags.ts tenantFlagFor).
 *
 * 스키마 부재(to_regclass=null)만 available=false 다. 뷰가 있는데 flags 컬럼이 사라진 경우는 조용히 false 로
 * 덮지 않고 쿼리가 그대로 실패한다 — 큐가 설치됐는데도 "큐 미설치"로 보고하면 운영자가 존재하지 않는 인프라
 * 문제를 쫓게 된다(조용한 false 금지).
 */
async function readQueueDepth(client: PoolClient, tenantId: string): Promise<QueueDepth> {
  const view = await client.query<{ regclass: string | null }>(
    `SELECT to_regclass('graphile_worker.jobs')::text AS regclass`,
  );
  if (view.rows[0]?.regclass === null) {
    return { available: false, pending_jobs: null };
  }

  const count = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM graphile_worker.jobs
      WHERE locked_at IS NULL
        AND flags ? $1`,
    [tenantFlagFor(tenantId)],
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
