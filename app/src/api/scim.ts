import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import type { PlainSecret, SecretRef } from "../../../ts/core-types";
import type { PrincipalId, TenantId } from "../../../ts/security-middleware-contract";
import type { Role } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { isRecord, runIdempotentCommand } from "./command";
import { ApiResponseError } from "./errors";
import { appendGovernanceAudit } from "./role-assignments";
import { requirePrincipal, type ApiServerDeps } from "./server";

const ROLES: readonly Role[] = ["viewer", "operator", "reviewer", "approver", "admin"];
const SCIM_SCHEMA_REF = "scim-principal@1";
const SCIM_SIGNATURE_RE = /^sha256=([a-f0-9]{64})$/i;
const SCIM_PROVIDER_KEY_RE = /^[a-z0-9][a-z0-9._:-]{1,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type ScimSecretRotationPolicy = "manual" | "periodic_30d" | "periodic_60d" | "periodic_90d";
export type ScimSecretRotationStatus = "manual" | "current" | "due_soon" | "overdue" | "decommissioned";
export const SCIM_SECRET_ROTATION_DUE_SOON_DAYS = 7;
const SCIM_SECRET_ROTATION_POLICIES: readonly ScimSecretRotationPolicy[] = ["manual", "periodic_30d", "periodic_60d", "periodic_90d"];
const SCIM_SECRET_ROTATION_INTERVAL_DAYS: Record<ScimSecretRotationPolicy, number | null> = {
  manual: null,
  periodic_30d: 30,
  periodic_60d: 60,
  periodic_90d: 90,
};

interface ScimPrincipalInput {
  readonly schemaVersion: typeof SCIM_SCHEMA_REF;
  readonly idpProvider: string;
  readonly externalId: string;
  readonly sub: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly active: boolean;
  readonly externalGroups: readonly string[] | null;
  readonly roleSource: "roles" | "external_groups";
  readonly roles: readonly Role[] | null;
}

interface ResolvedScimPrincipalInput extends Omit<ScimPrincipalInput, "roles"> {
  readonly roles: readonly Role[];
}

interface ScimProviderRow {
  readonly id: string;
  readonly provider_key: string;
  readonly status: "active" | "disabled";
  readonly inbound_schema_ref: string;
  readonly auth_mode: "signed_request_v1";
  readonly signature_secret_ref: string;
  readonly clock_skew_seconds: number;
}

interface ScimProviderListRow extends ScimProviderRow {
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

interface ScimGroupRoleMappingRow {
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

interface CreateScimProviderBody {
  readonly providerKey: string;
  readonly displayName: string;
  readonly signatureSecretRef: string;
  readonly secretRotationPolicy: ScimSecretRotationPolicy;
  readonly clockSkewSeconds: number;
}

interface UpdateScimProviderBody {
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

interface UpdateScimProviderResult {
  readonly row: ScimProviderListRow;
  readonly secretRotated: boolean;
}

interface DecommissionScimProviderBody {
  readonly reason: string;
}

interface DecommissionScimProviderResult {
  readonly row: ScimProviderListRow;
  readonly disabledMappings: number;
  readonly revokedAssignments: number;
}

type ScimGroupRoleMappingImportMode = "upsert_only" | "replace_active";

interface CreateScimMappingBody {
  readonly externalGroup: string;
  readonly role: Role;
  readonly description: string | null;
}

interface ImportScimMappingBody {
  readonly mode: ScimGroupRoleMappingImportMode;
  readonly mappings: readonly CreateScimMappingBody[];
}

interface ImportScimMappingResult {
  readonly providerKey: string;
  readonly mode: ScimGroupRoleMappingImportMode;
  readonly imported: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly disabled: number;
  readonly rows: readonly ScimGroupRoleMappingRow[];
}

interface UpdateScimMappingBody {
  readonly roleProvided: boolean;
  readonly role: Role | null;
  readonly statusProvided: boolean;
  readonly status: "active" | "disabled" | null;
  readonly descriptionProvided: boolean;
  readonly description: string | null;
}

export function registerScimRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/scim/providers", { config: { rbacAction: "scim.sync" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const rows = await withTenantTx(deps.pool, principal.tenantId, (client) => listScimProviders(client, principal.tenantId));
    reply.code(200).send({ items: rows.map(mapScimProvider), next_cursor: null });
  });

  app.post("/v1/scim/providers", { config: { rbacAction: "scim.sync" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseCreateScimProviderBody(request.body);
    const result = await runIdempotentCommand(deps, request, "createScimProvider", "/v1/scim/providers", async (client, tenantId) => {
      const row = await createScimProvider(client, tenantId, principal.subjectId, body);
      await appendGovernanceAudit(client, request, "scim.sync", "allow", "scim_provider_created", {
        provider_id: row.id,
        provider_key: row.provider_key,
        signature_secret_ref: row.signature_secret_ref,
        secret_rotation_policy: row.secret_rotation_policy,
        clock_skew_seconds: row.clock_skew_seconds,
      });
      return { status: 201, body: mapScimProvider(row) };
    });
    reply.code(result.status).send(result.body);
  });

  app.patch<{ Params: { providerKey: string } }>(
    "/v1/scim/providers/:providerKey",
    { config: { rbacAction: "scim.sync" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const providerKey = parseProviderKey(request.params.providerKey);
      const body = parseUpdateScimProviderBody(request.body);
      const result = await runIdempotentCommand(
        deps,
        request,
        "updateScimProvider",
        `/v1/scim/providers/${providerKey}`,
        async (client, tenantId) => {
          const update = await updateScimProvider(client, tenantId, principal.subjectId, providerKey, body);
          const row = update.row;
          await appendGovernanceAudit(client, request, "scim.sync", "allow", "scim_provider_updated", {
            provider_id: row.id,
            provider_key: row.provider_key,
            status: row.status,
            signature_secret_ref: row.signature_secret_ref,
            secret_rotation_policy: row.secret_rotation_policy,
            clock_skew_seconds: row.clock_skew_seconds,
            secret_rotated: update.secretRotated,
            last_secret_rotated_at: row.last_secret_rotated_at?.toISOString() ?? null,
          });
          return { status: 200, body: mapScimProvider(row) };
        },
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { providerKey: string } }>(
    "/v1/scim/providers/:providerKey/decommission",
    { config: { rbacAction: "scim.sync" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const providerKey = parseProviderKey(request.params.providerKey);
      const body = parseDecommissionScimProviderBody(request.body);
      const result = await runIdempotentCommand(
        deps,
        request,
        "decommissionScimProvider",
        `/v1/scim/providers/${providerKey}/decommission`,
        async (client, tenantId) => {
          const decommissioned = await decommissionScimProvider(client, tenantId, principal.subjectId, providerKey, body);
          await appendGovernanceAudit(client, request, "scim.sync", "allow", "scim_provider_decommissioned", {
            provider_id: decommissioned.row.id,
            provider_key: decommissioned.row.provider_key,
            decommission_reason: decommissioned.row.decommission_reason,
            decommissioned_at: decommissioned.row.decommissioned_at?.toISOString() ?? null,
            disabled_mappings: decommissioned.disabledMappings,
            revoked_assignments: decommissioned.revokedAssignments,
          });
          return {
            status: 200,
            body: {
              provider: mapScimProvider(decommissioned.row),
              disabled_mappings: decommissioned.disabledMappings,
              revoked_assignments: decommissioned.revokedAssignments,
            },
          };
        },
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.get<{ Params: { providerKey: string } }>(
    "/v1/scim/providers/:providerKey/group-role-mappings",
    { config: { rbacAction: "scim.sync" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const providerKey = parseProviderKey(request.params.providerKey);
      const rows = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
        await requireScimProvider(client, principal.tenantId, providerKey);
        return listScimGroupRoleMappings(client, principal.tenantId, providerKey);
      });
      reply.code(200).send({ items: rows.map(mapScimGroupRoleMapping), next_cursor: null });
    },
  );

  app.post<{ Params: { providerKey: string } }>(
    "/v1/scim/providers/:providerKey/group-role-mappings",
    { config: { rbacAction: "scim.sync" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const providerKey = parseProviderKey(request.params.providerKey);
      const body = parseCreateScimMappingBody(request.body);
      const result = await runIdempotentCommand(
        deps,
        request,
        "createScimGroupRoleMapping",
        `/v1/scim/providers/${providerKey}/group-role-mappings`,
        async (client, tenantId) => {
          await requireMutableScimProvider(client, tenantId, providerKey);
          const row = await createScimGroupRoleMapping(client, tenantId, principal.subjectId, providerKey, body);
          await appendGovernanceAudit(client, request, "scim.sync", "allow", "scim_group_role_mapping_created", {
            mapping_id: row.id,
            provider_key: row.provider_key,
            external_group: row.external_group,
            role: row.role,
          });
          return { status: 201, body: mapScimGroupRoleMapping(row) };
        },
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { providerKey: string } }>(
    "/v1/scim/providers/:providerKey/group-role-mappings/import",
    { config: { rbacAction: "scim.sync" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const providerKey = parseProviderKey(request.params.providerKey);
      const body = parseImportScimMappingBody(request.body);
      const result = await runIdempotentCommand(
        deps,
        request,
        "importScimGroupRoleMappings",
        `/v1/scim/providers/${providerKey}/group-role-mappings/import`,
        async (client, tenantId) => {
          const imported = await importScimGroupRoleMappings(client, tenantId, principal.subjectId, providerKey, body);
          await appendGovernanceAudit(client, request, "scim.sync", "allow", "scim_group_role_mappings_imported", {
            provider_key: imported.providerKey,
            mode: imported.mode,
            mapping_count: body.mappings.length,
            imported: imported.imported,
            updated: imported.updated,
            unchanged: imported.unchanged,
            disabled: imported.disabled,
          });
          return { status: 200, body: mapScimGroupRoleMappingImport(imported) };
        },
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.patch<{ Params: { providerKey: string; mappingId: string } }>(
    "/v1/scim/providers/:providerKey/group-role-mappings/:mappingId",
    { config: { rbacAction: "scim.sync" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const providerKey = parseProviderKey(request.params.providerKey);
      const mappingId = parseUuid(request.params.mappingId);
      const body = parseUpdateScimMappingBody(request.body);
      const result = await runIdempotentCommand(
        deps,
        request,
        "updateScimGroupRoleMapping",
        `/v1/scim/providers/${providerKey}/group-role-mappings/${mappingId}`,
        async (client, tenantId) => {
          await requireMutableScimProvider(client, tenantId, providerKey);
          const row = await updateScimGroupRoleMapping(client, tenantId, principal.subjectId, providerKey, mappingId, body);
          await appendGovernanceAudit(client, request, "scim.sync", "allow", "scim_group_role_mapping_updated", {
            mapping_id: row.id,
            provider_key: row.provider_key,
            external_group: row.external_group,
            role: row.role,
            status: row.status,
          });
          return { status: 200, body: mapScimGroupRoleMapping(row) };
        },
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.post("/v1/scim/principals", { config: { rbacAction: "scim.sync" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const input = parseScimPrincipalInput(request.body);
    const provider = await verifyScimInboundBoundary(deps, request, principal, input);
    const result = await runIdempotentCommand(deps, request, "syncScimPrincipal", "/v1/scim/principals", async (client, tenantId) => {
      const resolved = await resolveScimRoles(client, tenantId, input);
      const saved = await upsertScimPrincipal(client, tenantId, resolved);
      if (resolved.active) {
        await syncScimRoles(client, tenantId, resolved, principal.subjectId);
      } else {
        await client.query(
          `UPDATE principal_role_assignments
              SET status = 'revoked',
                  revoked_by = $4,
                  revoked_at = now()
            WHERE tenant_id = $1::uuid
              AND principal_sub = $2
                  AND idp_provider = $3
                  AND source = 'scim'
                  AND status = 'active'`,
          [tenantId, resolved.sub, resolved.idpProvider, principal.subjectId],
        );
      }
      await appendGovernanceAudit(client, request, "scim.sync", "allow", "scim_principal_synced", {
        principal_id: saved.rows[0]?.id ?? null,
        provider_id: provider.id,
        schema_version: resolved.schemaVersion,
        sub: resolved.sub,
        idp_provider: resolved.idpProvider,
        external_id: resolved.externalId,
        active: resolved.active,
        role_source: resolved.roleSource,
        external_groups_count: resolved.externalGroups?.length ?? 0,
        roles: resolved.roles,
      });
      return {
        status: 200,
        body: {
          principal_id: saved.rows[0]?.id ?? null,
          sub: resolved.sub,
          active: resolved.active,
          roles: resolved.active ? resolved.roles : [],
        },
      };
    });
    reply.code(result.status).send(result.body);
  });
}

async function listScimProviders(client: PoolClient, tenantId: string): Promise<ScimProviderListRow[]> {
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

async function createScimProvider(
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

async function updateScimProvider(
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

async function requireScimProvider(client: PoolClient, tenantId: string, providerKey: string): Promise<ScimProviderRow> {
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

async function requireMutableScimProvider(client: PoolClient, tenantId: string, providerKey: string): Promise<ScimProviderListRow> {
  const provider = await requireScimProviderForAdmin(client, tenantId, providerKey);
  if (provider.decommissioned_at !== null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "scim_provider_decommissioned", provider_key: providerKey });
  }
  return provider;
}

async function decommissionScimProvider(
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

async function listScimGroupRoleMappings(
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

async function createScimGroupRoleMapping(
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

async function importScimGroupRoleMappings(
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

async function updateScimGroupRoleMapping(
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

function mapScimProvider(row: ScimProviderListRow): Record<string, unknown> {
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

function mapScimGroupRoleMapping(row: ScimGroupRoleMappingRow): Record<string, unknown> {
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

function mapScimGroupRoleMappingImport(result: ImportScimMappingResult): Record<string, unknown> {
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

export function scimSecretRotationDueAt(
  policy: ScimSecretRotationPolicy,
  createdAt: Date,
  lastSecretRotatedAt: Date | null,
): Date | null {
  const intervalDays = SCIM_SECRET_ROTATION_INTERVAL_DAYS[policy];
  if (intervalDays === null) return null;
  const baseline = lastSecretRotatedAt ?? createdAt;
  return new Date(baseline.getTime() + intervalDays * 24 * 60 * 60 * 1000);
}

export function scimSecretRotationStatus(
  policy: ScimSecretRotationPolicy,
  createdAt: Date,
  lastSecretRotatedAt: Date | null,
  decommissionedAt: Date | null,
  now = new Date(),
): ScimSecretRotationStatus {
  if (decommissionedAt !== null) return "decommissioned";
  const dueAt = scimSecretRotationDueAt(policy, createdAt, lastSecretRotatedAt);
  if (dueAt === null) return "manual";
  if (dueAt.getTime() <= now.getTime()) return "overdue";
  const dueSoonAt = new Date(now.getTime() + SCIM_SECRET_ROTATION_DUE_SOON_DAYS * 24 * 60 * 60 * 1000);
  return dueAt.getTime() <= dueSoonAt.getTime() ? "due_soon" : "current";
}

async function verifyScimInboundBoundary(
  deps: ApiServerDeps,
  request: { headers: Record<string, unknown>; body?: unknown },
  principal: { tenantId: string },
  input: ScimPrincipalInput,
): Promise<ScimProviderRow> {
  const provider = await withTenantTx(deps.pool, principal.tenantId, (client) =>
    loadScimProvider(client, principal.tenantId, input.idpProvider),
  );
  if (provider === null) {
    throw new ApiResponseError("AUTHZ_FORBIDDEN", { reason: "scim_provider_not_registered" });
  }
  if (provider.status !== "active") {
    throw new ApiResponseError("AUTHZ_FORBIDDEN", { reason: "scim_provider_disabled" });
  }
  if (provider.inbound_schema_ref !== input.schemaVersion) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "scim_schema_version_mismatch",
      expected: provider.inbound_schema_ref,
      actual: input.schemaVersion,
    });
  }
  if (provider.auth_mode !== "signed_request_v1") {
    throw new ApiResponseError("AUTHZ_FORBIDDEN", { reason: "scim_provider_auth_mode_unsupported" });
  }
  const timestamp = requiredHeader(request.headers["x-rpa-scim-timestamp"], "x-rpa-scim-timestamp");
  const signature = requiredHeader(request.headers["x-rpa-scim-signature"], "x-rpa-scim-signature");
  const timestampSeconds = Number(timestamp);
  if (!Number.isInteger(timestampSeconds) || timestampSeconds <= 0) {
    throw new ApiResponseError("UNAUTHENTICATED", { reason: "invalid_scim_timestamp" });
  }
  const skewSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds);
  if (skewSeconds > provider.clock_skew_seconds) {
    throw new ApiResponseError("UNAUTHENTICATED", { reason: "stale_scim_timestamp" });
  }
  if (deps.scimSignatureSecretBoundary === undefined) {
    throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "scim_signature_boundary_not_configured" });
  }
  const secret = await deps.scimSignatureSecretBoundary.resolveAuthorized({
    principal: scimSecretPrincipal(principal.tenantId, input.idpProvider),
    ref: provider.signature_secret_ref as SecretRef,
    purpose: "connector",
    connectorId: `scim:${input.idpProvider}`,
  });
  const payload = scimSigningPayload(timestamp, input.idpProvider, input.schemaVersion, request.body ?? null);
  if (!verifyScimSignature(secret, signature, payload)) {
    throw new ApiResponseError("UNAUTHENTICATED", { reason: "invalid_scim_signature" });
  }
  return provider;
}

async function loadScimProvider(client: PoolClient, tenantId: string, providerKey: string): Promise<ScimProviderRow | null> {
  const result = await client.query<ScimProviderRow>(
    `SELECT id::text AS id, provider_key, status, inbound_schema_ref, auth_mode,
            signature_secret_ref, clock_skew_seconds
       FROM scim_providers
      WHERE tenant_id=$1::uuid AND provider_key=$2::text`,
    [tenantId, providerKey],
  );
  return result.rows[0] ?? null;
}

async function upsertScimPrincipal(
  client: PoolClient,
  tenantId: string,
  input: ResolvedScimPrincipalInput,
): Promise<{ rows: Array<{ id: string }> }> {
  await assertScimIdentityConflictFree(client, tenantId, input);
  try {
    return await client.query<{ id: string }>(
      `INSERT INTO principals
          (id, tenant_id, sub, display_name, email, source, external_id, idp_provider, lifecycle_source)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'scim', $6, $7, 'scim')
       ON CONFLICT (tenant_id, sub) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          email = EXCLUDED.email,
          source = 'scim',
          external_id = EXCLUDED.external_id,
          idp_provider = EXCLUDED.idp_provider,
          lifecycle_source = 'scim',
          updated_at = now()
       RETURNING id::text`,
      [randomUUID(), tenantId, input.sub, input.displayName, input.email, input.externalId, input.idpProvider],
    );
  } catch (err) {
    if (isRecord(err) && (err as { code?: unknown }).code === "23505") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "scim_identity_conflict" });
    }
    throw err;
  }
}

async function assertScimIdentityConflictFree(client: PoolClient, tenantId: string, input: ScimPrincipalInput): Promise<void> {
  const external = await client.query<{ sub: string }>(
    `SELECT sub
       FROM principals
      WHERE tenant_id=$1::uuid
        AND idp_provider=$2::text
        AND external_id=$3::text
      FOR UPDATE`,
    [tenantId, input.idpProvider, input.externalId],
  );
  const externalRow = external.rows[0];
  if (externalRow !== undefined && externalRow.sub !== input.sub) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "scim_external_id_sub_conflict",
      idp_provider: input.idpProvider,
      external_id: input.externalId,
    });
  }

  const sub = await client.query<{ idp_provider: string | null; external_id: string | null }>(
    `SELECT idp_provider, external_id
       FROM principals
      WHERE tenant_id=$1::uuid
        AND sub=$2::text
      FOR UPDATE`,
    [tenantId, input.sub],
  );
  const subRow = sub.rows[0];
  if (
    subRow !== undefined &&
    (subRow.idp_provider !== null || subRow.external_id !== null) &&
    (subRow.idp_provider !== input.idpProvider || subRow.external_id !== input.externalId)
  ) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "scim_sub_external_id_conflict",
      sub: input.sub,
    });
  }
}

async function syncScimRoles(
  client: { query: (sql: string, params?: readonly unknown[]) => Promise<{ rowCount: number | null }> },
  tenantId: string,
  input: ResolvedScimPrincipalInput,
  actorSub: string,
): Promise<void> {
  for (const role of input.roles) {
    const roleExternalId = scimRoleExternalId(input.externalId, role);
    await client.query(
      `WITH revived AS (
          UPDATE principal_role_assignments
             SET status = 'active',
                 revoked_by = NULL,
                 revoked_at = NULL,
                 revoke_reason = NULL,
                 granted_by = $7,
                 granted_at = now(),
                 updated_at = now()
           WHERE tenant_id = $2::uuid
             AND principal_sub = $3
             AND role = $4
             AND source = 'scim'
             AND idp_provider = $6
             AND external_id = $5
             AND status = 'revoked'
             AND NOT EXISTS (
               SELECT 1
                 FROM principal_role_assignments active_role
                WHERE active_role.tenant_id = $2::uuid
                  AND active_role.principal_sub = $3
                  AND active_role.role = $4
                  AND active_role.status = 'active'
             )
           RETURNING id
        )
        INSERT INTO principal_role_assignments
          (id, tenant_id, principal_sub, role, source, external_id, idp_provider, lifecycle_source, status, granted_by, reason)
        SELECT $1::uuid, $2::uuid, $3, $4, 'scim', $5, $6, 'scim', 'active', $7, 'scim_sync'
         WHERE NOT EXISTS (SELECT 1 FROM revived)
           AND NOT EXISTS (
          SELECT 1
            FROM principal_role_assignments
           WHERE tenant_id = $2::uuid
             AND principal_sub = $3
             AND role = $4
             AND status = 'active'
        )`,
      [randomUUID(), tenantId, input.sub, role, roleExternalId, input.idpProvider, actorSub],
    );
  }
  await client.query(
    `UPDATE principal_role_assignments
        SET status = 'revoked',
            revoked_by = $5,
            revoked_at = now()
      WHERE tenant_id = $1::uuid
        AND principal_sub = $2
        AND idp_provider = $3
        AND source = 'scim'
        AND status = 'active'
        AND NOT (role = ANY($4::text[]))`,
    [tenantId, input.sub, input.idpProvider, input.roles, actorSub],
  );
}

async function resolveScimRoles(client: PoolClient, tenantId: string, input: ScimPrincipalInput): Promise<ResolvedScimPrincipalInput> {
  if (input.roleSource === "roles") {
    return { ...input, externalGroups: null, roles: input.roles ?? [] };
  }

  const externalGroups = input.externalGroups ?? [];
  if (externalGroups.length === 0) {
    return { ...input, externalGroups, roles: [] };
  }

  const rows = await client.query<{ external_group: string; role: Role }>(
    `SELECT external_group, role
       FROM scim_group_role_mappings
      WHERE tenant_id = $1::uuid
        AND provider_key = $2::text
        AND external_group = ANY($3::text[])
        AND status = 'active'`,
    [tenantId, input.idpProvider, externalGroups],
  );
  const roleByGroup = new Map(rows.rows.map((row) => [row.external_group, row.role]));
  const unmapped = externalGroups.filter((group) => !roleByGroup.has(group));
  if (unmapped.length > 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "scim_group_role_unmapped",
      field: "external_groups",
      idp_provider: input.idpProvider,
      unmapped_external_groups: unmapped,
    });
  }

  const roles = uniqueRoles(externalGroups.map((group) => roleByGroup.get(group)).filter((role): role is Role => role !== undefined));
  return { ...input, externalGroups, roles };
}

function parseScimPrincipalInput(raw: unknown): ScimPrincipalInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  const allowed = new Set(["schema_version", "idp_provider", "external_id", "sub", "display_name", "email", "active", "roles", "external_groups"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unknown_field", field: key });
  }
  const schemaVersion = requiredString(raw.schema_version, "schema_version");
  if (schemaVersion !== SCIM_SCHEMA_REF) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unsupported_scim_schema_version", schema_version: schemaVersion });
  }
  const idpProvider = requiredString(raw.idp_provider, "idp_provider");
  const externalId = requiredString(raw.external_id, "external_id");
  const sub = requiredString(raw.sub, "sub");
  const displayName = requiredString(raw.display_name, "display_name");
  const email = raw.email === undefined || raw.email === null ? null : requiredString(raw.email, "email");
  const active = raw.active === undefined ? true : raw.active;
  if (typeof active !== "boolean") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_active", field: "active" });

  const hasRoles = hasOwn(raw, "roles");
  const hasExternalGroups = hasOwn(raw, "external_groups");
  if (hasRoles && hasExternalGroups) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "scim_role_source_conflict", fields: ["roles", "external_groups"] });
  }
  if (!hasRoles && !hasExternalGroups) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_scim_role_source", fields: ["roles", "external_groups"] });
  }

  if (hasRoles) {
    const roles = parseScimRoles(raw.roles);
    return { schemaVersion, idpProvider, externalId, sub, displayName, email, active, externalGroups: null, roleSource: "roles", roles };
  }

  const externalGroups = parseExternalGroups(raw.external_groups);
  return { schemaVersion, idpProvider, externalId, sub, displayName, email, active, externalGroups, roleSource: "external_groups", roles: null };
}

function parseCreateScimProviderBody(raw: unknown): CreateScimProviderBody {
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

function parseUpdateScimProviderBody(raw: unknown): UpdateScimProviderBody {
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

function parseDecommissionScimProviderBody(raw: unknown): DecommissionScimProviderBody {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  assertAllowedKeys(raw, ["reason"]);
  return { reason: requiredString(raw.reason, "reason") };
}

function parseCreateScimMappingBody(raw: unknown): CreateScimMappingBody {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  assertAllowedKeys(raw, ["external_group", "role", "description"]);
  return {
    externalGroup: requiredString(raw.external_group, "external_group"),
    role: parseRole(raw.role),
    description: parseOptionalText(raw.description, "description"),
  };
}

function parseImportScimMappingBody(raw: unknown): ImportScimMappingBody {
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

function parseUpdateScimMappingBody(raw: unknown): UpdateScimMappingBody {
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

function assertAllowedKeys(raw: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unknown_field", field: key });
  }
}

function parseProviderKey(value: string): string {
  const trimmed = value.trim();
  if (!SCIM_PROVIDER_KEY_RE.test(trimmed)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_provider_key", field: "provider_key" });
  }
  return trimmed;
}

function parseUuid(value: string): string {
  if (!UUID_RE.test(value)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return value;
}

function parseStatus(value: unknown): "active" | "disabled" {
  if (value === "active" || value === "disabled") return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_status", field: "status" });
}

function parseImportMode(value: unknown): ScimGroupRoleMappingImportMode {
  if (value === "upsert_only" || value === "replace_active") return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_scim_mapping_import_mode", field: "mode" });
}

function parseSecretRotationPolicy(value: unknown): ScimSecretRotationPolicy {
  if (SCIM_SECRET_ROTATION_POLICIES.includes(value as ScimSecretRotationPolicy)) return value as ScimSecretRotationPolicy;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_secret_rotation_policy", field: "secret_rotation_policy" });
}

function parseRole(value: unknown): Role {
  if (ROLES.includes(value as Role)) return value as Role;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_role", field: "role" });
}

function parseClockSkew(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 900) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_clock_skew_seconds", field: "clock_skew_seconds" });
  }
  return value;
}

function parseOptionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_string", field });
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function parseScimRoles(value: unknown): readonly Role[] {
  if (!Array.isArray(value) || value.some((role) => !ROLES.includes(role as Role))) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_roles", field: "roles" });
  }
  if (new Set(value).size !== value.length) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "duplicate_roles", field: "roles" });
  }
  return value as readonly Role[];
}

function parseExternalGroups(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_external_groups", field: "external_groups" });
  }
  const groups = value.map((group) => requiredString(group, "external_groups"));
  if (new Set(groups).size !== groups.length) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "duplicate_external_groups", field: "external_groups" });
  }
  return groups;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_string", field });
  }
  return value.trim();
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function uniqueRoles(roles: readonly Role[]): readonly Role[] {
  return [...new Set(roles)];
}

function requiredHeader(value: unknown, header: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiResponseError("UNAUTHENTICATED", { reason: "missing_scim_header", header });
  }
  return value.trim();
}

function scimSecretPrincipal(tenantId: string, providerKey: string) {
  return {
    subjectId: `api:scim:${providerKey}` as PrincipalId,
    tenantId: tenantId as TenantId,
    roles: [],
    source: "jwt" as const,
    claims: { runtime_identity: "api" },
  };
}

function scimRoleExternalId(externalId: string, role: Role): string {
  return `${externalId}:${role}`;
}

export function scimSigningPayload(
  timestamp: string,
  providerKey: string,
  schemaVersion: string,
  body: unknown,
): string {
  return `${timestamp}.POST./v1/scim/principals.${providerKey}.${schemaVersion}.${canonicalJson(body)}`;
}

function verifyScimSignature(secret: PlainSecret | string, signatureHeader: string, payload: string): boolean {
  const match = SCIM_SIGNATURE_RE.exec(signatureHeader);
  if (match === null) return false;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const provided = Buffer.from(match[1].toLowerCase(), "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "null";
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined) out[key] = canonicalize(item);
    }
    return out;
  }
  return value;
}
