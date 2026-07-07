// utility-executor.ts 에서 추출 — action/verify criteria 검증(assert*, 동작 무변경). 전부 무상태 — 클래스가
// 역import. 타입(UtilityAction 등)은 본체에서 type-only 역참조(런타임 순환 없음 — stagehand-dom-executor-dom.ts 동형).
import type { SecretRef, SideEffectKind } from "../../../ts/core-types";
import { UtilityExecutorError } from "./utility-executor-error";
import type { DeterministicCriteria, HttpAuth, HttpMethod, UtilityAction } from "./utility-executor";

const DOM_ACTIONS = new Set(["act", "observe", "extract"]);
const NON_BROWSER_ACTIONS = new Set(["file", "shell"]);
const HTTP_METHODS = new Set<HttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const SENSITIVE_HTTP_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"]);

export function assertUtilityAction(stepId: string, action: unknown): UtilityAction {
  if (typeof action !== "object" || action === null || !("type" in action)) {
    throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' action missing 'type'`);
  }
  const type = (action as { type: unknown }).type;
  if (typeof type !== "string") {
    throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' action.type not a string`);
  }
  if (DOM_ACTIONS.has(type)) {
    throw new UtilityExecutorError(
      "EXECUTOR_CAPABILITY_MISMATCH",
      `step '${stepId}' action '${type}' requires the dom executor (Stagehand act/observe/extract) — not utility`,
    );
  }
  if (NON_BROWSER_ACTIONS.has(type)) {
    throw new UtilityExecutorError(
      "EXECUTOR_CAPABILITY_MISMATCH",
      `step '${stepId}' action '${type}' is non-browser utility — handled by a separate module (architecture §9.1)`,
    );
  }
  if (type === "navigate") {
    const url = nonEmptyString((action as { url?: unknown }).url);
    if (url === undefined) {
      throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' navigate.url must be a non-empty string`);
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' navigate.url must be an absolute URL`);
    }
    // 방어심층(RQ-021): 실행기는 url을 독립 재검증하는 신뢰경계다 — http(s)만 허용한다. opaque scheme
    //   (file:/javascript:/data:/blob: 등)은 producer(site-resolution.originOf)가 막아도 실행기에서 fail-closed로
    //   재차단(단일 producer 가정에 의존하지 않음, 조용한 false 금지). site-resolution.originOf와 동일 규약.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new UtilityExecutorError(
        "IR_SCHEMA_INVALID",
        `step '${stepId}' navigate.url must be an http(s) URL (got scheme '${parsed.protocol}')`,
      );
    }
    return { type, url };
  }
  if (type === "api_call") {
    return assertHttpApiCall(stepId, action as Record<string, unknown>);
  }
  if (type === "download") {
    const trigger = (action as { trigger?: unknown }).trigger;
    const selector = typeof trigger === "object" && trigger !== null
      ? nonEmptyString((trigger as { selector?: unknown }).selector)
      : undefined;
    const fileName = nonEmptyString((action as { fileName?: unknown }).fileName);
    const timeoutMs = (action as { timeoutMs?: unknown }).timeoutMs;
    if (selector === undefined) {
      throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' download.trigger.selector must be a non-empty string`);
    }
    if (fileName === undefined || /[\\/]/.test(fileName)) {
      throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' download.fileName must be a file name, not a path`);
    }
    if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
      throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' download.timeoutMs must be a positive integer`);
    }
    return { type, trigger: { selector }, fileName, timeoutMs };
  }
  if (type === "upload") {
    const selector = nonEmptyString((action as { selector?: unknown }).selector);
    const files = (action as { files?: unknown }).files;
    const validFiles = typeof files === "string"
      ? nonEmptyString(files)
      : Array.isArray(files) && files.length > 0 && files.every((f) => nonEmptyString(f) !== undefined)
        ? files
        : undefined;
    if (selector === undefined) {
      throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' upload.selector must be a non-empty string`);
    }
    if (validFiles === undefined) {
      throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' upload.files must be a non-empty string or string array`);
    }
    return { type, selector, files: validFiles };
  }
  throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' unknown action '${type}'`);
}

function assertHttpApiCall(stepId: string, action: Record<string, unknown>): Extract<UtilityAction, { type: "api_call" }> {
  const rawMethod = typeof action.method === "string" ? action.method.toUpperCase() : "GET";
  if (!HTTP_METHODS.has(rawMethod as HttpMethod)) {
    throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' api_call.method must be one of GET/POST/PUT/PATCH/DELETE`);
  }
  const method = rawMethod as HttpMethod;
  const url = nonEmptyString(action.url);
  if (url === undefined) {
    throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' api_call.url must be a non-empty string`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' api_call.url must be an absolute URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' api_call.url must be an http(s) URL`);
  }

  const headers = assertHttpHeaders(stepId, action.headers);
  const auth = assertHttpAuth(stepId, action.auth, action.connectorId ?? action.connector_id);
  const timeoutMs = action.timeoutMs ?? action.timeout_ms;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0 || (timeoutMs as number) > 300_000)) {
    throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' api_call.timeoutMs must be an integer between 1 and 300000`);
  }
  const sideEffectKind = assertSideEffectKind(stepId, action.sideEffect ?? action.side_effect);
  const idempotencyKey = nonEmptyString(action.idempotencyKey ?? action.idempotency_key);
  const effectiveSideEffectKind = sideEffectKind ?? (method === "GET" ? "read_only" : "update");
  if (effectiveSideEffectKind !== "read_only" && idempotencyKey === undefined) {
    throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' api_call.idempotency_key is required for non-read-only HTTP calls`);
  }
  return {
    type: "api_call",
    method,
    url,
    headers,
    ...(action.body !== undefined ? { body: action.body } : {}),
    auth,
    ...(timeoutMs !== undefined ? { timeoutMs: timeoutMs as number } : {}),
    sideEffectKind: effectiveSideEffectKind,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };
}

function assertHttpHeaders(stepId: string, raw: unknown): Record<string, string> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' api_call.headers must be an object`);
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (name.trim().length === 0 || typeof value !== "string") {
      throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' api_call.headers must contain non-empty string values`);
    }
    const normalized = name.trim();
    if (SENSITIVE_HTTP_HEADERS.has(normalized.toLowerCase())) {
      throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' api_call.headers.${normalized} must use SecretRef auth, not raw header values`);
    }
    headers[normalized] = value;
  }
  return headers;
}

function assertHttpAuth(stepId: string, raw: unknown, rawConnectorId: unknown): HttpAuth {
  if (raw === undefined) return { type: "none" };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' api_call.auth must be an object`);
  }
  const type = (raw as { type?: unknown }).type;
  if (type === "none") return { type: "none" };
  if (type === "secret_ref_bearer") {
    const secretRef = nonEmptyString((raw as { secret_ref?: unknown; secretRef?: unknown }).secret_ref ?? (raw as { secretRef?: unknown }).secretRef);
    if (secretRef === undefined || !secretRef.startsWith("secret://")) {
      throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' api_call.auth.secret_ref must be a SecretRef`);
    }
    const connectorId = nonEmptyString(rawConnectorId ?? (raw as { connector_id?: unknown; connectorId?: unknown }).connector_id ?? (raw as { connectorId?: unknown }).connectorId);
    return { type: "secret_ref_bearer", secretRef: secretRef as SecretRef, ...(connectorId !== undefined ? { connectorId } : {}) };
  }
  throw new UtilityExecutorError(
    "IR_SCHEMA_INVALID",
    `step '${stepId}' api_call.auth.type must be 'none' or 'secret_ref_bearer'`,
  );
}

function assertSideEffectKind(stepId: string, raw: unknown): SideEffectKind | undefined {
  if (raw === undefined) return undefined;
  if (
    raw === "read_only" ||
    raw === "login" ||
    raw === "submit" ||
    raw === "create" ||
    raw === "update" ||
    raw === "delete" ||
    raw === "upload"
  ) {
    return raw;
  }
  throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' api_call.sideEffect must be a valid side effect kind`);
}

export function assertDeterministicCriteria(criteria: unknown): DeterministicCriteria {
  if (typeof criteria !== "object" || criteria === null || !("type" in criteria)) {
    throw new UtilityExecutorError("IR_SCHEMA_INVALID", "verify criteria missing 'type'");
  }
  const type = (criteria as { type: unknown }).type;
  if (type === "element_present") {
    const selector = nonEmptyString((criteria as { selector?: unknown }).selector);
    if (selector === undefined) {
      throw new UtilityExecutorError("IR_SCHEMA_INVALID", "element_present.selector must be a non-empty string");
    }
    return { type, selector };
  }
  if (type === "element_visible") {
    const target = (criteria as { target?: unknown }).target;
    const selector = typeof target === "object" && target !== null
      ? nonEmptyString((target as { selector?: unknown }).selector)
      : undefined;
    if (selector === undefined) {
      throw new UtilityExecutorError("IR_SCHEMA_INVALID", "element_visible.target.selector must be a non-empty string");
    }
    return { type, target: { selector } };
  }
  if (type === "min_rows") {
    const selector = nonEmptyString((criteria as { selector?: unknown }).selector);
    const n = (criteria as { n?: unknown }).n;
    if (selector === undefined) {
      throw new UtilityExecutorError("IR_SCHEMA_INVALID", "min_rows.selector must be a non-empty string");
    }
    if (!Number.isInteger(n) || (n as number) < 1) {
      throw new UtilityExecutorError("IR_SCHEMA_INVALID", "min_rows.n must be an integer >= 1");
    }
    return { type, selector, n: n as number };
  }
  if (type === "element_absent") {
    const target = (criteria as { target?: unknown }).target;
    const selector = typeof target === "object" && target !== null
      ? nonEmptyString((target as { selector?: unknown }).selector)
      : undefined;
    if (selector === undefined) {
      throw new UtilityExecutorError("IR_SCHEMA_INVALID", "element_absent.target.selector must be a non-empty string");
    }
    return { type, target: { selector } };
  }
  if (type === "text_includes") {
    const texts = (criteria as { texts?: unknown }).texts;
    if (!Array.isArray(texts) || texts.length === 0 || !texts.every((t) => nonEmptyString(t) !== undefined)) {
      throw new UtilityExecutorError("IR_SCHEMA_INVALID", "text_includes.texts must be a non-empty array of non-empty strings");
    }
    return { type, texts: texts as string[] };
  }
  if (type === "url_matches") {
    const pattern = nonEmptyString((criteria as { pattern?: unknown }).pattern);
    if (pattern === undefined) {
      throw new UtilityExecutorError("IR_SCHEMA_INVALID", "url_matches.pattern must be a non-empty string");
    }
    try {
      new RegExp(pattern);
    } catch {
      throw new UtilityExecutorError("IR_SCHEMA_INVALID", `url_matches.pattern is not a valid regex: ${pattern}`);
    }
    return { type, pattern };
  }
  if (type === "http_status") {
    const codes = (criteria as { codes?: unknown }).codes;
    if (!Array.isArray(codes) || codes.length === 0 || !codes.every((code) => Number.isInteger(code) && code >= 100 && code <= 599)) {
      throw new UtilityExecutorError("IR_SCHEMA_INVALID", "http_status.codes must be non-empty HTTP status codes");
    }
    return { type, codes: codes as number[] };
  }
  {
    // VLM/스크린샷 기준 등은 vision 실행기 소관(후행, §9.1) — 조용히 통과시키지 않는다.
    throw new UtilityExecutorError(
      "EXECUTOR_CAPABILITY_MISMATCH",
      `verify criteria '${String(type)}' is not deterministic — requires the vision executor`,
    );
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
