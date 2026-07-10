import type { ScenarioGenerationResult } from "../../api/types";

// F3(잔여 설계 §3.2·상세 설계 §4.5): 원패스 셸의 phase — 기존 useGenerationActions 위에 얹는
// 파생 상태만 계산한다(생성/보정/실행 로직 이동 없음). PRECHECK 는 별도 phase 가 아니라 IDLE 내
// 접힌 준비 요약이다(상세 설계 §3.1 "단계 미추가 원칙"). 새로고침 시 IDLE 복귀는 수용
// (이력은 GenerationHistory 가 제공, generation 딥링크 복원은 YAGNI — 레지스터 F3 결정 기록).
export type EasyGenerationPhase = "IDLE" | "GENERATING" | "PREVIEW" | "TESTING";

export function useEasyGeneration(input: {
  readonly generating: boolean;
  readonly result: ScenarioGenerationResult | null;
  readonly testRunId: string | null;
}): EasyGenerationPhase {
  if (input.generating) return "GENERATING";
  if (input.result === null) return "IDLE";
  if (input.testRunId === null) return "PREVIEW";
  return "TESTING";
}
