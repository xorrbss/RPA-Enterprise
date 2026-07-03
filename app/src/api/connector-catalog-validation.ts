import { ApiResponseError } from "../runtime/errors";
import { isRecord } from "./command";
import { UUID_RE } from "./server-shared";

export type ConnectorCertificationStatus = "security_review" | "certified" | "blocked" | "revoked";
export type ConnectorEnvironment = "dev" | "staging" | "prod";

export interface ConnectorReceiptSemantics {
  readonly sent: "not_applicable" | "metadata_only" | "provider_receipt_required";
  readonly accepted: "not_applicable" | "metadata_only" | "provider_receipt_required";
  readonly delivered: "not_applicable" | "metadata_only" | "provider_receipt_required";
  readonly completed: "not_applicable" | "metadata_only" | "business_receipt_required";
}

export interface ConnectorProfileCreateInput {
  readonly connectorId: string;
  readonly profileName: string;
  readonly environment: ConnectorEnvironment;
  readonly secretRefs: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly ownerRef: string;
  readonly supportOwnerRef: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ConnectorCertificationInput {
  readonly status: ConnectorCertificationStatus;
  readonly reason: string;
  readonly manifestRef: string | null;
  readonly securityReviewRef: string | null;
  readonly testEvidenceRef: string | null;
  readonly ownerEvidenceRef: string | null;
  readonly receiptSemantics: ConnectorReceiptSemantics;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export function parseConnectorProfileCreateRequest(raw: unknown): ConnectorProfileCreateInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "connector_profile_body_expected_object" });
  assertAllowedKeys(raw, ["connector_id", "profile_name", "environment", "secret_refs", "allowed_hosts", "owner_ref", "support_owner_ref", "metadata"]);
  const connectorId = parseConnectorId(raw.connector_id);
  return {
    connectorId,
    profileName: parseSafeText(raw.profile_name, "profile_name", 1, 120),
    environment: parseEnvironment(raw.environment),
    secretRefs: parseSecretRefs(raw.secret_refs),
    allowedHosts: parseAllowedHosts(raw.allowed_hosts),
    ownerRef: requireOne(parseEvidenceRef(raw.owner_ref, "owner_ref", true), "connector_profile_owner_ref_missing"),
    supportOwnerRef: parseEvidenceRef(raw.support_owner_ref, "support_owner_ref", false),
    metadata: parseSafeMetadata(raw.metadata),
  };
}

export function parseConnectorCertificationRequest(raw: unknown): ConnectorCertificationInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "connector_certification_body_expected_object" });
  assertAllowedKeys(raw, [
    "status",
    "reason",
    "manifest_ref",
    "security_review_ref",
    "test_evidence_ref",
    "owner_evidence_ref",
    "receipt_semantics",
    "metadata",
  ]);
  return {
    status: parseCertificationStatus(raw.status),
    reason: parseSafeText(raw.reason, "reason", 1, 500),
    manifestRef: parseEvidenceRef(raw.manifest_ref, "manifest_ref", false),
    securityReviewRef: parseEvidenceRef(raw.security_review_ref, "security_review_ref", false),
    testEvidenceRef: parseEvidenceRef(raw.test_evidence_ref, "test_evidence_ref", false),
    ownerEvidenceRef: parseEvidenceRef(raw.owner_evidence_ref, "owner_evidence_ref", false),
    receiptSemantics: parseReceiptSemantics(raw.receipt_semantics),
    metadata: parseSafeMetadata(raw.metadata),
  };
}

function parseConnectorId(raw: unknown): string {
  const value = parseSafeText(raw, "connector_id", 1, 120);
  if (!/^[a-z0-9][a-z0-9_.-]{1,120}$/.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_connector_id" });
  }
  return value;
}

function parseEnvironment(raw: unknown): ConnectorEnvironment {
  if (raw === undefined) return "dev";
  if (raw === "dev" || raw === "staging" || raw === "prod") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_connector_profile_environment" });
}

function parseCertificationStatus(raw: unknown): ConnectorCertificationStatus {
  if (raw === "security_review" || raw === "certified" || raw === "blocked" || raw === "revoked") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_connector_certification_status" });
}

function parseSecretRefs(raw: unknown): readonly string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 20) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_connector_profile_secret_refs" });
  }
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const item of raw) {
    const ref = parseSecretRef(item, "secret_refs");
    if (!seen.has(ref)) {
      seen.add(ref);
      refs.push(ref);
    }
  }
  return refs;
}

function parseSecretRef(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !raw.startsWith("secret://") || raw.length <= "secret://".length || raw.length > 500) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  }
  assertNoRawSecretOrEndpoint(raw, field);
  return raw;
}

function parseAllowedHosts(raw: unknown): readonly string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 20) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_connector_profile_allowed_hosts" });
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

function parseEvidenceRef(raw: unknown, field: string, required: boolean): string | null {
  if (raw === undefined || raw === null || raw === "") {
    if (required) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `${field}_required` });
    return null;
  }
  return parseSafeText(raw, field, 1, 500);
}

function parseSafeMetadata(raw: unknown): Readonly<Record<string, unknown>> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_connector_metadata" });
  assertSafeMetadata(raw, "metadata", 0);
  return raw;
}

function parseReceiptSemantics(raw: unknown): ConnectorReceiptSemantics {
  if (raw === undefined) return defaultReceiptSemantics();
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_receipt_semantics" });
  assertAllowedKeys(raw, ["sent", "accepted", "delivered", "completed"]);
  return {
    sent: parseReceiptLeg(raw.sent, "sent", ["not_applicable", "metadata_only", "provider_receipt_required"]),
    accepted: parseReceiptLeg(raw.accepted, "accepted", ["not_applicable", "metadata_only", "provider_receipt_required"]),
    delivered: parseReceiptLeg(raw.delivered, "delivered", ["not_applicable", "metadata_only", "provider_receipt_required"]),
    completed: parseReceiptLeg(raw.completed, "completed", ["not_applicable", "metadata_only", "business_receipt_required"]),
  };
}

function parseReceiptLeg<T extends string>(raw: unknown, field: string, allowed: readonly T[]): T {
  if (typeof raw !== "string" || !allowed.includes(raw as T)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_receipt_semantics_${field}` });
  }
  return raw as T;
}

export function defaultReceiptSemantics(): ConnectorReceiptSemantics {
  return {
    sent: "metadata_only",
    accepted: "provider_receipt_required",
    delivered: "provider_receipt_required",
    completed: "business_receipt_required",
  };
}

export function assertCertificationEvidence(input: ConnectorCertificationInput): void {
  if (input.status !== "certified") return;
  if (
    input.manifestRef === null ||
    input.securityReviewRef === null ||
    input.testEvidenceRef === null ||
    input.ownerEvidenceRef === null
  ) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "connector_certification_evidence_required" });
  }
}

export function parseUuid(raw: unknown, field: string): string {
  if (typeof raw === "string" && UUID_RE.test(raw)) return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function parseSafeText(raw: unknown, field: string, min: number, max: number): string {
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  const value = raw.trim();
  if (value.length < min || value.length > max) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  assertNoRawSecretOrEndpoint(value, field);
  return value;
}

function assertAllowedKeys(raw: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(raw)) {
    if (!allowedSet.has(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "connector_unknown_field", field: key });
    }
  }
}

function assertSafeMetadata(value: unknown, field: string, depth: number): void {
  if (depth > 4) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_too_deep", field });
  if (typeof value === "string") {
    assertNoRawSecretOrEndpoint(value, field);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return;
  if (Array.isArray(value)) {
    if (value.length > 50) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_array_too_large", field });
    value.forEach((item, index) => assertSafeMetadata(item, `${field}.${index}`, depth + 1));
    return;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > 50) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_object_too_large", field });
    for (const [key, child] of entries) {
      if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || forbiddenConnectorKey(key)) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "connector_metadata_secret_or_endpoint_key_forbidden", field: `${field}.${key}` });
      }
      assertSafeMetadata(child, `${field}.${key}`, depth + 1);
    }
  }
}

function assertNoRawSecretOrEndpoint(value: string, field: string): void {
  if (/https?:\/\//i.test(value) || /hooks\.slack\.com/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "raw_endpoint_url_forbidden", field });
  }
  if (/\bauthorization\b/i.test(value) || /\bbearer\s+[a-z0-9._~+/=-]{8,}/i.test(value) || /\b(token|password|secret)=/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_material_forbidden", field });
  }
}

function forbiddenConnectorKey(key: string): boolean {
  return /(^|[_.-])(api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|credential|authorization|cookie|webhook_url|endpoint_url|url|dsn|smtp|raw_payload|request_payload|response_payload|payload|body|raw_body|provider_response|provider_body)([_.-]|$)/i.test(key);
}

export function requireOne<T>(row: T | undefined | null, reason: string): T {
  if (row === undefined || row === null) {
    throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason });
  }
  return row;
}
