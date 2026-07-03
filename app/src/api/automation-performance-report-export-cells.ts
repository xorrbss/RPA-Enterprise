// automation-performance-report.ts 에서 추출 — CSV/Markdown/XLSX 가 공유하는 ROI 계보 셀 포맷터(동작 무변경 이동).
import { ROI_SOURCES, ROI_STAGES, type RoiSourceLineage } from "./automation-performance-report-types";

export function roiSourceCountsCell(lineage: RoiSourceLineage): string {
  return countPairsCell(ROI_SOURCES.map((source) => [source, lineage.source_counts[source]] as const));
}

export function roiStageCountsCell(lineage: RoiSourceLineage): string {
  return countPairsCell(ROI_STAGES.map((stage) => [stage, lineage.stage_counts[stage]] as const));
}

function countPairsCell(pairs: readonly (readonly [string, number])[]): string {
  const nonZero = pairs.filter((pair) => pair[1] > 0).map((pair) => `${pair[0]}:${pair[1]}`);
  return nonZero.length === 0 ? "none" : nonZero.join("; ");
}

export function listCell(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join("; ");
}

export function roiSampleIdeasCell(lineage: RoiSourceLineage): string {
  if (lineage.sample_ideas.length === 0) return "none";
  return lineage.sample_ideas
    .map((idea) => `${idea.title} [${idea.source}/${idea.stage}/${idea.department}/${idea.business_owner}]`)
    .join("; ");
}
