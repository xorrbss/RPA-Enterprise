/**
 * RuntimeWorker — Worker 잡 디스패처 (D2 골격, ts/runtime-contract.ts 구현).
 *
 * 계약: RuntimeWorker.handle(job: RuntimeWorkerJob) → RuntimeJobResult. job kind는
 * release-decisions.md #9의 닫힌 집합. 본 골격은 D2에서 검증 가능한 잡만 구현하고, D3(executor/lease)·
 * D6(pipeline)에 의존하는 잡은 **조용한 no-op 없이** 명시적으로 throw한다(가정 금지).
 *
 * 큐 런너(Graphile Worker) 연결은 D2.5 어댑터에서 본 handle()에 위임한다.
 */
import { createHash, randomUUID } from "node:crypto";

import type pg from "pg";

import {
  SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
  checkBypassRlsUse,
  safeSerialize,
} from "../../../security/compliance-scaffold";
import type { ArtifactRef, ObjectRef } from "../../../ts/core-types";
import type { RunState, WorkitemState } from "../../../ts/state-machine-types";
import type {
  ArtifactLifecycleOperationalAudit,
  ArtifactLifecycleOperationalUseCase,
  ArtifactLifecycleTarget,
  ArtifactRedactor,
  ArtifactRetentionStore,
  EventId,
  IsoDateTime,
  LeaseCleanupPolicy,
  LeaseIsolation,
  LeaseId,
  LeaseRenewResult,
  RunAbortDrainInput,
  RunAbortDrainResult,
  RunAbortDrainer,
  ResumeTokenEnvelope,
  RuntimeJobResult,
  RuntimeWorker,
  RuntimeWorkerJob,
  SessionRestoreInput,
  SessionRestoreResult,
  SessionRestorer,
  WorkerId,
} from "../../../ts/runtime-contract";
import type { CorrelationId, RunId, StepId, TenantId } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { applyRunTransition } from "../runtime/run-transition";
import { applyWorkitemTransition } from "../runtime/workitem-transition";
import { relayOutbox } from "../runtime/outbox-relay";

export interface BrowserLeasePlan {
  readonly siteProfileId: string;
  readonly browserIdentityId: string;
  readonly isolation?: LeaseIsolation;
  readonly cleanupPolicy?: LeaseCleanupPolicy;
  readonly ttlMs?: number;
  readonly downloadDirRef?: string;
}

export type BrowserLeasePlanResolver = (
  client: pg.PoolClient,
  input: { tenantId: string; runId: string },
) => Promise<BrowserLeasePlan | null>;

export interface PgRuntimeWorkerOptions {
  readonly workerId?: string;
  readonly browserLeasePlanResolver?: BrowserLeasePlanResolver;
  readonly sessionRestorer?: SessionRestorer;
  readonly runAbortDrainer?: RunAbortDrainer;
  readonly artifactRedactor?: ArtifactRedactor;
  readonly artifactRetentionStore?: ArtifactRetentionStore;
  readonly defaultBrowserLeaseTtlMs?: number;
  readonly artifactRedactionMaxAttempts?: number;
  readonly artifactLifecycleClaimTtlMs?: number;
  readonly artifactLifecycleRetryAfterMs?: number;
  readonly artifactLifecycleAuditRetentionDays?: number;
  readonly runAbortTimeoutMs?: number;
}

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

type RunRow = { status: RunState; correlation_id: string };
type RunResumeRow = RunRow & { resume_token: unknown };
type RunResumeIntent = SessionRestoreInput;
type RunResumeTxAResult =
  | { kind: "ready"; intent: RunResumeIntent }
  | { kind: "job_result"; result: RuntimeJobResult };
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
type WorkitemRow = { status: WorkitemState };
type ArtifactLifecycleRow = {
  id: string;
  tenant_id: string;
  run_id: string | null;
  step_id: string | null;
  attempt: number | null;
  type: string;
  redaction_status: ArtifactLifecycleTarget["redactionStatus"];
  redaction_attempts: number;
  sha256: string | null;
  object_ref: string;
  retention_until: string | null;
  legal_hold: boolean;
  quarantine: boolean;
  deleted_at: string | null;
  deleted_reason: string | null;
  deleted_by_job: string | null;
};
type ArtifactLifecycleClaimKind = "artifact_redaction" | "artifact_retention";
type ArtifactLifecycleClaim = {
  readonly claimId: string;
  readonly kind: ArtifactLifecycleClaimKind;
  readonly tenantId: string;
  readonly workerId: string;
  readonly correlationId: string;
  readonly artifact: ArtifactLifecycleTarget;
};
type ArtifactLifecycleClaimResult =
  | { readonly kind: "claimed"; readonly claim: ArtifactLifecycleClaim }
  | { readonly kind: "deferred"; readonly retryAfterMs: number }
  | { readonly kind: "empty" };
type LifecycleAuditAppendInput = {
  readonly tenantId: string;
  readonly correlationId: string;
  readonly workerId: string;
  readonly useCase: ArtifactLifecycleOperationalUseCase;
  readonly jobKind: "artifact_redaction" | "artifact_retention";
  readonly reasonCode: string;
  readonly artifact: ArtifactLifecycleTarget;
  readonly jobId: string;
  readonly retentionDays: number;
};
const DEFAULT_BROWSER_LEASE_TTL_MS = 300_000;
const DEFAULT_ARTIFACT_LIFECYCLE_CLAIM_TTL_MS = 300_000;
const DEFAULT_ARTIFACT_REDACTION_MAX_ATTEMPTS = 3;
const DEFAULT_ARTIFACT_LIFECYCLE_RETRY_AFTER_MS = 60_000;
const DEFAULT_ARTIFACT_LIFECYCLE_AUDIT_RETENTION_DAYS = 90;
const DEFAULT_RUN_ABORT_TIMEOUT_MS = 30_000;

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

export class PgRuntimeWorker implements RuntimeWorker {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: PgRuntimeWorkerOptions = {},
  ) {}

  async handle(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    switch (job.kind) {
      case "outbox_relay": {
        if (job.tenantId === undefined) {
          throw new Error("RuntimeWorker: outbox_relay requires tenantId (RLS-scoped relay)");
        }
        const { publishedEventIds } = await withTenantTx(this.pool, job.tenantId, (c) => relayOutbox(c));
        return { kind: "completed", emittedEvents: publishedEventIds as readonly EventId[] };
      }

      case "run_claim":
        return this.handleRunClaim(job);

      case "run_abort":
        return this.handleRunAbort(job);

      case "lease_sweeper":
        return this.handleLeaseSweeper(job);

      case "workitem_checkout":
        return this.handleWorkitemCheckout(job);

      case "run_resume":
        return this.handleRunResume(job);

      // D3(executor/lease)·D6(pipeline) 의존 — D2 골격 미구현. 조용한 no-op 금지: 명시적 throw.
      case "artifact_redaction":
        return this.handleArtifactRedaction(job);

      case "artifact_retention":
        return this.handleArtifactRetention(job);

      case "dlq_replay":
        throw new Error(
          `RuntimeWorker: job kind '${job.kind}' is not implemented in D2 (pending D3 executor/lease or D6 pipeline)`,
        );

      default: {
        // 닫힌 union 외 값 — 컴파일 타임 exhaustiveness + 런타임 방어.
        const exhaustive: never = job.kind;
        throw new Error(`RuntimeWorker: unknown job kind ${String(exhaustive)}`);
      }
    }
  }

  private async handleRunClaim(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "run_claim.tenantId");
    const runId = requireString(job.runId, "run_claim.runId");
    const workerId = requireString(
      this.options.workerId,
      "PgRuntimeWorkerOptions.workerId for run_claim",
    );
    const leasePlanResolver = this.options.browserLeasePlanResolver;
    if (leasePlanResolver === undefined) {
      throw new Error("RuntimeWorker: run_claim requires an explicit BrowserLeasePlanResolver");
    }

    return withTenantTx(this.pool, tenantId, async (client) => {
      const run = await this.loadExpectedRun(client, tenantId, runId, "queued");
      if (run.kind !== "ok") return run.result;

      const lease = await this.acquireBrowserLease(client, {
        tenantId,
        runId,
        workerId,
        plan: await leasePlanResolver(client, { tenantId, runId }),
      });
      if (lease.kind !== "acquired") return lease;

      const transition = await applyRunTransition(client, {
        tenantId,
        runId,
        fromStatus: "queued",
        event: { type: "worker.claimed" },
        guard: { leaseAcquired: true },
        correlationId: job.correlationId ?? run.row.correlation_id,
        workerId,
        eventIdempotencyKey: `${runId}:run_claim`,
      });

      if (!transition.applied) {
        throw new Error(
          `RuntimeWorker: run_claim CAS conflict after row lock; observed=${transition.observed ?? "null"}`,
        );
      }
      if (transition.pending.length > 0) {
        throw new Error("RuntimeWorker: run_claim produced unsupported pending side effects");
      }

      return {
        kind: "completed",
        emittedEvents: transition.emitted.map((e) => e.eventId as EventId),
      };
    });
  }

  private async handleRunAbort(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
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

  private async handleWorkitemCheckout(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "workitem_checkout.tenantId");
    const workitemId = requireString(job.workitemId, "workitem_checkout.workitemId");
    const correlationId = requireString(job.correlationId, "workitem_checkout.correlationId");
    const workerId = requireString(
      this.options.workerId,
      "PgRuntimeWorkerOptions.workerId for workitem_checkout",
    );

    return withTenantTx(this.pool, tenantId, async (client) => {
      const current = await client.query<WorkitemRow>(
        `SELECT status
           FROM workitems
          WHERE tenant_id = $1::uuid AND id = $2::uuid
          FOR UPDATE`,
        [tenantId, workitemId],
      );
      const row = current.rows[0];
      if (row === undefined) {
        return { kind: "failed", code: "RESOURCE_NOT_FOUND" };
      }
      if (row.status !== "new") {
        return { kind: "failed", code: "WORKITEM_CHECKOUT_CONFLICT" };
      }

      const transition = await applyWorkitemTransition(client, {
        tenantId,
        workitemId,
        fromStatus: "new",
        event: { type: "checkout" },
        guard: { uniqueReferenceFree: true },
        correlationId,
        runId: job.runId,
        workerId,
        eventIdempotencyKey: `${workitemId}:workitem_checkout`,
      });

      if (!transition.applied) {
        throw new Error(
          `RuntimeWorker: workitem_checkout CAS conflict after row lock; observed=${transition.observed ?? "null"}`,
        );
      }
      if (transition.pending.length > 0) {
        throw new Error("RuntimeWorker: workitem_checkout produced unsupported pending side effects");
      }

      return {
        kind: "completed",
        emittedEvents: transition.emitted.map((e) => e.eventId as EventId),
      };
    });
  }

  private async handleLeaseSweeper(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "lease_sweeper.tenantId");
    await withTenantTx(this.pool, tenantId, async (client) => {
      await client.query(
        `UPDATE browser_leases
            SET state = 'expired'
          WHERE tenant_id = $1::uuid
            AND state IN ('reserved','active')
            AND expires_at < now()`,
        [tenantId],
      );
      await client.query(
        `UPDATE credential_leases
            SET status = 'expired'
          WHERE tenant_id = $1::uuid
            AND status = 'active'
            AND locked_until < now()`,
        [tenantId],
      );
    });
    return { kind: "completed", emittedEvents: [] };
  }

  private async handleRunResume(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "run_resume.tenantId");
    const runId = requireString(job.runId, "run_resume.runId");
    const workerId = requireString(
      this.options.workerId,
      "PgRuntimeWorkerOptions.workerId for run_resume",
    );
    const leasePlanResolver = this.options.browserLeasePlanResolver;
    if (leasePlanResolver === undefined) {
      throw new Error("RuntimeWorker: run_resume requires an explicit BrowserLeasePlanResolver");
    }
    const sessionRestorer = this.options.sessionRestorer;
    if (sessionRestorer === undefined) {
      throw new Error("RuntimeWorker: run_resume requires an explicit SessionRestorer");
    }

    const txA = await withTenantTx(this.pool, tenantId, async (client): Promise<RunResumeTxAResult> => {
      const run = await client.query<RunResumeRow>(
        `SELECT status, correlation_id::text, resume_token
           FROM runs
          WHERE tenant_id = $1::uuid AND id = $2::uuid
          FOR UPDATE`,
        [tenantId, runId],
      );
      const row = run.rows[0];
      if (row === undefined) {
        return { kind: "job_result", result: { kind: "failed", code: "RUN_NOT_FOUND" } };
      }
      if (row.status !== "resume_requested" && row.status !== "resuming") {
        return {
          kind: "job_result",
          result: { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" },
        };
      }

      const token = parseResumeTokenEnvelope(row.resume_token, runId);
      if (token === null) {
        return {
          kind: "job_result",
          result: { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" },
        };
      }

      let lease = await this.findActiveBrowserLeaseForRun(client, {
        tenantId,
        runId,
        workerId,
      });
      if (lease === null) {
        const acquired = await this.acquireBrowserLease(client, {
          tenantId,
          runId,
          workerId,
          plan: await leasePlanResolver(client, { tenantId, runId }),
        });
        if (acquired.kind !== "acquired") return { kind: "job_result", result: acquired };
        lease = acquired.leaseId;
      }

      if (row.status === "resume_requested") {
        const transition = await applyRunTransition(client, {
          tenantId,
          runId,
          fromStatus: "resume_requested",
          event: { type: "worker.claimed" },
          guard: { leaseAcquired: true },
          correlationId: job.correlationId ?? row.correlation_id,
          workerId,
          eventIdempotencyKey: `${runId}:run_resume:r17`,
        });

        if (!transition.applied) {
          throw new Error(
            `RuntimeWorker: run_resume R17 CAS conflict after row lock; observed=${transition.observed ?? "null"}`,
          );
        }
        if (!isOnlyRestoreSessionPending(transition.pending)) {
          throw new Error("RuntimeWorker: run_resume R17 produced unsupported pending side effects");
        }
      }

      await client.query(
        `UPDATE runs
            SET worker_id = $3::uuid,
                updated_at = now()
          WHERE tenant_id = $1::uuid
            AND id = $2::uuid
            AND status = 'resuming'`,
        [tenantId, runId, workerId],
      );

      return {
        kind: "ready",
        intent: {
          tenantId: tenantId as TenantId,
          runId: runId as RunId,
          leaseId: lease as LeaseId,
          workerId: workerId as WorkerId,
          correlationId: (job.correlationId ?? row.correlation_id) as CorrelationId,
          token,
          expectedPageStateRef: token.pageStateRef,
          resumeNodeId: token.resumeNodeId,
        },
      };
    });

    if (txA.kind === "job_result") return txA.result;

    const restoreResult = await sessionRestorer.restoreSession(txA.intent).catch(
      (err): SessionRestoreResult => ({
        kind: "terminal_failure",
        reason: unknownToReason(err),
      }),
    );

    return withTenantTx(this.pool, tenantId, async (client) => {
      const run = await client.query<RunRow>(
        `SELECT status, correlation_id::text
           FROM runs
          WHERE tenant_id = $1::uuid AND id = $2::uuid
          FOR UPDATE`,
        [tenantId, runId],
      );
      const row = run.rows[0];
      if (row === undefined) {
        return { kind: "failed", code: "RUN_NOT_FOUND" };
      }
      if (row.status !== "resuming") {
        return { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" };
      }

      const next = restoreTransitionFor(restoreResult, txA.intent.expectedPageStateRef);
      const transition = await applyRunTransition(client, {
        tenantId,
        runId,
        fromStatus: "resuming",
        event: next.event,
        guard: next.guard,
        correlationId: job.correlationId ?? row.correlation_id,
        workerId,
        eventIdempotencyKey: `${runId}:run_resume`,
      });

      if (!transition.applied) {
        throw new Error(
          `RuntimeWorker: run_resume ${next.event.type} CAS conflict after row lock; observed=${
            transition.observed ?? "null"
          }`,
        );
      }
      if (transition.pending.length > 0) {
        throw new Error("RuntimeWorker: run_resume completion produced unsupported pending side effects");
      }

      return {
        kind: "completed",
        emittedEvents: transition.emitted.map((e) => e.eventId as EventId),
      };
    });
  }

  private async handleArtifactRedaction(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "artifact_redaction.tenantId");
    const correlationId = requireString(job.correlationId, "artifact_redaction.correlationId");
    const workerId = requireString(
      this.options.workerId,
      "PgRuntimeWorkerOptions.workerId for artifact_redaction",
    );
    if (this.options.artifactRedactor === undefined) {
      throw new Error("RuntimeWorker: artifact_redaction requires an explicit ArtifactRedactor");
    }
    const maxAttempts = this.options.artifactRedactionMaxAttempts ?? DEFAULT_ARTIFACT_REDACTION_MAX_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
      throw new Error("RuntimeWorker: artifact_redaction maxAttempts must be a positive integer");
    }

    const claim = await withTenantTx(this.pool, tenantId, async (client) => {
      await assertLifecycleBypassUse(client, "artifact_redaction_job", "artifact_lifecycle.redaction.claim");
      return this.claimRedactionArtifact(client, {
        tenantId,
        runId: job.runId,
        workerId,
        correlationId,
        claimTtlMs: this.lifecycleClaimTtlMs(),
        maxAttempts,
      });
    });
    if (claim.kind === "deferred") {
      return { kind: "deferred", code: "SESSION_LOCKED", retryAfterMs: claim.retryAfterMs };
    }
    if (claim.kind === "empty") {
      return { kind: "completed", emittedEvents: [] };
    }

    const audit = lifecycleOperationalAudit({
      useCase: "artifact_redaction_job",
      correlationId,
      reasonCode: "artifact_lifecycle.redaction.object_io",
    });
    const decision = await this.options.artifactRedactor.redact({
      tenantId: tenantId as TenantId,
      correlationId: correlationId as CorrelationId,
      artifact: claim.claim.artifact,
      policy: { maxAttempts },
      audit,
    }).catch(() => ({ kind: "retryable_failed", reason: "redactor_exception" }) as const);

    await withTenantTx(this.pool, tenantId, async (client) => {
      await assertLifecycleBypassUse(client, "artifact_redaction_job", "artifact_lifecycle.redaction.finalize");
      await this.finalizeRedactionDecision(client, { claim: claim.claim, decision, maxAttempts });
    });
    return { kind: "completed", emittedEvents: [] };
  }

  private async handleArtifactRetention(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "artifact_retention.tenantId");
    const correlationId = requireString(job.correlationId, "artifact_retention.correlationId");
    const workerId = requireString(
      this.options.workerId,
      "PgRuntimeWorkerOptions.workerId for artifact_retention",
    );
    if (this.options.artifactRetentionStore === undefined) {
      throw new Error("RuntimeWorker: artifact_retention requires an explicit ArtifactRetentionStore");
    }

    const claim = await withTenantTx(this.pool, tenantId, async (client) => {
      await assertLifecycleBypassUse(client, "artifact_retention_sweeper", "artifact_lifecycle.retention.claim");
      return this.claimRetentionArtifact(client, {
        tenantId,
        workerId,
        correlationId,
        claimTtlMs: this.lifecycleClaimTtlMs(),
      });
    });
    if (claim.kind === "deferred") {
      return { kind: "deferred", code: "SESSION_LOCKED", retryAfterMs: claim.retryAfterMs };
    }
    if (claim.kind === "empty") {
      return { kind: "completed", emittedEvents: [] };
    }

    const audit = lifecycleOperationalAudit({
      useCase: "artifact_retention_sweeper",
      correlationId,
      reasonCode: "artifact_lifecycle.retention.object_delete",
    });
    const deleteResult = await this.options.artifactRetentionStore.deleteObject({
      tenantId: tenantId as TenantId,
      correlationId: correlationId as CorrelationId,
      artifact: claim.claim.artifact,
      jobId: claim.claim.claimId,
      policy: { deleteReason: "retention_expired" },
      audit,
    }).catch(() => ({ kind: "transient_failed", reason: "retention_store_exception" }) as const);

    await withTenantTx(this.pool, tenantId, async (client) => {
      await assertLifecycleBypassUse(client, "artifact_retention_sweeper", "artifact_lifecycle.retention.finalize");
      await this.finalizeRetentionDecision(client, { claim: claim.claim, deleteResult });
    });
    return { kind: "completed", emittedEvents: [] };
  }

  private async loadExpectedRun(
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

  private async acquireBrowserLease(
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

  private async findActiveBrowserLeaseForRun(
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

  private async claimRedactionArtifact(
    client: pg.PoolClient,
    input: {
      tenantId: string;
      runId: RunId | undefined;
      workerId: string;
      correlationId: string;
      claimTtlMs: number;
      maxAttempts: number;
    },
  ): Promise<ArtifactLifecycleClaimResult> {
    const active = await client.query<{ retry_after_ms: number }>(
      `SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (lifecycle_claim_expires_at - now())) * 1000))::int AS retry_after_ms
         FROM artifacts
        WHERE tenant_id = $1::uuid
          AND redaction_status = 'pending'
          AND redaction_attempts < $3::int
          AND deleted_at IS NULL
          AND quarantine = false
          AND ($2::uuid IS NULL OR run_id = $2::uuid)
          AND lifecycle_claim_id IS NOT NULL
          AND lifecycle_claim_expires_at > now()
        ORDER BY lifecycle_claim_expires_at ASC
        LIMIT 1
        FOR UPDATE`,
      [input.tenantId, input.runId ?? null, input.maxAttempts],
    );
    const activeRow = active.rows[0];
    if (activeRow !== undefined) {
      return { kind: "deferred", retryAfterMs: activeRow.retry_after_ms };
    }

    const artifact = await client.query<ArtifactLifecycleRow>(
      `SELECT id::text, tenant_id::text, run_id::text, step_id, attempt, type,
              redaction_status, redaction_attempts, sha256, object_ref,
              retention_until::text, legal_hold, quarantine, deleted_at::text,
              deleted_reason, deleted_by_job
         FROM artifacts
        WHERE tenant_id = $1::uuid
          AND redaction_status = 'pending'
          AND redaction_attempts < $3::int
          AND deleted_at IS NULL
          AND quarantine = false
          AND ($2::uuid IS NULL OR run_id = $2::uuid)
          AND (lifecycle_claim_id IS NULL OR lifecycle_claim_expires_at <= now())
        ORDER BY created_at ASC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [input.tenantId, input.runId ?? null, input.maxAttempts],
    );
    const row = artifact.rows[0];
    if (row === undefined) {
      return { kind: "empty" };
    }

    const claimId = randomUUID();
    const target = artifactTargetFromRow(row);
    await appendLifecycleAuditWithClient(client, {
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      workerId: input.workerId,
      useCase: "artifact_redaction_job",
      jobKind: "artifact_redaction",
      reasonCode: "artifact_lifecycle.redaction.claim",
      artifact: target,
      jobId: claimId,
      retentionDays: this.lifecycleAuditRetentionDays(),
    });

    const claimed = await client.query(
      `UPDATE artifacts
          SET lifecycle_claim_id = $3::uuid,
              lifecycle_claim_kind = 'artifact_redaction',
              lifecycle_claim_worker_id = $4::uuid,
              lifecycle_claim_correlation_id = $5::uuid,
              lifecycle_claimed_at = now(),
              lifecycle_claim_expires_at = now() + ($6::int * interval '1 millisecond')
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND redaction_status = 'pending'
          AND redaction_attempts < $7::int
          AND deleted_at IS NULL
          AND quarantine = false
          AND (lifecycle_claim_id IS NULL OR lifecycle_claim_expires_at <= now())`,
      [input.tenantId, row.id, claimId, input.workerId, input.correlationId, input.claimTtlMs, input.maxAttempts],
    );
    if (claimed.rowCount !== 1) {
      throw new Error("RuntimeWorker: artifact_redaction claim CAS conflict");
    }
    return {
      kind: "claimed",
      claim: {
        claimId,
        kind: "artifact_redaction",
        tenantId: input.tenantId,
        workerId: input.workerId,
        correlationId: input.correlationId,
        artifact: target,
      },
    };
  }

  private async claimRetentionArtifact(
    client: pg.PoolClient,
    input: {
      tenantId: string;
      workerId: string;
      correlationId: string;
      claimTtlMs: number;
    },
  ): Promise<ArtifactLifecycleClaimResult> {
    const active = await client.query<{ retry_after_ms: number }>(
      `SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (lifecycle_claim_expires_at - now())) * 1000))::int AS retry_after_ms
         FROM artifacts
        WHERE tenant_id = $1::uuid
          AND deleted_at IS NULL
          AND legal_hold = false
          AND quarantine = false
          AND retention_until IS NOT NULL
          AND retention_until <= now()
          AND lifecycle_claim_id IS NOT NULL
          AND lifecycle_claim_expires_at > now()
        ORDER BY lifecycle_claim_expires_at ASC
        LIMIT 1
        FOR UPDATE`,
      [input.tenantId],
    );
    const activeRow = active.rows[0];
    if (activeRow !== undefined) {
      return { kind: "deferred", retryAfterMs: activeRow.retry_after_ms };
    }

    const artifact = await client.query<ArtifactLifecycleRow>(
      `SELECT id::text, tenant_id::text, run_id::text, step_id, attempt, type,
              redaction_status, redaction_attempts, sha256, object_ref,
              retention_until::text, legal_hold, quarantine, deleted_at::text,
              deleted_reason, deleted_by_job
         FROM artifacts
        WHERE tenant_id = $1::uuid
          AND deleted_at IS NULL
          AND legal_hold = false
          AND quarantine = false
          AND retention_until IS NOT NULL
          AND retention_until <= now()
          AND (lifecycle_claim_id IS NULL OR lifecycle_claim_expires_at <= now())
        ORDER BY retention_until ASC, created_at ASC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [input.tenantId],
    );
    const row = artifact.rows[0];
    if (row === undefined) {
      return { kind: "empty" };
    }

    const claimId = randomUUID();
    const target = artifactTargetFromRow(row);
    await appendLifecycleAuditWithClient(client, {
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      workerId: input.workerId,
      useCase: "artifact_retention_sweeper",
      jobKind: "artifact_retention",
      reasonCode: "artifact_lifecycle.retention.claim",
      artifact: target,
      jobId: claimId,
      retentionDays: this.lifecycleAuditRetentionDays(),
    });

    const claimed = await client.query(
      `UPDATE artifacts
          SET lifecycle_claim_id = $3::uuid,
              lifecycle_claim_kind = 'artifact_retention',
              lifecycle_claim_worker_id = $4::uuid,
              lifecycle_claim_correlation_id = $5::uuid,
              lifecycle_claimed_at = now(),
              lifecycle_claim_expires_at = now() + ($6::int * interval '1 millisecond')
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND deleted_at IS NULL
          AND legal_hold = false
          AND quarantine = false
          AND retention_until IS NOT NULL
          AND retention_until <= now()
          AND (lifecycle_claim_id IS NULL OR lifecycle_claim_expires_at <= now())`,
      [input.tenantId, row.id, claimId, input.workerId, input.correlationId, input.claimTtlMs],
    );
    if (claimed.rowCount !== 1) {
      throw new Error("RuntimeWorker: artifact_retention claim CAS conflict");
    }
    return {
      kind: "claimed",
      claim: {
        claimId,
        kind: "artifact_retention",
        tenantId: input.tenantId,
        workerId: input.workerId,
        correlationId: input.correlationId,
        artifact: target,
      },
    };
  }

  private async finalizeRedactionDecision(
    client: pg.PoolClient,
    input: {
      claim: ArtifactLifecycleClaim;
      decision: Awaited<ReturnType<ArtifactRedactor["redact"]>>;
      maxAttempts: number;
    },
  ): Promise<void> {
    if (input.claim.kind !== "artifact_redaction") {
      throw new Error("RuntimeWorker: artifact_redaction finalize received the wrong claim kind");
    }

    const nextAttempts = input.claim.artifact.redactionAttempts + 1;
    let status: "pending" | "redacted" | "failed" | "not_required";
    let redactedObjectRef: ObjectRef | undefined;
    let sha256: string | undefined;
    switch (input.decision.kind) {
      case "redacted":
        status = "redacted";
        redactedObjectRef = input.decision.redactedObjectRef;
        sha256 = input.decision.sha256;
        break;
      case "not_required":
        status = "not_required";
        break;
      case "retryable_failed":
        status = nextAttempts >= input.maxAttempts ? "failed" : "pending";
        break;
      case "terminal_failed":
        status = "failed";
        break;
      default:
        throw new Error(
          `RuntimeWorker: artifact_redaction unknown port result kind ${String(
            (input.decision as { kind?: unknown }).kind ?? "missing",
          )}`,
        );
    }

    await appendLifecycleAuditWithClient(client, {
      tenantId: input.claim.tenantId,
      correlationId: input.claim.correlationId,
      workerId: input.claim.workerId,
      useCase: "artifact_redaction_job",
      jobKind: "artifact_redaction",
      reasonCode: "artifact_lifecycle.redaction.finalize",
      artifact: input.claim.artifact,
      jobId: `${input.claim.claimId}:finalize`,
      retentionDays: this.lifecycleAuditRetentionDays(),
    });

    const updated = await client.query(
      `UPDATE artifacts
          SET redaction_status = $3,
              redaction_attempts = redaction_attempts + 1,
              object_ref = COALESCE($4, object_ref),
              sha256 = COALESCE($5, sha256),
              lifecycle_claim_id = NULL,
              lifecycle_claim_kind = NULL,
              lifecycle_claim_worker_id = NULL,
              lifecycle_claim_correlation_id = NULL,
              lifecycle_claimed_at = NULL,
              lifecycle_claim_expires_at = NULL
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND lifecycle_claim_id = $6::uuid
          AND lifecycle_claim_kind = 'artifact_redaction'
          AND lifecycle_claim_worker_id = $7::uuid
          AND lifecycle_claim_correlation_id = $8::uuid
          AND lifecycle_claim_expires_at > now()
          AND redaction_status = 'pending'
          AND deleted_at IS NULL
          AND quarantine = false`,
      [
        input.claim.tenantId,
        input.claim.artifact.artifactRef,
        status,
        redactedObjectRef ?? null,
        sha256 ?? null,
        input.claim.claimId,
        input.claim.workerId,
        input.claim.correlationId,
      ],
    );
    if (updated.rowCount !== 1) {
      throw new Error("RuntimeWorker: artifact_redaction finalize CAS conflict after object I/O");
    }
  }

  private async finalizeRetentionDecision(
    client: pg.PoolClient,
    input: {
      claim: ArtifactLifecycleClaim;
      deleteResult: Awaited<ReturnType<ArtifactRetentionStore["deleteObject"]>>;
    },
  ): Promise<void> {
    if (input.claim.kind !== "artifact_retention") {
      throw new Error("RuntimeWorker: artifact_retention finalize received the wrong claim kind");
    }

    let markDeleted: boolean;
    switch (input.deleteResult.kind) {
      case "deleted":
      case "not_found":
        markDeleted = true;
        break;
      case "transient_failed":
        markDeleted = false;
        break;
      default:
        throw new Error(
          `RuntimeWorker: artifact_retention unknown port result kind ${String(
            (input.deleteResult as { kind?: unknown }).kind ?? "missing",
          )}`,
        );
    }

    await appendLifecycleAuditWithClient(client, {
      tenantId: input.claim.tenantId,
      correlationId: input.claim.correlationId,
      workerId: input.claim.workerId,
      useCase: "artifact_retention_sweeper",
      jobKind: "artifact_retention",
      reasonCode: "artifact_lifecycle.retention.finalize",
      artifact: input.claim.artifact,
      jobId: `${input.claim.claimId}:finalize`,
      retentionDays: this.lifecycleAuditRetentionDays(),
    });

    const updated = await client.query(
      `UPDATE artifacts
          SET deleted_at = CASE WHEN $6::boolean THEN now() ELSE deleted_at END,
              deleted_reason = CASE WHEN $6::boolean THEN 'retention_expired' ELSE deleted_reason END,
              deleted_by_job = CASE WHEN $6::boolean THEN $3::text ELSE deleted_by_job END,
              lifecycle_claim_id = NULL,
              lifecycle_claim_kind = NULL,
              lifecycle_claim_worker_id = NULL,
              lifecycle_claim_correlation_id = NULL,
              lifecycle_claimed_at = NULL,
              lifecycle_claim_expires_at = NULL
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND lifecycle_claim_id = $3::uuid
          AND lifecycle_claim_kind = 'artifact_retention'
          AND lifecycle_claim_worker_id = $4::uuid
          AND lifecycle_claim_correlation_id = $5::uuid
          AND lifecycle_claim_expires_at > now()
          AND deleted_at IS NULL
          AND legal_hold = false
          AND quarantine = false
          AND retention_until IS NOT NULL
          AND retention_until <= now()`,
      [
        input.claim.tenantId,
        input.claim.artifact.artifactRef,
        input.claim.claimId,
        input.claim.workerId,
        input.claim.correlationId,
        markDeleted,
      ],
    );
    if (updated.rowCount !== 1) {
      throw new Error("RuntimeWorker: artifact_retention finalize CAS conflict after object deletion");
    }
  }

  private lifecycleClaimTtlMs(): number {
    const claimTtlMs = this.options.artifactLifecycleClaimTtlMs ?? DEFAULT_ARTIFACT_LIFECYCLE_CLAIM_TTL_MS;
    if (!Number.isInteger(claimTtlMs) || claimTtlMs <= 0) {
      throw new Error("RuntimeWorker: artifact lifecycle claimTtlMs must be a positive integer");
    }
    return claimTtlMs;
  }

  private lifecycleRetryAfterMs(): number {
    const retryAfterMs = this.options.artifactLifecycleRetryAfterMs ?? DEFAULT_ARTIFACT_LIFECYCLE_RETRY_AFTER_MS;
    if (!Number.isInteger(retryAfterMs) || retryAfterMs <= 0) {
      throw new Error("RuntimeWorker: artifact lifecycle retryAfterMs must be a positive integer");
    }
    return retryAfterMs;
  }

  private lifecycleAuditRetentionDays(): number {
    const days = this.options.artifactLifecycleAuditRetentionDays ?? DEFAULT_ARTIFACT_LIFECYCLE_AUDIT_RETENTION_DAYS;
    if (!Number.isInteger(days) || days <= 0) {
      throw new Error("RuntimeWorker: artifact lifecycle audit retention days must be a positive integer");
    }
    return days;
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new Error(`RuntimeWorker: ${label} is required`);
}

function parseResumeTokenEnvelope(value: unknown, expectedRunId: string): ResumeTokenEnvelope | null {
  if (!isRecord(value)) return null;
  const runId = stringField(value, "runId");
  const resumeNodeId = stringField(value, "resumeNodeId");
  const pageStateRef = stringField(value, "pageStateRef");
  const issuedAt = stringField(value, "issuedAt");
  const expiresAt = stringField(value, "expiresAt");
  const kid = stringField(value, "kid");
  const hmac = stringField(value, "hmac");
  if (
    runId === null ||
    runId !== expectedRunId ||
    resumeNodeId === null ||
    pageStateRef === null ||
    issuedAt === null ||
    expiresAt === null ||
    kid === null ||
    hmac === null
  ) {
    return null;
  }

  const loopContext = parseLoopContext(value.loopContext);
  if (loopContext === false) return null;
  return {
    runId: runId as RunId,
    resumeNodeId,
    pageStateRef,
    ...(loopContext === undefined ? {} : { loopContext }),
    issuedAt: issuedAt as ResumeTokenEnvelope["issuedAt"],
    expiresAt: expiresAt as ResumeTokenEnvelope["expiresAt"],
    kid,
    hmac,
  };
}

function parseLoopContext(
  value: unknown,
): { iteration: number; pageCount: number } | undefined | false {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return false;
  const iteration = value.iteration;
  const pageCount = value.pageCount;
  if (
    typeof iteration !== "number" ||
    typeof pageCount !== "number" ||
    !Number.isInteger(iteration) ||
    !Number.isInteger(pageCount) ||
    iteration < 0 ||
    pageCount < 0
  ) {
    return false;
  }
  return { iteration, pageCount };
}

function restoreTransitionFor(
  result: SessionRestoreResult,
  expectedPageStateRef: string,
):
  | { event: { type: "restore_ok" }; guard: { restoreOk: true } }
  | { event: { type: "restore_failed" }; guard: { loginBypassPossible: boolean } } {
  if (result.kind === "restored" && result.pageStateRef === expectedPageStateRef) {
    return { event: { type: "restore_ok" }, guard: { restoreOk: true } };
  }
  if (result.kind === "login_bypass") {
    return { event: { type: "restore_failed" }, guard: { loginBypassPossible: true } };
  }
  if (result.kind === "page_state_mismatch") {
    return {
      event: { type: "restore_failed" },
      guard: { loginBypassPossible: result.loginBypassPossible },
    };
  }
  return { event: { type: "restore_failed" }, guard: { loginBypassPossible: false } };
}

function isOnlyRestoreSessionPending(pending: readonly { kind: string }[]): boolean {
  return pending.length === 1 && pending[0]?.kind === "restoreSession";
}

function isOnlyAbortLeasePending(
  pending: readonly { kind: string; lease?: string }[],
  event: "drain_ok" | "drain_timeout",
): boolean {
  const expectedKind = event === "drain_timeout" ? "killLease" : "releaseLease";
  return pending.length === 1 && pending[0]?.kind === expectedKind && pending[0]?.lease === "browser";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function unknownToReason(value: unknown): string {
  if (value instanceof Error && value.message.trim().length > 0) return value.message;
  if (typeof value === "string" && value.trim().length > 0) return value;
  return "session restore failed";
}

function artifactTargetFromRow(row: ArtifactLifecycleRow): ArtifactLifecycleTarget {
  return {
    tenantId: row.tenant_id as TenantId,
    artifactRef: row.id as ArtifactRef,
    objectRef: row.object_ref as ObjectRef,
    ...(row.run_id === null ? {} : { runId: row.run_id as RunId }),
    ...(row.step_id === null ? {} : { stepId: row.step_id as StepId }),
    ...(row.attempt === null ? {} : { attempt: row.attempt }),
    type: row.type,
    redactionStatus: row.redaction_status,
    redactionAttempts: row.redaction_attempts,
    ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
    ...(row.retention_until === null ? {} : { retentionUntil: row.retention_until as IsoDateTime }),
    legalHold: row.legal_hold,
    quarantine: row.quarantine,
    ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at as IsoDateTime }),
    ...(row.deleted_reason === null ? {} : { deletedReason: row.deleted_reason }),
    ...(row.deleted_by_job === null ? {} : { deletedByJob: row.deleted_by_job }),
  };
}

function lifecycleOperationalAudit<TUseCase extends ArtifactLifecycleOperationalUseCase>(input: {
  useCase: TUseCase;
  correlationId: string;
  reasonCode: string;
}): ArtifactLifecycleOperationalAudit & { useCase: TUseCase } {
  return {
    useCase: input.useCase,
    action: "bypassrls.use",
    failClosed: true,
    correlationId: input.correlationId as CorrelationId,
    reasonCode: input.reasonCode,
  };
}

async function assertLifecycleBypassUse(
  client: pg.PoolClient,
  useCase: ArtifactLifecycleOperationalUseCase,
  reasonCode: string,
): Promise<void> {
  const policyDecision = checkBypassRlsUse({
    useCase,
    applicationRole: false,
    servesUserTraffic: false,
    reasonCode,
    immutableAuditAppendConfigured: true,
  });
  if (policyDecision.kind === "deny") {
    throw new Error(`RuntimeWorker: ${useCase} BYPASSRLS denied: ${policyDecision.reasons.join("; ")}`);
  }

  const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT rolsuper, rolbypassrls
       FROM pg_roles
      WHERE rolname = current_user`,
  );
  const row = role.rows[0];
  if (row?.rolsuper === true || row?.rolbypassrls !== true) {
    throw new Error(`RuntimeWorker: ${useCase} requires a non-SUPERUSER dedicated BYPASSRLS operational role`);
  }
}

async function appendLifecycleAudit(pool: pg.Pool, input: LifecycleAuditAppendInput): Promise<void> {
  await withTenantTx(pool, input.tenantId, (client) => appendLifecycleAuditWithClient(client, input));
}

async function appendLifecycleAuditWithClient(client: pg.PoolClient, input: LifecycleAuditAppendInput): Promise<void> {
  const occurredAt = new Date();
  const occurredAtIso = occurredAt.toISOString();
  const retentionUntilIso = new Date(
    occurredAt.getTime() + input.retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const actor = {
    kind: "system",
    id: "runtime-worker",
    worker_id: input.workerId,
  };
  const payload = {
    decision_kind: "artifact_lifecycle.bypassrls_use",
    use_case: input.useCase,
    job_kind: input.jobKind,
    reason_code: input.reasonCode,
    artifact_ref: input.artifact.artifactRef,
    run_id: input.artifact.runId,
    step_id: input.artifact.stepId,
    attempt: input.artifact.attempt,
    redaction_status: input.artifact.redactionStatus,
    retention_until: input.artifact.retentionUntil,
    legal_hold: input.artifact.legalHold,
    quarantine: input.artifact.quarantine,
    deleted_at_present: input.artifact.deletedAt !== undefined,
    object_ref_internal_only: true,
    fail_closed: true,
  };
  const payloadJson = safeSerialize(payload);
  const idempotencyKey = `${input.useCase}:${input.artifact.artifactRef}:${input.jobId}`;

  const previous = await client.query<{ sequence_no: string; hash: string }>(
    `SELECT sequence_no, hash
         FROM audit_log
        WHERE tenant_id = $1::uuid
        ORDER BY sequence_no DESC
        LIMIT 1
        FOR UPDATE`,
    [input.tenantId],
  );
  const previousRow = previous.rows[0];
  const sequence = previousRow === undefined ? 1 : Number(previousRow.sequence_no) + 1;
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(`RuntimeWorker: invalid lifecycle audit sequence for tenant ${input.tenantId}`);
  }
  const previousHash = previousRow?.hash ?? "GENESIS";
  const hash = hashLifecycleAuditRecord({
    tenantId: input.tenantId,
    sequence,
    actor,
    reason: input.reasonCode,
    correlationId: input.correlationId,
    idempotencyKey,
    occurredAt: occurredAtIso,
    retentionUntil: retentionUntilIso,
    payloadJson,
    previousHash,
  });

  await client.query(
    `INSERT INTO audit_log
         (id, tenant_id, sequence_no, actor, action, outcome, reason,
          correlation_id, idempotency_key, occurred_at, payload_schema_ref,
          payload, retention_until, previous_hash, hash)
       VALUES
         ($1::uuid, $2::uuid, $3::bigint, $4::jsonb, 'bypassrls.use', 'allow', $5,
          $6::uuid, $7, $8::timestamptz, $9, $10::jsonb,
          $11::timestamptz, $12, $13)`,
    [
      randomUUID(),
      input.tenantId,
      sequence,
      JSON.stringify(actor),
      input.reasonCode,
      input.correlationId,
      idempotencyKey,
      occurredAtIso,
      SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
      payloadJson,
      retentionUntilIso,
      previousRow?.hash ?? null,
      hash,
    ],
  );
}

function hashLifecycleAuditRecord(input: {
  tenantId: string;
  sequence: number;
  actor: Readonly<Record<string, string>>;
  reason: string;
  correlationId: string;
  idempotencyKey: string;
  occurredAt: string;
  retentionUntil: string;
  payloadJson: string;
  previousHash: string;
}): string {
  const canonical = canonicalize({
    tenantId: input.tenantId,
    sequence: input.sequence,
    actor: input.actor,
    action: "bypassrls.use",
    outcome: "allow",
    reason: input.reason,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt,
    retentionUntil: input.retentionUntil,
    payloadSchemaRef: SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
    payload: JSON.parse(input.payloadJson) as unknown,
    previousHash: input.previousHash,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  const entries = Object.entries(value as Readonly<Record<string, unknown>>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`).join(",")}}`;
}
