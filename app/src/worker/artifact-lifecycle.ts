// artifact 라이프사이클(redaction/retention) 헬퍼·타입·audit hash-chain — 런타임-worker에서 분리, 로직 무변경.
import { createHash, randomUUID } from "node:crypto";

import type pg from "pg";

import {
  SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
  checkBypassRlsUse,
  safeSerialize,
} from "../../../security/compliance-scaffold";
import type { ArtifactRef, ObjectRef, SecretRef } from "../../../ts/core-types";
import {
  ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
  ARTIFACT_OBJECT_IO_LOCAL_TEST_SCHEMA_REF,
} from "../../../ts/runtime-contract";
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
} from "../../../ts/runtime-contract";
import type { CorrelationId, RunId, StepId, TenantId } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { isRecord, stringField } from "./worker-util";

export type ArtifactLifecycleRow = {
  id: string;
  tenant_id: string;
  run_id: string | null;
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
export type LifecycleAuditAppendInput = {
  readonly tenantId: string;
  readonly correlationId: string;
  readonly workerId: string;
  readonly useCase: ArtifactLifecycleOperationalUseCase;
  readonly jobKind: "artifact_redaction" | "artifact_retention";
  readonly reasonCode: string;
  readonly artifact: ArtifactLifecycleTarget;
  readonly jobId: string;
  readonly retentionDays: number;
  readonly portBinding?: ArtifactObjectIoPortBinding;
  readonly objectIoEvidence?: ArtifactObjectIoEvidence;
};

export function artifactTargetFromRow(row: ArtifactLifecycleRow): ArtifactLifecycleTarget {
  return {
    tenantId: row.tenant_id as TenantId,
    artifactRef: row.id as ArtifactRef,
    objectRef: row.object_ref as ObjectRef,
    ...(row.run_id === null ? {} : { runId: row.run_id as RunId }),
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
    if (
      backendAlias === null ||
      credentialRef === null ||
      value.evidenceSchemaRef !== ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF
    ) {
      throw new Error(`RuntimeWorker: ${jobKind} real object-store port binding requires backendAlias, SecretRef, and artifact/object-io-evidence@1`);
    }
    return {
      kind,
      backendAlias,
      credentialRef: credentialRef as SecretRef,
      evidenceSchemaRef: ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
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

export function validateArtifactObjectIoEvidence(
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
      evidence.mayBeUsedAsStagingEvidence !== true
    ) {
      throw new Error("RuntimeWorker: real object-store evidence must match the SecretRef-backed port binding");
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

export async function assertLifecycleBypassUse(
  client: pg.PoolClient,
  useCase: ArtifactLifecycleOperationalUseCase,
  reasonCode: string,
): Promise<void> {
  const policyDecision = checkBypassRlsUse({
    useCase,
    applicationRole: false,
    servesUserTraffic: false,
    reasonCode,
    immutableAuditAppendConfigured: true,
  });
  if (policyDecision.kind === "deny") {
    throw new Error(`RuntimeWorker: ${useCase} BYPASSRLS denied: ${policyDecision.reasons.join("; ")}`);
  }

  const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT rolsuper, rolbypassrls
       FROM pg_roles
      WHERE rolname = current_user`,
  );
  const row = role.rows[0];
  if (row?.rolsuper === true || row?.rolbypassrls !== true) {
    throw new Error(`RuntimeWorker: ${useCase} requires a non-SUPERUSER dedicated BYPASSRLS operational role`);
  }
}

export async function appendLifecycleAudit(pool: pg.Pool, input: LifecycleAuditAppendInput): Promise<void> {
  await withTenantTx(pool, input.tenantId, (client) => appendLifecycleAuditWithClient(client, input));
}

export async function appendLifecycleAuditWithClient(client: pg.PoolClient, input: LifecycleAuditAppendInput): Promise<void> {
  const occurredAt = new Date();
  const occurredAtIso = occurredAt.toISOString();
  const retentionUntilIso = new Date(
    occurredAt.getTime() + input.retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const actor = {
    kind: "system",
    id: "runtime-worker",
    worker_id: input.workerId,
  };
  const payload = {
    decision_kind: "artifact_lifecycle.bypassrls_use",
    use_case: input.useCase,
    job_kind: input.jobKind,
    reason_code: input.reasonCode,
    artifact_ref: input.artifact.artifactRef,
    run_id: input.artifact.runId,
    step_id: input.artifact.stepId,
    attempt: input.artifact.attempt,
    redaction_status: input.artifact.redactionStatus,
    retention_until: input.artifact.retentionUntil,
    legal_hold: input.artifact.legalHold,
    quarantine: input.artifact.quarantine,
    deleted_at_present: input.artifact.deletedAt !== undefined,
    object_ref_internal_only: true,
    fail_closed: true,
    object_io_port_kind: input.portBinding?.kind,
    object_io_backend_alias: input.portBinding?.backendAlias,
    object_io_credential_ref:
      input.portBinding?.kind === "real_object_store" ? input.portBinding.credentialRef : undefined,
    object_io_evidence_schema_ref: input.objectIoEvidence?.schemaRef,
    object_io_operation: input.objectIoEvidence?.operation,
    object_io_receipt_id: input.objectIoEvidence?.receiptId,
    object_io_sha256_present: input.objectIoEvidence?.sha256 !== undefined,
    object_io_may_be_used_as_staging_evidence:
      input.objectIoEvidence?.mayBeUsedAsStagingEvidence ??
      (input.portBinding?.kind === "test_fake" ? false : undefined),
  };
  const payloadJson = safeSerialize(payload);
  const idempotencyKey = `${input.useCase}:${input.artifact.artifactRef}:${input.jobId}`;

  const previous = await client.query<{ sequence_no: string; hash: string }>(
    `SELECT sequence_no, hash
         FROM audit_log
        WHERE tenant_id = $1::uuid
        ORDER BY sequence_no DESC
        LIMIT 1
        FOR UPDATE`,
    [input.tenantId],
  );
  const previousRow = previous.rows[0];
  const sequence = previousRow === undefined ? 1 : Number(previousRow.sequence_no) + 1;
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(`RuntimeWorker: invalid lifecycle audit sequence for tenant ${input.tenantId}`);
  }
  const previousHash = previousRow?.hash ?? "GENESIS";
  const hash = hashLifecycleAuditRecord({
    tenantId: input.tenantId,
    sequence,
    actor,
    reason: input.reasonCode,
    correlationId: input.correlationId,
    idempotencyKey,
    occurredAt: occurredAtIso,
    retentionUntil: retentionUntilIso,
    payloadJson,
    previousHash,
  });

  await client.query(
    `INSERT INTO audit_log
         (id, tenant_id, sequence_no, actor, action, outcome, reason,
          correlation_id, idempotency_key, occurred_at, payload_schema_ref,
          payload, retention_until, previous_hash, hash)
       VALUES
         ($1::uuid, $2::uuid, $3::bigint, $4::jsonb, 'bypassrls.use', 'allow', $5,
          $6::uuid, $7, $8::timestamptz, $9, $10::jsonb,
          $11::timestamptz, $12, $13)`,
    [
      randomUUID(),
      input.tenantId,
      sequence,
      JSON.stringify(actor),
      input.reasonCode,
      input.correlationId,
      idempotencyKey,
      occurredAtIso,
      SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
      payloadJson,
      retentionUntilIso,
      previousRow?.hash ?? null,
      hash,
    ],
  );
}

function hashLifecycleAuditRecord(input: {
  tenantId: string;
  sequence: number;
  actor: Readonly<Record<string, string>>;
  reason: string;
  correlationId: string;
  idempotencyKey: string;
  occurredAt: string;
  retentionUntil: string;
  payloadJson: string;
  previousHash: string;
}): string {
  const canonical = canonicalize({
    tenantId: input.tenantId,
    sequence: input.sequence,
    actor: input.actor,
    action: "bypassrls.use",
    outcome: "allow",
    reason: input.reason,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt,
    retentionUntil: input.retentionUntil,
    payloadSchemaRef: SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
    payload: JSON.parse(input.payloadJson) as unknown,
    previousHash: input.previousHash,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  const entries = Object.entries(value as Readonly<Record<string, unknown>>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`).join(",")}}`;
}
