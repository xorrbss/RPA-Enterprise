import { EmptyState, ErrorState, desktopStateForError } from "../../components/states";
import { ModelCostTrendMini, RoiSourceMixChart, RoiStageMixChart } from "./PerformanceCharts";
import {
  REPORT_RUN_MODE_OPTIONS,
  compactNumber,
  decisionSignalLabel,
  moneyLabel,
  nullableMoneyLabel,
  percentLabel,
  ratioLabel,
  reportRunModeLabel,
  roiActualsNote,
  roiActualsTitle,
  roiActualsValue,
  roiLineageMeta,
  roiLineageSourceLabel,
  roiLineageTitle,
  type ReportExportFormat,
  type ReportExportState,
} from "./report-format";
import type {
  AutomationPerformanceReport,
  AutomationPerformanceRunMode,
  AutomationPerformanceRoiSourceLineage,
} from "../../api/types";

function ReportMetric({ label, value, note }: { label: string; value: string; note: string }): JSX.Element {
  return (
    <span className="metric-card">
      <span className="label">{label}</span>
      <strong>{value}</strong>
      <span className="subtle">{note}</span>
    </span>
  );
}

function RoiSourceLineageMetric({
  lineage,
  confidence,
}: {
  lineage: AutomationPerformanceRoiSourceLineage;
  confidence: AutomationPerformanceReport["summary"]["roi_confidence"];
}): JSX.Element {
  return (
    <span className="metric-card" title={roiLineageTitle(lineage, confidence)}>
      <span className="label">ROI 근거</span>
      <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{roiLineageSourceLabel(lineage)}</strong>
      <span className="subtle" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{roiLineageMeta(lineage)}</span>
    </span>
  );
}

function RoiSourceLineage({
  lineage,
  confidence,
}: {
  lineage: AutomationPerformanceRoiSourceLineage;
  confidence: AutomationPerformanceReport["summary"]["roi_confidence"];
}): JSX.Element {
  return (
    <span
      title={roiLineageTitle(lineage, confidence)}
      style={{ display: "inline-grid", gap: 2, maxWidth: 240, minWidth: 0, verticalAlign: "middle" }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{roiLineageSourceLabel(lineage)}</span>
      <span className="subtle" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{roiLineageMeta(lineage)}</span>
    </span>
  );
}

function RoiActualsInline({ actuals }: { actuals: AutomationPerformanceReport["summary"]["roi_actuals"] }): JSX.Element {
  return (
    <span
      title={roiActualsTitle(actuals)}
      style={{ display: "inline-grid", gap: 2, maxWidth: 220, minWidth: 0, verticalAlign: "middle" }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{roiActualsValue(actuals)}</span>
      <span className="subtle" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{roiActualsNote(actuals)}</span>
    </span>
  );
}

export function AutomationPerformancePanel({
  report,
  month,
  runMode,
  exportState,
  exportFormat,
  isLoading,
  isError,
  error,
  onMonthChange,
  onRunModeChange,
  onRetry,
  onExportCsv,
  onExportXlsx,
  onExportPocMarkdown,
  canExportXlsx,
  canExportPocMarkdown,
}: {
  report: AutomationPerformanceReport | undefined;
  month: string;
  runMode: AutomationPerformanceRunMode;
  exportState: ReportExportState;
  exportFormat: ReportExportFormat | null;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  onMonthChange: (month: string) => void;
  onRunModeChange: (runMode: AutomationPerformanceRunMode) => void;
  onRetry: () => void;
  onExportCsv: () => void;
  onExportXlsx: () => void;
  onExportPocMarkdown: () => void;
  canExportXlsx: boolean;
  canExportPocMarkdown: boolean;
}): JSX.Element {
  const topWorkflows = report?.by_workflow.slice(0, 5) ?? [];
  const recentTrends = report?.trends.slice(-7) ?? [];
  const topCostModels = report?.cost_by_model.slice(0, 3) ?? [];
  const recentModelCostTrends = report?.model_cost_trends.slice(-7) ?? [];
  const errorState = isError ? desktopStateForError(error) : null;
  return (
    <section className="panel performance-report-panel" aria-label="월간 자동화 성과 리포트">
      <div className="panel-head">
        <div>
          <h2>월간 자동화 성과</h2>
          <p className="subtle">{report !== undefined ? `${report.month} · ${report.timezone} · ${reportRunModeLabel(report.run_mode)}` : `${month} · Asia/Seoul · ${reportRunModeLabel(runMode)}`}</p>
        </div>
        <div className="inline-actions">
          <label className="field month-field">
            <span>월</span>
            <input type="month" value={month} onChange={(event) => onMonthChange(event.target.value)} />
          </label>
          <label className="field month-field">
            <span>실행 구분</span>
            <select value={runMode} onChange={(event) => onRunModeChange(event.target.value as AutomationPerformanceRunMode)}>
              {REPORT_RUN_MODE_OPTIONS.map((option) => (
                <option key={option} value={option}>{reportRunModeLabel(option)}</option>
              ))}
            </select>
          </label>
          <button className="btn" type="button" onClick={onRetry}>새로고침</button>
          <button className="btn" type="button" disabled={exportState === "pending" || report === undefined} onClick={onExportCsv}>
            {exportState === "pending" && exportFormat === "csv" ? "준비 중" : "CSV"}
          </button>
          <button className="btn" type="button" disabled={exportState === "pending" || report === undefined || !canExportPocMarkdown} onClick={onExportPocMarkdown}>
            {exportState === "pending" && exportFormat === "poc_markdown" ? "준비 중" : "PoC 문서"}
          </button>
          <button className="btn" type="button" disabled={exportState === "pending" || report === undefined || !canExportXlsx} onClick={onExportXlsx}>
            {exportState === "pending" && exportFormat === "xlsx" ? "준비 중" : "XLSX"}
          </button>
        </div>
      </div>
      {runMode === "prod" && <p className="subtle" style={{ margin: "0 0 8px" }}>성과·ROI는 운영 실행만 집계합니다. 시험 실행은 포함하지 않습니다.</p>}
      {runMode !== "prod" && <p className="form-alert red" role="alert">전체 또는 시험 실행을 선택했습니다. 이 수치는 운영 성과로 해석할 수 없습니다.</p>}
      {exportState === "success" && <p className="notice success" role="status">성과 리포트 {exportFormat?.toUpperCase() ?? "export"}를 준비했습니다.</p>}
      {exportState === "error" && <p className="form-alert red" role="alert">성과 리포트 {exportFormat?.toUpperCase() ?? "export"}를 준비하지 못했습니다.</p>}
      {isError ? (
        <ErrorState
          title={errorState?.title}
          message={`성과 리포트를 확인하지 못했습니다. ${errorState?.message ?? ""}`}
          details={errorState?.details}
          onRetry={onRetry}
        />
      ) : isLoading ? (
        <EmptyState title="확인 필요" message="성과 리포트를 동기화하는 중입니다." />
      ) : report === undefined ? (
        <EmptyState title="보류" message="성과 리포트 데이터가 없습니다." />
      ) : (
        <>
          <div className="summary-grid performance-summary">
            <ReportMetric label="성공률" value={percentLabel(report.summary.success_rate)} note={`${compactNumber(report.summary.completed)}건 완료`} />
            <ReportMetric label="절감 시간" value={`${compactNumber(report.summary.estimated_hours_saved, 1)}h`} note={moneyLabel(report.summary.estimated_value)} />
            <ReportMetric label="재처리율" value={percentLabel(report.summary.reprocessing_rate)} note={`${compactNumber(report.summary.rerun_count)}건 재실행`} />
            <ReportMetric label="게이트웨이 비용" value={moneyLabel(report.summary.gateway_cost)} note={`${compactNumber(report.summary.total_runs)}건 실행`} />
            <ReportMetric label="순가치" value={moneyLabel(report.summary.net_value)} note={`${ratioLabel(report.summary.value_to_cost_ratio)} 가치/비용`} />
            <ReportMetric label="AI 호출 비용" value={nullableMoneyLabel(report.summary.llm_call_cost)} note={`증감 ${nullableMoneyLabel(report.summary.run_vs_call_cost_delta)}`} />
            <RoiSourceLineageMetric lineage={report.summary.roi_source_lineage} confidence={report.summary.roi_confidence} />
            <ReportMetric label="ROI 실적" value={roiActualsValue(report.summary.roi_actuals)} note={roiActualsNote(report.summary.roi_actuals)} />
            <ReportMetric label="판단" value={decisionSignalLabel(report.summary.decision_signal)} note={report.summary.decision_signal.reason} />
          </div>
          <div className="performance-compact-visuals">
            <RoiSourceMixChart lineage={report.summary.roi_source_lineage} />
            <RoiStageMixChart lineage={report.summary.roi_source_lineage} />
            <ModelCostTrendMini trends={report.model_cost_trends} />
          </div>
          {recentTrends.length > 0 && (
            <div className="table-wrap performance-workflow-table">
              <table>
                <thead>
                  <tr>
                    <th scope="col">일자</th>
                    <th scope="col">실행</th>
                    <th scope="col">성공률</th>
                    <th scope="col">재처리</th>
                    <th scope="col">비용</th>
                    <th scope="col">건당 비용</th>
                    <th scope="col">증감</th>
                  </tr>
                </thead>
                <tbody>
                  {recentTrends.map((row) => (
                    <tr key={row.day}>
                      <th scope="row">{row.day}</th>
                      <td>{compactNumber(row.total_runs)}</td>
                      <td>{percentLabel(row.success_rate)}</td>
                      <td>{percentLabel(row.reprocessing_rate)}</td>
                      <td>{moneyLabel(row.gateway_cost)}</td>
                      <td>{nullableMoneyLabel(row.avg_cost_per_run)}</td>
                      <td>{nullableMoneyLabel(row.cost_delta_from_previous_day)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {recentModelCostTrends.length > 0 && (
            <div className="table-wrap performance-workflow-table">
              <table aria-label="모델 비용 일별 추이">
                <thead>
                  <tr>
                    <th scope="col">일자</th>
                    <th scope="col">모델</th>
                    <th scope="col">호출</th>
                    <th scope="col">비용</th>
                    <th scope="col">일 비중</th>
                    <th scope="col">증감</th>
                  </tr>
                </thead>
                <tbody>
                  {recentModelCostTrends.map((row) => (
                    <tr key={`${row.day}-${row.model}`}>
                      <th scope="row">{row.day}</th>
                      <td><code>{row.model}</code></td>
                      <td>{compactNumber(row.calls)}</td>
                      <td>{nullableMoneyLabel(row.cost)}</td>
                      <td>{percentLabel(row.cost_share_of_day)}</td>
                      <td>{nullableMoneyLabel(row.cost_delta_from_previous_day_for_model)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="performance-report-grid">
            <div className="performance-failure-list">
              <h3>실패 원인 Top N</h3>
              {report.failure_top.length === 0 ? (
                <p className="subtle">집계된 실패가 없습니다.</p>
              ) : (
                <ul>
                  {report.failure_top.map((item) => (
                    <li key={item.code}>
                      <code>{item.code}</code>
                      <strong>{compactNumber(item.count)}건</strong>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="performance-failure-list">
              <h3>모델 비용 Top 3</h3>
              {topCostModels.length === 0 ? (
                <p className="subtle">집계된 LLM 호출 비용이 없습니다.</p>
              ) : (
                <ul>
                  {topCostModels.map((item) => (
                    <li key={item.model}>
                      <code>{item.model}</code>
                      <strong>{nullableMoneyLabel(item.cost)} · {compactNumber(item.calls)}회 호출 · {percentLabel(item.cost_share)}</strong>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="table-wrap performance-workflow-table">
              <table>
                <thead>
                  <tr>
                    <th scope="col">업무</th>
                    <th scope="col">성공률</th>
                    <th scope="col">재처리</th>
                    <th scope="col">절감</th>
                    <th scope="col">순가치</th>
                    <th scope="col">비용</th>
                    <th scope="col">건당 비용</th>
                    <th scope="col">ROI 실적</th>
                    <th scope="col">ROI 근거</th>
                    <th scope="col">판단</th>
                  </tr>
                </thead>
                <tbody>
                  {topWorkflows.length === 0 ? (
                    <tr>
                      <td colSpan={10}>표시할 업무별 성과가 없습니다.</td>
                    </tr>
                  ) : (
                    topWorkflows.map((row) => (
                      <tr key={row.scenario_id}>
                        <th scope="row">{row.scenario_name}</th>
                        <td>{percentLabel(row.success_rate)}</td>
                        <td>{percentLabel(row.reprocessing_rate)}</td>
                        <td>{compactNumber(row.estimated_hours_saved, 1)}h · {moneyLabel(row.estimated_value)}</td>
                        <td>{moneyLabel(row.net_value)} · {ratioLabel(row.value_to_cost_ratio)}</td>
                        <td>{moneyLabel(row.gateway_cost)}</td>
                        <td>{nullableMoneyLabel(row.cost_per_completed_run)}</td>
                        <td><RoiActualsInline actuals={row.roi_actuals} /></td>
                        <td><RoiSourceLineage lineage={row.roi_source_lineage} confidence={row.roi_confidence} /></td>
                        <td>{decisionSignalLabel(row.decision_signal)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
