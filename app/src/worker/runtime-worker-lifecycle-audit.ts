// runtime-worker.ts 에서 추출 — artifact-lifecycle BYPASSRLS 운영감사 + 해시체인 append-only 기록(동작 무변경).
// 매핑·검증(순수)은 runtime-worker-artifact-lifecycle.ts. 본 모듈은 async DB(client.query) + append-only 감사 해시체인(createHash).
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
  checkBypassRlsUse,
  safeSerialize,
} from "../../../security/compliance-scaffold";
import type {
  ArtifactLifecycleOperationalUseCase,
  ArtifactLifecycleTarget,
  ArtifactObjectIoEvidence,
  ArtifactObjectIoPortBinding,
} from "../../../ts/runtime-contract";

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

  // 동일 테넌트 audit 체인 선형화 — 동시 append 직렬화(tx advisory lock; FOR UPDATE LIMIT1 만으론 sequence 경합).
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text))", [input.tenantId]);
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
