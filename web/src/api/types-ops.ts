// DG-3 전용 워커 풀 — 풀 레지스트리 항목 + 호출 테넌트의 배정.
export type WorkerPoolStatus = "active" | "draining" | "disabled";
export type WorkerPoolPriority = "low" | "medium" | "high" | "critical";

export interface WorkerPoolItem {
  readonly pool_key: string;
  readonly description: string | null;
  readonly status: WorkerPoolStatus;
  readonly max_concurrency: number;
  readonly priority: WorkerPoolPriority;
  readonly created_at: string;
  readonly updated_at: string;
  readonly updated_by: string | null;
  readonly workers?: {
    readonly total: number;
    readonly active: number;
    readonly stale: number;
    readonly worker_ids: readonly string[];
  };
}

export interface WorkerPoolMutationBody {
  readonly description?: string | null;
  readonly status?: WorkerPoolStatus;
  readonly max_concurrency?: number;
  readonly priority?: WorkerPoolPriority;
  readonly reason?: string;
}

export interface WorkerPoolList {
  readonly items: readonly WorkerPoolItem[];
  readonly assigned_pool_key: string | null;
  // 운영 안전(stuck 가시화): 호출 테넌트의 대기(queued) 실행 수 + 가장 오래된 시각. 배정 풀에 워커가 없으면
  // run 이 디스패치되지 않아 queued 로 쌓인다 — 콘솔이 정직한 지연 힌트를 표기.
  readonly pending: { readonly queued_runs: number; readonly oldest_queued_at: string | null };
}

export type RunTriggerType = "cron" | "webhook";

export interface RunTriggerItem {
  readonly trigger_id: string;
  readonly scenario_version_id: string;
  readonly trigger_type: RunTriggerType;
  readonly status: "enabled" | "paused" | "archived";
  readonly cron_expression: string | null;
  readonly timezone: string | null;
  readonly webhook_secret_ref: string | null;
  readonly webhook_secret_configured?: boolean;
  readonly params: Record<string, unknown>;
  readonly catchup_policy: "skip_missed" | "fire_once";
  readonly max_concurrent_runs: number;
  readonly next_fire_at: string | null;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RunTriggerCreateBody {
  readonly trigger_type?: RunTriggerType;
  readonly scenario_version_id: string;
  readonly cron_expression?: string;
  readonly timezone?: string;
  readonly webhook_secret_ref?: string;
  readonly params?: Record<string, unknown>;
  readonly catchup_policy?: "skip_missed" | "fire_once";
  readonly max_concurrent_runs?: number;
  readonly next_fire_at?: string | null;
}

export interface RunTriggerUpdateBody {
  readonly cron_expression?: string;
  readonly timezone?: string;
  readonly webhook_secret_ref?: string;
  readonly params?: Record<string, unknown>;
  readonly catchup_policy?: "skip_missed" | "fire_once";
  readonly max_concurrent_runs?: number;
  readonly next_fire_at?: string | null;
}

export interface RunTriggerFireItem {
  readonly fire_id: string;
  readonly trigger_id: string;
  readonly fire_key: string;
  readonly status: "queued" | "skipped" | "failed";
  readonly scheduled_for: string;
  readonly run_id: string | null;
  readonly failure_reason: Record<string, unknown> | null;
  readonly created_at: string;
}

export type OpsHealthStatus = "ok" | "warning" | "critical";

export interface OpsHealth {
  readonly status: OpsHealthStatus;
  readonly detected_at: string;
  readonly queue: {
    readonly available: boolean;
    readonly pending_jobs: number | null;
  };
  readonly browser_leases: {
    readonly reserved: number;
    readonly active: number;
    readonly draining: number;
    readonly expired: number;
    readonly expired_open: number;
    readonly next_expiry_at: string | null;
  };
  readonly stale_runs: {
    readonly nonterminal_over_15m: number;
    readonly oldest_updated_at: string | null;
  };
}

export type BotPoolHealth = "ok" | "warning" | "critical";

export interface BotPoolItem {
  readonly bot_pool_id: string;
  readonly name: string;
  readonly kind: "browser";
  readonly capacity_slots: number;
  readonly workers: {
    readonly total: number;
    readonly active: number;
    readonly draining: number;
    readonly dead: number;
    readonly stale: number;
    readonly open_circuit: number;
  };
  readonly leases: {
    readonly reserved: number;
    readonly active: number;
    readonly draining: number;
    readonly expired_open: number;
    readonly next_expiry_at: string | null;
  };
  readonly queue: {
    readonly pending_runs: number;
    readonly queued_runs: number;
    readonly claimed_runs: number;
    readonly oldest_queued_at: string | null;
    readonly due_triggers: number;
  };
  readonly capacity: {
    readonly occupied_slots: number;
    readonly available_slots: number;
    readonly capacity_gap: number;
    readonly queue_pressure: number | null;
    readonly live_capacity: {
      readonly available: boolean;
      readonly pool_key?: string;
      readonly source?: "worker_pool_memberships";
      readonly reason_code?: "worker_pool_membership_missing";
    };
  };
  readonly health: BotPoolHealth;
  readonly health_reason: string;
}
