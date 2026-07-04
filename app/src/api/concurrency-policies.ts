import type { FastifyInstance } from "fastify";

import { withTenantTx } from "../db/pool";
import { isRecord, runIdempotentCommand } from "./command";
import { ApiResponseError } from "../runtime/errors";
import {
  ensureNoActiveCredentialLease,
  ensureSiteExists,
  insertCredentialEvent,
  loadPolicyForUpdate,
  parseBody,
  parseCredentialRef,
  parseOptionalLabel,
  parseOptionalMaxConcurrency,
  parseOwnerSub,
  parseReason,
  parseRequiredMaxConcurrency,
  parseRotationPolicy,
  parseSiteProfileId,
  readConcurrencyPolicies,
  rejectForbiddenSecretValue,
  type CredentialEventType,
  type CredentialStatus,
} from "./concurrency-policies-support";
import { appendGovernanceAudit } from "./role-assignments";
import { requirePrincipal, type ApiServerDeps, UUID_RE } from "./server-shared";

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
