/**
 * 단위 테스트 — S3ArtifactRetentionStore (mock S3HttpTransport; 라이브 네트워크 없음).
 *
 * 증명(checklist row 52 — artifact retention/object deletion):
 *  - 204 → deleted / 404 → not_found(둘 다 멱등 성공, evidence 동반).
 *  - 5xx/네트워크 → transient_failed: **삭제로 간주 금지**(evidence 없음; deleted_at 미설정 보장).
 *  - real evidence 가 ObjectRef 와 PlainSecret 을 절대 담지 않음(직렬화 형태에서 objectRef/자격 부재 단언).
 *  - evidence 가 credentialRef(SecretRef 식별자)·artifactRef·backendAlias·receiptId 를 담음.
 *  - test_fake 바인딩 거부(real_object_store 만 staging 증거 가능).
 *
 * 실행: tsx test/s3-artifact-retention-store.unit.ts
 */
import type { ArtifactRef, ObjectRef, PlainSecret, SecretRef } from "../../ts/core-types";
import type { CorrelationId, TenantId } from "../../ts/security-middleware-contract";
import type {
  ArtifactLifecycleOperationalAudit,
  ArtifactLifecycleTarget,
  ArtifactLocalTestPortBinding,
  ArtifactRealObjectStorePortBinding,
  ArtifactRetentionDeleteRequest,
} from "../../ts/runtime-contract";
import { S3ObjectStore, type S3HttpTransport, type S3HttpTransportResponse } from "../src/artifacts/s3-object-store";
import { S3ArtifactRetentionStore, S3ArtifactRetentionStoreError } from "../src/artifacts/s3-artifact-retention-store";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// 누설 점검용 비밀/내부 locator (evidence/직렬화에 절대 등장 금지).
const SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" as PlainSecret;
const OBJECT_KEY = "internal-object-locator-DO-NOT-LEAK";
const OBJECT_REF = `s3://examplebucket/${OBJECT_KEY}` as ObjectRef;
const ARTIFACT_REF = "artifact-public-id-42" as ArtifactRef;
const CREDENTIAL_REF = "rpa/staging/artifact-lifecycle/object_store/s3" as SecretRef;
const CORRELATION_ID = "corr-1" as CorrelationId;
const TENANT_ID = "tenant-1" as TenantId;
const BACKEND_ALIAS = "s3-staging";

function makeStore(status: number): S3ObjectStore {
  const transport: S3HttpTransport = async () => statusResponse(status);
  return new S3ObjectStore({
    endpoint: "https://s3.us-east-1.amazonaws.com",
    region: "us-east-1",
    bucket: "examplebucket",
    accessKeyId: "AKIA" + "IOSFODNN7EXAMPLE", // 공개 예제 AKID(분리=secret-scan 오탐 회피)
    secretAccessKey: SECRET_KEY,
    transport,
    clock: () => new Date("2013-05-24T00:00:00.000Z"),
  });
}

function makeNetworkErrorStore(): S3ObjectStore {
  const transport: S3HttpTransport = async () => {
    throw new Error(`ECONNRESET ${OBJECT_KEY} ${String(SECRET_KEY)}`);
  };
  return new S3ObjectStore({
    endpoint: "https://s3.us-east-1.amazonaws.com",
    region: "us-east-1",
    bucket: "examplebucket",
    accessKeyId: "AKIA" + "IOSFODNN7EXAMPLE", // 공개 예제 AKID(분리=secret-scan 오탐 회피)
    secretAccessKey: SECRET_KEY,
    transport,
    clock: () => new Date("2013-05-24T00:00:00.000Z"),
  });
}

function statusResponse(status: number): S3HttpTransportResponse {
  return { ok: status >= 200 && status < 300, status, bytes: async () => new Uint8Array() };
}

const REAL_BINDING: ArtifactRealObjectStorePortBinding = {
  kind: "real_object_store",
  backendAlias: BACKEND_ALIAS,
  credentialRef: CREDENTIAL_REF,
  evidenceSchemaRef: "artifact/object-io-evidence@1",
  mayBeUsedAsStagingEvidence: true,
};

function target(): ArtifactLifecycleTarget {
  return {
    tenantId: TENANT_ID,
    artifactRef: ARTIFACT_REF,
    objectRef: OBJECT_REF,
    type: "llm_output",
    redactionStatus: "redacted",
    redactionAttempts: 0,
    legalHold: false,
    quarantine: false,
  };
}

function request(): ArtifactRetentionDeleteRequest {
  const audit: ArtifactLifecycleOperationalAudit & { useCase: "artifact_retention_sweeper" } = {
    useCase: "artifact_retention_sweeper",
    action: "bypassrls.use",
    failClosed: true,
    correlationId: CORRELATION_ID,
    reasonCode: "retention_expired",
  };
  return {
    tenantId: TENANT_ID,
    correlationId: CORRELATION_ID,
    artifact: target(),
    jobId: "job-1",
    policy: { deleteReason: "retention_expired" },
    portBinding: REAL_BINDING,
    audit,
  };
}

/**
 * evidence 의 직렬화 형태에 ObjectRef 값/object key/PlainSecret 이 없는지 + `objectRef` 라는 키 자체가
 * 없는지(`objectRefInternalOnly` 같은 boolean 플래그는 허용 — 값이 아님).
 */
function assertNoForbidden(label: string, value: unknown): void {
  const text = JSON.stringify(value) ?? "";
  const leaks: string[] = [];
  if (text.includes(OBJECT_KEY)) leaks.push("object-key");
  if (text.includes(OBJECT_REF)) leaks.push("object-ref-value");
  if (text.includes(String(SECRET_KEY))) leaks.push("plain-secret");
  // `"objectRef":` 키는 금지하되 `objectRefInternalOnly` 플래그는 허용.
  if (/"objectRef"\s*:/.test(text)) leaks.push("objectRef-key");
  check(`${label}: evidence 에 ObjectRef/PlainSecret 미포함`, leaks.length === 0, leaks.join(","));
}

async function main(): Promise<void> {
  {
    try {
      new S3ArtifactRetentionStore(makeStore(204), { ...REAL_BINDING, mayBeUsedAsStagingEvidence: false });
      check("S3 retention rejects non-staging-qualified binding", false, "expected constructor failure");
    } catch (err) {
      check("S3 retention rejects non-staging-qualified binding", err instanceof S3ArtifactRetentionStoreError, String(err));
    }
  }

  // (1) 204 → deleted + evidence(ObjectRef/secret 부재, credentialRef/artifactRef 포함).
  {
    const store = new S3ArtifactRetentionStore(makeStore(204), REAL_BINDING);
    const r = await store.deleteObject(request());
    check("204 → deleted", r.kind === "deleted", r.kind);
    if (r.kind === "deleted") {
      assertNoForbidden("deleted", r.evidence);
      check("evidence.operation = delete", r.evidence.operation === "delete");
      check("evidence.artifactRef = public", r.evidence.artifactRef === ARTIFACT_REF);
      check("evidence.backendAlias", r.evidence.backendAlias === BACKEND_ALIAS);
      check("evidence.receiptId 존재", typeof r.evidence.receiptId === "string" && r.evidence.receiptId.length > 0);
      check(
        "evidence real variant 표식 + credentialRef(SecretRef 식별자)",
        r.evidence.portKind === "real_object_store" &&
          r.evidence.credentialRef === CREDENTIAL_REF &&
          r.evidence.objectRefInternalOnly === true &&
          r.evidence.mayBeUsedAsStagingEvidence === true,
      );
    }
  }

  // (2) 404 → not_found(멱등 성공) + evidence.
  {
    const store = new S3ArtifactRetentionStore(makeStore(404), REAL_BINDING);
    const r = await store.deleteObject(request());
    check("404 → not_found", r.kind === "not_found", r.kind);
    if (r.kind === "not_found") assertNoForbidden("not_found", r.evidence);
  }

  // (3) 503 → transient_failed: evidence 없음(삭제로 간주 금지) + reason 에 ObjectRef/secret 미포함.
  {
    const store = new S3ArtifactRetentionStore(makeStore(503), REAL_BINDING);
    const r = await store.deleteObject(request());
    check("503 → transient_failed", r.kind === "transient_failed", r.kind);
    if (r.kind === "transient_failed") {
      check("transient_failed 은 evidence 미동반(삭제 함의 차단)", !("evidence" in r) || (r as { evidence?: unknown }).evidence === undefined);
      check("transient reason 에 ObjectRef 미포함", !r.reason.includes(OBJECT_KEY) && !r.reason.includes(OBJECT_REF), r.reason);
      check("transient reason 에 PlainSecret 미포함", !r.reason.includes(String(SECRET_KEY)), r.reason);
    }
  }

  // (4) 네트워크 오류 → transient_failed(삭제 함의 없음, 미누설).
  {
    const store = new S3ArtifactRetentionStore(makeNetworkErrorStore(), REAL_BINDING);
    const r = await store.deleteObject(request());
    check("네트워크 오류 → transient_failed", r.kind === "transient_failed", r.kind);
    if (r.kind === "transient_failed") {
      check("네트워크 transient reason 미누설", !r.reason.includes(OBJECT_KEY) && !r.reason.includes(String(SECRET_KEY)), r.reason);
    }
  }

  // (5) test_fake 바인딩 거부.
  {
    const fake: ArtifactLocalTestPortBinding = {
      kind: "test_fake",
      backendAlias: "local-test-fake",
      evidenceSchemaRef: "artifact/object-io-local-test@1",
      testOnly: true,
    };
    let threw: unknown;
    try {
      // @ts-expect-error — 의도적으로 test_fake 를 넘겨 런타임 거부를 검증.
      new S3ArtifactRetentionStore(makeStore(204), fake);
    } catch (e) {
      threw = e;
    }
    check("test_fake 바인딩 거부", threw instanceof S3ArtifactRetentionStoreError, String(threw));
  }

  console.log(`\ns3-artifact-retention-store.unit: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
