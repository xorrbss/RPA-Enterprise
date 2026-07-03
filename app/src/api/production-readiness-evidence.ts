import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { isRecord } from "./command";

export type ProductionReadinessEvidenceType =
  | "external_alert_delivery"
  | "managed_backup_restore_drill"
  | "slo_oncall_signoff"
  | "observability_telemetry_wiring"
  | "support_training_completion";
export type ProductionReadinessEvidenceStatus = "valid" | "failed";

export interface ProductionReadinessEvidence {
  readonly evidence_id: string;
  readonly evidence_type: ProductionReadinessEvidenceType;
  readonly status: ProductionReadinessEvidenceStatus;
  readonly evidence_at: string;
  readonly expires_at: string | null;
  readonly summary: string;
  readonly evidence_ref: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly recorded_by: string;
  readonly recorded_at: string;
  readonly legal_hold: boolean;
}

interface ProductionReadinessEvidenceRow {
  readonly id: string;
  readonly evidence_type: ProductionReadinessEvidenceType;
  readonly status: ProductionReadinessEvidenceStatus;
  readonly evidence_at: Date;
  readonly expires_at: Date | null;
  readonly summary: string;
  readonly evidence_ref: string | null;
  readonly metadata: unknown;
  readonly recorded_by: string;
  readonly recorded_at: Date;
  readonly legal_hold: boolean;
}

export interface ProductionReadinessEvidenceInput {
  readonly evidenceType: ProductionReadinessEvidenceType;
  readonly status: ProductionReadinessEvidenceStatus;
  readonly evidenceAt: Date;
  readonly expiresAt: Date | null;
  readonly summary: string;
  readonly evidenceRef: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly legalHold: boolean;
}

const OWNER_EVIDENCE_TYPES: readonly ProductionReadinessEvidenceType[] = [
  "external_alert_delivery",
  "managed_backup_restore_drill",
  "slo_oncall_signoff",
  "observability_telemetry_wiring",
  "support_training_completion",
];
const OWNER_EVIDENCE_RETENTION_DAYS = 365;

export async function readLatestOwnerEvidence(
  client: PoolClient,
  tenantId: string,
): Promise<Record<ProductionReadinessEvidenceType, ProductionReadinessEvidence | null>> {
  const rows = await client.query<ProductionReadinessEvidenceRow>(
    `WITH ranked AS (
       SELECT id::text, evidence_type, status, evidence_at, expires_at, summary, evidence_ref,
              metadata, recorded_by, recorded_at, legal_hold,
              row_number() OVER (
                PARTITION BY evidence_type
                ORDER BY evidence_at DESC, recorded_at DESC, id DESC
              ) AS rn
         FROM production_readiness_evidence
        WHERE tenant_id = $1::uuid
          AND deleted_at IS NULL
          AND evidence_type = ANY($2::text[])
     )
     SELECT id, evidence_type, status, evidence_at, expires_at, summary, evidence_ref,
            metadata, recorded_by, recorded_at, legal_hold
       FROM ranked
      WHERE rn = 1`,
    [tenantId, [...OWNER_EVIDENCE_TYPES]],
  );
  const out: Record<ProductionReadinessEvidenceType, ProductionReadinessEvidence | null> = {
    external_alert_delivery: null,
    managed_backup_restore_drill: null,
    slo_oncall_signoff: null,
    observability_telemetry_wiring: null,
    support_training_completion: null,
  };
  for (const row of rows.rows) {
    out[row.evidence_type] = mapEvidence(row);
  }
  return out;
}

export async function readProductionReadinessEvidence(
  client: PoolClient,
  tenantId: string,
  evidenceType: ProductionReadinessEvidenceType | undefined,
  limit: number,
): Promise<ProductionReadinessEvidence[]> {
  const result = await client.query<ProductionReadinessEvidenceRow>(
    `SELECT id::text, evidence_type, status, evidence_at, expires_at, summary, evidence_ref,
            metadata, recorded_by, recorded_at, legal_hold
       FROM production_readiness_evidence
      WHERE tenant_id = $1::uuid
        AND deleted_at IS NULL
        AND ($2::text IS NULL OR evidence_type = $2::text)
      ORDER BY evidence_at DESC, recorded_at DESC, id DESC
      LIMIT $3`,
    [tenantId, evidenceType ?? null, limit],
  );
  return result.rows.map(mapEvidence);
}

export async function insertProductionReadinessEvidence(
  client: PoolClient,
  tenantId: string,
  recordedBy: string,
  input: ProductionReadinessEvidenceInput,
): Promise<ProductionReadinessEvidence> {
  const retentionUntil = new Date(Date.now() + OWNER_EVIDENCE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result = await client.query<ProductionReadinessEvidenceRow>(
    `INSERT INTO production_readiness_evidence (
       id, tenant_id, evidence_type, status, evidence_at, expires_at, summary,
       evidence_ref, metadata, recorded_by, retention_until, legal_hold
     )
     VALUES ($1::uuid,$2::uuid,$3,$4,$5::timestamptz,$6::timestamptz,$7,$8,$9::jsonb,$10,$11::timestamptz,$12)
     RETURNING id::text, evidence_type, status, evidence_at, expires_at, summary, evidence_ref,
               metadata, recorded_by, recorded_at, legal_hold`,
    [
      randomUUID(),
      tenantId,
      input.evidenceType,
      input.status,
      input.evidenceAt.toISOString(),
      input.expiresAt?.toISOString() ?? null,
      input.summary,
      input.evidenceRef,
      JSON.stringify(input.metadata),
      recordedBy,
      retentionUntil.toISOString(),
      input.legalHold,
    ],
  );
  return mapEvidence(result.rows[0]);
}

function mapEvidence(row: ProductionReadinessEvidenceRow): ProductionReadinessEvidence {
  return {
    evidence_id: row.id,
    evidence_type: row.evidence_type,
    status: row.status,
    evidence_at: row.evidence_at.toISOString(),
    expires_at: row.expires_at?.toISOString() ?? null,
    summary: row.summary,
    evidence_ref: row.evidence_ref,
    metadata: isRecord(row.metadata) ? row.metadata : {},
    recorded_by: row.recorded_by,
    recorded_at: row.recorded_at.toISOString(),
    legal_hold: row.legal_hold,
  };
}
