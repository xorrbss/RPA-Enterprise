import type {
  CapabilityDecision,
  LLMPrimitive,
  LLMRequest,
  ModelCapabilities,
  RedactedImageRef,
} from "../ts/security-middleware-contract";

export function evaluateCapability(input: {
  primitive: LLMPrimitive;
  responseFormat?: LLMRequest["responseFormat"];
  images?: readonly RedactedImageRef[];
  capabilities: ModelCapabilities;
}): CapabilityDecision {
  const { primitive, responseFormat, images = [], capabilities } = input;

  if ((primitive === "act" || primitive === "observe" || primitive === "agent") && !capabilities.domReasoning) {
    return deny(`primitive ${primitive} requires domReasoning capability`);
  }

  if ((primitive === "vlm_verify" || images.length > 0) && !capabilities.vision) {
    return deny("vision input requires model vision capability");
  }

  if (responseFormat?.type === "json_schema" && !capabilities.jsonMode && responseFormat.strict) {
    return deny("strict json_schema output requires jsonMode capability");
  }

  if (capabilities.sse) return { kind: "allow", transport: "sse" };
  return { kind: "allow", transport: "sync" };
}
function deny(reason: string): CapabilityDecision {
  return { kind: "deny", code: "LLM_CAPABILITY_MISMATCH", reason };
}
