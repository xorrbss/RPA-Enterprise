/**
 * S3ArtifactRedactor — `ArtifactRedactor`(ts/runtime-contract.ts) 의 실제 S3 구현.
 *
 * 내부 ObjectRef 에서 object 를 읽어 **주입된 `ArtifactContentTransform`** 로 마스킹한 뒤, 새 ObjectRef 로
 * 다시 써서 redaction-safe object 를 만들고 sha256/evidence 를 반환한다. checklist row 51(artifact
 * redaction object I/O)을 specified 범위까지 닫는다.
 *
 * ┌─ OPEN DECISION (의도적 미결) ─────────────────────────────────────────────┐
 * │ 마스킹 ALGORITHM 자체는 미결정이다. impl-contracts-bundle.md 는 "마스킹 수행"만   │
 * │ 명시하며 구체 규칙(어떤 PII/패턴을 어떻게 가릴지)은 product-open 결정 대상이다.    │
 * │ 본 어댑터는 **실 S3 object I/O + evidence + fail-closed wiring** 만 제공하고,    │
 * │ 변환 규칙은 `ArtifactContentTransform` 포트로 주입한다(pluggable). 마스킹 변환을   │
 * │ 제공하지 않으면 redaction 은 **fail-closed** — 미마스킹 바이트를 "redacted" 로     │
 * │ 표시하는 조용한 passthrough 를 만들지 않는다("조용한 false 금지").              │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * 보안/멱등 계약(ARTIFACT_LIFECYCLE_OPERATIONAL_CONTRACT / runtime-contract):
 *  - evidence 는 ObjectRef/PlainSecret 절대 미포함(evidenceMayContainObjectRef:false,
 *    evidenceMayContainPlainSecret:false). public 표면은 ArtifactRef 만.
 *  - credentialRef(SecretRef 식별자)는 허용(evidenceMayContainSecretRefIdentifier:true).
 *  - real_object_store 포트 필수(test_fake 는 staging 증거 불가) → 거부.
 *  - S3/transport 오류는 policy.maxAttempts 기준 retryable_failed / terminal_failed 매핑
 *    (reason 에 status/stage 만 — ObjectRef/자격/바이트 미포함).
 */
import { createHash, randomUUID } from "node:crypto";

import type { ArtifactRef, ObjectRef } from "../../../ts/core-types";
import {
  ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
  type ArtifactObjectIoEvidence,
  type ArtifactObjectIoPortBinding,
  type ArtifactLifecycleTarget,
  type ArtifactRealObjectStorePortBinding,
  type ArtifactRedactionDecision,
  type ArtifactRedactionRequest,
  type ArtifactRedactor,
} from "../../../ts/runtime-contract";
import { S3ObjectStore, S3ObjectStoreError } from "./s3-object-store";

/** 변환 입력 메타(시크릿 미포함 — type/sha256 등 분류 힌트만). */
export interface ArtifactContentTransformMeta {
  /** artifacts.type(개방형). */
  type: string;
  /** 원본 sha256(있으면). */
  sha256?: string;
}

/**
 * 마스킹 변환 포트(REQUIRED, 기본 마스킹 구현 없음). 호출자가 실 변환을 주입해야 redaction 이 성립한다.
 *  - `redacted`: 마스킹된 바이트 반환 → 새 ObjectRef 로 기록.
 *  - `not_required`: 마스킹 불필요(예: 민감정보 없음) → 원본 유지, deletion 없이 not_required 결정.
 * 변환이 throw 하면 terminal_failed(잘못된 변환을 redacted 로 위장하지 않는다 — fail-closed).
 */
export interface ArtifactContentTransform {
  transform(
    bytes: Uint8Array,
    meta: ArtifactContentTransformMeta,
  ): Promise<{ kind: "redacted"; bytes: Uint8Array } | { kind: "not_required"; reason: string }>;
}

export class S3ArtifactRedactorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "S3ArtifactRedactorError";
  }
}

export class S3ArtifactRedactor implements ArtifactRedactor {
  readonly binding: ArtifactObjectIoPortBinding;
  private readonly real: ArtifactRealObjectStorePortBinding;

  constructor(
    private readonly objectStore: S3ObjectStore,
    binding: ArtifactRealObjectStorePortBinding,
    /**
     * 마스킹 변환 포트. **필수** — 생략 시 redaction 은 fail-closed(terminal). 기본 마스킹 없음.
     * (생성자에서 undefined 를 받아 redact() 가 fail-closed 하도록 둔다; 누락 자체로 throw 하지 않는 이유는
     *  retention 과 동일한 어댑터-구성 시점이 아니라 호출별 결정을 명시적으로 남기기 위함.)
     */
    private readonly transform: ArtifactContentTransform | undefined,
  ) {
    if (binding.kind !== "real_object_store") {
      throw new S3ArtifactRedactorError(
        "S3ArtifactRedactor requires a real_object_store port binding",
      );
    }
    this.binding = binding;
    this.real = binding;
  }

  async redact(input: ArtifactRedactionRequest): Promise<ArtifactRedactionDecision> {
    // (1) fail-closed: 변환 포트 미주입 → 미마스킹 바이트를 redacted 로 위장하지 않는다.
    if (this.transform === undefined) {
      return {
        kind: "terminal_failed",
        reason: "redaction content transform not configured (masking algorithm is an open decision)",
      };
    }

    const sourceRef: ObjectRef = input.artifact.objectRef;

    // (2) 내부 object 읽기. 부재(null)는 terminal(삭제 대상 없음 — 재시도 무의미).
    let sourceBytes: Uint8Array;
    try {
      const content = await this.objectStore.get(sourceRef);
      if (content === null) {
        return { kind: "terminal_failed", reason: "source object not found for redaction" };
      }
      sourceBytes = new TextEncoder().encode(content);
    } catch (err) {
      return this.mapIoFailure(err, input.artifact, input.policy.maxAttempts);
    }

    // (3) 변환 적용. 변환 throw → terminal(잘못된 변환을 redacted 로 위장하지 않음, fail-closed).
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
        evidence: this.buildEvidence(input),
      };
    }

    if (transformed.kind === "not_required") {
      return {
        kind: "not_required",
        reason: transformed.reason,
        evidence: this.buildEvidence(input),
      };
    }

    // (4) 마스킹된 바이트를 새 ObjectRef 로 기록 + sha256 산출.
    let redactedObjectRef: ObjectRef;
    try {
      const redactedContent = new TextDecoder().decode(transformed.bytes);
      redactedObjectRef = await this.objectStore.put(redactedContent);
    } catch (err) {
      return this.mapIoFailure(err, input.artifact, input.policy.maxAttempts);
    }
    const sha256 = createHash("sha256").update(transformed.bytes).digest("hex");

    return {
      kind: "redacted",
      redactedObjectRef,
      sha256,
      evidence: { ...this.buildEvidence(input), sha256 },
    };
  }

  /** S3/transport 실패 → policy.maxAttempts 기준 retryable / terminal 매핑(삭제·재시도 안전). */
  private mapIoFailure(
    err: unknown,
    artifact: ArtifactLifecycleTarget,
    maxAttempts: number,
  ): ArtifactRedactionDecision {
    const reason = ioFailureReason(err);
    // 이번 시도까지 포함한 누적 시도 수가 한도 미만이면 retryable, 도달/초과면 terminal.
    const attemptsAfterThis = artifact.redactionAttempts + 1;
    if (attemptsAfterThis < maxAttempts) {
      return { kind: "retryable_failed", reason };
    }
    return { kind: "terminal_failed", reason };
  }

  /**
   * real variant 증거 조립. artifactRef(public) + backendAlias + credentialRef + correlationId +
   * 무작위 receiptId. **ObjectRef/PlainSecret 절대 미포함**, objectRefInternalOnly:true,
   * mayBeUsedAsStagingEvidence:true(real 포트). sha256 은 호출부가 redacted 결정에서 덧붙인다.
   */
  private buildEvidence(input: ArtifactRedactionRequest): ArtifactObjectIoEvidence {
    const artifactRef: ArtifactRef = input.artifact.artifactRef;
    return {
      schemaRef: ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
      portKind: "real_object_store",
      backendAlias: this.real.backendAlias,
      credentialRef: this.real.credentialRef,
      operation: "redact",
      artifactRef,
      correlationId: input.correlationId,
      receiptId: randomUUID(),
      objectRefInternalOnly: true,
      mayBeUsedAsStagingEvidence: true,
    };
  }
}

/** I/O 실패 사유 — status/네트워크만(ObjectRef/자격/바이트 미포함). */
function ioFailureReason(err: unknown): string {
  if (err instanceof S3ObjectStoreError) {
    return err.status !== undefined
      ? `s3 redaction I/O failure (HTTP ${err.status})`
      : "s3 redaction I/O failure (network)";
  }
  return "s3 redaction I/O failure";
}
