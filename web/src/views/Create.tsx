import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ClipboardCheck, FileText, PlaySquare, Sparkles } from "lucide-react";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { useListView } from "../api/useListView";
import type { ScenarioGenerationRequest, ScenarioItem } from "../api/types";
import { BrowserRecorderPanel } from "../components/BrowserRecorderPanel";
import { PromptScenarioGenerator } from "../components/PromptScenarioGenerator";
import type { EasyGenerationPhase } from "../components/easy-create/useEasyGeneration";
import { navigate, useHashParam } from "../router";
import { ScenarioTestWorkbench } from "./Playground";
import { ReviewStrip } from "./create/ReviewStrip";
import { TemplateGallery } from "./create/TemplateGallery";
import { AutomationStartChooser } from "./scenarios/AutomationStartChooser";
import { ScenarioSetupCorridor, queryState } from "./scenarios/ScenarioSetupCorridor";

export function CreateView(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const recorderRef = useRef<HTMLDivElement | null>(null);
  const testWorkbenchRef = useRef<HTMLDivElement | null>(null);
  const aiCreatorFocusConsumedRef = useRef(false);
  const focusParam = useHashParam("focus");
  const creatorParam = useHashParam("creator");
  const templateParam = useHashParam("template_id");
  const promptParam = useHashParam("prompt");
  const startParam = useHashParam("start");
  const modeParam = useHashParam("mode");
  const generationMode: ScenarioGenerationRequest["mode"] =
    modeParam === "save_and_run" || modeParam === "save" || modeParam === "draft_only" ? modeParam : "save";
  // F3(§3.2·§3.3): 원패스 phase — 생성기가 통지하고, 홈은 phase 매트릭스로 섹션 노출을 게이팅한다.
  // GENERATING/PREVIEW/TESTING 에서는 초안 흐름만 남긴다(세로 밀도 해소 — 패널 직렬 렌더 제거).
  const [phase, setPhase] = useState<EasyGenerationPhase>("IDLE");
  const idle = phase === "IDLE";
  // 접힘은 기존 <details> 관례(AdvancedSettings 동형). focus=test 딥링크는 워크벤치를 자동 펼침(무음 no-op 금지).
  const [workbenchOpen, setWorkbenchOpen] = useState(focusParam === "test");
  const [recorderOpen, setRecorderOpen] = useState(false);

  const scenarioList = useListView<ScenarioItem>(
    ["scenarios"],
    (params) => api.listScenarios(params),
    { limit: 50, refetchInterval: 10_000 },
  );
  const sitesQuery = useQuery({
    queryKey: ["create-console", "setup-sites"],
    queryFn: () => api.listSites({ limit: 50 }),
    staleTime: 15_000,
  });
  const recentRunsQuery = useQuery({
    queryKey: ["create-console", "setup-runs"],
    queryFn: () => api.listRuns({ limit: 50 }),
    staleTime: 15_000,
  });

  const sites = sitesQuery.data?.items ?? [];
  const scenarios = scenarioList.query.data?.items ?? [];
  const recentRuns = recentRunsQuery.data?.items ?? [];
  const latestScenario = scenarios[0];
  const latestCompletedRun = useMemo(
    () => recentRuns.find((run) => run.status === "completed") ?? null,
    [recentRuns],
  );
  const firstLoginSiteNeedingSession = useMemo(
    () => sites.find((site) => site.approval_status === "approved" && site.login_capable === true && site.session_ready !== true) ?? null,
    [sites],
  );
  const showStartChooser = creatorParam === null && templateParam === null && promptParam === null;

  useEffect(() => {
    if (focusParam !== "test") return;
    setWorkbenchOpen(true);
    testWorkbenchRef.current?.scrollIntoView?.({ block: "start" });
  }, [focusParam]);

  useEffect(() => {
    if (creatorParam !== "ai") {
      aiCreatorFocusConsumedRef.current = false;
      return;
    }
    if (aiCreatorFocusConsumedRef.current || !can("scenario.create")) return;
    aiCreatorFocusConsumedRef.current = true;
    const handle = window.setTimeout(focusNaturalLanguageInput, 0);
    return () => window.clearTimeout(handle);
  }, [can, creatorParam]);

  useEffect(() => {
    if (startParam !== "template") return;
    const handle = window.setTimeout(() => {
      document.getElementById("create-template-start")?.scrollIntoView?.({ block: "center" });
    }, 0);
    return () => window.clearTimeout(handle);
  }, [startParam]);

  function focusNaturalLanguageInput(): void {
    const target = document.getElementById("scenario-natural-language-request");
    target?.focus();
    target?.scrollIntoView?.({ block: "center" });
  }

  function focusRecorder(): void {
    // 시작 방식에서 "녹화"를 고르면 접힌 녹화 패널을 펼치고 이동한다(§3.3 매트릭스).
    setRecorderOpen(true);
    recorderRef.current?.scrollIntoView?.({ block: "start" });
  }

  return (
    <div className="create-console">
      {/* E1: 확인 필요 스트립 — 내게 확인할 일이 있을 때만 홈 최상단에(만들기 홈이 기본 랜딩이 되면서 myWork 진입점 흡수). */}
      {idle && <ReviewStrip />}
      {idle && <CreateJourneyHeader />}
      {can("scenario.create") ? (
        <>
          {idle && showStartChooser && (
            <AutomationStartChooser
              onBrowserText={focusNaturalLanguageInput}
              onBrowserRecord={focusRecorder}
              onTemplate={() => document.getElementById("create-template-start")?.scrollIntoView?.({ block: "center" })} // E6: 홈 갤러리로(카탈로그는 admin 표준)
              onDocument={() => navigate("documentIdp", { source: "create-console" })}
              onConnector={() => navigate("connectorCatalog", { focus: "connectors" })}
              onManual={() => navigate("scenarioStudio", { expert: "manual" })}
            />
          )}
          {idle && !showStartChooser && (
            <section className="panel scenario-create-strip" aria-label="선택한 자동화 출발점">
              <div>
                <h2>선택한 출발점 이어가기</h2>
                <p className="subtle">가져온 요청을 말로 확인하고, 준비 상태를 본 뒤 초안을 만듭니다.</p>
              </div>
              <span className="scenario-create-actions">
                <button className="btn primary" type="button" onClick={focusNaturalLanguageInput}>
                  요청 확인
                </button>
                <button className="btn" type="button" onClick={() => navigate("create")}>
                  다른 출발점 고르기
                </button>
              </span>
            </section>
          )}
          <PromptScenarioGenerator defaultMode={generationMode} onPhaseChange={setPhase} />
        </>
      ) : (
        <section className="panel create-readonly-panel" aria-label="만들기 콘솔 읽기 전용 안내">
          <h2>만들기 권한이 필요합니다</h2>
          <p className="subtle">현재 역할에서는 초안을 만들 수 없지만, 준비 상태와 테스트/증빙 경로는 확인할 수 있습니다.</p>
        </section>
      )}

      {/* E6: 업무 사용자의 템플릿 경로 — 커넥터 카탈로그(관리 콘솔)가 유일 경로였던 것을 홈에 제공. */}
      {idle && <TemplateGallery canCreateScenario={can("scenario.create")} />}
      {idle && (
        <ScenarioSetupCorridor
          collapsible
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
          onOpenTest={(scenarioId) => navigate("create", scenarioId === undefined ? { focus: "test" } : { scenario: scenarioId, focus: "test" })}
        />
      )}

      {/* F3: 기존 자동화 테스트/녹화는 접힌 details 로 — focus=test 딥링크는 phase 와 무관하게 워크벤치를 보장(계약 유지). */}
      {(idle || focusParam === "test") && (
        <div ref={testWorkbenchRef}>
          <details
            className="panel collapse-panel"
            open={workbenchOpen}
            onToggle={(event) => setWorkbenchOpen((event.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>
              기존 자동화 테스트
              <span className="subtle">저장된 자동화의 실행 계획 확인과 테스트 실행</span>
            </summary>
            <div className="collapse-panel-body">
              <ScenarioTestWorkbench embedded createRoute="create" />
            </div>
          </details>
        </div>
      )}

      {idle && can("scenario.create") && (
        <div ref={recorderRef}>
          <details
            className="panel collapse-panel"
            open={recorderOpen}
            onToggle={(event) => setRecorderOpen((event.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>
              브라우저 녹화로 만들기
              <span className="subtle">화면을 따라 하며 클릭·입력 순서를 녹화해 초안을 만듭니다</span>
            </summary>
            <div className="collapse-panel-body">
              <BrowserRecorderPanel />
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

function CreateJourneyHeader(): JSX.Element {
  const steps = [
    { label: "말로 설명", detail: "업무를 자연어로 적기", icon: Sparkles },
    { label: "준비 확인", detail: "사이트·세션·보안 상태", icon: ClipboardCheck },
    { label: "초안 생성", detail: "검증된 자동화 초안 저장", icon: FileText },
    { label: "테스트", detail: "계획 확인 후 시험 실행", icon: PlaySquare },
  ] as const;
  return (
    <section className="panel create-journey" aria-label="만들기 기본 경로">
      <div className="create-journey-copy">
        <p className="eyebrow">만들기 콘솔</p>
        <h2>말로 시작해서 테스트까지 한 흐름으로 이어갑니다</h2>
        <p className="subtle">전문가 설정은 자동화 스튜디오에 남겨 두고, 여기서는 첫 자동화의 기본 경로만 집중합니다.</p>
      </div>
      <ol className="create-journey-steps">
        {steps.map((step, index) => {
          const Icon = step.icon;
          return (
            <li key={step.label}>
              <span className="create-journey-icon">
                <Icon size={16} aria-hidden="true" />
              </span>
              <span>
                <strong>{step.label}</strong>
                <small>{step.detail}</small>
              </span>
              {index < steps.length - 1 && <ArrowRight size={14} aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
