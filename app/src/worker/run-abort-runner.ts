// run_abort 잡 실행(drain/finalize/lease 만료) — PgRuntimeWorker에서 분리한 협력 클래스. 로직 무변경.
import type pg from "pg";

import type {
  EventId,
  LeaseId,
  RunAbortDrainInput,
  RunAbortDrainResult,
  RuntimeJobResult,
  RuntimeWorkerJob,
  WorkerId,
} from "../../../ts/runtime-contract";
import type { CorrelationId, RunId, TenantId } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { applyRunTransition } from "../runtime/run-transition";
import { requireString, unknownToReason } from "./worker-util";
import type { PgRuntimeWorkerOptions, RunRow } from "./runtime-worker";

const DEFAULT_RUN_ABORT_TIMEOUT_MS = 30_000;

type RunAbortSourceStatus = "running" | "suspended" | "resume_requested" | "resuming";
type RunAbortTxAResult =
  | { kind: "ready"; intent: RunAbortDrainInput }
  | {
      kind: "finalize";
      event: "drain_ok" | "drain_timeout";
      correlationId: string;
      leaseId?: string;
      workerId?: string;
    }
  | { kind: "job_result"; result: RuntimeJobResult };

export class RunAbortRunner {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: PgRuntimeWorkerOptions = {},
  ) {}

  async handleRunAbort(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "run_abort.tenantId");
    const runId = requireString(job.runId, "run_abort.runId");
    const timeoutMs = job.abortTimeoutMs ?? this.options.runAbortTimeoutMs ?? DEFAULT_RUN_ABORT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("RuntimeWorker: run_abort timeoutMs must be a positive integer");
    }

    const txA = await withTenantTx(this.pool, tenantId, async (client): Promise<RunAbortTxAResult> => {
      const run = await client.query<RunRow & { worker_id: string | null; abort_source_status: RunAbortSourceStatus | null }>(
        `SELECT status, correlation_id::text, worker_id::text, abort_source_status
           FROM runs
          WHERE tenant_id = $1::uuid AND id = $2::uuid
          FOR UPDATE`,
        [tenantId, runId],
      );
      const row = run.rows[0];
      if (row === undefined) {
        return { kind: "job_result", result: { kind: "failed", code: "RUN_NOT_FOUND" } };
      }
      if (row.status === "cancelled") {
        return { kind: "job_result", result: { kind: "completed", emittedEvents: [] } };
      }
      if (row.status !== "aborting") {
        return { kind: "job_result", result: { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" } };
      }

      const correlationId = job.correlationId ?? row.correlation_id;
      if (row.abort_source_status === "suspended" || row.abort_source_status === "resume_requested") {
        if (
          row.worker_id !== null &&
          (await this.hasOpenAbortBrowserLeaseForRun(client, { tenantId, runId, workerId: row.worker_id }))
        ) {
          return { kind: "job_result", result: { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" } };
        }
        return { kind: "finalize", event: "drain_ok", correlationId };
      }
      if (row.abort_source_status !== "running" && row.abort_source_status !== "resuming") {
        return { kind: "job_result", result: { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" } };
      }
      if (row.worker_id === null) {
        return { kind: "job_result", result: { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" } };
      }

      const drainer = this.options.runAbortDrainer;
      if (drainer === undefined) {
        throw new Error("RuntimeWorker: run_abort requires an explicit RunAbortDrainer when a browser lease is present");
      }

      const workerId = row.worker_id;
      const claim = await this.claimAbortBrowserLeaseForRun(client, { tenantId, runId, workerId, timeoutMs });
      if (claim.kind === "multiple" || claim.kind === "missing") {
        return { kind: "job_result", result: { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" } };
      }
      if (claim.kind === "deferred") {
        return {
          kind: "job_result",
          result: { kind: "deferred", code: "CONTROL_PLANE_INTERNAL_ERROR", retryAfterMs: claim.retryAfterMs },
        };
      }
      if (claim.kind === "expired") {
        return { kind: "finalize", event: "drain_timeout", correlationId, leaseId: claim.leaseId, workerId };
      }

      return {
        kind: "ready",
        intent: {
          tenantId: tenantId as TenantId,
          runId: runId as RunId,
          leaseId: claim.leaseId as LeaseId,
          workerId: workerId as WorkerId,
          correlationId: correlationId as CorrelationId,
          timeoutMs,
        },
      };
    });

    if (txA.kind === "job_result") return txA.result;
    if (txA.kind === "finalize") {
      return this.finalizeRunAbort(tenantId, runId, txA);
    }

    const drainResult = await this.options.runAbortDrainer!.drainAbort(txA.intent).catch(
      (err): RunAbortDrainResult => ({
        kind: "transient_failed",
        reason: unknownToReason(err),
      }),
    );
    if (drainResult.kind === "transient_failed") {
      await this.releaseAbortBrowserDrainClaim(txA.intent);
      return {
        kind: "deferred",
        code: "CONTROL_PLANE_INTERNAL_ERROR",
        retryAfterMs: drainResult.retryAfterMs ?? 1_000,
      };
    }
    if (drainResult.kind === "terminal_failed") {
      await this.releaseAbortBrowserDrainClaim(txA.intent);
      return { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" };
    }

    return this.finalizeRunAbort(tenantId, runId, {
      event: drainResult.kind === "timeout" ? "drain_timeout" : "drain_ok",
      correlationId: txA.intent.correlationId,
      leaseId: txA.intent.leaseId,
      workerId: txA.intent.workerId,
    });
  }

  private async hasOpenAbortBrowserLeaseForRun(
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

  private async claimAbortBrowserLeaseForRun(
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

  private async releaseAbortBrowserDrainClaim(input: RunAbortDrainInput): Promise<void> {
    await withTenantTx(this.pool, input.tenantId, async (client) => {
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

  private async finalizeRunAbort(
    tenantId: string,
    runId: string,
    input: {
      event: "drain_ok" | "drain_timeout";
      correlationId: string;
      leaseId?: string;
      workerId?: string;
    },
  ): Promise<RuntimeJobResult> {
    return withTenantTx(this.pool, tenantId, async (client) => {
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

      if (input.leaseId !== undefined && input.workerId !== undefined) {
        await this.expireAbortBrowserLease(client, {
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

  private async expireAbortBrowserLease(
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
}

function isOnlyAbortLeasePending(
  pending: readonly { kind: string; lease?: string }[],
  event: "drain_ok" | "drain_timeout",
): boolean {
  const expectedKind = event === "drain_timeout" ? "killLease" : "releaseLease";
  return pending.length === 1 && pending[0]?.kind === expectedKind && pending[0]?.lease === "browser";
}
