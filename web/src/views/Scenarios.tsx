import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import type { ScenarioItem } from "../api/types";

// 시나리오 목록 + prod 승격(If-Match=현재 version, 충돌→SCENARIO_VERSION_CONFLICT 표면화).
// 시나리오 편집/저장/validate는 IR 본문이 필요해 후속(에디터) 슬라이스.
export function ScenariosView(): JSX.Element {
  const api = useApiClient();
  const query = useQuery({ queryKey: ["scenarios"], queryFn: () => api.listScenarios({ limit: 50 }), refetchInterval: 10_000 });
  return (
    <QueryPanel<ScenarioItem>
      title="시나리오"
      query={query}
      rowKey={(r) => r.scenario_id}
      emptyMessage="저장된 시나리오가 없습니다."
      columns={[
        { header: "이름", render: (r) => r.name },
        { header: "버전", render: (r) => `v${r.version}` },
        { header: "최신 버전 ID", render: (r) => <code>{r.latest_version_id.slice(0, 8)}</code> },
        {
          header: "작업",
          render: (r) => (
            <ActionButton
              label="prod 승격"
              confirmText={`${r.name} v${r.version}을(를) prod로 승격할까요? (정적검증 V1–V11 통과 필요)`}
              run={(key) => api.promoteScenario(r.scenario_id, r.version, key)}
              invalidateKeys={[["scenarios"]]}
            />
          ),
        },
      ]}
    />
  );
}
