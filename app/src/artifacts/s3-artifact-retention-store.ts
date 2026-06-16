/**
 * S3ArtifactRetentionStore — `ArtifactRetentionStore`(ts/runtime-contract.ts) 의 실제 S3 구현.
 *
 * artifact 보존 만료 시 내부 ObjectRef 를 S3 에서 삭제하고, ArtifactObjectIoEvidence(real variant)를
 * 생성한다. checklist row 52(artifact retention/object deletion) 증거를 만든다.
 *
 * 멱등/안전 계약(ARTIFACT_LIFECYCLE_OPERATIONAL_CONTRACT / runtime-contract):
 *  - `deleted`(204) 와 `not_found`(404 NoSuchKey) 는 둘 다 멱등 성공 → evidence 동반.
 *  - `transient_failed`(네트워크/5xx)는 **삭제로 간주 금지**(retentionFailureMustNotTombstone:true) —
 *    상위 finalize 가 artifacts.deleted_at 을 설정하지 않도록 evidence 없이 reason 만 반환한다.
 *  - evidence 는 ObjectRef 와 PlainSecret 을 절대 담지 않는다(evidenceMayContainObjectRef:false,
 *    evidenceMayContainPlainSecret:false). public 표면은 ArtifactRef 만(publicEvidenceUsesArtifactRefOnly).
 *    credentialRef(SecretRef 식별자)는 담아도 된다(evidenceMayContainSecretRefIdentifier:true).
 *  - real_object_store 포트는 SecretRef 백업 필수(realPortRequiresSecretRef). test_fake 바인딩은 본
 *    어댑터의 대상이 아니다(로컬 픽스처 증거 전용 — staging 증거 불가) → 거부한다.
 *
 * 실제 S3 I/O 는 주입된 `S3ObjectStore`(deleteDistinguishing)에 위임한다 — 본 store 는 결과를 계약
 * 결과 kind 로 매핑하고 evidence 를 조립할 뿐이다.
 */
import { randomUUID } from "node:crypto";

import type { ArtifactRef, ObjectRef } from "../../../ts/core-types";
import {
  ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
  type ArtifactObjectIoEvidence,
  type ArtifactObjectIoPortBinding,
  type ArtifactRealObjectStorePortBinding,
  type ArtifactRetentionDeleteRequest,
  type ArtifactRetentionDeleteResult,
  type ArtifactRetentionStore,
} from "../../../ts/runtime-contract";
import { S3ObjectStore, S3ObjectStoreError } from "./s3-object-store";

export class S3ArtifactRetentionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "S3ArtifactRetentionStoreError";
  }
}

export class S3ArtifactRetentionStore implements ArtifactRetentionStore {
  readonly binding: ArtifactObjectIoPortBinding;
  private readonly real: ArtifactRealObjectStorePortBinding;

  constructor(
    private readonly objectStore: S3ObjectStore,
    binding: ArtifactRealObjectStorePortBinding,
  ) {
    // real_object_store 포트만 — test_fake 는 staging/product 삭제 증거를 만들 수 없다(fail-closed).
    if (binding.kind !== "real_object_store") {
      throw new S3ArtifactRetentionStoreError(
        "S3ArtifactRetentionStore requires a real_object_store port binding",
      );
    }
    this.binding = binding;
    this.real = binding;
  }

  async deleteObject(input: ArtifactRetentionDeleteRequest): Promise<ArtifactRetentionDeleteResult> {
    const objectRef: ObjectRef = input.artifact.objectRef;
    try {
      const outcome = await this.objectStore.deleteDistinguishing(objectRef);
      // deleted / not_found 모두 멱등 성공 → 동일 형식의 real evidence 동반.
      return {
        kind: outcome, // "deleted" | "not_found"
        evidence: this.buildEvidence(input),
      };
    } catch (err) {
      // 네트워크/5xx → transient_failed. **삭제로 간주 금지** → evidence 없이 reason 만.
      // reason 에는 status/stage 만(ObjectRef/자격/object 바이트 미포함; portExceptionMessageMayReachLogs:false 준수).
      return { kind: "transient_failed", reason: transientReason(err) };
    }
  }

  /**
   * real variant 증거 조립. artifactRef(public) + backendAlias + credentialRef(SecretRef 식별자) +
   * correlationId + 무작위 receiptId. **ObjectRef/PlainSecret 절대 미포함**, objectRefInternalOnly:true,
   * mayBeUsedAsStagingEvidence:true(real 포트).
   */
  private buildEvidence(input: ArtifactRetentionDeleteRequest): ArtifactObjectIoEvidence {
    const artifactRef: ArtifactRef = input.artifact.artifactRef;
    return {
      schemaRef: ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
      portKind: "real_object_store",
      backendAlias: this.real.backendAlias,
      credentialRef: this.real.credentialRef, // SecretRef 식별자(값 아님) — 노출 허용.
      operation: "delete",
      artifactRef,
      correlationId: input.correlationId,
      receiptId: randomUUID(),
      objectRefInternalOnly: true,
      mayBeUsedAsStagingEvidence: true,
    };
  }
}

/** transient 실패 사유 — status/네트워크만(ObjectRef/자격/바이트 미포함). */
function transientReason(err: unknown): string {
  if (err instanceof S3ObjectStoreError) {
    return err.status !== undefined
      ? `s3 delete transient failure (HTTP ${err.status})`
      : "s3 delete transient failure (network)";
  }
  return "s3 delete transient failure";
}
