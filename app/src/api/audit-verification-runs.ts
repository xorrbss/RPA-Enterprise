import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { AuditChainVerification } from "./audit-record-hash";

export type AuditVerificationRunStatus = "valid" | "invalid" | "failed";
export type AuditVerificationTriggerKind = "manual_api" | "maintenance";

export interface AuditVerifierRunRow {
  id: string;
  status: AuditVerificationRunStatus;
  rows_checked: string;
  violation_count: number;
  violations: unknown;
  checked_from_sequence: string | null;
  checked_to_sequence: string | null;
  started_at: Date;
  completed_at: Date;
  correlation_id: string;
  triggered_by: unknown;
  trigger_kind: AuditVerificationTriggerKind;
  retention_until: Date;
  legal_hold: boolean;
  created_at?: Date;
  cursor_at: string;
}

interface ActorSummary {
  subject_id: string | null;
  roles: readonly string[];
}

export const VERIFIER_RETENTION_DAYS = 90;

export async function insertAuditVerificationRun(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly result?: AuditChainVerification;
    readonly status?: AuditVerificationRunStatus;
    readonly startedAt: Date;
    readonly completedAt: Date;
    readonly correlationId: string;
    readonly triggeredBy: unknown;
    readonly triggerKind: AuditVerificationTriggerKind;
    readonly legalHold: boolean;
  },
): Promise<AuditVerifierRunRow> {
  const status: AuditVerificationRunStatus = input.status ?? (input.result?.valid === true ? "valid" : "invalid");
  if (status !== "failed" && input.result === undefined) {
    throw new Error(`audit verification run status ${status} requires a verification result`);
  }
  const retentionUntil = new Date(input.completedAt.getTime() + VERIFIER_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const violations = input.result?.violations ?? [];
  const result = await client.query<AuditVerifierRunRow>(
    `INSERT INTO audit_verifier_runs (
       id, tenant_id, status, rows_checked, violation_count, violations,
       checked_from_sequence, checked_to_sequence, started_at, completed_at,
       correlation_id, triggered_by, trigger_kind, retention_until, legal_hold
     )
     VALUES (
       $1::uuid, $2::uuid, $3, $4::bigint, $5::int, $6::jsonb,
       $7::bigint, $8::bigint, $9::timestamptz, $10::timestamptz,
       $11::uuid, $12::jsonb, $13, $14::timestamptz, $15::boolean
     )
     RETURNING id, status, rows_checked::text, violation_count, violations,
               checked_from_sequence::text, checked_to_sequence::text,
               started_at, completed_at, correlation_id, triggered_by, trigger_kind,
               retention_until, legal_hold, completed_at::text AS cursor_at`,
    [
      randomUUID(),
      input.tenantId,
      status,
      input.result?.rowsChecked ?? 0,
      violations.length,
      JSON.stringify(violations),
      input.result?.checkedFromSequence ?? null,
      input.result?.checkedToSequence ?? null,
      input.startedAt.toISOString(),
      input.completedAt.toISOString(),
      input.correlationId,
      JSON.stringify(input.triggeredBy),
      input.triggerKind,
      retentionUntil.toISOString(),
      input.legalHold,
    ],
  );
  return result.rows[0]!;
}

function mapActor(raw: unknown): ActorSummary {
  if (typeof raw !== "object" || raw === null) return { subject_id: null, roles: [] };
  const actor = raw as { subjectId?: unknown; roles?: unknown };
  return {
    subject_id: typeof actor.subjectId === "string" ? actor.subjectId : null,
    roles: Array.isArray(actor.roles) ? actor.roles.filter((role): role is string => typeof role === "string") : [],
  };
}

export function mapAuditVerificationRunRow(row: AuditVerifierRunRow): Record<string, unknown> {
  return {
    verification_run_id: row.id,
    status: row.status,
    rows_checked: Number(row.rows_checked),
    violation_count: row.violation_count,
    violations: Array.isArray(row.violations) ? row.violations : [],
    checked_from_sequence: row.checked_from_sequence === null ? null : Number(row.checked_from_sequence),
    checked_to_sequence: row.checked_to_sequence === null ? null : Number(row.checked_to_sequence),
    started_at: row.started_at.toISOString(),
    completed_at: row.completed_at.toISOString(),
    correlation_id: row.correlation_id,
    triggered_by: mapActor(row.triggered_by),
    trigger_kind: row.trigger_kind,
    retention_until: row.retention_until.toISOString(),
    legal_hold: row.legal_hold,
  };
}
