// PgRuntimeWorker god-class에서 추출한 artifact_redaction 잡 처리기(협력객체, 동작 무변경).
// 순수 leaf. 매핑·검증·공유 getter는 runtime-worker-artifact-lifecycle.ts, BYPASSRLS 감사는 runtime-worker-lifecycle-audit.ts.
import { randomUUID } from "node:crypto";

import type pg from "pg";

import type { ArtifactRef, ObjectRef } from "../../../ts/core-types";
import type {
  ArtifactObjectIoPortBinding,
  ArtifactRedactionDecision,
  ArtifactRedactor,
  RuntimeJobResult,
  RuntimeWorkerJob,
  ScenarioGenerationId,
} from "../../../ts/runtime-contract";
import type { CorrelationId, RunId, TenantId } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { optionalString, requireString } from "./runtime-worker-parse";
import {
  artifactLifecycleJobScope,
  artifactTargetFromRow,
  evidenceFromRedactionDecision,
  lifecycleAuditRetentionDays,
  lifecycleClaimTtlMs,
  lifecycleOperationalAudit,
  requireArtifactObjectIoPortBinding,
  validateArtifactRedactionDecision,
  type ArtifactLifecycleClaim,
  type ArtifactLifecycleClaimResult,
  type ArtifactLifecycleRow,
} from "./runtime-worker-artifact-lifecycle";
import { appendLifecycleAuditWithClient, assertLifecycleBypassUse } from "./runtime-worker-lifecycle-audit";

const DEFAULT_ARTIFACT_REDACTION_MAX_ATTEMPTS = 3;

export interface ArtifactRedactionProcessorDeps {
  readonly workerId?: string;
  readonly artifactRedactor?: ArtifactRedactor;
  readonly allowTestArtifactLifecyclePorts?: boolean;
  readonly artifactRedactionMaxAttempts?: number;
  readonly artifactLifecycleClaimTtlMs?: number;
  readonly artifactLifecycleAuditRetentionDays?: number;
}

export class ArtifactRedactionProcessor {
  constructor(
    private readonly pool: pg.Pool,
    private readonly deps: ArtifactRedactionProcessorDeps,
  ) {}

  async handle(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "artifact_redaction.tenantId");
    const correlationId = requireString(job.correlationId, "artifact_redaction.correlationId");
    const workerId = requireString(
      this.deps.workerId,
      "PgRuntimeWorkerOptions.workerId for artifact_redaction",
    );
    const redactor = this.deps.artifactRedactor;
    if (redactor === undefined) {
      throw new Error("RuntimeWorker: artifact_redaction requires an explicit ArtifactRedactor");
    }
    const portBinding = requireArtifactObjectIoPortBinding(
      redactor.binding,
      "artifact_redaction",
      this.deps.allowTestArtifactLifecyclePorts === true,
    );
    const maxAttempts = this.deps.artifactRedactionMaxAttempts ?? DEFAULT_ARTIFACT_REDACTION_MAX_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
      throw new Error("RuntimeWorker: artifact_redaction maxAttempts must be a positive integer");
    }
    const scope = artifactLifecycleJobScope(job, "artifact_redaction");

    const claim = await withTenantTx(this.pool, tenantId, async (client) => {
      await assertLifecycleBypassUse(client, "artifact_redaction_job", "artifact_lifecycle.redaction.claim");
      return this.claimRedactionArtifact(client, {
        tenantId,
        runId: scope.runId,
        artifactId: optionalString(job.artifactId, "artifact_redaction.artifactId") as ArtifactRef | undefined,
        generationId: scope.generationId,
        workerId,
        correlationId,
        claimTtlMs: lifecycleClaimTtlMs(this.deps.artifactLifecycleClaimTtlMs),
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

  private async claimRedactionArtifact(
    client: pg.PoolClient,
    input: {
      tenantId: string;
      runId: RunId | undefined;
      artifactId: ArtifactRef | undefined;
      generationId: ScenarioGenerationId | undefined;
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
           AND ($4::uuid IS NULL OR id = $4::uuid)
           AND (
             ($2::uuid IS NULL AND $5::uuid IS NULL)
             OR ($2::uuid IS NOT NULL AND run_id = $2::uuid)
             OR ($5::uuid IS NOT NULL AND generation_id = $5::uuid)
           )
           AND lifecycle_claim_id IS NOT NULL
           AND lifecycle_claim_expires_at > now()
        ORDER BY lifecycle_claim_expires_at ASC
        LIMIT 1
        FOR UPDATE`,
      [input.tenantId, input.runId ?? null, input.maxAttempts, input.artifactId ?? null, input.generationId ?? null],
    );
    const activeRow = active.rows[0];
    if (activeRow !== undefined) {
      return { kind: "deferred", retryAfterMs: activeRow.retry_after_ms };
    }

    const artifact = await client.query<ArtifactLifecycleRow>(
      `SELECT id::text, tenant_id::text, run_id::text, generation_id::text, step_id, attempt, type,
              redaction_status, redaction_attempts, sha256, object_ref,
              retention_until::text, legal_hold, quarantine, deleted_at::text,
              deleted_reason, deleted_by_job
         FROM artifacts
        WHERE tenant_id = $1::uuid
          AND redaction_status = 'pending'
          AND redaction_attempts < $3::int
           AND deleted_at IS NULL
           AND quarantine = false
           AND ($4::uuid IS NULL OR id = $4::uuid)
           AND (
             ($2::uuid IS NULL AND $5::uuid IS NULL)
             OR ($2::uuid IS NOT NULL AND run_id = $2::uuid)
             OR ($5::uuid IS NOT NULL AND generation_id = $5::uuid)
           )
           AND (lifecycle_claim_id IS NULL OR lifecycle_claim_expires_at <= now())
        ORDER BY created_at ASC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [input.tenantId, input.runId ?? null, input.maxAttempts, input.artifactId ?? null, input.generationId ?? null],
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
      retentionDays: lifecycleAuditRetentionDays(this.deps.artifactLifecycleAuditRetentionDays),
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
           AND ($8::uuid IS NULL OR id = $8::uuid)
           AND ($9::uuid IS NULL OR generation_id = $9::uuid)
           AND (lifecycle_claim_id IS NULL OR lifecycle_claim_expires_at <= now())`,
      [
        input.tenantId,
        row.id,
        claimId,
        input.workerId,
        input.correlationId,
        input.claimTtlMs,
        input.maxAttempts,
        input.artifactId ?? null,
        input.generationId ?? null,
      ],
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
      retentionDays: lifecycleAuditRetentionDays(this.deps.artifactLifecycleAuditRetentionDays),
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
}
