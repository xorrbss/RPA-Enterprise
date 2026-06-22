/**
 * 리스트(GET) 공용 — 커서 페이지네이션 + 닫힌 enum 필터 검증 (D6.5 read-backfill / api-surface §0.5).
 *
 * - 커서: 불투명 base64url(JSON {c=created_at ISO, i=id}). keyset `(created_at, id)` DESC 기반.
 *   limit+1 행을 조회해 다음 페이지 유무를 판정하고 마지막 페이지 행으로 next_cursor를 만든다.
 * - limit: 1..MAX. 운영 상한(api-surface §0.5: Phase 3 정책 전 런타임 기본값) — ops-defaults 확정 시 override.
 * - status/kind 필터: 닫힌 enum이므로 무효값은 IR_SCHEMA_INVALID(422)로 거부(조용한 빈-결과 금지).
 *   enum 런타임 배열이 SSoT에 없어 `Record<State,true>`로 미러링 → 누락/오타가 컴파일타임 에러(드리프트 차단).
 */
import type { HumanTaskKind, HumanTaskState, RunState, WorkitemState } from "../../../ts/state-machine-types";
import { ApiResponseError } from "./errors";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PageCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface PageParams {
  readonly limit: number;
  readonly cursor: PageCursor | null;
}

/** limit 파라미터 파싱. 미지정→기본, 무효 형식/0 이하→422, 상한 초과는 MAX로 캡(운영 정책). */
export function parseLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_limit" });
  }
  const n = Number.parseInt(raw, 10);
  if (n < 1) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_limit" });
  }
  return Math.min(n, MAX_LIMIT);
}

/** 불투명 커서 디코드. 미지정→null, 형식 무효→422(::cast 500 회피). */
export function decodeCursor(raw: unknown): PageCursor | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_cursor" });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_cursor" });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_cursor" });
  }
  const { c, i } = parsed as { c?: unknown; i?: unknown };
  if (typeof c !== "string" || typeof i !== "string" || !UUID_RE.test(i) || Number.isNaN(Date.parse(c))) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_cursor" });
  }
  return { createdAt: c, id: i };
}

// createdAt 는 DB `<ts>::text`(마이크로초 전정밀도 문자열)여야 한다 — JS Date 경유 시 pg 가 timestamptz 를 밀리초
// Date 로 파싱해 마이크로초가 소실되고, 절단된 커서가 마이크로초 컬럼과 비교돼 동일-밀리초 경계 행이 keyset
// 페이지네이션에서 조용히 누락된다(PAG-01). 커서는 전정밀도 문자열을 그대로 싣고, 비교 시 호출부가 ::timestamptz 로 재파싱.
export function encodeCursor(createdAt: string, id: string): string {
  // fail-loud: 호출부가 `<ts>::text AS cursor_at`(전정밀도 문자열) 대신 누락/Date 를 넘기면 조용한 잘못된 커서 대신 throw.
  if (typeof createdAt !== "string" || createdAt.length === 0) {
    throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "cursor_source_not_text" });
  }
  return Buffer.from(JSON.stringify({ c: createdAt, i: id }), "utf8").toString("base64url");
}

export function parsePageParams(query: Record<string, unknown>): PageParams {
  return { limit: parseLimit(query.limit), cursor: decodeCursor(query.cursor) };
}

/**
 * limit+1 행(keyset DESC)으로부터 페이지를 만든다. 다음 페이지 존재 시 마지막 반환 행으로 next_cursor 생성.
 * rows는 limit+1 한도로 조회되어 있어야 한다(LIMIT $limit + 1).
 */
export function paginate<Row, Item>(
  rows: readonly Row[],
  limit: number,
  cursorOf: (row: Row) => { createdAt: string; id: string },
  map: (row: Row) => Item,
): { items: Item[]; next_cursor: string | null } {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  let nextCursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    const last = cursorOf(pageRows[pageRows.length - 1]);
    nextCursor = encodeCursor(last.createdAt, last.id);
  }
  return { items: pageRows.map(map), next_cursor: nextCursor };
}

// ===== 닫힌 enum 필터 검증(Record로 exhaustive 미러링: state-machine-types.ts + DB CHECK 정합) =====

const RUN_STATE_SET: Record<RunState, true> = {
  queued: true, claimed: true, running: true, suspending: true, suspended: true,
  resume_requested: true, resuming: true, completing: true, completed: true,
  aborting: true, cancelled: true, failed_business: true, failed_system: true,
};

const HUMANTASK_STATE_SET: Record<HumanTaskState, true> = {
  open: true, assigned: true, in_progress: true, resolved: true,
  expired: true, cancelled: true, escalated: true,
};

const HUMANTASK_KIND_SET: Record<HumanTaskKind, true> = {
  approval: true, validation: true, exception: true, captcha: true, mfa: true,
};

const WORKITEM_STATE_SET: Record<WorkitemState, true> = {
  new: true, processing: true, successful: true, retry: true,
  failed_business: true, failed_system: true, abandoned: true,
};

function requireEnumFilter<T extends string>(raw: unknown, set: Record<T, true>, reason: string): T | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string" && Object.prototype.hasOwnProperty.call(set, raw)) {
    return raw as T;
  }
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
}

export function runStateFilter(raw: unknown): RunState | undefined {
  return requireEnumFilter<RunState>(raw, RUN_STATE_SET, "invalid_status");
}

export function humanTaskStateFilter(raw: unknown): HumanTaskState | undefined {
  return requireEnumFilter<HumanTaskState>(raw, HUMANTASK_STATE_SET, "invalid_status");
}

export function humanTaskKindFilter(raw: unknown): HumanTaskKind | undefined {
  return requireEnumFilter<HumanTaskKind>(raw, HUMANTASK_KIND_SET, "invalid_kind");
}

export function workitemStateFilter(raw: unknown): WorkitemState | undefined {
  return requireEnumFilter<WorkitemState>(raw, WORKITEM_STATE_SET, "invalid_status");
}

/** optional uuid 필터(scenario_version_id, run_id 등). 무효 형식→422. */
export function uuidFilter(raw: unknown, reason: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string" && UUID_RE.test(raw)) return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
}

/**
 * optional PrincipalId 필터(human_tasks.assignee 등). PrincipalId(JWT sub)는 자유형 string(UUID 보장 없음:
 * OIDC sub auth0|… 등)이라 uuid 형식을 강제하지 않는다. 비-빈 string 만 허용(빈 값→422). 파라미터 바인딩
 * text 비교라 주입 경로 없음.
 */
export function principalIdFilter(raw: unknown, reason: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string" && raw.length > 0) return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
}
