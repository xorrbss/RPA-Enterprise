// 자동화 성과 리포트 라우트 + 쿼리 파라미터 파싱. 집계 SQL/도메인 계산·내보내기 빌더는
// automation-performance-report-{queries,aggregate,export-*}.ts 로 분해(동작 무변경).
import type { FastifyInstance } from "fastify";

import { csvWithBom } from "./csv";
import { ApiResponseError } from "../runtime/errors";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";
import { buildAutomationPerformanceReport } from "./automation-performance-report-queries";
import { reportToCsv } from "./automation-performance-report-export-csv";
import { reportToPocMarkdown } from "./automation-performance-report-export-markdown";
import { reportToXlsx } from "./automation-performance-report-export-xlsx";
import type { ReportPeriod, RunModeScope } from "./automation-performance-report-types";

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const POC_MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

export function registerAutomationPerformanceReportRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/reports/automation-performance", { config: { rbacAction: "run.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const period = parseReportPeriod(query.month);
    const runMode = parseReportRunMode(query.run_mode);
    const report = await buildAutomationPerformanceReport(deps, principal.tenantId, period, runMode);
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
    const runMode = parseReportRunMode(query.run_mode);
    const report = await buildAutomationPerformanceReport(deps, principal.tenantId, period, runMode);
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
      // BOM 없으면 Windows Excel 이 CP949 로 열어 한글 자동화 이름이 깨진다.
      .send(csvWithBom(reportToCsv(report)));
  });
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

function parseReportRunMode(raw: unknown): RunModeScope {
  if (raw === undefined || raw === null || raw === "") return "prod";
  if (raw === "prod" || raw === "test" || raw === "all") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_run_mode" });
}

function currentKstMonth(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}
