import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import { ScenarioForm, type ScenarioFormMode } from "../components/ScenarioForm";
import type { ScenarioItem } from "../api/types";

// 자동화 만들기(시나리오 스튜디오): 작성/편집 폼 + 목록 + prod 승격.
// 생성=POST /v1/scenarios, 편집=PUT(If-Match), 승격=POST /promote(If-Match=현재 version). 역할 게이팅: scenario.create/update/promote.
export function ScenariosView(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const query = useQuery({ queryKey: ["scenarios"], queryFn: () => api.listScenarios({ limit: 50 }), refetchInterval: 10_000 });
  const [form, setForm] = useState<ScenarioFormMode | null>(null);

  return (
    <div>
      {can("scenario.create") && (
        <div style={{ marginBottom: 12 }}>
          <button className="btn" type="button" onClick={() => setForm({ kind: "create" })} disabled={form?.kind === "create"}>
            + 새 자동화 만들기
          </button>
        </div>
      )}
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
                {can("scenario.update") && (
                  <button
                    className="btn"
                    type="button"
                    onClick={() => setForm({ kind: "edit", scenarioId: r.scenario_id, name: r.name, version: r.version })}
                  >
                    편집
                  </button>
                )}
                <ActionButton
                  label="prod 승격"
                  action="scenario.promote"
                  confirmText={`${r.name} v${r.version}을(를) prod로 승격할까요? (정적검증 V1–V11 통과 필요)`}
                  run={(key) => api.promoteScenario(r.scenario_id, r.version, key)}
                  invalidateKeys={[["scenarios"]]}
                />
                <ActionButton
                  label="실행"
                  action="run.create"
                  confirmText={`${r.name} 최신 버전(v${r.version})으로 실행을 시작할까요? 새 실행이 대기열(queued)에 등록됩니다. 진행은 워커 연결 시 시작됩니다(미연결 시 queued 대기). ‘실행 기록’에서 확인하세요.`}
                  // TODO(후속): params:{} 는 파라미터 시나리오(navigate.url_ref 가 params 키)엔 부족 —
                  //   url_ref 가 params 에 없으면 런타임이 URL_REF_PARAM_MISSING 으로 loud 실패한다(조용한 실패 아님).
                  //   params 입력 폼(params_schema 기반)을 추가하면 콘솔에서 파라미터 시나리오 실행 가능. dev 데모는 serve.ts 가 queued run 을 params 와 함께 시드.
                  run={(key) => api.createRun({ scenario_version_id: r.latest_version_id, params: {} }, key)}
                  invalidateKeys={[["runs"]]}
                />
              </span>
            ),
          },
        ]}
      />
    </div>
  );
}
