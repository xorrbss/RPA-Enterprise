import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { Role } from "../../../ts/security-middleware-contract";
import { isRecord } from "./command";
import { ApiResponseError } from "../runtime/errors";
import { assertAllowedKeys, hasOwn, parseOptionalText, parseRole, parseStatus, requiredString } from "./scim-parse";
import { requireMutableScimProvider } from "./scim-providers";

export interface ScimGroupRoleMappingRow {
  readonly id: string;
  readonly provider_key: string;
  readonly external_group: string;
  readonly role: Role;
  readonly status: "active" | "disabled";
  readonly description: string | null;
  readonly created_by: string;
  readonly updated_by: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export type ScimGroupRoleMappingImportMode = "upsert_only" | "replace_active";

export interface CreateScimMappingBody {
  readonly externalGroup: string;
  readonly role: Role;
  readonly description: string | null;
}

export interface ImportScimMappingBody {
  readonly mode: ScimGroupRoleMappingImportMode;
  readonly mappings: readonly CreateScimMappingBody[];
}

export interface ImportScimMappingResult {
  readonly providerKey: string;
  readonly mode: ScimGroupRoleMappingImportMode;
  readonly imported: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly disabled: number;
  readonly rows: readonly ScimGroupRoleMappingRow[];
}

export interface UpdateScimMappingBody {
  readonly roleProvided: boolean;
  readonly role: Role | null;
  readonly statusProvided: boolean;
  readonly status: "active" | "disabled" | null;
  readonly descriptionProvided: boolean;
  readonly description: string | null;
}

export async function listScimGroupRoleMappings(
  client: PoolClient,
  tenantId: string,
  providerKey: string,
): Promise<ScimGroupRoleMappingRow[]> {
  const result = await client.query<ScimGroupRoleMappingRow>(
    `SELECT id::text AS id, provider_key, external_group, role, status, description,
            created_by, updated_by, created_at, updated_at
       FROM scim_group_role_mappings
      WHERE tenant_id = $1::uuid AND provider_key = $2::text
      ORDER BY external_group ASC, role ASC`,
    [tenantId, providerKey],
  );
  return result.rows;
}

export async function createScimGroupRoleMapping(
  client: PoolClient,
  tenantId: string,
  actorSub: string,
  providerKey: string,
  body: CreateScimMappingBody,
): Promise<ScimGroupRoleMappingRow> {
  try {
    const result = await client.query<ScimGroupRoleMappingRow>(
      `INSERT INTO scim_group_role_mappings
          (id, tenant_id, provider_key, external_group, role, status, description, created_by)
       VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, 'active', $6::text, $7::text)
       RETURNING id::text AS id, provider_key, external_group, role, status, description,
                 created_by, updated_by, created_at, updated_at`,
      [randomUUID(), tenantId, providerKey, body.externalGroup, body.role, body.description, actorSub],
    );
    return result.rows[0]!;
  } catch (err) {
    if (isRecord(err) && (err as { code?: unknown }).code === "23505") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", {
        reason: "scim_group_role_mapping_already_exists",
        provider_key: providerKey,
        external_group: body.externalGroup,
      });
    }
    throw err;
  }
}

export async function importScimGroupRoleMappings(
  client: PoolClient,
  tenantId: string,
  actorSub: string,
  providerKey: string,
  body: ImportScimMappingBody,
): Promise<ImportScimMappingResult> {
  await requireMutableScimProvider(client, tenantId, providerKey);
  const groups = body.mappings.map((mapping) => mapping.externalGroup);
  const existing = await client.query<ScimGroupRoleMappingRow>(
    `SELECT id::text AS id, provider_key, external_group, role, status, description,
            created_by, updated_by, created_at, updated_at
       FROM scim_group_role_mappings
      WHERE tenant_id = $1::uuid
        AND provider_key = $2::text
        AND external_group = ANY($3::text[])
      FOR UPDATE`,
    [tenantId, providerKey, groups],
  );
  const existingByGroup = new Map(existing.rows.map((row) => [row.external_group, row]));
  const rows: ScimGroupRoleMappingRow[] = [];
  let imported = 0;
  let updated = 0;
  let unchanged = 0;

  for (const mapping of body.mappings) {
    const current = existingByGroup.get(mapping.externalGroup);
    if (current === undefined) {
      const row = await insertScimGroupRoleMapping(client, tenantId, actorSub, providerKey, mapping);
      rows.push(row);
      imported += 1;
      continue;
    }
    if (current.status === "active" && current.role === mapping.role && current.description === mapping.description) {
      rows.push(current);
      unchanged += 1;
      continue;
    }
    const row = await replaceScimGroupRoleMapping(client, tenantId, actorSub, providerKey, current.id, mapping);
    rows.push(row);
    updated += 1;
  }

  let disabled = 0;
  if (body.mode === "replace_active") {
    const disabledResult = await client.query(
      `UPDATE scim_group_role_mappings
          SET status = 'disabled',
              updated_by = $3::text,
              updated_at = now()
        WHERE tenant_id = $1::uuid
          AND provider_key = $2::text
          AND status = 'active'
          AND NOT (external_group = ANY($4::text[]))`,
      [tenantId, providerKey, actorSub, groups],
    );
    disabled = disabledResult.rowCount ?? 0;
  }

  return { providerKey, mode: body.mode, imported, updated, unchanged, disabled, rows };
}

export async function updateScimGroupRoleMapping(
  client: PoolClient,
  tenantId: string,
  actorSub: string,
  providerKey: string,
  mappingId: string,
  body: UpdateScimMappingBody,
): Promise<ScimGroupRoleMappingRow> {
  const result = await client.query<ScimGroupRoleMappingRow>(
    `UPDATE scim_group_role_mappings
        SET role = CASE WHEN $4::boolean THEN $5::text ELSE role END,
            status = CASE WHEN $6::boolean THEN $7::text ELSE status END,
            description = CASE WHEN $8::boolean THEN $9::text ELSE description END,
            updated_by = $10::text,
            updated_at = now()
      WHERE tenant_id = $1::uuid AND provider_key = $2::text AND id = $3::uuid
      RETURNING id::text AS id, provider_key, external_group, role, status, description,
                created_by, updated_by, created_at, updated_at`,
    [
      tenantId,
      providerKey,
      mappingId,
      body.roleProvided,
      body.role,
      body.statusProvided,
      body.status,
      body.descriptionProvided,
      body.description,
      actorSub,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return row;
}

async function insertScimGroupRoleMapping(
  client: PoolClient,
  tenantId: string,
  actorSub: string,
  providerKey: string,
  body: CreateScimMappingBody,
): Promise<ScimGroupRoleMappingRow> {
  const result = await client.query<ScimGroupRoleMappingRow>(
    `INSERT INTO scim_group_role_mappings
        (id, tenant_id, provider_key, external_group, role, status, description, created_by)
     VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, 'active', $6::text, $7::text)
     RETURNING id::text AS id, provider_key, external_group, role, status, description,
               created_by, updated_by, created_at, updated_at`,
    [randomUUID(), tenantId, providerKey, body.externalGroup, body.role, body.description, actorSub],
  );
  return result.rows[0]!;
}

async function replaceScimGroupRoleMapping(
  client: PoolClient,
  tenantId: string,
  actorSub: string,
  providerKey: string,
  mappingId: string,
  body: CreateScimMappingBody,
): Promise<ScimGroupRoleMappingRow> {
  const result = await client.query<ScimGroupRoleMappingRow>(
    `UPDATE scim_group_role_mappings
        SET role = $4::text,
            status = 'active',
            description = $5::text,
            updated_by = $6::text,
            updated_at = now()
      WHERE tenant_id = $1::uuid
        AND provider_key = $2::text
        AND id = $3::uuid
      RETURNING id::text AS id, provider_key, external_group, role, status, description,
                created_by, updated_by, created_at, updated_at`,
    [tenantId, providerKey, mappingId, body.role, body.description, actorSub],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return row;
}

export function mapScimGroupRoleMapping(row: ScimGroupRoleMappingRow): Record<string, unknown> {
  return {
    mapping_id: row.id,
    provider_key: row.provider_key,
    external_group: row.external_group,
    role: row.role,
    status: row.status,
    description: row.description,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function mapScimGroupRoleMappingImport(result: ImportScimMappingResult): Record<string, unknown> {
  return {
    provider_key: result.providerKey,
    mode: result.mode,
    imported: result.imported,
    updated: result.updated,
    unchanged: result.unchanged,
    disabled: result.disabled,
    items: result.rows.map(mapScimGroupRoleMapping),
  };
}

export function parseCreateScimMappingBody(raw: unknown): CreateScimMappingBody {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  assertAllowedKeys(raw, ["external_group", "role", "description"]);
  return {
    externalGroup: requiredString(raw.external_group, "external_group"),
    role: parseRole(raw.role),
    description: parseOptionalText(raw.description, "description"),
  };
}

export function parseImportScimMappingBody(raw: unknown): ImportScimMappingBody {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  assertAllowedKeys(raw, ["mode", "mappings"]);
  const mode = parseImportMode(raw.mode);
  if (!Array.isArray(raw.mappings) || raw.mappings.length < 1 || raw.mappings.length > 500) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_scim_mapping_import_size", field: "mappings", min: 1, max: 500 });
  }
  const seen = new Set<string>();
  const mappings = raw.mappings.map((item, index) => {
    if (!isRecord(item)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_scim_mapping_import_row", field: `mappings.${index}` });
    }
    assertAllowedKeys(item, ["external_group", "role", "description"]);
    const mapping = {
      externalGroup: requiredString(item.external_group, `mappings.${index}.external_group`),
      role: parseRole(item.role),
      description: parseOptionalText(item.description, `mappings.${index}.description`),
    };
    if (seen.has(mapping.externalGroup)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", {
        reason: "duplicate_external_group",
        field: "mappings",
        external_group: mapping.externalGroup,
      });
    }
    seen.add(mapping.externalGroup);
    return mapping;
  });
  return { mode, mappings };
}

export function parseUpdateScimMappingBody(raw: unknown): UpdateScimMappingBody {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  assertAllowedKeys(raw, ["role", "status", "description"]);
  const roleProvided = hasOwn(raw, "role");
  const statusProvided = hasOwn(raw, "status");
  const descriptionProvided = hasOwn(raw, "description");
  if (!roleProvided && !statusProvided && !descriptionProvided) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "empty_update" });
  }
  return {
    roleProvided,
    role: roleProvided ? parseRole(raw.role) : null,
    statusProvided,
    status: statusProvided ? parseStatus(raw.status) : null,
    descriptionProvided,
    description: descriptionProvided ? parseOptionalText(raw.description, "description") : null,
  };
}

function parseImportMode(value: unknown): ScimGroupRoleMappingImportMode {
  if (value === "upsert_only" || value === "replace_active") return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_scim_mapping_import_mode", field: "mode" });
}
