import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import type { Role } from "../../../ts/security-middleware-contract";
import { isRecord, runIdempotentCommand } from "./command";
import { ApiResponseError } from "./errors";
import { appendGovernanceAudit } from "./role-assignments";
import { requirePrincipal, type ApiServerDeps } from "./server";

const ROLES: readonly Role[] = ["viewer", "operator", "reviewer", "approver", "admin"];

interface ScimPrincipalInput {
  readonly idpProvider: string;
  readonly externalId: string;
  readonly sub: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly active: boolean;
  readonly roles: readonly Role[];
}

export function registerScimRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.post("/v1/scim/principals", { config: { rbacAction: "scim.sync" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const input = parseScimPrincipalInput(request.body);
    const result = await runIdempotentCommand(deps, request, "syncScimPrincipal", "/v1/scim/principals", async (client, tenantId) => {
      const saved = await client.query<{ id: string }>(
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
      if (input.active) {
        await syncScimRoles(client, tenantId, input, principal.subjectId);
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
          [tenantId, input.sub, input.idpProvider, principal.subjectId],
        );
      }
      await appendGovernanceAudit(client, request, "scim.sync", "allow", "scim_principal_synced", {
        principal_id: saved.rows[0]?.id ?? null,
        sub: input.sub,
        idp_provider: input.idpProvider,
        external_id: input.externalId,
        active: input.active,
        roles: input.roles,
      });
      return {
        status: 200,
        body: {
          principal_id: saved.rows[0]?.id ?? null,
          sub: input.sub,
          active: input.active,
          roles: input.active ? input.roles : [],
        },
      };
    });
    reply.code(result.status).send(result.body);
  });
}

async function syncScimRoles(
  client: { query: (sql: string, params?: readonly unknown[]) => Promise<{ rowCount: number | null }> },
  tenantId: string,
  input: ScimPrincipalInput,
  actorSub: string,
): Promise<void> {
  for (const role of input.roles) {
    await client.query(
      `INSERT INTO principal_role_assignments
          (id, tenant_id, principal_sub, role, source, external_id, idp_provider, lifecycle_source, status, granted_by, reason)
       SELECT $1::uuid, $2::uuid, $3, $4, 'scim', $5, $6, 'scim', 'active', $7, 'scim_sync'
        WHERE NOT EXISTS (
          SELECT 1
            FROM principal_role_assignments
           WHERE tenant_id = $2::uuid
             AND principal_sub = $3
             AND role = $4
             AND status = 'active'
        )`,
      [randomUUID(), tenantId, input.sub, role, input.externalId, input.idpProvider, actorSub],
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

function parseScimPrincipalInput(raw: unknown): ScimPrincipalInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  const allowed = new Set(["idp_provider", "external_id", "sub", "display_name", "email", "active", "roles"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unknown_field", field: key });
  }
  const idpProvider = requiredString(raw.idp_provider, "idp_provider");
  const externalId = requiredString(raw.external_id, "external_id");
  const sub = requiredString(raw.sub, "sub");
  const displayName = requiredString(raw.display_name, "display_name");
  const email = raw.email === undefined || raw.email === null ? null : requiredString(raw.email, "email");
  const active = raw.active === undefined ? true : raw.active;
  if (typeof active !== "boolean") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_active", field: "active" });
  if (!Array.isArray(raw.roles) || raw.roles.some((role) => !ROLES.includes(role as Role))) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_roles", field: "roles" });
  }
  return { idpProvider, externalId, sub, displayName, email, active, roles: raw.roles as readonly Role[] };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_string", field });
  }
  return value.trim();
}
