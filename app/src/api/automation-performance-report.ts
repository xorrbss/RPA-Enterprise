import { Buffer } from "node:buffer";

import type { FastifyInstance } from "fastify";

import { withTenantTx } from "../db/pool";
import { ApiResponseError } from "./errors";
import { requirePrincipal, type ApiServerDeps } from "./server";

const REPORT_TZ = "Asia/Seoul";
const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const POC_MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

type SpreadsheetCell = string | number | null;

interface WorksheetData {
  readonly name: string;
  readonly rows: readonly (readonly SpreadsheetCell[])[];
}

interface ZipEntry {
  readonly path: string;
  readonly data: Buffer;
}

interface ReportPeriod {
  readonly month: string;
  readonly start: Date;
  readonly end: Date;
}

interface WorkflowReportRow {
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
  implementation_effort: string;
  roi_idea_count: number;
  confidence_low: number;
  confidence_medium: number;
  confidence_high: number;
  gateway_cost: string;
  completed_cost: string;
  failed_business_cost: string;
  failed_system_cost: string;
  other_cost: string;
}

interface FailureTopRow {
  code: string;
  count: number;
}

interface TrendReportRow {
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

interface CostByModelRow {
  model: string;
  calls: number;
  input_tokens: string | null;
  output_tokens: string | null;
  cost: string | null;
}

interface CostByStatus {
  readonly completed: number;
  readonly failed_business: number;
  readonly failed_system: number;
  readonly other: number;
}

interface RoiConfidenceBreakdown {
  readonly low: number;
  readonly medium: number;
  readonly high: number;
}

interface CostByModelItem {
  readonly model: string;
  readonly calls: number;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cost: number | null;
  readonly cost_share: number | null;
}

interface TrendReportItem {
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

interface WorkflowReportItem {
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
}

interface AutomationPerformanceReport {
  readonly month: string;
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
  };
  readonly cost_by_model: readonly CostByModelItem[];
  readonly failure_top: readonly FailureTopRow[];
  readonly trends: readonly TrendReportItem[];
  readonly by_workflow: readonly WorkflowReportItem[];
}

export function registerAutomationPerformanceReportRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/reports/automation-performance", { config: { rbacAction: "run.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const period = parseReportPeriod((request.query as Record<string, unknown>).month);
    const report = await buildAutomationPerformanceReport(deps, principal.tenantId, period);
    reply.code(200).send(report);
  });

  app.get("/v1/reports/automation-performance/export", { config: { rbacAction: "run.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const format = query.format ?? "csv";
    if (format !== "csv" && format !== "xlsx" && format !== "poc_markdown") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_export_format" });
    }
    const period = parseReportPeriod(query.month);
    const report = await buildAutomationPerformanceReport(deps, principal.tenantId, period);
    if (format === "xlsx") {
      reply
        .code(200)
        .header("content-type", XLSX_CONTENT_TYPE)
        .header("content-disposition", `attachment; filename="automation-performance-${period.month}.xlsx"`)
        .send(reportToXlsx(report));
      return;
    }
    if (format === "poc_markdown") {
      reply
        .code(200)
        .header("content-type", POC_MARKDOWN_CONTENT_TYPE)
        .header("content-disposition", `attachment; filename="automation-performance-poc-${period.month}.md"`)
        .send(reportToPocMarkdown(report));
      return;
    }
    reply
      .code(200)
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="automation-performance-${period.month}.csv"`)
      .send(reportToCsv(report));
  });
}

async function buildAutomationPerformanceReport(
  deps: ApiServerDeps,
  tenantId: string,
  period: ReportPeriod,
): Promise<AutomationPerformanceReport> {
  const { workflowRows, failureRows, trendRows, costByModelRows } = await withTenantTx(deps.pool, tenantId, async (client) => {
    const workflows = await client.query<WorkflowReportRow>(
      `WITH run_by_scenario AS (
         SELECT sv.scenario_id::text AS scenario_id,
                s.name AS scenario_name,
                count(*)::int AS total_runs,
                count(*) FILTER (WHERE r.status = 'completed')::int AS completed,
                count(*) FILTER (WHERE r.status = 'failed_business')::int AS failed_business,
                count(*) FILTER (WHERE r.status = 'failed_system')::int AS failed_system,
                COALESCE(sum(r.usage_cost), 0)::text AS gateway_cost,
                COALESCE(sum(r.usage_cost) FILTER (WHERE r.status = 'completed'), 0)::text AS completed_cost,
                COALESCE(sum(r.usage_cost) FILTER (WHERE r.status = 'failed_business'), 0)::text AS failed_business_cost,
                COALESCE(sum(r.usage_cost) FILTER (WHERE r.status = 'failed_system'), 0)::text AS failed_system_cost,
                COALESCE(sum(r.usage_cost) FILTER (WHERE r.status NOT IN ('completed','failed_business','failed_system')), 0)::text AS other_cost
           FROM runs r
           JOIN scenario_versions sv ON sv.tenant_id = r.tenant_id AND sv.id = r.scenario_version_id
           JOIN scenarios s ON s.tenant_id = sv.tenant_id AND s.id = sv.scenario_id
          WHERE r.tenant_id = $1::uuid
            AND r.created_at >= $2::timestamptz
            AND r.created_at < $3::timestamptz
          GROUP BY sv.scenario_id, s.name
       ),
       reruns_by_scenario AS (
         SELECT sv.scenario_id::text AS scenario_id,
                count(rr.id)::int AS rerun_count,
                COALESCE(sum(child.usage_cost), 0)::text AS rerun_cost
           FROM run_reruns rr
           JOIN runs child ON child.tenant_id = rr.tenant_id AND child.id = rr.child_run_id
           JOIN scenario_versions sv ON sv.tenant_id = child.tenant_id AND sv.id = child.scenario_version_id
          WHERE rr.tenant_id = $1::uuid
            AND rr.created_at >= $2::timestamptz
            AND rr.created_at < $3::timestamptz
          GROUP BY sv.scenario_id
       ),
       roi_by_scenario AS (
         SELECT ai.scenario_id::text AS scenario_id,
                s.name AS scenario_name,
                COALESCE(sum(re.monthly_hours_saved), 0)::text AS estimated_hours_saved,
                COALESCE(sum(re.estimated_monthly_value), 0)::text AS estimated_value,
                COALESCE(sum(re.implementation_effort), 0)::text AS implementation_effort,
                count(re.id)::int AS roi_idea_count,
                count(*) FILTER (WHERE re.confidence = 'low')::int AS confidence_low,
                count(*) FILTER (WHERE re.confidence = 'medium')::int AS confidence_medium,
                count(*) FILTER (WHERE re.confidence = 'high')::int AS confidence_high
           FROM automation_ideas ai
           JOIN scenarios s ON s.tenant_id = ai.tenant_id AND s.id = ai.scenario_id
           JOIN roi_estimates re ON re.tenant_id = ai.tenant_id AND re.automation_idea_id = ai.id
          WHERE ai.tenant_id = $1::uuid
            AND ai.scenario_id IS NOT NULL
            AND ai.stage IN ('approved','build','operate')
          GROUP BY ai.scenario_id, s.name
       )
       SELECT COALESCE(r.scenario_id, roi.scenario_id) AS scenario_id,
              COALESCE(r.scenario_name, roi.scenario_name) AS scenario_name,
              COALESCE(r.total_runs, 0)::int AS total_runs,
              COALESCE(r.completed, 0)::int AS completed,
              COALESCE(r.failed_business, 0)::int AS failed_business,
              COALESCE(r.failed_system, 0)::int AS failed_system,
              COALESCE(rr.rerun_count, 0)::int AS rerun_count,
              COALESCE(rr.rerun_cost, '0') AS rerun_cost,
              COALESCE(roi.estimated_hours_saved, '0') AS estimated_hours_saved,
              COALESCE(roi.estimated_value, '0') AS estimated_value,
              COALESCE(roi.implementation_effort, '0') AS implementation_effort,
              COALESCE(roi.roi_idea_count, 0)::int AS roi_idea_count,
              COALESCE(roi.confidence_low, 0)::int AS confidence_low,
              COALESCE(roi.confidence_medium, 0)::int AS confidence_medium,
              COALESCE(roi.confidence_high, 0)::int AS confidence_high,
              COALESCE(r.gateway_cost, '0') AS gateway_cost,
              COALESCE(r.completed_cost, '0') AS completed_cost,
              COALESCE(r.failed_business_cost, '0') AS failed_business_cost,
              COALESCE(r.failed_system_cost, '0') AS failed_system_cost,
              COALESCE(r.other_cost, '0') AS other_cost
         FROM run_by_scenario r
         FULL OUTER JOIN roi_by_scenario roi ON roi.scenario_id = r.scenario_id
         LEFT JOIN reruns_by_scenario rr ON rr.scenario_id = COALESCE(r.scenario_id, roi.scenario_id)
        ORDER BY COALESCE(r.total_runs, 0) DESC, COALESCE(roi.estimated_value::numeric, 0) DESC, COALESCE(r.scenario_name, roi.scenario_name) ASC`,
      [tenantId, period.start.toISOString(), period.end.toISOString()],
    );
    const failures = await client.query<FailureTopRow>(
      `SELECT COALESCE(NULLIF(failure_reason->>'code', ''), 'RUN_FAILED') AS code,
              count(*)::int AS count
         FROM runs
        WHERE tenant_id = $1::uuid
          AND status IN ('failed_business','failed_system')
          AND created_at >= $2::timestamptz
          AND created_at < $3::timestamptz
        GROUP BY 1
        ORDER BY count(*) DESC, code ASC
        LIMIT 5`,
      [tenantId, period.start.toISOString(), period.end.toISOString()],
    );
    const trends = await client.query<TrendReportRow>(
      `WITH days AS (
         SELECT generate_series(
                  $2::timestamptz,
                  $3::timestamptz - interval '1 day',
                  interval '1 day'
                ) AS day_start
       ),
       runs_by_day AS (
         SELECT date_trunc('day', r.created_at AT TIME ZONE $4) AS day_kst,
                count(*)::int AS total_runs,
                count(*) FILTER (WHERE r.status = 'completed')::int AS completed,
                count(*) FILTER (WHERE r.status = 'failed_business')::int AS failed_business,
                count(*) FILTER (WHERE r.status = 'failed_system')::int AS failed_system,
                COALESCE(sum(r.usage_cost), 0)::text AS gateway_cost,
                COALESCE(sum(r.usage_cost) FILTER (WHERE r.status = 'completed'), 0)::text AS completed_cost,
                COALESCE(sum(r.usage_cost) FILTER (WHERE r.status = 'failed_business'), 0)::text AS failed_business_cost,
                COALESCE(sum(r.usage_cost) FILTER (WHERE r.status = 'failed_system'), 0)::text AS failed_system_cost,
                COALESCE(sum(r.usage_cost) FILTER (WHERE r.status NOT IN ('completed','failed_business','failed_system')), 0)::text AS other_cost
           FROM runs r
          WHERE r.tenant_id = $1::uuid
            AND r.created_at >= $2::timestamptz
            AND r.created_at < $3::timestamptz
          GROUP BY 1
       ),
       reruns_by_day AS (
         SELECT date_trunc('day', rr.created_at AT TIME ZONE $4) AS day_kst,
                count(*)::int AS rerun_count,
                COALESCE(sum(child.usage_cost), 0)::text AS rerun_cost
           FROM run_reruns rr
           JOIN runs child ON child.tenant_id = rr.tenant_id AND child.id = rr.child_run_id
          WHERE rr.tenant_id = $1::uuid
            AND rr.created_at >= $2::timestamptz
            AND rr.created_at < $3::timestamptz
          GROUP BY 1
       )
       SELECT to_char(d.day_start AT TIME ZONE $4, 'YYYY-MM-DD') AS day,
              COALESCE(r.total_runs, 0)::int AS total_runs,
              COALESCE(r.completed, 0)::int AS completed,
              COALESCE(r.failed_business, 0)::int AS failed_business,
              COALESCE(r.failed_system, 0)::int AS failed_system,
              COALESCE(rr.rerun_count, 0)::int AS rerun_count,
              COALESCE(rr.rerun_cost, '0') AS rerun_cost,
              COALESCE(r.gateway_cost, '0') AS gateway_cost,
              COALESCE(r.completed_cost, '0') AS completed_cost,
              COALESCE(r.failed_business_cost, '0') AS failed_business_cost,
              COALESCE(r.failed_system_cost, '0') AS failed_system_cost,
              COALESCE(r.other_cost, '0') AS other_cost
         FROM days d
         LEFT JOIN runs_by_day r ON r.day_kst = date_trunc('day', d.day_start AT TIME ZONE $4)
         LEFT JOIN reruns_by_day rr ON rr.day_kst = date_trunc('day', d.day_start AT TIME ZONE $4)
       ORDER BY d.day_start`,
      [tenantId, period.start.toISOString(), period.end.toISOString(), REPORT_TZ],
    );
    const costByModel = await client.query<CostByModelRow>(
      `SELECT model,
              count(*)::int AS calls,
              sum(input_tokens)::text AS input_tokens,
              sum(output_tokens)::text AS output_tokens,
              sum(cost)::text AS cost
         FROM stagehand_calls
        WHERE tenant_id = $1::uuid
          AND created_at >= $2::timestamptz
          AND created_at < $3::timestamptz
        GROUP BY model
        ORDER BY sum(cost) DESC NULLS LAST, model ASC`,
      [tenantId, period.start.toISOString(), period.end.toISOString()],
    );
    return { workflowRows: workflows.rows, failureRows: failures.rows, trendRows: trends.rows, costByModelRows: costByModel.rows };
  });

  const byWorkflow = workflowRows.map(mapWorkflowRow);
  const trends = mapTrendRows(trendRows);
  const costByModel = mapCostByModelRows(costByModelRows);
  const summary = summarizeWorkflows(byWorkflow, costByModel);
  return {
    month: period.month,
    timezone: REPORT_TZ,
    period_start: period.start.toISOString(),
    period_end: period.end.toISOString(),
    summary,
    cost_by_model: costByModel,
    failure_top: failureRows,
    trends,
    by_workflow: byWorkflow,
  };
}

function mapWorkflowRow(row: WorkflowReportRow): WorkflowReportItem {
  const rated = row.completed + row.failed_business + row.failed_system;
  const estimatedValue = Number(row.estimated_value);
  const implementationEffort = Number(row.implementation_effort);
  const gatewayCost = Number(row.gateway_cost);
  const completedCost = Number(row.completed_cost);
  return {
    scenario_id: row.scenario_id,
    scenario_name: row.scenario_name,
    total_runs: row.total_runs,
    completed: row.completed,
    failed_business: row.failed_business,
    failed_system: row.failed_system,
    success_rate: rated > 0 ? row.completed / rated : null,
    rerun_count: row.rerun_count,
    reprocessing_rate: row.total_runs > 0 ? row.rerun_count / row.total_runs : null,
    estimated_hours_saved: Number(row.estimated_hours_saved),
    estimated_value: estimatedValue,
    implementation_effort: implementationEffort,
    net_value: estimatedValue - gatewayCost,
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
  };
}

function mapTrendRows(rows: readonly TrendReportRow[]): readonly TrendReportItem[] {
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

function mapCostByModelRows(rows: readonly CostByModelRow[]): readonly CostByModelItem[] {
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

function summarizeWorkflows(
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
    },
  );
  const rated = totals.completed + totals.failed_business + totals.failed_system;
  const llmCallCost = sumKnownModelCost(costByModel);
  return {
    total_runs: totals.total_runs,
    completed: totals.completed,
    failed_business: totals.failed_business,
    failed_system: totals.failed_system,
    success_rate: rated > 0 ? totals.completed / rated : null,
    rerun_count: totals.rerun_count,
    reprocessing_rate: totals.total_runs > 0 ? totals.rerun_count / totals.total_runs : null,
    estimated_hours_saved: totals.estimated_hours_saved,
    estimated_value: totals.estimated_value,
    implementation_effort: totals.implementation_effort,
    net_value: totals.estimated_value - totals.gateway_cost,
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
  };
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

function parseReportPeriod(raw: unknown): ReportPeriod {
  if (raw !== undefined && (typeof raw !== "string" || !/^\d{4}-\d{2}$/.test(raw))) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_month" });
  }
  const month = raw ?? currentKstMonth();
  const [yearText, monthText] = String(month).split("-");
  const year = Number.parseInt(yearText, 10);
  const monthIndex = Number.parseInt(monthText, 10) - 1;
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_month" });
  }
  return {
    month: String(month),
    start: new Date(Date.UTC(year, monthIndex, 1, -9, 0, 0, 0)),
    end: new Date(Date.UTC(year, monthIndex + 1, 1, -9, 0, 0, 0)),
  };
}

function currentKstMonth(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

function reportToCsv(report: AutomationPerformanceReport): string {
  const summaryLines = [
    ["metric", "value"],
    ["month", report.month],
    ["timezone", report.timezone],
    ["period_start", report.period_start],
    ["period_end", report.period_end],
    ["total_runs", String(report.summary.total_runs)],
    ["completed", String(report.summary.completed)],
    ["failed_business", String(report.summary.failed_business)],
    ["failed_system", String(report.summary.failed_system)],
    ["success_rate", rateCell(report.summary.success_rate)],
    ["rerun_count", String(report.summary.rerun_count)],
    ["reprocessing_rate", rateCell(report.summary.reprocessing_rate)],
    ["estimated_hours_saved", String(report.summary.estimated_hours_saved)],
    ["estimated_value", String(report.summary.estimated_value)],
    ["implementation_effort", String(report.summary.implementation_effort)],
    ["net_value", String(report.summary.net_value)],
    ["value_to_cost_ratio", rateCell(report.summary.value_to_cost_ratio)],
    ["payback_months", rateCell(report.summary.payback_months)],
    ["gateway_cost", String(report.summary.gateway_cost)],
    ["completed_cost", String(report.summary.cost_by_status.completed)],
    ["failed_business_cost", String(report.summary.cost_by_status.failed_business)],
    ["failed_system_cost", String(report.summary.cost_by_status.failed_system)],
    ["failed_cost", String(report.summary.failed_cost)],
    ["other_cost", String(report.summary.cost_by_status.other)],
    ["rerun_cost", String(report.summary.rerun_cost)],
    ["avg_cost_per_run", rateCell(report.summary.avg_cost_per_run)],
    ["cost_per_completed_run", rateCell(report.summary.cost_per_completed_run)],
    ["llm_call_cost", rateCell(report.summary.llm_call_cost)],
    ["run_vs_call_cost_delta", rateCell(report.summary.run_vs_call_cost_delta)],
    ["roi_idea_count", String(report.summary.roi_idea_count)],
    ["roi_confidence_low", String(report.summary.roi_confidence.low)],
    ["roi_confidence_medium", String(report.summary.roi_confidence.medium)],
    ["roi_confidence_high", String(report.summary.roi_confidence.high)],
  ];
  const failureLines = [["code", "count"], ...report.failure_top.map((row) => [row.code, String(row.count)])];
  const modelCostLines = [
    ["model", "calls", "input_tokens", "output_tokens", "cost", "cost_share"],
    ...report.cost_by_model.map((row) => [
      row.model,
      String(row.calls),
      nullableNumberCell(row.input_tokens),
      nullableNumberCell(row.output_tokens),
      nullableNumberCell(row.cost),
      rateCell(row.cost_share),
    ]),
  ];
  const trendLines = [
    [
      "day",
      "total_runs",
      "completed",
      "failed_business",
      "failed_system",
      "success_rate",
      "rerun_count",
      "reprocessing_rate",
      "gateway_cost",
      "completed_cost",
      "failed_business_cost",
      "failed_system_cost",
      "other_cost",
      "rerun_cost",
      "avg_cost_per_run",
      "cost_per_completed_run",
      "cost_delta_from_previous_day",
    ],
    ...report.trends.map((row) => [
      row.day,
      String(row.total_runs),
      String(row.completed),
      String(row.failed_business),
      String(row.failed_system),
      rateCell(row.success_rate),
      String(row.rerun_count),
      rateCell(row.reprocessing_rate),
      String(row.gateway_cost),
      String(row.cost_by_status.completed),
      String(row.cost_by_status.failed_business),
      String(row.cost_by_status.failed_system),
      String(row.cost_by_status.other),
      String(row.rerun_cost),
      rateCell(row.avg_cost_per_run),
      rateCell(row.cost_per_completed_run),
      rateCell(row.cost_delta_from_previous_day),
    ]),
  ];
  const workflowLines = [
    [
      "scenario_id",
      "scenario_name",
      "total_runs",
      "completed",
      "failed_business",
      "failed_system",
      "success_rate",
      "rerun_count",
      "reprocessing_rate",
      "estimated_hours_saved",
      "estimated_value",
      "implementation_effort",
      "net_value",
      "value_to_cost_ratio",
      "payback_months",
      "gateway_cost",
      "completed_cost",
      "failed_business_cost",
      "failed_system_cost",
      "other_cost",
      "rerun_cost",
      "avg_cost_per_run",
      "cost_per_completed_run",
      "roi_idea_count",
      "roi_confidence_low",
      "roi_confidence_medium",
      "roi_confidence_high",
    ],
    ...report.by_workflow.map((row) => [
      row.scenario_id,
      row.scenario_name,
      String(row.total_runs),
      String(row.completed),
      String(row.failed_business),
      String(row.failed_system),
      rateCell(row.success_rate),
      String(row.rerun_count),
      rateCell(row.reprocessing_rate),
      String(row.estimated_hours_saved),
      String(row.estimated_value),
      String(row.implementation_effort),
      String(row.net_value),
      rateCell(row.value_to_cost_ratio),
      rateCell(row.payback_months),
      String(row.gateway_cost),
      String(row.cost_by_status.completed),
      String(row.cost_by_status.failed_business),
      String(row.cost_by_status.failed_system),
      String(row.cost_by_status.other),
      String(row.rerun_cost),
      rateCell(row.avg_cost_per_run),
      rateCell(row.cost_per_completed_run),
      String(row.roi_idea_count),
      String(row.roi_confidence.low),
      String(row.roi_confidence.medium),
      String(row.roi_confidence.high),
    ]),
  ];
  return [
    ["Summary"],
    ...summaryLines,
    [],
    ["Failure Top N"],
    ...failureLines,
    [],
    ["Cost By Model"],
    ...modelCostLines,
    [],
    ["Daily Trends"],
    ...trendLines,
    [],
    ["Workflow ROI"],
    ...workflowLines,
  ]
    .map((line) => line.map(csvCell).join(","))
    .join("\n");
}

function rateCell(value: number | null): string {
  return value === null ? "" : String(value);
}

function nullableNumberCell(value: number | null): string {
  return value === null ? "" : String(value);
}

function csvCell(value: string): string {
  const guarded = guardSpreadsheetFormula(value);
  return `"${guarded.replace(/"/g, "\"\"")}"`;
}

function guardSpreadsheetFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function reportToPocMarkdown(report: AutomationPerformanceReport): string {
  const summaryRows = [
    ["Month", report.month],
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
          workflowDecision(row),
        ])
      : [["No workflow evidence", "0", "-", "-", "0", "0", "0", "-", "-", "0", "-", "0", "-", "Hold: collect monthly run evidence"]];
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

  return [
    "# Automation Performance PoC Report",
    "",
    `- Month: ${markdownInline(report.month)}`,
    `- Reporting timezone: ${markdownInline(report.timezone)}`,
    `- Period: ${markdownInline(report.period_start)} to ${markdownInline(report.period_end)}`,
    `- Recommended decision: ${markdownInline(reportDecision(report))}`,
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

function reportDecision(report: AutomationPerformanceReport): string {
  if (report.summary.total_runs === 0) return "Hold: collect monthly run evidence";
  if (report.summary.success_rate !== null && report.summary.success_rate < 0.8) return "Hold: improve reliability before scaling";
  if (report.summary.reprocessing_rate !== null && report.summary.reprocessing_rate > 0.2) return "Hold: reduce reruns before scaling";
  if (
    report.summary.success_rate !== null &&
    report.summary.success_rate >= 0.9 &&
    (report.summary.reprocessing_rate ?? 0) <= 0.1 &&
    report.summary.net_value > 0
  ) {
    return "Expand: PoC evidence supports scaling";
  }
  return "Watch: continue PoC and review failure/ROI assumptions";
}

function workflowDecision(row: WorkflowReportItem): string {
  if (row.total_runs === 0) return "Hold: collect run evidence";
  if (row.success_rate !== null && row.success_rate < 0.8) return "Hold: improve reliability";
  if (row.reprocessing_rate !== null && row.reprocessing_rate > 0.2) return "Hold: reduce reruns";
  if (
    row.success_rate !== null &&
    row.success_rate >= 0.9 &&
    (row.reprocessing_rate ?? 0) <= 0.1 &&
    row.net_value > 0
  ) {
    return "Expand";
  }
  if (row.failed_business + row.failed_system > 0) return "Watch: review failure causes";
  return "Watch: validate ROI assumptions";
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

function reportToXlsx(report: AutomationPerformanceReport): Buffer {
  const sheets = reportToWorkbookSheets(report);
  const worksheetOverrides = sheets
    .map(
      (_sheet, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("");
  const workbookRelationships = sheets
    .map(
      (_sheet, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join("");
  return zipEntries([
    xmlEntry(
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
        `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        worksheetOverrides +
        `</Types>`,
    ),
    xmlEntry(
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
        `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>` +
        `</Relationships>`,
    ),
    xmlEntry(
      "docProps/core.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
        `<dc:title>Automation Performance Report ${escapeXml(report.month)}</dc:title>` +
        `<dc:creator>RPA Control Plane</dc:creator>` +
        `<cp:lastModifiedBy>RPA Control Plane</cp:lastModifiedBy>` +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${escapeXml(report.period_end)}</dcterms:created>` +
        `<dcterms:modified xsi:type="dcterms:W3CDTF">${escapeXml(report.period_end)}</dcterms:modified>` +
        `</cp:coreProperties>`,
    ),
    xmlEntry(
      "docProps/app.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
        `<Application>RPA Control Plane</Application>` +
        `<DocSecurity>0</DocSecurity>` +
        `<ScaleCrop>false</ScaleCrop>` +
        `<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>${sheets.length}</vt:i4></vt:variant></vt:vector></HeadingPairs>` +
        `<TitlesOfParts><vt:vector size="${sheets.length}" baseType="lpstr">${sheets.map((sheet) => `<vt:lpstr>${escapeXml(sheet.name)}</vt:lpstr>`).join("")}</vt:vector></TitlesOfParts>` +
        `</Properties>`,
    ),
    xmlEntry(
      "xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets>${sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets>` +
        `</workbook>`,
    ),
    xmlEntry(
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        workbookRelationships +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `</Relationships>`,
    ),
    xmlEntry(
      "xl/styles.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font></fonts>` +
        `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
        `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
        `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
        `<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>` +
        `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
        `</styleSheet>`,
    ),
    ...sheets.map((sheet, index) => xmlEntry(`xl/worksheets/sheet${index + 1}.xml`, worksheetXml(sheet.rows))),
  ]);
}

function reportToWorkbookSheets(report: AutomationPerformanceReport): readonly WorksheetData[] {
  return [
    {
      name: "Summary",
      rows: [
        ["metric", "value"],
        ["month", report.month],
        ["timezone", report.timezone],
        ["period_start", report.period_start],
        ["period_end", report.period_end],
        ["total_runs", report.summary.total_runs],
        ["completed", report.summary.completed],
        ["failed_business", report.summary.failed_business],
        ["failed_system", report.summary.failed_system],
        ["success_rate", report.summary.success_rate],
        ["rerun_count", report.summary.rerun_count],
        ["reprocessing_rate", report.summary.reprocessing_rate],
        ["estimated_hours_saved", report.summary.estimated_hours_saved],
        ["estimated_value", report.summary.estimated_value],
        ["implementation_effort", report.summary.implementation_effort],
        ["net_value", report.summary.net_value],
        ["value_to_cost_ratio", report.summary.value_to_cost_ratio],
        ["payback_months", report.summary.payback_months],
        ["gateway_cost", report.summary.gateway_cost],
        ["completed_cost", report.summary.cost_by_status.completed],
        ["failed_business_cost", report.summary.cost_by_status.failed_business],
        ["failed_system_cost", report.summary.cost_by_status.failed_system],
        ["failed_cost", report.summary.failed_cost],
        ["other_cost", report.summary.cost_by_status.other],
        ["rerun_cost", report.summary.rerun_cost],
        ["avg_cost_per_run", report.summary.avg_cost_per_run],
        ["cost_per_completed_run", report.summary.cost_per_completed_run],
        ["llm_call_cost", report.summary.llm_call_cost],
        ["run_vs_call_cost_delta", report.summary.run_vs_call_cost_delta],
        ["roi_idea_count", report.summary.roi_idea_count],
        ["roi_confidence_low", report.summary.roi_confidence.low],
        ["roi_confidence_medium", report.summary.roi_confidence.medium],
        ["roi_confidence_high", report.summary.roi_confidence.high],
      ],
    },
    {
      name: "Failure Top N",
      rows: [["code", "count"], ...report.failure_top.map((row) => [row.code, row.count] as const)],
    },
    {
      name: "Cost By Model",
      rows: [
        ["model", "calls", "input_tokens", "output_tokens", "cost", "cost_share"],
        ...report.cost_by_model.map((row) => [
          row.model,
          row.calls,
          row.input_tokens,
          row.output_tokens,
          row.cost,
          row.cost_share,
        ]),
      ],
    },
    {
      name: "Daily Trends",
      rows: [
        [
          "day",
          "total_runs",
          "completed",
          "failed_business",
          "failed_system",
          "success_rate",
          "rerun_count",
          "reprocessing_rate",
          "gateway_cost",
          "completed_cost",
          "failed_business_cost",
          "failed_system_cost",
          "other_cost",
          "rerun_cost",
          "avg_cost_per_run",
          "cost_per_completed_run",
          "cost_delta_from_previous_day",
        ],
        ...report.trends.map((row) => [
          row.day,
          row.total_runs,
          row.completed,
          row.failed_business,
          row.failed_system,
          row.success_rate,
          row.rerun_count,
          row.reprocessing_rate,
          row.gateway_cost,
          row.cost_by_status.completed,
          row.cost_by_status.failed_business,
          row.cost_by_status.failed_system,
          row.cost_by_status.other,
          row.rerun_cost,
          row.avg_cost_per_run,
          row.cost_per_completed_run,
          row.cost_delta_from_previous_day,
        ]),
      ],
    },
    {
      name: "Workflow ROI",
      rows: [
        [
          "scenario_id",
          "scenario_name",
          "total_runs",
          "completed",
          "failed_business",
          "failed_system",
          "success_rate",
          "rerun_count",
          "reprocessing_rate",
          "estimated_hours_saved",
          "estimated_value",
          "implementation_effort",
          "net_value",
          "value_to_cost_ratio",
          "payback_months",
          "gateway_cost",
          "completed_cost",
          "failed_business_cost",
          "failed_system_cost",
          "other_cost",
          "rerun_cost",
          "avg_cost_per_run",
          "cost_per_completed_run",
          "roi_idea_count",
          "roi_confidence_low",
          "roi_confidence_medium",
          "roi_confidence_high",
        ],
        ...report.by_workflow.map((row) => [
          row.scenario_id,
          row.scenario_name,
          row.total_runs,
          row.completed,
          row.failed_business,
          row.failed_system,
          row.success_rate,
          row.rerun_count,
          row.reprocessing_rate,
          row.estimated_hours_saved,
          row.estimated_value,
          row.implementation_effort,
          row.net_value,
          row.value_to_cost_ratio,
          row.payback_months,
          row.gateway_cost,
          row.cost_by_status.completed,
          row.cost_by_status.failed_business,
          row.cost_by_status.failed_system,
          row.cost_by_status.other,
          row.rerun_cost,
          row.avg_cost_per_run,
          row.cost_per_completed_run,
          row.roi_idea_count,
          row.roi_confidence.low,
          row.roi_confidence.medium,
          row.roi_confidence.high,
        ]),
      ],
    },
  ];
}

function worksheetXml(rows: readonly (readonly SpreadsheetCell[])[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>` +
    rows
      .map(
        (row, rowIndex) =>
          `<row r="${rowIndex + 1}">` +
          row.map((value, columnIndex) => cellXml(value, `${columnName(columnIndex + 1)}${rowIndex + 1}`)).join("") +
          `</row>`,
      )
      .join("") +
    `</sheetData>` +
    `</worksheet>`
  );
}

function cellXml(value: SpreadsheetCell, ref: string): string {
  if (value === null) return `<c r="${ref}"/>`;
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(guardSpreadsheetFormula(String(value)))}</t></is></c>`;
}

function columnName(index: number): string {
  let n = index;
  let name = "";
  while (n > 0) {
    n -= 1;
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26);
  }
  return name;
}

function xmlEntry(path: string, xml: string): ZipEntry {
  return { path, data: Buffer.from(xml, "utf8") };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function zipEntries(entries: readonly ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const crc = crc32(entry.data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(dosDate(), 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(entry.data.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(dosDate(), 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(entry.data.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + entry.data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function dosDate(): number {
  return ((2026 - 1980) << 9) | (1 << 5) | 1;
}

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < CRC32_TABLE.length; i += 1) {
  let c = i;
  for (let bit = 0; bit < 8; bit += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
