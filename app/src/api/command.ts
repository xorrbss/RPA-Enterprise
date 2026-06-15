/**
 * 멱등 명령형 POST 공용 골격 (D4.5 — api-surface §0.4 / release-decisions #7).
 *
 * 부작용 명령 엔드포인트(run abort, human-task assign/start/resolve/escalate, dlq replay)가 공유하는
 * 멱등 예약/재생/충돌/실패영속 보일러플레이트를 한 곳으로 모은다(KISS/DRY). 각 엔드포인트는 요청-형상
 * 선검사(키 소모 이전, malformed→422)를 핸들러에서 수행한 뒤, 자원-상태 의존 작업만 `work`로 넘긴다.
 *
 *  - reserve: (tenant, endpoint, Idempotency-Key)로 최초 처리 보관. replay→최초 응답 재생,
 *    in_flight→409(retryable), blocked(request_hash mismatch)→412.
 *  - work: 동일 tx에서 부작용 수행 후 CommandResponse 반환. 헬퍼가 같은 tx에서 멱등 'succeeded' 기록(원자화).
 *  - 실패: 결정론적(비-retryable) ApiResponseError만 saveFailure로 영속(동일 키 재요청이 같은 응답 재생).
 *    retryable(경합/transient)은 영속하지 않고 재던진다(예약 'processing' 유지 → TTL 회수).
 *
 * 기존 createRun/promoteScenario는 인라인 구현을 유지한다(엔탱글 회피, 원자적 변경). 신규 D4.5 명령만 사용.
 */
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { isApiErrorResponse, toApiError } from "../../../codegen/error-middleware";
import type { OperationId } from "../../../ts/control-plane-contract";
import { ERROR_CATALOG, type ApiError } from "../../../ts/error-catalog";
import type { CanonicalRequestHash, IdempotencyKey } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { ApiResponseError } from "./errors";
import { canonicalRequestHash, completeIdempotencyInTx } from "./idempotency";
import { requirePrincipal, type ApiServerDeps } from "./server";

export interface CommandResponse {
  status: number;
  body: unknown;
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** 작업 콜백: 열린 tenant-bound tx에서 부작용 수행 후 응답 반환(멱등 성공 기록은 헬퍼가 동일 tx에서 수행). */
export type CommandWork = (client: PoolClient, tenantId: string) => Promise<CommandResponse>;

/**
 * 멱등 명령 실행. 호출 전 핸들러가 path/body 형상 선검사(키 소모 이전)를 끝내야 한다.
 * `path`는 request_hash 계산용 정규 경로(예: `/v1/human-tasks/<id>/assign`).
 */
export async function runIdempotentCommand(
  deps: ApiServerDeps,
  request: FastifyRequest,
  endpoint: OperationId,
  path: string,
  work: CommandWork,
): Promise<CommandResponse> {
  const principal = requirePrincipal(request);

  const idempotencyKey = request.headers["idempotency-key"];
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_idempotency_key", header: "Idempotency-Key" });
  }

  const requestHash = canonicalRequestHash("POST", path, request.body ?? null);
  const reservation = await deps.idempotency.reserve({
    tenantId: principal.tenantId,
    endpoint,
    key: idempotencyKey as IdempotencyKey,
    requestHash: requestHash as CanonicalRequestHash,
    expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString(),
  });
  if (reservation.kind === "replay") {
    return { status: reservation.response.status, body: reservation.response.body };
  }
  if (reservation.kind === "in_flight") {
    throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", { reason: "idempotency_in_flight" });
  }
  if (reservation.kind === "blocked") {
    throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "idempotency_request_hash_mismatch" });
  }

  const recordId = reservation.recordId;
  try {
    return await withTenantTx(deps.pool, principal.tenantId, async (client) => {
      const response = await work(client, principal.tenantId);
      // 멱등 성공 기록을 부작용과 동일 tx에 원자화(별도 tx 불일치 창 제거).
      await completeIdempotencyInTx(client, recordId, response);
      return response;
    });
  } catch (err) {
    if (err instanceof ApiResponseError && !ERROR_CATALOG[err.code].retryable) {
      await deps.idempotency.saveFailure(recordId, apiErrorBody(err, request.correlationId));
    }
    throw err;
  }
}

/** 분류된 실패(ApiResponseError)를 멱등 레코드에 저장할 ApiError 본문으로 변환. */
export function apiErrorBody(err: ApiResponseError, correlationId: string): ApiError {
  const mapped = toApiError(err.code, correlationId, err.details);
  if (isApiErrorResponse(mapped)) {
    return mapped.body;
  }
  // 도달 불가: err.code는 DEAD_LETTER(상태통지)를 타입에서 배제.
  return { code: err.code, message: ERROR_CATALOG[err.code].userMessage, correlation_id: correlationId };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
