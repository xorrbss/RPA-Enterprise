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

export function registerScimRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
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
