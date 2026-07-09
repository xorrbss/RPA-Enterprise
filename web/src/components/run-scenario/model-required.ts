import type { ApiErrorBody } from "../../api/types";

// createRun 의 model_required(다정책+기본없음 → 임의선택 불가) 판별 — error-catalog 본문 details.reason 으로 식별.
// E0: RunScenarioButton 전용 private 이던 판별을 공용 추출 — 쉬운 제작 위저드(E4 TestProgress)가 같은 복구
// 동선(모델 선택 후 재시도, RunScenarioButton 동형)을 재사용한다(판별 로직 중복 금지).
export function modelRequiredOf(body: ApiErrorBody | null): { available: number } | null {
  const details = body?.details;
  if (details === undefined || details.reason !== "model_required") return null;
  const available = typeof details.available === "number" ? details.available : 0;
  return { available };
}
