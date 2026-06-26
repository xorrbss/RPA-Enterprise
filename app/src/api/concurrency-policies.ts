import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import { isRecord, runIdempotentCommand } from "./command";
import { ApiResponseError } from "./errors";
import { appendGovernanceAudit } from "./role-assignments";
import { requirePrincipal, type ApiServerDeps } from "./server";

type CredentialStatus = "active" | "deprecated" | "revoked";
type RotationPolicy = "manual" | "periodic_30d" | "periodic_60d" | "periodic_90d";
type CredentialEventType = "registered" | "updated" | "rotated_from" | "rotated_to" | "decommissioned";

interface ConcurrencyPolicyRow {
  readonly credential_ref: string;
  readonly site_profile_id: string;
  readonly site_name: string | null;
  readonly max_concurrency: number;
  readonly active_leases: string;
  readonly label: string | null;
  readonly registered_by: string | null;
  readonly registered_at: Date;
  readonly status: CredentialStatus;
  readonly owner_sub: string | null;
  readonly scope: "site";
  readonly rotation_policy: RotationPolicy;
  readonly rotated_at: Date | null;
  readonly last_used_at: Date | null;
  readonly deprecated_at: Date | null;
  readonly revoked_at: Date | null;
  readonly replaced_by_credential_ref: string | null;
}

interface ConcurrencyPolicyItem {
  readonly credential_ref: string;
  readonly site_profile_id: string;
  readonly site_name: string | null;
  readonly max_concurrency: number;
  readonly active_leases: number;
  readonly label: string | null;
  readonly registered_by: string | null;
  readonly registered_at: string;
  readonly status: CredentialStatus;
  readonly owner_sub: string | null;
  readonly scope: "site";
  readonly rotation_policy: RotationPolicy;
  readonly rotated_at: string | null;
  readonly last_used_at: string | null;
  readonly deprecated_at: string | null;
  readonly revoked_at: string | null;
  readonly replaced_by_credential_ref: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREDENTIAL_PURPOSES = new Set(["executor"]);
const ROTATION_POLICIES = new Set<RotationPolicy>(["manual", "periodic_30d", "periodic_60d", "periodic_90d"]);
const MAX_REASON = 500;

const FORBIDDEN_VALUE_FIELDS = [
  "value",
  "secret",
  "secret_value",
  "password",
  "passphrase",
  "plaintext",
  "plain_secret",
  "token",
] as const;

function credentialRefDenial(ref: string): string | null {
  if (ref.includes("%")) return "percent-encoding not allowed";
  const segs = ref.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return "empty or path-traversal segment";
  if (segs.length < 5 || segs[0] !== "rpa") return "must follow rpa/<env>/<runtime>/<purpose>/<name>";
  if (!CREDENTIAL_PURPOSES.has(segs[3] ?? "")) return "purpose segment is not a credential purpose";
  return null;
}

export function registerConcurrencyPolicyRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/credentials/concurrency", { config: { rbacAction: "ops_alert.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const items = await withTenantTx(deps.pool, principal.tenantId, async (client) =>
      readConcurrencyPolicies(client, principal.tenantId),
    );
    reply.code(200).send({ items, next_cursor: null });
  });

  app.post("/v1/credentials", { config: { rbacAction: "credential.manage" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseBody(request.body);
    rejectForbiddenSecretValue(body);
    const credentialRef = parseCredentialRef(body, "credential_ref");
    const siteProfileId = parseSiteProfileId(body);
    const maxConcurrency = parseRequiredMaxConcurrency(body);
    const label = parseOptionalLabel(body);
    const ownerSub = parseOwnerSub(body, principal.subjectId);
    const rotationPolicy = parseRotationPolicy(body, "manual");
    const result = await runIdempotentCommand(
      deps,
      request,
      "registerCredentialBinding",
      `/v1/credentials/${encodeURIComponent(credentialRef)}/${siteProfileId}`,
      async (client, tenantId) => {
        await ensureSiteExists(client, tenantId, siteProfileId);
        const existing = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM credential_concurrency_policies
              WHERE tenant_id = $1::uuid AND credential_ref = $2 AND site_profile_id = $3::uuid
           ) AS exists`,
          [tenantId, credentialRef, siteProfileId],
        );
        await client.query(
          `INSERT INTO credential_concurrency_policies
             (tenant_id, credential_ref, site_profile_id, max_concurrency, label, registered_by, registered_at,
              status, owner_sub, scope, rotation_policy, deprecated_at, revoked_at, replaced_by_credential_ref)
           VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, now(), 'active', $7, 'site', $8, NULL, NULL, NULL)
           ON CONFLICT (tenant_id, credential_ref, site_profile_id)
             DO UPDATE SET max_concurrency = EXCLUDED.max_concurrency,
                           label = EXCLUDED.label,
                           registered_by = EXCLUDED.registered_by,
                           registered_at = now(),
                           status = 'active',
                           owner_sub = EXCLUDED.owner_sub,
                           scope = 'site',
                           rotation_policy = EXCLUDED.rotation_policy,
                           deprecated_at = NULL,
                           revoked_at = NULL,
                           replaced_by_credential_ref = NULL`,
          [tenantId, credentialRef, siteProfileId, maxConcurrency, label, principal.subjectId, ownerSub, rotationPolicy],
        );
        const eventType: CredentialEventType = existing.rows[0]?.exists === true ? "updated" : "registered";
        await insertCredentialEvent(client, tenantId, credentialRef, siteProfileId, eventType, principal.subjectId, null, null);
        await appendGovernanceAudit(client, request, "credential.manage", "allow", `credential_binding_${eventType}`, {
          credential_ref: credentialRef,
          site_profile_id: siteProfileId,
          max_concurrency: maxConcurrency,
          status: "active",
          owner_sub: ownerSub,
          scope: "site",
          rotation_policy: rotationPolicy,
        });
        return {
          status: 200,
          body: {
            credential_ref: credentialRef,
            site_profile_id: siteProfileId,
            max_concurrency: maxConcurrency,
            label,
            status: "active",
            owner_sub: ownerSub,
            scope: "site",
            rotation_policy: rotationPolicy,
          },
        };
      },
    );
    reply.code(result.status).send(result.body);
  });

  app.post("/v1/credentials/rotate", { config: { rbacAction: "credential.manage" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseBody(request.body);
    rejectForbiddenSecretValue(body);
    const credentialRef = parseCredentialRef(body, "credential_ref");
    const newCredentialRef = parseCredentialRef(body, "new_credential_ref");
    const siteProfileId = parseSiteProfileId(body);
    if (newCredentialRef === credentialRef) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "replacement_must_differ", field: "new_credential_ref" });
    }
    const maxConcurrency = parseOptionalMaxConcurrency(body);
    const label = "label" in body ? parseOptionalLabel(body) : undefined;
    const rotationPolicy = "rotation_policy" in body ? parseRotationPolicy(body, "manual") : undefined;
    const reason = parseReason(body);
    const result = await runIdempotentCommand(
      deps,
      request,
      "rotateCredentialBinding",
      `/v1/credentials/${encodeURIComponent(credentialRef)}/${siteProfileId}/rotate/${encodeURIComponent(newCredentialRef)}`,
      async (client, tenantId) => {
        const current = await loadPolicyForUpdate(client, tenantId, credentialRef, siteProfileId);
        if (current.status !== "active") {
          throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "credential_not_active", status: current.status });
        }
        await ensureNoActiveCredentialLease(client, tenantId, credentialRef, siteProfileId);
        const nextMax = maxConcurrency ?? current.max_concurrency;
        const nextLabel = label !== undefined ? label : current.label;
        const nextOwner = current.owner_sub ?? principal.subjectId;
        const nextRotationPolicy = rotationPolicy ?? current.rotation_policy;
        try {
          await client.query(
            `INSERT INTO credential_concurrency_policies
               (tenant_id, credential_ref, site_profile_id, max_concurrency, label, registered_by, registered_at,
                status, owner_sub, scope, rotation_policy, rotated_at)
             VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, now(), 'active', $7, 'site', $8, now())`,
            [tenantId, newCredentialRef, siteProfileId, nextMax, nextLabel, principal.subjectId, nextOwner, nextRotationPolicy],
          );
        } catch (err) {
          if (isRecord(err) && (err as { code?: unknown }).code === "23505") {
            throw new ApiResponseError("IR_SCHEMA_INVALID", {
              reason: "replacement_credential_ref_exists",
              field: "new_credential_ref",
            });
          }
          throw err;
        }
        await client.query(
          `UPDATE credential_concurrency_policies
              SET status = 'deprecated',
                  deprecated_at = now(),
                  rotated_at = now(),
                  replaced_by_credential_ref = $4
            WHERE tenant_id = $1::uuid AND credential_ref = $2 AND site_profile_id = $3::uuid`,
          [tenantId, credentialRef, siteProfileId, newCredentialRef],
        );
        await insertCredentialEvent(
          client,
          tenantId,
          credentialRef,
          siteProfileId,
          "rotated_from",
          principal.subjectId,
          reason,
          newCredentialRef,
        );
        await insertCredentialEvent(
          client,
          tenantId,
          newCredentialRef,
          siteProfileId,
          "rotated_to",
          principal.subjectId,
          reason,
          credentialRef,
        );
        await appendGovernanceAudit(client, request, "credential.manage", "allow", "credential_binding_rotated", {
          credential_ref: credentialRef,
          replacement_credential_ref: newCredentialRef,
          site_profile_id: siteProfileId,
          previous_status: "deprecated",
          replacement_status: "active",
          rotation_policy: nextRotationPolicy,
        });
        return {
          status: 200,
          body: {
            credential_ref: credentialRef,
            site_profile_id: siteProfileId,
            status: "deprecated",
            replaced_by_credential_ref: newCredentialRef,
            replacement: {
              credential_ref: newCredentialRef,
              site_profile_id: siteProfileId,
              max_concurrency: nextMax,
              label: nextLabel,
              status: "active",
              owner_sub: nextOwner,
              scope: "site",
              rotation_policy: nextRotationPolicy,
            },
          },
        };
      },
    );
    reply.code(result.status).send(result.body);
  });

  app.post("/v1/credentials/decommission", { config: { rbacAction: "credential.manage" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseBody(request.body);
    rejectForbiddenSecretValue(body);
    const credentialRef = parseCredentialRef(body, "credential_ref");
    const siteProfileId = parseSiteProfileId(body);
    const reason = parseReason(body);
    const result = await runIdempotentCommand(
      deps,
      request,
      "decommissionCredentialBinding",
      `/v1/credentials/${encodeURIComponent(credentialRef)}/${siteProfileId}/decommission`,
      async (client, tenantId) => {
        const current = await loadPolicyForUpdate(client, tenantId, credentialRef, siteProfileId);
        if (current.status === "revoked") {
          throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "credential_already_revoked" });
        }
        await ensureNoActiveCredentialLease(client, tenantId, credentialRef, siteProfileId);
        await client.query(
          `UPDATE credential_concurrency_policies
              SET status = 'revoked',
                  revoked_at = now()
            WHERE tenant_id = $1::uuid AND credential_ref = $2 AND site_profile_id = $3::uuid`,
          [tenantId, credentialRef, siteProfileId],
        );
        await insertCredentialEvent(client, tenantId, credentialRef, siteProfileId, "decommissioned", principal.subjectId, reason, null);
        await appendGovernanceAudit(client, request, "credential.manage", "allow", "credential_binding_decommissioned", {
          credential_ref: credentialRef,
          site_profile_id: siteProfileId,
          previous_status: current.status,
          status: "revoked",
        });
        return { status: 200, body: { credential_ref: credentialRef, site_profile_id: siteProfileId, status: "revoked" } };
      },
    );
    reply.code(result.status).send(result.body);
  });

  app.delete<{ Querystring: { credential_ref?: string; site_profile_id?: string } }>(
    "/v1/credentials",
    { config: { rbacAction: "credential.manage" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const credentialRef = typeof request.query.credential_ref === "string" ? request.query.credential_ref.trim() : "";
      const siteProfileId = typeof request.query.site_profile_id === "string" ? request.query.site_profile_id : "";
      if (credentialRef.length === 0) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_credential_ref", field: "credential_ref" });
      }
      if (!UUID_RE.test(siteProfileId)) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_site_profile_id", field: "site_profile_id" });
      }
      const result = await runIdempotentCommand(
        deps,
        request,
        "deleteCredentialBinding",
        `/v1/credentials/${encodeURIComponent(credentialRef)}/${siteProfileId}`,
        async (client, tenantId) => {
          await ensureNoActiveCredentialLease(client, tenantId, credentialRef, siteProfileId);
          const del = await client.query<{
            label: string | null;
            status: CredentialStatus;
          }>(
            `DELETE FROM credential_concurrency_policies
              WHERE tenant_id = $1::uuid AND credential_ref = $2 AND site_profile_id = $3::uuid
              RETURNING label, status`,
            [tenantId, credentialRef, siteProfileId],
          );
          const deleted = del.rows[0];
          if (deleted === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
          await insertCredentialEvent(client, tenantId, credentialRef, siteProfileId, "decommissioned", principal.subjectId, null, null);
          await appendGovernanceAudit(client, request, "credential.manage", "allow", "credential_binding_deleted", {
            credential_ref: credentialRef,
            site_profile_id: siteProfileId,
            previous_status: deleted.status,
          });
          return { status: 200, body: { credential_ref: credentialRef, site_profile_id: siteProfileId, deleted: true } };
        },
      );
      reply.code(result.status).send(result.body);
    },
  );
}

async function readConcurrencyPolicies(client: PoolClient, tenantId: string): Promise<readonly ConcurrencyPolicyItem[]> {
  const result = await client.query<ConcurrencyPolicyRow>(
    `SELECT
        p.credential_ref,
        p.site_profile_id::text AS site_profile_id,
        sp.name AS site_name,
        p.max_concurrency,
        COALESCE(l.active_leases, 0)::text AS active_leases,
        p.label,
        p.registered_by,
        p.registered_at,
        p.status,
        p.owner_sub,
        p.scope,
        p.rotation_policy,
        p.rotated_at,
        p.last_used_at,
        p.deprecated_at,
        p.revoked_at,
        p.replaced_by_credential_ref
       FROM credential_concurrency_policies p
       LEFT JOIN site_profiles sp ON sp.tenant_id = p.tenant_id AND sp.id = p.site_profile_id
       LEFT JOIN (
         SELECT credential_ref, site_profile_id, count(*) AS active_leases
           FROM credential_leases
          WHERE tenant_id = $1::uuid AND status = 'active' AND locked_until > now()
          GROUP BY credential_ref, site_profile_id
       ) l ON l.credential_ref = p.credential_ref AND l.site_profile_id = p.site_profile_id
      WHERE p.tenant_id = $1::uuid
      ORDER BY sp.name NULLS LAST, p.credential_ref`,
    [tenantId],
  );
  return result.rows.map(mapPolicy);
}

function mapPolicy(row: ConcurrencyPolicyRow): ConcurrencyPolicyItem {
  return {
    credential_ref: row.credential_ref,
    site_profile_id: row.site_profile_id,
    site_name: row.site_name,
    max_concurrency: row.max_concurrency,
    active_leases: Number(row.active_leases),
    label: row.label,
    registered_by: row.registered_by,
    registered_at: row.registered_at.toISOString(),
    status: row.status,
    owner_sub: row.owner_sub,
    scope: row.scope,
    rotation_policy: row.rotation_policy,
    rotated_at: row.rotated_at?.toISOString() ?? null,
    last_used_at: row.last_used_at?.toISOString() ?? null,
    deprecated_at: row.deprecated_at?.toISOString() ?? null,
    revoked_at: row.revoked_at?.toISOString() ?? null,
    replaced_by_credential_ref: row.replaced_by_credential_ref,
  };
}

function parseBody(raw: unknown): Record<string, unknown> {
  return isRecord(raw) ? raw : {};
}

function rejectForbiddenSecretValue(body: Record<string, unknown>): void {
  const forbidden = FORBIDDEN_VALUE_FIELDS.find((field) => field in body);
  if (forbidden !== undefined) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_value_not_accepted", field: forbidden });
  }
}

function parseCredentialRef(body: Record<string, unknown>, field: "credential_ref" | "new_credential_ref"): string {
  const credentialRef = typeof body[field] === "string" ? body[field].trim() : "";
  if (credentialRef.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `missing_${field}`, field });
  }
  const refDenial = credentialRefDenial(credentialRef);
  if (refDenial !== null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "credential_ref_invalid", detail: refDenial, field });
  }
  return credentialRef;
}

function parseSiteProfileId(body: Record<string, unknown>): string {
  const siteProfileId = typeof body.site_profile_id === "string" ? body.site_profile_id : "";
  if (!UUID_RE.test(siteProfileId)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_site_profile_id", field: "site_profile_id" });
  }
  return siteProfileId;
}

function parseRequiredMaxConcurrency(body: Record<string, unknown>): number {
  const maxConcurrency =
    typeof body.max_concurrency === "number" && Number.isInteger(body.max_concurrency) ? body.max_concurrency : null;
  if (maxConcurrency === null || maxConcurrency < 1) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_max_concurrency", field: "max_concurrency" });
  }
  return maxConcurrency;
}

function parseOptionalMaxConcurrency(body: Record<string, unknown>): number | undefined {
  if (!("max_concurrency" in body)) return undefined;
  return parseRequiredMaxConcurrency(body);
}

function parseOptionalLabel(body: Record<string, unknown>): string | null {
  if (!("label" in body) || body.label === null || body.label === undefined) return null;
  if (typeof body.label !== "string") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_label", field: "label" });
  }
  const label = body.label.trim();
  return label.length > 0 ? label : null;
}

function parseOwnerSub(body: Record<string, unknown>, fallback: string): string {
  if (!("owner_sub" in body) || body.owner_sub === null || body.owner_sub === undefined) return fallback;
  if (typeof body.owner_sub !== "string" || body.owner_sub.trim().length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_owner_sub", field: "owner_sub" });
  }
  return body.owner_sub.trim();
}

function parseRotationPolicy(body: Record<string, unknown>, fallback: RotationPolicy): RotationPolicy {
  if (!("rotation_policy" in body) || body.rotation_policy === null || body.rotation_policy === undefined) return fallback;
  if (typeof body.rotation_policy !== "string" || !ROTATION_POLICIES.has(body.rotation_policy as RotationPolicy)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_rotation_policy", field: "rotation_policy" });
  }
  return body.rotation_policy as RotationPolicy;
}

function parseReason(body: Record<string, unknown>): string | null {
  if (!("reason" in body) || body.reason === null || body.reason === undefined) return null;
  if (typeof body.reason !== "string") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_reason", field: "reason" });
  }
  const reason = body.reason.trim();
  if (reason.length === 0) return null;
  if (reason.length > MAX_REASON) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "reason_too_long", field: "reason" });
  }
  return reason;
}

async function ensureSiteExists(client: PoolClient, tenantId: string, siteProfileId: string): Promise<void> {
  const site = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM site_profiles WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [tenantId, siteProfileId],
  );
  if (site.rows[0] === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
}

async function ensureNoActiveCredentialLease(
  client: PoolClient,
  tenantId: string,
  credentialRef: string,
  siteProfileId: string,
): Promise<void> {
  const active = await client.query(
    `SELECT 1 FROM credential_leases
      WHERE tenant_id = $1::uuid AND credential_ref = $2 AND site_profile_id = $3::uuid
        AND status = 'active' AND locked_until > now() LIMIT 1`,
    [tenantId, credentialRef, siteProfileId],
  );
  if (active.rows[0] !== undefined) {
    throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", { reason: "active_credential_leases" });
  }
}

async function loadPolicyForUpdate(
  client: PoolClient,
  tenantId: string,
  credentialRef: string,
  siteProfileId: string,
): Promise<ConcurrencyPolicyRow> {
  const result = await client.query<ConcurrencyPolicyRow>(
    `SELECT
        p.credential_ref,
        p.site_profile_id::text AS site_profile_id,
        NULL::text AS site_name,
        p.max_concurrency,
        '0'::text AS active_leases,
        p.label,
        p.registered_by,
        p.registered_at,
        p.status,
        p.owner_sub,
        p.scope,
        p.rotation_policy,
        p.rotated_at,
        p.last_used_at,
        p.deprecated_at,
        p.revoked_at,
        p.replaced_by_credential_ref
       FROM credential_concurrency_policies p
      WHERE p.tenant_id = $1::uuid AND p.credential_ref = $2 AND p.site_profile_id = $3::uuid
      FOR UPDATE`,
    [tenantId, credentialRef, siteProfileId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return row;
}

async function insertCredentialEvent(
  client: PoolClient,
  tenantId: string,
  credentialRef: string,
  siteProfileId: string,
  eventType: CredentialEventType,
  actorSub: string,
  reason: string | null,
  replacementCredentialRef: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO credential_binding_events
       (id, tenant_id, credential_ref, site_profile_id, event_type, actor_sub, reason, replacement_credential_ref)
     VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8)`,
    [randomUUID(), tenantId, credentialRef, siteProfileId, eventType, actorSub, reason, replacementCredentialRef],
  );
}
