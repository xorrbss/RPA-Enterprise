import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { isRecord } from "./command";
import { ApiResponseError } from "../runtime/errors";
// rotation 정책 계산 정본은 runtime/scim-secret-rotation-policy — 운영 알림 scim_secret_rotation 소스와 공용.
import {
  SCIM_SECRET_ROTATION_DUE_SOON_DAYS,
  scimSecretRotationDueAt,
  scimSecretRotationStatus,
  type ScimSecretRotationPolicy,
  type ScimSecretRotationStatus,
} from "../runtime/scim-secret-rotation-policy";
import { SCIM_SCHEMA_REF, assertAllowedKeys, hasOwn, parseProviderKey, parseStatus, requiredString } from "./scim-parse";

export {
  SCIM_SECRET_ROTATION_DUE_SOON_DAYS,
  scimSecretRotationDueAt,
  scimSecretRotationStatus,
};
export type { ScimSecretRotationPolicy, ScimSecretRotationStatus };
const SCIM_SECRET_ROTATION_POLICIES: readonly ScimSecretRotationPolicy[] = ["manual", "periodic_30d", "periodic_60d", "periodic_90d"];

export interface ScimProviderRow {
  readonly id: string;
  readonly provider_key: string;
  readonly status: "active" | "disabled";
  readonly inbound_schema_ref: string;
  readonly auth_mode: "signed_request_v1";
  readonly signature_secret_ref: string;
  readonly clock_skew_seconds: number;
}

export interface ScimProviderListRow extends ScimProviderRow {
  readonly display_name: string;
  readonly secret_rotation_policy: ScimSecretRotationPolicy;
  readonly last_secret_rotated_at: Date | null;
  readonly last_secret_rotated_by: string | null;
  readonly decommissioned_at: Date | null;
  readonly decommissioned_by: string | null;
  readonly decommission_reason: string | null;
  readonly created_by: string;
  readonly updated_by: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface CreateScimProviderBody {
  readonly providerKey: string;
  readonly displayName: string;
  readonly signatureSecretRef: string;
  readonly secretRotationPolicy: ScimSecretRotationPolicy;
  readonly clockSkewSeconds: number;
}

export interface UpdateScimProviderBody {
  readonly displayNameProvided: boolean;
  readonly displayName: string | null;
  readonly statusProvided: boolean;
  readonly status: "active" | "disabled" | null;
  readonly signatureSecretRefProvided: boolean;
  readonly signatureSecretRef: string | null;
  readonly secretRotationPolicyProvided: boolean;
  readonly secretRotationPolicy: ScimSecretRotationPolicy | null;
  readonly clockSkewSecondsProvided: boolean;
  readonly clockSkewSeconds: number | null;
}

export interface UpdateScimProviderResult {
  readonly row: ScimProviderListRow;
  readonly secretRotated: boolean;
}

export interface DecommissionScimProviderBody {
  readonly reason: string;
}

export interface DecommissionScimProviderResult {
  readonly row: ScimProviderListRow;
  readonly disabledMappings: number;
  readonly revokedAssignments: number;
}

export async function listScimProviders(client: PoolClient, tenantId: string): Promise<ScimProviderListRow[]> {
  const result = await client.query<ScimProviderListRow>(
    `SELECT id::text AS id, provider_key, display_name, status, inbound_schema_ref, auth_mode,
            signature_secret_ref, secret_rotation_policy, clock_skew_seconds,
            last_secret_rotated_at, last_secret_rotated_by,
            decommissioned_at, decommissioned_by, decommission_reason,
            created_by, updated_by, created_at, updated_at
       FROM scim_providers
      WHERE tenant_id = $1::uuid
      ORDER BY provider_key ASC`,
    [tenantId],
  );
  return result.rows;
}

export async function createScimProvider(
  client: PoolClient,
  tenantId: string,
  actorSub: string,
  body: CreateScimProviderBody,
): Promise<ScimProviderListRow> {
  try {
    const result = await client.query<ScimProviderListRow>(
      `INSERT INTO scim_providers
          (id, tenant_id, provider_key, display_name, status, inbound_schema_ref, auth_mode,
           signature_secret_ref, secret_rotation_policy, clock_skew_seconds, created_by)
       VALUES
          ($1::uuid, $2::uuid, $3::text, $4::text, 'active', $5::text, 'signed_request_v1',
           $6::text, $7::text, $8::int, $9::text)
       RETURNING id::text AS id, provider_key, display_name, status, inbound_schema_ref, auth_mode,
                 signature_secret_ref, secret_rotation_policy, clock_skew_seconds,
                 last_secret_rotated_at, last_secret_rotated_by,
                 decommissioned_at, decommissioned_by, decommission_reason,
                 created_by, updated_by, created_at, updated_at`,
      [
        randomUUID(),
        tenantId,
        body.providerKey,
        body.displayName,
        SCIM_SCHEMA_REF,
        body.signatureSecretRef,
        body.secretRotationPolicy,
        body.clockSkewSeconds,
        actorSub,
      ],
    );
    return result.rows[0]!;
  } catch (err) {
    if (isRecord(err) && (err as { code?: unknown }).code === "23505") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "scim_provider_already_exists", provider_key: body.providerKey });
    }
    throw err;
  }
}

export async function updateScimProvider(
  client: PoolClient,
  tenantId: string,
  actorSub: string,
  providerKey: string,
  body: UpdateScimProviderBody,
): Promise<UpdateScimProviderResult> {
  const existing = await requireScimProviderForAdmin(client, tenantId, providerKey);
  if (existing.decommissioned_at !== null && body.statusProvided && body.status === "active") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "scim_provider_decommissioned", provider_key: providerKey });
  }
  const secretRotated = body.signatureSecretRefProvided && existing.signature_secret_ref !== body.signatureSecretRef;
  const result = await client.query<ScimProviderListRow>(
    `UPDATE scim_providers
        SET display_name = CASE WHEN $3::boolean THEN $4::text ELSE display_name END,
            status = CASE WHEN $5::boolean THEN $6::text ELSE status END,
            signature_secret_ref = CASE WHEN $7::boolean THEN $8::text ELSE signature_secret_ref END,
            secret_rotation_policy = CASE WHEN $9::boolean THEN $10::text ELSE secret_rotation_policy END,
            clock_skew_seconds = CASE WHEN $11::boolean THEN $12::int ELSE clock_skew_seconds END,
            last_secret_rotated_at = CASE WHEN $14::boolean THEN now() ELSE last_secret_rotated_at END,
            last_secret_rotated_by = CASE WHEN $14::boolean THEN $13::text ELSE last_secret_rotated_by END,
            updated_by = $13::text,
            updated_at = now()
      WHERE tenant_id = $1::uuid AND provider_key = $2::text
      RETURNING id::text AS id, provider_key, display_name, status, inbound_schema_ref, auth_mode,
                signature_secret_ref, secret_rotation_policy, clock_skew_seconds,
                last_secret_rotated_at, last_secret_rotated_by,
                decommissioned_at, decommissioned_by, decommission_reason,
                created_by, updated_by, created_at, updated_at`,
    [
      tenantId,
      providerKey,
      body.displayNameProvided,
      body.displayName,
      body.statusProvided,
      body.status,
      body.signatureSecretRefProvided,
      body.signatureSecretRef,
      body.secretRotationPolicyProvided,
      body.secretRotationPolicy,
      body.clockSkewSecondsProvided,
      body.clockSkewSeconds,
      actorSub,
      secretRotated,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return { row, secretRotated };
}

export async function requireScimProvider(client: PoolClient, tenantId: string, providerKey: string): Promise<ScimProviderRow> {
  const provider = await loadScimProvider(client, tenantId, providerKey);
  if (provider === null) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return provider;
}

async function requireScimProviderForAdmin(client: PoolClient, tenantId: string, providerKey: string): Promise<ScimProviderListRow> {
  const result = await client.query<ScimProviderListRow>(
    `SELECT id::text AS id, provider_key, display_name, status, inbound_schema_ref, auth_mode,
            signature_secret_ref, secret_rotation_policy, clock_skew_seconds,
            last_secret_rotated_at, last_secret_rotated_by,
            decommissioned_at, decommissioned_by, decommission_reason,
            created_by, updated_by, created_at, updated_at
       FROM scim_providers
      WHERE tenant_id = $1::uuid AND provider_key = $2::text`,
    [tenantId, providerKey],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return row;
}

export async function requireMutableScimProvider(client: PoolClient, tenantId: string, providerKey: string): Promise<ScimProviderListRow> {
  const provider = await requireScimProviderForAdmin(client, tenantId, providerKey);
  if (provider.decommissioned_at !== null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "scim_provider_decommissioned", provider_key: providerKey });
  }
  return provider;
}

export async function decommissionScimProvider(
  client: PoolClient,
  tenantId: string,
  actorSub: string,
  providerKey: string,
  body: DecommissionScimProviderBody,
): Promise<DecommissionScimProviderResult> {
  await requireScimProviderForAdmin(client, tenantId, providerKey);
  const providerResult = await client.query<ScimProviderListRow>(
    `UPDATE scim_providers
        SET status = 'disabled',
            decommissioned_at = COALESCE(decommissioned_at, now()),
            decommissioned_by = COALESCE(decommissioned_by, $3::text),
            decommission_reason = COALESCE(decommission_reason, $4::text),
            updated_by = $3::text,
            updated_at = now()
      WHERE tenant_id = $1::uuid AND provider_key = $2::text
      RETURNING id::text AS id, provider_key, display_name, status, inbound_schema_ref, auth_mode,
                signature_secret_ref, secret_rotation_policy, clock_skew_seconds,
                last_secret_rotated_at, last_secret_rotated_by,
                decommissioned_at, decommissioned_by, decommission_reason,
                created_by, updated_by, created_at, updated_at`,
    [tenantId, providerKey, actorSub, body.reason],
  );
  const row = providerResult.rows[0];
  if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");

  const mappingResult = await client.query(
    `UPDATE scim_group_role_mappings
        SET status = 'disabled',
            updated_by = $3::text,
            updated_at = now()
      WHERE tenant_id = $1::uuid
        AND provider_key = $2::text
        AND status = 'active'`,
    [tenantId, providerKey, actorSub],
  );
  const assignmentResult = await client.query(
    `UPDATE principal_role_assignments
        SET status = 'revoked',
            revoked_by = $3::text,
            revoked_at = now(),
            revoke_reason = 'scim_provider_decommissioned',
            updated_at = now()
      WHERE tenant_id = $1::uuid
        AND idp_provider = $2::text
        AND source = 'scim'
        AND status = 'active'`,
    [tenantId, providerKey, actorSub],
  );
  return {
    row,
    disabledMappings: mappingResult.rowCount ?? 0,
    revokedAssignments: assignmentResult.rowCount ?? 0,
  };
}

export async function loadScimProvider(client: PoolClient, tenantId: string, providerKey: string): Promise<ScimProviderRow | null> {
  const result = await client.query<ScimProviderRow>(
    `SELECT id::text AS id, provider_key, status, inbound_schema_ref, auth_mode,
            signature_secret_ref, clock_skew_seconds
       FROM scim_providers
      WHERE tenant_id=$1::uuid AND provider_key=$2::text`,
    [tenantId, providerKey],
  );
  return result.rows[0] ?? null;
}

export function mapScimProvider(row: ScimProviderListRow): Record<string, unknown> {
  const rotationDueAt = row.decommissioned_at === null
    ? scimSecretRotationDueAt(row.secret_rotation_policy, row.created_at, row.last_secret_rotated_at)
    : null;
  return {
    provider_id: row.id,
    provider_key: row.provider_key,
    display_name: row.display_name,
    status: row.status,
    inbound_schema_ref: row.inbound_schema_ref,
    auth_mode: row.auth_mode,
    signature_secret_ref: row.signature_secret_ref,
    secret_rotation_policy: row.secret_rotation_policy,
    rotation_due_at: rotationDueAt?.toISOString() ?? null,
    rotation_status: scimSecretRotationStatus(row.secret_rotation_policy, row.created_at, row.last_secret_rotated_at, row.decommissioned_at),
    clock_skew_seconds: row.clock_skew_seconds,
    last_secret_rotated_at: row.last_secret_rotated_at?.toISOString() ?? null,
    last_secret_rotated_by: row.last_secret_rotated_by,
    decommissioned_at: row.decommissioned_at?.toISOString() ?? null,
    decommissioned_by: row.decommissioned_by,
    decommission_reason: row.decommission_reason,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function parseCreateScimProviderBody(raw: unknown): CreateScimProviderBody {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  assertAllowedKeys(raw, ["provider_key", "display_name", "signature_secret_ref", "secret_rotation_policy", "clock_skew_seconds"]);
  return {
    providerKey: parseProviderKey(requiredString(raw.provider_key, "provider_key")),
    displayName: requiredString(raw.display_name, "display_name"),
    signatureSecretRef: requiredString(raw.signature_secret_ref, "signature_secret_ref"),
    secretRotationPolicy: parseSecretRotationPolicy(raw.secret_rotation_policy ?? "periodic_90d"),
    clockSkewSeconds: parseClockSkew(raw.clock_skew_seconds ?? 300),
  };
}

export function parseUpdateScimProviderBody(raw: unknown): UpdateScimProviderBody {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  assertAllowedKeys(raw, ["display_name", "status", "signature_secret_ref", "secret_rotation_policy", "clock_skew_seconds"]);
  const displayNameProvided = hasOwn(raw, "display_name");
  const statusProvided = hasOwn(raw, "status");
  const signatureSecretRefProvided = hasOwn(raw, "signature_secret_ref");
  const secretRotationPolicyProvided = hasOwn(raw, "secret_rotation_policy");
  const clockSkewSecondsProvided = hasOwn(raw, "clock_skew_seconds");
  if (!displayNameProvided && !statusProvided && !signatureSecretRefProvided && !secretRotationPolicyProvided && !clockSkewSecondsProvided) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "empty_update" });
  }
  return {
    displayNameProvided,
    displayName: displayNameProvided ? requiredString(raw.display_name, "display_name") : null,
    statusProvided,
    status: statusProvided ? parseStatus(raw.status) : null,
    signatureSecretRefProvided,
    signatureSecretRef: signatureSecretRefProvided ? requiredString(raw.signature_secret_ref, "signature_secret_ref") : null,
    secretRotationPolicyProvided,
    secretRotationPolicy: secretRotationPolicyProvided ? parseSecretRotationPolicy(raw.secret_rotation_policy) : null,
    clockSkewSecondsProvided,
    clockSkewSeconds: clockSkewSecondsProvided ? parseClockSkew(raw.clock_skew_seconds) : null,
  };
}

export function parseDecommissionScimProviderBody(raw: unknown): DecommissionScimProviderBody {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  assertAllowedKeys(raw, ["reason"]);
  return { reason: requiredString(raw.reason, "reason") };
}

function parseSecretRotationPolicy(value: unknown): ScimSecretRotationPolicy {
  if (SCIM_SECRET_ROTATION_POLICIES.includes(value as ScimSecretRotationPolicy)) return value as ScimSecretRotationPolicy;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_secret_rotation_policy", field: "secret_rotation_policy" });
}

function parseClockSkew(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 900) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_clock_skew_seconds", field: "clock_skew_seconds" });
  }
  return value;
}
