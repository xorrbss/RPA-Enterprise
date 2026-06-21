/**
 * browser_leases 행 SQL 조작 (runtime-worker.ts 분해 — 동작 무변경 이동).
 *
 * renew(heartbeat/expires 연장)·drain(draining/expired 전이)·INIT실패 예약행 DELETE. 순수 SQL leaf —
 * runtime-worker 내부 비-export 타입 의존 0(입력 인터페이스는 함께 이동). 클래스는 deleteInitReservedBrowserLease를,
 * claim int 테스트는 renew/drain을 직접 import한다(단방향, back-cycle 없음).
 */
import type pg from "pg";

import type {
  EventId,
  IsoDateTime,
  LeaseRenewResult,
  RunAbortDrainInput,
  RuntimeJobResult,
} from "../../../ts/runtime-contract";
import { withTenantTx } from "../db/pool";
import { applyRunTransition } from "../runtime/run-transition";
import { unpauseLinkedWorkitemForRunAbort } from "../runtime/workitem-settlement";
import { isOnlyAbortLeasePending } from "./runtime-worker-parse";

export interface BrowserLeaseRenewInput {
  readonly tenantId: string;
  readonly leaseId: string;
  readonly workerId: string;
  readonly ttlMs: number;
}

export interface BrowserLeaseDrainInput {
  readonly tenantId: string;
  readonly leaseId: string;
  readonly workerId: string;
  readonly reason: "run_cancelled" | "run_completed" | "run_suspended" | "sweeper";
}

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

/**
 * INIT 실패(R3a/R3b) 시 Phase A 에서 예약(active)만 된 browser lease 행을 **삭제**한다. INIT 실패는 bind 가 throw 한
 * 경우라 라이브 세션이 열린 적이 없어 teardown 이 불요하고, drain('draining' 잔류)은 종결자가 없어 누적된다(행 누수).
 * 더 중요한 건 재-claim 이 신규 lease 를 INSERT 해 run 당 lease 가 2행이 되면 abort 의 claimAbortBrowserLeaseForRun
 * (run_id 별 LIMIT 2)이 'multiple'→CONTROL_PLANE_INTERNAL_ERROR 로 wedge 되는 것(적대리뷰 B1) — 행을 삭제해
 * 'run 당 활성 lease ≤1' 불변식을 복원한다. owner 가드(다른 워커 lease 미삭제).
 */
export async function deleteInitReservedBrowserLease(
  client: pg.PoolClient,
  input: { readonly tenantId: string; readonly leaseId: string; readonly workerId: string },
): Promise<void> {
  await client.query(
    `DELETE FROM browser_leases
      WHERE tenant_id = $1::uuid AND id = $2::uuid AND owner_worker_id = $3::uuid`,
    [input.tenantId, input.leaseId, input.workerId],
  );
}

export async function findActiveBrowserLeaseForRun(
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

export async function hasOpenAbortBrowserLeaseForRun(
  client: pg.PoolClient,
  input: {
    tenantId: string;
    runId: string;
    workerId: string;
  },
): Promise<boolean> {
  const lease = await client.query<{ id: string }>(
    `SELECT id::text
       FROM browser_leases
      WHERE tenant_id = $1::uuid
        AND run_id = $2::uuid
        AND owner_worker_id = $3::uuid
        AND state IN ('reserved','active','draining')
      LIMIT 1
      FOR UPDATE`,
    [input.tenantId, input.runId, input.workerId],
  );
  return lease.rows.length > 0;
}

export async function claimAbortBrowserLeaseForRun(
  client: pg.PoolClient,
  input: {
    tenantId: string;
    runId: string;
    workerId: string;
    timeoutMs: number;
  },
): Promise<
  | { kind: "claimed"; leaseId: string }
  | { kind: "expired"; leaseId: string }
  | { kind: "deferred"; retryAfterMs: number }
  | { kind: "missing" }
  | { kind: "multiple" }
> {
  const lease = await client.query<{ id: string; state: string; deadline_expired: boolean; retry_after_ms: number }>(
    `SELECT id::text,
            state,
            (expires_at <= now()) AS deadline_expired,
            GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - now())) * 1000))::int AS retry_after_ms
       FROM browser_leases
      WHERE tenant_id = $1::uuid
        AND run_id = $2::uuid
        AND owner_worker_id = $3::uuid
        AND state IN ('reserved','active','draining','expired')
      ORDER BY created_at DESC
      LIMIT 2
      FOR UPDATE`,
    [input.tenantId, input.runId, input.workerId],
  );
  if (lease.rows.length > 1) return { kind: "multiple" };
  const row = lease.rows[0];
  if (row === undefined) return { kind: "missing" };
  if (row.state === "expired" || row.deadline_expired) return { kind: "expired", leaseId: row.id };
  if (row.state === "draining") return { kind: "deferred", retryAfterMs: row.retry_after_ms };

  const claimed = await client.query<{ id: string }>(
    `UPDATE browser_leases
        SET state = 'draining',
            expires_at = LEAST(expires_at, now() + ($4::int * interval '1 millisecond'))
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND owner_worker_id = $3::uuid
        AND state IN ('reserved','active')
      RETURNING id::text`,
    [input.tenantId, row.id, input.workerId, input.timeoutMs],
  );
  if (claimed.rowCount !== 1) return { kind: "deferred", retryAfterMs: 1_000 };
  return { kind: "claimed", leaseId: row.id };
}

export async function releaseAbortBrowserDrainClaim(pool: pg.Pool, input: RunAbortDrainInput): Promise<void> {
  await withTenantTx(pool, input.tenantId, async (client) => {
    const released = await client.query(
      `UPDATE browser_leases
          SET state = 'active'
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND run_id = $3::uuid
          AND owner_worker_id = $4::uuid
          AND state = 'draining'`,
      [input.tenantId, input.leaseId, input.runId, input.workerId],
    );
    if (released.rowCount !== 1) {
      throw new Error("RuntimeWorker: run_abort browser lease drain-claim release CAS conflict");
    }
  });
}

export async function finalizeRunAbort(
  pool: pg.Pool,
  tenantId: string,
  runId: string,
  input: {
    event: "drain_ok" | "drain_timeout";
    correlationId: string;
    leaseId?: string;
    workerId?: string;
  },
): Promise<RuntimeJobResult> {
  return withTenantTx(pool, tenantId, async (client) => {
    const transition = await applyRunTransition(client, {
      tenantId,
      runId,
      fromStatus: "aborting",
      event: { type: input.event },
      guard: {},
      correlationId: input.correlationId,
      eventIdempotencyKey: `${runId}:run_abort`,
    });

    if (!transition.applied) {
      if (transition.observed === "cancelled") {
        return { kind: "completed", emittedEvents: [] };
      }
      throw new Error(`RuntimeWorker: run_abort CAS conflict after row lock; observed=${transition.observed ?? "null"}`);
    }
    if (!isOnlyAbortLeasePending(transition.pending, input.event)) {
      throw new Error("RuntimeWorker: run_abort finalization produced unsupported pending side effects");
    }

    // #7 회귀 보수: suspended/resume_requested/resuming → abort 면 W9-paused workitem 이 W11 없이 영구 paused 잔류
    //   → checkout sweeper 영영 스킵(누수). abort 종결 tx 에서 un-pause + 즉시만료로 sweeper(W6/W7) 자가회수에 위임.
    await unpauseLinkedWorkitemForRunAbort(client, { tenantId, runId });

    if (input.leaseId !== undefined && input.workerId !== undefined) {
      await expireAbortBrowserLease(client, {
        tenantId,
        runId,
        leaseId: input.leaseId,
        workerId: input.workerId,
      });
    }

    return {
      kind: "completed",
      emittedEvents: transition.emitted.map((e) => e.eventId as EventId),
    };
  });
}

export async function expireAbortBrowserLease(
  client: pg.PoolClient,
  input: {
    tenantId: string;
    runId: string;
    leaseId: string;
    workerId: string;
  },
): Promise<void> {
  const expired = await client.query(
    `UPDATE browser_leases
        SET state = 'expired',
            expires_at = LEAST(expires_at, now())
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND run_id = $3::uuid
        AND owner_worker_id = $4::uuid
        AND state IN ('reserved','active','draining','expired')`,
    [input.tenantId, input.leaseId, input.runId, input.workerId],
  );
  if (expired.rowCount === 0) {
    throw new Error("RuntimeWorker: run_abort browser lease finalize CAS conflict");
  }
}
