import { useCallback, useEffect, useState } from "react";

import type { ScenarioDetail } from "../../api/types";
import { diffDraftIr, type StepDiff } from "./step-diff";

// #453/N1: revise 변경 표시는 저장본끼리(v1 vs v2) 비교한다.
// - 응답 draft_ir 은 서버가 instruction 을 redaction 하므로, 비redaction 저장본과 섞어 비교하면
//   마스킹 차이만으로 가짜 "달라진 단계"가 생기고, 응답끼리 비교하면 instruction 만 바뀐 수정이
//   양쪽 다 같은 토큰으로 마스킹돼 무표시가 된다. 저장본끼리 비교만이 두 함정을 모두 피한다.
// - 이전 저장본(v1)은 refetch 로 v2 가 되기 전에 begin() 시점 스냅샷으로 보관하고, ReviseControl 이
//   invalidate 한 scenario-detail 재조회가 새 data 객체(v2)로 도착한 뒤에만 계산한다(도착 전 계산 금지 —
//   react-query 는 성공 refetch 시 data 객체를 교체하므로 객체 항등 변화가 도착 신호다).
// 소비처: FocusedScenarioStudio 설계 탭(DesignStepCards)과 GenerationResult(저장 완료 경로).
// key 는 계산된 diff 가 어느 대상의 것인지 식별하는 소비처 스코프 값(스튜디오=scenario_id,
// 초안 직후=generation_id — 이력 선택으로 다른 결과로 바뀌면 표시하지 않기 위함).
export function useSavedReviseDiff(detail: ScenarioDetail | undefined): {
  readonly result: { readonly key: string; readonly diff: StepDiff } | null;
  readonly begin: (key: string, base: ScenarioDetail | undefined) => void;
  readonly reset: () => void;
} {
  const [pending, setPending] = useState<{ readonly key: string; readonly base: ScenarioDetail | undefined } | null>(null);
  const [result, setResult] = useState<{ readonly key: string; readonly diff: StepDiff } | null>(null);
  useEffect(() => {
    if (pending === null || detail === undefined) return;
    if (detail === pending.base) return; // 아직 이전 캐시 그대로 — 새 저장본 도착 대기
    setResult({ key: pending.key, diff: diffDraftIr(pending.base?.ir, detail.ir) });
    setPending(null);
  }, [pending, detail]);
  // begin/reset 은 항등 고정 — 소비처가 effect 의존성에 넣어도 재실행 루프가 없다.
  const begin = useCallback((key: string, base: ScenarioDetail | undefined) => {
    setResult(null); // 직전 diff 는 새 수정으로 대체 — 이전 표시가 새 결과에 남지 않게 한다.
    setPending({ key, base });
  }, []);
  const reset = useCallback(() => {
    setPending(null);
    setResult(null);
  }, []);
  return { result, begin, reset };
}
