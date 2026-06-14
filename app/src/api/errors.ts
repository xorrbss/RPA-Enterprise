/**
 * 제어평면 API 에러 경계 (D4.1).
 *
 * 계약:
 *  - api-surface.md §0.2: 모든 4xx/5xx 본문은 ApiError(ts/error-catalog.ts). HTTP 상태는
 *    ERROR_CATALOG[code].httpStatus 그대로(중복 정의 금지). correlation_id는 trace/event와 동일 값.
 *  - codegen/error-middleware.ts(toApiError)를 재사용해 ErrorCode→HTTP를 단일 지점에서 매핑한다.
 *  - "조용한 false/unknown 금지": 분류된 ApiResponseError는 해당 catalog code로, 임의 throwable은
 *    CONTROL_PLANE_INTERNAL_ERROR로 매핑한다. raw error/details는 로그에만 남기고 응답에는 노출하지 않는다.
 */
import type { FastifyInstance } from "fastify";

import { isApiErrorResponse, toApiError } from "../../../codegen/error-middleware";
import type { ErrorCode } from "../../../ts/error-catalog";

/** 제어평면 핸들러/미들웨어가 던지는 분류된 에러. code는 카탈로그 코드(상태통지 DEAD_LETTER 제외). */
export class ApiResponseError extends Error {
  readonly code: Exclude<ErrorCode, "DEAD_LETTER">;
  readonly details?: unknown;

  constructor(code: Exclude<ErrorCode, "DEAD_LETTER">, details?: unknown) {
    super(code);
    this.name = "ApiResponseError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Fastify 에러 핸들러 등록. ApiResponseError → toApiError(ErrorCode→HTTP + ApiError 본문, codegen 재사용).
 * 미분류 예외는 CONTROL_PLANE_INTERNAL_ERROR로 매핑해 ApiError shape와 catalog-backed code를 유지한다.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiResponseError) {
      const mapped = toApiError(error.code, request.correlationId, error.details);
      if (isApiErrorResponse(mapped)) {
        reply.code(mapped.status).send(mapped.body);
        return;
      }
      // 도달 불가: ApiResponseError.code는 DEAD_LETTER(상태통지)를 타입에서 배제. 방어적 500.
      reply.code(500).send({ message: "내부 오류가 발생했습니다.", correlation_id: request.correlationId });
      return;
    }
    request.log.error({ err: error, correlation_id: request.correlationId }, "unclassified control-plane error");
    const mapped = toApiError("CONTROL_PLANE_INTERNAL_ERROR", request.correlationId);
    if (isApiErrorResponse(mapped)) {
      reply.code(mapped.status).send(mapped.body);
      return;
    }
    reply.code(500).send({ message: "내부 오류가 발생했습니다.", correlation_id: request.correlationId });
  });
}
