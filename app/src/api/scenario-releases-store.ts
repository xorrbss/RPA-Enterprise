import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import { ApiResponseError } from "../runtime/errors";
import { mapScenarioCertification, type ScenarioCertificationRow } from "./scenario-certification";
import type { ApiServerDeps } from "./server-shared";

type ScenarioEnvironment = "dev" | "staging" | "prod";
export type ReleaseTargetEnvironment = Extract<ScenarioEnvironment, "staging" | "prod">;
export type ReleaseStatus = "draft" | "submitted" | "approved" | "rejected" | "deployed" | "rolled_back" | "cancelled";

export interface ReleaseRow extends ScenarioCertificationRow {
  id: string;
  scenario_id: string;
  source_version_id: string;
  source_version: number;
  target_environment: ReleaseTargetEnvironment;
  status: ReleaseStatus;
  package_hash: string;
  validation_report: unknown;
  requested_by: string;
  requested_at: Date;
  submitted_at: Date | null;
  approved_by: string | null;
  approved_at: Date | null;
  rejected_by: string | null;
  rejected_at: Date | null;
  rejection_reason: string | null;
  deployed_by: string | null;
  deployed_at: Date | null;
  rollback_of_release_id: string | null;
  reason: string | null;
  created_at: Date;
  updated_at: Date;
  cursor_at: string;
}

export interface BindingRow {
  id: string;
  scenario_id: string;
  environment: ScenarioEnvironment;
  scenario_version_id: string;
  version: number;
  release_id: string | null;
  activated_by: string;
  activated_at: Date;
}

interface ReleaseEventRow {
  id: string;
  event_type: string;
  actor_sub: string;
  reason: string | null;
  created_at: Date;
}

interface ScenarioVersionRow extends ScenarioCertificationRow {
  scenario_id: string;
  scenario_name: string;
  version_id: string;
  version: number;
  ir: unknown;
}

export async function withScenario<T>(
  deps: ApiServerDeps,
  tenantId: string,
  scenarioId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTenantTx(deps.pool, tenantId, async (client) => {
    const exists = await client.query(
      `SELECT 1 FROM scenarios WHERE tenant_id=$1::uuid AND id=$2::uuid AND archived_at IS NULL`,
      [tenantId, scenarioId],
    );
    if (exists.rowCount === 0) throw new ApiResponseError("RESOURCE_NOT_FOUND");
    return work(client);
  });
}

export async function withRelease<T>(
  deps: ApiServerDeps,
  tenantId: string,
  releaseId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTenantTx(deps.pool, tenantId, async (client) => {
    await loadRelease(client, tenantId, releaseId);
    return work(client);
  });
}

export async function loadScenarioVersion(client: PoolClient, tenantId: string, scenarioId: string, version: number): Promise<ScenarioVersionRow> {
  const result = await client.query<ScenarioVersionRow>(
    `SELECT s.id::text AS scenario_id, s.name AS scenario_name, sv.id::text AS version_id, sv.version, sv.ir,
            sv.certification_status, sv.certified_by, sv.certified_at, sv.certification_expires_at,
            sv.certification_reason, sv.certification_revoked_by, sv.certification_revoked_at,
            sv.certification_revoke_reason, sv.governance_stage, sv.governance_reason,
            sv.governance_evidence_ref, sv.governance_metadata, sv.governance_updated_by,
            sv.governance_updated_at
       FROM scenarios s
       JOIN scenario_versions sv ON sv.tenant_id=s.tenant_id AND sv.scenario_id=s.id
      WHERE s.tenant_id=$1::uuid AND s.id=$2::uuid AND s.archived_at IS NULL AND sv.version=$3`,
    [tenantId, scenarioId, version],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return row;
}

export async function loadScenarioVersionById(client: PoolClient, tenantId: string, scenarioId: string, versionId: string): Promise<ScenarioVersionRow> {
  const result = await client.query<ScenarioVersionRow>(
    `SELECT s.id::text AS scenario_id, s.name AS scenario_name, sv.id::text AS version_id, sv.version, sv.ir,
            sv.certification_status, sv.certified_by, sv.certified_at, sv.certification_expires_at,
            sv.certification_reason, sv.certification_revoked_by, sv.certification_revoked_at,
            sv.certification_revoke_reason, sv.governance_stage, sv.governance_reason,
            sv.governance_evidence_ref, sv.governance_metadata, sv.governance_updated_by,
            sv.governance_updated_at
       FROM scenarios s
       JOIN scenario_versions sv ON sv.tenant_id=s.tenant_id AND sv.scenario_id=s.id
      WHERE s.tenant_id=$1::uuid AND s.id=$2::uuid AND s.archived_at IS NULL AND sv.id=$3::uuid`,
    [tenantId, scenarioId, versionId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return row;
}

export async function assertLatestVersion(client: PoolClient, tenantId: string, scenarioId: string, expectedVersion: number): Promise<void> {
  const result = await client.query<{ version: number }>(
    `SELECT sv.version
       FROM scenarios s
       JOIN scenario_versions sv ON sv.tenant_id=s.tenant_id AND sv.scenario_id=s.id
      WHERE s.tenant_id=$1::uuid AND s.id=$2::uuid AND s.archived_at IS NULL
      ORDER BY sv.version DESC
      LIMIT 1`,
    [tenantId, scenarioId],
  );
  const version = result.rows[0]?.version;
  if (version === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  if (version !== expectedVersion) {
    throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "if_match_mismatch", currentVersion: version });
  }
}

export async function loadRelease(client: PoolClient, tenantId: string, releaseId: string): Promise<ReleaseRow> {
  const result = await client.query<ReleaseRow>(
    `${releaseSelectSql()} WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid`,
    [tenantId, releaseId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return row;
}

export async function releaseDetail(client: PoolClient, tenantId: string, releaseId: string, includeBinding = false): Promise<Record<string, unknown>> {
  const release = await loadRelease(client, tenantId, releaseId);
  const events = await client.query<ReleaseEventRow>(
    `SELECT id::text AS id, event_type, actor_sub, reason, created_at
       FROM scenario_release_events
      WHERE tenant_id=$1::uuid AND release_id=$2::uuid
      ORDER BY created_at ASC, id ASC`,
    [tenantId, releaseId],
  );
  const body: Record<string, unknown> = {
    ...mapRelease(release),
    events: events.rows.map((event) => ({
      event_id: event.id,
      event_type: event.event_type,
      actor_sub: event.actor_sub,
      reason: event.reason,
      created_at: event.created_at.toISOString(),
    })),
  };
  if (includeBinding) {
    const binding = await client.query<BindingRow>(
      `SELECT b.id::text AS id, b.scenario_id::text AS scenario_id, b.environment, b.scenario_version_id::text AS scenario_version_id,
              sv.version, b.release_id::text AS release_id, b.activated_by, b.activated_at
         FROM scenario_environment_bindings b
         JOIN scenario_versions sv ON sv.tenant_id=b.tenant_id AND sv.id=b.scenario_version_id
        WHERE b.tenant_id=$1::uuid AND b.scenario_id=$2::uuid AND b.environment=$3 AND b.deactivated_at IS NULL`,
      [tenantId, release.scenario_id, release.target_environment],
    );
    body.current_binding = binding.rows[0] !== undefined ? mapBinding(binding.rows[0]) : null;
  }
  return body;
}

export function releaseSelectSql(): string {
  return `SELECT r.id::text AS id, r.scenario_id::text AS scenario_id, r.source_version_id::text AS source_version_id,
                 sv.version AS source_version, r.target_environment, r.status, r.package_hash, r.validation_report,
                 sv.certification_status, sv.certified_by, sv.certified_at, sv.certification_expires_at,
                  sv.certification_reason, sv.certification_revoked_by, sv.certification_revoked_at,
                  sv.certification_revoke_reason, sv.governance_stage, sv.governance_reason,
                  sv.governance_evidence_ref, sv.governance_metadata, sv.governance_updated_by,
                  sv.governance_updated_at,
                 r.requested_by, r.requested_at, r.submitted_at, r.approved_by, r.approved_at,
                 r.rejected_by, r.rejected_at, r.rejection_reason, r.deployed_by, r.deployed_at,
                 r.rollback_of_release_id::text AS rollback_of_release_id, r.reason,
                 r.created_at, r.updated_at, r.created_at::text AS cursor_at
            FROM scenario_releases r
            JOIN scenario_versions sv ON sv.tenant_id=r.tenant_id AND sv.id=r.source_version_id`;
}

export async function appendReleaseEvent(
  client: PoolClient,
  tenantId: string,
  releaseId: string,
  eventType: string,
  actorSub: string,
  reason: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO scenario_release_events (id, tenant_id, release_id, event_type, actor_sub, reason)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)`,
    [randomUUID(), tenantId, releaseId, eventType, actorSub, reason],
  );
}

export function mapRelease(row: ReleaseRow): Record<string, unknown> {
  return {
    release_id: row.id,
    scenario_id: row.scenario_id,
    source_version_id: row.source_version_id,
    source_version: row.source_version,
    target_environment: row.target_environment,
    status: row.status,
    package_hash: row.package_hash,
    validation_report: row.validation_report,
    certification: mapScenarioCertification(row),
    requested_by: row.requested_by,
    requested_at: row.requested_at.toISOString(),
    submitted_at: row.submitted_at?.toISOString() ?? null,
    approved_by: row.approved_by,
    approved_at: row.approved_at?.toISOString() ?? null,
    rejected_by: row.rejected_by,
    rejected_at: row.rejected_at?.toISOString() ?? null,
    rejection_reason: row.rejection_reason,
    deployed_by: row.deployed_by,
    deployed_at: row.deployed_at?.toISOString() ?? null,
    rollback_of_release_id: row.rollback_of_release_id,
    reason: row.reason,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function mapBinding(row: BindingRow): Record<string, unknown> {
  return {
    binding_id: row.id,
    scenario_id: row.scenario_id,
    environment: row.environment,
    scenario_version_id: row.scenario_version_id,
    version: row.version,
    release_id: row.release_id,
    activated_by: row.activated_by,
    activated_at: row.activated_at.toISOString(),
  };
}
