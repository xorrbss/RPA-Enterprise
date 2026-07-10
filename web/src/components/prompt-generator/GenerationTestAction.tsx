import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { useCan } from "../../api/permissions";
import { RunScenarioButton } from "../RunScenarioButton";

// F3(§3.3): PREVIEW 의 "테스트 실행" CTA — 화면 이동 없이 RunScenarioButton onStarted 로 홈 안에서
// TESTING(TestProgress)으로 전환한다(E4 배선 재사용). RunScenarioButton 은 ScenarioItem(latest_version_id)
// 이 필요해 목록에서 조회한다(생성 성공 시 ["scenarios"] invalidate 로 곧 동기화 — GenerationHistory 와 캐시 공유).
export function GenerationTestAction({
  scenarioId,
  onStarted,
}: {
  readonly scenarioId: string;
  readonly onStarted: (runId: string) => void;
}): JSX.Element | null {
  const api = useApiClient();
  const can = useCan();
  const scenarios = useQuery({
    queryKey: ["scenarios"],
    queryFn: () => api.listScenarios({ limit: 50 }),
    refetchInterval: 10_000,
  });
  // run.create 미보유 시 CTA 자체를 내지 않는다(워크벤치 RunScenarioButton 게이팅과 동형 — 백엔드가 최종 강제).
  if (!can("run.create")) return null;
  const item = (scenarios.data?.items ?? []).find((scenario) => scenario.scenario_id === scenarioId);
  if (item === undefined) {
    // 조용한 부재 금지 — 목록 동기화 전에는 사유를 문장으로 표기한다.
    return (
      <span className="subtle" role="status">
        테스트 실행 준비 중 — 자동화 목록을 동기화하고 있습니다.
      </span>
    );
  }
  return <RunScenarioButton scenario={item} runMode="test" onStarted={onStarted} />;
}
