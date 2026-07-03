// automation-performance-report.ts 에서 추출 — XLSX 내보내기 빌더(워크북 시트 + OOXML/ZIP 직렬화, 동작 무변경 이동).
import { Buffer } from "node:buffer";

import { guardSpreadsheetFormula } from "./csv";
import {
  listCell,
  roiSampleIdeasCell,
  roiSourceCountsCell,
  roiStageCountsCell,
} from "./automation-performance-report-export-cells";
import type { AutomationPerformanceReport } from "./automation-performance-report-types";

type SpreadsheetCell = string | number | null;

interface WorksheetData {
  readonly name: string;
  readonly rows: readonly (readonly SpreadsheetCell[])[];
}

interface ZipEntry {
  readonly path: string;
  readonly data: Buffer;
}

export function reportToXlsx(report: AutomationPerformanceReport): Buffer {
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
        ["roi_source_counts", roiSourceCountsCell(report.summary.roi_source_lineage)],
        ["roi_stage_counts", roiStageCountsCell(report.summary.roi_source_lineage)],
        ["roi_departments", listCell(report.summary.roi_source_lineage.departments)],
        ["roi_business_owners", listCell(report.summary.roi_source_lineage.business_owners)],
        ["roi_sample_ideas", roiSampleIdeasCell(report.summary.roi_source_lineage)],
        ["roi_actual_evidence_count", report.summary.roi_actuals.evidence_count],
        ["estimated_transaction_count", report.summary.roi_actuals.estimated_transaction_count],
        ["actual_transaction_count", report.summary.roi_actuals.actual_transaction_count],
        ["comparable_actual_transaction_count", report.summary.roi_actuals.comparable_actual_transaction_count],
        ["transaction_attainment_rate", report.summary.roi_actuals.transaction_attainment_rate],
        ["estimated_exception_rate", report.summary.roi_actuals.estimated_exception_rate],
        ["actual_failure_rate", report.summary.roi_actuals.actual_failure_rate],
        ["comparable_actual_failure_rate", report.summary.roi_actuals.comparable_actual_failure_rate],
        ["failure_rate_delta", report.summary.roi_actuals.failure_rate_delta],
        ["human_intervention_minutes", report.summary.roi_actuals.human_intervention_minutes],
        ["actual_reprocessing_minutes", report.summary.roi_actuals.reprocessing_minutes],
        ["latest_roi_actual_period_end", report.summary.roi_actuals.latest_period_end],
        ["decision_signal_status", report.summary.decision_signal.status],
        ["decision_signal_reason", report.summary.decision_signal.reason],
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
      name: "Model Cost Trends",
      rows: [
        [
          "day",
          "model",
          "calls",
          "input_tokens",
          "output_tokens",
          "cost",
          "cost_share_of_day",
          "cost_delta_from_previous_day_for_model",
        ],
        ...report.model_cost_trends.map((row) => [
          row.day,
          row.model,
          row.calls,
          row.input_tokens,
          row.output_tokens,
          row.cost,
          row.cost_share_of_day,
          row.cost_delta_from_previous_day_for_model,
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
          "roi_source_counts",
          "roi_stage_counts",
          "roi_departments",
          "roi_business_owners",
          "roi_sample_ideas",
          "roi_actual_evidence_count",
          "estimated_transaction_count",
          "actual_transaction_count",
          "comparable_actual_transaction_count",
          "transaction_attainment_rate",
          "estimated_exception_rate",
          "actual_failure_rate",
          "comparable_actual_failure_rate",
          "failure_rate_delta",
          "human_intervention_minutes",
          "actual_reprocessing_minutes",
          "latest_roi_actual_period_end",
          "decision_signal_status",
          "decision_signal_reason",
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
          roiSourceCountsCell(row.roi_source_lineage),
          roiStageCountsCell(row.roi_source_lineage),
          listCell(row.roi_source_lineage.departments),
          listCell(row.roi_source_lineage.business_owners),
          roiSampleIdeasCell(row.roi_source_lineage),
          row.roi_actuals.evidence_count,
          row.roi_actuals.estimated_transaction_count,
          row.roi_actuals.actual_transaction_count,
          row.roi_actuals.comparable_actual_transaction_count,
          row.roi_actuals.transaction_attainment_rate,
          row.roi_actuals.estimated_exception_rate,
          row.roi_actuals.actual_failure_rate,
          row.roi_actuals.comparable_actual_failure_rate,
          row.roi_actuals.failure_rate_delta,
          row.roi_actuals.human_intervention_minutes,
          row.roi_actuals.reprocessing_minutes,
          row.roi_actuals.latest_period_end,
          row.decision_signal.status,
          row.decision_signal.reason,
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
