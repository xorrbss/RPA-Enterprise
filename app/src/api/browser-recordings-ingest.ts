import { isRecord } from "./command";
import { ApiResponseError } from "../runtime/errors";
import type { RecordingEventType } from "./browser-recordings-store";

export interface StartRecordingBody {
  readonly name: string;
  readonly startUrl?: string;
}

export interface AppendEventsBody {
  readonly events: readonly ParsedRecordingEvent[];
}

export interface ParsedRecordingEvent {
  readonly eventType: RecordingEventType;
  readonly selector: string | null;
  readonly elementKey: string | null;
  readonly label: string | null;
  readonly url: string | null;
  readonly valuePreview: string | null;
}

const EVENT_TYPES: readonly RecordingEventType[] = ["navigate", "click", "input", "select", "submit", "wait"];
const ELEMENT_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{1,63}$/;
const SENSITIVE_KEY_RE = /(^value$|password|passwd|token|cookie|secret|otp|mfa|authorization)/i;
const BEARER_VALUE_RE = /\bbearer\s+[A-Za-z0-9._~+/=-]+/i;
const TOKENISH_VALUE_RE = /^[A-Za-z0-9._~+/=-]{32,}$/;
const OTP_VALUE_RE = /^\d{6,8}$/;
const REDACTED_VALUE_PREVIEW = "[redacted]";

export function parseStartBody(raw: unknown): StartRecordingBody {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  rejectSensitiveKeys(raw);
  for (const key of Object.keys(raw)) {
    if (!["name", "start_url"].includes(key)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
  }
  const name = requireTrimmed(raw.name, "invalid_name");
  const startUrl = optionalHttpUrl(raw.start_url, "invalid_start_url");
  return { name, ...(startUrl !== undefined ? { startUrl } : {}) };
}

export function parseAppendEventsBody(raw: unknown): AppendEventsBody {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  rejectSensitiveKeys(raw);
  for (const key of Object.keys(raw)) {
    if (key !== "events") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
  }
  if (!Array.isArray(raw.events) || raw.events.length === 0 || raw.events.length > 100) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_events" });
  }
  return { events: raw.events.map(parseEvent) };
}

export function eventSeqCursor(raw: unknown): number | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_cursor" });
  }
  const seq = Number.parseInt(raw, 10);
  if (seq < 1) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_cursor" });
  return seq;
}

function parseEvent(raw: unknown): ParsedRecordingEvent {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "event_object_required" });
  rejectSensitiveKeys(raw);
  for (const key of Object.keys(raw)) {
    if (!["event_type", "selector", "element_key", "label", "url", "value_preview"].includes(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_event_field", field: key });
    }
  }
  const eventType = requireEnum(raw.event_type, EVENT_TYPES, "invalid_event_type");
  const selector = optionalTrimmed(raw.selector, "invalid_selector");
  const elementKey = optionalElementKey(raw.element_key);
  const label = optionalTrimmed(raw.label, "invalid_label");
  const url = optionalHttpUrl(raw.url, "invalid_event_url");
  const valuePreview = redactSensitiveValuePreview(
    eventType,
    optionalTrimmed(raw.value_preview, "invalid_value_preview"),
    selector,
    elementKey,
    label,
  );

  if (eventType === "navigate" && url === undefined) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "navigate_url_required" });
  if ((eventType === "click" || eventType === "input" || eventType === "select" || eventType === "submit") && selector === undefined) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "selector_required", event_type: eventType });
  }
  if (eventType === "select" && valuePreview === undefined) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "select_value_required" });
  return { eventType, selector: selector ?? null, elementKey: elementKey ?? null, label: label ?? null, url: url ?? null, valuePreview: valuePreview ?? null };
}

function redactSensitiveValuePreview(
  eventType: RecordingEventType,
  valuePreview: string | undefined,
  selector: string | undefined,
  elementKey: string | undefined,
  label: string | undefined,
): string | undefined {
  if (valuePreview === undefined || eventType !== "input") return valuePreview;
  const context = [selector, elementKey, label].filter((value): value is string => value !== undefined).join(" ");
  const trimmed = valuePreview.trim();
  if (
    SENSITIVE_KEY_RE.test(context) ||
    BEARER_VALUE_RE.test(trimmed) ||
    TOKENISH_VALUE_RE.test(trimmed) ||
    OTP_VALUE_RE.test(trimmed)
  ) {
    return REDACTED_VALUE_PREVIEW;
  }
  return valuePreview;
}

function rejectSensitiveKeys(value: unknown): void {
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(key)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "sensitive_recording_field_rejected", field: key });
    if (isRecord(nested)) rejectSensitiveKeys(nested);
    if (Array.isArray(nested)) for (const item of nested) rejectSensitiveKeys(item);
  }
}

function requireTrimmed(value: unknown, reason: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
  }
  return value.trim();
}

function optionalTrimmed(value: unknown, reason: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireTrimmed(value, reason);
}

function optionalElementKey(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !ELEMENT_KEY_RE.test(value)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_element_key" });
  return value;
}

export function assertHttpUrl(value: string, reason: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
}

function optionalHttpUrl(value: unknown, reason: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 2048) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
  const url = value.trim();
  assertHttpUrl(url, reason);
  return url;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], reason: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
  return value as T;
}

export function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], reason: string): T | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireEnum(value, allowed, reason);
}
