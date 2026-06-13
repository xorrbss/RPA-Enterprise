/**
 * codegen/error-middleware.ts
 *
 * D1 codegen artifact — DO NOT hand-edit semantics here.
 * Source of truth: ../ts/error-catalog.ts (ERROR_CATALOG) + api-surface.md §0.2.
 *
 * Maps an ErrorCode → HTTP response { status, body: ApiError }.
 * Framework-agnostic pure function (`toApiError`); thin Express/Fastify
 * adapter wiring is documented in comments at the bottom.
 *
 * Contract invariants honored (api-surface.md §0.2, error-catalog.ts):
 *  - HTTP status = ERROR_CATALOG[code].httpStatus, used verbatim (no re-mapping).
 *  - body.message defaults to ERROR_CATALOG[code].userMessage (외부 노출, no secrets).
 *  - operatorAction is internal-only and is NEVER placed in the response body.
 *  - correlation_id MUST equal the event-envelope / trace correlation_id (§0.2).
 *  - DEAD_LETTER (httpStatus 200) is NOT an API error response — it is a status
 *    notification. It is surfaced as a discriminated notification result, never
 *    thrown/returned as an ApiError ("조용한 false/unknown 금지": we do not silently
 *    coerce it into a 200 error body).
 *  - Every ErrorCode is mapped via ERROR_CATALOG (Record<ErrorCode, ErrorMeta>);
 *    there is no unmapped/unknown fallback path for a valid ErrorCode.
 */

import {
  ERROR_CATALOG,
  type ApiError,
  type ErrorCode,
  type ErrorMeta,
} from "../ts/error-catalog";

/**
 * Successful resolution of `toApiError` for codes that are genuine API errors
 * (i.e. ERROR_CATALOG[code].httpStatus !== 200).
 */
export interface ApiErrorResponse {
  kind: "error";
  status: number;
  body: ApiError;
}

/**
 * Resolution for DEAD_LETTER (httpStatus 200) — not an error response but a
 * status notification. Callers MUST handle this branch explicitly rather than
 * emitting it as an HTTP error body.
 */
export interface NotificationResponse {
  kind: "notification";
  code: Extract<ErrorCode, "DEAD_LETTER">;
  /** ERROR_CATALOG[code].userMessage — operator-facing status text. */
  message: string;
  correlationId: string;
}

export type ToApiErrorResult = ApiErrorResponse | NotificationResponse;

/** httpStatus value reserved by the catalog for "not an API error". */
const NON_ERROR_HTTP_STATUS = 200;

/**
 * Pure mapping from an ErrorCode to its HTTP response shape.
 *
 * @param code           A catalog ErrorCode (exhaustively keyed in ERROR_CATALOG).
 * @param correlationId  The shared correlation_id (event-envelope/trace/log).
 * @param details        Optional structured detail (api-surface ApiError.details).
 *                       MUST already be redaction-safe — this function does not
 *                       inspect or sanitize it.
 *
 * @returns ApiErrorResponse for real errors; NotificationResponse for DEAD_LETTER.
 */
export function toApiError(
  code: ErrorCode,
  correlationId: string,
  details?: unknown,
): ToApiErrorResult {
  const meta: ErrorMeta = ERROR_CATALOG[code];

  // DEAD_LETTER(200): status notification, not an API error response (§0.2).
  if (meta.httpStatus === NON_ERROR_HTTP_STATUS) {
    return {
      kind: "notification",
      code: code as Extract<ErrorCode, "DEAD_LETTER">,
      message: meta.userMessage,
      correlationId,
    };
  }

  const body: ApiError = {
    code,
    message: meta.userMessage, // 외부 노출용; operatorAction은 절대 싣지 않는다.
    correlation_id: correlationId,
    ...(details !== undefined ? { details } : {}),
  };

  return {
    kind: "error",
    status: meta.httpStatus, // ERROR_CATALOG 그대로(중복 정의 금지).
    body,
  };
}

/**
 * Type guard: true when the resolution is a genuine HTTP error response.
 * Lets adapters branch without re-reading the catalog.
 */
export function isApiErrorResponse(
  r: ToApiErrorResult,
): r is ApiErrorResponse {
  return r.kind === "error";
}

/* ---------------------------------------------------------------------------
 * Framework adapters (comments only — no framework dependency is introduced).
 *
 * The codegen output stays framework-agnostic per contract. Wire it like so:
 *
 * --- Express ---
 *   // import type { Request, Response, NextFunction } from "express";
 *   //
 *   // export function expressErrorMiddleware(
 *   //   err: unknown,
 *   //   req: Request,
 *   //   res: Response,
 *   //   next: NextFunction,
 *   // ): void {
 *   //   // `err` should carry a catalog ErrorCode + the request correlation_id
 *   //   // (the same id propagated to event-envelope/trace). Resolving an
 *   //   // ErrorCode from an arbitrary throwable is the caller's policy and is
 *   //   // intentionally out of scope here — unclassified exceptions must map to
 *   //   // a "system"-class code upstream ("조용한 false/unknown 금지").
 *   //   const { code, correlationId, details } = err as {
 *   //     code: ErrorCode; correlationId: string; details?: unknown;
 *   //   };
 *   //   const r = toApiError(code, correlationId, details);
 *   //   if (r.kind === "notification") {
 *   //     // DEAD_LETTER: not an error body. Hand off to the DLQ/notify path
 *   //     // and respond per that endpoint's contract (api-surface §0.2).
 *   //     next(); // or a 200 status-list body — endpoint-specific.
 *   //     return;
 *   //   }
 *   //   res.status(r.status).json(r.body);
 *   // }
 *
 * --- Fastify ---
 *   // import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
 *   //
 *   // export function fastifyErrorHandler(
 *   //   err: FastifyError & { code: ErrorCode; correlationId: string; details?: unknown },
 *   //   _req: FastifyRequest,
 *   //   reply: FastifyReply,
 *   // ): void {
 *   //   const r = toApiError(err.code, err.correlationId, err.details);
 *   //   if (r.kind === "notification") return; // DEAD_LETTER — not an error body.
 *   //   reply.code(r.status).send(r.body);
 *   // }
 * ------------------------------------------------------------------------- */
