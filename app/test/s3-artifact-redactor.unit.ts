/**
 * 단위 테스트 — S3ArtifactRedactor (mock S3HttpTransport; 라이브 네트워크 없음).
 *
 * 증명(checklist row 51 — artifact redaction object I/O, specified 범위):
 *  - transform 주입(redacted) → 새 ObjectRef + sha256 + evidence(real variant).
 *  - transform 주입(not_required) → not_required + evidence, 새 객체 기록 없음.
 *  - transform 미주입 → **fail-closed**(terminal_failed): 미마스킹 바이트를 "redacted" 로 위장 안 함.
 *  - source 부재(get null) → terminal_failed.
 *  - I/O 실패 → policy.maxAttempts 기준 retryable_failed / terminal_failed.
 *  - evidence 가 ObjectRef/PlainSecret 절대 미포함.
 *
 * 실행: tsx test/s3-artifact-redactor.unit.ts
 */
import { createHash } from "node:crypto";

import type { ArtifactRef, ObjectRef, PlainSecret, SecretRef } from "../../ts/core-types";
import type { CorrelationId, TenantId } from "../../ts/security-middleware-contract";
import type {
  ArtifactLifecycleOperationalAudit,
  ArtifactLifecycleTarget,
  ArtifactRealObjectStorePortBinding,
  ArtifactRedactionRequest,
} from "../../ts/runtime-contract";
import { S3ObjectStore, type S3HttpTransport, type S3HttpTransportResponse } from "../src/artifacts/s3-object-store";
import {
  S3ArtifactRedactor,
  type ArtifactContentTransform,
} from "../src/artifacts/s3-artifact-redactor";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" as PlainSecret;
const SOURCE_KEY = "internal-source-locator-DO-NOT-LEAK";
const SOURCE_REF = `s3://examplebucket/${SOURCE_KEY}` as ObjectRef;
const ARTIFACT_REF = "artifact-public-id-51" as ArtifactRef;
const CREDENTIAL_REF = "rpa/staging/artifact-lifecycle/object_store/s3" as SecretRef;
const CORRELATION_ID = "corr-51" as CorrelationId;
const TENANT_ID = "tenant-1" as TenantId;
const SOURCE_CONTENT = "name: 홍길동, ssn: 900101-1234567";
const REDACTED_CONTENT = "name: [REDACTED], ssn: [REDACTED]";

const REAL_BINDING: ArtifactRealObjectStorePortBinding = {
  kind: "real_object_store",
  backendAlias: "s3-staging",
  credentialRef: CREDENTIAL_REF,
  evidenceSchemaRef: "artifact/object-io-evidence@1",
};

/** GET → source 바이트, PUT → 빈 OK(기록 수락). 호출 기록. */
function ioTransport(puts: Uint8Array[]): S3HttpTransport {
  return async (_url, init) => {
    if (init.method === "GET") return bytesResponse(200, new TextEncoder().encode(SOURCE_CONTENT));
    if (init.method === "PUT") {
      if (init.body !== undefined) puts.push(init.body);
      return bytesResponse(200, new Uint8Array());
    }
    return bytesResponse(404, new Uint8Array());
  };
}

function bytesResponse(status: number, bytes: Uint8Array): S3HttpTransportResponse {
  return { ok: status >= 200 && status < 300, status, bytes: async () => bytes };
}

function makeStore(transport: S3HttpTransport): S3ObjectStore {
  return new S3ObjectStore({
    endpoint: "https://s3.us-east-1.amazonaws.com",
    region: "us-east-1",
    bucket: "examplebucket",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: SECRET_KEY,
    transport,
    clock: () => new Date("2013-05-24T00:00:00.000Z"),
  });
}

function target(redactionAttempts = 0): ArtifactLifecycleTarget {
  return {
    tenantId: TENANT_ID,
    artifactRef: ARTIFACT_REF,
    objectRef: SOURCE_REF,
    type: "llm_output",
    redactionStatus: "pending",
    redactionAttempts,
    legalHold: false,
    quarantine: false,
  };
}

function request(maxAttempts = 3, redactionAttempts = 0): ArtifactRedactionRequest {
  const audit: ArtifactLifecycleOperationalAudit & { useCase: "artifact_redaction_job" } = {
    useCase: "artifact_redaction_job",
    action: "bypassrls.use",
    failClosed: true,
    correlationId: CORRELATION_ID,
    reasonCode: "redaction",
  };
  return {
    tenantId: TENANT_ID,
    correlationId: CORRELATION_ID,
    artifact: target(redactionAttempts),
    policy: { maxAttempts },
    portBinding: REAL_BINDING,
    audit,
  };
}

/** 실제 마스킹 변환(테스트 주입). */
const maskingTransform: ArtifactContentTransform = {
  async transform() {
    return { kind: "redacted", bytes: new TextEncoder().encode(REDACTED_CONTENT) };
  },
};

const notRequiredTransform: ArtifactContentTransform = {
  async transform() {
    return { kind: "not_required", reason: "no sensitive content" };
  },
};

const throwingTransform: ArtifactContentTransform = {
  async transform() {
    throw new Error("transform boom");
  },
};

function assertNoForbidden(label: string, value: unknown): void {
  const text = JSON.stringify(value) ?? "";
  const leaks: string[] = [];
  if (text.includes(SOURCE_KEY)) leaks.push("source-key");
  if (text.includes(SOURCE_REF)) leaks.push("source-ref-value");
  if (text.includes(String(SECRET_KEY))) leaks.push("plain-secret");
  // `"objectRef":` 키는 금지하되 `objectRefInternalOnly` 플래그는 허용.
  if (/"objectRef"\s*:/.test(text)) leaks.push("objectRef-key");
  check(`${label}: evidence 에 ObjectRef/PlainSecret 미포함`, leaks.length === 0, leaks.join(","));
}

async function main(): Promise<void> {
  // (1) transform 주입 → redacted: 새 ObjectRef + sha256 + evidence.
  {
    const puts: Uint8Array[] = [];
    const redactor = new S3ArtifactRedactor(makeStore(ioTransport(puts)), REAL_BINDING, maskingTransform);
    const r = await redactor.redact(request());
    check("redacted 결정", r.kind === "redacted", r.kind);
    if (r.kind === "redacted") {
      check("새 redactedObjectRef(원본과 다름)", r.redactedObjectRef !== SOURCE_REF && String(r.redactedObjectRef).startsWith("s3://examplebucket/"), String(r.redactedObjectRef));
      const expectedSha = createHash("sha256").update(REDACTED_CONTENT).digest("hex");
      check("sha256 = 마스킹 바이트 해시", r.sha256 === expectedSha, r.sha256);
      check("PUT 된 바이트 = 마스킹 결과(미마스킹 원본 아님)", puts.length === 1 && new TextDecoder().decode(puts[0]) === REDACTED_CONTENT);
      check("PUT 바이트 ≠ source 원본", puts.length === 1 && new TextDecoder().decode(puts[0]) !== SOURCE_CONTENT);
      check("evidence.operation = redact", r.evidence.operation === "redact");
      check("evidence.sha256 동반", r.evidence.sha256 === expectedSha);
      assertNoForbidden("redacted", r.evidence);
    }
  }

  // (2) transform not_required → not_required + evidence, 새 PUT 없음.
  {
    const puts: Uint8Array[] = [];
    const redactor = new S3ArtifactRedactor(makeStore(ioTransport(puts)), REAL_BINDING, notRequiredTransform);
    const r = await redactor.redact(request());
    check("not_required 결정", r.kind === "not_required", r.kind);
    check("not_required → PUT 없음", puts.length === 0, `puts=${puts.length}`);
    if (r.kind === "not_required") assertNoForbidden("not_required", r.evidence);
  }

  // (3) transform 미주입 → fail-closed(terminal_failed): 미마스킹 바이트를 redacted 로 위장 안 함.
  {
    const puts: Uint8Array[] = [];
    const redactor = new S3ArtifactRedactor(makeStore(ioTransport(puts)), REAL_BINDING, undefined);
    const r = await redactor.redact(request());
    check("transform 미주입 → terminal_failed(fail-closed)", r.kind === "terminal_failed", r.kind);
    check("transform 미주입 → 'redacted' 결정 아님", r.kind !== "redacted");
    check("transform 미주입 → object 기록 없음(누설 차단)", puts.length === 0, `puts=${puts.length}`);
  }

  // (4) transform throw → terminal_failed(잘못된 변환을 redacted 로 위장 안 함).
  {
    const puts: Uint8Array[] = [];
    const redactor = new S3ArtifactRedactor(makeStore(ioTransport(puts)), REAL_BINDING, throwingTransform);
    const r = await redactor.redact(request());
    check("transform throw → terminal_failed", r.kind === "terminal_failed", r.kind);
    check("transform throw → PUT 없음", puts.length === 0);
    if (r.kind === "terminal_failed" && r.evidence) assertNoForbidden("transform-throw", r.evidence);
  }

  // (5) source 부재(get 404 → null) → terminal_failed.
  {
    const transport: S3HttpTransport = async (_url, init) => (init.method === "GET" ? bytesResponse(404, new Uint8Array()) : bytesResponse(200, new Uint8Array()));
    const redactor = new S3ArtifactRedactor(makeStore(transport), REAL_BINDING, maskingTransform);
    const r = await redactor.redact(request());
    check("source 부재 → terminal_failed", r.kind === "terminal_failed", r.kind);
  }

  // (6) get 5xx + 시도 여유 → retryable_failed (attemptsAfterThis < maxAttempts).
  {
    const transport: S3HttpTransport = async () => bytesResponse(503, new Uint8Array());
    const redactor = new S3ArtifactRedactor(makeStore(transport), REAL_BINDING, maskingTransform);
    const r = await redactor.redact(request(3, 0)); // 0+1=1 < 3 → retryable
    check("get 5xx(시도 여유) → retryable_failed", r.kind === "retryable_failed", r.kind);
    if (r.kind === "retryable_failed") check("retryable reason 미누설", !r.reason.includes(SOURCE_KEY) && !r.reason.includes(String(SECRET_KEY)), r.reason);
  }

  // (7) get 5xx + 시도 소진 → terminal_failed (attemptsAfterThis >= maxAttempts).
  {
    const transport: S3HttpTransport = async () => bytesResponse(503, new Uint8Array());
    const redactor = new S3ArtifactRedactor(makeStore(transport), REAL_BINDING, maskingTransform);
    const r = await redactor.redact(request(2, 1)); // 1+1=2 >= 2 → terminal
    check("get 5xx(시도 소진) → terminal_failed", r.kind === "terminal_failed", r.kind);
  }

  console.log(`\ns3-artifact-redactor.unit: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
