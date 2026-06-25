import { navigate } from "../../router";
import type { BotPoolItem } from "../../api/types";

export function BotPoolCapacityPanel({
  pools,
  isLoading,
  isError,
  retryQueueStatus,
  retryQueueTone,
}: {
  pools: readonly BotPoolItem[];
  isLoading: boolean;
  isError: boolean;
  retryQueueStatus: string;
  retryQueueTone: "green" | "red";
}): JSX.Element {
  return (
    <div className="ops-column bot-pool-capacity">
      <h3>용량</h3>
      {isError ? (
        <div className="ops-alert-empty" role="status">
          <strong>봇 풀 상태를 불러오지 못했습니다.</strong>
          <span className="subtle">잠시 후 다시 시도하거나, 권한·연결 상태를 운영 담당자에게 문의하세요.</span>
        </div>
      ) : isLoading ? (
        <div className="ops-alert-empty" role="status">
          <strong>봇 풀 용량을 확인하는 중입니다.</strong>
          <span className="subtle">브라우저 worker와 lease 점유율을 동기화합니다.</span>
        </div>
      ) : pools.length === 0 ? (
        <div className="ops-alert-empty" role="status">
          <strong>표시할 봇 풀이 없습니다.</strong>
          <span className="subtle">브라우저 실행 worker가 등록되면 용량이 표시됩니다.</span>
        </div>
      ) : (
        <ul>
          {pools.map((pool) => (
            <li key={pool.bot_pool_id}>
              <span>
                <strong>{pool.name}</strong>
                <span className="subtle">{botPoolCapacityDetail(pool)}</span>
                <span className="subtle">{pool.health_reason}</span>
              </span>
              <span className={`badge ${botPoolTone(pool.health)}`}>{botPoolHealthLabel(pool.health)}</span>
            </li>
          ))}
          <li>
            <span>
              <strong>실행 흐름</strong>
              <span className="subtle">실행 기록에서 queued/running 상태를 추적합니다.</span>
            </span>
            <button className="linklike" type="button" onClick={() => navigate("runTrace", { status: "running" })}>
              실행 보기
            </button>
          </li>
          <li>
            <span>
              <strong>재시도 큐</strong>
              <span className="subtle">작업 항목 재처리 대기 상태</span>
            </span>
            <button className={`badge ${retryQueueTone}`} type="button" onClick={() => navigate("workitems")}>
              {retryQueueStatus}
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

function botPoolTone(health: BotPoolItem["health"]): "green" | "amber" | "red" {
  if (health === "ok") return "green";
  if (health === "warning") return "amber";
  return "red";
}

function botPoolHealthLabel(health: BotPoolItem["health"]): string {
  if (health === "ok") return "정상";
  if (health === "warning") return "주의";
  return "위험";
}

function botPoolCapacityDetail(pool: BotPoolItem): string {
  const occupied = pool.leases.active + pool.leases.reserved;
  const workers = `worker ${pool.workers.active}/${pool.workers.total}`;
  const leases = `사용 ${occupied}/${pool.capacity_slots}`;
  const pending = `대기 ${pool.queue.pending_runs}건`;
  const dueTriggers = pool.queue.due_triggers > 0 ? ` · 발화 예정 ${pool.queue.due_triggers}건` : "";
  return `${workers} · ${leases} · ${pending}${dueTriggers}`;
}
