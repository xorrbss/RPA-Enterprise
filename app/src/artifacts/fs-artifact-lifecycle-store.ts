import { createHash, randomUUID } from "node:crypto";

import type { ArtifactRef, ObjectRef } from "../../../ts/core-types";
import {
  ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
  type ArtifactLifecycleTarget,
  type ArtifactObjectIoEvidence,
  type ArtifactObjectIoPortBinding,
  type ArtifactRealObjectStorePortBinding,
  type ArtifactRedactionDecision,
  type ArtifactRedactionRequest,
  type ArtifactRedactor,
  type ArtifactRetentionDeleteRequest,
  type ArtifactRetentionDeleteResult,
  type ArtifactRetentionStore,
} from "../../../ts/runtime-contract";
import type { ArtifactContentTransform } from "./s3-artifact-redactor";

export interface FsArtifactObjectStore {
  getBytes(objectRef: ObjectRef): Promise<Uint8Array | null>;
  putBytes(content: Uint8Array): Promise<ObjectRef>;
  delete(objectRef: ObjectRef): Promise<void>;
}

export class FsArtifactLifecycleStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FsArtifactLifecycleStoreError";
  }
}

export class FsArtifactRedactor implements ArtifactRedactor {
  readonly binding: ArtifactObjectIoPortBinding;
  private readonly real: ArtifactRealObjectStorePortBinding;

  constructor(
    private readonly objectStore: FsArtifactObjectStore,
    binding: ArtifactRealObjectStorePortBinding,
    private readonly transform: ArtifactContentTransform | undefined,
  ) {
    if (binding.kind !== "real_object_store") {
      throw new FsArtifactLifecycleStoreError("FsArtifactRedactor requires a real_object_store port binding");
    }
    if (binding.mayBeUsedAsStagingEvidence !== false) {
      throw new FsArtifactLifecycleStoreError("FsArtifactRedactor local_fs evidence must not be marked as staging evidence");
    }
    this.binding = binding;
    this.real = binding;
  }

  async redact(input: ArtifactRedactionRequest): Promise<ArtifactRedactionDecision> {
    if (this.transform === undefined) {
      return {
        kind: "terminal_failed",
        reason: "redaction content transform not configured",
      };
    }

    let sourceBytes: Uint8Array;
    try {
      const bytes = await this.objectStore.getBytes(input.artifact.objectRef);
      if (bytes === null) {
        return { kind: "terminal_failed", reason: "source object not found for redaction" };
      }
      sourceBytes = bytes;
    } catch (err) {
      return this.mapRedactionIoFailure(err, input.artifact, input.policy.maxAttempts);
    }

    let transformed: { kind: "redacted"; bytes: Uint8Array } | { kind: "not_required"; reason: string };
    try {
      transformed = await this.transform.transform(sourceBytes, {
        type: input.artifact.type,
        sha256: input.artifact.sha256,
      });
    } catch {
      return {
        kind: "terminal_failed",
        reason: "redaction content transform failed",
        evidence: this.buildEvidence(input.artifact.artifactRef, input.correlationId, "redact"),
      };
    }

    if (transformed.kind === "not_required") {
      return {
        kind: "not_required",
        reason: transformed.reason,
        evidence: this.buildEvidence(input.artifact.artifactRef, input.correlationId, "redact"),
      };
    }

    try {
      const redactedObjectRef = await this.objectStore.putBytes(transformed.bytes);
      const sha256 = createHash("sha256").update(transformed.bytes).digest("hex");
      return {
        kind: "redacted",
        redactedObjectRef,
        sha256,
        evidence: {
          ...this.buildEvidence(input.artifact.artifactRef, input.correlationId, "redact"),
          sha256,
        },
      };
    } catch (err) {
      return this.mapRedactionIoFailure(err, input.artifact, input.policy.maxAttempts);
    }
  }

  private mapRedactionIoFailure(
    _err: unknown,
    artifact: ArtifactLifecycleTarget,
    maxAttempts: number,
  ): ArtifactRedactionDecision {
    const attemptsAfterThis = artifact.redactionAttempts + 1;
    const reason = "fs redaction I/O failure";
    if (attemptsAfterThis < maxAttempts) return { kind: "retryable_failed", reason };
    return { kind: "terminal_failed", reason };
  }

  private buildEvidence(
    artifactRef: ArtifactRef,
    correlationId: ArtifactRedactionRequest["correlationId"],
    operation: "redact",
  ): ArtifactObjectIoEvidence {
    return {
      schemaRef: ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
      portKind: "real_object_store",
      backendAlias: this.real.backendAlias,
      credentialRef: this.real.credentialRef,
      operation,
      artifactRef,
      correlationId,
      receiptId: randomUUID(),
      objectRefInternalOnly: true,
      mayBeUsedAsStagingEvidence: this.real.mayBeUsedAsStagingEvidence,
    };
  }
}

export class FsArtifactRetentionStore implements ArtifactRetentionStore {
  readonly binding: ArtifactObjectIoPortBinding;
  private readonly real: ArtifactRealObjectStorePortBinding;

  constructor(
    private readonly objectStore: FsArtifactObjectStore,
    binding: ArtifactRealObjectStorePortBinding,
  ) {
    if (binding.kind !== "real_object_store") {
      throw new FsArtifactLifecycleStoreError("FsArtifactRetentionStore requires a real_object_store port binding");
    }
    if (binding.mayBeUsedAsStagingEvidence !== false) {
      throw new FsArtifactLifecycleStoreError("FsArtifactRetentionStore local_fs evidence must not be marked as staging evidence");
    }
    this.binding = binding;
    this.real = binding;
  }

  async deleteObject(input: ArtifactRetentionDeleteRequest): Promise<ArtifactRetentionDeleteResult> {
    try {
      const existing = await this.objectStore.getBytes(input.artifact.objectRef);
      if (existing === null) {
        return {
          kind: "not_found",
          evidence: this.buildEvidence(input.artifact.artifactRef, input.correlationId, "delete"),
        };
      }
      await this.objectStore.delete(input.artifact.objectRef);
      return {
        kind: "deleted",
        evidence: this.buildEvidence(input.artifact.artifactRef, input.correlationId, "delete"),
      };
    } catch {
      return { kind: "transient_failed", reason: "fs delete transient failure" };
    }
  }

  private buildEvidence(
    artifactRef: ArtifactRef,
    correlationId: ArtifactRetentionDeleteRequest["correlationId"],
    operation: "delete",
  ): ArtifactObjectIoEvidence {
    return {
      schemaRef: ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
      portKind: "real_object_store",
      backendAlias: this.real.backendAlias,
      credentialRef: this.real.credentialRef,
      operation,
      artifactRef,
      correlationId,
      receiptId: randomUUID(),
      objectRefInternalOnly: true,
      mayBeUsedAsStagingEvidence: this.real.mayBeUsedAsStagingEvidence,
    };
  }
}
