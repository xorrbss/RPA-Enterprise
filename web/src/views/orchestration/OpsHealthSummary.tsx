import { navigate } from "../../router";
import type { OpsHealth } from "../../api/types";
import { formatDateTime } from "./format";

export function OpsHealthSummary({
  health,
  isLoading,
  isError,
}: {
  health: OpsHealth | undefined;
  isLoading: boolean;
  isError: boolean;
}): JSX.Element {
  if (isError) {
    return (
      <section className="panel ops-health-summary" aria-label="운영 헬스 요약">
        <div className="panel-head">
          <h2>운영 헬스</h2>
          <span className="badge red">조회 실패</span>
        </div>
        <p className="empty-state">운영 헬스 스냅샷을 불러오지 못했습니다.</p>
      </section>
    );
  }

  return (
    <section className="panel ops-health-summary" aria-label="운영 헬스 요약">
      <div className="panel-head">
        <div>
          <h2>운영 헬스</h2>
          <p className="subtle">{health?.detected_at !== undefined ? formatDateTime(health.detected_at) : (isLoading ? "동기화 중" : "스냅샷 없음")}</p>
        </div>
        <span className={`badge ${opsHealthTone(health?.status)}`}>{opsHealthLabel(health?.status, isLoading)}</span>
      </div>
      <div className="ops-health-grid">
        <HealthTile
          title="큐 대기"
          value={health === undefined ? "-" : health.queue.available ? String(health.queue.pending_jobs ?? 0) : "미연결"}
          detail={health?.queue.available === true ? "대기 작업" : "작업 큐 미연결"}
        />
        <HealthTile
          title="브라우저 세션"
          value={health === undefined ? "-" : String(health.browser_leases.active + health.browser_leases.reserved)}
          detail={browserLeaseDetail(health)}
          tone={health !== undefined && health.browser_leases.expired_open > 0 ? "red" : "green"}
        />
        <HealthTile
          title="지연 실행"
          value={health === undefined ? "-" : String(health.stale_runs.nonterminal_over_15m)}
          detail={staleRunDetail(health)}
          tone={health !== undefined && health.stale_runs.nonterminal_over_15m > 0 ? "amber" : "green"}
          action={health !== undefined && health.stale_runs.nonterminal_over_15m > 0 ? () => navigate("runTrace", { status: "running" }) : undefined}
        />
        <HealthTile
          title="예약 스케줄러"
          value={schedulerHealthValue(health)}
          detail={schedulerHealthDetail(health)}
          tone={schedulerHealthTone(health)}
        />
      </div>
    </section>
  );
}

function HealthTile({
  title,
  value,
  detail,
  tone = "blue",
  action,
}: {
  title: string;
  value: string;
  detail: string;
  tone?: "green" | "blue" | "amber" | "red" | "muted";
  action?: () => void;
}): JSX.Element {
  return (
    <div className="ops-health-tile">
      <span className="subtle">{title}</span>
      <strong>{value}</strong>
      <span className={`badge ${tone}`}>{detail}</span>
      {action !== undefined && (
        <button className="linklike" type="button" onClick={action}>
          실행 보기
        </button>
      )}
    </div>
  );
}

// 브라우저 세션 만료 타이밍 표면화 — 만료 미회수 건수만으론 긴급성 판단 불가.
// next_expiry_at(다음 자동 회수 시각)은 계약 제공 필드이며, null 이면 표기하지 않는다(조용한 false 금지).
function browserLeaseDetail(health: OpsHealth | undefined): string {
  if (health === undefined) return "사용 중/예약";
  const { expired_open, next_expiry_at } = health.browser_leases;
  const base = `만료 미회수 ${expired_open}건`;
  return next_expiry_at !== null ? `${base} · 다음 만료 ${formatDateTime(next_expiry_at)}` : base;
}

// 지연 실행의 '가장 오래된 시작 시각'을 표면화 — 15분인지 2시간인지로 심각도가 갈린다.
// 지연 건이 있고 oldest_updated_at(계약 제공)이 있으면 그 시각을, 아니면 기존 일반 문구를 보인다.
function staleRunDetail(health: OpsHealth | undefined): string {
  if (health === undefined) return "15분 이상 진행 중";
  const { nonterminal_over_15m, oldest_updated_at } = health.stale_runs;
  if (nonterminal_over_15m > 0 && oldest_updated_at !== null) {
    return `가장 오래된 시작 ${formatDateTime(oldest_updated_at)}`;
  }
  return "15분 이상 진행 중";
}

function opsHealthTone(status: OpsHealth["status"] | undefined): "green" | "amber" | "red" | "muted" {
  if (status === "ok") return "green";
  if (status === "warning") return "amber";
  if (status === "critical") return "red";
  return "muted";
}

function opsHealthLabel(status: OpsHealth["status"] | undefined, isLoading: boolean): string {
  if (status === "ok") return "정상";
  if (status === "warning") return "주의";
  if (status === "critical") return "위험";
  return isLoading ? "동기화 중" : "미확인";
}

function schedulerHealthValue(health: OpsHealth | undefined): string {
  if (health === undefined) return "-";
  return health.queue.available ? "큐 연결" : "확인 필요";
}

function schedulerHealthDetail(health: OpsHealth | undefined): string {
  if (health === undefined) return "스케줄러 상태 확인 중";
  return health.queue.available ? "발화 작업 적재 가능" : "작업 큐 미연결";
}

function schedulerHealthTone(health: OpsHealth | undefined): "green" | "blue" | "amber" | "red" | "muted" {
  if (health === undefined) return "muted";
  return health.queue.available ? "green" : "amber";
}
