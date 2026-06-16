// 브라우저 리스 획득·조회 + run 로드(claim/resume 공용) — PgRuntimeWorker에서 분리한 협력 클래스. 로직 무변경.
import { randomUUID } from "node:crypto";

import type pg from "pg";

import type { RunState } from "../../../ts/state-machine-types";
import type { IsoDateTime, LeaseRenewResult, RuntimeJobResult } from "../../../ts/runtime-contract";
import type {
  BrowserLeaseDrainInput,
  BrowserLeasePlan,
  BrowserLeaseRenewInput,
  PgRuntimeWorkerOptions,
  RunRow,
} from "./runtime-worker";

const DEFAULT_BROWSER_LEASE_TTL_MS = 300_000;

export async function renewBrowserLease(
  client: pg.PoolClient,
  input: BrowserLeaseRenewInput,
): Promise<LeaseRenewResult> {
  if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0) {
    throw new Error("renewBrowserLease: ttlMs must be a positive integer");
  }
  const renewed = await client.query<{ expires_at: string }>(
    `UPDATE browser_leases
        SET heartbeat_at = now(),
            expires_at = now() + ($4::int * interval '1 millisecond')
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND owner_worker_id = $3::uuid
        AND state IN ('reserved','active')
        AND expires_at >= now()
      RETURNING expires_at::text`,
    [input.tenantId, input.leaseId, input.workerId, input.ttlMs],
  );
  const row = renewed.rows[0];
  if (row !== undefined) return { kind: "renewed", expiresAt: row.expires_at as IsoDateTime };
  return {
    kind: "lost",
    code: "BROWSER_LEASE_EXPIRED",
    reason: "lease missing, owned by another worker, drained, cross-tenant, or expired",
  };
}

export async function drainBrowserLease(
  client: pg.PoolClient,
  input: BrowserLeaseDrainInput,
): Promise<void> {
  await client.query(
    `UPDATE browser_leases
        SET state = CASE WHEN $4 = 'sweeper' THEN 'expired' ELSE 'draining' END,
            expires_at = now()
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND owner_worker_id = $3::uuid
        AND state IN ('reserved','active')`,
    [input.tenantId, input.leaseId, input.workerId, input.reason],
  );
}

export class BrowserLeaseManager {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: PgRuntimeWorkerOptions = {},
  ) {}

  async loadExpectedRun(
    client: pg.PoolClient,
    tenantId: string,
    runId: string,
    expectedStatus: RunState,
  ): Promise<{ kind: "ok"; row: RunRow } | { kind: "failed"; result: RuntimeJobResult }> {
    const run = await client.query<RunRow>(
      `SELECT status, correlation_id::text
         FROM runs
        WHERE tenant_id = $1::uuid AND id = $2::uuid
        FOR UPDATE`,
      [tenantId, runId],
    );
    const row = run.rows[0];
    if (row === undefined) {
      return { kind: "failed", result: { kind: "failed", code: "RUN_NOT_FOUND" } };
    }
    if (row.status !== expectedStatus) {
      if (expectedStatus === "queued" && row.status === "cancelled") {
        // A queued/claimed run can be cancelled by the API before its stale run_claim job is consumed.
        return { kind: "failed", result: { kind: "completed", emittedEvents: [] } };
      }
      return { kind: "failed", result: { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" } };
    }
    return { kind: "ok", row };
  }

  async acquireBrowserLease(
    client: pg.PoolClient,
    input: {
      tenantId: string;
      runId: string;
      workerId: string;
      plan: BrowserLeasePlan | null;
    },
  ): Promise<RuntimeJobResult | { kind: "acquired"; leaseId: string }> {
    if (input.plan === null) {
      return { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" };
    }

    const ttlMs = input.plan.ttlMs ?? this.options.defaultBrowserLeaseTtlMs ?? DEFAULT_BROWSER_LEASE_TTL_MS;
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("RuntimeWorker: browser lease ttlMs must be a positive integer");
    }
    const isolation = input.plan.isolation ?? "context";
    const cleanupPolicy = input.plan.cleanupPolicy ?? "clear_all";

    const worker = await client.query<{ kind: string; status: string; circuit_state: string }>(
      `SELECT kind, status, circuit_state FROM workers WHERE id = $1::uuid`,
      [input.workerId],
    );
    const workerRow = worker.rows[0];
    if (workerRow?.kind !== "browser" || workerRow.status !== "active" || workerRow.circuit_state === "open") {
      return { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" };
    }

    const identity = await client.query<{ risk: string; approved: boolean }>(
      `SELECT sp.risk, sp.approved
         FROM browser_identities bi
         JOIN site_profiles sp
           ON sp.tenant_id = bi.tenant_id
          AND sp.id = bi.site_profile_id
        WHERE bi.tenant_id = $1::uuid
          AND bi.id = $2::uuid
          AND sp.id = $3::uuid
        FOR UPDATE OF bi`,
      [input.tenantId, input.plan.browserIdentityId, input.plan.siteProfileId],
    );
    const site = identity.rows[0];
    if (site === undefined) {
      return { kind: "failed", code: "RESOURCE_NOT_FOUND" };
    }
    if (site.risk === "red" && !site.approved) {
      return { kind: "failed", code: "SITE_PROFILE_BLOCKED" };
    }

    await client.query(
      `UPDATE browser_leases
          SET state = 'expired'
        WHERE tenant_id = $1::uuid
          AND site_profile_id = $2::uuid
          AND browser_identity_id = $3::uuid
          AND state IN ('reserved','active')
          AND expires_at < now()`,
      [input.tenantId, input.plan.siteProfileId, input.plan.browserIdentityId],
    );

    const active = await client.query<{ retry_after_ms: number }>(
      `SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - now())) * 1000))::int AS retry_after_ms
         FROM browser_leases
        WHERE tenant_id = $1::uuid
          AND site_profile_id = $2::uuid
          AND browser_identity_id = $3::uuid
          AND state IN ('reserved','active')
          AND expires_at >= now()
        ORDER BY expires_at ASC
        LIMIT 1
        FOR UPDATE`,
      [input.tenantId, input.plan.siteProfileId, input.plan.browserIdentityId],
    );
    const activeLease = active.rows[0];
    if (activeLease !== undefined) {
      return { kind: "deferred", code: "SESSION_LOCKED", retryAfterMs: activeLease.retry_after_ms };
    }

    const leaseId = randomUUID();
    await client.query(
      `INSERT INTO browser_leases (
         id, tenant_id, site_profile_id, browser_identity_id, run_id, owner_worker_id,
         isolation, state, cleanup_policy, download_dir_ref, expires_at
       )
       VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         $7, 'active', $8, $9, now() + ($10::int * interval '1 millisecond')
       )`,
      [
        leaseId,
        input.tenantId,
        input.plan.siteProfileId,
        input.plan.browserIdentityId,
        input.runId,
        input.workerId,
        isolation,
        cleanupPolicy,
        input.plan.downloadDirRef ?? null,
        ttlMs,
      ],
    );

    return { kind: "acquired", leaseId };
  }

  async findActiveBrowserLeaseForRun(
    client: pg.PoolClient,
    input: {
      tenantId: string;
      runId: string;
      workerId: string;
    },
  ): Promise<string | null> {
    const lease = await client.query<{ id: string }>(
      `SELECT id::text
         FROM browser_leases
        WHERE tenant_id = $1::uuid
          AND run_id = $2::uuid
          AND owner_worker_id = $3::uuid
          AND state IN ('reserved','active')
          AND expires_at >= now()
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [input.tenantId, input.runId, input.workerId],
    );
    return lease.rows[0]?.id ?? null;
  }
}
