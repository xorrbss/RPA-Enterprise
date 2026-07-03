export interface Paginated<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

export type GlobalSearchType = "run" | "scenario" | "human_task" | "principal" | "credential";

export interface GlobalSearchItem {
  readonly type: GlobalSearchType;
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
  readonly route: string;
  readonly matched_field: string;
}

export interface GlobalSearchResult {
  readonly items: readonly GlobalSearchItem[];
  readonly next_cursor: string | null;
}

export interface ListParams {
  limit?: number;
  cursor?: string;
  status?: string;
  kind?: string;
  risk?: string;
  assignee?: string;
  unassigned?: boolean;
  terminal?: "false";
  active?: boolean;
  run_id?: string;
  // query-bag: 뷰별 추가 필터(model 등)를 허용. URLSearchParams로 직렬화.
  [k: string]: string | number | boolean | undefined;
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
