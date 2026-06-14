/**
 * 제어평면 API 에러 경계 (D4.1).
 *
 * 계약:
 *  - api-surface.md §0.2: 모든 4xx/5xx 본문은 ApiError(ts/error-catalog.ts). HTTP 상태는
 *    ERROR_CATALOG[code].httpStatus 그대로(중복 정의 금지). correlation_id는 trace/event와 동일 값.
 *  - codegen/error-middleware.ts(toApiError)를 재사용해 ErrorCode→HTTP를 단일 지점에서 매핑한다.
 *  - "조용한 false/unknown 금지": 분류된 ApiResponseError만 ApiError 본문으로 매핑한다. 임의 throwable의
 *    카탈로그 코드 분류는 본 계층 밖(codegen/error-middleware.ts 주석: 상위에서 system 코드로 분류)이며,
 *    카탈로그에 일반 내부오류(500) 코드가 없으므로 미분류 예외는 코드를 날조하지 않고 로깅 후 표면화한다.
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
 * 미분류 예외는 카탈로그 코드를 날조하지 않고(가정 금지) 로깅 후 500으로 표면화한다.
 *
 * TODO: [BLOCKED]
 *   violated: api-surface §0.2(모든 4xx/5xx 본문=ApiError, code 필수)
 *   reason: error-catalog에 일반 내부오류(500) 코드가 없어 미분류 예외에 실을 카탈로그 code가 없다.
 *   required_change: 임의 throwable→ExceptionClass(system) 분류 계층 + 일반 500 카탈로그 코드 신설 결정
 *     (D4 범위 밖; codegen/error-middleware.ts 주석의 "upstream system 분류"와 동일 미해결 지점).
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
    // 미분류 예외: 일반 내부오류 카탈로그 코드 부재(위 TODO) → 로깅 후 500. 코드 날조 금지.
    request.log.error({ err: error, correlation_id: request.correlationId }, "unclassified control-plane error");
    reply.code(500).send({ message: "내부 오류가 발생했습니다.", correlation_id: request.correlationId });
  });
}
