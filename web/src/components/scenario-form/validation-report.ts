// 검증 실패/오류 표면화 헬퍼 — ApiError details 운영자 요약, 검증 리포트 요약 라인. 조용한 실패 금지.

import { ApiError } from "../../api/types";
import { errorLabel } from "../badges";
import { isRecord } from "./ir-mode";

const DETAIL_KEY_LABELS: Record<string, string> = {
  field: "항목",
  reason: "사유",
  detail: "설명",
  message: "설명",
  available: "선택 가능",
  code: "오류 코드",
  instancePath: "위치",
  schemaPath: "검증 규칙",
};

const DETAIL_VALUE_LABELS: Record<string, string> = {
  model_required: "AI 모델 선택이 필요합니다.",
  invalid_cron_expression: "예약식을 다시 확인해야 합니다.",
  unsupported_operation: "지원하지 않는 동작입니다.",
  start_url_required_for_auto_run: "자동 실행에는 시작 주소가 필요합니다.",
  target_required_for_auto_run: "자동 실행에는 대상 사이트가 필요합니다.",
  video_recording_port_not_configured:
    "동영상 증거 저장 포트가 설정되지 않았습니다.",
};

function detailKeyLabel(key: string): string {
  return DETAIL_KEY_LABELS[key] ?? key;
}

function detailValueLabel(value: unknown): string {
  if (typeof value === "string") return DETAIL_VALUE_LABELS[value] ?? value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return value.map(detailValueLabel).join(", ");
  if (isRecord(value)) {
    const keys = Object.keys(value);
    return keys.length > 0
      ? `하위 항목 ${keys.slice(0, 6).join(", ")}`
      : "하위 항목 없음";
  }
  if (value === null) return "없음";
  return "확인 필요";
}

function detailsText(details: Record<string, unknown>): string {
  const rows = Object.entries(details).map(
    ([key, value]) => `${detailKeyLabel(key)}: ${detailValueLabel(value)}`,
  );
  return rows.length > 0 ? `\n${rows.join("\n")}` : "";
}

export function describe(e: unknown): string {
  // web-고유 행동지향 분기: 붙여넣은 IR JSON 자체가 깨진 경우는 계약 코드가 아니라 입력 수정 안내(보존).
  if (e instanceof SyntaxError)
    return "JSON 형식 오류 — 중괄호/쉼표를 확인하세요.";
  // 그 외(ApiError 포함)는 errorLabel(계약 userMessage 미러)로 통일하되, 검증 details는 운영자 요약으로 부가.
  if (e instanceof ApiError && e.body?.details) {
    return `${errorLabel(e)}${detailsText(e.body.details)}`;
  }
  return errorLabel(e);
}

function reportIssueText(issue: unknown): string {
  if (!isRecord(issue)) return detailValueLabel(issue);
  const path =
    issue.instancePath ?? issue.path ?? issue.field ?? issue.schemaPath;
  const message = issue.message ?? issue.reason ?? issue.code ?? issue.detail;
  const node = issue.node_id ?? issue.nodeId;
  const key =
    `${issue.rule ?? ""} ${issue.code ?? ""} ${message ?? ""} ${path ?? ""}`.toLowerCase();
  let summary =
    "검증 항목을 확인하세요. 자동화 만들기의 단계 편집 또는 자동화 정의 직접 편집에서 수정할 수 있습니다.";
  if (key.includes("action") || key.includes("unsupported")) {
    summary =
      "지원하지 않는 자동화 동작입니다. 단계 편집에서 동작 유형을 다시 선택하세요.";
  } else if (
    key.includes("target") ||
    key.includes("branch") ||
    key.includes("node")
  ) {
    summary =
      "조건 분기 대상 단계가 없습니다. 단계 편집에서 다음 단계 연결을 확인하세요.";
  } else if (key.includes("instruction") || key.includes("extract")) {
    summary = "데이터 추출 단계의 지시문 또는 출력 형식을 확인하세요.";
  } else if (key.includes("priority")) {
    summary =
      "조건 우선순위가 겹칩니다. 같은 조건 그룹 안의 우선순위를 조정하세요.";
  } else if (key.includes("loop")) {
    summary = "반복 단계의 종료 조건 또는 최대 반복 횟수를 확인하세요.";
  } else if (key.includes("url") || key.includes("navigate")) {
    summary = "페이지 이동 단계의 주소 입력값과 사이트 등록 상태를 확인하세요.";
  }
  return node !== undefined
    ? `${summary} 문제가 난 단계 참조가 있습니다.`
    : summary;
}

export function validationReportLines(report: unknown): string[] {
  if (!isRecord(report)) return ["검증 리포트가 실패를 반환했습니다."];
  const errors = Array.isArray(report.errors) ? report.errors : [];
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  const lines: string[] = [];
  if (errors.length > 0) {
    lines.push(`오류 ${errors.length}건`);
    lines.push(...errors.slice(0, 3).map(reportIssueText));
  }
  if (warnings.length > 0) lines.push(`주의 ${warnings.length}건`);
  if (lines.length === 0) {
    const keys = Object.keys(report);
    lines.push(
      keys.length > 0
        ? `리포트 항목 ${keys.join(", ")}`
        : "검증 리포트가 실패를 반환했습니다.",
    );
  }
  if (errors.length > 3)
    lines.push(`추가 오류 ${errors.length - 3}건은 원문 상세에서 확인하세요.`);
  return lines;
}
