import { Sparkline } from "../../components/Sparkline";
import {
  ROI_SOURCE_LABELS,
  ROI_SOURCE_ORDER,
  ROI_SOURCE_TONES,
  ROI_STAGE_LABELS,
  ROI_STAGE_ORDER,
  ROI_STAGE_TONES,
  compactNumber,
  moneyLabel,
  percentLabel,
  type CompactMixItem,
} from "./report-format";
import type { AutomationPerformanceReport, AutomationPerformanceRoiSourceLineage } from "../../api/types";

type ModelCostDayTrend = {
  readonly day: string;
  readonly cost: number | null;
  readonly rowCount: number;
  readonly nullCostRows: number;
};

function safeMixCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function compactMixTotal(items: readonly CompactMixItem[]): number {
  return items.reduce((sum, item) => sum + item.count, 0);
}

function compactMixPercent(count: number, total: number): string {
  return total > 0 ? percentLabel(count / total) : "0%";
}

function compactMixAriaLabel(chartName: string, items: readonly CompactMixItem[]): string {
  const total = compactMixTotal(items);
  const detail = items
    .map((item) => `${item.label} ${compactNumber(item.count)} (${compactMixPercent(item.count, total)})`)
    .join(", ");
  return `${chartName}. 총 ${compactNumber(total)}건. ${detail}`;
}

function CompactHorizontalBarSummary({
  title,
  items,
  ariaLabel,
}: {
  title: string;
  items: readonly CompactMixItem[];
  ariaLabel: string;
}): JSX.Element {
  const total = compactMixTotal(items);
  return (
    <div className="performance-viz-card">
      <div className="performance-viz-head">
        <h3>{title}</h3>
        <strong>{compactNumber(total)}건</strong>
      </div>
      <div className="compact-bar" role="img" aria-label={ariaLabel}>
        {total === 0 ? (
          <span className="compact-bar-empty" aria-hidden="true">0</span>
        ) : (
          items.map((item) => (
            <span
              key={item.key}
              className={`compact-bar-segment ${item.tone}`}
              style={{ width: `${(item.count / total) * 100}%` }}
              aria-hidden="true"
            />
          ))
        )}
      </div>
      <ul className="compact-bar-legend" aria-hidden="true">
        {items.map((item) => (
          <li key={item.key}>
            <span className={`compact-bar-dot ${item.tone}`} />
            <span>{item.label}</span>
            <strong>{compactNumber(item.count)} · {compactMixPercent(item.count, total)}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RoiSourceMixChart({ lineage }: { lineage: AutomationPerformanceRoiSourceLineage }): JSX.Element {
  const items: readonly CompactMixItem[] = ROI_SOURCE_ORDER.map((source) => ({
    key: source,
    label: ROI_SOURCE_LABELS[source],
    count: safeMixCount(lineage.source_counts[source]),
    tone: ROI_SOURCE_TONES[source],
  }));
  return (
    <CompactHorizontalBarSummary
      title="ROI 근거 출처"
      items={items}
      ariaLabel={compactMixAriaLabel("ROI 근거 출처 차트", items)}
    />
  );
}

export function RoiStageMixChart({ lineage }: { lineage: AutomationPerformanceRoiSourceLineage }): JSX.Element {
  const items: readonly CompactMixItem[] = ROI_STAGE_ORDER.map((stage) => ({
    key: stage,
    label: ROI_STAGE_LABELS[stage],
    count: safeMixCount(lineage.stage_counts[stage]),
    tone: ROI_STAGE_TONES[stage],
  }));
  return (
    <CompactHorizontalBarSummary
      title="ROI 단계 구성"
      items={items}
      ariaLabel={compactMixAriaLabel("ROI 단계 구성 차트", items)}
    />
  );
}

function aggregateModelCostByDay(
  trends: AutomationPerformanceReport["model_cost_trends"],
): readonly ModelCostDayTrend[] {
  const byDay = new Map<string, { cost: number; hasKnownCost: boolean; rowCount: number; nullCostRows: number }>();
  for (const row of trends) {
    const current = byDay.get(row.day) ?? { cost: 0, hasKnownCost: false, rowCount: 0, nullCostRows: 0 };
    current.rowCount += 1;
    if (row.cost === null || !Number.isFinite(row.cost)) {
      current.nullCostRows += 1;
    } else {
      current.cost += row.cost;
      current.hasKnownCost = true;
    }
    byDay.set(row.day, current);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, value]) => ({
      day,
      cost: value.hasKnownCost ? value.cost : null,
      rowCount: value.rowCount,
      nullCostRows: value.nullCostRows,
    }));
}

function modelCostKnownTotal(days: readonly ModelCostDayTrend[]): number {
  return days.reduce((sum, day) => sum + (day.cost ?? 0), 0);
}

function modelCostMissingRows(days: readonly ModelCostDayTrend[]): number {
  return days.reduce((sum, day) => sum + day.nullCostRows, 0);
}

function modelCostTrendAriaLabel(days: readonly ModelCostDayTrend[]): string {
  const total = modelCostKnownTotal(days);
  const missingRows = modelCostMissingRows(days);
  const latest = days[days.length - 1];
  const latestText = latest === undefined
    ? "최근 데이터 없음"
    : latest.cost === null
      ? `최근 ${latest.day} 비용 미집계`
      : `최근 ${latest.day} ${moneyLabel(latest.cost)}`;
  return `모델 비용 추이 차트. ${compactNumber(days.length)}일, 합계 ${moneyLabel(total)}, 미집계 ${compactNumber(missingRows)}건. ${latestText}`;
}

export function ModelCostTrendMini({
  trends,
}: {
  trends: AutomationPerformanceReport["model_cost_trends"];
}): JSX.Element {
  const days = aggregateModelCostByDay(trends).slice(-7);
  const total = modelCostKnownTotal(days);
  const missingRows = modelCostMissingRows(days);
  const note = days.length === 0
    ? "0일 · 비용 데이터 없음 · 미집계 0건"
    : `${compactNumber(days.length)}일 · 미집계 ${compactNumber(missingRows)}건`;
  return (
    <div className="performance-viz-card">
      <div className="performance-viz-head">
        <h3>모델 비용 추이</h3>
        <strong>합계</strong>
      </div>
      <div className="model-cost-mini">
        <span>
          <strong>{moneyLabel(total)}</strong>
          <span className="subtle">{note}</span>
        </span>
        <Sparkline
          points={days.map((day) => ({ label: day.day, value: day.cost }))}
          ariaLabel={modelCostTrendAriaLabel(days)}
          width={150}
          height={32}
        />
      </div>
    </div>
  );
}
