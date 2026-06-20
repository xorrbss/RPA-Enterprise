/**
 * 자연어 generation 정책 primitive (scenario-generations.ts 분해 — 동작 무변경 이동).
 *
 * route 핸들러와 결정형 플래너가 함께 쓰는 recording/pagination 정책 primitive. 양쪽이 본 leaf를 import해
 * route↔planner 순환 의존을 끊는다(planner 모듈 추출의 선행). EvidencePolicy(./scenario-generation-types)만 의존.
 */
import type { EvidencePolicy } from "./scenario-generation-types";

export const DEFAULT_PAGINATION_MAX_PAGES = 3;
export const MAX_AUTO_PAGINATION_PAGES = 10;

export type RecordingPolicy = "always" | "masked_on_failure" | "never";

export function recordingPolicy(evidence: EvidencePolicy): RecordingPolicy {
  // Action-level recording controls step screenshot capture only; run video is driven by meta.evidence.video.
  if (evidence.screenshot === "each_step") return "always";
  if (evidence.screenshot === "never") return "never";
  return "masked_on_failure";
}
