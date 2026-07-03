import {
  ApiError,
  type AutomationAdoptionEvidenceStatus,
  type AutomationAdoptionEvidenceType,
  type AutomationIdeaItem,
  type AutomationIdeaSource,
  type ProcessMiningImportItem,
  type ProcessMiningImportSourceType,
  type RoiEstimate,
} from "../../api/types";
import { useApiClient } from "../../api/context";
import { currency, numberLabel, ROI_VIABILITY_LABEL } from "./labels";

export function idempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface RoiPreview {
  monthly_hours_saved: number | null;
  estimated_monthly_value: number | null;
  platform_monthly_cost: number | null;
  avoided_license_cost: number | null;
  monthly_value: number | null;
  payback_months: number | null;
  viability: RoiEstimate["viability"] | null;
}

export interface ApprovalDecision {
  tone: "green" | "amber";
  label: string;
  title: string;
  summary: string;
  items: readonly string[];
}

export function roiPreview(input: RoiFormState): RoiPreview {
  const frequency = Number(input.frequency_per_month);
  const minutes = Number(input.minutes_per_case);
  const exceptionRate = Number(input.exception_rate);
  const hourlyCost = Number(input.hourly_cost);
  const effort = Number(input.implementation_effort);
  const platformMonthlyCost = Number(input.platform_monthly_cost);
  const avoidedLicenseCost = Number(input.avoided_license_cost);
  const monthly_hours_saved = (frequency * minutes * (1 - exceptionRate)) / 60;
  const estimated_monthly_value = monthly_hours_saved * hourlyCost;
  const monthly_value = estimated_monthly_value + avoidedLicenseCost - platformMonthlyCost;
  return {
    monthly_hours_saved,
    estimated_monthly_value,
    platform_monthly_cost: platformMonthlyCost,
    avoided_license_cost: avoidedLicenseCost,
    monthly_value,
    payback_months: monthly_value > 0 ? effort / monthly_value : null,
    viability: monthly_value > 0 ? "viable" : "not_viable",
  };
}

export function roiValidationMessage(input: RoiFormState): string | null {
  const frequency = Number(input.frequency_per_month);
  if (!Number.isInteger(frequency) || frequency < 0) return "월 처리 건수는 0 이상의 정수여야 합니다.";
  const minutes = Number(input.minutes_per_case);
  if (!Number.isFinite(minutes) || minutes < 0) return "건당 소요 시간은 0 이상이어야 합니다.";
  const exceptionRate = Number(input.exception_rate);
  if (!Number.isFinite(exceptionRate) || exceptionRate < 0 || exceptionRate > 1) return "예외율은 0에서 1 사이여야 합니다.";
  const hourlyCost = Number(input.hourly_cost);
  if (!Number.isFinite(hourlyCost) || hourlyCost < 0) return "시간당 비용은 0 이상이어야 합니다.";
  const effort = Number(input.implementation_effort);
  if (!Number.isFinite(effort) || effort < 0) return "자동화 구축 비용은 0 이상이어야 합니다.";
  const platformMonthlyCost = Number(input.platform_monthly_cost);
  if (!Number.isFinite(platformMonthlyCost) || platformMonthlyCost < 0) return "Platform monthly cost must be 0 or greater.";
  const avoidedLicenseCost = Number(input.avoided_license_cost);
  if (!Number.isFinite(avoidedLicenseCost) || avoidedLicenseCost < 0) return "Avoided license cost must be 0 or greater.";
  return null;
}

export function approvalDecision(idea: AutomationIdeaItem | null, roi: RoiEstimate | null | undefined): ApprovalDecision {
  if (idea === null) {
    return {
      tone: "amber",
      label: "선택 필요",
      title: "후보를 선택해 주세요",
      summary: "자동화 후보를 선택하면 ROI와 운영 연결 상태를 기준으로 승인 판단을 보여줍니다.",
      items: ["후보 목록에서 업무를 선택하세요."],
    };
  }

  if (roi === undefined) {
    return {
      tone: "amber",
      label: "확인 중",
      title: "ROI를 확인하고 있습니다",
      summary: "저장된 ROI와 운영 연결 상태를 불러온 뒤 승인 판단을 갱신합니다.",
      items: ["잠시 후 승인 준비 상태를 확인하세요."],
    };
  }

  const items: string[] = [];
  if (roi === null) {
    items.push("ROI를 저장해야 승인 검토를 시작할 수 있습니다.");
  } else {
    items.push(`회수 기간 ${numberLabel(roi.payback_months, "개월")} · 월 절감액 ${currency(roi.estimated_monthly_value)}`);
    items.push(`순 월가치 ${currency(roi.monthly_value)} · 판정 ${ROI_VIABILITY_LABEL[roi.viability]}`);
    if (roi.viability === "not_viable") items.push("플랫폼 비용이 월 절감액을 초과해 유한한 회수 기간을 산정하지 않습니다.");
    if (roi.payback_months === null) items.push("회수 기간을 산정할 수 없어 CoE 검토가 필요합니다.");
    if (roi.payback_months !== null && roi.payback_months > 12) items.push("회수 기간이 12개월을 넘어 우선순위 재검토가 필요합니다.");
    if (roi.confidence === "low") items.push("추정 신뢰도가 낮아 처리 건수나 샘플 근거를 보강해야 합니다.");
  }
  if (idea.scenario_id === null) items.push("자동화 설계안을 연결해야 구축 착수 여부를 판단할 수 있습니다.");
  if (idea.run_trigger_id === null) items.push("운영 예약을 연결해야 실제 운영 전환 범위를 확인할 수 있습니다.");

  const needsWork = roi === null
    || roi.payback_months === null
    || roi.viability === "not_viable"
    || (roi.payback_months !== null && roi.payback_months > 12)
    || roi.confidence === "low"
    || idea.scenario_id === null
    || idea.run_trigger_id === null;

  if (!needsWork) {
    return {
      tone: "green",
      label: "승인 추천",
      title: "CoE 승인 요건을 충족합니다",
      summary: "저장된 ROI, 자동화 설계안, 운영 예약이 모두 준비되어 구축 단계로 넘길 수 있습니다.",
      items,
    };
  }

  return {
    tone: "amber",
    label: "보완 필요",
    title: "승인 전에 보완할 항목이 있습니다",
    summary: "ROI 근거와 실행 연결 상태를 먼저 정리하면 승인 회의에서 바로 판단할 수 있습니다.",
    items,
  };
}

export interface RoiFormState {
  frequency_per_month: string;
  minutes_per_case: string;
  exception_rate: string;
  hourly_cost: string;
  implementation_effort: string;
  platform_monthly_cost: string;
  avoided_license_cost: string;
  confidence: "low" | "medium" | "high";
}

export interface RoiActualFormState {
  period_start: string;
  period_end: string;
  actual_transaction_count: string;
  actual_failure_rate: string;
  human_intervention_minutes: string;
  reprocessing_minutes: string;
  evidence_ref: string;
  summary: string;
}

export interface AdoptionEvidenceFormState {
  evidence_type: AutomationAdoptionEvidenceType;
  status: AutomationAdoptionEvidenceStatus;
  evidence_ref: string;
  summary: string;
}

export interface ProcessMiningImportFormState {
  source_type: ProcessMiningImportSourceType;
  source_system: string;
  source_owner_ref: string;
  schema_version: string;
  import_evidence_ref: string;
  lineage_ref: string;
  row_count: string;
  candidate_count: string;
  import_summary: string;
}

export async function readRoi(api: ReturnType<typeof useApiClient>, ideaId: string): Promise<RoiEstimate | null> {
  try {
    return await api.getRoiEstimate(ideaId);
  } catch (err) {
    if (err instanceof ApiError && err.httpStatus === 404) return null;
    throw err;
  }
}

export function currentMonthActualDefaults(): RoiActualFormState {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    period_start: dateOnly(start),
    period_end: dateOnly(now),
    actual_transaction_count: "0",
    actual_failure_rate: "0",
    human_intervention_minutes: "0",
    reprocessing_minutes: "0",
    evidence_ref: "ticket:ROI-ACTUAL",
    summary: "실행·검토·재처리 증빙으로 정합한 파일럿 실제값입니다.",
  };
}

export function adoptionEvidenceDefaults(): AdoptionEvidenceFormState {
  return {
    evidence_type: "pilot_charter_signoff",
    status: "valid",
    evidence_ref: "ticket:PILOT-123",
    summary: "CoE 담당자가 검토한 파일럿 준비도 증빙입니다.",
  };
}

export function processMiningImportDefaults(): ProcessMiningImportFormState {
  return {
    source_type: "process_mining",
    source_system: "celonis-export",
    source_owner_ref: "group:process-owner",
    schema_version: "2026-06",
    import_evidence_ref: "artifact:pm-import-1",
    lineage_ref: "lineage:pm-import-1",
    row_count: "120",
    candidate_count: "4",
    import_summary: "고객 소유 모니터링에서 집계한 프로세스 마이닝 내보내기입니다.",
  };
}

function dateOnly(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function roiActualValidationMessage(input: RoiActualFormState): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.period_start) || !/^\d{4}-\d{2}-\d{2}$/.test(input.period_end)) return "실제값 기간을 날짜 형식으로 입력해야 합니다.";
  if (input.period_end < input.period_start) return "실제값 종료일은 시작일 이후여야 합니다.";
  const actualCount = Number(input.actual_transaction_count);
  if (!Number.isInteger(actualCount) || actualCount < 0) return "실제 처리 건수는 0 이상의 정수여야 합니다.";
  const failureRate = Number(input.actual_failure_rate);
  if (!Number.isFinite(failureRate) || failureRate < 0 || failureRate > 1) return "실제 실패율은 0에서 1 사이여야 합니다.";
  const intervention = Number(input.human_intervention_minutes);
  if (!Number.isFinite(intervention) || intervention < 0) return "사람 개입 시간은 0 이상이어야 합니다.";
  const reprocessing = Number(input.reprocessing_minutes);
  if (!Number.isFinite(reprocessing) || reprocessing < 0) return "재처리 시간은 0 이상이어야 합니다.";
  if (input.evidence_ref.trim().length === 0) return "실제값 근거 참조가 필요합니다.";
  if (input.summary.trim().length === 0) return "실제값 요약이 필요합니다.";
  return null;
}

export function adoptionEvidenceValidationMessage(input: AdoptionEvidenceFormState): string | null {
  if (input.evidence_ref.trim().length === 0) return "파일럿 증빙 참조가 필요합니다.";
  if (input.summary.trim().length === 0) return "파일럿 증빙 요약이 필요합니다.";
  return null;
}

export function processImportValidationMessage(input: ProcessMiningImportFormState): string | null {
  if (input.source_system.trim().length === 0) return "원본 시스템을 입력해야 합니다.";
  if (input.source_owner_ref.trim().length === 0) return "원본 담당자를 입력해야 합니다.";
  if (input.schema_version.trim().length === 0) return "스키마 버전을 입력해야 합니다.";
  if (input.import_evidence_ref.trim().length === 0) return "가져오기 증빙 참조가 필요합니다.";
  if (input.lineage_ref.trim().length === 0) return "계보 참조가 필요합니다.";
  const rowCount = Number(input.row_count);
  if (!Number.isInteger(rowCount) || rowCount < 1) return "행 수는 1 이상이어야 합니다.";
  const candidateCount = Number(input.candidate_count);
  if (!Number.isInteger(candidateCount) || candidateCount < 0 || candidateCount > rowCount) return "후보 수는 0에서 행 수 사이여야 합니다.";
  if (input.import_summary.trim().length === 0) return "가져오기 요약이 필요합니다.";
  return null;
}

export function schemaMappingForSource(sourceType: ProcessMiningImportSourceType): Readonly<Record<string, unknown>> {
  if (sourceType === "task_mining") {
    return { task_name: "task_alias", application_alias: "application_alias", timestamp: "event_at" };
  }
  return { case_id: "case_alias", activity: "activity_name", timestamp: "event_at" };
}

export function ideaSourceRequiresImport(source: AutomationIdeaSource): boolean {
  return source === "process_mining" || source === "task_mining" || source === "imported";
}

export function importMatchesIdeaSource(source: AutomationIdeaSource, item: ProcessMiningImportItem): boolean {
  if (source === "process_mining") return item.source_type === "process_mining";
  if (source === "task_mining") return item.source_type === "task_mining";
  if (source === "imported") return item.source_type === "monitoring_export" || item.source_type === "api_import";
  return false;
}

export function appendUniqueIdeas(
  current: readonly AutomationIdeaItem[],
  incoming: readonly AutomationIdeaItem[],
): AutomationIdeaItem[] {
  const seen = new Set(current.map((item) => item.idea_id));
  const merged = [...current];
  for (const item of incoming) {
    if (seen.has(item.idea_id)) continue;
    seen.add(item.idea_id);
    merged.push(item);
  }
  return merged;
}
