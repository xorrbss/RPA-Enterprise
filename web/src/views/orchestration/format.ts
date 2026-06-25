// Orchestration 공유 포맷·에러 헬퍼 — 패널(TriggerFireHistory)·뷰·폼이 공유한다.
import { ApiError } from "../../api/types";
import { errorCodeLabel, errorLabel } from "../../components/badges";

export function formatDateTime(value: string | null | undefined): string {
  if (value === null || value === undefined) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function detailValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim().length > 0 ? value.trim() : null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

const ERROR_CODE_LABELS: Record<string, string> = {
  MAX_CONCURRENCY_REACHED: "동시 실행 한도에 도달했습니다.",
};

const DETAIL_KEY_LABELS: Record<string, string> = {
  detail: "설명",
  field: "항목",
  reason: "사유",
};

const DETAIL_VALUE_LABELS: Record<string, string> = {
  cron_expression: "예약식",
  invalid_cron_expression: "예약식을 다시 확인해야 합니다.",
  "expected five fields": "분 시 일 월 요일 형식이어야 합니다.",
};

export function opsErrorCodeLabel(code: unknown): string {
  const normalized = detailValue(code);
  if (normalized === null) return "사유 코드 없음";
  return ERROR_CODE_LABELS[normalized] ?? errorCodeLabel(normalized);
}

function detailKeyLabel(key: string): string {
  return DETAIL_KEY_LABELS[key] ?? key.replaceAll("_", " ");
}

function detailValueLabel(value: string): string {
  return DETAIL_VALUE_LABELS[value] ?? value;
}

export function detailPart(key: string, value: unknown): string | null {
  const normalized = detailValue(value);
  if (normalized === null) return null;
  return `${detailKeyLabel(key)}: ${detailValueLabel(normalized)}`;
}

export function errorWithDetails(error: unknown): string {
  const base = errorLabel(error);
  if (!(error instanceof ApiError)) return base;
  const details = error.body?.details;
  if (details === undefined) return base;
  const parts = [
    detailPart("field", details.field),
    detailPart("reason", details.reason),
    detailPart("detail", details.detail),
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `${base} (${parts.join(" · ")})` : base;
}
