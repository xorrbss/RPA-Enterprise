// artifact 라이프사이클 잡 실행(redaction/retention) — PgRuntimeWorker에서 분리한 협력 클래스. 로직 무변경.
import { randomUUID } from "node:crypto";

import type pg from "pg";

import type { ObjectRef } from "../../../ts/core-types";
import type {
  ArtifactLifecycleTarget,
  ArtifactObjectIoPortBinding,
  ArtifactRedactionDecision,
  ArtifactRetentionDeleteResult,
  RuntimeJobResult,
  RuntimeWorkerJob,
} from "../../../ts/runtime-contract";
import type { CorrelationId, RunId, TenantId } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { requireString } from "./worker-util";
import {
  type ArtifactLifecycleRow,
  type ArtifactLifecycleClaimKind,
  artifactTargetFromRow,
  lifecycleOperationalAudit,
  requireArtifactObjectIoPortBinding,
  validateArtifactRedactionDecision,
  validateArtifactRetentionDeleteResult,
  evidenceFromRedactionDecision,
  evidenceFromRetentionDeleteResult,
  assertLifecycleBypassUse,
  appendLifecycleAuditWithClient,
} from "./artifact-lifecycle";
import type { PgRuntimeWorkerOptions } from "./runtime-worker";

const DEFAULT_ARTIFACT_LIFECYCLE_CLAIM_TTL_MS = 300_000;
const DEFAULT_ARTIFACT_REDACTION_MAX_ATTEMPTS = 3;
const DEFAULT_ARTIFACT_LIFECYCLE_RETRY_AFTER_MS = 60_000;
const DEFAULT_ARTIFACT_LIFECYCLE_AUDIT_RETENTION_DAYS = 90;

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

export class ArtifactLifecycleRunner {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: PgRuntimeWorkerOptions = {},
  ) {}

  async handleArtifactRedaction(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "artifact_redaction.tenantId");
    const correlationId = requireString(job.correlationId, "artifact_redaction.correlationId");
    const workerId = requireString(
      this.options.workerId,
      "PgRuntimeWorkerOptions.workerId for artifact_redaction",
    );
    const redactor = this.options.artifactRedactor;
    if (redactor === undefined) {
      throw new Error("RuntimeWorker: artifact_redaction requires an explicit ArtifactRedactor");
    }
    const portBinding = requireArtifactObjectIoPortBinding(
      redactor.binding,
      "artifact_redaction",
      this.options.allowTestArtifactLifecyclePorts === true,
    );
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
        portBinding,
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
    const decision = await redactor.redact({
      tenantId: tenantId as TenantId,
      correlationId: correlationId as CorrelationId,
      artifact: claim.claim.artifact,
      policy: { maxAttempts },
      portBinding,
      audit,
    }).catch(() => ({ kind: "retryable_failed", reason: "redactor_exception" }) as const);
    validateArtifactRedactionDecision(decision, {
      operation: "redact",
      artifactRef: claim.claim.artifact.artifactRef,
      correlationId,
      portBinding,
    });

    await withTenantTx(this.pool, tenantId, async (client) => {
      await assertLifecycleBypassUse(client, "artifact_redaction_job", "artifact_lifecycle.redaction.finalize");
      await this.finalizeRedactionDecision(client, { claim: claim.claim, decision, maxAttempts, portBinding });
    });
    return { kind: "completed", emittedEvents: [] };
  }

  async handleArtifactRetention(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "artifact_retention.tenantId");
    const correlationId = requireString(job.correlationId, "artifact_retention.correlationId");
    const workerId = requireString(
      this.options.workerId,
      "PgRuntimeWorkerOptions.workerId for artifact_retention",
    );
    const retentionStore = this.options.artifactRetentionStore;
    if (retentionStore === undefined) {
      throw new Error("RuntimeWorker: artifact_retention requires an explicit ArtifactRetentionStore");
    }
    const portBinding = requireArtifactObjectIoPortBinding(
      retentionStore.binding,
      "artifact_retention",
      this.options.allowTestArtifactLifecyclePorts === true,
    );

    const claim = await withTenantTx(this.pool, tenantId, async (client) => {
      await assertLifecycleBypassUse(client, "artifact_retention_sweeper", "artifact_lifecycle.retention.claim");
      return this.claimRetentionArtifact(client, {
        tenantId,
        workerId,
        correlationId,
        claimTtlMs: this.lifecycleClaimTtlMs(),
        portBinding,
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
    const deleteResult = await retentionStore.deleteObject({
      tenantId: tenantId as TenantId,
      correlationId: correlationId as CorrelationId,
      artifact: claim.claim.artifact,
      jobId: claim.claim.claimId,
      policy: { deleteReason: "retention_expired" },
      portBinding,
      audit,
    }).catch(() => ({ kind: "transient_failed", reason: "retention_store_exception" }) as const);
    validateArtifactRetentionDeleteResult(deleteResult, {
      operation: "delete",
      artifactRef: claim.claim.artifact.artifactRef,
      correlationId,
      portBinding,
    });

    await withTenantTx(this.pool, tenantId, async (client) => {
      await assertLifecycleBypassUse(client, "artifact_retention_sweeper", "artifact_lifecycle.retention.finalize");
      await this.finalizeRetentionDecision(client, { claim: claim.claim, deleteResult, portBinding });
    });
    return { kind: "completed", emittedEvents: [] };
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
      portBinding: ArtifactObjectIoPortBinding;
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
      portBinding: input.portBinding,
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
      portBinding: ArtifactObjectIoPortBinding;
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
      portBinding: input.portBinding,
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
      decision: ArtifactRedactionDecision;
      maxAttempts: number;
      portBinding: ArtifactObjectIoPortBinding;
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
      portBinding: input.portBinding,
      objectIoEvidence: evidenceFromRedactionDecision(input.decision),
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
      deleteResult: ArtifactRetentionDeleteResult;
      portBinding: ArtifactObjectIoPortBinding;
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
      portBinding: input.portBinding,
      objectIoEvidence: evidenceFromRetentionDeleteResult(input.deleteResult),
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
