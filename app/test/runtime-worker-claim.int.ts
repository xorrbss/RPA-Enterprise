/**
 * D3 runtime-worker claim gate integration.
 *
 * This proves the first repo-owned runtime execution slice: `run_claim` may
 * claim a queued run only when a stable worker identity and explicit browser
 * lease plan are configured. It stops before real step execution/artifact work.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ObjectRef } from "../../ts/core-types";
import type { CorrelationId, RunId, TenantId } from "../../ts/security-middleware-contract";
import {
  ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
  ARTIFACT_OBJECT_IO_LOCAL_TEST_SCHEMA_REF,
} from "../../ts/runtime-contract";
import type {
  ArtifactObjectIoEvidence,
  ArtifactObjectIoOperation,
  ArtifactObjectIoPortBinding,
  ArtifactRedactor,
  ArtifactRetentionStore,
  RuntimeWorkerJob,
  WorkitemId,
} from "../../ts/runtime-contract";

import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { createPool, withTenantTx } from "../src/db/pool";
import { bootstrapTracing } from "../src/observability/bootstrap";
import {
  PgRuntimeWorker,
  type BrowserLeasePlanResolver,
} from "../src/worker/runtime-worker";
import { drainBrowserLease, renewBrowserLease } from "../src/worker/runtime-worker-browser-lease";

// §E run.claim/browser.lease.acquire span 발행 검증용 in-memory exporter(외부 의존 없음).
const spanExporter = new InMemorySpanExporter();
bootstrapTracing(spanExporter);

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_runtime_claim_int";

const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const WORKER = "10000000-0000-0000-0000-000000000010";
const OTHER_WORKER = "10000000-0000-0000-0000-000000000011";
const GATEWAY_WORKER = "10000000-0000-0000-0000-000000000012";
const OPEN_CIRCUIT_WORKER = "10000000-0000-0000-0000-000000000013";
const LIFECYCLE_BYPASS_ROLE = "rpa_lifecycle_bypass";
// 테스트 전용 BYPASSRLS 역할 비밀번호(역할명과 동일, rpa_smoke 패턴). CI 비밀번호 인증용; 로컬 trust는 무시.
const LIFECYCLE_BYPASS_PASSWORD = "rpa_lifecycle_bypass";
const CORRELATION = "20000000-0000-0000-0000-000000000001";

const SCENARIO = "30000000-0000-0000-0000-000000000001";
const SCENARIO_VERSION = "30000000-0000-0000-0000-000000000002";
const RUN_OK = "30000000-0000-0000-0000-000000000003";
const RUN_CROSS = "30000000-0000-0000-0000-000000000004";
const RUN_CONFLICT = "30000000-0000-0000-0000-000000000005";
const RUN_RED = "30000000-0000-0000-0000-000000000006";
const RUN_HOLDER = "30000000-0000-0000-0000-000000000007";
const RUN_SWEEP = "30000000-0000-0000-0000-000000000008";
const RUN_GATEWAY_WORKER = "30000000-0000-0000-0000-000000000009";
const RUN_OPEN_CIRCUIT_WORKER = "30000000-0000-0000-0000-00000000000a";
const WORKITEM_OK = "30000000-0000-0000-0000-000000000101";
const WORKITEM_CROSS = "30000000-0000-0000-0000-000000000102";
const WORKITEM_PROCESSING = "30000000-0000-0000-0000-000000000103";
const WORKITEM_RETRY = "30000000-0000-0000-0000-000000000104";
const WORKITEM_TERMINAL = "30000000-0000-0000-0000-000000000105";

const SITE_OK = "40000000-0000-0000-0000-000000000001";
const IDENTITY_OK = "40000000-0000-0000-0000-000000000002";
const SITE_CONFLICT = "40000000-0000-0000-0000-000000000003";
const IDENTITY_CONFLICT = "40000000-0000-0000-0000-000000000004";
const SITE_RED = "40000000-0000-0000-0000-000000000005";
const IDENTITY_RED = "40000000-0000-0000-0000-000000000006";
const SITE_SWEEP = "40000000-0000-0000-0000-000000000007";
const IDENTITY_SWEEP = "40000000-0000-0000-0000-000000000008";
const CONFLICT_LEASE = "50000000-0000-0000-0000-000000000001";
const EXPIRED_BROWSER_LEASE = "50000000-0000-0000-0000-000000000002";
const FUTURE_BROWSER_LEASE = "50000000-0000-0000-0000-000000000003";
const HEARTBEAT_BROWSER_LEASE = "50000000-0000-0000-0000-000000000004";
const DRAIN_BROWSER_LEASE = "50000000-0000-0000-0000-000000000005";
const CREDENTIAL_REF_EXPIRED = "secret://tenant-a/runtime-claim-expired";
const CREDENTIAL_REF_FUTURE = "secret://tenant-a/runtime-claim-future";
const ARTIFACT_REDACTION_PENDING = "60000000-0000-0000-0000-000000000001";
const ARTIFACT_REDACTION_QUARANTINED = "60000000-0000-0000-0000-000000000002";
const ARTIFACT_REDACTION_DELETED = "60000000-0000-0000-0000-000000000003";
const ARTIFACT_REDACTION_ALREADY = "60000000-0000-0000-0000-000000000004";
const ARTIFACT_REDACTION_ACTIVE_CLAIM = "60000000-0000-0000-0000-000000000005";
const ARTIFACT_REDACTION_RETRYABLE = "60000000-0000-0000-0000-000000000006";
const ARTIFACT_REDACTION_GENERATION_TARGET = "60000000-0000-0000-0000-000000000007";
const ARTIFACT_REDACTION_GENERATION_UNRELATED = "60000000-0000-0000-0000-000000000008";
const ARTIFACT_RETENTION_DELETE = "60000000-0000-0000-0000-000000000011";
const ARTIFACT_RETENTION_NOT_FOUND = "60000000-0000-0000-0000-000000000012";
const ARTIFACT_RETENTION_TRANSIENT = "60000000-0000-0000-0000-000000000013";
const ARTIFACT_RETENTION_LEGAL_HOLD = "60000000-0000-0000-0000-000000000014";
const ARTIFACT_RETENTION_QUARANTINE = "60000000-0000-0000-0000-000000000015";
const ARTIFACT_RETENTION_UNEXPIRED = "60000000-0000-0000-0000-000000000016";
const ARTIFACT_RETENTION_ALREADY_DELETED = "60000000-0000-0000-0000-000000000017";
const GENERATION_SCOPE_A = "30000000-0000-0000-0000-000000000201";
const GENERATION_SCOPE_B = "30000000-0000-0000-0000-000000000202";
const ARTIFACT_GENERATION_REDACTION_MATCH = "60000000-0000-0000-0000-000000000021";
const ARTIFACT_GENERATION_REDACTION_OTHER = "60000000-0000-0000-0000-000000000022";
const ARTIFACT_GENERATION_RETENTION_MATCH = "60000000-0000-0000-0000-000000000023";
const ARTIFACT_GENERATION_RETENTION_OTHER = "60000000-0000-0000-0000-000000000024";
const ARTIFACT_RETENTION_TOCTOU = "60000000-0000-0000-0000-000000000025";
const GENERATION_TOCTOU = "30000000-0000-0000-0000-000000000203";
// AUD-10 integrity_checker: 전용 테넌트로 격리(integrity 스캔은 tenant-wide). run/generation 없이도 artifacts 유효.
const TENANT_INTEGRITY = "00000000-0000-0000-0000-0000000000c3";
const ARTIFACT_INTEGRITY_OK = "60000000-0000-0000-0000-000000000031";
const ARTIFACT_INTEGRITY_TAMPERED = "60000000-0000-0000-0000-000000000032";
const ARTIFACT_INTEGRITY_MISSING = "60000000-0000-0000-0000-000000000033";
const ARTIFACT_INTEGRITY_PENDING = "60000000-0000-0000-0000-000000000034";
const ARTIFACT_INTEGRITY_QUARANTINED = "60000000-0000-0000-0000-000000000035";
const INTEGRITY_OK_BYTES = new TextEncoder().encode("integrity-ok-bytes");
const INTEGRITY_TAMPERED_ACTUAL = new TextEncoder().encode("integrity-tampered-actual-bytes");
const INTEGRITY_PENDING_ACTUAL = new TextEncoder().encode("integrity-pending-actual-bytes");
const sha256hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const ACTIVE_REDACTION_CLAIM = "70000000-0000-0000-0000-000000000001";
const GENERATION_TARGET = "80000000-0000-0000-0000-000000000001";
const GENERATION_UNRELATED = "80000000-0000-0000-0000-000000000002";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

const planResolver: BrowserLeasePlanResolver = async (_client, input) => {
  if (input.runId === RUN_OK) {
    return { siteProfileId: SITE_OK, browserIdentityId: IDENTITY_OK, downloadDirRef: "lease://ok" };
  }
  if (
    input.runId === RUN_CROSS ||
    input.runId === RUN_GATEWAY_WORKER ||
    input.runId === RUN_OPEN_CIRCUIT_WORKER
  ) {
    return { siteProfileId: SITE_OK, browserIdentityId: IDENTITY_OK, ttlMs: 60_000, downloadDirRef: "lease://ok" };
  }
  if (input.runId === RUN_CONFLICT) {
    return {
      siteProfileId: SITE_CONFLICT,
      browserIdentityId: IDENTITY_CONFLICT,
      ttlMs: 60_000,
      downloadDirRef: "lease://conflict",
    };
  }
  if (input.runId === RUN_RED) {
    return { siteProfileId: SITE_RED, browserIdentityId: IDENTITY_RED, ttlMs: 60_000, downloadDirRef: "lease://red" };
  }
  return null;
};

const redactionCalls: Array<Parameters<ArtifactRedactor["redact"]>[0]> = [];
const retentionCalls: Array<Parameters<ArtifactRetentionStore["deleteObject"]>[0]> = [];
// AUD-11 legal_hold TOCTOU 테스트 훅: deleteObject 진행 중(=fix 가 행 락 보유 중) 동시 legal_hold 쓰기를 주입한다.
// run() 안에서 bypass pool 이 만들어진 뒤 배선된다(모듈 const fake 가 함수-로컬 pool 을 참조하기 위함).
let toctouConcurrentHold: ((artifactId: string) => Promise<void>) | undefined;

const localTestPortBinding = {
  kind: "test_fake",
  backendAlias: "local-test-fake",
  evidenceSchemaRef: ARTIFACT_OBJECT_IO_LOCAL_TEST_SCHEMA_REF,
  testOnly: true,
} as const satisfies ArtifactObjectIoPortBinding;

function localTestEvidence(input: {
  artifact: { artifactRef: Parameters<ArtifactRedactor["redact"]>[0]["artifact"]["artifactRef"] };
  correlationId: CorrelationId;
  portBinding: ArtifactObjectIoPortBinding;
}, operation: ArtifactObjectIoOperation, receiptId: string, sha256?: string): ArtifactObjectIoEvidence {
  if (input.portBinding.kind !== "test_fake") {
    throw new Error("test fixture expected a test_fake port binding");
  }
  return {
    schemaRef: ARTIFACT_OBJECT_IO_LOCAL_TEST_SCHEMA_REF,
    portKind: "test_fake",
    backendAlias: "local-test-fake",
    operation,
    artifactRef: input.artifact.artifactRef,
    correlationId: input.correlationId,
    receiptId,
    objectRefInternalOnly: true,
    mayBeUsedAsStagingEvidence: false,
    ...(sha256 === undefined ? {} : { sha256 }),
  };
}

const fakeArtifactRedactor: ArtifactRedactor = {
  binding: localTestPortBinding,
  redact: async (input) => {
    redactionCalls.push(input);
    if (
      input.artifact.artifactRef === ARTIFACT_REDACTION_PENDING ||
      input.artifact.artifactRef === ARTIFACT_GENERATION_REDACTION_MATCH
    ) {
      const sha256 = input.artifact.artifactRef === ARTIFACT_REDACTION_PENDING
        ? "sha256:redacted-safe"
        : "sha256:generation-redacted-safe";
      return {
        kind: "redacted",
        redactedObjectRef: (input.artifact.artifactRef === ARTIFACT_REDACTION_PENDING
          ? "object://runtime-worker/redacted-safe"
          : "object://runtime-worker/generation-redacted-safe") as ObjectRef,
        sha256,
        evidence: localTestEvidence(input, "redact", "local-redaction-receipt", sha256),
      };
    }
    if (input.artifact.artifactRef === ARTIFACT_REDACTION_GENERATION_TARGET) {
      const sha256 = "sha256:generation-redacted-safe";
      return {
        kind: "redacted",
        redactedObjectRef: "object://runtime-worker/generation-redacted-safe" as ObjectRef,
        sha256,
        evidence: localTestEvidence(input, "redact", "local-generation-redaction-receipt", sha256),
      };
    }
    if (input.artifact.artifactRef === ARTIFACT_REDACTION_RETRYABLE) {
      return {
        kind: "retryable_failed",
        reason: "redaction backend unavailable",
        evidence: localTestEvidence(input, "redact", "local-redaction-retryable-receipt"),
      };
    }
    return { kind: "terminal_failed", reason: `unexpected redaction fixture ${input.artifact.artifactRef}` };
  },
};

const fakeArtifactRetentionStore: ArtifactRetentionStore = {
  binding: localTestPortBinding,
  deleteObject: async (input) => {
    retentionCalls.push(input);
    if (
      input.artifact.artifactRef === ARTIFACT_RETENTION_DELETE ||
      input.artifact.artifactRef === ARTIFACT_GENERATION_RETENTION_MATCH
    ) {
      return {
        kind: "deleted",
        evidence: localTestEvidence(input, "delete", "local-retention-delete-receipt"),
      };
    }
    if (input.artifact.artifactRef === ARTIFACT_RETENTION_NOT_FOUND) {
      return {
        kind: "not_found",
        evidence: localTestEvidence(input, "delete", "local-retention-not-found-receipt"),
      };
    }
    if (input.artifact.artifactRef === ARTIFACT_RETENTION_TRANSIENT) {
      return { kind: "transient_failed", reason: "object store unavailable" };
    }
    if (input.artifact.artifactRef === ARTIFACT_RETENTION_TOCTOU) {
      // 물리 삭제 도중 운영자가 legal_hold=true 를 설정하는 상황을 주입. fix(행 락 보유) 경로에서는 이 쓰기가
      // 락에 막혀 삭제 커밋 이후로 직렬화되므로 tombstone 은 일관되게 기록된다.
      if (toctouConcurrentHold !== undefined) await toctouConcurrentHold(input.artifact.artifactRef);
      return {
        kind: "deleted",
        evidence: localTestEvidence(input, "delete", "local-retention-toctou-receipt"),
      };
    }
    return { kind: "transient_failed", reason: `unexpected retention fixture ${input.artifact.artifactRef}` };
  },
};

// AUD-10 integrity_checker fake: object_ref → raw 바이트(또는 부재/transient). 호출된 ref 를 기록해 제외(pending/quarantined) 검증.
const integrityGetBytesCalls: string[] = [];
const fakeIntegrityObjectStore = {
  getBytes: async (objectRef: ObjectRef): Promise<Uint8Array | null> => {
    const ref = String(objectRef);
    integrityGetBytesCalls.push(ref);
    if (ref === "object://runtime-worker/integrity-ok") return INTEGRITY_OK_BYTES;
    if (ref === "object://runtime-worker/integrity-tampered") return INTEGRITY_TAMPERED_ACTUAL;
    if (ref === "object://runtime-worker/integrity-pending") return INTEGRITY_PENDING_ACTUAL;
    if (ref === "object://runtime-worker/integrity-missing") return null;
    throw new Error(`unexpected integrity fixture ${ref}`);
  },
};

async function seedIntegrityArtifacts(pool: ReturnType<typeof createPool>): Promise<void> {
  await withTenantTx(pool, TENANT_INTEGRITY, async (c) => {
    await c.query(
      `INSERT INTO artifacts (
         id, tenant_id, run_id, generation_id, type, redaction_status, redaction_attempts, object_ref,
         retention_until, legal_hold, quarantine, deleted_at, deleted_reason, deleted_by_job,
         lifecycle_claim_id, lifecycle_claim_kind, lifecycle_claim_worker_id,
         lifecycle_claim_correlation_id, lifecycle_claimed_at, lifecycle_claim_expires_at
       )
       VALUES
         -- 일치(sha256 = 실제 해시) → 격리 안 됨(거짓양성 없음)
         ($1,$6,NULL,NULL,'receipt','not_required',0,'object://runtime-worker/integrity-ok',
          now() + interval '90 days',false,false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
         -- 변조(저장 sha256 ≠ 실제 바이트 해시) → 격리
         ($2,$6,NULL,NULL,'receipt','not_required',0,'object://runtime-worker/integrity-tampered',
          now() + interval '90 days',false,false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
         -- object 부재(비-삭제 행) → 격리
         ($3,$6,NULL,NULL,'receipt','not_required',0,'object://runtime-worker/integrity-missing',
          now() + interval '90 days',false,false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
         -- pending(redaction 미완) → 스캔 제외(서빙 안정 상태 아님). getBytes 호출되면 안 됨
         ($4,$6,NULL,NULL,'screenshot','pending',0,'object://runtime-worker/integrity-pending',
          now() + interval '90 days',false,false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
         -- 이미 격리됨 → 스캔 제외(재처리 안 함). getBytes 호출되면 안 됨
         ($5,$6,NULL,NULL,'receipt','not_required',0,'object://runtime-worker/integrity-already-q',
          now() + interval '90 days',false,true,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`,
      [
        ARTIFACT_INTEGRITY_OK,
        ARTIFACT_INTEGRITY_TAMPERED,
        ARTIFACT_INTEGRITY_MISSING,
        ARTIFACT_INTEGRITY_PENDING,
        ARTIFACT_INTEGRITY_QUARANTINED,
        TENANT_INTEGRITY,
      ],
    );
    // 기준 sha256 주입: OK 는 실제 해시(일치), tampered/missing/pending 은 의도적으로 실제와 다르게.
    await c.query(`UPDATE artifacts SET sha256 = $2 WHERE id = $1::uuid`, [ARTIFACT_INTEGRITY_OK, sha256hex(INTEGRITY_OK_BYTES)]);
    await c.query(`UPDATE artifacts SET sha256 = $2 WHERE id = $1::uuid`, [ARTIFACT_INTEGRITY_TAMPERED, sha256hex(new TextEncoder().encode("integrity-original"))]);
    await c.query(`UPDATE artifacts SET sha256 = $2 WHERE id = $1::uuid`, [ARTIFACT_INTEGRITY_MISSING, sha256hex(new TextEncoder().encode("integrity-missing-baseline"))]);
    await c.query(`UPDATE artifacts SET sha256 = $2 WHERE id = $1::uuid`, [ARTIFACT_INTEGRITY_PENDING, sha256hex(new TextEncoder().encode("integrity-pending-baseline"))]);
  });
}

async function seedTenant(pool: ReturnType<typeof createPool>, tenantId: string): Promise<void> {
  await withTenantTx(pool, tenantId, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,$3)`, [
      SCENARIO,
      tenantId,
      `runtime-claim-${tenantId}`,
    ]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'draft','{"nodes":[]}'::jsonb)`,
      [SCENARIO_VERSION, tenantId, SCENARIO],
    );
  });
}

async function seedRun(pool: ReturnType<typeof createPool>, runId: string, status = "queued"): Promise<void> {
  await withTenantTx(pool, TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [runId, TENANT_A, SCENARIO_VERSION, status, CORRELATION],
    );
  });
}

async function seedLifecycleArtifacts(pool: ReturnType<typeof createPool>): Promise<void> {
  await withTenantTx(pool, TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO scenario_generations
         (id, tenant_id, mode, status, prompt_hash, draft_ir, created_by)
       VALUES
         ($1::uuid, $3::uuid, 'draft_only', 'drafted', 'hash-generation-target', '{"nodes":[]}'::jsonb, 'runtime-worker-test'),
         ($2::uuid, $3::uuid, 'draft_only', 'drafted', 'hash-generation-unrelated', '{"nodes":[]}'::jsonb, 'runtime-worker-test')`,
      [GENERATION_TARGET, GENERATION_UNRELATED, TENANT_A],
    );
    await c.query(
      `INSERT INTO artifacts (
         id, tenant_id, run_id, generation_id, type, redaction_status, redaction_attempts, object_ref,
         retention_until, legal_hold, quarantine, deleted_at, deleted_reason, deleted_by_job,
         lifecycle_claim_id, lifecycle_claim_kind, lifecycle_claim_worker_id,
         lifecycle_claim_correlation_id, lifecycle_claimed_at, lifecycle_claim_expires_at
        )
        VALUES
          ($1,$2,$3,NULL,'screenshot','pending',0,'object://runtime-worker/redaction-pending',
           now() + interval '90 days',false,false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
          ($4,$2,$3,NULL,'screenshot','pending',0,'object://runtime-worker/redaction-quarantine',
           now() + interval '90 days',false,true,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
          ($5,$2,$3,NULL,'screenshot','pending',0,'object://runtime-worker/redaction-deleted',
           now() + interval '90 days',false,false,now(),'test_deleted',NULL,NULL,NULL,NULL,NULL,NULL,NULL),
          ($6,$2,$3,NULL,'screenshot','redacted',1,'object://runtime-worker/redaction-already',
           now() + interval '90 days',false,false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
          ($7,$2,$8,NULL,'screenshot','pending',0,'object://runtime-worker/redaction-active-claim',
           now() + interval '90 days',false,false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
          ($16,$2,$3,NULL,'screenshot','pending',3,'object://runtime-worker/redaction-retryable',
           now() + interval '90 days',false,false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
          ($17,$2,NULL,$18,'scenario_generation_llm_output','pending',0,'object://runtime-worker/generation-target',
           now() + interval '90 days',false,false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
          ($19,$2,NULL,$20,'scenario_generation_llm_output','pending',0,'object://runtime-worker/generation-unrelated',
           now() + interval '90 days',false,false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
          ($9,$2,$3,NULL,'receipt','not_required',0,'object://runtime-worker/retention-delete',
           now() - interval '3 days',false,false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
          ($10,$2,$3,NULL,'receipt','not_required',0,'object://runtime-worker/retention-not-found',
           now() - interval '2 days',false,false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
          ($11,$2,$3,NULL,'receipt','not_required',0,'object://runtime-worker/retention-transient',
           now() - interval '1 day',false,false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
          ($12,$2,$3,NULL,'receipt','not_required',0,'object://runtime-worker/retention-legal-hold',
           now() - interval '1 day',true,false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
          ($13,$2,$3,NULL,'receipt','not_required',0,'object://runtime-worker/retention-quarantine',
           now() - interval '1 day',false,true,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
          ($14,$2,$3,NULL,'receipt','not_required',0,'object://runtime-worker/retention-unexpired',
           now() + interval '90 days',false,false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
          ($15,$2,$3,NULL,'receipt','not_required',0,'object://runtime-worker/retention-already-deleted',
           now() - interval '1 day',false,false,now(),'retention_expired','previous-job',NULL,NULL,NULL,NULL,NULL,NULL)`,
      [
        ARTIFACT_REDACTION_PENDING,
        TENANT_A,
        RUN_HOLDER,
        ARTIFACT_REDACTION_QUARANTINED,
        ARTIFACT_REDACTION_DELETED,
        ARTIFACT_REDACTION_ALREADY,
        ARTIFACT_REDACTION_ACTIVE_CLAIM,
        RUN_SWEEP,
        ARTIFACT_RETENTION_DELETE,
        ARTIFACT_RETENTION_NOT_FOUND,
        ARTIFACT_RETENTION_TRANSIENT,
        ARTIFACT_RETENTION_LEGAL_HOLD,
        ARTIFACT_RETENTION_QUARANTINE,
        ARTIFACT_RETENTION_UNEXPIRED,
        ARTIFACT_RETENTION_ALREADY_DELETED,
        ARTIFACT_REDACTION_RETRYABLE,
        ARTIFACT_REDACTION_GENERATION_TARGET,
        GENERATION_TARGET,
        ARTIFACT_REDACTION_GENERATION_UNRELATED,
        GENERATION_UNRELATED,
      ],
    );
  });
}

async function seedGenerationLifecycleArtifacts(pool: ReturnType<typeof createPool>): Promise<void> {
  await withTenantTx(pool, TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO scenario_generations
         (id, tenant_id, mode, status, prompt_hash, planner, draft_ir, validation_report,
          evidence_policy, blockers, created_by)
       VALUES
         ($1::uuid,$3::uuid,'save','saved','hash-generation-scope-a','llm_v1','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb,'claim-test'),
         ($2::uuid,$3::uuid,'save','saved','hash-generation-scope-b','llm_v1','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb,'claim-test')`,
      [GENERATION_SCOPE_A, GENERATION_SCOPE_B, TENANT_A],
    );
    await c.query(
      `INSERT INTO artifacts (
         id, tenant_id, generation_id, type, redaction_status, redaction_attempts, object_ref,
         retention_until, legal_hold, quarantine, deleted_at, deleted_reason, deleted_by_job,
         lifecycle_claim_id, lifecycle_claim_kind, lifecycle_claim_worker_id,
         lifecycle_claim_correlation_id, lifecycle_claimed_at, lifecycle_claim_expires_at
       )
       VALUES
         ($1,$5,$6,'scenario_generation_llm_output','pending',0,'object://runtime-worker/generation-redaction-match',
          now() + interval '90 days',false,false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
         ($2,$5,$7,'scenario_generation_llm_output','pending',0,'object://runtime-worker/generation-redaction-other',
          now() + interval '90 days',false,false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
         ($3,$5,$6,'scenario_generation_llm_output','not_required',0,'object://runtime-worker/generation-retention-match',
          now() - interval '1 day',false,false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
         ($4,$5,$7,'scenario_generation_llm_output','not_required',0,'object://runtime-worker/generation-retention-other',
          now() - interval '1 day',false,false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`,
      [
        ARTIFACT_GENERATION_REDACTION_MATCH,
        ARTIFACT_GENERATION_REDACTION_OTHER,
        ARTIFACT_GENERATION_RETENTION_MATCH,
        ARTIFACT_GENERATION_RETENTION_OTHER,
        TENANT_A,
        GENERATION_SCOPE_A,
        GENERATION_SCOPE_B,
      ],
    );
  });
}

async function seedWorkitems(pool: ReturnType<typeof createPool>): Promise<void> {
  await withTenantTx(pool, TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO workitems (id, tenant_id, connector_id, unique_reference, status, checked_out_by, checked_out_at)
       VALUES
       ($1,$2,'runtime-claim','checkout-ok','new',NULL,NULL),
       ($3,$2,'runtime-claim','checkout-cross','new',NULL,NULL),
       ($4,$2,'runtime-claim','checkout-processing','processing',$7,now()),
       ($5,$2,'runtime-claim','checkout-retry','retry',NULL,NULL),
       ($6,$2,'runtime-claim','checkout-terminal','successful',$7,now())`,
      [WORKITEM_OK, TENANT_A, WORKITEM_CROSS, WORKITEM_PROCESSING, WORKITEM_RETRY, WORKITEM_TERMINAL, OTHER_WORKER],
    );
  });
}

async function createLifecycleBypassRole(): Promise<void> {
  const admin = createPool({
    host: process.env.PGHOST,
    port: process.env.PGPORT === undefined ? undefined : Number(process.env.PGPORT),
    database: process.env.PGDATABASE,
    user: "postgres",
    // CI(비밀번호 인증)는 superuser 비밀번호 필요(PGADMIN_PASSWORD). 로컬 temp-PG(trust)는 무시.
    password: process.env.PGADMIN_PASSWORD,
    options: `-c search_path=${SCHEMA},public`,
  });
  try {
    await admin.query(`DROP ROLE IF EXISTS ${LIFECYCLE_BYPASS_ROLE}`);
    await admin.query(
      `CREATE ROLE ${LIFECYCLE_BYPASS_ROLE}
         LOGIN
         PASSWORD '${LIFECYCLE_BYPASS_PASSWORD}'
         NOSUPERUSER
         NOCREATEDB
         NOCREATEROLE
         NOINHERIT
         BYPASSRLS`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${LIFECYCLE_BYPASS_ROLE}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${SCHEMA} TO ${LIFECYCLE_BYPASS_ROLE}`);
  } finally {
    await admin.end();
  }
}

async function seedActiveRedactionClaim(pool: ReturnType<typeof createPool>): Promise<void> {
  await withTenantTx(pool, TENANT_A, async (c) => {
    const updated = await c.query(
      `UPDATE artifacts
          SET lifecycle_claim_id = $3::uuid,
              lifecycle_claim_kind = 'artifact_redaction',
              lifecycle_claim_worker_id = $4::uuid,
              lifecycle_claim_correlation_id = $5::uuid,
              lifecycle_claimed_at = now(),
              lifecycle_claim_expires_at = now() + interval '5 minutes'
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND lifecycle_claim_id IS NULL`,
      [TENANT_A, ARTIFACT_REDACTION_ACTIVE_CLAIM, ACTIVE_REDACTION_CLAIM, WORKER, CORRELATION],
    );
    check("test fixture seeds active lifecycle claim through BYPASSRLS role", updated.rowCount === 1);
  });
}

async function seedSitesAndWorkers(pool: ReturnType<typeof createPool>): Promise<void> {
  const setup = await pool.connect();
  try {
    await setup.query(
      `INSERT INTO workers (id, kind, status, circuit_state) VALUES
       ($1::uuid,'browser','active','closed'),
       ($2::uuid,'browser','active','closed'),
       ($3::uuid,'gateway','active','closed'),
       ($4::uuid,'browser','active','open')`,
      [WORKER, OTHER_WORKER, GATEWAY_WORKER, OPEN_CIRCUIT_WORKER],
    );
  } finally {
    setup.release();
  }

  await withTenantTx(pool, TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved)
       VALUES
       ($1,$2,'ok','https://ok.example/*','green',false),
       ($3,$2,'conflict','https://conflict.example/*','green',false),
       ($4,$2,'red','https://red.example/*','red',false),
       ($5,$2,'sweep','https://sweep.example/*','green',false)`,
      [SITE_OK, TENANT_A, SITE_CONFLICT, SITE_RED, SITE_SWEEP],
    );
    await c.query(
      `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label)
       VALUES
       ($1,$2,$3,'ok'),
       ($4,$2,$5,'conflict'),
       ($6,$2,$7,'red'),
       ($8,$2,$9,'sweep')`,
      [
        IDENTITY_OK,
        TENANT_A,
        SITE_OK,
        IDENTITY_CONFLICT,
        SITE_CONFLICT,
        IDENTITY_RED,
        SITE_RED,
        IDENTITY_SWEEP,
        SITE_SWEEP,
      ],
    );
  });
}

async function seedConflictLease(pool: ReturnType<typeof createPool>): Promise<void> {
  await withTenantTx(pool, TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO browser_leases (
         id, tenant_id, site_profile_id, browser_identity_id, run_id, owner_worker_id,
         isolation, state, cleanup_policy, download_dir_ref, expires_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,'context','active','clear_all','lease://held', now() + interval '5 minutes')`,
      [CONFLICT_LEASE, TENANT_A, SITE_CONFLICT, IDENTITY_CONFLICT, RUN_HOLDER, OTHER_WORKER],
    );
  });
}

async function seedSweeperLeases(pool: ReturnType<typeof createPool>): Promise<void> {
  await withTenantTx(pool, TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO browser_leases (
         id, tenant_id, site_profile_id, browser_identity_id, run_id, owner_worker_id,
         isolation, state, cleanup_policy, download_dir_ref, expires_at
       )
       VALUES
       ($1,$2,$3,$4,$5,$6,'context','active','clear_all','lease://expired', now() - interval '1 second'),
       ($7,$2,$3,$4,$5,$6,'context','active','clear_all','lease://future', now() + interval '5 minutes'),
       ($8,$2,$3,$4,$5,$6,'context','active','clear_all','lease://heartbeat', now() + interval '5 minutes'),
       ($9,$2,$3,$4,$5,$6,'context','active','clear_all','lease://drain', now() + interval '5 minutes')`,
      [
        EXPIRED_BROWSER_LEASE,
        TENANT_A,
        SITE_SWEEP,
        IDENTITY_SWEEP,
        RUN_SWEEP,
        WORKER,
        FUTURE_BROWSER_LEASE,
        HEARTBEAT_BROWSER_LEASE,
        DRAIN_BROWSER_LEASE,
      ],
    );
    await c.query(
      `INSERT INTO credential_leases (
       tenant_id, credential_ref, site_profile_id, slot_no, run_id, status, locked_until
       )
       VALUES
       ($1,$2,$3,0,$4,'active', now() - interval '1 second'),
       ($1,$5,$3,0,$4,'active', now() + interval '5 minutes')`,
      [TENANT_A, CREDENTIAL_REF_EXPIRED, SITE_SWEEP, RUN_SWEEP, CREDENTIAL_REF_FUTURE],
    );
  });
}

async function runStatus(pool: ReturnType<typeof createPool>, runId: string): Promise<{ status?: string; workerId?: string | null }> {
  return withTenantTx(pool, TENANT_A, async (c) => {
    const row = await c.query<{ status: string; worker_id: string | null }>(
      `SELECT status, worker_id::text FROM runs WHERE id=$1`,
      [runId],
    );
    return { status: row.rows[0]?.status, workerId: row.rows[0]?.worker_id };
  });
}

async function workitemDetails(pool: ReturnType<typeof createPool>, workitemId: string): Promise<{
  status?: string;
  checkedOutBy?: string | null;
  checkedOutAtSet?: boolean;
}> {
  return withTenantTx(pool, TENANT_A, async (c) => {
    const row = await c.query<{
      status: string;
      checked_out_by: string | null;
      checked_out_at_set: boolean;
    }>(
      `SELECT status, checked_out_by::text, checked_out_at IS NOT NULL AS checked_out_at_set
         FROM workitems
        WHERE id=$1::uuid`,
      [workitemId],
    );
    return {
      status: row.rows[0]?.status,
      checkedOutBy: row.rows[0]?.checked_out_by,
      checkedOutAtSet: row.rows[0]?.checked_out_at_set,
    };
  });
}

async function browserLeaseDetails(pool: ReturnType<typeof createPool>, leaseId: string): Promise<{
  state?: string;
  renewedFarFuture?: boolean;
}> {
  return withTenantTx(pool, TENANT_A, async (c) => {
    const row = await c.query<{ state: string; renewed_far_future: boolean }>(
      `SELECT state,
              expires_at > now() + interval '9 minutes' AS renewed_far_future
         FROM browser_leases
        WHERE id=$1::uuid`,
      [leaseId],
    );
    return {
      state: row.rows[0]?.state,
      renewedFarFuture: row.rows[0]?.renewed_far_future,
    };
  });
}

async function browserLeaseForRun(pool: ReturnType<typeof createPool>, runId: string): Promise<{
  state?: string;
  defaultTtlWindow?: boolean;
}> {
  return withTenantTx(pool, TENANT_A, async (c) => {
    const row = await c.query<{ state: string; default_ttl_window: boolean }>(
      `SELECT state,
              expires_at > now() + interval '4 minutes'
              AND expires_at < now() + interval '6 minutes' AS default_ttl_window
         FROM browser_leases
        WHERE run_id=$1::uuid`,
      [runId],
    );
    return {
      state: row.rows[0]?.state,
      defaultTtlWindow: row.rows[0]?.default_ttl_window,
    };
  });
}

async function leaseSweeperState(pool: ReturnType<typeof createPool>): Promise<{
  expiredBrowser?: string;
  futureBrowser?: string;
  expiredCredential?: string;
  futureCredential?: string;
}> {
  return withTenantTx(pool, TENANT_A, async (c) => {
    const rows = await c.query<{
      expired_browser: string | undefined;
      future_browser: string | undefined;
      expired_credential: string | undefined;
      future_credential: string | undefined;
    }>(
      `SELECT
         (SELECT state FROM browser_leases WHERE id=$1::uuid) AS expired_browser,
         (SELECT state FROM browser_leases WHERE id=$2::uuid) AS future_browser,
         (SELECT status FROM credential_leases WHERE tenant_id=$3::uuid AND credential_ref=$4 AND site_profile_id=$5::uuid AND slot_no=0) AS expired_credential,
         (SELECT status FROM credential_leases WHERE tenant_id=$3::uuid AND credential_ref=$6 AND site_profile_id=$5::uuid AND slot_no=0) AS future_credential`,
      [
        EXPIRED_BROWSER_LEASE,
        FUTURE_BROWSER_LEASE,
        TENANT_A,
        CREDENTIAL_REF_EXPIRED,
        SITE_SWEEP,
        CREDENTIAL_REF_FUTURE,
      ],
    );
    const row = rows.rows[0];
    return {
      expiredBrowser: row?.expired_browser,
      futureBrowser: row?.future_browser,
      expiredCredential: row?.expired_credential,
      futureCredential: row?.future_credential,
    };
  });
}

async function activeLeaseCount(pool: ReturnType<typeof createPool>, siteId: string): Promise<number> {
  return withTenantTx(pool, TENANT_A, async (c) => {
    const row = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM browser_leases
        WHERE site_profile_id=$1 AND state IN ('reserved','active') AND expires_at >= now()`,
      [siteId],
    );
    return row.rows[0]?.n ?? -1;
  });
}

async function artifactLifecycleDetails(
  pool: ReturnType<typeof createPool>,
  artifactId: string,
): Promise<{
  redactionStatus: string;
  redactionAttempts: number;
  objectRef: string;
  retentionUntil: string | null;
  legalHold: boolean;
  quarantine: boolean;
  deletedAtSet: boolean;
  deletedReason: string | null;
  deletedByJob: string | null;
  lifecycleClaimSet: boolean;
  lifecycleClaimKind: string | null;
}> {
  return withTenantTx(pool, TENANT_A, async (c) => {
    const row = await c.query<{
      redaction_status: string;
      redaction_attempts: number;
      object_ref: string;
      retention_until: string | null;
      legal_hold: boolean;
      quarantine: boolean;
      deleted_at_set: boolean;
      deleted_reason: string | null;
      deleted_by_job: string | null;
      lifecycle_claim_set: boolean;
      lifecycle_claim_kind: string | null;
    }>(
      `SELECT redaction_status, redaction_attempts, object_ref, retention_until::text, legal_hold, quarantine,
              deleted_at IS NOT NULL AS deleted_at_set, deleted_reason, deleted_by_job,
              lifecycle_claim_id IS NOT NULL AS lifecycle_claim_set, lifecycle_claim_kind
         FROM artifacts
        WHERE id=$1::uuid`,
      [artifactId],
    );
    const found = row.rows[0];
    if (found === undefined) {
      return {
        redactionStatus: "missing",
        redactionAttempts: -1,
        objectRef: "missing",
        retentionUntil: null,
        legalHold: false,
        quarantine: false,
        deletedAtSet: false,
        deletedReason: null,
        deletedByJob: null,
        lifecycleClaimSet: false,
        lifecycleClaimKind: null,
      };
    }
    return {
      redactionStatus: found.redaction_status,
      redactionAttempts: found.redaction_attempts,
      objectRef: found.object_ref,
      retentionUntil: found.retention_until,
      legalHold: found.legal_hold,
      quarantine: found.quarantine,
      deletedAtSet: found.deleted_at_set,
      deletedReason: found.deleted_reason,
      deletedByJob: found.deleted_by_job,
      lifecycleClaimSet: found.lifecycle_claim_set,
      lifecycleClaimKind: found.lifecycle_claim_kind,
    };
  });
}

async function artifactLifecycleAuditSummary(pool: ReturnType<typeof createPool>): Promise<{
  count: number;
  objectRefLeakCount: number;
  localTestEvidenceCount: number;
  stagingEvidenceCount: number;
  reasons: string[];
}> {
  return withTenantTx(pool, TENANT_A, async (c) => {
    const row = await c.query<{
      count: number;
      object_ref_leak_count: number;
      local_test_evidence_count: number;
      staging_evidence_count: number;
      reasons: string[];
    }>(
      `SELECT count(*)::int AS count,
              count(*) FILTER (WHERE payload::text LIKE '%object://%')::int AS object_ref_leak_count,
              count(*) FILTER (WHERE payload->>'object_io_evidence_schema_ref' = $2)::int AS local_test_evidence_count,
              count(*) FILTER (WHERE payload->>'object_io_may_be_used_as_staging_evidence' = 'true')::int AS staging_evidence_count,
              coalesce(array_agg(reason ORDER BY sequence_no), ARRAY[]::text[]) AS reasons
         FROM audit_log
        WHERE tenant_id=$1::uuid
          AND reason LIKE 'artifact_lifecycle.%'`,
      [TENANT_A, ARTIFACT_OBJECT_IO_LOCAL_TEST_SCHEMA_REF],
    );
    return {
      count: row.rows[0]?.count ?? 0,
      objectRefLeakCount: row.rows[0]?.object_ref_leak_count ?? 0,
      localTestEvidenceCount: row.rows[0]?.local_test_evidence_count ?? 0,
      stagingEvidenceCount: row.rows[0]?.staging_evidence_count ?? 0,
      reasons: row.rows[0]?.reasons ?? [],
    };
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
    } finally {
      setup.release();
    }
    console.log("migrations applied (concurrency -> core)");

    await seedTenant(pool, TENANT_A);
    await seedSitesAndWorkers(pool);
    await seedRun(pool, RUN_OK);
    await seedRun(pool, RUN_CROSS);
    await seedRun(pool, RUN_CONFLICT);
    await seedRun(pool, RUN_RED);
    await seedRun(pool, RUN_HOLDER, "claimed");
    await seedRun(pool, RUN_SWEEP, "claimed");
    await seedRun(pool, RUN_GATEWAY_WORKER);
    await seedRun(pool, RUN_OPEN_CIRCUIT_WORKER);
    await seedWorkitems(pool);
    await seedConflictLease(pool);
    await seedSweeperLeases(pool);
    await seedLifecycleArtifacts(pool);
    console.log("seeded runtime claim fixtures");

    const configured = new PgRuntimeWorker(pool, { workerId: WORKER, browserLeasePlanResolver: planResolver });

    spanExporter.reset();
    const ok = await configured.handle({
      kind: "run_claim",
      tenantId: TENANT_A as TenantId,
      runId: RUN_OK as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("run_claim success -> completed", ok.kind === "completed", JSON.stringify(ok));
    // §E: run.claim(루트) ⊃ browser.lease.acquire span이 실 call-site에서 발행되고 공통속성을 가진다.
    {
      const spans = spanExporter.getFinishedSpans();
      const claimSpan = spans.find((s) => s.name === "run.claim");
      const leaseSpan = spans.find((s) => s.name === "browser.lease.acquire");
      check("run_claim emits run.claim span", claimSpan !== undefined);
      check("run_claim emits browser.lease.acquire span", leaseSpan !== undefined);
      check(
        "run.claim span carries common attrs",
        claimSpan?.attributes.tenant_id === TENANT_A &&
          claimSpan?.attributes.run_id === RUN_OK &&
          claimSpan?.attributes.correlation_id === CORRELATION,
        JSON.stringify(claimSpan?.attributes),
      );
      check(
        "browser.lease.acquire nests under run.claim",
        leaseSpan?.parentSpanId !== undefined && leaseSpan?.parentSpanId === claimSpan?.spanContext().spanId,
      );
    }
    const okRun = await runStatus(pool, RUN_OK);
    check("run_claim sets run claimed", okRun.status === "claimed", JSON.stringify(okRun));
    check("run_claim sets worker_id", okRun.workerId === WORKER, JSON.stringify(okRun));
    check("run_claim creates one active lease", (await activeLeaseCount(pool, SITE_OK)) === 1);
    const okLease = await browserLeaseForRun(pool, RUN_OK);
    check(
      "run_claim defaults browser lease TTL to 5 minutes",
      okLease.state === "active" && okLease.defaultTtlWindow === true,
      JSON.stringify(okLease),
    );

    const cross = await configured.handle({
      kind: "run_claim",
      tenantId: TENANT_B as TenantId,
      runId: RUN_CROSS as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("cross-tenant run_claim fails closed", cross.kind === "failed" && cross.code === "RUN_NOT_FOUND", JSON.stringify(cross));
    const crossRun = await runStatus(pool, RUN_CROSS);
    check("cross-tenant run remains queued", crossRun.status === "queued", JSON.stringify(crossRun));

    const conflict = await configured.handle({
      kind: "run_claim",
      tenantId: TENANT_A as TenantId,
      runId: RUN_CONFLICT as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check(
      "active lease conflict defers",
      conflict.kind === "deferred" && conflict.code === "SESSION_LOCKED" && conflict.retryAfterMs > 0,
      JSON.stringify(conflict),
    );
    const conflictRun = await runStatus(pool, RUN_CONFLICT);
    check("conflict run remains queued", conflictRun.status === "queued", JSON.stringify(conflictRun));
    check("conflict does not create extra active lease", (await activeLeaseCount(pool, SITE_CONFLICT)) === 1);

    const red = await configured.handle({
      kind: "run_claim",
      tenantId: TENANT_A as TenantId,
      runId: RUN_RED as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("red unapproved site blocks", red.kind === "failed" && red.code === "SITE_PROFILE_BLOCKED", JSON.stringify(red));
    const redRun = await runStatus(pool, RUN_RED);
    check("red-site run remains queued", redRun.status === "queued", JSON.stringify(redRun));
    check("red-site block creates no lease", (await activeLeaseCount(pool, SITE_RED)) === 0);

    const gatewayWorker = new PgRuntimeWorker(pool, { workerId: GATEWAY_WORKER, browserLeasePlanResolver: planResolver });
    const gatewayWorkerClaim = await gatewayWorker.handle({
      kind: "run_claim",
      tenantId: TENANT_A as TenantId,
      runId: RUN_GATEWAY_WORKER as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check(
      "non-browser worker run_claim fails closed",
      gatewayWorkerClaim.kind === "failed" && gatewayWorkerClaim.code === "CONTROL_PLANE_INTERNAL_ERROR",
      JSON.stringify(gatewayWorkerClaim),
    );
    check("non-browser worker run remains queued", (await runStatus(pool, RUN_GATEWAY_WORKER)).status === "queued");

    const openCircuitWorker = new PgRuntimeWorker(pool, {
      workerId: OPEN_CIRCUIT_WORKER,
      browserLeasePlanResolver: planResolver,
    });
    const openCircuitClaim = await openCircuitWorker.handle({
      kind: "run_claim",
      tenantId: TENANT_A as TenantId,
      runId: RUN_OPEN_CIRCUIT_WORKER as RunId,
      correlationId: CORRELATION as CorrelationId,
    });
    check(
      "open-circuit browser worker run_claim fails closed",
      openCircuitClaim.kind === "failed" && openCircuitClaim.code === "CONTROL_PLANE_INTERNAL_ERROR",
      JSON.stringify(openCircuitClaim),
    );
    check("open-circuit worker run remains queued", (await runStatus(pool, RUN_OPEN_CIRCUIT_WORKER)).status === "queued");
    check("worker registry gate creates no extra browser lease", (await activeLeaseCount(pool, SITE_OK)) === 1);

    try {
      await new PgRuntimeWorker(pool).handle({
        kind: "run_claim",
        tenantId: TENANT_A as TenantId,
        runId: RUN_OK as RunId,
        correlationId: CORRELATION as CorrelationId,
      });
      check("run_claim without configured worker identity throws", false, "expected throw");
    } catch (err) {
      check(
        "run_claim without configured worker identity throws",
        String(err).includes("workerId"),
        String(err),
      );
    }

    const checkout = await configured.handle({
      kind: "workitem_checkout",
      tenantId: TENANT_A as TenantId,
      workitemId: WORKITEM_OK as WorkitemId,
      correlationId: CORRELATION as CorrelationId,
    });
    check("workitem_checkout W1 success -> completed", checkout.kind === "completed", JSON.stringify(checkout));
    const checkoutItem = await workitemDetails(pool, WORKITEM_OK);
    check("workitem_checkout W1 sets processing", checkoutItem.status === "processing", JSON.stringify(checkoutItem));
    check("workitem_checkout W1 sets checked_out_by", checkoutItem.checkedOutBy === WORKER, JSON.stringify(checkoutItem));
    check("workitem_checkout W1 sets checked_out_at", checkoutItem.checkedOutAtSet === true, JSON.stringify(checkoutItem));

    const duplicateCheckout = await configured.handle({
      kind: "workitem_checkout",
      tenantId: TENANT_A as TenantId,
      workitemId: WORKITEM_OK as WorkitemId,
      correlationId: CORRELATION as CorrelationId,
    });
    check(
      "workitem_checkout duplicate fails closed",
      duplicateCheckout.kind === "failed" && duplicateCheckout.code === "WORKITEM_CHECKOUT_CONFLICT",
      JSON.stringify(duplicateCheckout),
    );

    const crossCheckout = await configured.handle({
      kind: "workitem_checkout",
      tenantId: TENANT_B as TenantId,
      workitemId: WORKITEM_CROSS as WorkitemId,
      correlationId: CORRELATION as CorrelationId,
    });
    check(
      "cross-tenant workitem_checkout fails closed",
      crossCheckout.kind === "failed" && crossCheckout.code === "RESOURCE_NOT_FOUND",
      JSON.stringify(crossCheckout),
    );
    const crossItem = await workitemDetails(pool, WORKITEM_CROSS);
    check("cross-tenant checkout leaves workitem new", crossItem.status === "new", JSON.stringify(crossItem));

    const processingCheckout = await configured.handle({
      kind: "workitem_checkout",
      tenantId: TENANT_A as TenantId,
      workitemId: WORKITEM_PROCESSING as WorkitemId,
      correlationId: CORRELATION as CorrelationId,
    });
    check(
      "processing workitem_checkout conflicts explicitly",
      processingCheckout.kind === "failed" && processingCheckout.code === "WORKITEM_CHECKOUT_CONFLICT",
      JSON.stringify(processingCheckout),
    );

    const retryCheckout = await configured.handle({
      kind: "workitem_checkout",
      tenantId: TENANT_A as TenantId,
      workitemId: WORKITEM_RETRY as WorkitemId,
      correlationId: CORRELATION as CorrelationId,
    });
    check(
      "retry workitem_checkout remains blocked until W8 side effects are implemented",
      retryCheckout.kind === "failed" && retryCheckout.code === "WORKITEM_CHECKOUT_CONFLICT",
      JSON.stringify(retryCheckout),
    );

    const terminalCheckout = await configured.handle({
      kind: "workitem_checkout",
      tenantId: TENANT_A as TenantId,
      workitemId: WORKITEM_TERMINAL as WorkitemId,
      correlationId: CORRELATION as CorrelationId,
    });
    check(
      "terminal workitem_checkout conflicts explicitly",
      terminalCheckout.kind === "failed" && terminalCheckout.code === "WORKITEM_CHECKOUT_CONFLICT",
      JSON.stringify(terminalCheckout),
    );

    try {
      await new PgRuntimeWorker(pool).handle({
        kind: "workitem_checkout",
        tenantId: TENANT_A as TenantId,
        workitemId: WORKITEM_CROSS as WorkitemId,
        correlationId: CORRELATION as CorrelationId,
      });
      check("workitem_checkout without configured worker identity throws", false, "expected throw");
    } catch (err) {
      check("workitem_checkout without configured worker identity throws", String(err).includes("workerId"), String(err));
    }

    try {
      await configured.handle({
        kind: "workitem_checkout",
        tenantId: TENANT_A as TenantId,
        workitemId: WORKITEM_CROSS as WorkitemId,
      });
      check("workitem_checkout without correlationId throws", false, "expected throw");
    } catch (err) {
      check("workitem_checkout without correlationId throws", String(err).includes("correlationId"), String(err));
    }

    try {
      await configured.handle({
        kind: "run_resume",
        tenantId: TENANT_A as TenantId,
        runId: RUN_OK as RunId,
        correlationId: CORRELATION as CorrelationId,
      });
      check("run_resume without SessionRestorer throws", false, "expected throw");
    } catch (err) {
      check("run_resume without SessionRestorer throws", String(err).includes("SessionRestorer"), String(err));
    }

    try {
      await configured.handle({
        kind: "artifact_redaction",
        tenantId: TENANT_A as TenantId,
        runId: RUN_HOLDER as RunId,
        correlationId: CORRELATION as CorrelationId,
      });
      check("artifact_redaction without ArtifactRedactor throws", false, "expected throw");
    } catch (err) {
      check("artifact_redaction without ArtifactRedactor throws", String(err).includes("ArtifactRedactor"), String(err));
    }

    try {
      await configured.handle({
        kind: "artifact_retention",
        tenantId: TENANT_A as TenantId,
        correlationId: CORRELATION as CorrelationId,
      });
      check("artifact_retention without ArtifactRetentionStore throws", false, "expected throw");
    } catch (err) {
      check(
        "artifact_retention without ArtifactRetentionStore throws",
        String(err).includes("ArtifactRetentionStore"),
        String(err),
      );
    }

    const unboundRedactor = {
      redact: fakeArtifactRedactor.redact,
    } as unknown as ArtifactRedactor;
    try {
      await new PgRuntimeWorker(pool, {
        workerId: WORKER,
        artifactRedactor: unboundRedactor,
      }).handle({
        kind: "artifact_redaction",
        tenantId: TENANT_A as TenantId,
        runId: RUN_HOLDER as RunId,
        correlationId: CORRELATION as CorrelationId,
      });
      check("artifact_redaction without object-store binding throws", false, "expected throw");
    } catch (err) {
      check(
        "artifact_redaction without object-store binding throws",
        String(err).includes("real object-store port binding"),
        String(err),
      );
    }

    const malformedRealRedactor = {
      binding: {
        kind: "real_object_store",
        backendAlias: "staging-object-store",
        evidenceSchemaRef: ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
      },
      redact: fakeArtifactRedactor.redact,
    } as unknown as ArtifactRedactor;
    try {
      await new PgRuntimeWorker(pool, {
        workerId: WORKER,
        artifactRedactor: malformedRealRedactor,
      }).handle({
        kind: "artifact_redaction",
        tenantId: TENANT_A as TenantId,
        runId: RUN_HOLDER as RunId,
        correlationId: CORRELATION as CorrelationId,
      });
      check("artifact_redaction real port without SecretRef throws", false, "expected throw");
    } catch (err) {
      check(
        "artifact_redaction real port without SecretRef throws",
        String(err).includes("SecretRef"),
        String(err),
      );
    }

    try {
      await new PgRuntimeWorker(pool, {
        workerId: WORKER,
        artifactRedactor: fakeArtifactRedactor,
      }).handle({
        kind: "artifact_redaction",
        tenantId: TENANT_A as TenantId,
        runId: RUN_HOLDER as RunId,
        correlationId: CORRELATION as CorrelationId,
      });
      check("artifact_redaction test_fake port is rejected without test opt-in", false, "expected throw");
    } catch (err) {
      check(
        "artifact_redaction test_fake port is rejected without test opt-in",
        String(err).includes("local-test-only"),
        String(err),
      );
    }
    check("artifact_redaction port wiring failures call no redactor", redactionCalls.length === 0);

    try {
      await new PgRuntimeWorker(pool, {
        workerId: WORKER,
        artifactRetentionStore: fakeArtifactRetentionStore,
      }).handle({
        kind: "artifact_retention",
        tenantId: TENANT_A as TenantId,
        correlationId: CORRELATION as CorrelationId,
      });
      check("artifact_retention test_fake port is rejected without test opt-in", false, "expected throw");
    } catch (err) {
      check(
        "artifact_retention test_fake port is rejected without test opt-in",
        String(err).includes("local-test-only"),
        String(err),
      );
    }
    check("artifact_retention port wiring failures call no object store", retentionCalls.length === 0);

    const nonBypassRedactor = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      artifactRedactor: fakeArtifactRedactor,
      allowTestArtifactLifecyclePorts: true,
    });
    try {
      await nonBypassRedactor.handle({
        kind: "artifact_redaction",
        tenantId: TENANT_A as TenantId,
        runId: RUN_HOLDER as RunId,
        correlationId: CORRELATION as CorrelationId,
      });
      check("artifact_redaction refuses non-BYPASSRLS role before object I/O", false, "expected throw");
    } catch (err) {
      check(
        "artifact_redaction refuses non-BYPASSRLS role before object I/O",
        String(err).includes("BYPASSRLS"),
        String(err),
      );
    }
    check("artifact_redaction non-BYPASSRLS gate calls no redactor", redactionCalls.length === 0);

    const nonBypassRetention = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      artifactRetentionStore: fakeArtifactRetentionStore,
      allowTestArtifactLifecyclePorts: true,
    });
    try {
      await nonBypassRetention.handle({
        kind: "artifact_retention",
        tenantId: TENANT_A as TenantId,
        correlationId: CORRELATION as CorrelationId,
      });
      check("artifact_retention refuses non-BYPASSRLS role before object I/O", false, "expected throw");
    } catch (err) {
      check(
        "artifact_retention refuses non-BYPASSRLS role before object I/O",
        String(err).includes("BYPASSRLS"),
        String(err),
      );
    }
    check("artifact_retention non-BYPASSRLS gate calls no object store", retentionCalls.length === 0);

    await createLifecycleBypassRole();
    const lifecycleBypassPool = createPool({
      host: process.env.PGHOST,
      port: process.env.PGPORT === undefined ? undefined : Number(process.env.PGPORT),
      database: process.env.PGDATABASE,
      user: LIFECYCLE_BYPASS_ROLE,
      // 역할 비밀번호 명시(env PGPASSWORD=rpa_smoke가 아님). 로컬 trust는 무시.
      password: LIFECYCLE_BYPASS_PASSWORD,
      options: `-c search_path=${SCHEMA},public`,
    });
    try {
      await seedActiveRedactionClaim(lifecycleBypassPool);
      const supersededDeletes: string[] = []; // AUD-9: redaction 후 삭제된 원본 객체 ref 기록.
      const bypassWorker = new PgRuntimeWorker(lifecycleBypassPool, {
        workerId: WORKER,
        artifactRedactor: fakeArtifactRedactor,
        artifactRetentionStore: fakeArtifactRetentionStore,
        artifactSupersededObjectStore: { delete: async (ref) => { supersededDeletes.push(String(ref)); } },
        artifactIntegrityObjectStore: fakeIntegrityObjectStore,
        allowTestArtifactLifecyclePorts: true,
      });
      const activeClaim = await bypassWorker.handle({
        kind: "artifact_redaction",
        tenantId: TENANT_A as TenantId,
        runId: RUN_SWEEP as RunId,
        correlationId: CORRELATION as CorrelationId,
      });
      check(
        "artifact_redaction active unexpired claim defers",
        activeClaim.kind === "deferred" && activeClaim.code === "SESSION_LOCKED" && activeClaim.retryAfterMs > 0,
        JSON.stringify(activeClaim),
      );
      check("artifact_redaction active claim deferral calls no redactor", redactionCalls.length === 0);

      const redaction = await bypassWorker.handle({
        kind: "artifact_redaction",
        tenantId: TENANT_A as TenantId,
        runId: RUN_HOLDER as RunId,
        correlationId: CORRELATION as CorrelationId,
      });
      check("artifact_redaction BYPASSRLS path completes", redaction.kind === "completed", JSON.stringify(redaction));
      const redacted = await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_REDACTION_PENDING);
      check(
        "artifact_redaction finalize marks redacted by claim CAS",
        redacted.redactionStatus === "redacted" &&
          redacted.redactionAttempts === 1 &&
          redacted.objectRef === "object://runtime-worker/redacted-safe" &&
          redacted.lifecycleClaimSet === false,
        JSON.stringify(redacted),
      );
      check("artifact_redaction calls redactor exactly once", redactionCalls.length === 1);
      check(
        "artifact_redaction port receives ArtifactRef, policy, and local-test binding",
        redactionCalls[0]?.artifact.artifactRef === ARTIFACT_REDACTION_PENDING &&
          redactionCalls[0]?.policy.maxAttempts === 5 &&
          redactionCalls[0]?.portBinding.kind === "test_fake",
        JSON.stringify(redactionCalls[0]),
      );
      check(
        "artifact_redaction AUD-9: redacted 후 원본 평문 객체 삭제(redacted-at-rest)",
        supersededDeletes.includes("object://runtime-worker/redaction-pending"),
        supersededDeletes.join(","),
      );
      check(
        "artifact_redaction AUD-9: redacted 객체는 삭제하지 않음",
        !supersededDeletes.includes("object://runtime-worker/redacted-safe"),
        supersededDeletes.join(","),
      );
      check(
        "artifact_redaction skips quarantined/deleted/already redacted rows",
        (await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_REDACTION_QUARANTINED)).redactionStatus === "pending" &&
          (await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_REDACTION_DELETED)).deletedAtSet === true &&
          (await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_REDACTION_ALREADY)).redactionStatus === "redacted",
      );

      const redactionRetryPending = await bypassWorker.handle({
        kind: "artifact_redaction",
        tenantId: TENANT_A as TenantId,
        runId: RUN_HOLDER as RunId,
        correlationId: CORRELATION as CorrelationId,
      });
      check(
        "artifact_redaction retryable result below max keeps row pending",
        redactionRetryPending.kind === "completed",
        JSON.stringify(redactionRetryPending),
      );
      const retryablePending = await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_REDACTION_RETRYABLE);
      check(
        "artifact_redaction retryable below max increments attempts without marking failed",
        retryablePending.redactionStatus === "pending" &&
          retryablePending.redactionAttempts === 4 &&
          retryablePending.lifecycleClaimSet === false,
        JSON.stringify(retryablePending),
      );

      const redactionRetryExhausted = await bypassWorker.handle({
        kind: "artifact_redaction",
        tenantId: TENANT_A as TenantId,
        runId: RUN_HOLDER as RunId,
        correlationId: CORRELATION as CorrelationId,
      });
      check(
        "artifact_redaction retryable result at max completes finalization",
        redactionRetryExhausted.kind === "completed",
        JSON.stringify(redactionRetryExhausted),
      );
      const retryableFailed = await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_REDACTION_RETRYABLE);
      check(
        "artifact_redaction retryable at max marks failed and clears claim",
        retryableFailed.redactionStatus === "failed" &&
          retryableFailed.redactionAttempts === 5 &&
          retryableFailed.lifecycleClaimSet === false,
        JSON.stringify(retryableFailed),
      );
      check(
        "artifact_redaction retry threshold calls retryable fixture twice",
        redactionCalls.filter((call) => call.artifact.artifactRef === ARTIFACT_REDACTION_RETRYABLE).length === 2,
        JSON.stringify(redactionCalls.map((call) => call.artifact.artifactRef)),
      );

      const scopedGenerationRedaction = await bypassWorker.handle({
        kind: "artifact_redaction",
        tenantId: TENANT_A as TenantId,
        artifactId: ARTIFACT_REDACTION_GENERATION_TARGET as RuntimeWorkerJob["artifactId"],
        generationId: GENERATION_TARGET as RuntimeWorkerJob["generationId"],
        correlationId: CORRELATION as CorrelationId,
      });
      check(
        "artifact_redaction generation-scoped job ignores unrelated active tenant claim",
        scopedGenerationRedaction.kind === "completed",
        JSON.stringify(scopedGenerationRedaction),
      );
      const generationTarget = await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_REDACTION_GENERATION_TARGET);
      const generationUnrelated = await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_REDACTION_GENERATION_UNRELATED);
      check(
        "artifact_redaction generation-scoped job only redacts requested artifact",
        generationTarget.redactionStatus === "redacted" &&
          generationTarget.objectRef === "object://runtime-worker/generation-redacted-safe" &&
          generationUnrelated.redactionStatus === "pending",
        JSON.stringify({ generationTarget, generationUnrelated }),
      );
      check(
        "artifact_redaction generation-scoped job calls redactor for target only",
        redactionCalls.filter((call) => call.artifact.artifactRef === ARTIFACT_REDACTION_GENERATION_TARGET).length === 1 &&
          !redactionCalls.some((call) => call.artifact.artifactRef === ARTIFACT_REDACTION_GENERATION_UNRELATED),
        JSON.stringify(redactionCalls.map((call) => call.artifact.artifactRef)),
      );

      await withTenantTx(lifecycleBypassPool, TENANT_A, async (c) => {
        await c.query(
          `UPDATE artifacts
              SET lifecycle_claim_expires_at = now() - interval '1 minute'
                , lifecycle_claimed_at = now() - interval '2 minutes'
            WHERE tenant_id = $1::uuid AND id = $2::uuid`,
          [TENANT_A, ARTIFACT_REDACTION_ACTIVE_CLAIM],
        );
      });
      const tenantWideRedaction = await bypassWorker.handle({
        kind: "artifact_redaction",
        tenantId: TENANT_A as TenantId,
        correlationId: CORRELATION as CorrelationId,
      });
      check("artifact_redaction tenant-wide maintenance sweep still claims eligible rows", tenantWideRedaction.kind === "completed", JSON.stringify(tenantWideRedaction));
      const tenantWideClaimed = await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_REDACTION_ACTIVE_CLAIM);
      check(
        "artifact_redaction tenant-wide maintenance sweep is not forced to generation scope",
        redactionCalls.some((call) => call.artifact.artifactRef === ARTIFACT_REDACTION_ACTIVE_CLAIM) &&
          tenantWideClaimed.redactionStatus === "failed" &&
          tenantWideClaimed.lifecycleClaimSet === false,
        JSON.stringify({ calls: redactionCalls.map((call) => call.artifact.artifactRef), tenantWideClaimed }),
      );

      const retentionDelete = await bypassWorker.handle({
        kind: "artifact_retention",
        tenantId: TENANT_A as TenantId,
        correlationId: CORRELATION as CorrelationId,
      });
      check("artifact_retention deleted result completes", retentionDelete.kind === "completed", JSON.stringify(retentionDelete));
      const deleted = await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_RETENTION_DELETE);
      check(
        "artifact_retention deleted result tombstones row",
        deleted.deletedAtSet === true &&
          deleted.deletedReason === "retention_expired" &&
          deleted.deletedByJob !== null &&
          deleted.lifecycleClaimSet === false,
        JSON.stringify(deleted),
      );

      const retentionNotFound = await bypassWorker.handle({
        kind: "artifact_retention",
        tenantId: TENANT_A as TenantId,
        correlationId: CORRELATION as CorrelationId,
      });
      check("artifact_retention not_found result completes", retentionNotFound.kind === "completed", JSON.stringify(retentionNotFound));
      const notFound = await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_RETENTION_NOT_FOUND);
      check(
        "artifact_retention not_found is idempotent success",
        notFound.deletedAtSet === true &&
          notFound.deletedReason === "retention_expired" &&
          notFound.deletedByJob !== null &&
          notFound.lifecycleClaimSet === false,
        JSON.stringify(notFound),
      );

      const retentionTransient = await bypassWorker.handle({
        kind: "artifact_retention",
        tenantId: TENANT_A as TenantId,
        correlationId: CORRELATION as CorrelationId,
      });
      check("artifact_retention transient result completes", retentionTransient.kind === "completed", JSON.stringify(retentionTransient));
      const transient = await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_RETENTION_TRANSIENT);
      check(
        "artifact_retention transient failure clears claim without tombstone",
        transient.deletedAtSet === false &&
          transient.deletedReason === null &&
          transient.deletedByJob === null &&
          transient.lifecycleClaimSet === false,
        JSON.stringify(transient),
      );
      check("artifact_retention calls object store for each eligible due row", retentionCalls.length === 3);

      const retentionRetry = await bypassWorker.handle({
        kind: "artifact_retention",
        tenantId: TENANT_A as TenantId,
        correlationId: CORRELATION as CorrelationId,
      });
      check("artifact_retention retries transient due row", retentionRetry.kind === "completed", JSON.stringify(retentionRetry));
      check(
        "artifact_retention retry does not call skipped rows",
        retentionCalls.length === 4 &&
          retentionCalls[3]?.artifact.artifactRef === ARTIFACT_RETENTION_TRANSIENT &&
          !retentionCalls.some((call) =>
            [
              ARTIFACT_RETENTION_LEGAL_HOLD,
              ARTIFACT_RETENTION_QUARANTINE,
              ARTIFACT_RETENTION_UNEXPIRED,
              ARTIFACT_RETENTION_ALREADY_DELETED,
            ].includes(call.artifact.artifactRef),
          ),
        JSON.stringify(retentionCalls.map((call) => call.artifact.artifactRef)),
      );

      await seedGenerationLifecycleArtifacts(lifecycleBypassPool);
      const redactionCallsBeforeGenerationScope = redactionCalls.length;
      const generationRedaction = await bypassWorker.handle({
        kind: "artifact_redaction",
        tenantId: TENANT_A as TenantId,
        generationId: GENERATION_SCOPE_A as RuntimeWorkerJob["generationId"],
        correlationId: CORRELATION as CorrelationId,
      });
      check("artifact_redaction generation-scoped job completes", generationRedaction.kind === "completed", JSON.stringify(generationRedaction));
      const generationRedacted = await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_GENERATION_REDACTION_MATCH);
      const otherGenerationPending = await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_GENERATION_REDACTION_OTHER);
      check(
        "artifact_redaction generationId scope only redacts matching generation artifact",
        redactionCalls.length === redactionCallsBeforeGenerationScope + 1 &&
          redactionCalls[redactionCalls.length - 1]?.artifact.artifactRef === ARTIFACT_GENERATION_REDACTION_MATCH &&
          redactionCalls[redactionCalls.length - 1]?.artifact.generationId === GENERATION_SCOPE_A &&
          redactionCalls[redactionCalls.length - 1]?.artifact.runId === undefined &&
          generationRedacted.redactionStatus === "redacted" &&
          generationRedacted.objectRef === "object://runtime-worker/generation-redacted-safe" &&
          otherGenerationPending.redactionStatus === "pending",
        JSON.stringify({
          calls: redactionCalls.map((call) => call.artifact.artifactRef),
          generationRedacted,
          otherGenerationPending,
        }),
      );

      const retentionCallsBeforeGenerationScope = retentionCalls.length;
      const generationRetention = await bypassWorker.handle({
        kind: "artifact_retention",
        tenantId: TENANT_A as TenantId,
        generationId: GENERATION_SCOPE_A as RuntimeWorkerJob["generationId"],
        correlationId: CORRELATION as CorrelationId,
      });
      check("artifact_retention generation-scoped job completes", generationRetention.kind === "completed", JSON.stringify(generationRetention));
      const generationDeleted = await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_GENERATION_RETENTION_MATCH);
      const otherGenerationRetained = await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_GENERATION_RETENTION_OTHER);
      const runTransientStillDue = await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_RETENTION_TRANSIENT);
      check(
        "artifact_retention generationId scope only deletes matching generation artifact",
        retentionCalls.length === retentionCallsBeforeGenerationScope + 1 &&
          retentionCalls[retentionCalls.length - 1]?.artifact.artifactRef === ARTIFACT_GENERATION_RETENTION_MATCH &&
          retentionCalls[retentionCalls.length - 1]?.artifact.generationId === GENERATION_SCOPE_A &&
          retentionCalls[retentionCalls.length - 1]?.artifact.runId === undefined &&
          generationDeleted.deletedAtSet === true &&
          generationDeleted.deletedReason === "retention_expired" &&
          otherGenerationRetained.deletedAtSet === false &&
          runTransientStillDue.deletedAtSet === false,
        JSON.stringify({
          calls: retentionCalls.map((call) => call.artifact.artifactRef),
          generationDeleted,
          otherGenerationRetained,
          runTransientStillDue,
        }),
      );

      // AUD-11 legal_hold TOCTOU: claim 커밋과 물리 삭제 사이 윈도우에 legal_hold 가 켜져도 삭제·tombstone 이
      // 원자적으로 유지되어 "바이트 삭제됨 + deleted_at NULL"(보존대상 비가역 손실) 불일치가 생기지 않아야 한다.
      // 전용 generation 스코프로 다른 due 행과 격리.
      await withTenantTx(lifecycleBypassPool, TENANT_A, async (c) => {
        await c.query(
          `INSERT INTO scenario_generations
             (id, tenant_id, mode, status, prompt_hash, planner, draft_ir, validation_report,
              evidence_policy, blockers, created_by)
           VALUES ($1::uuid,$2::uuid,'save','saved','hash-generation-toctou','llm_v1','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb,'aud11-test')`,
          [GENERATION_TOCTOU, TENANT_A],
        );
        await c.query(
          `INSERT INTO artifacts (
             id, tenant_id, generation_id, type, redaction_status, redaction_attempts, object_ref,
             retention_until, legal_hold, quarantine, deleted_at, deleted_reason, deleted_by_job,
             lifecycle_claim_id, lifecycle_claim_kind, lifecycle_claim_worker_id,
             lifecycle_claim_correlation_id, lifecycle_claimed_at, lifecycle_claim_expires_at
           )
           VALUES ($1,$2,$3,'scenario_generation_llm_output','not_required',0,'object://runtime-worker/retention-toctou',
              now() - interval '1 day',false,false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`,
          [ARTIFACT_RETENTION_TOCTOU, TENANT_A, GENERATION_TOCTOU],
        );
      });

      toctouConcurrentHold = async (artifactId) => {
        // deleteObject 진행 중 별도 커넥션에서 legal_hold=true 를 시도. fix(re-check 가 행을 FOR UPDATE 로 잠금) 경로에서는
        // 이 쓰기가 락 대기 → statement_timeout 으로 취소(처리기 tx 가 deleteObject 완료를 기다리므로 PG 자동 데드락 감지
        // 불가 → 타임아웃이 교착을 끊음). no-fix 경로에서는 락이 없어 즉시 커밋 → finalize CAS(legal_hold=false)가 깨진다.
        const holdClient = await lifecycleBypassPool.connect();
        try {
          await holdClient.query("SET statement_timeout = 1500");
          await holdClient.query("UPDATE artifacts SET legal_hold = true WHERE id = $1::uuid", [artifactId]);
        } catch {
          /* fix 경로: 행 락에 막혀 statement_timeout 으로 취소됨(기대된 차단) */
        } finally {
          holdClient.release();
        }
      };
      let toctouOutcome: string;
      try {
        const toctouResult = await bypassWorker.handle({
          kind: "artifact_retention",
          tenantId: TENANT_A as TenantId,
          generationId: GENERATION_TOCTOU as RuntimeWorkerJob["generationId"],
          correlationId: CORRELATION as CorrelationId,
        });
        toctouOutcome = toctouResult.kind;
      } catch (err) {
        toctouOutcome = `threw:${String(err)}`;
      } finally {
        toctouConcurrentHold = undefined;
      }
      const toctouState = await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_RETENTION_TOCTOU);
      check(
        "artifact_retention legal_hold TOCTOU: delete+tombstone stays atomic under concurrent legal_hold write (AUD-11)",
        toctouOutcome === "completed" && toctouState.deletedAtSet === true && toctouState.lifecycleClaimSet === false,
        JSON.stringify({ toctouOutcome, toctouState }),
      );

      try {
        await bypassWorker.handle({
          kind: "artifact_redaction",
          tenantId: TENANT_A as TenantId,
          runId: RUN_HOLDER as RunId,
          generationId: GENERATION_SCOPE_A as RuntimeWorkerJob["generationId"],
          correlationId: CORRELATION as CorrelationId,
        });
        check("artifact_redaction rejects mixed runId/generationId scope", false, "expected throw");
      } catch (err) {
        check(
          "artifact_redaction rejects mixed runId/generationId scope",
          String(err).includes("cannot set both runId and generationId"),
          String(err),
        );
      }

      const lifecycleAudit = await artifactLifecycleAuditSummary(pool);
      check("artifact lifecycle appends claim/finalize audits", lifecycleAudit.count >= 8, JSON.stringify(lifecycleAudit));
      check("artifact lifecycle audit payloads do not leak ObjectRef", lifecycleAudit.objectRefLeakCount === 0, JSON.stringify(lifecycleAudit));
      check(
        "artifact lifecycle local fake evidence is marked non-staging",
        lifecycleAudit.localTestEvidenceCount >= 3 && lifecycleAudit.stagingEvidenceCount === 0,
        JSON.stringify(lifecycleAudit),
      );

      // AUD-10 artifact_integrity_checker: sha256 ↔ object 실제 해시 대조 → 불일치 quarantine. 전용 테넌트로 격리.
      await seedIntegrityArtifacts(lifecycleBypassPool);
      // 사전 상태: 어떤 것도 격리되지 않음(체커가 플립하는 것임을 증명 — 사전 상태가 아님).
      const okBefore = await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_INTEGRITY_OK);
      const tamperedBefore = await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_INTEGRITY_TAMPERED);
      check(
        "artifact_integrity pre-scan: no integrity artifact is pre-quarantined",
        okBefore.quarantine === false && tamperedBefore.quarantine === false,
        JSON.stringify({ okBefore, tamperedBefore }),
      );

      integrityGetBytesCalls.length = 0;
      const integrity = await bypassWorker.handle({
        kind: "artifact_integrity",
        tenantId: TENANT_INTEGRITY as TenantId,
        correlationId: CORRELATION as CorrelationId,
      });
      check("artifact_integrity job completes", integrity.kind === "completed", JSON.stringify(integrity));

      const okAfter = await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_INTEGRITY_OK);
      const tamperedAfter = await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_INTEGRITY_TAMPERED);
      const missingAfter = await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_INTEGRITY_MISSING);
      const pendingAfter = await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_INTEGRITY_PENDING);
      const quarantinedAfter = await artifactLifecycleDetails(lifecycleBypassPool, ARTIFACT_INTEGRITY_QUARANTINED);
      check(
        "artifact_integrity quarantines tampered (hash mismatch) and missing object, spares matching",
        okAfter.quarantine === false &&
          tamperedAfter.quarantine === true &&
          missingAfter.quarantine === true,
        JSON.stringify({ okAfter, tamperedAfter, missingAfter }),
      );
      check(
        "artifact_integrity excludes pending and already-quarantined rows from scan",
        pendingAfter.quarantine === false &&
          quarantinedAfter.quarantine === true &&
          !integrityGetBytesCalls.includes("object://runtime-worker/integrity-pending") &&
          !integrityGetBytesCalls.includes("object://runtime-worker/integrity-already-q"),
        JSON.stringify({ pendingAfter, quarantinedAfter, calls: integrityGetBytesCalls }),
      );
    } finally {
      await lifecycleBypassPool.end();
    }

    const wrongRenew = await withTenantTx(pool, TENANT_A, (c) =>
      renewBrowserLease(c, {
        tenantId: TENANT_A,
        leaseId: HEARTBEAT_BROWSER_LEASE,
        workerId: OTHER_WORKER,
        ttlMs: 600_000,
      }),
    );
    check("wrong-worker browser heartbeat is lost", wrongRenew.kind === "lost" && wrongRenew.code === "BROWSER_LEASE_EXPIRED", JSON.stringify(wrongRenew));
    check("wrong-worker heartbeat leaves lease active", (await browserLeaseDetails(pool, HEARTBEAT_BROWSER_LEASE)).state === "active");

    const crossTenantRenew = await withTenantTx(pool, TENANT_B, (c) =>
      renewBrowserLease(c, {
        tenantId: TENANT_B,
        leaseId: HEARTBEAT_BROWSER_LEASE,
        workerId: WORKER,
        ttlMs: 600_000,
      }),
    );
    check("cross-tenant browser heartbeat is lost", crossTenantRenew.kind === "lost" && crossTenantRenew.code === "BROWSER_LEASE_EXPIRED", JSON.stringify(crossTenantRenew));
    check("cross-tenant heartbeat leaves tenant A lease active", (await browserLeaseDetails(pool, HEARTBEAT_BROWSER_LEASE)).state === "active");

    const ownerRenew = await withTenantTx(pool, TENANT_A, (c) =>
      renewBrowserLease(c, {
        tenantId: TENANT_A,
        leaseId: HEARTBEAT_BROWSER_LEASE,
        workerId: WORKER,
        ttlMs: 600_000,
      }),
    );
    check("owner browser heartbeat renews", ownerRenew.kind === "renewed", JSON.stringify(ownerRenew));
    check("owner heartbeat extends expiry", (await browserLeaseDetails(pool, HEARTBEAT_BROWSER_LEASE)).renewedFarFuture === true);

    const expiredRenew = await withTenantTx(pool, TENANT_A, (c) =>
      renewBrowserLease(c, {
        tenantId: TENANT_A,
        leaseId: EXPIRED_BROWSER_LEASE,
        workerId: WORKER,
        ttlMs: 600_000,
      }),
    );
    check("expired browser heartbeat does not revive", expiredRenew.kind === "lost" && expiredRenew.code === "BROWSER_LEASE_EXPIRED", JSON.stringify(expiredRenew));

    await withTenantTx(pool, TENANT_A, (c) =>
      drainBrowserLease(c, {
        tenantId: TENANT_A,
        leaseId: DRAIN_BROWSER_LEASE,
        workerId: OTHER_WORKER,
        reason: "run_completed",
      }),
    );
    check("wrong-worker drain leaves lease active", (await browserLeaseDetails(pool, DRAIN_BROWSER_LEASE)).state === "active");

    await withTenantTx(pool, TENANT_A, (c) =>
      drainBrowserLease(c, {
        tenantId: TENANT_A,
        leaseId: DRAIN_BROWSER_LEASE,
        workerId: WORKER,
        reason: "run_completed",
      }),
    );
    check("owner drain marks browser lease draining", (await browserLeaseDetails(pool, DRAIN_BROWSER_LEASE)).state === "draining");

    const drainedRenew = await withTenantTx(pool, TENANT_A, (c) =>
      renewBrowserLease(c, {
        tenantId: TENANT_A,
        leaseId: DRAIN_BROWSER_LEASE,
        workerId: WORKER,
        ttlMs: 600_000,
      }),
    );
    check("drained browser heartbeat is lost", drainedRenew.kind === "lost" && drainedRenew.code === "BROWSER_LEASE_EXPIRED", JSON.stringify(drainedRenew));

    const beforeCrossTenantSweep = await new PgRuntimeWorker(pool).handle({
      kind: "lease_sweeper",
      tenantId: TENANT_B as TenantId,
    });
    check("cross-tenant lease_sweeper completes", beforeCrossTenantSweep.kind === "completed", JSON.stringify(beforeCrossTenantSweep));
    const beforeSweep = await leaseSweeperState(pool);
    check("cross-tenant sweep does not touch tenant A browser lease", beforeSweep.expiredBrowser === "active", JSON.stringify(beforeSweep));
    check("cross-tenant sweep does not touch tenant A credential lease", beforeSweep.expiredCredential === "active", JSON.stringify(beforeSweep));

    const sweep = await new PgRuntimeWorker(pool).handle({
      kind: "lease_sweeper",
      tenantId: TENANT_A as TenantId,
    });
    check("tenant lease_sweeper completes", sweep.kind === "completed", JSON.stringify(sweep));
    const afterSweep = await leaseSweeperState(pool);
    check("lease_sweeper expires stale browser lease", afterSweep.expiredBrowser === "expired", JSON.stringify(afterSweep));
    check("lease_sweeper preserves future browser lease", afterSweep.futureBrowser === "active", JSON.stringify(afterSweep));
    check("lease_sweeper expires stale credential lease", afterSweep.expiredCredential === "expired", JSON.stringify(afterSweep));
    check("lease_sweeper preserves future credential lease", afterSweep.futureCredential === "active", JSON.stringify(afterSweep));

    const sweepAgain = await new PgRuntimeWorker(pool).handle({
      kind: "lease_sweeper",
      tenantId: TENANT_A as TenantId,
    });
    check("lease_sweeper idempotent second pass", sweepAgain.kind === "completed", JSON.stringify(sweepAgain));
    const afterSecondSweep = await leaseSweeperState(pool);
    check("second sweep keeps expired/future states stable", JSON.stringify(afterSecondSweep) === JSON.stringify(afterSweep), JSON.stringify(afterSecondSweep));

    try {
      await new PgRuntimeWorker(pool).handle({ kind: "lease_sweeper" });
      check("lease_sweeper without tenantId throws", false, "expected throw");
    } catch (err) {
      check("lease_sweeper without tenantId throws", String(err).includes("lease_sweeper.tenantId"), String(err));
    }
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D3 runtime-worker claim integration green");
}

main().catch((err) => {
  console.error("FAIL: runtime-worker claim integration threw:", err);
  process.exit(1);
});
