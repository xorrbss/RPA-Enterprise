import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import { ScenarioForm, type ScenarioFormMode } from "../components/ScenarioForm";
import type { ScenarioItem } from "../api/types";

// 자동화 만들기(시나리오 스튜디오): 작성/편집 폼 + 목록 + prod 승격.
// 생성=POST /v1/scenarios, 편집=PUT(If-Match), 승격=POST /promote(If-Match=현재 version).
export function ScenariosView(): JSX.Element {
  const api = useApiClient();
  const query = useQuery({ queryKey: ["scenarios"], queryFn: () => api.listScenarios({ limit: 50 }), refetchInterval: 10_000 });
  const [form, setForm] = useState<ScenarioFormMode | null>(null);

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <button className="btn" type="button" onClick={() => setForm({ kind: "create" })} disabled={form?.kind === "create"}>
          + 새 자동화 만들기
        </button>
      </div>
      {form !== null && <ScenarioForm mode={form} onClose={() => setForm(null)} />}
      <QueryPanel<ScenarioItem>
        title="시나리오"
        query={query}
        rowKey={(r) => r.scenario_id}
        emptyMessage="저장된 시나리오가 없습니다. ‘새 자동화 만들기’로 시작하세요."
        columns={[
          { header: "이름", render: (r) => r.name },
          { header: "버전", render: (r) => `v${r.version}` },
          { header: "최신 버전 ID", render: (r) => <code>{r.latest_version_id.slice(0, 8)}</code> },
          {
            header: "작업",
            render: (r) => (
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <button
                  className="btn"
                  type="button"
                  onClick={() => setForm({ kind: "edit", scenarioId: r.scenario_id, name: r.name, version: r.version })}
                >
                  편집
                </button>
                <ActionButton
                  label="prod 승격"
                  confirmText={`${r.name} v${r.version}을(를) prod로 승격할까요? (정적검증 V1–V11 통과 필요)`}
                  run={(key) => api.promoteScenario(r.scenario_id, r.version, key)}
                  invalidateKeys={[["scenarios"]]}
                />
              </span>
            ),
          },
        ]}
      />
    </div>
  );
}
