import type { ListParams, Paginated } from "./types-common";

export type AutomationIdeaStage = "intake" | "assess" | "approved" | "build" | "operate" | "rejected" | "archived";
export type AutomationIdeaPriority = "low" | "medium" | "high" | "critical";
export type AutomationIdeaSource = "manual" | "process_mining" | "task_mining" | "imported";
export type ProcessMiningImportSourceType = "process_mining" | "task_mining" | "monitoring_export" | "api_import";
export type ProcessMiningImportStatus = "received" | "processed" | "blocked";
export type ProcessMiningImportAnonymizationMode = "aggregated_alias" | "pseudonymized" | "not_applicable";
export type AutomationAdoptionEvidenceType = "pilot_charter_signoff" | "raci_signoff" | "training_completion" | "support_model_signoff";
export type AutomationAdoptionEvidenceStatus = "valid" | "failed" | "deferred";
export type RoiConfidence = "low" | "medium" | "high";
export type RoiViability = "viable" | "not_viable";

export interface AutomationIdeaItem {
  readonly idea_id: string;
  readonly title: string;
  readonly description: string;
  readonly business_owner: string;
  readonly department: string;
  readonly source: AutomationIdeaSource;
  readonly stage: AutomationIdeaStage;
  readonly priority: AutomationIdeaPriority;
  readonly score: number;
  readonly scenario_id: string | null;
  readonly run_trigger_id: string | null;
  readonly source_import_id: string | null;
  readonly source_item_ref: string | null;
  readonly source_lineage: Readonly<Record<string, unknown>>;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface AutomationIdeaListParams extends ListParams {
  readonly stage?: AutomationIdeaStage;
  readonly owner?: string;
  readonly department?: string;
}

export interface AutomationIdeaCreateBody {
  readonly title: string;
  readonly description: string;
  readonly business_owner: string;
  readonly department: string;
  readonly source?: AutomationIdeaSource;
  readonly priority?: AutomationIdeaPriority;
  readonly score?: number;
  readonly source_import_id?: string;
  readonly source_item_ref?: string;
  readonly source_lineage?: Readonly<Record<string, unknown>>;
}

export interface AutomationIdeaUpdateBody {
  readonly title?: string;
  readonly description?: string;
  readonly business_owner?: string;
  readonly department?: string;
  readonly priority?: AutomationIdeaPriority;
  readonly score?: number;
  readonly scenario_id?: string | null;
  readonly run_trigger_id?: string | null;
}

export interface ProcessMiningImportItem {
  readonly import_id: string;
  readonly source_type: ProcessMiningImportSourceType;
  readonly source_system: string;
  readonly source_owner_ref: string;
  readonly schema_version: string;
  readonly import_evidence_ref: string;
  readonly lineage_ref: string;
  readonly row_count: number;
  readonly candidate_count: number;
  readonly anonymization_mode: ProcessMiningImportAnonymizationMode;
  readonly schema_mapping: Readonly<Record<string, unknown>>;
  readonly import_summary: string;
  readonly status: ProcessMiningImportStatus;
  readonly blocked_reason: string | null;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ProcessMiningImportListParams extends ListParams {
  readonly source_type?: ProcessMiningImportSourceType;
  readonly status?: ProcessMiningImportStatus;
}

export interface ProcessMiningImportCreateBody {
  readonly source_type: ProcessMiningImportSourceType;
  readonly source_system: string;
  readonly source_owner_ref: string;
  readonly schema_version: string;
  readonly import_evidence_ref: string;
  readonly lineage_ref: string;
  readonly row_count: number;
  readonly candidate_count: number;
  readonly anonymization_mode?: ProcessMiningImportAnonymizationMode;
  readonly schema_mapping: Readonly<Record<string, unknown>>;
  readonly import_summary: string;
  readonly status?: ProcessMiningImportStatus;
  readonly blocked_reason?: string | null;
}

export interface AutomationAdoptionEvidenceItem {
  readonly evidence_id: string;
  readonly idea_id: string;
  readonly evidence_type: AutomationAdoptionEvidenceType;
  readonly status: AutomationAdoptionEvidenceStatus;
  readonly evidence_at: string;
  readonly expires_at: string | null;
  readonly summary: string;
  readonly evidence_ref: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly recorded_by: string;
  readonly recorded_at: string;
  readonly legal_hold: boolean;
}

export interface AutomationAdoptionEvidenceRequest {
  readonly evidence_type: AutomationAdoptionEvidenceType;
  readonly status: AutomationAdoptionEvidenceStatus;
  readonly evidence_at: string;
  readonly expires_at?: string | null;
  readonly summary: string;
  readonly evidence_ref?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly legal_hold?: boolean;
}

export type AutomationAdoptionEvidencePage = Paginated<AutomationAdoptionEvidenceItem>;

export interface AutomationAdoptionEvidenceListParams extends ListParams {
  readonly evidence_type?: AutomationAdoptionEvidenceType;
  readonly status?: AutomationAdoptionEvidenceStatus;
}

export interface RoiEstimateRequest {
  readonly frequency_per_month: number;
  readonly minutes_per_case: number;
  readonly exception_rate: number;
  readonly hourly_cost: number;
  readonly implementation_effort: number;
  readonly platform_monthly_cost?: number;
  readonly avoided_license_cost?: number;
  readonly confidence?: RoiConfidence;
}

export interface RoiEstimate {
  readonly roi_estimate_id: string;
  readonly automation_idea_id: string;
  readonly frequency_per_month: number;
  readonly minutes_per_case: number;
  readonly exception_rate: number;
  readonly hourly_cost: number;
  readonly implementation_effort: number;
  readonly platform_monthly_cost: number;
  readonly avoided_license_cost: number;
  readonly monthly_hours_saved: number;
  readonly estimated_monthly_value: number;
  readonly monthly_value: number;
  readonly payback_months: number | null;
  readonly viability: RoiViability;
  readonly confidence: RoiConfidence;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RoiActualEvidenceRequest {
  readonly period_start: string;
  readonly period_end: string;
  readonly actual_transaction_count: number;
  readonly actual_failure_rate: number;
  readonly human_intervention_minutes: number;
  readonly reprocessing_minutes: number;
  readonly evidence_ref: string;
  readonly summary: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly legal_hold?: boolean;
}

/**
 * ROI 실적 프리필 제안(read-only) — 연결 자동화의 기간 내 prod 실행 통계 기반 **제안일 뿐 증거가 아니다**.
 * 미연결/종결 0건이면 집계·제안 필드가 null(0으로 합성 금지). 확정은 사람이 실적 저장(POST)할 때만.
 */
export interface RoiActualSuggestion {
  readonly automation_idea_id: string;
  readonly scenario_id: string | null;
  readonly period_start: string;
  readonly period_end: string;
  readonly run_mode: "prod";
  readonly total_runs: number | null;
  readonly completed_runs: number | null;
  readonly failed_runs: number | null;
  readonly suggested_actual_transaction_count: number | null;
  readonly suggested_actual_failure_rate: number | null;
}

export interface RoiActualEvidence {
  readonly roi_actual_id: string;
  readonly automation_idea_id: string;
  readonly period_start: string;
  readonly period_end: string;
  readonly actual_transaction_count: number;
  readonly actual_failure_rate: number;
  readonly human_intervention_minutes: number;
  readonly reprocessing_minutes: number;
  readonly evidence_ref: string;
  readonly summary: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly recorded_by: string;
  readonly recorded_at: string;
  readonly legal_hold: boolean;
}
