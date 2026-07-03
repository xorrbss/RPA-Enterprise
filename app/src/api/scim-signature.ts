import { createHmac, timingSafeEqual } from "node:crypto";

import type { PlainSecret, SecretRef } from "../../../ts/core-types";
import type { PrincipalId, TenantId } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { isRecord } from "./command";
import { ApiResponseError } from "../runtime/errors";
import { loadScimProvider, type ScimProviderRow } from "./scim-providers";
import type { ScimPrincipalInput } from "./scim-sync";
import type { ApiServerDeps } from "./server-shared";

const SCIM_SIGNATURE_RE = /^sha256=([a-f0-9]{64})$/i;

export async function verifyScimInboundBoundary(
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

// [R2-5 동결] SCIM 인바운드 HMAC 서명 페이로드의 바이트 형식 — 외부 IdP 계약. raw-hash 와 달리 NFC 없음.
//   통합/변경 금지(서명 검증 전면 파손).
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
