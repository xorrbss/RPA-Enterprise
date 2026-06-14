import type {
  AdapterErrorCode,
  LLMBackendAdapter,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  ModelCapabilities,
} from "../ts/security-middleware-contract";
import type { ArtifactRef } from "../ts/core-types";

export interface FakeAdapterScript {
  readonly capabilities: ModelCapabilities;
  readonly stream: readonly LLMStreamEvent[];
  readonly syncResponse?: LLMResponse;
}
export class FakeLLMBackendAdapter implements LLMBackendAdapter {
  readonly id: string;

  constructor(id: string, private readonly script: FakeAdapterScript) {
    this.id = id;
  }

  capabilities(): ModelCapabilities {
    return this.script.capabilities;
  }

  async *streamCall(_req: LLMRequest, signal: AbortSignal): AsyncIterable<LLMStreamEvent> {
    for (const event of this.script.stream) {
      if (signal.aborted) {
        yield { type: "aborted" };
        return;
      }
      yield event;
    }
  }

  async syncCall(_req: LLMRequest): Promise<LLMResponse> {
    if (this.script.syncResponse !== undefined) return this.script.syncResponse;
    return {
      outputRef: "artifact://fake/sync-output" as ArtifactRef,
      usage: { inputTokens: 0, outputTokens: 0, cost: 0, estimated: true },
      finishReason: "stop",
    };
  }
}

export function gatewayErrorForAdapter(code: AdapterErrorCode):
  | "LLM_RATE_LIMITED"
  | "LLM_BACKEND_UNAVAILABLE"
  | "LLM_STREAM_IDLE_TIMEOUT"
  | "LLM_STREAM_TIMEOUT"
  | "LLM_BUDGET_EXCEEDED"
  | "LLM_MALFORMED_OUTPUT"
  | "LLM_CONTENT_FILTERED"
  | "LLM_CONNECTION_FAILED" {
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
