/**
 * audit_log 변조-증거 해시체인 — 공유 canonical/hash + 체인 검증자 (적대감사 #C1/#C2).
 *
 * 두 writer(security-audit·lifecycle)가 **동일한 영속 컬럼 집합**으로 hash 를 계산하도록 단일 computeAuditHash 를 공유한다.
 * (기존: 두 canonical 이 분기 + security-audit 만 비영속 `resource` 를 해싱해 저장 데이터로 재계산 불가 → tamper-evidence
 * 무력화.) 이제 hash 는 audit_log 의 영속 컬럼만으로 재현 가능하므로 verifyAuditChain 이 저장 행에서 재계산·연속성 검증한다.
 * timestamptz 왕복(Date↔ISO) 비결정성은 new Date(x).toISOString() 정규화로 제거한다.
 */
import { createHash } from "node:crypto";

import { withTenantTx, type PgPool } from "../db/pool";

/** hash canonical 입력 — audit_log 영속 컬럼만(id/created_at/legal_hold/deleted_at 은 hash 외 가변 메타). */
export interface AuditHashInput {
  readonly tenantId: string;
  readonly sequenceNo: number;
  readonly actor: unknown;
  readonly action: string;
  readonly outcome: string;
  readonly reason: string | null;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string | Date;
  readonly retentionUntil: string | Date | null;
  readonly payloadSchemaRef: string;
  readonly payload: unknown;
  readonly previousHash: string;
}

function normalizeTs(value: string | Date | null): string | null {
  if (value === null) return null;
  return new Date(value).toISOString();
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  const entries = Object.entries(value as Readonly<Record<string, unknown>>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`).join(",")}}`;
}

/** 영속 컬럼으로 audit_log 행 hash 계산(write·verify 공유). 반환=`sha256:<hex>`. */
export function computeAuditHash(input: AuditHashInput): string {
  const canonical = canonicalize({
    tenantId: input.tenantId,
    sequence: input.sequenceNo,
    actor: input.actor,
    action: input.action,
    outcome: input.outcome,
    reason: input.reason,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    occurredAt: normalizeTs(input.occurredAt),
    retentionUntil: normalizeTs(input.retentionUntil),
    payloadSchemaRef: input.payloadSchemaRef,
    payload: input.payload,
    previousHash: input.previousHash,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export interface AuditChainViolation {
  readonly sequenceNo: number;
  readonly id: string;
  readonly kind: "hash_mismatch" | "broken_link" | "sequence_gap" | "genesis_invalid";
  readonly detail: string;
}

export interface AuditChainVerification {
  readonly tenantId: string;
  readonly rowsChecked: number;
  readonly valid: boolean;
  readonly violations: readonly AuditChainViolation[];
}

interface AuditChainRow {
  id: string;
  sequence_no: string;
  actor: unknown;
  action: string;
  outcome: string;
  reason: string | null;
  correlation_id: string;
  idempotency_key: string;
  occurred_at: Date;
  retention_until: Date | null;
  payload_schema_ref: string;
  payload: unknown;
  previous_hash: string | null;
  hash: string;
}

/**
 * 테넌트 감사체인 검증 — 저장 행에서 hash 재계산·연속성 확인(조용한 변조 탐지). DB 트리거(prevent_audit_log_mutation)가
 * 예방(UPDATE/DELETE 차단)이라면 이것은 탐지(트리거 우회한 superuser/BYPASSRLS·외부 WORM 미러 검증). RLS 경유.
 */
export async function verifyAuditChain(pool: PgPool, tenantId: string): Promise<AuditChainVerification> {
  const rows = await withTenantTx(pool, tenantId, async (client) => {
    const r = await client.query<AuditChainRow>(
      `SELECT id::text AS id, sequence_no, actor, action, outcome, reason, correlation_id,
              idempotency_key, occurred_at, retention_until, payload_schema_ref, payload,
              previous_hash, hash
         FROM audit_log
        WHERE tenant_id = $1::uuid AND deleted_at IS NULL
        ORDER BY sequence_no ASC`,
      [tenantId],
    );
    return r.rows;
  });

  const violations: AuditChainViolation[] = [];
  let expectedSeq = 1;
  let priorHash = "GENESIS";
  for (const row of rows) {
    const seq = Number(row.sequence_no);
    if (seq !== expectedSeq) {
      violations.push({ sequenceNo: seq, id: row.id, kind: "sequence_gap", detail: `expected sequence ${expectedSeq}, found ${seq}` });
    }
    const expectedPrev = expectedSeq === 1 ? null : priorHash;
    if (expectedSeq === 1 && row.previous_hash !== null) {
      violations.push({ sequenceNo: seq, id: row.id, kind: "genesis_invalid", detail: "genesis row must have NULL previous_hash" });
    }
    if (expectedSeq !== 1 && row.previous_hash !== expectedPrev) {
      violations.push({ sequenceNo: seq, id: row.id, kind: "broken_link", detail: `previous_hash does not link prior row hash` });
    }
    const recomputed = computeAuditHash({
      tenantId,
      sequenceNo: seq,
      actor: row.actor,
      action: row.action,
      outcome: row.outcome,
      reason: row.reason,
      correlationId: row.correlation_id,
      idempotencyKey: row.idempotency_key,
      occurredAt: row.occurred_at,
      retentionUntil: row.retention_until,
      payloadSchemaRef: row.payload_schema_ref,
      payload: row.payload,
      // 체인 hash 는 저장된 previous_hash(없으면 GENESIS)를 입력으로 계산됐다.
      previousHash: row.previous_hash ?? "GENESIS",
    });
    if (recomputed !== row.hash) {
      violations.push({ sequenceNo: seq, id: row.id, kind: "hash_mismatch", detail: "recomputed hash does not match stored hash" });
    }
    priorHash = row.hash;
    expectedSeq += 1;
  }

  return { tenantId, rowsChecked: rows.length, valid: violations.length === 0, violations };
}
