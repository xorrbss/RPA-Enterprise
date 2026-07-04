import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { isRecord, type CommandResponse } from "./command";
import { ApiResponseError } from "../runtime/errors";

export type AiRuntimePolicyMode = "observe" | "warn" | "block";

export interface AiRuntimePolicyRow {
  readonly id: string;
  readonly mode: AiRuntimePolicyMode;
  readonly subject_mapping_ref: string;
  readonly grace_until: Date | null;
  readonly emergency_override_owner_ref: string;
  readonly audit_action: "ai_governance.enforce";
  readonly policy_decision_ref: string;
  readonly evidence_ref: string | null;
  readonly updated_by: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface AiRuntimePolicyInput {
  readonly mode: AiRuntimePolicyMode;
  readonly subjectMappingRef: string;
  readonly graceUntil: Date | null;
  readonly emergencyOverrideOwnerRef: string;
  readonly policyDecisionRef: string;
  readonly evidenceRef: string | null;
}

export const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/@# -]*$/;
export const SECRET_OR_RAW_RE = /(https?:\/\/|hooks\.slack\.com|\bbearer\s+[a-z0-9._~+/=-]{8,}|\b(api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|credential|authorization)\s*[:=]\s*\S{4,}|\b(token|password|secret)=)/i;
const ISO_8601_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export function parseAiRuntimePolicyRequest(raw: unknown): AiRuntimePolicyInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ai_runtime_policy_body_expected_object" });
  const allowed = new Set([
    "mode",
    "subject_mapping_ref",
    "grace_until",
    "emergency_override_owner_ref",
    "policy_decision_ref",
    "evidence_ref",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ai_runtime_policy_unknown_field", field: key });
  }
  const mode = parsePolicyMode(raw.mode);
  const graceUntil = raw.grace_until === undefined || raw.grace_until === null || raw.grace_until === ""
    ? null
    : parseFutureIsoDate(raw.grace_until, "grace_until");
  return {
    mode,
    subjectMappingRef: parseSafePolicyRef(raw.subject_mapping_ref, "subject_mapping_ref", 300),
    graceUntil,
    emergencyOverrideOwnerRef: parseSafePolicyRef(raw.emergency_override_owner_ref, "emergency_override_owner_ref", 300),
    policyDecisionRef: parseSafePolicyRef(raw.policy_decision_ref, "policy_decision_ref", 300),
    evidenceRef: raw.evidence_ref === undefined || raw.evidence_ref === null || raw.evidence_ref === ""
      ? null
      : parseSafePolicyRef(raw.evidence_ref, "evidence_ref", 500),
  };
}

export async function readAiRuntimePolicy(client: PoolClient, tenantId: string): Promise<Record<string, unknown> | null> {
  const row = await readAiRuntimePolicyRow(client, tenantId);
  return row === null ? null : mapAiRuntimePolicy(row);
}

export async function upsertAiRuntimePolicy(
  client: PoolClient,
  tenantId: string,
  updatedBy: string,
  input: AiRuntimePolicyInput,
): Promise<CommandResponse> {
  const existing = await readAiRuntimePolicyRow(client, tenantId);
  const values = [
    input.mode,
    input.subjectMappingRef,
    input.graceUntil?.toISOString() ?? null,
    input.emergencyOverrideOwnerRef,
    input.policyDecisionRef,
    input.evidenceRef,
    updatedBy,
  ];
  if (existing === null) {
    const result = await client.query<AiRuntimePolicyRow>(
      `INSERT INTO ai_runtime_policies (
         id, tenant_id, mode, subject_mapping_ref, grace_until,
         emergency_override_owner_ref, policy_decision_ref, evidence_ref, updated_by
       )
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz, $6, $7, $8, $9)
       RETURNING id::text, mode, subject_mapping_ref, grace_until,
                 emergency_override_owner_ref, audit_action, policy_decision_ref,
                 evidence_ref, updated_by, created_at, updated_at`,
      [randomUUID(), tenantId, ...values],
    );
    return { status: 201, body: mapAiRuntimePolicy(result.rows[0]) };
  }

  const result = await client.query<AiRuntimePolicyRow>(
    `UPDATE ai_runtime_policies
        SET mode = $2,
            subject_mapping_ref = $3,
            grace_until = $4::timestamptz,
            emergency_override_owner_ref = $5,
            policy_decision_ref = $6,
            evidence_ref = $7,
            updated_by = $8,
            updated_at = now()
      WHERE tenant_id = $1::uuid
        AND id = $9::uuid
        AND deleted_at IS NULL
      RETURNING id::text, mode, subject_mapping_ref, grace_until,
                emergency_override_owner_ref, audit_action, policy_decision_ref,
                evidence_ref, updated_by, created_at, updated_at`,
    [tenantId, ...values, existing.id],
  );
  return { status: 200, body: mapAiRuntimePolicy(result.rows[0]) };
}

function mapAiRuntimePolicy(row: AiRuntimePolicyRow): Record<string, unknown> {
  return {
    policy_id: row.id,
    mode: row.mode,
    subject_mapping_ref: row.subject_mapping_ref,
    grace_until: row.grace_until?.toISOString() ?? null,
    emergency_override_owner_ref: row.emergency_override_owner_ref,
    audit_action: row.audit_action,
    policy_decision_ref: row.policy_decision_ref,
    evidence_ref: row.evidence_ref,
    updated_by: row.updated_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export async function readAiRuntimePolicyRow(client: PoolClient, tenantId: string): Promise<AiRuntimePolicyRow | null> {
  const result = await client.query<AiRuntimePolicyRow>(
    `SELECT id::text, mode, subject_mapping_ref, grace_until,
            emergency_override_owner_ref, audit_action, policy_decision_ref,
            evidence_ref, updated_by, created_at, updated_at
       FROM ai_runtime_policies
      WHERE tenant_id = $1::uuid
        AND deleted_at IS NULL
      ORDER BY updated_at DESC, id DESC
      LIMIT 1`,
    [tenantId],
  );
  return result.rows[0] ?? null;
}

export function isGraceActive(policy: Pick<AiRuntimePolicyRow, "grace_until">): boolean {
  return policy.grace_until !== null && policy.grace_until.getTime() > Date.now();
}

function parsePolicyMode(raw: unknown): AiRuntimePolicyMode {
  if (raw === "observe" || raw === "warn" || raw === "block") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_ai_runtime_policy_mode" });
}

function parseFutureIsoDate(raw: unknown, field: string): Date {
  if (typeof raw !== "string" || raw.length === 0) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_iso_datetime", field });
  if (!isStrictIsoDateTime(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_iso_datetime", field });
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_iso_datetime", field });
  if (date.getTime() <= Date.now()) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `${field}_must_be_future`, field });
  return date;
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

function parseSafePolicyRef(raw: unknown, field: string, max: number): string {
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  const value = raw.trim();
  if (value.length === 0 || value.length > max || !SAFE_REF_RE.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  }
  if (SECRET_OR_RAW_RE.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_material_or_raw_endpoint_forbidden", field });
  }
  return value;
}
