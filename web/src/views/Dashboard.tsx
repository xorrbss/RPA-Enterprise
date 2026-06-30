import { useQuery } from "@tanstack/react-query";
import { useState, type ComponentProps } from "react";

import { useApiClient } from "../api/context";
import { ROLE_LABELS, useCan, useRoles } from "../api/permissions";
import { OnboardingBanner } from "../components/OnboardingBanner";
import { QueryPanel } from "../components/QueryPanel";
import { Sparkline, type SparklinePoint } from "../components/Sparkline";
import { StatusBadge, errorCodeLabel, kindLabel } from "../components/badges";
import { getInternalNavFlags, type NavPolicyFlags } from "../navPolicy";
import { navigate, type ViewKey } from "../router";
import type {
  AutomationPerformanceReport,
  AutomationPerformanceReportExportFormat,
  AutomationPerformanceRoiSource,
  AutomationPerformanceRoiSourceLineage,
  AutomationPerformanceRoiStage,
  DeadLetterItem,
  HumanTaskItem,
  OpsAlertItem,
  OpsHealth,
  RunItem,
  RunSummary,
  RunTrendPoint,
  RunTrends,
  SiteItem,
} from "../api/types";

// 첫-실행 안내 배너 — 권한별(RBAC) 안내문/CTA. cta 없으면 viewer 안내문만(없는 권한 동선 창작 금지).
// 입력은 부모가 실 응답으로 판정한 '진짜 빈 테넌트' 여부 + useCan뿐(데이터 미창작).
// 분기는 2가지뿐: 현 RBAC 매트릭스(permissions.ts)상 scenario.create 보유 역할은 예외 없이 run.create도
// 보유하므로(viewer만 둘 다 없음), run.create 유무가 곧 '명령 권한자 vs 뷰어' 경계다.
// 문구는 시나리오 존재를 단정하지 않는다 — 부모는 listScenarios를 조회하지 않아 '준비된 자동화'가 있는지
// 관찰한 적이 없다(데이터 미창작). CTA 라벨('자동화 화면으로 가기')은 동작 그대로의 안내문이고, 이동 대상은
// scenarioStudio(meta.ts title='자동화 만들기')다 — 라벨은 대상 title을 그대로 쓰지 않는다.
function onboardingProps(can: (a: string) => boolean, roles: readonly string[]): ComponentProps<typeof OnboardingBanner> {
  // 역할 미확인(roles 없음)은 '데이터 없음'이 아니라 '권한/설정 문제'일 수 있다 — 빈 화면의 원인을 구분해
  // 운영자가 IT 담당자에게 접근 권한을 요청하도록 안내한다(Topbar '권한 미확인 · 읽기 전용'과 일관).
  if (roles.length === 0) return { message: "현재 역할을 확인할 수 없어 화면이 비어 보일 수 있습니다. IT 담당자에게 접근 권한을 요청하세요." };
  if (can("run.create")) return { message: "첫 실행을 시작해 보세요.", cta: { label: "자동화 화면으로 가기", view: "scenarioStudio" } };
  return { message: "아직 등록된 실행이 없습니다. 권한이 있는 담당자가 첫 실행을 시작할 수 있습니다." };
}

// 지표 카드 — 클릭 시 해당 목록 화면으로 드릴다운(죽은 대시보드 → 진입점). 카드 자체가 버튼이라 키보드 포커스/Enter 동작.
// 라우트는 타입드 {view, params}로 navigate에 위임(원시 해시 리터럴 제거·라우트 의도 가시화) — '실행 중'은
// runTrace?status=running으로 카운트와 목록 모집단을 일치. params는 RunState enum 등 기존 실 필드 그대로.
function Metric({ label, value, view, params, hint }: { label: string; value: string; view: ViewKey; params?: Record<string, string>; hint: string }): JSX.Element {
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
function pageCount(d: Page | undefined): string {
  if (d === undefined) return "—";
  return d.next_cursor !== null ? `${d.items.length}+` : String(d.items.length);
}

// 서버 집계(전체 기간)라 절단 '+' 없는 정확 카운트. 로딩 전이면 '—'(데이터 도착 전 단정 금지).
function exactCount(s: RunSummary | undefined, status: string): string {
  if (s === undefined || s.by_status === undefined) return "—";
  return String(s.by_status[status] ?? 0);
}

// run_success_rate(§E) — completed/(completed+failed_business+failed_system). 분모 0이면 success_rate=null →
// '—'(0/0을 100%/0%로 단정하지 않음, "조용한 false 금지"). 정수 %로 표기.
function successRateLabel(s: RunSummary | undefined): string {
  if (s === undefined || typeof s.success_rate !== "number") return "—";
  return `${Math.round(s.success_rate * 100)}%`;
}

// cache_hit_rate(§E) — ActionPlanCache 조회 적중률(서버 집계). 조회 0(분모 0) → null → '—'(0/0 단정 금지).
function cacheHitRateLabel(s: RunSummary | undefined): string {
  if (s === undefined || s.cache === undefined || typeof s.cache.hit_rate !== "number") return "—";
  return `${Math.round(s.cache.hit_rate * 100)}%`;
}

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
function RunTrendsPanel({
  trends,
  isLoading,
  isError,
}: {
  trends: RunTrends | undefined;
  isLoading: boolean;
  isError: boolean;
}): JSX.Element {
  // points 가 배열이 아니면(미도착/계약 위반 응답) 빈 시리즈로 — 패널 크래시 대신 정직한 빈 상태(white-screen 방지).
  const points: readonly RunTrendPoint[] = trends !== undefined && Array.isArray(trends.points) ? trends.points : [];
  const rate = latestSuccessRate(points);
  return (
    <section className="panel run-trends-panel" aria-label="실행 추세">
      <div className="panel-head">
        <h2>최근 추세</h2>
        {trends !== undefined && <span className="subtle">{trends.window_days}일 · {trends.timezone}</span>}
      </div>
      {isError ? (
        <p className="empty-state">추세를 불러오지 못했습니다.</p>
      ) : isLoading ? (
        <p className="empty-state">추세를 동기화하는 중입니다.</p>
      ) : trends === undefined || points.length === 0 ? (
        <p className="empty-state">표시할 추세 데이터가 없습니다.</p>
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

type ActionItem = {
  readonly key: string;
  readonly tone: "red" | "amber" | "blue";
  readonly title: string;
  readonly meta: string;
  readonly traceTitle?: string;
  readonly view: ViewKey;
  readonly params?: Record<string, string>;
};

function roleFocus(roles: readonly string[], can: (a: string) => boolean, flags: NavPolicyFlags): { title: string; note: string; actions: readonly { label: string; view: ViewKey; params?: Record<string, string> }[] } {
  const known = roles.map((r) => ROLE_LABELS[r] ?? r);
  const roleText = known.length > 0 ? known.join(" · ") : "권한 미확인";
  if (roles.includes("admin")) {
    const actions: { label: string; view: ViewKey; params?: Record<string, string> }[] = [
      { label: "사이트 접근 정책", view: "security" },
      { label: "AI 모델 정책", view: "llmGateway" },
    ];
    if (flags.showInternalOpenGate) actions.push({ label: "Product-open 점검", view: "openGate" });
    return {
      title: `관리자 작업대 · ${roleText}`,
      note: "정책 충돌, 사이트 승인, 모델 기본값처럼 운영 전체를 막을 수 있는 설정을 먼저 확인합니다.",
      actions,
    };
  }
  if (roles.includes("approver")) {
    return {
      title: `승인자 작업대 · ${roleText}`,
      note: "결재, 고위험 사이트 승인, 사람 확인 대기를 먼저 처리해 자동화 재개 시간을 줄입니다.",
      actions: [
        { label: "결재 인박스", view: "approvalInbox" },
        { label: "사람 확인", view: "humanTasks" },
        { label: "감사 이력", view: "auditExplorer" },
      ],
    };
  }
  if (roles.includes("reviewer")) {
    return {
      title: `검토자 작업대 · ${roleText}`,
      note: "보안문자, 추가 인증, 검증 업무를 빠르게 처리하고 원본 실행으로 되돌아갑니다.",
      actions: [
        { label: "사람 확인", view: "humanTasks" },
        { label: "실행 기록", view: "runTrace" },
      ],
    };
  }
  if (can("run.create")) {
    return {
      title: `운영자 작업대 · ${roleText}`,
      note: "실패, 재처리 대기, 실행 중인 자동화를 먼저 보고 재처리 또는 취소까지 이어갑니다.",
      actions: [
        { label: "실패 실행", view: "runTrace", params: { status: "failed_system" } },
        { label: "작업 목록", view: "workitems" },
        { label: "자동화 만들기", view: "scenarioStudio" },
      ],
    };
  }
  return {
    title: `조회 작업대 · ${roleText}`,
    note: "읽기 권한으로 운영 상태와 증빙을 확인합니다. 명령은 권한 있는 담당자에게 요청하세요.",
    actions: [
      { label: "실행 기록", view: "runTrace" },
      { label: "작업 목록", view: "workitems" },
    ],
  };
}

function RoleWorkbench({ roles, can }: { roles: readonly string[]; can: (a: string) => boolean }): JSX.Element {
  const focus = roleFocus(roles, can, getInternalNavFlags());
  return (
    <section className="panel role-workbench" aria-label="역할별 작업대">
      <div>
        <h2>{focus.title}</h2>
        <p className="subtle">{focus.note}</p>
      </div>
      <div className="quick-actions">
        {focus.actions.map((a) => (
          <button key={`${a.view}-${a.label}`} className="btn" type="button" onClick={() => navigate(a.view, a.params)}>
            {a.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function bySoonestTimeout(a: HumanTaskItem, b: HumanTaskItem): number {
  const at = a.timeout !== null ? Date.parse(a.timeout) : Number.POSITIVE_INFINITY;
  const bt = b.timeout !== null ? Date.parse(b.timeout) : Number.POSITIVE_INFINITY;
  return at - bt;
}

function runningFreshness(run: RunItem): { tone: "amber" | "blue"; meta: string } {
  const updated = run.updated_at ?? run.as_of;
  if (updated === null || updated === undefined) return { tone: "blue", meta: "진행 시각 확인 필요" };
  const t = Date.parse(updated);
  if (Number.isNaN(t)) return { tone: "blue", meta: "진행 시각 확인 필요" };
  const minutes = Math.max(0, Math.floor((Date.now() - t) / 60_000));
  if (minutes >= 15) return { tone: "amber", meta: `최근 진행 ${minutes}분 전` };
  return { tone: "blue", meta: `최근 진행 ${minutes}분 전` };
}

function businessErrorLabel(code: string | undefined, fallback: string): string {
  if (code === undefined) return fallback;
  const label = errorCodeLabel(code);
  return label === code ? fallback : label;
}

function failedRunMeta(run: RunItem): string {
  return businessErrorLabel(run.failure_reason?.code, "실패 사유 확인 필요");
}

function failedRunTraceTitle(run: RunItem): string {
  const parts = [`실행 추적 번호: ${run.run_id}`];
  if (run.failure_reason !== null && run.failure_reason !== undefined) parts.push(`상세 오류 코드: ${run.failure_reason.code}`);
  return parts.join(" · ");
}

function humanTaskMeta(task: HumanTaskItem): string {
  if (task.timeout !== null) return `마감 ${task.timeout}`;
  const label = kindLabel(task.kind);
  return label === task.kind ? "확인 대기" : `${label} 확인 대기`;
}

function workitemRetryMeta(item: DeadLetterItem): string {
  return businessErrorLabel(item.reason_code, "재처리 원인 확인 필요");
}

function workitemTraceTitle(item: DeadLetterItem): string {
  const parts = [`재처리 추적 번호: ${item.dead_letter_id}`];
  if (item.source_id !== null) parts.push(`원본 항목 추적 번호: ${item.source_id}`);
  if (item.reason_code !== undefined) parts.push(`상세 사유 코드: ${item.reason_code}`);
  return parts.join(" · ");
}

function sinkTraceTitle(item: DeadLetterItem): string {
  return `외부 전달 추적 번호: ${item.dead_letter_id}`;
}

function collectActionItems(args: {
  failedBiz: readonly RunItem[];
  failedSys: readonly RunItem[];
  running: readonly RunItem[];
  human: readonly HumanTaskItem[];
  wiDlq: readonly DeadLetterItem[];
  sinkDlq: readonly DeadLetterItem[];
  redSites: readonly SiteItem[];
}): ActionItem[] {
  const out: ActionItem[] = [];
  for (const r of args.failedSys.slice(0, 2)) {
    out.push({ key: `fs-${r.run_id}`, tone: "red", title: "시스템 실패 실행", meta: failedRunMeta(r), traceTitle: failedRunTraceTitle(r), view: "runTrace", params: { run: r.run_id, status: "failed_system" } });
  }
  for (const r of args.failedBiz.slice(0, 2)) {
    out.push({ key: `fb-${r.run_id}`, tone: "red", title: "업무 실패 실행", meta: failedRunMeta(r), traceTitle: failedRunTraceTitle(r), view: "runTrace", params: { run: r.run_id, status: "failed_business" } });
  }
  for (const h of [...args.human].sort(bySoonestTimeout).slice(0, 3)) {
    out.push({ key: `h-${h.human_task_id}`, tone: h.timeout !== null ? "amber" : "blue", title: "사람 확인 대기", meta: humanTaskMeta(h), traceTitle: `사람 확인 추적 번호: ${h.human_task_id}`, view: "humanTasks", params: { ht: h.human_task_id } });
  }
  for (const d of args.wiDlq.slice(0, 2)) {
    out.push({ key: `wd-${d.dead_letter_id}`, tone: "red", title: "작업 항목 재처리 대기", meta: workitemRetryMeta(d), traceTitle: workitemTraceTitle(d), view: "workitems" });
  }
  for (const d of args.sinkDlq.slice(0, 2)) {
    out.push({ key: `sd-${d.dead_letter_id}`, tone: "red", title: "외부 전달 재처리 대기", meta: "외부 전달 재처리", traceTitle: sinkTraceTitle(d), view: "workitems" });
  }
  for (const s of args.redSites.filter((site) => site.approval_status === "pending").slice(0, 2)) {
    out.push({ key: `site-${s.site_profile_id}`, tone: "amber", title: "고위험 사이트 승인 대기", meta: s.name ?? "사이트명 확인 필요", traceTitle: `사이트 추적 번호: ${s.site_profile_id}`, view: "security" });
  }
  for (const r of args.running.slice(0, 1)) {
    const freshness = runningFreshness(r);
    out.push({ key: `run-${r.run_id}`, tone: freshness.tone, title: "실행 중 상태 점검", meta: freshness.meta, traceTitle: `실행 추적 번호: ${r.run_id}`, view: "runTrace", params: { run: r.run_id, status: "running" } });
  }
  return out.slice(0, 5);
}

function ActionQueue({ items }: { items: readonly ActionItem[] }): JSX.Element {
  return (
    <section className="panel action-queue" aria-label="지금 처리해야 할 Top 5">
      <div className="panel-head">
        <h2>지금 처리해야 할 Top 5</h2>
      </div>
      {items.length === 0 ? (
        <p className="subtle" style={{ margin: 0, padding: 16 }}>즉시 처리할 항목이 없습니다.</p>
      ) : (
        <div className="queue-list">
          {items.map((item, index) => (
            <button key={item.key} className="queue-item" type="button" aria-label={`Top ${index + 1} 처리 항목 ${item.title}. ${item.meta}`} title={item.traceTitle} onClick={() => navigate(item.view, item.params)}>
              <span className={`badge ${item.tone}`}>{index + 1}</span>
              <span>
                <strong>{item.title}</strong>
                <span className="subtle">{item.meta}</span>
              </span>
              <span className="subtle" aria-hidden="true">→</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function OpsSignalPanel({
  health,
  alerts,
  isLoading,
  isError,
}: {
  health: OpsHealth | undefined;
  alerts: readonly OpsAlertItem[];
  isLoading: boolean;
  isError: boolean;
}): JSX.Element {
  const topAlerts = alerts.slice(0, 3);
  return (
    <section className="panel ops-signal-panel" aria-label="운영 헬스와 긴급 알림">
      <div className="panel-head">
        <div>
          <h2>운영 헬스와 긴급 알림</h2>
          <p className="subtle">{health?.detected_at ?? (isLoading ? "동기화 중" : "스냅샷 없음")}</p>
        </div>
        <span className={`badge ${opsHealthTone(health?.status, isError)}`}>{opsHealthLabel(health?.status, isLoading, isError)}</span>
      </div>
      {isError ? (
        <p className="empty-state">운영 알림 스냅샷을 불러오지 못했습니다.</p>
      ) : (
        <div className="ops-signal-body">
          <div className="ops-signal-facts">
            <span>
              <strong>{health === undefined ? "-" : health.queue.available ? String(health.queue.pending_jobs ?? 0) : "미연결"}</strong>
              <small>큐 대기</small>
            </span>
            <span>
              <strong>{health === undefined ? "-" : String(health.stale_runs.nonterminal_over_15m)}</strong>
              <small>지연 실행</small>
            </span>
            <span>
              <strong>{health === undefined ? "-" : String(health.browser_leases.expired_open)}</strong>
              <small>만료 미회수 세션</small>
            </span>
          </div>
          {topAlerts.length === 0 ? (
            <p className="subtle ops-signal-empty">긴급 운영 알림이 없습니다.</p>
          ) : (
            <ul className="ops-signal-alerts">
              {topAlerts.map((alert) => (
                <li key={alert.alert_id}>
                  <span className={`badge ${opsAlertTone(alert.severity)}`}>{opsAlertSeverityLabel(alert.severity)}</span>
                  <button className="linklike" type="button" onClick={() => navigateOpsAlert(alert.route)}>
                    {alert.title}
                  </button>
                  <span className="subtle">{opsAlertSourceLabel(alert.source)} · {alert.recommended_action}</span>
                </li>
              ))}
            </ul>
          )}
          <button className="btn" type="button" onClick={() => navigate("automationOps")}>알림 센터 열기</button>
        </div>
      )}
    </section>
  );
}

function opsHealthTone(status: OpsHealth["status"] | undefined, isError: boolean): "green" | "amber" | "red" | "muted" {
  if (isError) return "red";
  if (status === "ok") return "green";
  if (status === "warning") return "amber";
  if (status === "critical") return "red";
  return "muted";
}

function opsHealthLabel(status: OpsHealth["status"] | undefined, isLoading: boolean, isError: boolean): string {
  if (isError) return "조회 실패";
  if (status === "ok") return "정상";
  if (status === "warning") return "주의";
  if (status === "critical") return "위험";
  return isLoading ? "동기화 중" : "미확인";
}

function opsAlertTone(severity: OpsAlertItem["severity"]): "red" | "amber" | "blue" {
  if (severity === "critical") return "red";
  if (severity === "warning") return "amber";
  return "blue";
}

function opsAlertSeverityLabel(severity: OpsAlertItem["severity"]): string {
  if (severity === "critical") return "위험";
  if (severity === "warning") return "주의";
  return "정보";
}

function opsAlertSourceLabel(source: OpsAlertItem["source"]): string {
  if (source === "run_sla") return "실행 SLA";
  if (source === "human_task_sla") return "사람 작업 SLA";
  if (source === "trigger_fire") return "트리거 발화";
  if (source === "failure_spike") return "실패 급증";
  if (source === "bot_pool") return "Bot Pool";
  if (source === "scim_secret_rotation") return "SCIM SecretRef";
  if (source === "audit_verifier") return "감사 체인";
  return "재처리 대기";
}

function navigateOpsAlert(route: string | null): void {
  if (route === null || route.trim().length === 0) {
    navigate("automationOps");
    return;
  }
  const trimmed = route.trim();
  location.hash = trimmed.startsWith("#") ? trimmed : `#${trimmed.replace(/^\/+/, "")}`;
}

type ReportExportState = "idle" | "pending" | "success" | "error";
type ReportExportFormat = AutomationPerformanceReportExportFormat;

function currentReportMonth(): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, "0")}`;
}

function percentLabel(value: number | null): string {
  return value === null ? "-" : `${Math.round(value * 100)}%`;
}

function compactNumber(value: number, digits = 0): string {
  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: digits }).format(value);
}

function moneyLabel(value: number): string {
  return new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 }).format(value);
}

function nullableMoneyLabel(value: number | null): string {
  return value === null ? "-" : moneyLabel(value);
}

function ratioLabel(value: number | null): string {
  return value === null ? "-" : `${compactNumber(value, 1)}x`;
}

type CompactMixTone = "blue" | "green" | "amber" | "purple" | "muted";

type CompactMixItem = {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly tone: CompactMixTone;
};

type ModelCostDayTrend = {
  readonly day: string;
  readonly cost: number | null;
  readonly rowCount: number;
  readonly nullCostRows: number;
};

const ROI_SOURCE_ORDER: readonly AutomationPerformanceRoiSource[] = ["process_mining", "task_mining", "manual", "imported"];

const ROI_SOURCE_LABELS: Record<AutomationPerformanceRoiSource, string> = {
  manual: "manual",
  process_mining: "process mining",
  task_mining: "task mining",
  imported: "imported",
};

const ROI_SOURCE_TONES: Record<AutomationPerformanceRoiSource, CompactMixTone> = {
  manual: "green",
  process_mining: "blue",
  task_mining: "purple",
  imported: "amber",
};

const ROI_STAGE_ORDER: readonly AutomationPerformanceRoiStage[] = ["approved", "build", "operate"];

const ROI_STAGE_LABELS: Record<AutomationPerformanceRoiStage, string> = {
  approved: "approved",
  build: "build",
  operate: "operate",
};

const ROI_STAGE_TONES: Record<AutomationPerformanceRoiStage, CompactMixTone> = {
  approved: "green",
  build: "blue",
  operate: "amber",
};

function confidenceLabel(value: AutomationPerformanceReport["summary"]["roi_confidence"]): string {
  return `H${value.high}/M${value.medium}/L${value.low}`;
}

function decisionSignalLabel(value: AutomationPerformanceReport["summary"]["decision_signal"]): string {
  if (value.status === "expand") return "Expand";
  if (value.status === "hold") return "Hold";
  return "Watch";
}

function roiActualsValue(value: AutomationPerformanceReport["summary"]["roi_actuals"]): string {
  if (value.evidence_count === 0) return "No actuals";
  if (value.estimated_transaction_count === 0) return `${compactNumber(value.actual_transaction_count)} actual tx`;
  return `${compactNumber(value.comparable_actual_transaction_count)}/${compactNumber(value.estimated_transaction_count)} tx`;
}

function roiActualsNote(value: AutomationPerformanceReport["summary"]["roi_actuals"]): string {
  if (value.evidence_count === 0) return "evidence 0";
  if (value.estimated_transaction_count === 0) return `no estimate · fail ${percentLabel(value.actual_failure_rate)}`;
  return `attain ${percentLabel(value.transaction_attainment_rate)} · actual ${compactNumber(value.actual_transaction_count)}`;
}

function roiActualsTitle(value: AutomationPerformanceReport["summary"]["roi_actuals"]): string {
  if (value.evidence_count === 0) return "No ROI actual evidence for this report period";
  return [
    `evidence ${compactNumber(value.evidence_count)}`,
    `comparable/estimate ${compactNumber(value.comparable_actual_transaction_count)}/${compactNumber(value.estimated_transaction_count)}`,
    `total actual ${compactNumber(value.actual_transaction_count)}`,
    `attainment ${percentLabel(value.transaction_attainment_rate)}`,
    `failure ${percentLabel(value.comparable_actual_failure_rate)} vs estimate ${percentLabel(value.estimated_exception_rate)}`,
    `total actual failure ${percentLabel(value.actual_failure_rate)}`,
    `delta ${percentLabel(value.failure_rate_delta)}`,
    `human ${compactNumber(value.human_intervention_minutes, 1)}m`,
    `rework ${compactNumber(value.reprocessing_minutes, 1)}m`,
    `latest ${value.latest_period_end ?? "-"}`,
  ].join(" · ");
}

function compactTextList(values: readonly string[], limit: number): string {
  const unique = [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
  if (unique.length === 0) return "";
  const head = unique.slice(0, limit).join(", ");
  const remaining = unique.length - limit;
  return remaining > 0 ? `${head} 외 ${compactNumber(remaining)}` : head;
}

function roiLineageSourceLabel(lineage: AutomationPerformanceRoiSourceLineage): string {
  const parts = ROI_SOURCE_ORDER
    .map((source) => ({ source, count: lineage.source_counts[source] }))
    .filter((item) => item.count > 0)
    .map((item) => `${ROI_SOURCE_LABELS[item.source]} ${compactNumber(item.count)}`);
  if (parts.length > 0) return parts.join(" · ");
  return lineage.idea_count > 0 ? `${compactNumber(lineage.idea_count)}건` : "근거 없음";
}

function roiLineageMeta(lineage: AutomationPerformanceRoiSourceLineage): string {
  const departments = compactTextList(lineage.departments, 2);
  const owners = compactTextList(lineage.business_owners, 2);
  const parts: string[] = [];
  if (departments.length > 0) parts.push(`부서 ${departments}`);
  if (owners.length > 0) parts.push(`오너 ${owners}`);
  return parts.length > 0 ? parts.join(" · ") : `${compactNumber(lineage.idea_count)}건`;
}

function roiLineageTitle(
  lineage: AutomationPerformanceRoiSourceLineage,
  confidence: AutomationPerformanceReport["summary"]["roi_confidence"],
): string {
  const sampleTitles = compactTextList(lineage.sample_ideas.map((idea) => idea.title), 3);
  const sampleText = sampleTitles.length > 0 ? ` · 샘플 ${sampleTitles}` : "";
  return `${roiLineageSourceLabel(lineage)} · ${roiLineageMeta(lineage)} · 신뢰도 ${confidenceLabel(confidence)}${sampleText}`;
}

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
  return `${chartName}. total ${compactNumber(total)}. ${detail}`;
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

function RoiSourceMixChart({ lineage }: { lineage: AutomationPerformanceRoiSourceLineage }): JSX.Element {
  const items: readonly CompactMixItem[] = ROI_SOURCE_ORDER.map((source) => ({
    key: source,
    label: ROI_SOURCE_LABELS[source],
    count: safeMixCount(lineage.source_counts[source]),
    tone: ROI_SOURCE_TONES[source],
  }));
  return (
    <CompactHorizontalBarSummary
      title="ROI source mix"
      items={items}
      ariaLabel={compactMixAriaLabel("ROI source mix chart", items)}
    />
  );
}

function RoiStageMixChart({ lineage }: { lineage: AutomationPerformanceRoiSourceLineage }): JSX.Element {
  const items: readonly CompactMixItem[] = ROI_STAGE_ORDER.map((stage) => ({
    key: stage,
    label: ROI_STAGE_LABELS[stage],
    count: safeMixCount(lineage.stage_counts[stage]),
    tone: ROI_STAGE_TONES[stage],
  }));
  return (
    <CompactHorizontalBarSummary
      title="ROI stage mix"
      items={items}
      ariaLabel={compactMixAriaLabel("ROI stage mix chart", items)}
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
    ? "latest empty"
    : latest.cost === null
      ? `latest ${latest.day} missing cost`
      : `latest ${latest.day} ${moneyLabel(latest.cost)}`;
  return `Model cost trend chart. ${compactNumber(days.length)} days, total ${moneyLabel(total)}, missing costs ${compactNumber(missingRows)}. ${latestText}`;
}

function ModelCostTrendMini({
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
        <h3>Model cost trend</h3>
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

function AutomationPerformancePanel({
  report,
  month,
  exportState,
  exportFormat,
  isLoading,
  isError,
  onMonthChange,
  onRetry,
  onExportCsv,
  onExportXlsx,
  onExportPocMarkdown,
  canExportXlsx,
  canExportPocMarkdown,
}: {
  report: AutomationPerformanceReport | undefined;
  month: string;
  exportState: ReportExportState;
  exportFormat: ReportExportFormat | null;
  isLoading: boolean;
  isError: boolean;
  onMonthChange: (month: string) => void;
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
  return (
    <section className="panel performance-report-panel" aria-label="월간 자동화 성과 리포트">
      <div className="panel-head">
        <div>
          <h2>월간 자동화 성과</h2>
          <p className="subtle">{report !== undefined ? `${report.month} · ${report.timezone}` : `${month} · Asia/Seoul`}</p>
        </div>
        <div className="inline-actions">
          <label className="field month-field">
            <span>월</span>
            <input type="month" value={month} onChange={(event) => onMonthChange(event.target.value)} />
          </label>
          <button className="btn" type="button" onClick={onRetry}>새로고침</button>
          <button className="btn" type="button" disabled={exportState === "pending" || report === undefined} onClick={onExportCsv}>
            {exportState === "pending" && exportFormat === "csv" ? "준비 중" : "CSV"}
          </button>
          <button className="btn" type="button" disabled={exportState === "pending" || report === undefined || !canExportPocMarkdown} onClick={onExportPocMarkdown}>
            {exportState === "pending" && exportFormat === "poc_markdown" ? "Preparing" : "PoC MD"}
          </button>
          <button className="btn" type="button" disabled={exportState === "pending" || report === undefined || !canExportXlsx} onClick={onExportXlsx}>
            {exportState === "pending" && exportFormat === "xlsx" ? "준비 중" : "XLSX"}
          </button>
        </div>
      </div>
      {exportState === "success" && <p className="notice success" role="status">성과 리포트 {exportFormat?.toUpperCase() ?? "export"}를 준비했습니다.</p>}
      {exportState === "error" && <p className="form-alert red" role="alert">성과 리포트 {exportFormat?.toUpperCase() ?? "export"}를 준비하지 못했습니다.</p>}
      {isError ? (
        <p className="empty-state">성과 리포트를 불러오지 못했습니다.</p>
      ) : isLoading ? (
        <p className="empty-state">성과 리포트를 동기화하는 중입니다.</p>
      ) : report === undefined ? (
        <p className="empty-state">성과 리포트 데이터가 없습니다.</p>
      ) : (
        <>
          <div className="summary-grid performance-summary">
            <ReportMetric label="성공률" value={percentLabel(report.summary.success_rate)} note={`${compactNumber(report.summary.completed)}건 완료`} />
            <ReportMetric label="절감 시간" value={`${compactNumber(report.summary.estimated_hours_saved, 1)}h`} note={moneyLabel(report.summary.estimated_value)} />
            <ReportMetric label="재처리율" value={percentLabel(report.summary.reprocessing_rate)} note={`${compactNumber(report.summary.rerun_count)}건 재실행`} />
            <ReportMetric label="Gateway 비용" value={moneyLabel(report.summary.gateway_cost)} note={`${compactNumber(report.summary.total_runs)}건 실행`} />
            <ReportMetric label="순가치" value={moneyLabel(report.summary.net_value)} note={`${ratioLabel(report.summary.value_to_cost_ratio)} value/cost`} />
            <ReportMetric label="LLM 비용" value={nullableMoneyLabel(report.summary.llm_call_cost)} note={`delta ${nullableMoneyLabel(report.summary.run_vs_call_cost_delta)}`} />
            <RoiSourceLineageMetric lineage={report.summary.roi_source_lineage} confidence={report.summary.roi_confidence} />
            <ReportMetric label="ROI actuals" value={roiActualsValue(report.summary.roi_actuals)} note={roiActualsNote(report.summary.roi_actuals)} />
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
                    <th scope="col">Cost/run</th>
                    <th scope="col">Delta</th>
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
              <table aria-label="Model cost daily trends">
                <thead>
                  <tr>
                    <th scope="col">일자</th>
                    <th scope="col">모델</th>
                    <th scope="col">Calls</th>
                    <th scope="col">비용</th>
                    <th scope="col">일 비중</th>
                    <th scope="col">Delta</th>
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
                      <strong>{nullableMoneyLabel(item.cost)} · {compactNumber(item.calls)} calls · {percentLabel(item.cost_share)}</strong>
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
                    <th scope="col">Cost/run</th>
                    <th scope="col">ROI actuals</th>
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

function downloadCsv(csv: string, filename: string): void {
  downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), filename);
}

function downloadMarkdown(markdown: string, filename: string): void {
  downloadBlob(new Blob([markdown], { type: "text/markdown;charset=utf-8" }), filename);
}

function downloadBlob(blob: Blob, filename: string): void {
  if (typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function DashboardView(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const roles = useRoles();
  const [reportMonth, setReportMonth] = useState(currentReportMonth);
  const [reportExportState, setReportExportState] = useState<ReportExportState>("idle");
  const [reportExportFormat, setReportExportFormat] = useState<ReportExportFormat | null>(null);
  // '실행 중'은 서버 status 필터로 정확히 집계(이전: 전체 50건을 클라에서 status==='running' 필터 → 50건 초과 시 구조적 오집계).
  const running = useQuery({ queryKey: ["runs", "running"], queryFn: () => api.listRuns({ status: "running", limit: 50 }), refetchInterval: 5_000 });
  const recent = useQuery({ queryKey: ["runs"], queryFn: () => api.listRuns({ limit: 50 }), refetchInterval: 5_000 });
  const human = useQuery({ queryKey: ["human-tasks"], queryFn: () => api.listHumanTasks({ limit: 50 }), refetchInterval: 5_000 });
  const wiDlq = useQuery({ queryKey: ["dlq", "workitem"], queryFn: () => api.listDlq("workitem", { limit: 50 }), refetchInterval: 5_000 });
  const sinkDlq = useQuery({ queryKey: ["dlq", "sink"], queryFn: () => api.listDlq("sink", { limit: 50 }), refetchInterval: 5_000 });
  // 실패 터미널(failed_business/failed_system)을 서버 status 필터로 각각 정확 집계(클라 필터 아님).
  // 카드를 status별로 분리한다: 합산 단일 카드는 카운트(business+system)와 드릴다운 해시(단일 status)의 모집단이
  // 어긋나(RunTrace는 단일 status만 시드) 실패 총량을 오표상했다. 카드별 단일-status 카운트↔단일-status 해시로
  // '실행 중' 카드와 동일하게 카운트·목록 모집단 정합을 정확히 만족시킨다(조용한 false 인접 오표상 제거).
  const failedBiz = useQuery({ queryKey: ["runs", "failed_business"], queryFn: () => api.listRuns({ status: "failed_business", limit: 50 }), refetchInterval: 5_000 });
  const failedSys = useQuery({ queryKey: ["runs", "failed_system"], queryFn: () => api.listRuns({ status: "failed_system", limit: 50 }), refetchInterval: 5_000 });
  const redSites = useQuery({ queryKey: ["sites", "red"], queryFn: () => api.listSites({ risk: "red", limit: 50 }), refetchInterval: 10_000 });
  // 관찰성 집계(§E run_success_rate + status별 정확 카운트). 서버 GROUP BY 라 카드가 '50+' 근사 대신 정확 총계.
  const summary = useQuery({ queryKey: ["runs", "summary"], queryFn: () => api.getRunSummary(), refetchInterval: 5_000 });
  const trends = useQuery({ queryKey: ["runs", "trends"], queryFn: () => api.getRunTrends(30), refetchInterval: 30_000 });
  const performanceReport = useQuery({
    queryKey: ["automation-performance-report", reportMonth],
    queryFn: () => api.getAutomationPerformanceReport(reportMonth),
    refetchInterval: 60_000,
  });
  const opsHealth = useQuery({ queryKey: ["ops-health", "dashboard"], queryFn: () => api.getOpsHealth(), refetchInterval: 5_000 });
  const opsAlerts = useQuery({ queryKey: ["ops-alerts", "dashboard"], queryFn: () => api.listOpsAlerts({ limit: 3 }), refetchInterval: 5_000 });

  async function exportPerformanceReportCsv(): Promise<void> {
    setReportExportState("pending");
    setReportExportFormat("csv");
    try {
      const csv = await api.exportAutomationPerformanceReportCsv(reportMonth);
      downloadCsv(csv, `automation-performance-${reportMonth}.csv`);
      setReportExportState("success");
    } catch {
      setReportExportState("error");
    }
  }

  async function exportPerformanceReportXlsx(): Promise<void> {
    setReportExportState("pending");
    setReportExportFormat("xlsx");
    try {
      if (api.exportAutomationPerformanceReportXlsx === undefined) throw new Error("xlsx export is not available");
      const xlsx = await api.exportAutomationPerformanceReportXlsx(reportMonth);
      downloadBlob(xlsx, `automation-performance-${reportMonth}.xlsx`);
      setReportExportState("success");
    } catch {
      setReportExportState("error");
    }
  }

  async function exportPerformanceReportPocMarkdown(): Promise<void> {
    setReportExportState("pending");
    setReportExportFormat("poc_markdown");
    try {
      if (api.exportAutomationPerformanceReportPocMarkdown === undefined) throw new Error("PoC Markdown export is not available");
      const markdown = await api.exportAutomationPerformanceReportPocMarkdown(reportMonth);
      downloadMarkdown(markdown, `automation-performance-poc-${reportMonth}.md`);
      setReportExportState("success");
    } catch {
      setReportExportState("error");
    }
  }

  // 첫-실행 안내 배너: '진짜 빈 테넌트'(실행 0건)일 때만. recent(무필터 listRuns)의 실 필드로만 판정.
  // length===0 && next_cursor===null → 절단된 0(더 있을 수 있음)이 아닌 진짜 0(조용한 false 금지).
  // isLoading/isError 중에는 미표시(데이터 도착 전 단정 금지). 실행이 1건이라도 생기면 자동 소멸.
  const isEmptyTenant = recent.isSuccess && recent.data.items.length === 0 && recent.data.next_cursor === null;

  return (
    <>
      {isEmptyTenant && <OnboardingBanner {...onboardingProps(can, roles)} />}
      <RoleWorkbench roles={roles} can={can} />
      <OpsSignalPanel
        health={opsHealth.data}
        alerts={opsAlerts.data?.items ?? []}
        isLoading={(opsHealth.data === undefined && opsHealth.isFetching) || (opsAlerts.data === undefined && opsAlerts.isFetching)}
        isError={opsHealth.isError || opsAlerts.isError}
      />
      <div className="metrics">
        <Metric label="실행 성공률" value={successRateLabel(summary.data)} view="runTrace" params={{ status: "completed" }} hint="완료 실행" />
        <Metric label="캐시 재사용률" value={cacheHitRateLabel(summary.data)} view="runTrace" hint="실행 기록" />
        <Metric label="실행 중" value={exactCount(summary.data, "running")} view="runTrace" params={{ status: "running" }} hint="실행 기록" />
        <Metric label="사람 확인 대기" value={pageCount(human.data)} view="humanTasks" hint="사람 확인" />
        <Metric label="업무 실패" value={exactCount(summary.data, "failed_business")} view="runTrace" params={{ status: "failed_business" }} hint="실행 기록" />
        <Metric label="시스템 실패" value={exactCount(summary.data, "failed_system")} view="runTrace" params={{ status: "failed_system" }} hint="실행 기록" />
        <Metric label="작업 항목 재처리 대기" value={pageCount(wiDlq.data)} view="workitems" hint="작업 목록" />
        <Metric label="외부 전달 재처리 대기" value={pageCount(sinkDlq.data)} view="workitems" hint="작업 목록" />
      </div>
      <p className="subtle" style={{ margin: "0 2px" }}>
        실행 성공률·캐시 재사용률·실행 중·업무 실패·시스템 실패는 전체 기간 정확 집계입니다. 사람 확인·재처리 대기는 최신 50건 기준이며 <strong>+</strong>는 표시 한도를 넘겨 더 있음을 뜻합니다(예: <code>50+</code> = 50건 이상).
      </p>
      <RunTrendsPanel
        trends={trends.data}
        isLoading={trends.data === undefined && trends.isFetching}
        isError={trends.isError}
      />
      <AutomationPerformancePanel
        report={performanceReport.data}
        month={reportMonth}
        exportState={reportExportState}
        exportFormat={reportExportFormat}
        isLoading={performanceReport.data === undefined && performanceReport.isFetching}
        isError={performanceReport.isError}
        onMonthChange={(month) => {
          setReportMonth(month);
          setReportExportState("idle");
          setReportExportFormat(null);
        }}
        onRetry={() => void performanceReport.refetch()}
        onExportCsv={() => void exportPerformanceReportCsv()}
        onExportXlsx={() => void exportPerformanceReportXlsx()}
        onExportPocMarkdown={() => void exportPerformanceReportPocMarkdown()}
        canExportXlsx={api.exportAutomationPerformanceReportXlsx !== undefined}
        canExportPocMarkdown={api.exportAutomationPerformanceReportPocMarkdown !== undefined}
      />
      <ActionQueue
        items={collectActionItems({
          failedBiz: failedBiz.data?.items ?? [],
          failedSys: failedSys.data?.items ?? [],
          running: running.data?.items ?? [],
          human: human.data?.items ?? [],
          wiDlq: wiDlq.data?.items ?? [],
          sinkDlq: sinkDlq.data?.items ?? [],
          redSites: redSites.data?.items ?? [],
        })}
      />
      {/* 빈 테넌트(실행 0건)일 때는 위 OnboardingBanner 가 '실행 없음' + CTA 로 그 상태를 온전히 안내하므로,
          같은 사실을 반복하는 패널 EmptyState('아직 실행이 없습니다.')는 숨긴다(중복 메시지·중복 role='status' 제거).
          실행이 1건이라도 생기면 isEmptyTenant=false 가 되어 패널이 즉시 복귀한다(기능 손실 없음). */}
      {!isEmptyTenant && (
      <QueryPanel<RunItem>
        title="최근 실행"
        query={recent}
        rowKey={(r) => r.run_id}
        emptyMessage="아직 실행이 없습니다."
        columns={[
          {
            header: "실행 추적 번호",
            render: (r) => (
              <button
                type="button"
                className="linklike"
                aria-label="실행 추적 상세 보기"
                title={`실행 추적 번호: ${r.run_id}`}
                onClick={() => navigate("runTrace", { run: r.run_id })}
              >
                상세 보기
              </button>
            ),
          },
          { header: "상태", render: (r) => <StatusBadge status={r.status} /> },
        ]}
      />
      )}
    </>
  );
}
