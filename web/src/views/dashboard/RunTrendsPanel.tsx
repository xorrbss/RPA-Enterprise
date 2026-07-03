import { Sparkline, type SparklinePoint } from "../../components/Sparkline";
import { EmptyState, ErrorState, desktopStateForError } from "../../components/states";
import type { RunTrendPoint, RunTrends } from "../../api/types";

// 일별 추세(GET /v1/runs/trends) — 스냅샷 지표를 시계열로 보강. 마지막 non-null 성공률 + 윈도우 처리량 합계.
function latestSuccessRate(points: readonly RunTrendPoint[]): number | null {
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const r = points[i]?.success_rate;
    if (r !== null && r !== undefined) return r;
  }
  return null;
}

function windowThroughput(points: readonly RunTrendPoint[]): number {
  return points.reduce((sum, p) => sum + p.total, 0);
}

function trendAria(metric: "성공률" | "처리량", windowDays: number, points: readonly RunTrendPoint[]): string {
  const last = points[points.length - 1];
  let tail = "";
  if (metric === "성공률") {
    tail = last !== undefined && last.success_rate !== null ? `최근 ${Math.round(last.success_rate * 100)}%` : "최근 측정값 없음";
  } else if (last !== undefined) {
    tail = `최근 ${last.total}건`;
  }
  return `최근 ${windowDays}일 ${metric} 추세. ${tail}`.trim();
}

function TrendRow({
  title,
  current,
  note,
  points,
  ariaLabel,
  domainMax,
}: {
  title: string;
  current: string;
  note: string;
  points: readonly SparklinePoint[];
  ariaLabel: string;
  domainMax?: number;
}): JSX.Element {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "6px 0" }}>
      <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span className="subtle">{title}</span>
        <strong>{current}</strong>
        <span className="subtle">{note}</span>
      </span>
      <Sparkline points={points} ariaLabel={ariaLabel} domainMax={domainMax} />
    </div>
  );
}

// 최근 추세 패널 — 데이터 미도착/오류/빈 시리즈를 정직하게 구분 표기(단정 금지). 성공률 도메인 [0,1], 처리량 자동.
export function RunTrendsPanel({
  trends,
  isLoading,
  isError,
  error,
}: {
  trends: RunTrends | undefined;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
}): JSX.Element {
  // points 가 배열이 아니면(미도착/계약 위반 응답) 빈 시리즈로 — 패널 크래시 대신 정직한 빈 상태(white-screen 방지).
  const points: readonly RunTrendPoint[] = trends !== undefined && Array.isArray(trends.points) ? trends.points : [];
  const rate = latestSuccessRate(points);
  const errorState = isError ? desktopStateForError(error) : null;
  return (
    <section className="panel run-trends-panel" aria-label="실행 추세">
      <div className="panel-head">
        <h2>최근 추세</h2>
        {trends !== undefined && <span className="subtle">{trends.window_days}일 · {trends.timezone}</span>}
      </div>
      {isError ? (
        <ErrorState
          title={errorState?.title}
          message={`실행 추세를 확인하지 못했습니다. ${errorState?.message ?? ""}`}
          details={errorState?.details}
        />
      ) : isLoading ? (
        <EmptyState title="확인 필요" message="추세를 동기화하는 중입니다." />
      ) : trends === undefined || points.length === 0 ? (
        <EmptyState title="첫 실행 전" message="표시할 추세 데이터가 없습니다." />
      ) : (
        <div>
          <TrendRow
            title="실행 성공률"
            current={rate === null ? "—" : `${Math.round(rate * 100)}%`}
            note={rate === null ? "완료·실패한 실행이 아직 없습니다" : "최근 측정값"}
            points={points.map((p) => ({ value: p.success_rate, label: p.day }))}
            ariaLabel={trendAria("성공률", trends.window_days, points)}
            domainMax={1}
          />
          <TrendRow
            title="일별 처리량"
            current={`${windowThroughput(points)}건`}
            note={`${trends.window_days}일 합계`}
            points={points.map((p) => ({ value: p.total, label: p.day }))}
            ariaLabel={trendAria("처리량", trends.window_days, points)}
          />
        </div>
      )}
    </section>
  );
}
