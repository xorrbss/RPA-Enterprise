import type { ApiClient } from "../../api/client";
import {
  ApiError,
  type DocumentFieldSchema,
  type DocumentJobStatus,
  type ListParams,
  type RunItem,
  type RunArtifactItem,
} from "../../api/types";
import { formatDateTime } from "../../util/time";

export type FieldPreset = "invoice" | "contract";
export type PickerPage<T> = { readonly items: readonly T[]; readonly truncated: boolean };

export const FIELD_PRESETS: Record<FieldPreset, readonly DocumentFieldSchema[]> = {
  invoice: [
    { key: "invoice_id", label: "송장 번호", type: "text", required: true, aliases: ["Invoice ID"], min_confidence: 0.8 },
    { key: "total", label: "금액", type: "number", required: true, aliases: ["Total"], min_confidence: 0.8 },
    { key: "approved", label: "승인 여부", type: "boolean", required: false, min_confidence: 0.7 },
  ],
  contract: [
    { key: "contract_no", label: "계약 번호", type: "text", required: true, min_confidence: 0.8 },
    { key: "counterparty", label: "거래처", type: "text", required: true, aliases: ["Vendor", "Customer"], min_confidence: 0.8 },
    { key: "effective_date", label: "효력 시작일", type: "date", required: false, min_confidence: 0.75 },
  ],
};

export const STATUS_FILTERS: readonly { value: "" | DocumentJobStatus; label: string }[] = [
  { value: "", label: "전체" },
  { value: "created", label: "추출 대기" },
  { value: "extracted", label: "추출 완료" },
  { value: "validation_required", label: "검증 필요" },
  { value: "validated", label: "검증 완료" },
  { value: "failed", label: "실패" },
];

async function collectPickerPages<T>(
  fetcher: (params: ListParams) => Promise<{ items: readonly T[]; next_cursor: string | null }>,
  limit: number,
  maxPages: number,
): Promise<PickerPage<T>> {
  let cursor: string | undefined;
  const items: T[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetcher({ limit, ...(cursor !== undefined ? { cursor } : {}) });
    items.push(...result.items);
    if (result.next_cursor === null) return { items, truncated: false };
    cursor = result.next_cursor;
  }
  return { items, truncated: true };
}

export function listRecentRunsForPicker(api: ApiClient): Promise<PickerPage<RunItem>> {
  return collectPickerPages((params) => api.listRuns(params), 20, 5);
}

export function listRunArtifactsForPicker(api: ApiClient, runId: string): Promise<PickerPage<RunArtifactItem>> {
  return collectPickerPages((params) => api.listRunArtifacts(runId, params), 100, 10);
}

export function documentStatusLabel(status: DocumentJobStatus): string {
  switch (status) {
    case "created": return "추출 대기";
    case "extracted": return "추출 완료";
    case "validation_required": return "검증 필요";
    case "validated": return "검증 완료";
    case "failed": return "실패";
  }
}

export function documentStatusTone(status: DocumentJobStatus): "green" | "amber" | "red" | "blue" {
  switch (status) {
    case "created": return "blue";
    case "extracted":
    case "validated": return "green";
    case "validation_required": return "amber";
    case "failed": return "red";
  }
}

export function documentTypeLabel(type: string): string {
  if (type === "invoice") return "송장";
  if (type === "contract") return "계약서";
  return type;
}

export function fieldTypeLabel(type: string): string {
  if (type === "number") return "숫자";
  if (type === "date") return "날짜";
  if (type === "boolean") return "참/거짓";
  return "텍스트";
}

export function fieldSourceLabel(source: string): string {
  if (source === "json") return "JSON 키";
  if (source === "csv") return "CSV 헤더";
  if (source === "pattern") return "패턴";
  if (source === "label") return "라벨 문장";
  if (source === "external_idp") return "외부 IDP";
  return "누락";
}

export function requiredFieldCount(fields: readonly DocumentFieldSchema[]): number {
  return fields.filter((field) => field.required === true).length;
}

export function cloneFields(fields: readonly DocumentFieldSchema[]): DocumentFieldSchema[] {
  return fields.map((field) => ({ ...field, aliases: field.aliases === undefined ? undefined : [...field.aliases] }));
}

export function cleanFieldSchema(fields: readonly DocumentFieldSchema[]): DocumentFieldSchema[] {
  return fields.map((field) => {
    const aliases = (field.aliases ?? []).map((alias) => alias.trim()).filter((alias) => alias.length > 0);
    return {
      key: field.key.trim(),
      ...(field.label?.trim() ? { label: field.label.trim() } : {}),
      type: field.type ?? "text",
      required: field.required === true,
      ...(aliases.length > 0 ? { aliases } : {}),
      min_confidence: field.min_confidence ?? 0.8,
    };
  });
}

export function fieldSchemaValidationMessage(fields: readonly DocumentFieldSchema[]): string | null {
  if (fields.length === 0) return "추출 필드는 1개 이상이어야 합니다.";
  const keys = new Set<string>();
  for (const field of fields) {
    const key = field.key.trim();
    if (key.length === 0) return "필드 키를 입력하세요.";
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) return "필드 키는 영문자로 시작하고 영문, 숫자, 밑줄만 사용할 수 있습니다.";
    if (keys.has(key)) return "중복된 필드 키가 있습니다.";
    keys.add(key);
    if ((field.label ?? "").trim().length === 0) return "표시 이름을 입력하세요.";
    const confidence = field.min_confidence ?? 0.8;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return "신뢰도 기준은 0에서 1 사이여야 합니다.";
  }
  return null;
}

export function isDocumentSourceArtifact(artifact: RunArtifactItem): boolean {
  if (artifact.redaction_status !== "redacted" && artifact.redaction_status !== "not_required") return false;
  const mediaType = (artifact.media_type ?? "").toLowerCase();
  const filename = (artifact.filename ?? "").toLowerCase();
  const type = artifact.type.toLowerCase();
  return (
    mediaType === "application/json" ||
    mediaType === "text/csv" ||
    mediaType.startsWith("text/") ||
    filename.endsWith(".json") ||
    filename.endsWith(".csv") ||
    filename.endsWith(".txt") ||
    type.includes("json") ||
    type.includes("csv") ||
    type.includes("text")
  );
}

export function runOptionLabel(run: RunItem): string {
  const time = run.updated_at ?? run.as_of;
  return time !== null && time !== undefined
    ? `${runStatusLabel(run.status)} · ${formatDateTime(time)}`
    : runStatusLabel(run.status);
}

function runStatusLabel(status: string): string {
  switch (status) {
    case "queued": return "대기 실행";
    case "running": return "실행 중";
    case "completed": return "완료 실행";
    case "failed_system":
    case "failed_business": return "실패 실행";
    case "suspended": return "사람 확인 대기";
    case "cancelled": return "취소된 실행";
    default: return "실행 기록";
  }
}

export function artifactLabel(artifact: RunArtifactItem): string {
  const name = artifact.filename?.trim();
  if (name !== undefined && name.length > 0) return name;
  if (artifact.media_type === "application/json" || artifact.type.toLowerCase().includes("json")) return "JSON 결과";
  if (artifact.media_type === "text/csv" || artifact.type.toLowerCase().includes("csv")) return "CSV 문서";
  if (artifact.media_type?.startsWith("text/") === true || artifact.type.toLowerCase().includes("text")) return "텍스트 문서";
  return "문서 산출물";
}

export function artifactLabelById(id: string, artifacts: readonly RunArtifactItem[]): string {
  const artifact = artifacts.find((item) => item.artifact_id === id);
  return artifact !== undefined ? artifactLabel(artifact) : "선택한 증빙 자료";
}

export function principalDisplayLabel(value: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value) || value.includes("|")) {
    return "등록자 확인됨";
  }
  return value;
}

export function isExtractionNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.httpStatus === 404;
}

export function artifactPickerHint(runId: string, loading: boolean, failed: boolean, count: number, truncated: boolean): string {
  if (runId.trim().length === 0) return "먼저 실행 기록을 선택하세요.";
  if (loading) return "실행 산출물을 불러오는 중입니다.";
  if (failed) return "실행 산출물을 불러오지 못했습니다.";
  if (count === 0) return "마스킹 처리된 JSON, CSV, 텍스트 산출물이 있는 실행을 선택하세요.";
  if (truncated) return "문서 후보 1000건 기준입니다. 필요한 산출물이 없으면 실행 기록에서 직접 열어 확인하세요.";
  return "마스킹 처리된 JSON, CSV, 텍스트 산출물만 표시합니다.";
}
