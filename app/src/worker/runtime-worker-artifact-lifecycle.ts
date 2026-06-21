// runtime-worker.ts 에서 추출 — artifact-lifecycle 잡 매핑·검증·증거(evidence) leaf 헬퍼(동작 무변경).
// 순수/동기 함수 + 소유 도메인 타입(Row/ClaimKind/JobScope). BYPASSRLS 감사·해시는 runtime-worker-lifecycle-audit.ts.
import {
  ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
  ARTIFACT_OBJECT_IO_LOCAL_TEST_SCHEMA_REF,
} from "../../../ts/runtime-contract";
import type { ArtifactRef, ObjectRef, SecretRef } from "../../../ts/core-types";
import type {
  ArtifactLifecycleOperationalAudit,
  ArtifactLifecycleOperationalUseCase,
  ArtifactLifecycleTarget,
  ArtifactObjectIoEvidence,
  ArtifactObjectIoOperation,
  ArtifactObjectIoPortBinding,
  ArtifactRedactionDecision,
  ArtifactRetentionDeleteResult,
  IsoDateTime,
  RuntimeWorkerJob,
  ScenarioGenerationId,
} from "../../../ts/runtime-contract";
import type { CorrelationId, RunId, StepId, TenantId } from "../../../ts/security-middleware-contract";
import { isRecord, optionalString, stringField } from "./runtime-worker-parse";

export type ArtifactLifecycleRow = {
  id: string;
  tenant_id: string;
  run_id: string | null;
  generation_id: string | null;
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
export type ArtifactLifecycleClaimKind = "artifact_redaction" | "artifact_retention";
export type ArtifactLifecycleJobScope = {
  readonly runId: RunId | undefined;
  readonly generationId: ScenarioGenerationId | undefined;
};

export function artifactLifecycleJobScope(job: RuntimeWorkerJob, kind: ArtifactLifecycleClaimKind): ArtifactLifecycleJobScope {
  const runId = optionalString(job.runId, `${kind}.runId`) as RunId | undefined;
  const generationId = optionalString(job.generationId, `${kind}.generationId`) as ScenarioGenerationId | undefined;
  if (runId !== undefined && generationId !== undefined) {
    throw new Error(`RuntimeWorker: ${kind} job cannot set both runId and generationId`);
  }
  return { runId, generationId };
}

export function artifactTargetFromRow(row: ArtifactLifecycleRow): ArtifactLifecycleTarget {
  return {
    tenantId: row.tenant_id as TenantId,
    artifactRef: row.id as ArtifactRef,
    objectRef: row.object_ref as ObjectRef,
    ...(row.run_id === null ? {} : { runId: row.run_id as RunId }),
    ...(row.generation_id === null ? {} : { generationId: row.generation_id as ScenarioGenerationId }),
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

export function lifecycleOperationalAudit<TUseCase extends ArtifactLifecycleOperationalUseCase>(input: {
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

export function requireArtifactObjectIoPortBinding(
  value: unknown,
  jobKind: ArtifactLifecycleClaimKind,
  allowTestPort: boolean,
): ArtifactObjectIoPortBinding {
  if (!isRecord(value)) {
    throw new Error(`RuntimeWorker: ${jobKind} requires a real object-store port binding with SecretRef`);
  }
  const kind = value.kind;
  if (kind === "real_object_store") {
    const backendAlias = stringField(value, "backendAlias");
    const credentialRef = stringField(value, "credentialRef");
    const mayBeUsedAsStagingEvidence = value.mayBeUsedAsStagingEvidence;
    if (
      backendAlias === null ||
      credentialRef === null ||
      value.evidenceSchemaRef !== ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF ||
      typeof mayBeUsedAsStagingEvidence !== "boolean"
    ) {
      throw new Error(`RuntimeWorker: ${jobKind} real object-store port binding requires backendAlias, SecretRef, artifact/object-io-evidence@1, and explicit staging evidence flag`);
    }
    return {
      kind,
      backendAlias,
      credentialRef: credentialRef as SecretRef,
      evidenceSchemaRef: ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
      mayBeUsedAsStagingEvidence,
    };
  }
  if (kind === "test_fake") {
    if (!allowTestPort) {
      throw new Error(
        `RuntimeWorker: ${jobKind} test_fake artifact lifecycle port is local-test-only and cannot be used as staging object-store evidence`,
      );
    }
    if (
      value.backendAlias !== "local-test-fake" ||
      value.evidenceSchemaRef !== ARTIFACT_OBJECT_IO_LOCAL_TEST_SCHEMA_REF ||
      value.testOnly !== true
    ) {
      throw new Error(`RuntimeWorker: ${jobKind} test_fake port binding must use artifact/object-io-local-test@1`);
    }
    return {
      kind,
      backendAlias: "local-test-fake",
      evidenceSchemaRef: ARTIFACT_OBJECT_IO_LOCAL_TEST_SCHEMA_REF,
      testOnly: true,
    };
  }
  throw new Error(`RuntimeWorker: ${jobKind} requires a real object-store port binding with SecretRef`);
}

export function validateArtifactRedactionDecision(
  decision: ArtifactRedactionDecision,
  expected: {
    operation: ArtifactObjectIoOperation;
    artifactRef: ArtifactRef;
    correlationId: string;
    portBinding: ArtifactObjectIoPortBinding;
  },
): void {
  switch (decision.kind) {
    case "redacted":
      if (typeof decision.redactedObjectRef !== "string" || decision.redactedObjectRef.trim().length === 0) {
        throw new Error("RuntimeWorker: artifact_redaction redacted result requires redactedObjectRef");
      }
      if (typeof decision.sha256 !== "string" || decision.sha256.trim().length === 0) {
        throw new Error("RuntimeWorker: artifact_redaction redacted result requires sha256 evidence");
      }
      validateArtifactObjectIoEvidence(decision.evidence, expected, decision.sha256);
      return;
    case "not_required":
      validateArtifactObjectIoEvidence(decision.evidence, expected);
      return;
    case "retryable_failed":
    case "terminal_failed":
      if (decision.evidence !== undefined) validateArtifactObjectIoEvidence(decision.evidence, expected);
      return;
    default:
      throw new Error(
        `RuntimeWorker: artifact_redaction unknown port result kind ${String(
          (decision as { kind?: unknown }).kind ?? "missing",
        )}`,
      );
  }
}

export function validateArtifactRetentionDeleteResult(
  result: ArtifactRetentionDeleteResult,
  expected: {
    operation: ArtifactObjectIoOperation;
    artifactRef: ArtifactRef;
    correlationId: string;
    portBinding: ArtifactObjectIoPortBinding;
  },
): void {
  switch (result.kind) {
    case "deleted":
    case "not_found":
      validateArtifactObjectIoEvidence(result.evidence, expected);
      return;
    case "transient_failed":
      return;
    default:
      throw new Error(
        `RuntimeWorker: artifact_retention unknown port result kind ${String(
          (result as { kind?: unknown }).kind ?? "missing",
        )}`,
      );
  }
}

function validateArtifactObjectIoEvidence(
  evidence: ArtifactObjectIoEvidence | undefined,
  expected: {
    operation: ArtifactObjectIoOperation;
    artifactRef: ArtifactRef;
    correlationId: string;
    portBinding: ArtifactObjectIoPortBinding;
  },
  expectedSha256?: string,
): void {
  if (!isRecord(evidence)) {
    throw new Error("RuntimeWorker: artifact lifecycle success requires object I/O evidence");
  }
  if (
    evidence.operation !== expected.operation ||
    evidence.artifactRef !== expected.artifactRef ||
    evidence.correlationId !== expected.correlationId ||
    evidence.objectRefInternalOnly !== true ||
    stringField(evidence, "receiptId") === null
  ) {
    throw new Error("RuntimeWorker: artifact lifecycle object I/O evidence does not match the claim");
  }
  if (expectedSha256 !== undefined && evidence.sha256 !== expectedSha256) {
    throw new Error("RuntimeWorker: artifact lifecycle object I/O evidence sha256 mismatch");
  }

  if (expected.portBinding.kind === "real_object_store") {
    assertOnlyEvidenceKeys(evidence, [
      "schemaRef",
      "portKind",
      "backendAlias",
      "credentialRef",
      "operation",
      "artifactRef",
      "correlationId",
      "receiptId",
      "objectRefInternalOnly",
      "mayBeUsedAsStagingEvidence",
      "sha256",
    ]);
    if (
      evidence.schemaRef !== ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF ||
      evidence.portKind !== "real_object_store" ||
      evidence.backendAlias !== expected.portBinding.backendAlias ||
      evidence.credentialRef !== expected.portBinding.credentialRef ||
      evidence.mayBeUsedAsStagingEvidence !== expected.portBinding.mayBeUsedAsStagingEvidence
    ) {
      throw new Error("RuntimeWorker: real object-store evidence must match the SecretRef-backed port binding and staging evidence flag");
    }
    return;
  }

  assertOnlyEvidenceKeys(evidence, [
    "schemaRef",
    "portKind",
    "backendAlias",
    "operation",
    "artifactRef",
    "correlationId",
    "receiptId",
    "objectRefInternalOnly",
    "mayBeUsedAsStagingEvidence",
    "sha256",
  ]);
  if (
    evidence.schemaRef !== ARTIFACT_OBJECT_IO_LOCAL_TEST_SCHEMA_REF ||
    evidence.portKind !== "test_fake" ||
    evidence.backendAlias !== "local-test-fake" ||
    evidence.mayBeUsedAsStagingEvidence !== false
  ) {
    throw new Error("RuntimeWorker: test_fake object I/O evidence must remain local-test-only");
  }
}

function assertOnlyEvidenceKeys(evidence: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(evidence)) {
    if (!allowedSet.has(key)) {
      throw new Error(`RuntimeWorker: artifact lifecycle object I/O evidence has unsupported field ${key}`);
    }
  }
}

export function evidenceFromRedactionDecision(decision: ArtifactRedactionDecision): ArtifactObjectIoEvidence | undefined {
  switch (decision.kind) {
    case "redacted":
    case "not_required":
    case "retryable_failed":
    case "terminal_failed":
      return decision.evidence;
  }
}

export function evidenceFromRetentionDeleteResult(result: ArtifactRetentionDeleteResult): ArtifactObjectIoEvidence | undefined {
  switch (result.kind) {
    case "deleted":
    case "not_found":
      return result.evidence;
    case "transient_failed":
      return undefined;
  }
}

const DEFAULT_ARTIFACT_LIFECYCLE_CLAIM_TTL_MS = 300_000;
const DEFAULT_ARTIFACT_LIFECYCLE_AUDIT_RETENTION_DAYS = 90;

export type ArtifactLifecycleClaim = {
  readonly claimId: string;
  readonly kind: ArtifactLifecycleClaimKind;
  readonly tenantId: string;
  readonly workerId: string;
  readonly correlationId: string;
  readonly artifact: ArtifactLifecycleTarget;
};
export type ArtifactLifecycleClaimResult =
  | { readonly kind: "claimed"; readonly claim: ArtifactLifecycleClaim }
  | { readonly kind: "deferred"; readonly retryAfterMs: number }
  | { readonly kind: "empty" };

export function lifecycleClaimTtlMs(configured: number | undefined): number {
  const claimTtlMs = configured ?? DEFAULT_ARTIFACT_LIFECYCLE_CLAIM_TTL_MS;
  if (!Number.isInteger(claimTtlMs) || claimTtlMs <= 0) {
    throw new Error("RuntimeWorker: artifact lifecycle claimTtlMs must be a positive integer");
  }
  return claimTtlMs;
}

export function lifecycleAuditRetentionDays(configured: number | undefined): number {
  const days = configured ?? DEFAULT_ARTIFACT_LIFECYCLE_AUDIT_RETENTION_DAYS;
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error("RuntimeWorker: artifact lifecycle audit retention days must be a positive integer");
  }
  return days;
}
