// automation-performance-report.ts 에서 추출 — ROI 계보 파싱·행 매핑·요약/판정 계산(동작 무변경 이동).
import {
  ROI_LINEAGE_SAMPLE_LIMIT,
  ROI_SOURCES,
  ROI_STAGES,
  type AutomationPerformanceReport,
  type CostByModelItem,
  type CostByModelRow,
  type DecisionSignal,
  type ModelCostTrendItem,
  type ModelCostTrendRow,
  type RoiActualsSummary,
  type RoiLineageIdea,
  type RoiSource,
  type RoiSourceCounts,
  type RoiSourceLineage,
  type RoiStage,
  type RoiStageCounts,
  type TrendReportItem,
  type TrendReportRow,
  type WorkflowReportItem,
  type WorkflowReportRow,
} from "./automation-performance-report-types";

function roiSourceLineageFromRaw(raw: unknown): RoiSourceLineage {
  if (!Array.isArray(raw)) {
    throw new Error("Invalid ROI source lineage row: expected array");
  }
  const ideas = raw.map(parseRoiLineageIdea);
  return roiSourceLineageFromIdeas(ideas);
}

function parseRoiLineageIdea(raw: unknown): RoiLineageIdea {
  const record = asRecord(raw);
  if (record === null) throw new Error("Invalid ROI source lineage row: expected object");
  const ideaId = requiredString(record.idea_id, "idea_id");
  const title = requiredString(record.title, "title");
  const source = requiredRoiSource(record.source);
  const stage = requiredRoiStage(record.stage);
  const department = requiredString(record.department, "department");
  const businessOwner = requiredString(record.business_owner, "business_owner");
  return { idea_id: ideaId, title, source, stage, department, business_owner: businessOwner };
}

function roiSourceLineageFromIdeas(ideas: readonly RoiLineageIdea[]): RoiSourceLineage {
  const sourceCounts = emptyRoiSourceCounts();
  const stageCounts = emptyRoiStageCounts();
  const departments: string[] = [];
  const businessOwners: string[] = [];
  for (const idea of ideas) {
    sourceCounts[idea.source] += 1;
    stageCounts[idea.stage] += 1;
    pushUniqueBounded(departments, idea.department, ROI_LINEAGE_SAMPLE_LIMIT);
    pushUniqueBounded(businessOwners, idea.business_owner, ROI_LINEAGE_SAMPLE_LIMIT);
  }
  return {
    idea_count: ideas.length,
    source_counts: sourceCounts,
    stage_counts: stageCounts,
    departments,
    business_owners: businessOwners,
    sample_ideas: ideas.slice(0, ROI_LINEAGE_SAMPLE_LIMIT),
  };
}

function summarizeRoiSourceLineage(byWorkflow: readonly WorkflowReportItem[]): RoiSourceLineage {
  const sourceCounts = emptyRoiSourceCounts();
  const stageCounts = emptyRoiStageCounts();
  const departments: string[] = [];
  const businessOwners: string[] = [];
  const sampleIdeas: RoiLineageIdea[] = [];
  let ideaCount = 0;
  for (const row of byWorkflow) {
    ideaCount += row.roi_source_lineage.idea_count;
    for (const source of ROI_SOURCES) sourceCounts[source] += row.roi_source_lineage.source_counts[source];
    for (const stage of ROI_STAGES) stageCounts[stage] += row.roi_source_lineage.stage_counts[stage];
    for (const department of row.roi_source_lineage.departments) pushUniqueBounded(departments, department, ROI_LINEAGE_SAMPLE_LIMIT);
    for (const owner of row.roi_source_lineage.business_owners) pushUniqueBounded(businessOwners, owner, ROI_LINEAGE_SAMPLE_LIMIT);
    for (const idea of row.roi_source_lineage.sample_ideas) {
      if (sampleIdeas.length < ROI_LINEAGE_SAMPLE_LIMIT) sampleIdeas.push(idea);
    }
  }
  return {
    idea_count: ideaCount,
    source_counts: sourceCounts,
    stage_counts: stageCounts,
    departments,
    business_owners: businessOwners,
    sample_ideas: sampleIdeas,
  };
}

function emptyRoiSourceCounts(): RoiSourceCounts {
  return { manual: 0, process_mining: 0, task_mining: 0, imported: 0 };
}

function emptyRoiStageCounts(): RoiStageCounts {
  return { approved: 0, build: 0, operate: 0 };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ROI source lineage row: ${field}`);
  }
  return value;
}

function requiredRoiSource(value: unknown): RoiSource {
  if (isRoiSource(value)) return value;
  throw new Error("Invalid ROI source lineage row: source");
}

function requiredRoiStage(value: unknown): RoiStage {
  if (isRoiStage(value)) return value;
  throw new Error("Invalid ROI source lineage row: stage");
}

function isRoiSource(value: unknown): value is RoiSource {
  return typeof value === "string" && ROI_SOURCES.includes(value as RoiSource);
}

function isRoiStage(value: unknown): value is RoiStage {
  return typeof value === "string" && ROI_STAGES.includes(value as RoiStage);
}

function pushUniqueBounded(values: string[], value: string, limit: number): void {
  if (values.length >= limit || values.includes(value)) return;
  values.push(value);
}

function latestDateString(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left >= right ? left : right;
}

export function mapWorkflowRow(row: WorkflowReportRow): WorkflowReportItem {
  const rated = row.completed + row.failed_business + row.failed_system;
  const estimatedValue = Number(row.estimated_value);
  const implementationEffort = Number(row.implementation_effort);
  const gatewayCost = Number(row.gateway_cost);
  const completedCost = Number(row.completed_cost);
  const successRate = rated > 0 ? row.completed / rated : null;
  const reprocessingRate = row.total_runs > 0 ? row.rerun_count / row.total_runs : null;
  const netValue = estimatedValue - gatewayCost;
  const roiSourceLineage = roiSourceLineageFromRaw(row.roi_ideas);
  const roiActuals = roiActualsFromWorkflowRow(row);
  return {
    scenario_id: row.scenario_id,
    scenario_name: row.scenario_name,
    total_runs: row.total_runs,
    completed: row.completed,
    failed_business: row.failed_business,
    failed_system: row.failed_system,
    success_rate: successRate,
    rerun_count: row.rerun_count,
    reprocessing_rate: reprocessingRate,
    estimated_hours_saved: Number(row.estimated_hours_saved),
    estimated_value: estimatedValue,
    implementation_effort: implementationEffort,
    net_value: netValue,
    value_to_cost_ratio: gatewayCost > 0 ? estimatedValue / gatewayCost : null,
    payback_months: estimatedValue > 0 ? implementationEffort / estimatedValue : null,
    gateway_cost: gatewayCost,
    cost_by_status: {
      completed: completedCost,
      failed_business: Number(row.failed_business_cost),
      failed_system: Number(row.failed_system_cost),
      other: Number(row.other_cost),
    },
    rerun_cost: Number(row.rerun_cost),
    avg_cost_per_run: row.total_runs > 0 ? gatewayCost / row.total_runs : null,
    cost_per_completed_run: row.completed > 0 ? completedCost / row.completed : null,
    roi_idea_count: row.roi_idea_count,
    roi_confidence: {
      low: row.confidence_low,
      medium: row.confidence_medium,
      high: row.confidence_high,
    },
    roi_source_lineage: roiSourceLineage,
    roi_actuals: roiActuals,
    decision_signal: decisionSignalFor({
      total_runs: row.total_runs,
      success_rate: successRate,
      reprocessing_rate: reprocessingRate,
      net_value: netValue,
      failures: row.failed_business + row.failed_system,
      scope: "workflow",
    }),
  };
}

function roiActualsFromWorkflowRow(row: WorkflowReportRow): RoiActualsSummary {
  const estimatedTransactionCount = Number(row.estimated_transaction_count);
  const actualTransactionCount = row.actual_transaction_count;
  const comparableActualTransactionCount = estimatedTransactionCount > 0 ? actualTransactionCount : 0;
  const estimatedExceptionRate = row.estimated_exception_rate === null ? null : Number(row.estimated_exception_rate);
  const actualFailureRate = row.actual_failure_rate === null ? null : Number(row.actual_failure_rate);
  const comparableActualFailureRate = comparableActualTransactionCount > 0 ? actualFailureRate : null;
  return {
    evidence_count: row.actual_evidence_count,
    estimated_transaction_count: estimatedTransactionCount,
    actual_transaction_count: actualTransactionCount,
    comparable_actual_transaction_count: comparableActualTransactionCount,
    transaction_attainment_rate: estimatedTransactionCount > 0 ? comparableActualTransactionCount / estimatedTransactionCount : null,
    estimated_exception_rate: estimatedExceptionRate,
    actual_failure_rate: actualFailureRate,
    comparable_actual_failure_rate: comparableActualFailureRate,
    failure_rate_delta: estimatedExceptionRate !== null && comparableActualFailureRate !== null ? comparableActualFailureRate - estimatedExceptionRate : null,
    human_intervention_minutes: Number(row.human_intervention_minutes),
    reprocessing_minutes: Number(row.reprocessing_minutes),
    latest_period_end: row.latest_actual_period_end,
  };
}

export function mapTrendRows(rows: readonly TrendReportRow[]): readonly TrendReportItem[] {
  const out: TrendReportItem[] = [];
  for (const row of rows) {
    out.push(mapTrendRow(row, out[out.length - 1]));
  }
  return out;
}

function mapTrendRow(row: TrendReportRow, previous: TrendReportItem | undefined): TrendReportItem {
  const rated = row.completed + row.failed_business + row.failed_system;
  const gatewayCost = Number(row.gateway_cost);
  const completedCost = Number(row.completed_cost);
  return {
    day: row.day,
    total_runs: row.total_runs,
    completed: row.completed,
    failed_business: row.failed_business,
    failed_system: row.failed_system,
    success_rate: rated > 0 ? row.completed / rated : null,
    rerun_count: row.rerun_count,
    reprocessing_rate: row.total_runs > 0 ? row.rerun_count / row.total_runs : null,
    gateway_cost: gatewayCost,
    cost_by_status: {
      completed: completedCost,
      failed_business: Number(row.failed_business_cost),
      failed_system: Number(row.failed_system_cost),
      other: Number(row.other_cost),
    },
    rerun_cost: Number(row.rerun_cost),
    avg_cost_per_run: row.total_runs > 0 ? gatewayCost / row.total_runs : null,
    cost_per_completed_run: row.completed > 0 ? completedCost / row.completed : null,
    cost_delta_from_previous_day: previous === undefined ? null : gatewayCost - previous.gateway_cost,
  };
}

export function mapCostByModelRows(rows: readonly CostByModelRow[]): readonly CostByModelItem[] {
  const totalKnownCost = rows.reduce((sum, row) => sum + (row.cost === null ? 0 : Number(row.cost)), 0);
  return rows.map((row) => {
    const cost = row.cost === null ? null : Number(row.cost);
    return {
      model: row.model,
      calls: row.calls,
      input_tokens: row.input_tokens === null ? null : Number(row.input_tokens),
      output_tokens: row.output_tokens === null ? null : Number(row.output_tokens),
      cost,
      cost_share: cost !== null && totalKnownCost > 0 ? cost / totalKnownCost : null,
    };
  });
}

export function mapModelCostTrendRows(rows: readonly ModelCostTrendRow[]): readonly ModelCostTrendItem[] {
  const previousKnownCostByModel = new Map<string, number>();
  return rows.map((row) => {
    const cost = row.cost === null ? null : Number(row.cost);
    const dayKnownCost = row.day_known_cost === null ? null : Number(row.day_known_cost);
    const previousCost = previousKnownCostByModel.get(row.model);
    const costDelta = cost !== null && previousCost !== undefined ? cost - previousCost : null;
    if (cost !== null) previousKnownCostByModel.set(row.model, cost);
    return {
      day: row.day,
      model: row.model,
      calls: row.calls,
      input_tokens: row.input_tokens === null ? null : Number(row.input_tokens),
      output_tokens: row.output_tokens === null ? null : Number(row.output_tokens),
      cost,
      cost_share_of_day: cost !== null && dayKnownCost !== null && dayKnownCost > 0 ? cost / dayKnownCost : null,
      cost_delta_from_previous_day_for_model: costDelta,
    };
  });
}

export function summarizeWorkflows(
  byWorkflow: readonly WorkflowReportItem[],
  costByModel: readonly CostByModelItem[],
): AutomationPerformanceReport["summary"] {
  const totals = byWorkflow.reduce(
    (acc, row) => ({
      total_runs: acc.total_runs + row.total_runs,
      completed: acc.completed + row.completed,
      failed_business: acc.failed_business + row.failed_business,
      failed_system: acc.failed_system + row.failed_system,
      rerun_count: acc.rerun_count + row.rerun_count,
      estimated_hours_saved: acc.estimated_hours_saved + row.estimated_hours_saved,
      estimated_value: acc.estimated_value + row.estimated_value,
      implementation_effort: acc.implementation_effort + row.implementation_effort,
      gateway_cost: acc.gateway_cost + row.gateway_cost,
      completed_cost: acc.completed_cost + row.cost_by_status.completed,
      failed_business_cost: acc.failed_business_cost + row.cost_by_status.failed_business,
      failed_system_cost: acc.failed_system_cost + row.cost_by_status.failed_system,
      other_cost: acc.other_cost + row.cost_by_status.other,
      rerun_cost: acc.rerun_cost + row.rerun_cost,
      roi_idea_count: acc.roi_idea_count + row.roi_idea_count,
      confidence_low: acc.confidence_low + row.roi_confidence.low,
      confidence_medium: acc.confidence_medium + row.roi_confidence.medium,
      confidence_high: acc.confidence_high + row.roi_confidence.high,
      actual_evidence_count: acc.actual_evidence_count + row.roi_actuals.evidence_count,
      estimated_transaction_count: acc.estimated_transaction_count + row.roi_actuals.estimated_transaction_count,
      actual_transaction_count: acc.actual_transaction_count + row.roi_actuals.actual_transaction_count,
      comparable_actual_transaction_count: acc.comparable_actual_transaction_count + row.roi_actuals.comparable_actual_transaction_count,
      estimated_exception_weighted_sum: acc.estimated_exception_weighted_sum + (
        row.roi_actuals.estimated_exception_rate === null ? 0 : row.roi_actuals.estimated_exception_rate * row.roi_actuals.estimated_transaction_count
      ),
      actual_failure_weighted_sum: acc.actual_failure_weighted_sum + (
        row.roi_actuals.actual_failure_rate === null ? 0 : row.roi_actuals.actual_failure_rate * row.roi_actuals.actual_transaction_count
      ),
      comparable_actual_failure_weighted_sum: acc.comparable_actual_failure_weighted_sum + (
        row.roi_actuals.comparable_actual_failure_rate === null
          ? 0
          : row.roi_actuals.comparable_actual_failure_rate * row.roi_actuals.comparable_actual_transaction_count
      ),
      human_intervention_minutes: acc.human_intervention_minutes + row.roi_actuals.human_intervention_minutes,
      actual_reprocessing_minutes: acc.actual_reprocessing_minutes + row.roi_actuals.reprocessing_minutes,
      latest_actual_period_end: latestDateString(acc.latest_actual_period_end, row.roi_actuals.latest_period_end),
    }),
    {
      total_runs: 0,
      completed: 0,
      failed_business: 0,
      failed_system: 0,
      rerun_count: 0,
      estimated_hours_saved: 0,
      estimated_value: 0,
      implementation_effort: 0,
      gateway_cost: 0,
      completed_cost: 0,
      failed_business_cost: 0,
      failed_system_cost: 0,
      other_cost: 0,
      rerun_cost: 0,
      roi_idea_count: 0,
      confidence_low: 0,
      confidence_medium: 0,
      confidence_high: 0,
      actual_evidence_count: 0,
      estimated_transaction_count: 0,
      actual_transaction_count: 0,
      comparable_actual_transaction_count: 0,
      estimated_exception_weighted_sum: 0,
      actual_failure_weighted_sum: 0,
      comparable_actual_failure_weighted_sum: 0,
      human_intervention_minutes: 0,
      actual_reprocessing_minutes: 0,
      latest_actual_period_end: null as string | null,
    },
  );
  const roiSourceLineage = summarizeRoiSourceLineage(byWorkflow);
  const estimatedExceptionRate = totals.estimated_transaction_count > 0
    ? totals.estimated_exception_weighted_sum / totals.estimated_transaction_count
    : null;
  const actualFailureRate = totals.actual_transaction_count > 0
    ? totals.actual_failure_weighted_sum / totals.actual_transaction_count
    : null;
  const comparableActualFailureRate = totals.comparable_actual_transaction_count > 0
    ? totals.comparable_actual_failure_weighted_sum / totals.comparable_actual_transaction_count
    : null;
  const roiActuals: RoiActualsSummary = {
    evidence_count: totals.actual_evidence_count,
    estimated_transaction_count: totals.estimated_transaction_count,
    actual_transaction_count: totals.actual_transaction_count,
    comparable_actual_transaction_count: totals.comparable_actual_transaction_count,
    transaction_attainment_rate: totals.estimated_transaction_count > 0 ? totals.comparable_actual_transaction_count / totals.estimated_transaction_count : null,
    estimated_exception_rate: estimatedExceptionRate,
    actual_failure_rate: actualFailureRate,
    comparable_actual_failure_rate: comparableActualFailureRate,
    failure_rate_delta: estimatedExceptionRate !== null && comparableActualFailureRate !== null ? comparableActualFailureRate - estimatedExceptionRate : null,
    human_intervention_minutes: totals.human_intervention_minutes,
    reprocessing_minutes: totals.actual_reprocessing_minutes,
    latest_period_end: totals.latest_actual_period_end,
  };
  const rated = totals.completed + totals.failed_business + totals.failed_system;
  const llmCallCost = sumKnownModelCost(costByModel);
  const successRate = rated > 0 ? totals.completed / rated : null;
  const reprocessingRate = totals.total_runs > 0 ? totals.rerun_count / totals.total_runs : null;
  const netValue = totals.estimated_value - totals.gateway_cost;
  return {
    total_runs: totals.total_runs,
    completed: totals.completed,
    failed_business: totals.failed_business,
    failed_system: totals.failed_system,
    success_rate: successRate,
    rerun_count: totals.rerun_count,
    reprocessing_rate: reprocessingRate,
    estimated_hours_saved: totals.estimated_hours_saved,
    estimated_value: totals.estimated_value,
    implementation_effort: totals.implementation_effort,
    net_value: netValue,
    value_to_cost_ratio: totals.gateway_cost > 0 ? totals.estimated_value / totals.gateway_cost : null,
    payback_months: totals.estimated_value > 0 ? totals.implementation_effort / totals.estimated_value : null,
    gateway_cost: totals.gateway_cost,
    cost_by_status: {
      completed: totals.completed_cost,
      failed_business: totals.failed_business_cost,
      failed_system: totals.failed_system_cost,
      other: totals.other_cost,
    },
    failed_cost: totals.failed_business_cost + totals.failed_system_cost,
    rerun_cost: totals.rerun_cost,
    avg_cost_per_run: totals.total_runs > 0 ? totals.gateway_cost / totals.total_runs : null,
    cost_per_completed_run: totals.completed > 0 ? totals.completed_cost / totals.completed : null,
    llm_call_cost: llmCallCost,
    run_vs_call_cost_delta: llmCallCost === null ? null : totals.gateway_cost - llmCallCost,
    roi_idea_count: totals.roi_idea_count,
    roi_confidence: {
      low: totals.confidence_low,
      medium: totals.confidence_medium,
      high: totals.confidence_high,
    },
    roi_source_lineage: roiSourceLineage,
    roi_actuals: roiActuals,
    decision_signal: decisionSignalFor({
      total_runs: totals.total_runs,
      success_rate: successRate,
      reprocessing_rate: reprocessingRate,
      net_value: netValue,
      failures: totals.failed_business + totals.failed_system,
      scope: "summary",
    }),
  };
}

function decisionSignalFor(args: {
  readonly total_runs: number;
  readonly success_rate: number | null;
  readonly reprocessing_rate: number | null;
  readonly net_value: number;
  readonly failures: number;
  readonly scope: "summary" | "workflow";
}): DecisionSignal {
  if (args.total_runs === 0) {
    return { status: "hold", reason: args.scope === "summary" ? "collect monthly run evidence" : "collect run evidence" };
  }
  if (args.success_rate !== null && args.success_rate < 0.8) {
    return { status: "hold", reason: args.scope === "summary" ? "improve reliability before scaling" : "improve reliability" };
  }
  if (args.reprocessing_rate !== null && args.reprocessing_rate > 0.2) {
    return { status: "hold", reason: args.scope === "summary" ? "reduce reruns before scaling" : "reduce reruns" };
  }
  if (args.success_rate !== null && args.success_rate >= 0.9 && (args.reprocessing_rate ?? 0) <= 0.1 && args.net_value > 0) {
    return { status: "expand", reason: args.scope === "summary" ? "PoC evidence supports scaling" : "scale candidate" };
  }
  if (args.failures > 0) return { status: "watch", reason: "review failure causes" };
  return { status: "watch", reason: "validate ROI assumptions" };
}

function sumKnownModelCost(costByModel: readonly CostByModelItem[]): number | null {
  let hasKnown = false;
  let total = 0;
  for (const row of costByModel) {
    if (row.cost !== null) {
      hasKnown = true;
      total += row.cost;
    }
  }
  return hasKnown ? total : null;
}
