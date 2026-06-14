import { ERROR_CATALOG } from "../ts/error-catalog";
import type { ApiError, ErrorCode } from "../ts/error-catalog";
import type { ControlPlaneResponse } from "../ts/control-plane-contract";

export type ApiErrorResponseCode = Exclude<ErrorCode, "DEAD_LETTER">;

export class ApiResponseException extends Error {
  readonly code: ApiErrorResponseCode;
  readonly details?: unknown;

  constructor(code: ApiErrorResponseCode, details?: unknown, message?: string) {
    super(message ?? ERROR_CATALOG[code].userMessage);
    this.name = "ApiResponseException";
    this.code = code;
    this.details = details;
  }
}

export class ContractBlockedError extends Error {
  readonly todo: string;

  constructor(todo: string) {
    super(todo);
    this.name = "ContractBlockedError";
    this.todo = todo;
  }
}

export function toApiError(code: ApiErrorResponseCode, correlationId: string, details?: unknown): ApiError {
  return {
    code,
    message: ERROR_CATALOG[code].userMessage,
    details,
    correlation_id: correlationId,
  };
}

export function apiErrorResponse(
  code: ApiErrorResponseCode,
  correlationId: string,
  details?: unknown,
): ControlPlaneResponse {
  return {
    status: ERROR_CATALOG[code].httpStatus,
    body: toApiError(code, correlationId, details),
  };
}

export function exceptionResponse(error: ApiResponseException, correlationId: string): ControlPlaneResponse {
  return apiErrorResponse(error.code, correlationId, error.details);
}
