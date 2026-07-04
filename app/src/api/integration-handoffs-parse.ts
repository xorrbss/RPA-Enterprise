import type { AuthenticatedPrincipal, PrincipalId, TenantId } from "../../../ts/security-middleware-contract";
import { isRecord } from "./command";
import { ApiResponseError } from "../runtime/errors";
import type {
  IntegrationHandoffCallbackInput,
  IntegrationHandoffCreateInput,
  IntegrationHandoffDispatchInput,
  IntegrationHandoffReceiptStatus,
  IntegrationHandoffStatus,
} from "./integration-handoffs-store";
import { UUID_RE } from "./server-shared";

const MAX_PROVIDER_CALLBACK_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;
const PROVIDER_CALLBACK_EVENT_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

export interface IntegrationHandoffCallbackHeaders {
  readonly eventId: string;
  readonly timestamp: string;
  readonly signature: string;
}

export function parseCreateRequest(raw: unknown): IntegrationHandoffCreateInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "integration_handoff_body_expected_object" });
  assertAllowedKeys(raw, ["provider_alias", "job_ref", "payload_ref", "callback_url_secret_ref", "callback_signature_secret_ref", "legal_hold"]);
  return {
    providerAlias: parseSafeString(raw.provider_alias, "provider_alias", 1, 120),
    jobRef: parseSafeString(raw.job_ref, "job_ref", 1, 300),
    payloadRef: parseSafeString(raw.payload_ref, "payload_ref", 1, 500),
    callbackUrlSecretRef: parseNullableSecretRef(raw.callback_url_secret_ref, "callback_url_secret_ref"),
    callbackSignatureSecretRef: parseNullableSecretRef(raw.callback_signature_secret_ref, "callback_signature_secret_ref"),
    legalHold: raw.legal_hold === undefined ? false : parseBoolean(raw.legal_hold, "legal_hold"),
  };
}

export function parseDispatchRequest(raw: unknown): IntegrationHandoffDispatchInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "integration_handoff_dispatch_body_expected_object" });
  assertAllowedKeys(raw, ["endpoint_secret_ref", "allowed_hosts", "max_attempts", "metadata", "legal_hold"]);
  return {
    endpointSecretRef: parseSecretRef(raw.endpoint_secret_ref, "endpoint_secret_ref"),
    allowedHosts: parseAllowedHosts(raw.allowed_hosts),
    maxAttempts: raw.max_attempts === undefined ? 3 : parseInteger(raw.max_attempts, "max_attempts", 1, 20),
    metadata: parseMetadata(raw.metadata),
    legalHold: raw.legal_hold === undefined ? false : parseBoolean(raw.legal_hold, "legal_hold"),
  };
}

export function parseCallbackRequest(raw: unknown): IntegrationHandoffCallbackInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "integration_handoff_callback_body_expected_object" });
  assertAllowedKeys(raw, ["external_job_id", "status", "receipt_id", "error_code", "legal_hold"]);
  const status = parseReceiptStatus(raw.status);
  const errorCode = raw.error_code === undefined || raw.error_code === null || raw.error_code === ""
    ? null
    : parseSafeString(raw.error_code, "error_code", 1, 120);
  if (status === "failed" && errorCode === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "error_code_required_for_failed_handoff" });
  }
  if ((status === "accepted" || status === "completed") && errorCode !== null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "error_code_for_successful_handoff_forbidden" });
  }
  return {
    externalJobId: parseSafeString(raw.external_job_id, "external_job_id", 1, 200),
    status,
    receiptId: parseSafeString(raw.receipt_id, "receipt_id", 1, 200),
    errorCode,
    legalHold: raw.legal_hold === undefined ? false : parseBoolean(raw.legal_hold, "legal_hold"),
  };
}

export function parseStatusFilter(raw: unknown): IntegrationHandoffStatus | undefined {
  if (raw === undefined) return undefined;
  if (raw === "accepted" || raw === "deferred" || raw === "completed" || raw === "failed" || raw === "cancelled") {
    return raw;
  }
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_integration_handoff_status" });
}

function parseReceiptStatus(raw: unknown): IntegrationHandoffReceiptStatus {
  if (raw === "accepted" || raw === "completed" || raw === "failed" || raw === "cancelled") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_integration_handoff_callback_status" });
}

export function parseUuid(raw: unknown, field: string): string {
  if (typeof raw === "string" && UUID_RE.test(raw)) return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

export function parseUuidNotFound(raw: unknown, field: string): string {
  if (typeof raw === "string" && UUID_RE.test(raw)) return raw;
  throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: `invalid_${field}` });
}

export function parseProviderCallbackHeaders(headers: Record<string, unknown>): IntegrationHandoffCallbackHeaders {
  const eventId = requireHeader(headers["x-rpa-integration-event-id"], "x-rpa-integration-event-id");
  if (!PROVIDER_CALLBACK_EVENT_ID_RE.test(eventId)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_integration_handoff_event_id" });
  }
  const timestamp = requireHeader(headers["x-rpa-integration-timestamp"], "x-rpa-integration-timestamp");
  parseProviderCallbackTimestamp(timestamp);
  const signature = requireHeader(headers["x-rpa-integration-signature"], "x-rpa-integration-signature");
  return { eventId, timestamp, signature };
}

function parseProviderCallbackTimestamp(value: string): void {
  if (!/^\d{10,13}$/.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_integration_handoff_timestamp" });
  }
  const numeric = Number(value);
  const millis = value.length === 13 ? numeric : numeric * 1000;
  const parsed = new Date(millis);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_integration_handoff_timestamp" });
  }
  if (Math.abs(Date.now() - parsed.getTime()) > MAX_PROVIDER_CALLBACK_TIMESTAMP_SKEW_MS) {
    throw new ApiResponseError("UNAUTHENTICATED", { reason: "integration_handoff_timestamp_outside_window" });
  }
}

function requireHeader(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_integration_handoff_header", header: name });
}

export function integrationHandoffCallbackPrincipal(tenantId: string): AuthenticatedPrincipal {
  return {
    subjectId: "api:integration-handoff-callback" as PrincipalId,
    tenantId: tenantId as TenantId,
    roles: [],
    source: "jwt",
    claims: { runtime_identity: "api" },
  };
}

function parseNullableSecretRef(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || !raw.startsWith("secret://") || raw.length <= "secret://".length || raw.length > 500) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  }
  assertSafeString(raw, field);
  return raw;
}

function parseSecretRef(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !raw.startsWith("secret://") || raw.length <= "secret://".length || raw.length > 500) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  }
  assertSafeString(raw, field);
  return raw;
}

function parseAllowedHosts(raw: unknown): readonly string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_allowed_hosts" });
  }
  const seen = new Set<string>();
  const hosts: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_allowed_host" });
    const host = item.trim().toLowerCase();
    if (
      host.length === 0 ||
      host.length > 253 ||
      host.includes("/") ||
      host.includes(":") ||
      host.includes("*") ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      /^[0-9.]+$/.test(host) ||
      !/^[a-z0-9.-]+$/.test(host) ||
      host.startsWith(".") ||
      host.endsWith(".")
    ) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_allowed_host", host: item });
    }
    if (!seen.has(host)) {
      seen.add(host);
      hosts.push(host);
    }
  }
  return hosts;
}

function parseInteger(raw: unknown, field: string, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  }
  return raw;
}

function parseMetadata(raw: unknown): Readonly<Record<string, unknown>> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_metadata" });
  assertSafeMetadata(raw, "metadata", 0);
  return raw;
}

function assertSafeMetadata(value: unknown, field: string, depth: number): void {
  if (depth > 4) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_too_deep", field });
  if (typeof value === "string") {
    assertSafeString(value, field);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 50) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_array_too_large", field });
    value.forEach((item, index) => assertSafeMetadata(item, `${field}.${index}`, depth + 1));
    return;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > 50) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_object_too_large", field });
    for (const [key, child] of entries) {
      if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || forbiddenEvidenceKey(key)) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_secret_or_endpoint_key_forbidden", field: `${field}.${key}` });
      }
      assertSafeMetadata(child, `${field}.${key}`, depth + 1);
    }
  }
}

export function parseSafeString(raw: unknown, field: string, min: number, max: number): string {
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  const value = raw.trim();
  if (value.length < min || value.length > max) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  assertSafeString(value, field);
  return value;
}

function parseBoolean(raw: unknown, field: string): boolean {
  if (typeof raw === "boolean") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function assertAllowedKeys(raw: Record<string, unknown>, allowed: readonly string[]): void {
  const set = new Set(allowed);
  for (const key of Object.keys(raw)) {
    if (!set.has(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "integration_handoff_unknown_field", field: key });
    }
  }
}

function assertSafeString(value: string, field: string): void {
  if (/https?:\/\//i.test(value) || /hooks\.slack\.com/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "raw_endpoint_url_forbidden", field });
  }
  if (/\bbearer\s+[a-z0-9._~+/=-]{8,}/i.test(value) || /\b(token|password|secret)=/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_material_forbidden", field });
  }
}

function forbiddenEvidenceKey(key: string): boolean {
  return /(^|[_.-])(api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|credential|authorization|cookie|webhook_url|endpoint_url|url|dsn|smtp|raw_payload|request_payload|response_payload|payload|body|raw_body|provider_response|provider_body)([_.-]|$)/i.test(key);
}

export function requireIdempotencyHeader(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_idempotency_key", header: "Idempotency-Key" });
  }
  return raw;
}
