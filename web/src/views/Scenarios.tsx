import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { useListView } from "../api/useListView";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import { BrowserRecorderPanel } from "../components/BrowserRecorderPanel";
import { PromptScenarioGenerator } from "../components/PromptScenarioGenerator";
import { RunScenarioButton } from "../components/RunScenarioButton";
import { ScenarioForm, type ScenarioFormMode } from "../components/ScenarioForm";
import { navigate, useHashParam } from "../router";
import { ScenarioTestWorkbench } from "./Playground";
import { AutomationStartChooser } from "./scenarios/AutomationStartChooser";
import { FocusedScenarioStudio } from "./scenarios/FocusedScenarioStudio";
import { PromotionInbox } from "./scenarios/PromotionInbox";
import { ScenarioReleasesPanel } from "./scenarios/ScenarioReleasesPanel";
import { ScenarioSetupCorridor, queryState } from "./scenarios/ScenarioSetupCorridor";
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
  const testWorkbenchRef = useRef<HTMLDivElement | null>(null);
  const focusParam = useHashParam("focus");
  const modeParam = useHashParam("mode");
  const selectedScenarioParam = useHashParam("scenario");
  const creatorParam = useHashParam("creator");
  const templateParam = useHashParam("template_id");
  const promptParam = useHashParam("prompt");
  const sitesQuery = useQuery({
    queryKey: ["scenario-studio", "setup-sites"],
    queryFn: () => api.listSites({ limit: 50 }),
    staleTime: 15_000,
  });
  const recentRunsQuery = useQuery({
    queryKey: ["scenario-studio", "setup-runs"],
    queryFn: () => api.listRuns({ limit: 50 }),
    staleTime: 15_000,
  });
  const sites = sitesQuery.data?.items ?? [];
  const scenarios = scenarioList.query.data?.items ?? [];
  const recentRuns = recentRunsQuery.data?.items ?? [];
  const latestScenario = scenarios[0];
  const selectedScenario = useMemo(
    () => selectedScenarioParam === null ? null : scenarios.find((scenario) => scenario.scenario_id === selectedScenarioParam) ?? null,
    [scenarios, selectedScenarioParam],
  );
  const selectedScenarioRun = useMemo(
    () =>
      selectedScenario === null
        ? null
        : recentRuns.find((run) => run.scenario_id === selectedScenario.scenario_id) ?? null,
    [recentRuns, selectedScenario],
  );
  const selectedScenarioRuns = useMemo(
    () =>
      selectedScenario === null
        ? []
        : recentRuns.filter((run) => run.scenario_id === selectedScenario.scenario_id).slice(0, 5),
    [recentRuns, selectedScenario],
  );
  const latestCompletedRun = useMemo(
    () => recentRuns.find((run) => run.status === "completed") ?? null,
    [recentRuns],
  );
  const inFocusMode = modeParam === "focus";
  const showStartChooser = creatorParam === null && templateParam === null && promptParam === null;
  const firstLoginSiteNeedingSession = useMemo(
    () => sites.find((site) => site.approval_status === "approved" && site.login_capable === true && site.session_ready !== true) ?? null,
    [sites],
  );

  useEffect(() => {
    if (focusParam === "test") testWorkbenchRef.current?.scrollIntoView?.({ block: "start" });
  }, [focusParam]);

  function focusNaturalLanguageInput(): void {
    const target = document.getElementById("scenario-natural-language-request");
    target?.focus();
    target?.scrollIntoView?.({ block: "center" });
  }

  function focusRecorder(): void {
    recorderRef.current?.scrollIntoView?.({ block: "start" });
  }

  function openTestWorkbench(scenarioId: string): void {
    navigate("scenarioStudio", { scenario: scenarioId, focus: "test" });
    window.setTimeout(() => testWorkbenchRef.current?.scrollIntoView?.({ block: "start" }), 0);
  }

  function openFocusedStudio(scenarioId: string): void {
    navigate("scenarioStudio", { mode: "focus", scenario: scenarioId });
  }

  return (
    <div>
      {can("scenario.create") && !inFocusMode && (
        <>
          {showStartChooser ? (
            <AutomationStartChooser
              onBrowserText={focusNaturalLanguageInput}
              onBrowserRecord={focusRecorder}
              onTemplate={() => navigate("connectorCatalog", { focus: "templates" })}
              onDocument={() => navigate("documentIdp", { source: "scenario-start" })}
              onConnector={() => navigate("connectorCatalog", { focus: "connectors" })}
              onManual={() => setForm({ kind: "create" })}
            />
          ) : (
            <section className="panel scenario-create-strip" aria-label="선택한 자동화 출발점">
              <div>
                <h2>선택한 출발점 이어가기</h2>
                <p className="subtle">카탈로그에서 가져온 요청을 확인하고, 필요한 값만 채운 뒤 초안을 만듭니다.</p>
              </div>
              <span className="scenario-create-actions">
                <button className="btn primary" type="button" onClick={focusNaturalLanguageInput}>
                  요청 확인
                </button>
                <button className="btn" type="button" onClick={() => navigate("scenarioStudio")}>
                  다른 출발점 고르기
                </button>
              </span>
            </section>
          )}
          <ScenarioSetupCorridor
            sites={sites}
            siteState={queryState(sitesQuery)}
            scenarios={scenarios}
            scenarioState={queryState(scenarioList.query)}
            recentRuns={recentRuns}
            runState={queryState(recentRunsQuery)}
            latestScenario={latestScenario}
            latestCompletedRun={latestCompletedRun}
            firstLoginSiteNeedingSession={firstLoginSiteNeedingSession}
            canCreateSite={can("site.create")}
            canUpdateSite={can("site.update")}
            canCaptureSession={can("session.capture")}
            canCreateScenario={can("scenario.create")}
            canCreateRun={can("run.create")}
            canReadEvidence={can("artifact.read")}
            onCreateDraft={focusNaturalLanguageInput}
          />
          <PromptScenarioGenerator />
          <div ref={testWorkbenchRef}>
            <ScenarioTestWorkbench embedded />
          </div>
        </>
      )}
      {can("scenario.create") && inFocusMode && (
        <ScenarioSetupCorridor
          sites={sites}
          siteState={queryState(sitesQuery)}
          scenarios={scenarios}
          scenarioState={queryState(scenarioList.query)}
          recentRuns={recentRuns}
          runState={queryState(recentRunsQuery)}
          latestScenario={latestScenario}
          latestCompletedRun={latestCompletedRun}
          firstLoginSiteNeedingSession={firstLoginSiteNeedingSession}
          canCreateSite={can("site.create")}
          canUpdateSite={can("site.update")}
          canCaptureSession={can("session.capture")}
          canCreateScenario={can("scenario.create")}
          canCreateRun={can("run.create")}
          canReadEvidence={can("artifact.read")}
          onCreateDraft={focusNaturalLanguageInput}
        />
      )}
      {inFocusMode && (
        <FocusedScenarioStudio
          scenario={selectedScenario}
          requestedScenarioId={selectedScenarioParam}
          latestRun={selectedScenarioRun}
          recentRuns={selectedScenarioRuns}
          loading={scenarioList.query.isLoading}
          canCreateRun={can("run.create")}
          canReadEvidence={can("artifact.read")}
          canUpdateScenario={can("scenario.update")}
          onTest={(scenarioId) => navigate("scenarioStudio", { mode: "focus", scenario: scenarioId, focus: "test" })}
          onEvidence={(runId) => navigate("runTrace", { run: runId, focus: "artifacts" })}
          onEdit={(scenario) => setForm({ kind: "edit", scenarioId: scenario.scenario_id, name: scenario.name, version: scenario.version })}
          onVersions={(scenario) => setVersionsFor(scenario)}
          onReleases={(scenario) => setReleasesFor(scenario)}
          onExit={() => navigate("scenarioStudio")}
        />
      )}
      {can("scenario.create") && inFocusMode && (
        <div ref={testWorkbenchRef}>
          <ScenarioTestWorkbench embedded />
        </div>
      )}
      {!can("scenario.create") && (
        <>
          <ScenarioSetupCorridor
            sites={sites}
            siteState={queryState(sitesQuery)}
            scenarios={scenarios}
            scenarioState={queryState(scenarioList.query)}
            recentRuns={recentRuns}
            runState={queryState(recentRunsQuery)}
            latestScenario={latestScenario}
            latestCompletedRun={latestCompletedRun}
            firstLoginSiteNeedingSession={firstLoginSiteNeedingSession}
            canCreateSite={can("site.create")}
            canUpdateSite={can("site.update")}
            canCaptureSession={can("session.capture")}
            canCreateScenario={can("scenario.create")}
            canCreateRun={can("run.create")}
            canReadEvidence={can("artifact.read")}
            onCreateDraft={focusNaturalLanguageInput}
          />
          <div ref={testWorkbenchRef}>
            <ScenarioTestWorkbench embedded />
          </div>
        </>
      )}
      {can("scenario.create") && !inFocusMode && (
        <div ref={recorderRef}>
          <BrowserRecorderPanel />
        </div>
      )}
      {can("scenario.create") && !inFocusMode && (
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
          { header: "실행 기준", render: (r) => <span className="badge blue">테스트 가능 · v{r.version}</span> },
          {
            header: "테스트 동선",
            render: (r) => (
              <div className="scenario-test-actions">
                <button className="btn" type="button" onClick={() => openFocusedStudio(r.scenario_id)}>
                  집중 작업
                </button>
                <button className="btn" type="button" onClick={() => openTestWorkbench(r.scenario_id)}>
                  계획·테스트
                </button>
                <span className="scenario-direct-run">
                  <span className="badge blue">테스트</span>
                  <RunScenarioButton scenario={r} runMode="test" />
                </span>
                {can("scenario.update") && (
                  <button
                    className="btn"
                    type="button"
                    onClick={() => setForm({ kind: "edit", scenarioId: r.scenario_id, name: r.name, version: r.version })}
                  >
                    편집
                  </button>
                )}
                <details className="developer-details scenario-management-menu">
                  <summary>관리 작업</summary>
                  <div className="scenario-management-actions">
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
