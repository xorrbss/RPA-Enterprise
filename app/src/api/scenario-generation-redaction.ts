/**
 * 자연어 generation 민감값 redaction 유틸 (scenario-generations.ts 분해 — 동작 무변경 이동).
 *
 * params_context(민감 키/PlainSecret 마커)·draft IR(instruction)·실패 ledger details(prompt·instruction)에서
 * 평문 노출을 차단한다(security-contracts redaction 경계). 외부 의존은 isRecord(./command)뿐. 내부 헬퍼·마커
 * 상수는 비-export.
 */
import { isRecord } from "./command";

const REDACTED_SCENARIO_GENERATION_PARAM = "[REDACTED:scenario_generation_param]";

export function redactParamsContext(value: Record<string, unknown>): Record<string, unknown> {
  return redactParamsContextRecord(value);
}

function redactParamsContextRecord(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = redactParamsContextValue(key, child);
  }
  return out;
}

function redactParamsContextValue(key: string, value: unknown): unknown {
  if (isSensitiveParamKey(key)) return REDACTED_SCENARIO_GENERATION_PARAM;
  if (Array.isArray(value)) return value.map((item) => redactParamsContextValue(key, item));
  if (isRecord(value)) return redactParamsContextRecord(value);
  if (typeof value === "string" && value.includes("PlainSecret")) return REDACTED_SCENARIO_GENERATION_PARAM;
  return value;
}

function isSensitiveParamKey(key: string): boolean {
  return /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential)/i.test(key);
}

export function containsRedactedParamsMarker(value: unknown): boolean {
  if (value === REDACTED_SCENARIO_GENERATION_PARAM) return true;
  if (Array.isArray(value)) return value.some((item) => containsRedactedParamsMarker(item));
  if (isRecord(value)) return Object.values(value).some((item) => containsRedactedParamsMarker(item));
  return false;
}

export function redactGenerationDraftIr(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactGenerationDraftIr(item));
  if (!isRecord(value)) return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    redacted[key] = key === "instruction" && typeof child === "string"
      ? "[REDACTED:scenario_generation_instruction]"
      : redactGenerationDraftIr(child);
  }
  return redacted;
}

export function redactGenerationFailureDetails(value: unknown, prompt: string): unknown {
  if (typeof value === "string") {
    return value.includes(prompt) ? value.replaceAll(prompt, "[REDACTED:scenario_generation_prompt]") : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactGenerationFailureDetails(item, prompt));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = key === "prompt" || key === "instruction"
      ? "[REDACTED:scenario_generation_error_detail]"
      : redactGenerationFailureDetails(child, prompt);
  }
  return out;
}
