import type {
  AdapterErrorCode,
  LLMRequest,
  LLMStreamEvent,
} from "../ts/security-middleware-contract";

export type StreamOutcome =
  | {
      kind: "completed";
      text: string;
      jsonText: string;
      usage: { inputTokens: number; outputTokens: number; cost: number; estimated?: boolean };
    }
  | { kind: "failed"; code: AdapterErrorCode; retryable: boolean; reason: string }
  | { kind: "aborted"; reason: string };

export async function collectGatewayStream(input: {
  request: LLMRequest;
  events: AsyncIterable<LLMStreamEvent>;
  abort?: AbortController;
}): Promise<StreamOutcome> {
  let text = "";
  let jsonText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let estimated = false;

  for await (const event of input.events) {
    switch (event.type) {
      case "open":
        break;
      case "text_delta":
        text += event.text;
        break;
      case "json_delta":
        jsonText += event.partial;
        break;
      case "usage":
        inputTokens = event.inputTokens;
        outputTokens = event.outputTokens;
        cost = event.cost;
        estimated = event.estimated === true;
        if (cost > input.request.budget.maxCost || outputTokens > input.request.budget.maxOutputTokens) {
          input.abort?.abort();
          return {
            kind: "failed",
            code: "BUDGET_EXCEEDED",
            retryable: false,
            reason: "usage exceeded request budget during stream",
          };
        }
        break;
      case "error":
        return { kind: "failed", code: event.code, retryable: event.retryable, reason: event.message };
      case "aborted":
        return { kind: "aborted", reason: "adapter emitted aborted" };
      case "done":
        return {
          kind: "completed",
          text,
          jsonText,
          usage: { inputTokens, outputTokens, cost, estimated },
        };
      case "tool_call_delta":
        break;
    }
  }

  return { kind: "failed", code: "CONNECTION_FAILED", retryable: true, reason: "stream ended without done" };
}
export type StructuredJsonRepairResult =
  | { kind: "valid"; value: unknown; repaired: false }
  | { kind: "valid"; value: unknown; repaired: true }
  | { kind: "invalid"; code: Extract<AdapterErrorCode, "MALFORMED_OUTPUT">; reason: string };

export function parseOrRepairStructuredJson(input: {
  jsonText: string;
  strict: boolean;
  validate: (value: unknown) => boolean;
  repairOnce: (jsonText: string, reason: string) => string;
}): StructuredJsonRepairResult {
  const first = parseJson(input.jsonText);
  if (first.kind === "ok" && input.validate(first.value)) {
    return { kind: "valid", value: first.value, repaired: false };
  }

  const reason = first.kind === "error" ? first.reason : "schema validation failed";
  if (input.strict) {
    return { kind: "invalid", code: "MALFORMED_OUTPUT", reason };
  }

  const repairedText = input.repairOnce(input.jsonText, reason);
  const repaired = parseJson(repairedText);
  if (repaired.kind === "ok" && input.validate(repaired.value)) {
    return { kind: "valid", value: repaired.value, repaired: true };
  }
  return { kind: "invalid", code: "MALFORMED_OUTPUT", reason: "repair attempt failed" };
}

function parseJson(text: string): { kind: "ok"; value: unknown } | { kind: "error"; reason: string } {
  try {
    return { kind: "ok", value: JSON.parse(text) as unknown };
  } catch (error: unknown) {
    return { kind: "error", reason: error instanceof Error ? error.message : "invalid json" };
  }
}
