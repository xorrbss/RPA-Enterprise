import type { FastifyInstance } from "fastify";

import { withTenantTx } from "../db/pool";
import { runIdempotentCommand } from "./command";
import { appendGovernanceAudit } from "./role-assignments";
import {
  createScimGroupRoleMapping,
  importScimGroupRoleMappings,
  listScimGroupRoleMappings,
  mapScimGroupRoleMapping,
  mapScimGroupRoleMappingImport,
  parseCreateScimMappingBody,
  parseImportScimMappingBody,
  parseUpdateScimMappingBody,
  updateScimGroupRoleMapping,
} from "./scim-group-mapping";
import { parseProviderKey, parseUuid } from "./scim-parse";
import {
  createScimProvider,
  decommissionScimProvider,
  listScimProviders,
  mapScimProvider,
  parseCreateScimProviderBody,
  parseDecommissionScimProviderBody,
  parseUpdateScimProviderBody,
  requireMutableScimProvider,
  requireScimProvider,
  updateScimProvider,
} from "./scim-providers";
import { verifyScimInboundBoundary } from "./scim-signature";
import { parseScimPrincipalInput, resolveScimRoles, syncScimRoles, upsertScimPrincipal } from "./scim-sync";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";

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
