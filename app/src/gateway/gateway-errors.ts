/**
 * Gateway 종결 실패/abort 신호 + AdapterErrorCode → 카탈로그 ErrorCode 매핑(llm-gateway-adapter.md §4).
 */
import type { ErrorCode } from "../../../ts/error-catalog";
import type { AdapterErrorCode } from "../../../ts/security-middleware-contract";

/** 카탈로그 ErrorCode 로 분류된 Gateway 종결 실패. */
export class GatewayError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    /** 원 AdapterErrorCode(멱등 store.fail 기록용). */
    readonly adapterCode?: AdapterErrorCode,
    readonly stagehandCallId?: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/** run abort 전파 — 카탈로그 ErrorCode 가 아닌 제어 흐름 신호(run 단위 취소가 처리). */
export class GatewayAbortedError extends Error {
  constructor() {
    super("LLM call aborted");
    this.name = "GatewayAbortedError";
  }
}

/** §4: AdapterErrorCode → 종결 ErrorCode. */
export function mapTerminal(code: AdapterErrorCode): ErrorCode {
  switch (code) {
    case "RATE_LIMIT":
      return "LLM_RATE_LIMITED";
    case "BACKEND_ERROR":
      return "LLM_BACKEND_UNAVAILABLE";
    case "STREAM_IDLE_TIMEOUT":
      return "LLM_STREAM_IDLE_TIMEOUT";
    case "STREAM_TIMEOUT":
      return "LLM_STREAM_TIMEOUT";
    case "BUDGET_EXCEEDED":
      return "LLM_BUDGET_EXCEEDED";
    case "MALFORMED_OUTPUT":
      return "LLM_MALFORMED_OUTPUT";
    case "CONTENT_FILTERED":
      return "LLM_CONTENT_FILTERED";
    case "CONNECTION_FAILED":
      return "LLM_CONNECTION_FAILED";
  }
}
