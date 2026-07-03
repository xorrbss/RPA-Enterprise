// automation-performance-report.ts 에서 추출 — 리포트 공유 상수·행/항목 타입(동작 무변경 이동).

export const REPORT_TZ = "Asia/Seoul";
export const ROI_SOURCES = ["manual", "process_mining", "task_mining", "imported"] as const;
export const ROI_STAGES = ["approved", "build", "operate"] as const;
export const ROI_LINEAGE_SAMPLE_LIMIT = 5;
export type RunModeScope = "prod" | "test" | "all";

export interface ReportPeriod {
  readonly month: string;
  readonly start: Date;
  readonly end: Date;
}

export interface WorkflowReportRow {
  scenario_id: string;
  scenario_name: string;
  total_runs: number;
  completed: number;
  failed_business: number;
  failed_system: number;
  rerun_count: number;
  rerun_cost: string;
  estimated_hours_saved: string;
  estimated_value: string;
  estimated_transaction_count: string;
  estimated_exception_rate: string | null;
  implementation_effort: string;
  roi_idea_count: number;
  confidence_low: number;
  confidence_medium: number;
  confidence_high: number;
  roi_ideas: unknown;
  actual_evidence_count: number;
  actual_transaction_count: number;
  actual_failure_rate: string | null;
  human_intervention_minutes: string;
  reprocessing_minutes: string;
  latest_actual_period_end: string | null;
  gateway_cost: string;
  completed_cost: string;
  failed_business_cost: string;
  failed_system_cost: string;
  other_cost: string;
}

export interface FailureTopRow {
  code: string;
  count: number;
}

export interface TrendReportRow {
  day: string;
  total_runs: number;
  completed: number;
  failed_business: number;
  failed_system: number;
  rerun_count: number;
  rerun_cost: string;
  gateway_cost: string;
  completed_cost: string;
  failed_business_cost: string;
  failed_system_cost: string;
  other_cost: string;
}

export interface CostByModelRow {
  model: string;
  calls: number;
  input_tokens: string | null;
  output_tokens: string | null;
  cost: string | null;
}

export interface ModelCostTrendRow {
  day: string;
  model: string;
  calls: number;
  input_tokens: string | null;
  output_tokens: string | null;
  cost: string | null;
  day_known_cost: string | null;
}

export interface CostByStatus {
  readonly completed: number;
  readonly failed_business: number;
  readonly failed_system: number;
  readonly other: number;
}

export interface RoiConfidenceBreakdown {
  readonly low: number;
  readonly medium: number;
  readonly high: number;
}

export type RoiSource = "manual" | "process_mining" | "task_mining" | "imported";
export type RoiStage = "approved" | "build" | "operate";

export interface RoiSourceCounts {
  manual: number;
  process_mining: number;
  task_mining: number;
  imported: number;
}

export interface RoiStageCounts {
  approved: number;
  build: number;
  operate: number;
}

export interface RoiLineageIdea {
  readonly idea_id: string;
  readonly title: string;
  readonly source: RoiSource;
  readonly stage: RoiStage;
  readonly department: string;
  readonly business_owner: string;
}

export interface RoiSourceLineage {
  readonly idea_count: number;
  readonly source_counts: RoiSourceCounts;
  readonly stage_counts: RoiStageCounts;
  readonly departments: readonly string[];
  readonly business_owners: readonly string[];
  readonly sample_ideas: readonly RoiLineageIdea[];
}

export type DecisionSignalStatus = "expand" | "hold" | "watch";

export interface DecisionSignal {
  readonly status: DecisionSignalStatus;
  readonly reason: string;
}

export interface RoiActualsSummary {
  readonly evidence_count: number;
  readonly estimated_transaction_count: number;
  readonly actual_transaction_count: number;
  readonly comparable_actual_transaction_count: number;
  readonly transaction_attainment_rate: number | null;
  readonly estimated_exception_rate: number | null;
  readonly actual_failure_rate: number | null;
  readonly comparable_actual_failure_rate: number | null;
  readonly failure_rate_delta: number | null;
  readonly human_intervention_minutes: number;
  readonly reprocessing_minutes: number;
  readonly latest_period_end: string | null;
}

export interface CostByModelItem {
  readonly model: string;
  readonly calls: number;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cost: number | null;
  readonly cost_share: number | null;
}

export interface ModelCostTrendItem {
  readonly day: string;
  readonly model: string;
  readonly calls: number;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cost: number | null;
  readonly cost_share_of_day: number | null;
  readonly cost_delta_from_previous_day_for_model: number | null;
}

export interface TrendReportItem {
  readonly day: string;
  readonly total_runs: number;
  readonly completed: number;
  readonly failed_business: number;
  readonly failed_system: number;
  readonly success_rate: number | null;
  readonly rerun_count: number;
  readonly reprocessing_rate: number | null;
  readonly gateway_cost: number;
  readonly cost_by_status: CostByStatus;
  readonly rerun_cost: number;
  readonly avg_cost_per_run: number | null;
  readonly cost_per_completed_run: number | null;
  readonly cost_delta_from_previous_day: number | null;
}

export interface WorkflowReportItem {
  readonly scenario_id: string;
  readonly scenario_name: string;
  readonly total_runs: number;
  readonly completed: number;
  readonly failed_business: number;
  readonly failed_system: number;
  readonly success_rate: number | null;
  readonly rerun_count: number;
  readonly reprocessing_rate: number | null;
  readonly estimated_hours_saved: number;
  readonly estimated_value: number;
  readonly implementation_effort: number;
  readonly net_value: number;
  readonly value_to_cost_ratio: number | null;
  readonly payback_months: number | null;
  readonly gateway_cost: number;
  readonly cost_by_status: CostByStatus;
  readonly rerun_cost: number;
  readonly avg_cost_per_run: number | null;
  readonly cost_per_completed_run: number | null;
  readonly roi_idea_count: number;
  readonly roi_confidence: RoiConfidenceBreakdown;
  readonly roi_source_lineage: RoiSourceLineage;
  readonly roi_actuals: RoiActualsSummary;
  readonly decision_signal: DecisionSignal;
}

export interface AutomationPerformanceReport {
  readonly month: string;
  readonly run_mode: RunModeScope;
  readonly timezone: typeof REPORT_TZ;
  readonly period_start: string;
  readonly period_end: string;
  readonly summary: {
    readonly total_runs: number;
    readonly completed: number;
    readonly failed_business: number;
    readonly failed_system: number;
    readonly success_rate: number | null;
    readonly rerun_count: number;
    readonly reprocessing_rate: number | null;
    readonly estimated_hours_saved: number;
    readonly estimated_value: number;
    readonly implementation_effort: number;
    readonly net_value: number;
    readonly value_to_cost_ratio: number | null;
    readonly payback_months: number | null;
    readonly gateway_cost: number;
    readonly cost_by_status: CostByStatus;
    readonly failed_cost: number;
    readonly rerun_cost: number;
    readonly avg_cost_per_run: number | null;
    readonly cost_per_completed_run: number | null;
    readonly llm_call_cost: number | null;
    readonly run_vs_call_cost_delta: number | null;
    readonly roi_idea_count: number;
    readonly roi_confidence: RoiConfidenceBreakdown;
    readonly roi_source_lineage: RoiSourceLineage;
    readonly roi_actuals: RoiActualsSummary;
    readonly decision_signal: DecisionSignal;
  };
  readonly cost_by_model: readonly CostByModelItem[];
  readonly model_cost_trends: readonly ModelCostTrendItem[];
  readonly failure_top: readonly FailureTopRow[];
  readonly trends: readonly TrendReportItem[];
  readonly by_workflow: readonly WorkflowReportItem[];
}
