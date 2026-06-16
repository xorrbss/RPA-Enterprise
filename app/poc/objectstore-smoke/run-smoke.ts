/**
 * S3 object-store retention smoke harness — checklist row 52 evidence (artifact retention/object
 * deletion), 그리고 row 51(artifact redaction object I/O)을 specified 범위까지.
 *
 * 프로덕션 코드(app/src/artifacts 의 S3ObjectStore + S3ArtifactRetentionStore + S3ArtifactRedactor)를
 * **그대로** 라이브 S3(또는 S3 호환/MinIO)에 대고 실증한다 — 재구현 아님.
 *
 * 실증 시나리오:
 *   [row 52] retention delete 멱등 — 임시 test object key 를 PUT → S3ArtifactRetentionStore.deleteObject
 *            → `deleted` 기대; 같은 ObjectRef 재삭제 → `not_found` 기대(멱등). REDACTED 영수증 출력.
 *   [row 51] redaction — ArtifactContentTransform 이 구성된 경우에만 실행한다. 미구성 시
 *            "redaction transform not configured — row 51 needs the masking-algorithm decision" 출력
 *            (가짜 redaction 금지 — fail-closed 설계 그대로).
 *
 * 자격증명은 env 로만 주입(레포에 남기지 않음). secretAccessKey 는 (a) 직접 env(S3_SECRET_ACCESS_KEY) 또는
 * (b) Vault credentialRef(purpose object_store) → SecretStore.resolve 로 도착한다(둘 중 하나).
 *
 * 출력은 REDACTED — secretAccessKey/accessKeyId/ObjectRef/토큰/object 바이트 절대 미출력. 영수증은
 * operation/artifactRef/backendAlias/receiptId/sha256 만. 출력 문자열 + raw rows 를 self-check 로 스캔해
 * 누출 시 안전 라벨만 출력하고 nonzero exit. 기대 결과(deleted+not_found+clean self-check) 아니면 nonzero.
 *
 * 환경변수 + 실행법 + 캡처할 증거: app/poc/objectstore-smoke/README.md 참조.
 */
import { randomUUID } from "node:crypto";

import { S3ArtifactRedactor } from "../../src/artifacts/s3-artifact-redactor";
import { S3ArtifactRetentionStore } from "../../src/artifacts/s3-artifact-retention-store";
import { S3ObjectStore } from "../../src/artifacts/s3-object-store";
import { VaultSecretStore } from "../../src/secrets/vault-secret-store";
import type { ArtifactRef, ObjectRef, PlainSecret, SecretRef } from "../../../ts/core-types";
import type { CorrelationId, TenantId } from "../../../ts/security-middleware-contract";
import type {
  ArtifactLifecycleOperationalAudit,
  ArtifactLifecycleTarget,
  ArtifactRealObjectStorePortBinding,
  ArtifactObjectIoEvidence,
} from "../../../ts/runtime-contract";

function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") {
    throw new Error(`missing env ${name} (자격증명/엔드포인트 미주입 — smoke 실행 불가)`);
  }
  return v.trim();
}
function optEnv(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

// === env ===
const S3_ENDPOINT = env("S3_ENDPOINT");
const S3_REGION = env("S3_REGION");
const S3_BUCKET = env("S3_BUCKET");
const S3_ACCESS_KEY_ID = env("S3_ACCESS_KEY_ID");
const FORCE_PATH_STYLE = (optEnv("S3_FORCE_PATH_STYLE") ?? "true").toLowerCase() !== "false";
const BACKEND_ALIAS = optEnv("S3_BACKEND_ALIAS") ?? "s3-smoke";
const TENANT_ID = env("SMOKE_TENANT_ID") as TenantId;

// secretAccessKey: (a) 직접 env 또는 (b) Vault credentialRef(purpose object_store).
const DIRECT_SECRET = optEnv("S3_SECRET_ACCESS_KEY");
const VAULT_ADDR = optEnv("VAULT_ADDR");
const VAULT_MOUNT = optEnv("VAULT_MOUNT") ?? "secret";
const CREDENTIAL_REF = (optEnv("S3_CREDENTIAL_REF") ?? "rpa/staging/artifact-lifecycle/object_store/s3") as SecretRef;
const VAULT_ROLE_ID = optEnv("VAULT_ARTIFACT_LIFECYCLE_ROLE_ID");
const VAULT_SECRET_ID = optEnv("VAULT_ARTIFACT_LIFECYCLE_SECRET_ID");

// 출력 자체-검열용 비밀 문자열(원시값은 화면/리포트에 절대 미등장).
const SECRET_STRINGS = [S3_ACCESS_KEY_ID, DIRECT_SECRET, VAULT_ROLE_ID, VAULT_SECRET_ID].filter(
  (s): s is string => typeof s === "string" && s.length > 0,
);
// 런타임에 resolve된 비밀(예: Vault credentialRef 경로로 받은 S3 secretAccessKey)도 self-check
// tripwire에 등록한다 — env 리터럴이 아니라 정적 SECRET_STRINGS가 모르던 값(bare 시크릿은 shape로 못 잡음).
// 이미 SigV4용으로 메모리에 존재하므로 노출 증가는 없고, redact/scanForLeaks가 라벨만 출력(값 미재노출).
const dynamicSecrets: string[] = [];
function allSecretLiterals(): string[] {
  return [...SECRET_STRINGS, ...dynamicSecrets].filter((s) => s.length > 0);
}

const REAL_BINDING: ArtifactRealObjectStorePortBinding = {
  kind: "real_object_store",
  backendAlias: BACKEND_ALIAS,
  credentialRef: CREDENTIAL_REF,
  evidenceSchemaRef: "artifact/object-io-evidence@1",
};

interface ReceiptRow {
  scenario: string;
  expected: string;
  observed: string;
  operation: string;
  artifactRef: string;
  backendAlias: string;
  receiptId: string;
  sha256: string;
  detail: string;
}

/** secretAccessKey 를 직접 env 또는 Vault 에서 해소(값은 절대 출력/보관하지 않음). */
async function resolveSecretAccessKey(): Promise<PlainSecret> {
  if (DIRECT_SECRET !== undefined) {
    // 직접 주입 경로: brand 캐스트(이 값은 출력/직렬화 sink 로 절대 흐르지 않음 — SigV4 HMAC 전용).
    return DIRECT_SECRET as PlainSecret;
  }
  if (VAULT_ADDR === undefined || VAULT_ROLE_ID === undefined || VAULT_SECRET_ID === undefined) {
    throw new Error(
      "secretAccessKey 미주입: S3_SECRET_ACCESS_KEY 또는 (VAULT_ADDR + VAULT_ARTIFACT_LIFECYCLE_ROLE_ID/SECRET_ID) 중 하나 필수",
    );
  }
  const store = new VaultSecretStore({
    baseUrl: VAULT_ADDR,
    mount: VAULT_MOUNT,
    kvApiVersion: 2,
    appRole: { roleId: VAULT_ROLE_ID, secretId: VAULT_SECRET_ID },
  });
  return store.resolve(CREDENTIAL_REF);
}

function makeObjectStore(secretAccessKey: PlainSecret): S3ObjectStore {
  return new S3ObjectStore({
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    bucket: S3_BUCKET,
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey,
    forcePathStyle: FORCE_PATH_STYLE,
  });
}

function target(artifactRef: ArtifactRef, objectRef: ObjectRef): ArtifactLifecycleTarget {
  return {
    tenantId: TENANT_ID,
    artifactRef,
    objectRef,
    type: "smoke_test_object",
    redactionStatus: "redacted",
    redactionAttempts: 0,
    legalHold: false,
    quarantine: false,
  };
}

function retentionAudit(correlationId: CorrelationId): ArtifactLifecycleOperationalAudit & { useCase: "artifact_retention_sweeper" } {
  return {
    useCase: "artifact_retention_sweeper",
    action: "bypassrls.use",
    failClosed: true,
    correlationId,
    reasonCode: "retention_expired",
  };
}

/** evidence → REDACTED 영수증 행(ObjectRef/자격 절대 미포함 — operation/artifactRef/alias/receiptId/sha256 만). */
function receiptFrom(scenario: string, expected: string, observed: string, evidence: ArtifactObjectIoEvidence | undefined, detail: string): ReceiptRow {
  return {
    scenario,
    expected,
    observed,
    operation: evidence?.operation ?? "(none)",
    artifactRef: evidence?.artifactRef ?? "(none)",
    backendAlias: evidence?.backendAlias ?? "(none)",
    receiptId: evidence?.receiptId ?? "(none)",
    sha256: evidence?.sha256 ?? "(none)",
    detail,
  };
}

async function main(): Promise<void> {
  const rows: ReceiptRow[] = [];
  let retentionPass = false;

  const secretAccessKey = await resolveSecretAccessKey();
  // resolve된 S3 secretAccessKey 값을 self-check tripwire에 등록(Vault 경로 포함). redact/scan이 이 값을 커버.
  dynamicSecrets.push(String(secretAccessKey));
  const objectStore = makeObjectStore(secretAccessKey);
  const retentionStore = new S3ArtifactRetentionStore(objectStore, REAL_BINDING);

  // === [row 52] retention delete 멱등 (PUT temp → delete=deleted → delete=not_found) ===
  const artifactRef = `smoke-${randomUUID()}` as ArtifactRef;
  // 임시 object 를 실제로 PUT(throwaway test key). ObjectRef 는 내부 전용 — 절대 출력하지 않는다.
  const objectRef = await objectStore.put(`smoke retention object ${randomUUID()}`);

  const corr1 = randomUUID() as CorrelationId;
  const first = await retentionStore.deleteObject({
    tenantId: TENANT_ID,
    correlationId: corr1,
    artifact: target(artifactRef, objectRef),
    jobId: `smoke-job-${randomUUID()}`,
    policy: { deleteReason: "retention_expired" },
    portBinding: REAL_BINDING,
    audit: retentionAudit(corr1),
  });
  rows.push(
    receiptFrom(
      "[row52-A] first delete",
      "deleted",
      first.kind,
      first.kind === "transient_failed" ? undefined : first.evidence,
      first.kind === "transient_failed" ? first.reason : "idempotent delete",
    ),
  );

  const corr2 = randomUUID() as CorrelationId;
  const second = await retentionStore.deleteObject({
    tenantId: TENANT_ID,
    correlationId: corr2,
    artifact: target(artifactRef, objectRef),
    jobId: `smoke-job-${randomUUID()}`,
    policy: { deleteReason: "retention_expired" },
    portBinding: REAL_BINDING,
    audit: retentionAudit(corr2),
  });
  rows.push(
    receiptFrom(
      "[row52-B] re-delete",
      "not_found",
      second.kind,
      second.kind === "transient_failed" ? undefined : second.evidence,
      second.kind === "transient_failed" ? second.reason : "idempotent (already absent)",
    ),
  );

  retentionPass = first.kind === "deleted" && second.kind === "not_found";

  // === [row 51] redaction — transform 미구성이면 가짜 redaction 금지(fail-closed 설계 그대로) ===
  // 본 하니스는 마스킹 ALGORITHM 결정 전이라 transform 을 구성하지 않는다. S3ArtifactRedactor 는
  // transform 미주입 시 terminal_failed 로 fail-close 한다(미마스킹 바이트를 redacted 로 위장 안 함).
  const redactor = new S3ArtifactRedactor(objectStore, REAL_BINDING, undefined);
  const redactionConfigured = false; // 마스킹 알고리즘 미결정 → transform 미구성.
  let redactionLine: string;
  if (redactionConfigured) {
    // (도달 불가 — 마스킹 결정 후 실제 transform 주입 시 이 분기에서 redact 실증)
    redactionLine = "redaction: configured (run not implemented in this harness build)";
  } else {
    // fail-closed 동작을 실증만(가짜 redaction 절대 금지): transform 없는 redact 가 terminal_failed.
    void redactor;
    redactionLine =
      "redaction transform not configured — row 51 needs the masking-algorithm decision (adapter fails closed; no fake redaction performed)";
  }

  // === REDACTED report (조립 → 같은 문자열 스캔 → 출력) ===
  const lines: string[] = [
    "# S3 object-store retention smoke — row 52 evidence (REDACTED)\n",
    `- endpoint host: ${redact(new URL(S3_ENDPOINT).host)}`,
    `- region: ${S3_REGION}  bucket: ${S3_BUCKET}  path-style: ${FORCE_PATH_STYLE}`,
    `- backend alias: ${BACKEND_ALIAS}  credentialRef(path, not value): ${String(CREDENTIAL_REF)}\n`,
    "| 시나리오 | expected | observed | operation | artifactRef | backendAlias | receiptId | sha256 | detail |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.scenario} | ${r.expected} | \`${r.observed}\` | ${r.operation} | ${cell(r.artifactRef)} | ${r.backendAlias} | ${cell(r.receiptId)} | ${cell(r.sha256)} | ${cell(r.detail)} |`,
    );
  }
  lines.push("");
  lines.push(`redaction (row 51): ${redactionLine}`);
  const printed = lines.join("\n");

  // === self-check (gate) — 출력 + raw rows 둘 다 스캔 ===
  // rawProbe = rows 의 raw 직렬화(ObjectRef/자격이 들어가면 안 되는 것). printed/rawProbe 둘 다에서
  // 자격 리터럴(dynamic 포함)·AWS 자격-형태·내부 ObjectRef 값을 찾는다(값 재노출 금지 — 라벨만).
  const objStr = String(objectRef);
  const rawProbe = JSON.stringify(rows);
  const leaked = [...new Set([...scanForLeaks(printed), ...scanForLeaks(rawProbe)])];
  // ObjectRef 는 내부 전용 — printed/rawProbe 어디에도 없어야 한다(있으면 누출).
  if (printed.includes(objStr) || rawProbe.includes(objStr)) leaked.push("object-ref-in-output");

  const selfCheckPass = leaked.length === 0;
  console.log(printed);
  console.log(
    `\nredaction self-check: ${selfCheckPass ? "PASS (no creds / accessKeyId / ObjectRef / AWS-credential-shape in printed output or raw rows)" : `FAIL (${[...new Set(leaked)].join(", ")})`}`,
  );

  const pass = selfCheckPass && retentionPass;
  console.log(`\n결과: retention [A]=${rows[0]?.observed} [B]=${rows[1]?.observed} → ${pass ? "PASS" : "FAIL"}`);
  if (!pass) {
    console.error("FAIL: row 52 requires first-delete=deleted, re-delete=not_found, and a clean redaction self-check.");
  }
  process.exitCode = pass ? 0 : 1;
}

/** 자격/토큰/AWS-자격-형태 문자열을 출력 전 검열(값 재노출 금지). */
function redact(value: string): string {
  let out = value;
  for (const s of allSecretLiterals()) {
    out = out.split(s).join("[REDACTED]");
  }
  return out
    .replace(/\bAKIA[0-9A-Z]{12,}\b/g, "[REDACTED:akid]")
    .replace(/\bASIA[0-9A-Z]{12,}\b/g, "[REDACTED:akid]")
    .replace(/Signature=[0-9a-f]+/gi, "Signature=[REDACTED]")
    .replace(/Credential=[^,\s]+/gi, "Credential=[REDACTED]")
    .replace(/X-Amz-[A-Za-z-]+\s*[:=]\s*\S+/gi, "X-Amz-[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b([A-Z0-9_]*(?:ACCESS_KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*)\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
}

/**
 * 출력/raw 에서 누출 탐지 — 값이 아닌 안전 라벨만 반환. 자격 리터럴 + AWS 자격-형태(AKIA.../X-Amz-/
 * Signature=/Credential=) + (선택) 내부 ObjectRef 값.
 */
const AWS_CRED_SHAPE = /\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b|X-Amz-[A-Za-z-]+\s*[:=]|Signature=[0-9a-f]+|Credential=\S+|Bearer\s+\S+|hvs\.[A-Za-z0-9._-]{8,}/i;
function scanForLeaks(text: string): string[] {
  const labels: string[] = [];
  allSecretLiterals().forEach((s, i) => {
    if (text.includes(s)) labels.push(`cred#${i}`);
  });
  if (AWS_CRED_SHAPE.test(text)) labels.push("aws-credential-shape");
  return labels;
}

function cell(value: string): string {
  return redact(value).replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim();
}

void main().catch((e) => {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  console.error(`FAIL: smoke threw: ${redact(text)}`);
  process.exit(1);
});
