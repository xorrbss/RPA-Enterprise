// automation-performance-report.ts 에서 추출 — PoC Markdown 내보내기 빌더(동작 무변경 이동, 문구/포맷 verbatim).
import { guardSpreadsheetFormula } from "./csv";
import { listCell, roiSourceCountsCell, roiStageCountsCell } from "./automation-performance-report-export-cells";
import type {
  AutomationPerformanceReport,
  DecisionSignal,
  RoiActualsSummary,
  RoiConfidenceBreakdown,
  RoiSourceLineage,
} from "./automation-performance-report-types";

function roiLineageCell(lineage: RoiSourceLineage): string {
  return [
    `sources ${roiSourceCountsCell(lineage)}`,
    `stages ${roiStageCountsCell(lineage)}`,
    `departments ${listCell(lineage.departments)}`,
    `owners ${listCell(lineage.business_owners)}`,
  ].join("; ");
}

function roiActualsCell(actuals: RoiActualsSummary): string {
  if (actuals.evidence_count === 0) return "no actual evidence";
  const transactionText = actuals.estimated_transaction_count > 0
    ? `comparable tx ${actuals.comparable_actual_transaction_count}/${actuals.estimated_transaction_count} (${percentCell(actuals.transaction_attainment_rate)})`
    : `actual tx ${actuals.actual_transaction_count}; no estimate`;
  return [
    `evidence ${actuals.evidence_count}`,
    transactionText,
    `total actual tx ${actuals.actual_transaction_count}`,
    `comparable failure ${percentCell(actuals.comparable_actual_failure_rate)} vs estimated ${percentCell(actuals.estimated_exception_rate)}`,
    `total actual failure ${percentCell(actuals.actual_failure_rate)}`,
    `delta ${percentCell(actuals.failure_rate_delta)}`,
    `human ${decimalCell(actuals.human_intervention_minutes, 1)}m`,
    `rework ${decimalCell(actuals.reprocessing_minutes, 1)}m`,
    `latest ${actuals.latest_period_end ?? "-"}`,
  ].join("; ");
}

export function reportToPocMarkdown(report: AutomationPerformanceReport): string {
  const summaryRows = [
    ["Month", report.month],
    ["Run mode", report.run_mode],
    ["Timezone", report.timezone],
    ["Period start", report.period_start],
    ["Period end", report.period_end],
    ["Total runs", String(report.summary.total_runs)],
    ["Completed", String(report.summary.completed)],
    ["Business failures", String(report.summary.failed_business)],
    ["System failures", String(report.summary.failed_system)],
    ["Success rate", percentCell(report.summary.success_rate)],
    ["Rerun count", String(report.summary.rerun_count)],
    ["Reprocessing rate", percentCell(report.summary.reprocessing_rate)],
    ["Estimated hours saved", decimalCell(report.summary.estimated_hours_saved, 1)],
    ["Estimated monthly value", moneyCell(report.summary.estimated_value)],
    ["Implementation effort", moneyCell(report.summary.implementation_effort)],
    ["Net monthly value", moneyCell(report.summary.net_value)],
    ["Value/cost ratio", nullableDecimalCell(report.summary.value_to_cost_ratio, 2)],
    ["Payback months", nullableDecimalCell(report.summary.payback_months, 1)],
    ["Gateway cost", moneyCell(report.summary.gateway_cost)],
    ["Failed cost", moneyCell(report.summary.failed_cost)],
    ["Rerun cost", moneyCell(report.summary.rerun_cost)],
    ["Avg cost/run", nullableMoneyCell(report.summary.avg_cost_per_run)],
    ["Cost/completed run", nullableMoneyCell(report.summary.cost_per_completed_run)],
    ["LLM call cost", nullableMoneyCell(report.summary.llm_call_cost)],
    ["Run-call cost delta", nullableMoneyCell(report.summary.run_vs_call_cost_delta)],
    ["ROI ideas", String(report.summary.roi_idea_count)],
    ["ROI confidence", confidenceCell(report.summary.roi_confidence)],
    ["ROI sources", roiSourceCountsCell(report.summary.roi_source_lineage)],
    ["ROI stages", roiStageCountsCell(report.summary.roi_source_lineage)],
    ["ROI departments", listCell(report.summary.roi_source_lineage.departments)],
    ["ROI business owners", listCell(report.summary.roi_source_lineage.business_owners)],
    ["ROI actuals", roiActualsCell(report.summary.roi_actuals)],
    ["Decision signal", decisionSignalCell(report.summary.decision_signal)],
  ];
  const failureRows =
    report.failure_top.length > 0
      ? report.failure_top.map((row, index) => [String(index + 1), row.code, String(row.count)])
      : [["-", "No failures recorded", "0"]];
  const workflowRows =
    report.by_workflow.length > 0
      ? report.by_workflow.map((row) => [
          row.scenario_name,
          String(row.total_runs),
          percentCell(row.success_rate),
          percentCell(row.reprocessing_rate),
          decimalCell(row.estimated_hours_saved, 1),
          moneyCell(row.estimated_value),
          moneyCell(row.net_value),
          nullableDecimalCell(row.value_to_cost_ratio, 2),
          nullableDecimalCell(row.payback_months, 1),
          moneyCell(row.gateway_cost),
          nullableMoneyCell(row.cost_per_completed_run),
          String(row.roi_idea_count),
          confidenceCell(row.roi_confidence),
          roiLineageCell(row.roi_source_lineage),
          roiActualsCell(row.roi_actuals),
          decisionSignalCell(row.decision_signal),
        ])
      : [["No workflow evidence", "0", "-", "-", "0", "0", "0", "-", "-", "0", "-", "0", "-", "none", "no actual evidence", "Hold: collect monthly run evidence"]];
  const trendRows =
    report.trends.length > 0
      ? report.trends.map((row) => [
          row.day,
          String(row.total_runs),
          percentCell(row.success_rate),
          String(row.rerun_count),
          percentCell(row.reprocessing_rate),
          moneyCell(row.gateway_cost),
          nullableMoneyCell(row.avg_cost_per_run),
          nullableMoneyCell(row.cost_delta_from_previous_day),
        ])
      : [["No daily evidence", "0", "-", "0", "-", "0", "-", "-"]];
  const modelCostRows =
    report.cost_by_model.length > 0
      ? report.cost_by_model.map((row) => [
          row.model,
          String(row.calls),
          nullableIntegerCell(row.input_tokens),
          nullableIntegerCell(row.output_tokens),
          nullableMoneyCell(row.cost),
          percentCell(row.cost_share),
        ])
      : [["No model calls", "0", "-", "-", "-", "-"]];
  const modelCostTrendRows =
    report.model_cost_trends.length > 0
      ? report.model_cost_trends.slice(-14).map((row) => [
          row.day,
          row.model,
          String(row.calls),
          nullableIntegerCell(row.input_tokens),
          nullableIntegerCell(row.output_tokens),
          nullableMoneyCell(row.cost),
          percentCell(row.cost_share_of_day),
          nullableMoneyCell(row.cost_delta_from_previous_day_for_model),
        ])
      : [["No model daily evidence", "-", "0", "-", "-", "-", "-", "-"]];

  return [
    "# Automation Performance PoC Report",
    "",
    `- Month: ${markdownInline(report.month)}`,
    `- Run mode: ${markdownInline(report.run_mode)}`,
    `- Reporting timezone: ${markdownInline(report.timezone)}`,
    `- Period: ${markdownInline(report.period_start)} to ${markdownInline(report.period_end)}`,
    `- Recommended decision: ${markdownInline(decisionSignalCell(report.summary.decision_signal))}`,
    "",
    "## Summary Metrics",
    "",
    markdownTable(["Metric", "Value"], summaryRows),
    "",
    "## Failure Top N",
    "",
    markdownTable(["Rank", "Failure code", "Count"], failureRows),
    "",
    "## Cost By Model",
    "",
    markdownTable(["Model", "Calls", "Input tokens", "Output tokens", "Cost", "Cost share"], modelCostRows),
    "",
    "## Model Cost Trends",
    "",
    markdownTable(
      ["Day", "Model", "Calls", "Input tokens", "Output tokens", "Cost", "Day share", "Cost delta"],
      modelCostTrendRows,
    ),
    "",
    "## Workflow ROI / Cost",
    "",
    markdownTable(
      [
        "Workflow",
        "Runs",
        "Success rate",
        "Reprocessing",
        "Hours saved",
        "Value",
        "Net",
        "Value/cost",
        "Payback",
        "Gateway cost",
        "Cost/completed",
        "ROI ideas",
        "Confidence",
        "ROI lineage",
        "ROI actuals",
        "Decision signal",
      ],
      workflowRows,
    ),
    "",
    "## Daily Trends",
    "",
    markdownTable(["Day", "Runs", "Success rate", "Reruns", "Reprocessing", "Gateway cost", "Avg cost/run", "Cost delta"], trendRows),
    "",
    "## Decision Guide",
    "",
    "- Expand: success rate is at least 90%, reprocessing is at most 10%, and net monthly value is positive.",
    "- Hold: success rate is below 80%, reprocessing is above 20%, or the workflow has no monthly run evidence.",
    "- Watch: metrics are mixed; review failure causes and ROI assumptions before scaling.",
    "- Never paste secrets, tokens, passwords, or resolved secret material into this report.",
    "",
  ].join("\n");
}

function decisionSignalCell(signal: DecisionSignal): string {
  const label = signal.status === "expand" ? "Expand" : signal.status === "hold" ? "Hold" : "Watch";
  return `${label}: ${signal.reason}`;
}

function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${headers.map(markdownTableCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(markdownTableCell).join(" | ")} |`),
  ].join("\n");
}

function markdownTableCell(value: string): string {
  return markdownInline(value);
}

function markdownInline(value: string): string {
  return guardSpreadsheetFormula(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}\[\]()#+.!|\-])/g, "\\$1");
}

function percentCell(value: number | null): string {
  return value === null ? "-" : `${Math.round(value * 100)}%`;
}

function nullableDecimalCell(value: number | null, maximumFractionDigits: number): string {
  return value === null ? "-" : decimalCell(value, maximumFractionDigits);
}

function nullableIntegerCell(value: number | null): string {
  return value === null ? "-" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function decimalCell(value: number, maximumFractionDigits: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);
}

function moneyCell(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function nullableMoneyCell(value: number | null): string {
  return value === null ? "-" : moneyCell(value);
}

function confidenceCell(value: RoiConfidenceBreakdown): string {
  return `H ${value.high} / M ${value.medium} / L ${value.low}`;
}
