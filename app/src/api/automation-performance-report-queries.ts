// automation-performance-report.ts 에서 추출 — 월간 리포트 집계 SQL + 리포트 조립(동작 무변경 이동).
import { withTenantTx } from "../db/pool";
import type { ApiServerDeps } from "./server-shared";
import {
  mapCostByModelRows,
  mapModelCostTrendRows,
  mapTrendRows,
  mapWorkflowRow,
  summarizeWorkflows,
} from "./automation-performance-report-aggregate";
import {
  REPORT_TZ,
  type AutomationPerformanceReport,
  type CostByModelRow,
  type FailureTopRow,
  type ModelCostTrendRow,
  type ReportPeriod,
  type RunModeScope,
  type TrendReportRow,
  type WorkflowReportRow,
} from "./automation-performance-report-types";

export async function buildAutomationPerformanceReport(
  deps: ApiServerDeps,
  tenantId: string,
  period: ReportPeriod,
  runMode: RunModeScope,
): Promise<AutomationPerformanceReport> {
  const { workflowRows, failureRows, trendRows, costByModelRows, modelCostTrendRows } = await withTenantTx(deps.pool, tenantId, async (client) => {
    const actualPeriodStart = `${period.month}-01`;
    const actualPeriodEnd = nextMonthDate(period.month);
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
            AND ($6::text = 'all' OR r.run_mode = $6)
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
            AND ($6::text = 'all' OR child.run_mode = $6)
          GROUP BY sv.scenario_id
       ),
       roi_by_scenario AS (
         SELECT ai.scenario_id::text AS scenario_id,
                s.name AS scenario_name,
                COALESCE(sum(re.monthly_hours_saved), 0)::text AS estimated_hours_saved,
                COALESCE(sum(re.estimated_monthly_value), 0)::text AS estimated_value,
                COALESCE(sum(re.frequency_per_month), 0)::text AS estimated_transaction_count,
                CASE WHEN COALESCE(sum(re.frequency_per_month), 0) > 0
                     THEN (sum(re.frequency_per_month * re.exception_rate) / sum(re.frequency_per_month))::text
                     ELSE NULL
                END AS estimated_exception_rate,
                COALESCE(sum(re.implementation_effort), 0)::text AS implementation_effort,
                count(re.id)::int AS roi_idea_count,
                count(*) FILTER (WHERE re.confidence = 'low')::int AS confidence_low,
                count(*) FILTER (WHERE re.confidence = 'medium')::int AS confidence_medium,
                count(*) FILTER (WHERE re.confidence = 'high')::int AS confidence_high,
                jsonb_agg(
                  jsonb_build_object(
                    'idea_id', ai.id::text,
                    'title', ai.title,
                    'source', ai.source,
                    'stage', ai.stage,
                    'department', ai.department,
                    'business_owner', ai.business_owner
                  )
                  ORDER BY re.estimated_monthly_value DESC, ai.updated_at DESC, ai.id::text
                ) AS roi_ideas
           FROM automation_ideas ai
           JOIN scenarios s ON s.tenant_id = ai.tenant_id AND s.id = ai.scenario_id
           JOIN roi_estimates re ON re.tenant_id = ai.tenant_id AND re.automation_idea_id = ai.id
          WHERE ai.tenant_id = $1::uuid
            AND ai.scenario_id IS NOT NULL
            AND ai.stage IN ('approved','build','operate')
          GROUP BY ai.scenario_id, s.name
       ),
       actual_by_scenario AS (
         SELECT ai.scenario_id::text AS scenario_id,
                s.name AS scenario_name,
                count(ra.id)::int AS actual_evidence_count,
                COALESCE(sum(ra.actual_transaction_count), 0)::int AS actual_transaction_count,
                CASE WHEN COALESCE(sum(ra.actual_transaction_count), 0) > 0
                     THEN (sum(ra.actual_transaction_count * ra.actual_failure_rate) / sum(ra.actual_transaction_count))::text
                     ELSE NULL
                END AS actual_failure_rate,
                COALESCE(sum(ra.human_intervention_minutes), 0)::text AS human_intervention_minutes,
                COALESCE(sum(ra.reprocessing_minutes), 0)::text AS reprocessing_minutes,
                max(ra.period_end)::text AS latest_actual_period_end
           FROM automation_ideas ai
           JOIN scenarios s ON s.tenant_id = ai.tenant_id AND s.id = ai.scenario_id
           JOIN roi_actual_evidence ra ON ra.tenant_id = ai.tenant_id AND ra.automation_idea_id = ai.id
          WHERE ai.tenant_id = $1::uuid
            AND ai.scenario_id IS NOT NULL
            AND ai.stage IN ('approved','build','operate')
            AND ra.deleted_at IS NULL
            AND ra.period_start >= $4::date
            AND ra.period_end < $5::date
          GROUP BY ai.scenario_id, s.name
       )
       SELECT COALESCE(r.scenario_id, roi.scenario_id, actual.scenario_id) AS scenario_id,
              COALESCE(r.scenario_name, roi.scenario_name, actual.scenario_name) AS scenario_name,
              COALESCE(r.total_runs, 0)::int AS total_runs,
              COALESCE(r.completed, 0)::int AS completed,
              COALESCE(r.failed_business, 0)::int AS failed_business,
              COALESCE(r.failed_system, 0)::int AS failed_system,
              COALESCE(rr.rerun_count, 0)::int AS rerun_count,
              COALESCE(rr.rerun_cost, '0') AS rerun_cost,
              COALESCE(roi.estimated_hours_saved, '0') AS estimated_hours_saved,
              COALESCE(roi.estimated_value, '0') AS estimated_value,
              COALESCE(roi.estimated_transaction_count, '0') AS estimated_transaction_count,
              roi.estimated_exception_rate AS estimated_exception_rate,
              COALESCE(roi.implementation_effort, '0') AS implementation_effort,
              COALESCE(roi.roi_idea_count, 0)::int AS roi_idea_count,
              COALESCE(roi.confidence_low, 0)::int AS confidence_low,
              COALESCE(roi.confidence_medium, 0)::int AS confidence_medium,
              COALESCE(roi.confidence_high, 0)::int AS confidence_high,
              COALESCE(roi.roi_ideas, '[]'::jsonb) AS roi_ideas,
              COALESCE(actual.actual_evidence_count, 0)::int AS actual_evidence_count,
              COALESCE(actual.actual_transaction_count, 0)::int AS actual_transaction_count,
              actual.actual_failure_rate AS actual_failure_rate,
              COALESCE(actual.human_intervention_minutes, '0') AS human_intervention_minutes,
              COALESCE(actual.reprocessing_minutes, '0') AS reprocessing_minutes,
              actual.latest_actual_period_end AS latest_actual_period_end,
              COALESCE(r.gateway_cost, '0') AS gateway_cost,
              COALESCE(r.completed_cost, '0') AS completed_cost,
              COALESCE(r.failed_business_cost, '0') AS failed_business_cost,
              COALESCE(r.failed_system_cost, '0') AS failed_system_cost,
              COALESCE(r.other_cost, '0') AS other_cost
         FROM run_by_scenario r
         FULL OUTER JOIN roi_by_scenario roi ON roi.scenario_id = r.scenario_id
         FULL OUTER JOIN actual_by_scenario actual ON actual.scenario_id = COALESCE(r.scenario_id, roi.scenario_id)
         LEFT JOIN reruns_by_scenario rr ON rr.scenario_id = COALESCE(r.scenario_id, roi.scenario_id, actual.scenario_id)
        ORDER BY COALESCE(r.total_runs, 0) DESC, COALESCE(roi.estimated_value::numeric, 0) DESC, COALESCE(r.scenario_name, roi.scenario_name, actual.scenario_name) ASC`,
      [tenantId, period.start.toISOString(), period.end.toISOString(), actualPeriodStart, actualPeriodEnd, runMode],
    );
    const failures = await client.query<FailureTopRow>(
      `SELECT COALESCE(NULLIF(failure_reason->>'code', ''), 'RUN_FAILED') AS code,
              count(*)::int AS count
         FROM runs
        WHERE tenant_id = $1::uuid
          AND status IN ('failed_business','failed_system')
          AND created_at >= $2::timestamptz
          AND created_at < $3::timestamptz
          AND ($4::text = 'all' OR run_mode = $4)
        GROUP BY 1
        ORDER BY count(*) DESC, code ASC
        LIMIT 5`,
      [tenantId, period.start.toISOString(), period.end.toISOString(), runMode],
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
            AND ($5::text = 'all' OR r.run_mode = $5)
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
            AND ($5::text = 'all' OR child.run_mode = $5)
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
      [tenantId, period.start.toISOString(), period.end.toISOString(), REPORT_TZ, runMode],
    );
    const costByModel = await client.query<CostByModelRow>(
      `SELECT c.model,
              count(*)::int AS calls,
              sum(c.input_tokens)::text AS input_tokens,
              sum(c.output_tokens)::text AS output_tokens,
              sum(c.cost)::text AS cost
         FROM stagehand_calls c
         JOIN runs r ON r.tenant_id = c.tenant_id AND r.id = c.run_id
        WHERE c.tenant_id = $1::uuid
          AND c.created_at >= $2::timestamptz
          AND c.created_at < $3::timestamptz
          AND ($4::text = 'all' OR r.run_mode = $4)
        GROUP BY c.model
        ORDER BY sum(c.cost) DESC NULLS LAST, c.model ASC`,
      [tenantId, period.start.toISOString(), period.end.toISOString(), runMode],
    );
    const modelCostTrends = await client.query<ModelCostTrendRow>(
      `WITH model_daily AS (
         SELECT to_char(date_trunc('day', c.created_at AT TIME ZONE $4), 'YYYY-MM-DD') AS day,
                c.model,
                count(*)::int AS calls,
                sum(c.input_tokens) AS input_tokens,
                sum(c.output_tokens) AS output_tokens,
                sum(c.cost) AS cost
           FROM stagehand_calls c
           JOIN runs r ON r.tenant_id = c.tenant_id AND r.id = c.run_id
          WHERE c.tenant_id = $1::uuid
            AND c.created_at >= $2::timestamptz
            AND c.created_at < $3::timestamptz
            AND ($5::text = 'all' OR r.run_mode = $5)
          GROUP BY 1, c.model
       ),
       day_cost AS (
         SELECT day,
                sum(cost) AS known_cost
           FROM model_daily
          WHERE cost IS NOT NULL
          GROUP BY day
       )
       SELECT md.day,
              md.model,
              md.calls,
              md.input_tokens::text AS input_tokens,
              md.output_tokens::text AS output_tokens,
              md.cost::text AS cost,
              dc.known_cost::text AS day_known_cost
         FROM model_daily md
        LEFT JOIN day_cost dc ON dc.day = md.day
       ORDER BY md.day ASC, md.cost DESC NULLS LAST, md.model ASC`,
      [tenantId, period.start.toISOString(), period.end.toISOString(), REPORT_TZ, runMode],
    );
    return {
      workflowRows: workflows.rows,
      failureRows: failures.rows,
      trendRows: trends.rows,
      costByModelRows: costByModel.rows,
      modelCostTrendRows: modelCostTrends.rows,
    };
  });

  const byWorkflow = workflowRows.map(mapWorkflowRow);
  const trends = mapTrendRows(trendRows);
  const costByModel = mapCostByModelRows(costByModelRows);
  const modelCostTrends = mapModelCostTrendRows(modelCostTrendRows);
  const summary = summarizeWorkflows(byWorkflow, costByModel);
  return {
    month: period.month,
    run_mode: runMode,
    timezone: REPORT_TZ,
    period_start: period.start.toISOString(),
    period_end: period.end.toISOString(),
    summary,
    cost_by_model: costByModel,
    model_cost_trends: modelCostTrends,
    failure_top: failureRows,
    trends,
    by_workflow: byWorkflow,
  };
}

function nextMonthDate(month: string): string {
  const [yearText, monthText] = month.split("-");
  const year = Number.parseInt(yearText, 10);
  const monthIndex = Number.parseInt(monthText, 10) - 1;
  const next = new Date(Date.UTC(year, monthIndex + 1, 1));
  return next.toISOString().slice(0, 10);
}
