import type { HumanTaskBusinessFormSchema, HumanTaskResolution } from "../../api/types";

export type SummaryItem = { readonly label: string; readonly value: string };

const SUMMARY_KEY_LABELS: Record<string, string> = {
  approved: "승인 여부",
  doc_ref: "문서 링크",
  invoice_id: "송장 번호",
  status: "상태",
  total: "금액",
};
const TECHNICAL_SUMMARY_KEYS = new Set([
  "artifact_id",
  "correlation_id",
  "human_task_id",
  "run_id",
  "scenario_id",
  "scenario_version_id",
  "source_artifact_id",
  "source_run_id",
  "tenant_id",
]);

export const DECISIONS: readonly { value: HumanTaskResolution["decision"]; label: string }[] = [
  { value: "approve", label: "승인" },
  { value: "reject", label: "반려" },
  { value: "correct", label: "수정 후 통과" },
  { value: "retry", label: "재시도 요청" },
];

function valueLabel(value: unknown): string {
  if (value === null || value === undefined) return "없음";
  // 범용 인박스: 메일 원문/문서 등 긴 검토 텍스트도 사람이 읽을 수 있게 넉넉히 표시(폭주 방지 상한만 유지).
  if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length}개 항목`;
  if (typeof value === "object") return "세부 정보 있음";
  return String(value);
}

// 범용 사람-확인 인박스: 임의 자동화의 payload 를 표시한다. 알려진 키는 한국어 라벨로, 그 외는 시나리오 작성자가 고른
//   키(예 제목/보낸사람/원문)를 그대로 라벨로 쓴다("추가 정보 N" 익명화 대신 — 새 자동화도 데이터만으로 의미 있게 표시).
//   form 필드로 편집되는 키(formFieldKeys)는 아래 입력 양식에서 보이므로 읽기전용 요약에서는 제외(중복 방지).
export function payloadSummaryItems(value: unknown, formFieldKeys: ReadonlySet<string>): readonly SummaryItem[] {
  if (value === null || value === undefined) return [{ label: "내용", value: "없음" }];
  if (typeof value !== "object" || Array.isArray(value)) return [{ label: "내용", value: valueLabel(value) }];
  const items = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !TECHNICAL_SUMMARY_KEYS.has(key) && !formFieldKeys.has(key))
    .slice(0, 8)
    .map(([key, item]) => ({ label: SUMMARY_KEY_LABELS[key] ?? key, value: valueLabel(item) }));
  return items.length > 0 ? items : [{ label: "업무 데이터", value: "요약 가능한 값 없음" }];
}

export function schemaSummaryLabel(schema: HumanTaskBusinessFormSchema | null, rawSchema: unknown): string {
  if (schema !== null) return `${schema.fields.length}개 입력 항목`;
  if (rawSchema === null || rawSchema === undefined) return "별도 입력 양식 없음";
  return "직접 입력 방식 사용";
}

export function schemaDetailItems(schema: HumanTaskBusinessFormSchema | null): readonly SummaryItem[] {
  if (schema === null) return [{ label: "입력 방식", value: "항목명과 수정값을 직접 입력합니다." }];
  return schema.fields.map((field) => ({
    label: field.label,
    value: field.required === true ? "필수 입력" : "선택 입력",
  }));
}
