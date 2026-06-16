// artifact_retention 잡 실행 — PgRuntimeWorker 협력 클래스. 로직 무변경.
import { randomUUID } from "node:crypto";

import type pg from "pg";

import type {
  ArtifactObjectIoPortBinding,
  ArtifactRetentionDeleteResult,
  RuntimeJobResult,
  RuntimeWorkerJob,
} from "../../../ts/runtime-contract";
import type { CorrelationId, TenantId } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { requireString } from "./worker-util";
import {
  type ArtifactLifecycleRow,
  artifactTargetFromRow,
  lifecycleOperationalAudit,
  requireArtifactObjectIoPortBinding,
  validateArtifactRetentionDeleteResult,
  evidenceFromRetentionDeleteResult,
  assertLifecycleBypassUse,
  appendLifecycleAuditWithClient,
} from "./artifact-lifecycle";
import {
  type ArtifactLifecycleClaim,
  type ArtifactLifecycleClaimResult,
  lifecycleClaimTtlMs,
  lifecycleAuditRetentionDays,
} from "./artifact-lifecycle-claim";
import type { PgRuntimeWorkerOptions } from "./runtime-worker";

export class ArtifactRetentionRunner {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: PgRuntimeWorkerOptions = {},
  ) {}

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
        claimTtlMs: lifecycleClaimTtlMs(this.options),
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
      retentionDays: lifecycleAuditRetentionDays(this.options),
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
      retentionDays: lifecycleAuditRetentionDays(this.options),
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
}
