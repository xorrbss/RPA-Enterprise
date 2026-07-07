import { navigate, type ViewKey } from "../../router";
import type { RunSummary } from "../../api/types";

export const DASHBOARD_RUN_MODE = "prod" as const;

// 지표 카드 — 클릭 시 해당 목록 화면으로 드릴다운(죽은 대시보드 → 진입점). 카드 자체가 버튼이라 키보드 포커스/Enter 동작.
// 라우트는 타입드 {view, params}로 navigate에 위임(원시 해시 리터럴 제거·라우트 의도 가시화) — '실행 중'은
// runTrace?status=running으로 카운트와 목록 모집단을 일치. params는 RunState enum 등 기존 실 필드 그대로.
export function Metric({ label, value, view, params, hint }: { label: string; value: string; view: ViewKey; params?: Record<string, string>; hint: string }): JSX.Element {
  return (
    <button type="button" className="metric metric-link" onClick={() => navigate(view, params)}>
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      <span className="metric-hint subtle">{hint} <span aria-hidden="true">→</span></span>
    </button>
  );
}

type Page = { items: readonly unknown[]; next_cursor: string | null };

// 카운트 표기(조용한 false 금지): 서버 집계 엔드포인트가 없어 카운트는 '최신 50건' 페이지 기준이다.
// next_cursor가 있으면(=더 있음) `N+`(≥N 하한)로, 없으면 정확한 N으로 표기 — 페이지 길이를 총계처럼 보이지 않게 한다.
export function pageCount(d: Page | undefined): string {
  if (d === undefined) return "—";
  return d.next_cursor !== null ? `${d.items.length}+` : String(d.items.length);
}

// 서버 집계(전체 기간)라 절단 '+' 없는 정확 카운트. 로딩 전이면 '—'(데이터 도착 전 단정 금지).
export function exactCount(s: RunSummary | undefined, status: string): string {
  if (s === undefined || s.by_status === undefined) return "—";
  return String(s.by_status[status] ?? 0);
}

// run_success_rate(§E) — completed/(completed+failed_business+failed_system). 분모 0이면 success_rate=null →
// '—'(0/0을 100%/0%로 단정하지 않음, "조용한 false 금지"). 정수 %로 표기.
export function successRateLabel(s: RunSummary | undefined): string {
  if (s !== undefined && s.total === 0) return "첫 실행 전";
  if (s === undefined || typeof s.success_rate !== "number") return "—";
  return `${Math.round(s.success_rate * 100)}%`;
}

// cache_hit_rate(§E) — ActionPlanCache 조회 적중률(서버 집계). 조회 0(분모 0) → null → '—'(0/0 단정 금지).
export function cacheHitRateLabel(s: RunSummary | undefined): string {
  if (s !== undefined && s.total === 0) return "첫 실행 전";
  if (s === undefined || s.cache === undefined || typeof s.cache.hit_rate !== "number") return "—";
  return `${Math.round(s.cache.hit_rate * 100)}%`;
}
