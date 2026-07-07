/**
 * /v1/ops-alerts 표면의 입력 파싱·검증 — 목록 필터, alert_id/ack 본문, 외부 전달(delivery)·webhook 발송·
 * provider 콜백 본문/헤더. 원문 endpoint URL·secret 재료 금지(assertSafeDeliveryString) 규칙을 여기서 강제한다.
 */
import { ApiResponseError } from "../runtime/errors";
import type {
  OpsAlertSeverity,
  OpsAlertSource,
  OpsNotificationWebhookSendInput,
} from "../runtime/ops-alerts/types";
import { isRecord } from "./command";
import { UUID_RE } from "./server-shared";

export type OpsAlertStatus = "open" | "acknowledged";
export type OpsAlertListStatus = OpsAlertStatus | "all";
export type OpsNotificationChannel = "teams" | "slack" | "email" | "webhook";
export type OpsNotificationDeliveryStatus = "sent" | "delivered" | "failed";

export interface OpsNotificationDeliveryInput {
  readonly channel: OpsNotificationChannel;
  readonly providerAlias: string;
  readonly status: OpsNotificationDeliveryStatus;
  readonly receiptId: string | null;
  readonly receiptAt: Date;
  readonly endpointSecretRef: string;
  readonly credentialSecretRef: string | null;
  readonly callbackSignatureSecretRef: string | null;
  readonly routePolicyRef: string | null;
  readonly recipientGroupRef: string | null;
  readonly attemptNo: number;
  readonly summary: string;
  readonly errorCode: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly legalHold: boolean;
}

export interface OpsNotificationCallbackInput {
  readonly status: "delivered" | "failed";
  readonly receiptId: string;
  readonly errorCode: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly legalHold: boolean;
}

export interface OpsNotificationCallbackHeaders {
  readonly eventId: string;
  readonly timestamp: string;
  readonly signature: string;
}

const SEVERITY_SET: Record<OpsAlertSeverity, true> = {
  critical: true,
  warning: true,
  info: true,
};

const SOURCE_SET: Record<OpsAlertSource, true> = {
  run_sla: true,
  human_task_sla: true,
  trigger_fire: true,
  failure_spike: true,
  dlq: true,
  bot_pool: true,
  scim_secret_rotation: true,
  audit_verifier: true,
  readiness_evidence: true,
  session_expiry: true,
  artifact_redaction: true,
  security_abort: true,
};

const STATUS_SET: Record<OpsAlertListStatus, true> = {
  open: true,
  acknowledged: true,
  all: true,
};

const OPS_NOTIFICATION_CALLBACK_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;
const OPS_NOTIFICATION_CALLBACK_EVENT_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

export function severityFilter(raw: unknown): OpsAlertSeverity | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string" && Object.prototype.hasOwnProperty.call(SEVERITY_SET, raw)) {
    return raw as OpsAlertSeverity;
  }
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_severity" });
}

export function sourceFilter(raw: unknown): OpsAlertSource | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string" && Object.prototype.hasOwnProperty.call(SOURCE_SET, raw)) {
    return raw as OpsAlertSource;
  }
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_source" });
}

export function statusFilter(raw: unknown): OpsAlertListStatus {
  if (raw === undefined) return "open";
  if (typeof raw === "string" && Object.prototype.hasOwnProperty.call(STATUS_SET, raw)) {
    return raw as OpsAlertListStatus;
  }
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_status" });
}

export function assertNoCursor(raw: unknown): void {
  if (raw === undefined) return;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_alert_cursor_not_supported" });
}

export function parseAlertId(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 300 || raw.includes("/")) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_alert_id" });
  }
  return raw;
}

export function parseUuidNotFound(raw: unknown, field: string): string {
  if (typeof raw === "string" && UUID_RE.test(raw)) return raw;
  throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: `invalid_${field}` });
}

export function parseAckRequest(raw: unknown): { comment: string | null } {
  if (raw === undefined || raw === null) return { comment: null };
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_alert_ack_body_expected_object" });
  const keys = Object.keys(raw);
  if (keys.some((key) => key !== "comment")) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_alert_ack_unknown_field" });
  }
  const comment = raw.comment;
  if (comment === undefined || comment === null || comment === "") return { comment: null };
  if (typeof comment !== "string" || comment.length > 1000) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_comment" });
  }
  return { comment };
}

export function parseOpsNotificationCallbackRequest(raw: unknown): OpsNotificationCallbackInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_notification_callback_body_expected_object" });
  const allowed = new Set(["receipt_id", "status", "error_code", "metadata", "legal_hold"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_notification_callback_unknown_field", field: key });
    }
  }
  const receiptId = parseSafeDeliveryString(raw.receipt_id, "receipt_id", 1, 200);
  const status = parseOpsNotificationCallbackStatus(raw.status);
  const errorCode = raw.error_code === undefined || raw.error_code === null || raw.error_code === ""
    ? null
    : parseSafeDeliveryString(raw.error_code, "error_code", 1, 120);
  if (status === "failed" && errorCode === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "error_code_required_for_failed_delivery" });
  }
  if (status === "delivered" && errorCode !== null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "error_code_for_delivered_callback_forbidden" });
  }
  const metadata = parseDeliveryMetadata(raw.metadata);
  const legalHold = raw.legal_hold === undefined ? false : parseDeliveryBoolean(raw.legal_hold, "legal_hold");
  return { receiptId, status, errorCode, metadata, legalHold };
}

function parseOpsNotificationCallbackStatus(raw: unknown): "delivered" | "failed" {
  if (raw === "delivered" || raw === "failed") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_ops_notification_callback_status" });
}

export function parseOpsNotificationCallbackHeaders(headers: Record<string, unknown>): OpsNotificationCallbackHeaders {
  const eventId = requireOpsNotificationCallbackHeader(headers["x-rpa-ops-notification-event-id"], "x-rpa-ops-notification-event-id");
  if (!OPS_NOTIFICATION_CALLBACK_EVENT_ID_RE.test(eventId)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_ops_notification_callback_event_id" });
  }
  const timestamp = requireOpsNotificationCallbackHeader(headers["x-rpa-ops-notification-timestamp"], "x-rpa-ops-notification-timestamp");
  parseOpsNotificationCallbackTimestamp(timestamp);
  const signature = requireOpsNotificationCallbackHeader(headers["x-rpa-ops-notification-signature"], "x-rpa-ops-notification-signature");
  return { eventId, timestamp, signature };
}

function parseOpsNotificationCallbackTimestamp(value: string): void {
  if (!/^\d{10,13}$/.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_ops_notification_callback_timestamp" });
  }
  const numeric = Number(value);
  const millis = value.length === 13 ? numeric : numeric * 1000;
  const parsed = new Date(millis);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_ops_notification_callback_timestamp" });
  }
  if (Math.abs(Date.now() - parsed.getTime()) > OPS_NOTIFICATION_CALLBACK_TIMESTAMP_SKEW_MS) {
    throw new ApiResponseError("UNAUTHENTICATED", { reason: "ops_notification_callback_timestamp_outside_window" });
  }
}

function requireOpsNotificationCallbackHeader(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_ops_notification_callback_header", header: name });
}

export function parseNotificationWebhookSendRequest(raw: unknown): OpsNotificationWebhookSendInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_notification_send_body_expected_object" });
  const allowed = new Set([
    "provider_alias",
    "endpoint_secret_ref",
    "callback_signature_secret_ref",
    "route_policy_ref",
    "recipient_group_ref",
    "allowed_hosts",
    "summary",
    "metadata",
    "legal_hold",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_notification_send_unknown_field", field: key });
    }
  }
  const providerAlias = raw.provider_alias === undefined || raw.provider_alias === null || raw.provider_alias === ""
    ? "webhook-primary"
    : parseSafeDeliveryString(raw.provider_alias, "provider_alias", 1, 120);
  const endpointSecretRef = parseSecretRef(raw.endpoint_secret_ref, "endpoint_secret_ref");
  const callbackSignatureSecretRef = raw.callback_signature_secret_ref === undefined || raw.callback_signature_secret_ref === null || raw.callback_signature_secret_ref === ""
    ? null
    : parseSecretRef(raw.callback_signature_secret_ref, "callback_signature_secret_ref");
  const routePolicyRef = parseSafeDeliveryString(raw.route_policy_ref, "route_policy_ref", 1, 200);
  const recipientGroupRef = raw.recipient_group_ref === undefined || raw.recipient_group_ref === null || raw.recipient_group_ref === ""
    ? null
    : parseSafeDeliveryString(raw.recipient_group_ref, "recipient_group_ref", 1, 200);
  const allowedHosts = parseAllowedWebhookHosts(raw.allowed_hosts);
  const summary = raw.summary === undefined || raw.summary === null || raw.summary === ""
    ? null
    : parseSafeDeliveryString(raw.summary, "summary", 1, 1000);
  const metadata = parseDeliveryMetadata(raw.metadata);
  const legalHold = raw.legal_hold === undefined ? false : parseDeliveryBoolean(raw.legal_hold, "legal_hold");
  return { providerAlias, endpointSecretRef, callbackSignatureSecretRef, routePolicyRef, recipientGroupRef, allowedHosts, summary, metadata, legalHold };
}

export function parseNotificationDeliveryRequest(raw: unknown): OpsNotificationDeliveryInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_notification_delivery_body_expected_object" });
  const allowed = new Set([
    "channel",
    "provider_alias",
    "status",
    "receipt_id",
    "receipt_at",
    "endpoint_secret_ref",
    "credential_secret_ref",
    "callback_signature_secret_ref",
    "route_policy_ref",
    "recipient_group_ref",
    "attempt_no",
    "summary",
    "error_code",
    "metadata",
    "legal_hold",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ops_notification_delivery_unknown_field", field: key });
    }
  }
  const channel = parseNotificationChannel(raw.channel);
  const providerAlias = parseSafeDeliveryString(raw.provider_alias, "provider_alias", 1, 120);
  const status = parseNotificationDeliveryStatus(raw.status);
  const receiptId = raw.receipt_id === undefined || raw.receipt_id === null || raw.receipt_id === ""
    ? null
    : parseSafeDeliveryString(raw.receipt_id, "receipt_id", 1, 200);
  const receiptAt = parseDeliveryIsoDate(raw.receipt_at, "receipt_at");
  if (receiptAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "receipt_at_in_future" });
  }
  const endpointSecretRef = parseSecretRef(raw.endpoint_secret_ref, "endpoint_secret_ref");
  const credentialSecretRef = raw.credential_secret_ref === undefined || raw.credential_secret_ref === null || raw.credential_secret_ref === ""
    ? null
    : parseSecretRef(raw.credential_secret_ref, "credential_secret_ref");
  const callbackSignatureSecretRef = raw.callback_signature_secret_ref === undefined || raw.callback_signature_secret_ref === null || raw.callback_signature_secret_ref === ""
    ? null
    : parseSecretRef(raw.callback_signature_secret_ref, "callback_signature_secret_ref");
  const routePolicyRef = raw.route_policy_ref === undefined || raw.route_policy_ref === null || raw.route_policy_ref === ""
    ? null
    : parseSafeDeliveryString(raw.route_policy_ref, "route_policy_ref", 1, 200);
  const recipientGroupRef = raw.recipient_group_ref === undefined || raw.recipient_group_ref === null || raw.recipient_group_ref === ""
    ? null
    : parseSafeDeliveryString(raw.recipient_group_ref, "recipient_group_ref", 1, 200);
  const attemptNo = raw.attempt_no === undefined ? 1 : parsePositiveInteger(raw.attempt_no, "attempt_no");
  const summary = parseSafeDeliveryString(raw.summary, "summary", 1, 1000);
  const errorCode = raw.error_code === undefined || raw.error_code === null || raw.error_code === ""
    ? null
    : parseSafeDeliveryString(raw.error_code, "error_code", 1, 120);
  if (status === "failed" && errorCode === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "error_code_required_for_failed_delivery" });
  }
  if (status !== "failed" && receiptId === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "receipt_id_required_for_successful_delivery" });
  }
  const metadata = parseDeliveryMetadata(raw.metadata);
  const legalHold = raw.legal_hold === undefined ? false : parseDeliveryBoolean(raw.legal_hold, "legal_hold");
  return {
    channel,
    providerAlias,
    status,
    receiptId,
    receiptAt,
    endpointSecretRef,
    credentialSecretRef,
    callbackSignatureSecretRef,
    routePolicyRef,
    recipientGroupRef,
    attemptNo,
    summary,
    errorCode,
    metadata,
    legalHold,
  };
}

function parseAllowedWebhookHosts(raw: unknown): readonly string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_allowed_hosts" });
  }
  const hosts = raw.map((item) => parseAllowedWebhookHost(item));
  return [...new Set(hosts)];
}

function parseAllowedWebhookHost(raw: unknown): string {
  const host = parseSafeDeliveryString(raw, "allowed_hosts", 1, 253).toLowerCase();
  if (host.includes("://") || host.includes("/") || host.includes("?") || host.includes("#")) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "allowed_host_must_not_be_url" });
  }
  if (host === "localhost" || host.endsWith(".localhost") || /^[0-9.]+$/.test(host) || host.includes(":")) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "allowed_host_public_dns_required" });
  }
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  const hostRe = new RegExp(`^(?:${label}\\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$`);
  if (!hostRe.test(host)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_allowed_host" });
  }
  return host;
}

function parseNotificationChannel(raw: unknown): OpsNotificationChannel {
  if (raw === "teams" || raw === "slack" || raw === "email" || raw === "webhook") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_notification_channel" });
}

function parseNotificationDeliveryStatus(raw: unknown): OpsNotificationDeliveryStatus {
  if (raw === "sent" || raw === "delivered" || raw === "failed") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_notification_delivery_status" });
}

function parseDeliveryIsoDate(raw: unknown, field: string): Date {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_iso_datetime", field });
  }
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_iso_datetime", field });
  }
  return date;
}

function parsePositiveInteger(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 1000) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  }
  return raw;
}

function parseSecretRef(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !raw.startsWith("secret://") || raw.length <= "secret://".length || raw.length > 500) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  }
  assertSafeDeliveryString(raw, field);
  return raw;
}

function parseSafeDeliveryString(raw: unknown, field: string, min: number, max: number): string {
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  const value = raw.trim();
  if (value.length < min || value.length > max) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  assertSafeDeliveryString(value, field);
  return value;
}

function parseDeliveryMetadata(raw: unknown): Readonly<Record<string, unknown>> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_must_be_object" });
  if (JSON.stringify(raw).length > 4000) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_too_large" });
  assertSafeDeliveryMetadata(raw, "metadata");
  return raw;
}

function parseDeliveryBoolean(raw: unknown, field: string): boolean {
  if (typeof raw === "boolean") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function assertSafeDeliveryMetadata(value: unknown, path: string): void {
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value === "string") {
    assertSafeDeliveryString(value, path);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertSafeDeliveryMetadata(item, `${path}.${index}`);
    return;
  }
  if (!isRecord(value)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_value_not_json", path });
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || forbiddenDeliveryMetadataKey(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_secret_or_endpoint_key_forbidden", path: `${path}.${key}` });
    }
    assertSafeDeliveryMetadata(item, `${path}.${key}`);
  }
}

function forbiddenDeliveryMetadataKey(key: string): boolean {
  return /(^|[_\-.])(secret|token|password|credential|authorization|cookie|webhook_url|endpoint_url|url|dsn|smtp)([_\-.]|$)/i.test(key);
}

function assertSafeDeliveryString(value: string, field: string): void {
  if (/https?:\/\//i.test(value) || /hooks\.slack\.com/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "raw_endpoint_url_forbidden", field });
  }
  if (/\bbearer\s+[a-z0-9._~+/=-]{8,}/i.test(value) || /\b(token|password|secret)=/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_material_forbidden", field });
  }
}
