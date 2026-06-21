import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import { PromptScenarioGenerator } from "../components/PromptScenarioGenerator";
import { RunScenarioButton } from "../components/RunScenarioButton";
import { ScenarioForm, type ScenarioFormMode } from "../components/ScenarioForm";
import { navigate } from "../router";
import type { ScenarioItem, ScenarioVersionItem } from "../api/types";

// 자동화 만들기(시나리오 스튜디오): 작성/편집 폼 + 목록 + 운영 기준 지정.
// 생성=POST /v1/scenarios, 편집=PUT(If-Match), 운영 지정=POST /promote(If-Match=현재 version). 역할 게이팅: scenario.create/update/promote.
// 운영 지정은 실행 전제가 아니라 canonical 표시 + AST 캐시 빌드 역할이므로 실행 버튼보다 보조 액션으로 둔다.
export function ScenariosView(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const query = useQuery({ queryKey: ["scenarios"], queryFn: () => api.listScenarios({ limit: 50 }), refetchInterval: 10_000 });
  const [form, setForm] = useState<ScenarioFormMode | null>(null);
  const [versionsFor, setVersionsFor] = useState<ScenarioItem | null>(null);

  return (
    <div>
      {can("scenario.create") && <PromptScenarioGenerator />}
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
        emptyAction={
          can("scenario.create") ? (
            <button className="btn primary" type="button" onClick={() => setForm({ kind: "create" })} disabled={form?.kind === "create"}>
              + 첫 자동화 만들기
            </button>
          ) : undefined
        }
        columns={[
          { header: "이름", render: (r) => r.name },
          { header: "버전", render: (r) => `v${r.version}` },
          {
            header: "운영",
            render: (r) => (
              <span className={`badge ${r.promotion_status === "prod" ? "green" : "muted"}`}>
                {r.promotion_status === "prod" ? "운영 기준" : "초안"}
              </span>
            ),
          },
          { header: "최신 버전 ID", render: (r) => <code>{r.latest_version_id.slice(0, 8)}</code> },
          {
            header: "작업",
            render: (r) => (
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <RunScenarioButton scenario={r} />
                <button className="btn" type="button" onClick={() => navigate("playground", { scenario: r.scenario_id })}>
                  미리보기
                </button>
                {can("scenario.update") && (
                  <button
                    className="btn"
                    type="button"
                    onClick={() => setForm({ kind: "edit", scenarioId: r.scenario_id, name: r.name, version: r.version })}
                  >
                    편집
                  </button>
                )}
                <button className="btn" type="button" onClick={() => setVersionsFor(r)}>
                  이력
                </button>
                <ActionButton
                  label={r.promotion_status === "prod" ? "운영 해제" : "운영 지정"}
                  action="scenario.promote"
                  title="운영 지정은 실행에 꼭 필요한 단계가 아니라 운영 기준 표시를 위한 보조 작업입니다."
                  confirmText={
                    r.promotion_status === "prod"
                      ? `${r.name} v${r.version}을(를) 운영 기준에서 내릴까요? 실행 이력은 보존됩니다.`
                      : `${r.name} v${r.version}을(를) 운영 기준으로 지정할까요? 실행에 꼭 필요한 단계는 아니며, 운영 기준 표시를 위한 보조 작업입니다. 시나리오 검사를 통과하고 사이트 승인·세션이 준비되어야 실제로 실행됩니다.`
                  }
                  run={(key) => api.setScenarioPromotion(r.scenario_id, r.version, r.promotion_status === "prod" ? "draft" : "prod", key)}
                  invalidateKeys={[["scenarios"]]}
                  successText={null}
                />
                <ActionButton
                  label="보관"
                  action="scenario.update"
                  confirmText={`${r.name}을(를) 보관할까요? 목록과 실행 생성 동선에서 제외됩니다.`}
                  run={(key) => api.archiveScenario(r.scenario_id, r.version, key)}
                  invalidateKeys={[["scenarios"]]}
                />
              </span>
            ),
          },
        ]}
      />
      {versionsFor !== null && <ScenarioVersionsPanel scenario={versionsFor} onClose={() => setVersionsFor(null)} />}
    </div>
  );
}

function ScenarioVersionsPanel(props: { scenario: ScenarioItem; onClose: () => void }): JSX.Element {
  const api = useApiClient();
  const query = useQuery({
    queryKey: ["scenario-versions", props.scenario.scenario_id],
    queryFn: () => api.listScenarioVersions(props.scenario.scenario_id),
  });

  return (
    <section style={{ marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{props.scenario.name} 버전 이력</h2>
        <button className="btn" type="button" onClick={props.onClose}>닫기</button>
      </div>
      <QueryPanel<ScenarioVersionItem>
        title="버전"
        query={query}
        rowKey={(r) => r.version_id}
        emptyMessage="저장된 버전이 없습니다."
        columns={[
          { header: "버전", render: (r) => `v${r.version}` },
          {
            header: "상태",
            render: (r) => (
              <span className={`badge ${r.promotion_status === "prod" ? "green" : "muted"}`}>
                {r.promotion_status === "prod" ? "운영 기준" : "초안"}
              </span>
            ),
          },
          { header: "작성", render: (r) => new Date(r.created_at).toLocaleString() },
          { header: "승격", render: (r) => (r.promoted_at !== null ? new Date(r.promoted_at).toLocaleString() : "-") },
          {
            header: "작업",
            render: (r) => (
              <ActionButton
                label="이 버전으로 롤백"
                action="scenario.update"
                disabled={r.version === props.scenario.version}
                confirmText={`${props.scenario.name} v${r.version}을(를) 복제해 새 draft v${props.scenario.version + 1}을 만들까요?`}
                run={(key) => api.rollbackScenario(props.scenario.scenario_id, r.version, props.scenario.version, key)}
                invalidateKeys={[["scenarios"], ["scenario-versions", props.scenario.scenario_id]]}
              />
            ),
          },
        ]}
      />
    </section>
  );
}
