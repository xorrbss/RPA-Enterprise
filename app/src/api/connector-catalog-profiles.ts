import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { ApiResponseError } from "../runtime/errors";
import { CONNECTORS, type ConnectorCatalogItem } from "./connector-catalog-data";
import {
  assertCertificationEvidence,
  defaultReceiptSemantics,
  requireOne,
  type ConnectorCertificationInput,
  type ConnectorCertificationStatus,
  type ConnectorEnvironment,
  type ConnectorProfileCreateInput,
  type ConnectorReceiptSemantics,
} from "./connector-catalog-validation";

export type ConnectorProfileStatus = "draft" | "security_review" | "certified" | "enabled" | "disabled" | "deprecated";

export interface ConnectorProfile {
  readonly profile_id: string;
  readonly connector_id: string;
  readonly profile_name: string;
  readonly status: ConnectorProfileStatus;
  readonly environment: ConnectorEnvironment;
  readonly secret_refs: readonly string[];
  readonly allowed_hosts: readonly string[];
  readonly owner_ref: string;
  readonly support_owner_ref: string | null;
  readonly profile_metadata: Readonly<Record<string, unknown>>;
  readonly latest_certification: ConnectorCertification | null;
  readonly created_by: string;
  readonly updated_by: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ConnectorCertification {
  readonly certification_id: string;
  readonly profile_id: string;
  readonly connector_id: string;
  readonly status: ConnectorCertificationStatus;
  readonly reason: string;
  readonly manifest_ref: string | null;
  readonly security_review_ref: string | null;
  readonly test_evidence_ref: string | null;
  readonly owner_evidence_ref: string | null;
  readonly receipt_semantics: ConnectorReceiptSemantics;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly certified_by: string;
  readonly created_at: string;
}

export interface ConnectorProfileRow {
  readonly id: string;
  readonly connector_id: string;
  readonly profile_name: string;
  readonly status: ConnectorProfileStatus;
  readonly environment: ConnectorEnvironment;
  readonly secret_refs: string[];
  readonly allowed_hosts: string[];
  readonly owner_ref: string;
  readonly support_owner_ref: string | null;
  readonly profile_metadata: Readonly<Record<string, unknown>>;
  readonly created_by: string;
  readonly updated_by: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly cursor_at: string;
  readonly certification_id: string | null;
  readonly certification_status: ConnectorCertificationStatus | null;
  readonly certification_reason: string | null;
  readonly manifest_ref: string | null;
  readonly security_review_ref: string | null;
  readonly test_evidence_ref: string | null;
  readonly owner_evidence_ref: string | null;
  readonly receipt_semantics: ConnectorReceiptSemantics | null;
  readonly certification_metadata: Readonly<Record<string, unknown>> | null;
  readonly certified_by: string | null;
  readonly certified_at: Date | null;
}

interface ConnectorCertificationRow {
  readonly id: string;
  readonly profile_id: string;
  readonly connector_id: string;
  readonly status: ConnectorCertificationStatus;
  readonly reason: string;
  readonly manifest_ref: string | null;
  readonly security_review_ref: string | null;
  readonly test_evidence_ref: string | null;
  readonly owner_evidence_ref: string | null;
  readonly receipt_semantics: ConnectorReceiptSemantics;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly certified_by: string;
  readonly created_at: Date;
}

export async function listConnectorProfiles(
  client: PoolClient,
  tenantId: string,
  limit: number,
  cursor: { readonly createdAt: string; readonly id: string } | null,
  connectorId: string | undefined,
  status: ConnectorProfileStatus | undefined,
): Promise<ConnectorProfileRow[]> {
  const values: unknown[] = [tenantId];
  const where = ["p.tenant_id = $1::uuid"];
  if (connectorId !== undefined) {
    values.push(connectorId);
    where.push(`p.connector_id = $${values.length}`);
  }
  if (status !== undefined) {
    values.push(status);
    where.push(`p.status = $${values.length}`);
  }
  if (cursor !== null) {
    values.push(cursor.createdAt, cursor.id);
    where.push(`(p.updated_at, p.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
  }
  values.push(limit + 1);
  const result = await client.query<ConnectorProfileRow>(
    `SELECT p.id, p.connector_id, p.profile_name, p.status, p.environment,
            p.secret_refs, p.allowed_hosts, p.owner_ref, p.support_owner_ref,
            p.profile_metadata, p.created_by, p.updated_by,
            p.created_at, p.updated_at, p.updated_at::text AS cursor_at,
            c.id AS certification_id,
            c.status AS certification_status,
            c.reason AS certification_reason,
            c.manifest_ref,
            c.security_review_ref,
            c.test_evidence_ref,
            c.owner_evidence_ref,
            c.receipt_semantics,
            c.metadata AS certification_metadata,
            c.certified_by,
            c.created_at AS certified_at
       FROM connector_profiles p
       LEFT JOIN connector_certifications c
         ON c.tenant_id = p.tenant_id
        AND c.id = p.latest_certification_id
      WHERE ${where.join(" AND ")}
      ORDER BY p.updated_at DESC, p.id DESC
      LIMIT $${values.length}`,
    values,
  );
  return result.rows;
}

export async function insertConnectorProfile(
  client: PoolClient,
  tenantId: string,
  actor: string,
  input: ConnectorProfileCreateInput,
): Promise<ConnectorProfile> {
  const catalogItem = findConnector(input.connectorId);
  assertConnectorProfileAllowed(catalogItem);
  if (catalogItem.required_secret_refs.length > 0 && input.secretRefs.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "connector_profile_secret_ref_required", connector_id: input.connectorId });
  }
  const result = await client.query<ConnectorProfileRow>(
    `INSERT INTO connector_profiles
       (id, tenant_id, connector_id, profile_name, environment, secret_refs, allowed_hosts,
        owner_ref, support_owner_ref, profile_metadata, created_by)
     VALUES
       ($1::uuid, $2::uuid, $3, $4, $5, $6::text[], $7::text[], $8, $9, $10::jsonb, $11)
     ON CONFLICT (tenant_id, connector_id, profile_name) DO UPDATE
        SET updated_at = connector_profiles.updated_at
     RETURNING id, connector_id, profile_name, status, environment, secret_refs, allowed_hosts,
               owner_ref, support_owner_ref, profile_metadata, created_by, updated_by,
               created_at, updated_at, updated_at::text AS cursor_at,
               NULL::uuid AS certification_id, NULL::text AS certification_status,
               NULL::text AS certification_reason, NULL::text AS manifest_ref,
               NULL::text AS security_review_ref, NULL::text AS test_evidence_ref,
               NULL::text AS owner_evidence_ref, NULL::jsonb AS receipt_semantics,
               NULL::jsonb AS certification_metadata, NULL::text AS certified_by,
               NULL::timestamptz AS certified_at`,
    [
      randomUUID(),
      tenantId,
      input.connectorId,
      input.profileName,
      input.environment,
      input.secretRefs,
      input.allowedHosts,
      input.ownerRef,
      input.supportOwnerRef,
      JSON.stringify(input.metadata),
      actor,
    ],
  );
  return mapConnectorProfile(requireOne(result.rows[0], "connector_profile_missing_after_insert"));
}

export async function insertConnectorCertification(
  client: PoolClient,
  tenantId: string,
  profileId: string,
  actor: string,
  input: ConnectorCertificationInput,
): Promise<ConnectorCertification> {
  const profile = await selectConnectorProfileForUpdate(client, tenantId, profileId);
  if (profile === undefined) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "connector_profile_not_found" });
  }
  findConnector(profile.connector_id);
  assertCertificationEvidence(input);
  const certificationId = randomUUID();
  const result = await client.query<ConnectorCertificationRow>(
    `INSERT INTO connector_certifications
       (id, tenant_id, profile_id, connector_id, status, reason, manifest_ref, security_review_ref,
        test_evidence_ref, owner_evidence_ref, receipt_semantics, metadata, certified_by)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13)
     RETURNING id, profile_id, connector_id, status, reason, manifest_ref, security_review_ref,
               test_evidence_ref, owner_evidence_ref, receipt_semantics, metadata, certified_by, created_at`,
    [
      certificationId,
      tenantId,
      profileId,
      profile.connector_id,
      input.status,
      input.reason,
      input.manifestRef,
      input.securityReviewRef,
      input.testEvidenceRef,
      input.ownerEvidenceRef,
      JSON.stringify(input.receiptSemantics),
      JSON.stringify(input.metadata),
      actor,
    ],
  );
  const nextProfileStatus = profileStatusFromCertification(input.status);
  await client.query(
    `UPDATE connector_profiles
        SET status = $4,
            latest_certification_id = $5::uuid,
            updated_by = $3,
            updated_at = now()
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid`,
    [tenantId, profileId, actor, nextProfileStatus, certificationId],
  );
  return mapConnectorCertification(requireOne(result.rows[0], "connector_certification_missing_after_insert"));
}

async function selectConnectorProfileForUpdate(
  client: PoolClient,
  tenantId: string,
  profileId: string,
): Promise<{ readonly id: string; readonly connector_id: string; readonly status: ConnectorProfileStatus } | undefined> {
  const result = await client.query<{ id: string; connector_id: string; status: ConnectorProfileStatus }>(
    `SELECT id, connector_id, status
       FROM connector_profiles
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
      FOR UPDATE`,
    [tenantId, profileId],
  );
  return result.rows[0];
}

export function mapConnectorProfile(row: ConnectorProfileRow): ConnectorProfile {
  return {
    profile_id: row.id,
    connector_id: row.connector_id,
    profile_name: row.profile_name,
    status: row.status,
    environment: row.environment,
    secret_refs: row.secret_refs,
    allowed_hosts: row.allowed_hosts,
    owner_ref: row.owner_ref,
    support_owner_ref: row.support_owner_ref,
    profile_metadata: row.profile_metadata,
    latest_certification: row.certification_id === null
      ? null
      : {
          certification_id: row.certification_id,
          profile_id: row.id,
          connector_id: row.connector_id,
          status: requireOne(row.certification_status, "connector_certification_status_missing"),
          reason: requireOne(row.certification_reason, "connector_certification_reason_missing"),
          manifest_ref: row.manifest_ref,
          security_review_ref: row.security_review_ref,
          test_evidence_ref: row.test_evidence_ref,
          owner_evidence_ref: row.owner_evidence_ref,
          receipt_semantics: row.receipt_semantics ?? defaultReceiptSemantics(),
          metadata: row.certification_metadata ?? {},
          certified_by: requireOne(row.certified_by, "connector_certification_actor_missing"),
          created_at: requireOne(row.certified_at, "connector_certification_created_at_missing").toISOString(),
        },
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function mapConnectorCertification(row: ConnectorCertificationRow): ConnectorCertification {
  return {
    certification_id: row.id,
    profile_id: row.profile_id,
    connector_id: row.connector_id,
    status: row.status,
    reason: row.reason,
    manifest_ref: row.manifest_ref,
    security_review_ref: row.security_review_ref,
    test_evidence_ref: row.test_evidence_ref,
    owner_evidence_ref: row.owner_evidence_ref,
    receipt_semantics: row.receipt_semantics,
    metadata: row.metadata,
    certified_by: row.certified_by,
    created_at: row.created_at.toISOString(),
  };
}

function profileStatusFromCertification(status: ConnectorCertificationStatus): ConnectorProfileStatus {
  if (status === "certified") return "certified";
  if (status === "revoked") return "disabled";
  return "security_review";
}

function findConnector(connectorId: string): ConnectorCatalogItem {
  const connector = CONNECTORS.find((item) => item.connector_id === connectorId);
  if (connector === undefined) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "connector_catalog_item_not_found" });
  }
  return connector;
}

function assertConnectorProfileAllowed(connector: ConnectorCatalogItem): void {
  if (connector.status === "available" || connector.status === "requires_admin") return;
  throw new ApiResponseError("IR_SCHEMA_INVALID", {
    reason: "connector_profile_not_allowed_for_catalog_status",
    connector_id: connector.connector_id,
    status: connector.status,
  });
}
