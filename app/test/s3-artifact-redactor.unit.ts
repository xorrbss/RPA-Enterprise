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
  S3ArtifactRedactorError,
  type ArtifactContentTransform,
} from "../src/artifacts/s3-artifact-redactor";
import { ContentRedactionTransform } from "../src/artifacts/content-redaction-transform";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (a === undefined || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
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
const REDACTED_BINARY = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x80]);

const REAL_BINDING: ArtifactRealObjectStorePortBinding = {
  kind: "real_object_store",
  backendAlias: "s3-staging",
  credentialRef: CREDENTIAL_REF,
  evidenceSchemaRef: "artifact/object-io-evidence@1",
  mayBeUsedAsStagingEvidence: true,
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

/** GET → 임의 RAW 바이트(바이너리 그대로 — TextDecoder 손상 없이), PUT → 빈 OK. 호출 기록. */
function rawBinaryTransport(payload: Uint8Array, puts: Uint8Array[]): S3HttpTransport {
  return async (_url, init) => {
    if (init.method === "GET") return bytesResponse(200, payload);
    if (init.method === "PUT") {
      if (init.body !== undefined) puts.push(init.body);
      return bytesResponse(200, new Uint8Array());
    }
    return bytesResponse(404, new Uint8Array());
  };
}

function makeStore(transport: S3HttpTransport): S3ObjectStore {
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

const binaryMaskingTransform: ArtifactContentTransform = {
  async transform() {
    return { kind: "redacted", bytes: REDACTED_BINARY };
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
  {
    try {
      new S3ArtifactRedactor(
        makeStore(ioTransport([])),
        { ...REAL_BINDING, mayBeUsedAsStagingEvidence: false },
        maskingTransform,
      );
      check("S3 redactor rejects non-staging-qualified binding", false, "expected constructor failure");
    } catch (err) {
      check("S3 redactor rejects non-staging-qualified binding", err instanceof S3ArtifactRedactorError, String(err));
    }
  }

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

  // (1b) transform redacted binary output: PUT and sha256 must use exact bytes, not UTF-8 text round-trip.
  {
    const puts: Uint8Array[] = [];
    const redactor = new S3ArtifactRedactor(makeStore(ioTransport(puts)), REAL_BINDING, binaryMaskingTransform);
    const r = await redactor.redact(request());
    check("binary redacted 결정", r.kind === "redacted", r.kind);
    if (r.kind === "redacted") {
      const expectedSha = createHash("sha256").update(REDACTED_BINARY).digest("hex");
      check("binary PUT preserves exact transformed bytes", puts.length === 1 && sameBytes(puts[0], REDACTED_BINARY));
      check("binary sha256 = exact transformed bytes", r.sha256 === expectedSha, r.sha256);
      check("binary evidence.sha256 동반", r.evidence.sha256 === expectedSha);
      assertNoForbidden("binary-redacted", r.evidence);
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

  // (8) VULN1 — 진짜 PNG 바이너리가 RAW byte 경로(getBytes)로 transform 까지 흘러 fail-closed(terminal).
  //     이전엔 get()의 TextDecoder(U+FFFD 치환)→re-encode round-trip 으로 binary 가 valid-UTF8 텍스트로
  //     둔갑해 fatal-decode 가드를 우회 → not_required/redacted 로 "safe" 위장됐다. 이제 raw 바이트가
  //     ContentRedactionTransform 의 fatal 디코드(또는 콘텐츠 기반 가드)에서 throw → redactor terminal_failed.
  {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG magic
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x00, 0x00, // binary bytes (invalid UTF-8)
    ]);
    const puts: Uint8Array[] = [];
    const redactor = new S3ArtifactRedactor(
      makeStore(rawBinaryTransport(png, puts)),
      REAL_BINDING,
      new ContentRedactionTransform(),
    );
    const r = await redactor.redact(request());
    check("VULN1: PNG binary THROUGH getBytes→redact → terminal_failed", r.kind === "terminal_failed", r.kind);
    check("VULN1: PNG → NOT redacted/not_required (no 'safe' 위장)", r.kind !== "redacted" && r.kind !== "not_required", r.kind);
    check("VULN1: PNG → object 기록 없음(누설 차단)", puts.length === 0, `puts=${puts.length}`);
  }

  // (9) VULN1 — NUL 포함 버퍼(유효 UTF-8 이지만 콘텐츠 기반 binary 신호)도 raw 경로로 terminal_failed.
  {
    // 유효 UTF-8 텍스트 사이에 실제 NUL(0x00) 바이트를 박는다 — fatal decode 는 통과하나 콘텐츠 가드가 잡음.
    const textBytes = new TextEncoder().encode("plausible text more text");
    const withNul = new Uint8Array(textBytes.length + 1);
    withNul.set(textBytes.subarray(0, 8), 0);
    withNul[8] = 0x00; // NUL
    withNul.set(textBytes.subarray(8), 9);
    const puts: Uint8Array[] = [];
    const redactor = new S3ArtifactRedactor(
      makeStore(rawBinaryTransport(withNul, puts)),
      REAL_BINDING,
      new ContentRedactionTransform(),
    );
    const r = await redactor.redact(request());
    check("VULN1: NUL-buffer THROUGH getBytes→redact → terminal_failed", r.kind === "terminal_failed", r.kind);
    check("VULN1: NUL-buffer → object 기록 없음", puts.length === 0, `puts=${puts.length}`);
  }

  console.log(`\ns3-artifact-redactor.unit: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
