import type { PoolClient } from "pg";

import { ApiResponseError } from "./errors";

export type ScenarioCertificationStatus = "uncertified" | "certified" | "revoked";
export type ScenarioGovernanceStage = "dev" | "review" | "pilot" | "certified" | "deprecated";

export interface ScenarioCertificationRow {
  certification_status: ScenarioCertificationStatus;
  certified_by: string | null;
  certified_at: Date | string | null;
  certification_expires_at: Date | string | null;
  certification_reason: string | null;
  certification_revoked_by: string | null;
  certification_revoked_at: Date | string | null;
  certification_revoke_reason: string | null;
  governance_stage: ScenarioGovernanceStage;
  governance_reason: string | null;
  governance_evidence_ref: string | null;
  governance_metadata: unknown;
  governance_updated_by: string | null;
  governance_updated_at: Date | string | null;
}

export interface ScenarioCertificationSnapshot {
  readonly status: ScenarioCertificationStatus;
  readonly certified_by: string | null;
  readonly certified_at: string | null;
  readonly expires_at: string | null;
  readonly reason: string | null;
  readonly revoked_by: string | null;
  readonly revoked_at: string | null;
  readonly revoke_reason: string | null;
  readonly valid_for_prod: boolean;
  readonly governance_stage: ScenarioGovernanceStage;
  readonly governance_reason: string | null;
  readonly governance_evidence_ref: string | null;
  readonly governance_metadata: Readonly<Record<string, unknown>>;
  readonly governance_updated_by: string | null;
  readonly governance_updated_at: string | null;
}

export function mapScenarioCertification(row: ScenarioCertificationRow, now = new Date()): ScenarioCertificationSnapshot {
  const expiresAt = toIso(row.certification_expires_at);
  return {
    status: row.certification_status,
    certified_by: row.certified_by,
    certified_at: toIso(row.certified_at),
    expires_at: expiresAt,
    reason: row.certification_reason,
    revoked_by: row.certification_revoked_by,
    revoked_at: toIso(row.certification_revoked_at),
    revoke_reason: row.certification_revoke_reason,
    valid_for_prod: row.certification_status === "certified" && (expiresAt === null || Date.parse(expiresAt) > now.getTime()),
    governance_stage: row.governance_stage,
    governance_reason: row.governance_reason,
    governance_evidence_ref: row.governance_evidence_ref,
    governance_metadata: isRecord(row.governance_metadata) ? row.governance_metadata : {},
    governance_updated_by: row.governance_updated_by,
    governance_updated_at: toIso(row.governance_updated_at),
  };
}

export async function assertScenarioVersionCertifiedForProd(
  client: PoolClient,
  tenantId: string,
  scenarioId: string,
  versionId: string,
): Promise<ScenarioCertificationSnapshot> {
  const result = await client.query<ScenarioCertificationRow & { version: number }>(
    `SELECT version, certification_status, certified_by, certified_at, certification_expires_at,
            certification_reason, certification_revoked_by, certification_revoked_at, certification_revoke_reason,
            governance_stage, governance_reason, governance_evidence_ref, governance_metadata,
            governance_updated_by, governance_updated_at
       FROM scenario_versions
      WHERE tenant_id=$1::uuid AND scenario_id=$2::uuid AND id=$3::uuid`,
    [tenantId, scenarioId, versionId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  const certification = mapScenarioCertification(row);
  if (certification.status !== "certified") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "certification_required_for_prod",
      certification_status: certification.status,
      source_version: row.version,
    });
  }
  if (!certification.valid_for_prod) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "certification_expired_for_prod",
      certification_status: certification.status,
      certification_expires_at: certification.expires_at,
      source_version: row.version,
    });
  }
  return certification;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
