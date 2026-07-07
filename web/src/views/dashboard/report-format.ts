import type {
  AutomationPerformanceReport,
  AutomationPerformanceReportExportFormat,
  AutomationPerformanceRunMode,
  AutomationPerformanceRoiSource,
  AutomationPerformanceRoiSourceLineage,
  AutomationPerformanceRoiStage,
} from "../../api/types";

export type ReportExportState = "idle" | "pending" | "success" | "error";
export type ReportExportFormat = AutomationPerformanceReportExportFormat;
export const REPORT_RUN_MODE_OPTIONS: readonly AutomationPerformanceRunMode[] = ["prod", "test", "all"];

export function currentReportMonth(): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function reportRunModeLabel(value: AutomationPerformanceRunMode): string {
  if (value === "test") return "시험 실행";
  if (value === "all") return "전체(시험 포함)";
  return "운영 실행";
}

export function percentLabel(value: number | null): string {
  return value === null ? "-" : `${Math.round(value * 100)}%`;
}

export function compactNumber(value: number, digits = 0): string {
  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: digits }).format(value);
}

export function moneyLabel(value: number): string {
  return new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 }).format(value);
}

export function nullableMoneyLabel(value: number | null): string {
  return value === null ? "-" : moneyLabel(value);
}

export function ratioLabel(value: number | null): string {
  return value === null ? "-" : `${compactNumber(value, 1)}x`;
}

export type CompactMixTone = "blue" | "green" | "amber" | "purple" | "muted";

export type CompactMixItem = {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly tone: CompactMixTone;
};

export const ROI_SOURCE_ORDER: readonly AutomationPerformanceRoiSource[] = ["process_mining", "task_mining", "manual", "imported"];

export const ROI_SOURCE_LABELS: Record<AutomationPerformanceRoiSource, string> = {
  manual: "수기 등록",
  process_mining: "프로세스 마이닝",
  task_mining: "태스크 마이닝",
  imported: "가져오기",
};

export const ROI_SOURCE_TONES: Record<AutomationPerformanceRoiSource, CompactMixTone> = {
  manual: "green",
  process_mining: "blue",
  task_mining: "purple",
  imported: "amber",
};

export const ROI_STAGE_ORDER: readonly AutomationPerformanceRoiStage[] = ["approved", "build", "operate"];

export const ROI_STAGE_LABELS: Record<AutomationPerformanceRoiStage, string> = {
  approved: "승인됨",
  build: "구축 중",
  operate: "운영 중",
};

export const ROI_STAGE_TONES: Record<AutomationPerformanceRoiStage, CompactMixTone> = {
  approved: "green",
  build: "blue",
  operate: "amber",
};

function confidenceLabel(value: AutomationPerformanceReport["summary"]["roi_confidence"]): string {
  return `높음 ${value.high}/중간 ${value.medium}/낮음 ${value.low}`;
}

export function decisionSignalLabel(value: AutomationPerformanceReport["summary"]["decision_signal"]): string {
  if (value.status === "expand") return "확대";
  if (value.status === "hold") return "보류";
  return "관찰";
}

export function roiActualsValue(value: AutomationPerformanceReport["summary"]["roi_actuals"]): string {
  if (value.evidence_count === 0) return "실적 없음";
  if (value.estimated_transaction_count === 0) return `${compactNumber(value.actual_transaction_count)}건 실적`;
  return `${compactNumber(value.comparable_actual_transaction_count)}/${compactNumber(value.estimated_transaction_count)}건`;
}

export function roiActualsNote(value: AutomationPerformanceReport["summary"]["roi_actuals"]): string {
  if (value.evidence_count === 0) return "증거 0건";
  if (value.estimated_transaction_count === 0) return `예상 없음 · 실패율 ${percentLabel(value.actual_failure_rate)}`;
  return `달성 ${percentLabel(value.transaction_attainment_rate)} · 실적 ${compactNumber(value.actual_transaction_count)}건`;
}

export function roiActualsTitle(value: AutomationPerformanceReport["summary"]["roi_actuals"]): string {
  if (value.evidence_count === 0) return "이 리포트 기간에는 ROI 실적 증거가 없습니다";
  return [
    `증거 ${compactNumber(value.evidence_count)}건`,
    `비교 가능/예상 ${compactNumber(value.comparable_actual_transaction_count)}/${compactNumber(value.estimated_transaction_count)}건`,
    `전체 실적 ${compactNumber(value.actual_transaction_count)}건`,
    `달성률 ${percentLabel(value.transaction_attainment_rate)}`,
    `실패율 ${percentLabel(value.comparable_actual_failure_rate)} vs 예상 ${percentLabel(value.estimated_exception_rate)}`,
    `전체 실적 실패율 ${percentLabel(value.actual_failure_rate)}`,
    `증감 ${percentLabel(value.failure_rate_delta)}`,
    `사람 개입 ${compactNumber(value.human_intervention_minutes, 1)}분`,
    `재처리 ${compactNumber(value.reprocessing_minutes, 1)}분`,
    `최근 기간 ${value.latest_period_end ?? "-"}`,
  ].join(" · ");
}

function compactTextList(values: readonly string[], limit: number): string {
  const unique = [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
  if (unique.length === 0) return "";
  const head = unique.slice(0, limit).join(", ");
  const remaining = unique.length - limit;
  return remaining > 0 ? `${head} 외 ${compactNumber(remaining)}` : head;
}

export function roiLineageSourceLabel(lineage: AutomationPerformanceRoiSourceLineage): string {
  const parts = ROI_SOURCE_ORDER
    .map((source) => ({ source, count: lineage.source_counts[source] }))
    .filter((item) => item.count > 0)
    .map((item) => `${ROI_SOURCE_LABELS[item.source]} ${compactNumber(item.count)}`);
  if (parts.length > 0) return parts.join(" · ");
  return lineage.idea_count > 0 ? `${compactNumber(lineage.idea_count)}건` : "근거 없음";
}

export function roiLineageMeta(lineage: AutomationPerformanceRoiSourceLineage): string {
  const departments = compactTextList(lineage.departments, 2);
  const owners = compactTextList(lineage.business_owners, 2);
  const parts: string[] = [];
  if (departments.length > 0) parts.push(`부서 ${departments}`);
  if (owners.length > 0) parts.push(`오너 ${owners}`);
  return parts.length > 0 ? parts.join(" · ") : `${compactNumber(lineage.idea_count)}건`;
}

export function roiLineageTitle(
  lineage: AutomationPerformanceRoiSourceLineage,
  confidence: AutomationPerformanceReport["summary"]["roi_confidence"],
): string {
  const sampleTitles = compactTextList(lineage.sample_ideas.map((idea) => idea.title), 3);
  const sampleText = sampleTitles.length > 0 ? ` · 샘플 ${sampleTitles}` : "";
  return `${roiLineageSourceLabel(lineage)} · ${roiLineageMeta(lineage)} · 신뢰도 ${confidenceLabel(confidence)}${sampleText}`;
}
