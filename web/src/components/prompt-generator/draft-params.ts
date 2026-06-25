// PromptScenarioGenerator 의 URL 감지 + 실행 입력값(params) 파싱 + draft_ir 추출 헬퍼.
//   helpers.ts 가 500줄을 넘지 않도록 분리(consumer 는 helpers 의 re-export 로 접근).
import { urlRefLabel } from "../../api/scenario-params";
import type { CreatedSite } from "../SiteCreateForm";
import type { ScenarioGenerationRequest, SiteItem } from "../../api/types";

export interface ParamFieldView {
  key: string;
  label: string;
  value: string;
  valueType: string;
}

const HTTP_URL_TOKEN_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_URL_PUNCTUATION_PATTERN = /[.,!?;:。．、，！？；：…]+$/u;
const TRAILING_URL_QUOTES_PATTERN = /["'”’]+$/u;
const CLOSING_URL_BRACKETS: Readonly<Record<string, string>> = {
  ")": "(",
  "]": "[",
  "}": "{",
  ">": "<",
  "）": "（",
  "〉": "〈",
  "》": "《",
  "」": "「",
  "』": "『",
  "】": "【",
};

function countCharacter(value: string, character: string): number {
  let count = 0;
  for (const next of value) {
    if (next === character) count += 1;
  }
  return count;
}

function trimUnmatchedClosingUrlBracket(value: string): string {
  const last = value[value.length - 1];
  if (last === undefined) return value;
  const opening = CLOSING_URL_BRACKETS[last];
  if (opening === undefined) return value;
  return countCharacter(value, last) > countCharacter(value, opening) ? value.slice(0, -1) : value;
}

function trimTrailingUrlToken(value: string): string {
  let next = value;
  for (;;) {
    const previous = next;
    next = trimUnmatchedClosingUrlBracket(next.replace(TRAILING_URL_PUNCTUATION_PATTERN, "").replace(TRAILING_URL_QUOTES_PATTERN, ""));
    if (next === previous) return next;
  }
}

export function httpOrigin(value: string): string | null {
  const trimmed = trimTrailingUrlToken(value.trim());
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function extractFirstHttpUrl(value: string): string | null {
  HTTP_URL_TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTTP_URL_TOKEN_PATTERN.exec(value)) !== null) {
    const candidate = trimTrailingUrlToken(match[0]);
    if (candidate.length > 0 && httpOrigin(candidate) !== null) return candidate;
  }
  return null;
}

export function singleMatchingSiteForUrl(url: string, sites: readonly SiteItem[]): SiteItem | null {
  const origin = httpOrigin(url);
  if (origin === null) return null;
  const matches = sites.filter((site) => site.url_pattern !== undefined && httpOrigin(site.url_pattern) === origin);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

const PENDING_FACT = "확인 중";
export function createdSiteToItem(site: CreatedSite): SiteItem {
  return {
    site_profile_id: site.site_profile_id,
    name: site.name,
    url_pattern: site.url_pattern,
    risk: site.risk ?? PENDING_FACT,
    approval_status: site.approved === true ? "approved" : "pending",
    circuit_status: PENDING_FACT,
    default_browser_identity_id: site.default_browser_identity_id ?? null,
    default_network_policy_id: site.default_network_policy_id ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordField(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const next = value[key];
  return isRecord(next) ? next : null;
}

function nonEmptyStringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const next = value[key];
  return typeof next === "string" && next.trim().length > 0 ? next.trim() : null;
}

export function parseParamsText(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("실행 입력값 형식이 올바르지 않습니다. 여러 항목을 담은 객체 형태로 입력하세요.");
  }
  if (!isRecord(parsed)) {
    throw new Error("실행 입력값은 여러 항목을 담은 객체 형태여야 합니다.");
  }
  return parsed;
}

export function paramsInputTextFromDraftIr(draftIr: unknown, paramsContext?: Record<string, unknown>): string {
  const params = nonEmptyRecord(paramsContext) ?? recordField(draftIr, "params") ?? paramsDefaultsFromDraftIr(draftIr);
  return params === null ? "" : JSON.stringify(params, null, 2);
}

function nonEmptyRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && Object.keys(value).length > 0 ? value : null;
}

function paramsDefaultsFromDraftIr(draftIr: unknown): Record<string, unknown> | null {
  const paramsSchema = recordField(draftIr, "params_schema");
  const properties = recordField(paramsSchema, "properties");
  if (properties === null) return null;
  const defaults: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(properties)) {
    if (!isRecord(property) || !Object.prototype.hasOwnProperty.call(property, "default")) continue;
    defaults[key] = property.default;
  }
  return Object.keys(defaults).length > 0 ? defaults : null;
}

export function paramsFieldsFromText(value: string): { fields: ParamFieldView[]; invalid: boolean } {
  try {
    const params = parseParamsText(value);
    if (params === undefined) return { fields: [], invalid: false };
    return {
      fields: Object.entries(params).map(([key, fieldValue]) => ({
        key,
        label: urlRefLabel(key),
        value: paramValueToInput(fieldValue),
        valueType: paramValueTypeLabel(fieldValue),
      })),
      invalid: false,
    };
  } catch {
    return { fields: [], invalid: true };
  }
}

function paramValueToInput(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

function paramValueTypeLabel(value: unknown): string {
  if (Array.isArray(value)) return "목록";
  if (value === null) return "빈 값";
  if (typeof value === "number") return "숫자";
  if (typeof value === "boolean") return "true/false";
  if (typeof value === "object") return "복합 값";
  return "텍스트";
}

function coerceParamInput(raw: string, previous: unknown): unknown {
  const trimmed = raw.trim();
  if (typeof previous === "number") {
    const parsed = Number(trimmed);
    return trimmed.length > 0 && Number.isFinite(parsed) ? parsed : raw;
  }
  if (typeof previous === "boolean") {
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
  }
  if (previous !== null && typeof previous === "object") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

export function paramsTextWithField(currentText: string, key: string, raw: string): string {
  const current = parseParamsText(currentText) ?? {};
  return JSON.stringify({ ...current, [key]: coerceParamInput(raw, current[key]) }, null, 2);
}

export function draftStartUrl(draftIr: unknown): string | null {
  const params = recordField(draftIr, "params") ?? paramsDefaultsFromDraftIr(draftIr);
  const paramsStartUrl = nonEmptyStringField(params, "start_url");
  return (
    nonEmptyStringField(draftIr, "start_url") ??
    nonEmptyStringField(recordField(draftIr, "meta"), "start_url") ??
    nonEmptyStringField(recordField(draftIr, "request"), "start_url") ??
    paramsStartUrl
  );
}

export function draftTarget(draftIr: unknown): ScenarioGenerationRequest["target"] | null {
  const target = recordField(draftIr, "target") ?? recordField(recordField(draftIr, "request"), "target");
  const siteProfileId = nonEmptyStringField(target, "site_profile_id");
  const browserIdentityId = nonEmptyStringField(target, "browser_identity_id");
  const networkPolicyId = nonEmptyStringField(target, "network_policy_id");
  if (siteProfileId === null || browserIdentityId === null || networkPolicyId === null) return null;
  return {
    site_profile_id: siteProfileId,
    browser_identity_id: browserIdentityId,
    network_policy_id: networkPolicyId,
  };
}
