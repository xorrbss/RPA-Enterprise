import { useRef, useState } from "react";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { useListView } from "../api/useListView";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import { BrowserRecorderPanel } from "../components/BrowserRecorderPanel";
import { PromptScenarioGenerator } from "../components/PromptScenarioGenerator";
import { RunScenarioButton } from "../components/RunScenarioButton";
import { ScenarioForm, type ScenarioFormMode } from "../components/ScenarioForm";
import { navigate } from "../router";
import { PromotionInbox } from "./scenarios/PromotionInbox";
import { ScenarioReleasesPanel } from "./scenarios/ScenarioReleasesPanel";
import { ScenarioVersionsPanel } from "./scenarios/ScenarioVersionsPanel";
import type { ScenarioItem } from "../api/types";

// 자동화 만들기(시나리오 스튜디오): 작성/편집 폼 + 목록 + 운영 기준 지정.
// 생성=POST /v1/scenarios, 편집=PUT(If-Match), 운영 지정=POST /promote(If-Match=현재 version). 역할 게이팅: scenario.create/update/promote.
// 운영 지정은 실행 전제가 아니라 canonical 표시 + AST 캐시 빌드 역할이므로 실행 버튼보다 보조 액션으로 둔다.
export function ScenariosView(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const scenarioList = useListView<ScenarioItem>(
    ["scenarios"],
    (params) => api.listScenarios(params),
    { limit: 50, refetchInterval: 10_000 },
  );
  const [form, setForm] = useState<ScenarioFormMode | null>(null);
  const [versionsFor, setVersionsFor] = useState<ScenarioItem | null>(null);
  const [releasesFor, setReleasesFor] = useState<ScenarioItem | null>(null);
  const recorderRef = useRef<HTMLDivElement | null>(null);

  function focusNaturalLanguageInput(): void {
    const target = document.getElementById("scenario-natural-language-request");
    target?.focus();
    target?.scrollIntoView?.({ block: "center" });
  }

  function focusRecorder(): void {
    recorderRef.current?.scrollIntoView?.({ block: "start" });
  }

  return (
    <div>
      {can("scenario.create") && (
        <>
          <section className="panel scenario-create-strip" aria-label="자동화 제작 시작">
            <div>
              <h2>자동화 제작 시작</h2>
              <p className="subtle">말로 시작해 초안을 만들고, 필요하면 로컬 브라우저 녹화로 보완합니다.</p>
            </div>
            <span className="scenario-create-actions">
              <button className="btn primary" type="button" onClick={focusNaturalLanguageInput}>
                자동화 초안 만들기
              </button>
              <button className="btn" type="button" onClick={focusRecorder}>
                브라우저 녹화로 만들기
              </button>
            </span>
          </section>
          <PromptScenarioGenerator />
        </>
      )}
      {can("scenario.create") && (
        <div ref={recorderRef}>
          <BrowserRecorderPanel />
        </div>
      )}
      {can("scenario.create") && (
        <ManualScenarioCreateDetails
          disabled={form?.kind === "create"}
          onCreate={() => setForm({ kind: "create" })}
        />
      )}
      {can("scenario.promote.approve") && <PromotionInbox />}
      {form !== null && <ScenarioForm mode={form} onClose={() => setForm(null)} />}
      <QueryPanel<ScenarioItem>
        title="자동화 목록"
        query={scenarioList.query}
        pager={scenarioList.pager}
        rowKey={(r) => r.scenario_id}
        emptyTitle="첫 실행 전"
        emptyMessage="저장된 자동화가 없습니다. 문장으로 초안을 만든 뒤 테스트 실행까지 이어가세요."
        emptyAction={
          can("scenario.create") ? (
            <button className="btn primary" type="button" onClick={focusNaturalLanguageInput}>
              자동화 초안 만들기
            </button>
          ) : undefined
        }
        columns={[
          { header: "이름", render: (r) => <ScenarioNameCell scenario={r} /> },
          { header: "버전", render: (r) => `v${r.version}` },
          {
            header: "운영 기준",
            render: (r) => (
              <span className={`badge ${r.promotion_status === "prod" ? "green" : "muted"}`}>
                {r.promotion_status === "prod" ? "운영 기준" : "초안"}
              </span>
            ),
          },
          { header: "실행 기준", render: (r) => <span className="badge muted">v{r.version} 준비됨</span> },
          {
            header: "주요 작업",
            render: (r) => (
              <div style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
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
                <details className="developer-details" style={{ display: "inline-block", minWidth: 120 }}>
                  <summary>관리 작업</summary>
                  <div style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
                    <button className="btn" type="button" onClick={() => setVersionsFor(r)}>
                      이력
                    </button>
                    <button className="btn" type="button" onClick={() => setReleasesFor(r)}>
                      배포
                    </button>
                    <ActionButton
                      label={r.promotion_status === "prod" ? "운영 기준 해제" : "운영 기준 지정"}
                      action="scenario.promote"
                      title="운영 기준 지정은 실행 필수 단계가 아니라 운영 표준 버전을 표시하는 보조 작업입니다."
                      confirmText={
                        r.promotion_status === "prod"
                          ? `${r.name} v${r.version}을(를) 운영 기준에서 내릴까요? 실행 이력은 보존됩니다.`
                          : `${r.name} v${r.version}을(를) 운영 기준으로 지정할까요? 실행에 꼭 필요한 단계는 아니며, 자동화 검사 통과와 사이트 승인·세션 준비는 별도로 확인됩니다.`
                      }
                      run={(key) => api.setScenarioPromotion(r.scenario_id, r.version, r.promotion_status === "prod" ? "draft" : "prod", key)}
                      invalidateKeys={[["scenarios"]]}
                      successText={null}
                    />
                    {r.promotion_status !== "prod" && !can("scenario.promote") && (
                      <ActionButton
                        label="운영 기준 승인 요청"
                        action="scenario.update"
                        inputLabel="요청 사유"
                        title="운영 기준 지정을 승인자에게 요청합니다. 요청자와 다른 승인자가 승인해야 적용됩니다."
                        confirmText={`${r.name} v${r.version}을(를) 운영 기준으로 승인 요청할까요? 승인자 검토 후 적용됩니다.`}
                        run={(key, reason) => api.createPromotionRequest(r.scenario_id, r.version, reason ?? "", key)}
                        invalidateKeys={[["promotion-requests"]]}
                        successText="요청됨"
                      />
                    )}
                    <ActionButton
                      label="보관"
                      action="scenario.update"
                      confirmText={`${r.name}을(를) 보관할까요? 목록과 실행 생성 동선에서 제외됩니다.`}
                      run={(key) => api.archiveScenario(r.scenario_id, r.version, key)}
                      invalidateKeys={[["scenarios"]]}
                    />
                  </div>
                </details>
              </div>
            ),
          },
        ]}
      />
      {versionsFor !== null && <ScenarioVersionsPanel scenario={versionsFor} onClose={() => setVersionsFor(null)} />}
      {releasesFor !== null && <ScenarioReleasesPanel scenario={releasesFor} onClose={() => setReleasesFor(null)} />}
    </div>
  );
}

function ManualScenarioCreateDetails(props: { disabled: boolean; onCreate: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="developer-details"
      open={open}
      style={{ marginBottom: 12 }}
    >
      <summary
        onClick={(event) => {
          event.preventDefault();
          setOpen((current) => !current);
        }}
      >
        양식으로 직접 만들기
      </summary>
      {open && (
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          <p className="subtle" style={{ margin: 0 }}>
            문장으로 초안을 만들 수 없는 예외 상황에서만 직접 입력 양식을 엽니다.
          </p>
          <button className="btn" type="button" onClick={props.onCreate} disabled={props.disabled} style={{ justifySelf: "start" }}>
            + 새 자동화 만들기
          </button>
        </div>
      )}
    </details>
  );
}

function ScenarioNameCell(props: { scenario: ScenarioItem }): JSX.Element {
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <strong>{props.scenario.name}</strong>
      <details className="developer-details" style={{ marginTop: 0 }}>
        <summary>식별값 보기</summary>
        <code className="subtle">{props.scenario.scenario_id}</code>
      </details>
    </div>
  );
}
