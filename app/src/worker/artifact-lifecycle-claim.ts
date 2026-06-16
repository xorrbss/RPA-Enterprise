// artifact 라이프사이클 공용(claim 타입·기본값·getter) — redaction/retention 러너 공유.
import type {
  ArtifactLifecycleTarget,
} from "../../../ts/runtime-contract";
import type { ArtifactLifecycleClaimKind } from "./artifact-lifecycle";
import type { PgRuntimeWorkerOptions } from "./runtime-worker";

export const DEFAULT_ARTIFACT_LIFECYCLE_CLAIM_TTL_MS = 300_000;
export const DEFAULT_ARTIFACT_REDACTION_MAX_ATTEMPTS = 3;
export const DEFAULT_ARTIFACT_LIFECYCLE_RETRY_AFTER_MS = 60_000;
export const DEFAULT_ARTIFACT_LIFECYCLE_AUDIT_RETENTION_DAYS = 90;

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

export function lifecycleClaimTtlMs(options: PgRuntimeWorkerOptions): number {
  const claimTtlMs = options.artifactLifecycleClaimTtlMs ?? DEFAULT_ARTIFACT_LIFECYCLE_CLAIM_TTL_MS;
  if (!Number.isInteger(claimTtlMs) || claimTtlMs <= 0) {
    throw new Error("RuntimeWorker: artifact lifecycle claimTtlMs must be a positive integer");
  }
  return claimTtlMs;
}

export function lifecycleRetryAfterMs(options: PgRuntimeWorkerOptions): number {
  const retryAfterMs = options.artifactLifecycleRetryAfterMs ?? DEFAULT_ARTIFACT_LIFECYCLE_RETRY_AFTER_MS;
  if (!Number.isInteger(retryAfterMs) || retryAfterMs <= 0) {
    throw new Error("RuntimeWorker: artifact lifecycle retryAfterMs must be a positive integer");
  }
  return retryAfterMs;
}

export function lifecycleAuditRetentionDays(options: PgRuntimeWorkerOptions): number {
  const days = options.artifactLifecycleAuditRetentionDays ?? DEFAULT_ARTIFACT_LIFECYCLE_AUDIT_RETENTION_DAYS;
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error("RuntimeWorker: artifact lifecycle audit retention days must be a positive integer");
  }
  return days;
}
