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

// ops-defaults.md §6 artifact.redaction_fail_threshold = 5(초과 시 failed+알림·조회차단). 종전 3 은 계약 미달.
const DEFAULT_ARTIFACT_REDACTION_MAX_ATTEMPTS = 5;

/**
 * redacted-at-rest(감사 AUD-9): redaction 이 원본을 새 redacted 객체로 대체한 뒤 **원본 평문 객체**를 object store
 * 에서 삭제하는 최소 능력. S3ObjectStore/FsObjectStore(ObjectStore.delete)가 구조적으로 충족한다. delete 는 멱등
 * (부재=무시)이라 재시도/재claim 에 안전하다.
 */
export interface SupersededObjectStore {
  delete(objectRef: ObjectRef): Promise<void>;
}

export interface ArtifactRedactionProcessorDeps {
  readonly workerId?: string;
  readonly artifactRedactor?: ArtifactRedactor;
  readonly allowTestArtifactLifecyclePorts?: boolean;
  readonly artifactRedactionMaxAttempts?: number;
  readonly artifactLifecycleClaimTtlMs?: number;
  readonly artifactLifecycleAuditRetentionDays?: number;
  /** AUD-9: redacted 결정으로 대체된 원본 평문 객체 삭제용(미주입 시 삭제 생략 — 후방호환). */
  readonly artifactSupersededObjectStore?: SupersededObjectStore;
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
    // AUD-9(redacted-at-rest): finalize 가 object_ref 를 새 redacted 객체로 교체(redacted 결정)했으면, 커밋 후 원본
    //   평문 객체(PII/credential 가능)를 삭제한다. 순서: finalize 커밋(row→redacted) 후 삭제 — 삭제가 실패해도 row 는
    //   redacted 를 가리켜 read 안전(loud 로그, AUD-10 orphan sweeper/재시도가 잔류 회수). not_required 는 원본 유지라
    //   비해당. finalize CAS 충돌이면 위에서 throw → 이 코드 미도달(잘못 삭제 안 함).
    if (decision.kind === "redacted") {
      const originalRef = claim.claim.artifact.objectRef;
      const deleter = this.deps.artifactSupersededObjectStore;
      if (deleter !== undefined && originalRef !== decision.redactedObjectRef) {
        try {
          await deleter.delete(originalRef);
        } catch (e) {
          console.error(
            `artifact_redaction: superseded 원본 평문 객체 삭제 실패(artifact ${claim.claim.artifact.artifactRef.slice(0, 8)}) — ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }
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
