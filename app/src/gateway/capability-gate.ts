/**
 * CapabilityGate — primitive ↔ 모델 capability 적합성 게이트 (D5 — llm-gateway-adapter.md §1).
 *
 * `CapabilityGate`(ts/security-middleware-contract.ts 고정) 구현. Gateway 가 호출 전 1회 평가한다.
 *
 * **하드 거부**(폴백 불가)만 `LLM_CAPABILITY_MISMATCH` 로 deny:
 *  - vlm_verify / 이미지 입력인데 `vision=false`
 *  - act/observe/extract/agent/self_heal 인데 `domReasoning=false`
 *
 * **structured output(responseFormat)** 은 `jsonMode=false` 여도 **거부하지 않는다**. §1 의 예시
 * "extract+jsonMode=false→거부" 를 README §19 결정이 **prompt-schema+strict 폴백**(§7)으로 refine했다
 * (Gateway 요청 빌드 단계에서 스키마를 프롬프트에 주입). 따라서 게이트는 allow 하고 폴백은 Gateway 책임.
 * transport 는 `sse=false` 면 sync 폴백(§1 capabilities.sse).
 */
import type {
  CapabilityDecision,
  CapabilityGate,
  LLMPrimitive,
} from "../../../ts/security-middleware-contract";

type GateInput = Parameters<CapabilityGate["evaluate"]>[0];

const NEEDS_DOM_REASONING: ReadonlySet<LLMPrimitive> = new Set<LLMPrimitive>([
  "act",
  "observe",
  "extract",
  "agent",
  "self_heal",
]);

function deny(reason: string): CapabilityDecision {
  return { kind: "deny", code: "LLM_CAPABILITY_MISMATCH", reason };
}

export class SafeCapabilityGate implements CapabilityGate {
  evaluate(input: GateInput): CapabilityDecision {
    const cap = input.capabilities;

    const needsVision = input.primitive === "vlm_verify" || (input.images?.length ?? 0) > 0;
    if (needsVision && !cap.vision) {
      return deny(`primitive '${input.primitive}' requires vision capability`);
    }
    if (NEEDS_DOM_REASONING.has(input.primitive) && !cap.domReasoning) {
      return deny(`primitive '${input.primitive}' requires domReasoning capability`);
    }
    // responseFormat + jsonMode=false 는 deny 아님 — §19 prompt-schema 폴백(Gateway 빌드). 하드 거부는 위 둘뿐.
    return { kind: "allow", transport: cap.sse ? "sse" : "sync" };
  }
}
