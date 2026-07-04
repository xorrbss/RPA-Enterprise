// concurrency-policies.ts 에서 추출 — 정책 조회/본문 파서/리스 가드/이벤트 영속 헬퍼(동작 무변경).
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { isRecord } from "./command";
import { ApiResponseError } from "../runtime/errors";
import { UUID_RE } from "./server-shared";

export type CredentialStatus = "active" | "deprecated" | "revoked";
type RotationPolicy = "manual" | "periodic_30d" | "periodic_60d" | "periodic_90d";
export type CredentialEventType = "registered" | "updated" | "rotated_from" | "rotated_to" | "decommissioned";

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

export async function readConcurrencyPolicies(client: PoolClient, tenantId: string): Promise<readonly ConcurrencyPolicyItem[]> {
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

export function parseBody(raw: unknown): Record<string, unknown> {
  return isRecord(raw) ? raw : {};
}

export function rejectForbiddenSecretValue(body: Record<string, unknown>): void {
  const forbidden = FORBIDDEN_VALUE_FIELDS.find((field) => field in body);
  if (forbidden !== undefined) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_value_not_accepted", field: forbidden });
  }
}

export function parseCredentialRef(body: Record<string, unknown>, field: "credential_ref" | "new_credential_ref"): string {
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

export function parseSiteProfileId(body: Record<string, unknown>): string {
  const siteProfileId = typeof body.site_profile_id === "string" ? body.site_profile_id : "";
  if (!UUID_RE.test(siteProfileId)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_site_profile_id", field: "site_profile_id" });
  }
  return siteProfileId;
}

export function parseRequiredMaxConcurrency(body: Record<string, unknown>): number {
  const maxConcurrency =
    typeof body.max_concurrency === "number" && Number.isInteger(body.max_concurrency) ? body.max_concurrency : null;
  if (maxConcurrency === null || maxConcurrency < 1) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_max_concurrency", field: "max_concurrency" });
  }
  return maxConcurrency;
}

export function parseOptionalMaxConcurrency(body: Record<string, unknown>): number | undefined {
  if (!("max_concurrency" in body)) return undefined;
  return parseRequiredMaxConcurrency(body);
}

export function parseOptionalLabel(body: Record<string, unknown>): string | null {
  if (!("label" in body) || body.label === null || body.label === undefined) return null;
  if (typeof body.label !== "string") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_label", field: "label" });
  }
  const label = body.label.trim();
  return label.length > 0 ? label : null;
}

export function parseOwnerSub(body: Record<string, unknown>, fallback: string): string {
  if (!("owner_sub" in body) || body.owner_sub === null || body.owner_sub === undefined) return fallback;
  if (typeof body.owner_sub !== "string" || body.owner_sub.trim().length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_owner_sub", field: "owner_sub" });
  }
  return body.owner_sub.trim();
}

export function parseRotationPolicy(body: Record<string, unknown>, fallback: RotationPolicy): RotationPolicy {
  if (!("rotation_policy" in body) || body.rotation_policy === null || body.rotation_policy === undefined) return fallback;
  if (typeof body.rotation_policy !== "string" || !ROTATION_POLICIES.has(body.rotation_policy as RotationPolicy)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_rotation_policy", field: "rotation_policy" });
  }
  return body.rotation_policy as RotationPolicy;
}

export function parseReason(body: Record<string, unknown>): string | null {
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

export async function ensureSiteExists(client: PoolClient, tenantId: string, siteProfileId: string): Promise<void> {
  const site = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM site_profiles WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [tenantId, siteProfileId],
  );
  if (site.rows[0] === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
}

export async function ensureNoActiveCredentialLease(
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

export async function loadPolicyForUpdate(
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

export async function insertCredentialEvent(
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
