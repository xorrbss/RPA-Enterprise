import { errorCodeLabel, kindLabel } from "../../components/badges";
import { navigate, type ViewKey } from "../../router";
import { formatDeadline } from "../../util/time";
import { isActiveHumanTask } from "../humanTaskFilters";
import { DASHBOARD_RUN_MODE } from "./metrics";
import type { DeadLetterItem, HumanTaskItem, RunItem, SiteItem } from "../../api/types";

type ActionItem = {
  readonly key: string;
  readonly tone: "red" | "amber" | "blue";
  readonly title: string;
  readonly meta: string;
  readonly traceTitle?: string;
  readonly view: ViewKey;
  readonly params?: Record<string, string>;
};

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

function humanTaskMeta(task: HumanTaskItem): { meta: string; tone: ActionItem["tone"] } {
  if (task.timeout !== null) {
    const deadline = formatDeadline(task.timeout);
    return { meta: `마감 ${deadline.text}`, tone: deadline.overdue ? "red" : "amber" };
  }
  const label = kindLabel(task.kind);
  return { meta: label === task.kind ? "확인 대기" : `${label} 확인 대기`, tone: "blue" };
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

export function collectActionItems(args: {
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
    out.push({ key: `fs-${r.run_id}`, tone: "red", title: withRunIdentity("시스템 실패 실행", r), meta: failedRunMeta(r), traceTitle: failedRunTraceTitle(r), view: "runTrace", params: { run: r.run_id, status: "failed_system", run_mode: DASHBOARD_RUN_MODE } });
  }
  for (const r of args.failedBiz.slice(0, 2)) {
    out.push({ key: `fb-${r.run_id}`, tone: "red", title: withRunIdentity("업무 실패 실행", r), meta: failedRunMeta(r), traceTitle: failedRunTraceTitle(r), view: "runTrace", params: { run: r.run_id, status: "failed_business", run_mode: DASHBOARD_RUN_MODE } });
  }
  for (const h of [...args.human].filter(isActiveHumanTask).sort(bySoonestTimeout).slice(0, 3)) {
    const humanMeta = humanTaskMeta(h);
    out.push({ key: `h-${h.human_task_id}`, tone: humanMeta.tone, title: `사람 확인 대기 · 접수번호 #${h.human_task_id.slice(0, 8)}`, meta: humanMeta.meta, traceTitle: `사람 확인 추적 번호: ${h.human_task_id}`, view: "humanTasks", params: { ht: h.human_task_id } });
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
    out.push({ key: `run-${r.run_id}`, tone: freshness.tone, title: withRunIdentity("실행 중 상태 점검", r), meta: freshness.meta, traceTitle: `실행 추적 번호: ${r.run_id}`, view: "runTrace", params: { run: r.run_id, status: "running", run_mode: DASHBOARD_RUN_MODE } });
  }
  return out.slice(0, 5);
}

// Top5 행 식별 — 어떤 자동화의 실행인지 제목에 병기(없으면 원제 유지 — 이름 날조 금지).
function withRunIdentity(base: string, r: RunItem): string {
  return r.scenario_name !== undefined ? `${base} · ${r.scenario_name}` : base;
}

export function ActionQueue({ items }: { items: readonly ActionItem[] }): JSX.Element {
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
