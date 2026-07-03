// run outcome 집계(api-surface §1 GET /v1/runs/summary). by_status=runs.status별 정확 카운트(부재 status는 키 생략).
// success_rate=completed/(completed+failed_business+failed_system), 분모 0이면 null(0/0 단정 금지).
export interface RunSummary {
  readonly by_status: Record<string, number>;
  readonly success_rate: number | null;
  readonly total: number;
  // cache_hit_rate(§E): ActionPlanCache 조회 적중률. by_mode=run_steps.cache_mode별 카운트,
  // hit_rate=hit/(조회=non-bypass), 조회 0이면 null. (bypass=캐시 미조회 → 분모 제외)
  readonly cache: { readonly by_mode: Record<string, number>; readonly hit_rate: number | null };
}

// run outcome 일별 추세(api-surface §1 GET /v1/runs/trends). 윈도우 내 모든 날 포함(0건 날도 — 스파크라인 연속).
// success_rate=completed/(completed+failed_business+failed_system), 그 날 분모 0이면 null(0/0 단정 금지).
export interface RunTrendPoint {
  readonly day: string;
  readonly completed: number;
  readonly failed_business: number;
  readonly failed_system: number;
  readonly total: number;
  readonly success_rate: number | null;
}

export interface RunTrends {
  readonly window_days: number;
  readonly timezone: string;
  readonly points: readonly RunTrendPoint[];
}

export interface AutomationPerformanceSummary {
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
  readonly cost_by_status: AutomationPerformanceCostByStatus;
  readonly failed_cost: number;
  readonly rerun_cost: number;
  readonly avg_cost_per_run: number | null;
  readonly cost_per_completed_run: number | null;
  readonly llm_call_cost: number | null;
  readonly run_vs_call_cost_delta: number | null;
  readonly roi_idea_count: number;
  readonly roi_confidence: AutomationPerformanceRoiConfidence;
  readonly roi_source_lineage: AutomationPerformanceRoiSourceLineage;
  readonly roi_actuals: AutomationPerformanceRoiActuals;
  readonly decision_signal: AutomationPerformanceDecisionSignal;
}

export interface AutomationPerformanceCostByStatus {
  readonly completed: number;
  readonly failed_business: number;
  readonly failed_system: number;
  readonly other: number;
}

export interface AutomationPerformanceRoiConfidence {
  readonly low: number;
  readonly medium: number;
  readonly high: number;
}

export type AutomationPerformanceRoiSource = "manual" | "process_mining" | "task_mining" | "imported";

export type AutomationPerformanceRoiStage = "approved" | "build" | "operate";

export interface AutomationPerformanceRoiSourceCounts {
  readonly manual: number;
  readonly process_mining: number;
  readonly task_mining: number;
  readonly imported: number;
}

export interface AutomationPerformanceRoiStageCounts {
  readonly approved: number;
  readonly build: number;
  readonly operate: number;
}

export interface AutomationPerformanceRoiSourceLineageIdea {
  readonly idea_id: string;
  readonly title: string;
  readonly source: AutomationPerformanceRoiSource;
  readonly stage: AutomationPerformanceRoiStage;
  readonly department: string;
  readonly business_owner: string;
}

export interface AutomationPerformanceRoiSourceLineage {
  readonly idea_count: number;
  readonly source_counts: AutomationPerformanceRoiSourceCounts;
  readonly stage_counts: AutomationPerformanceRoiStageCounts;
  readonly departments: readonly string[];
  readonly business_owners: readonly string[];
  readonly sample_ideas: readonly AutomationPerformanceRoiSourceLineageIdea[];
}

export interface AutomationPerformanceRoiActuals {
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

export interface AutomationPerformanceDecisionSignal {
  readonly status: "expand" | "hold" | "watch";
  readonly reason: string;
}

export interface AutomationPerformanceCostByModel {
  readonly model: string;
  readonly calls: number;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cost: number | null;
  readonly cost_share: number | null;
}

export interface AutomationPerformanceModelCostTrend {
  readonly day: string;
  readonly model: string;
  readonly calls: number;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cost: number | null;
  readonly cost_share_of_day: number | null;
  readonly cost_delta_from_previous_day_for_model: number | null;
}

export interface AutomationPerformanceFailureTop {
  readonly code: string;
  readonly count: number;
}

export interface AutomationPerformanceWorkflow {
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
  readonly cost_by_status: AutomationPerformanceCostByStatus;
  readonly rerun_cost: number;
  readonly avg_cost_per_run: number | null;
  readonly cost_per_completed_run: number | null;
  readonly roi_idea_count: number;
  readonly roi_confidence: AutomationPerformanceRoiConfidence;
  readonly roi_source_lineage: AutomationPerformanceRoiSourceLineage;
  readonly roi_actuals: AutomationPerformanceRoiActuals;
  readonly decision_signal: AutomationPerformanceDecisionSignal;
}

export interface AutomationPerformanceTrend {
  readonly day: string;
  readonly total_runs: number;
  readonly completed: number;
  readonly failed_business: number;
  readonly failed_system: number;
  readonly success_rate: number | null;
  readonly rerun_count: number;
  readonly reprocessing_rate: number | null;
  readonly gateway_cost: number;
  readonly cost_by_status: AutomationPerformanceCostByStatus;
  readonly rerun_cost: number;
  readonly avg_cost_per_run: number | null;
  readonly cost_per_completed_run: number | null;
  readonly cost_delta_from_previous_day: number | null;
}

export interface AutomationPerformanceReport {
  readonly month: string;
  readonly run_mode: AutomationPerformanceRunMode;
  readonly timezone: "Asia/Seoul";
  readonly period_start: string;
  readonly period_end: string;
  readonly summary: AutomationPerformanceSummary;
  readonly cost_by_model: readonly AutomationPerformanceCostByModel[];
  readonly model_cost_trends: readonly AutomationPerformanceModelCostTrend[];
  readonly failure_top: readonly AutomationPerformanceFailureTop[];
  readonly trends: readonly AutomationPerformanceTrend[];
  readonly by_workflow: readonly AutomationPerformanceWorkflow[];
}

export type AutomationPerformanceReportExportFormat = "csv" | "xlsx" | "poc_markdown";
export type AutomationPerformanceRunMode = "prod" | "test" | "all";
