// 제어평면 read 응답 타입(api-surface §1·§3·§4, app/src/api/reads.ts 매핑 기준).

export interface Paginated<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

export interface RunItem {
  readonly run_id: string;
  readonly status: string;
  readonly current_node: string | null;
  readonly as_of: string | null;
}

export interface WorkitemItem {
  readonly workitem_id: string;
  readonly status: string;
  readonly unique_reference: string;
  readonly target_id: string | null;
}

export interface HumanTaskItem {
  readonly human_task_id: string;
  readonly state: string;
  readonly kind: string;
  readonly assignee: string | null;
  readonly timeout: string | null;
  readonly run_id: string | null;
}

/** workitem DLQ(dead_letter) + sink DLQ(sink_deliveries) 공용. status는 DEAD_LETTER 통지(ApiError 아님). */
export interface DeadLetterItem {
  readonly dead_letter_id: string;
  readonly kind: "workitem" | "sink";
  readonly status: string;
  readonly source_id: string | null;
  readonly sink_idempotency_key?: string;
}

export interface ScenarioItem {
  readonly scenario_id: string;
  readonly name: string;
  readonly version: number;
  readonly latest_version_id: string;
}

export interface SiteItem {
  readonly site_profile_id: string;
  readonly risk: string;
  readonly approval_status: string;
  readonly circuit_status: string;
  readonly name?: string;
}

export interface RunDetail {
  readonly run_id: string;
  readonly status: string;
  readonly worker_id: string | null;
  readonly attempts: number;
  readonly as_of: string | null;
}

export interface ScenarioDetail {
  readonly scenario_id: string;
  readonly name: string;
  readonly version: number;
  readonly promotion_status: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly report: unknown;
}

export interface CreateRunBody {
  readonly scenario_version_id: string;
  readonly params?: Record<string, unknown>;
  readonly workitem_id?: string;
}

export interface GatewayPolicy {
  readonly model: string;
  readonly capabilities?: Record<string, unknown>;
  readonly budget?: Record<string, unknown>;
  readonly fallback?: Record<string, unknown>;
}

export interface ListParams {
  limit?: number;
  cursor?: string;
  status?: string;
  kind?: string;
  // query-bag: 뷰별 추가 필터(model 등)를 허용. URLSearchParams로 직렬화.
  [k: string]: string | number | undefined;
}

/** 제어평면 ApiError(error-catalog) 본문. */
export interface ApiErrorBody {
  readonly code: string;
  readonly message?: string;
  readonly details?: Record<string, unknown>;
  readonly correlation_id?: string;
}

export class ApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    readonly body: ApiErrorBody | null,
  ) {
    super(body?.message ?? code);
    this.name = "ApiError";
  }
}
