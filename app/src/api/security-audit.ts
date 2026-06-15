import { createHash, randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { safeSerialize } from "../../../security/compliance-scaffold";
import {
  SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
  SECURITY_AUDIT_REQUIRED_ACTIONS,
  type AuditedSecurityDecision,
  type DurableSecurityAuditDecisionWriter,
  type ImmutableAuditLogRecord,
  type SecurityAuditDecisionAction,
  type SecurityAuditDecisionAppendInput,
} from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";

// Keep this aligned with the API server's strict ISO-8601 date-time gate for params.as_of.
const ISO_8601_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export class PgSecurityAuditAppendRequiredError extends Error {
  constructor(
    readonly action: SecurityAuditDecisionAction,
    cause: unknown,
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`security audit append failed closed for ${action}: ${message}`);
    this.name = "PgSecurityAuditAppendRequiredError";
  }
}

export class PgDurableSecurityAuditDecisionWriter implements DurableSecurityAuditDecisionWriter {
  constructor(private readonly pool: Pool) {}

  async recordDecision<TDecision>(
    input: SecurityAuditDecisionAppendInput,
    decision: TDecision,
  ): Promise<AuditedSecurityDecision<TDecision>> {
    try {
      assertAuditInput(input);
      const payloadJson = safeSerialize(input.payload ?? null);
      const auditRecord = await withTenantTx(this.pool, input.tenantId, async (client) => {
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
          throw new Error(`invalid next audit sequence for tenant ${input.tenantId}`);
        }
        const previousHash = previousRow?.hash ?? "GENESIS";
        const hash = hashAuditRecord(input, sequence, previousHash, payloadJson);
        await client.query(
          `INSERT INTO audit_log
             (id, tenant_id, sequence_no, actor, action, outcome, reason,
              correlation_id, idempotency_key, occurred_at, payload_schema_ref,
              payload, retention_until, previous_hash, hash)
           VALUES
             ($1::uuid, $2::uuid, $3::bigint, $4::jsonb, $5, $6, $7,
              $8::uuid, $9, $10::timestamptz, $11, $12::jsonb,
              $13::timestamptz, $14, $15)`,
          [
            randomUUID(),
            input.tenantId,
            sequence,
            JSON.stringify(input.actor),
            input.action,
            input.outcome,
            input.reason,
            input.correlationId,
            input.idempotencyKey,
            input.occurredAt,
            input.payloadSchemaRef,
            payloadJson,
            input.retentionUntil,
            previousRow?.hash ?? null,
            hash,
          ],
        );
        return {
          ...input,
          sequence,
          previousHash,
          hash,
        } satisfies ImmutableAuditLogRecord;
      });
      return { decision, auditRecord };
    } catch (error) {
      throw new PgSecurityAuditAppendRequiredError(input.action, error);
    }
  }
}

function assertAuditInput(input: SecurityAuditDecisionAppendInput): void {
  if (input.failClosed !== true) {
    throw new Error("security audit writer must be fail-closed");
  }
  if (input.payloadSchemaRef !== SECURITY_AUDIT_PAYLOAD_SCHEMA_REF) {
    throw new Error("security audit payload_schema_ref is not the v1 boundary schema");
  }
  if (!SECURITY_AUDIT_REQUIRED_ACTIONS.includes(input.action)) {
    throw new Error(`security audit action is not in the required boundary allowlist: ${input.action}`);
  }
  if (!isStrictIsoDateTime(input.occurredAt)) {
    throw new Error("security audit occurredAt must be an ISO timestamp");
  }
  if (!isStrictIsoDateTime(input.retentionUntil)) {
    throw new Error("security audit retentionUntil must be an ISO timestamp");
  }
}

function isStrictIsoDateTime(value: string): boolean {
  const match = ISO_8601_RE.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offsetText !== "Z") {
    const offsetHour = Number(offsetText.slice(1, 3));
    const offsetMinute = Number(offsetText.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return day >= 1 && day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function hashAuditRecord(
  input: SecurityAuditDecisionAppendInput,
  sequence: number,
  previousHash: string,
  payloadJson: string,
): string {
  const canonical = canonicalize({
    tenantId: input.tenantId,
    sequence,
    actor: input.actor,
    action: input.action,
    outcome: input.outcome,
    resource: input.resource,
    reason: input.reason,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt,
    retentionUntil: input.retentionUntil,
    payloadSchemaRef: input.payloadSchemaRef,
    payload: JSON.parse(payloadJson),
    previousHash,
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
