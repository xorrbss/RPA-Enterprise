/**
 * 자연어 generation list/query 파라미터 파서 (scenario-generations.ts 분해 — 동작 무변경 이동).
 *
 * limit·cursor·status·run_id 필터·params_context 파서와 공유 UUID_RE를 보유한다. 무효 입력은
 * ApiResponseError(IR_SCHEMA_INVALID, 조용한 false 금지). 의존은 isRecord(./command)·ApiResponseError
 * (./errors)·GenerationStatus(./scenario-generation-types)뿐. UUID_RE는 본 모듈 소유, 원본이 import.
 */
import { isRecord } from "./command";
import { ApiResponseError } from "./errors";
import type { GenerationStatus } from "./scenario-generation-types";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseParamsContext(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function parseListLimit(value: string | undefined): number {
  if (value === undefined) return 20;
  if (!/^\d+$/.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_limit" });
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_limit", min: 1, max: 100 });
  }
  return n;
}

export function parseListCursor(value: string | undefined): { createdAt: string; id: string } | undefined {
  if (value === undefined || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      isRecord(parsed) &&
      typeof parsed.created_at === "string" &&
      Number.isFinite(Date.parse(parsed.created_at)) &&
      typeof parsed.id === "string" &&
      UUID_RE.test(parsed.id)
    ) {
      return { createdAt: parsed.created_at, id: parsed.id };
    }
  } catch {
    // fall through to uniform API error
  }
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_cursor" });
}

export function parseGenerationStatusFilter(value: string | undefined): GenerationStatus | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (value === "drafted" || value === "saved" || value === "run_queued" || value === "blocked" || value === "failed") {
    return value;
  }
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_generation_status" });
}

export function parseRunIdFilter(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (UUID_RE.test(value)) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_run_id" });
}
