import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  ClipboardCheck,
  FileCheck2,
  FileSearch,
  Globe,
  ListChecks,
  MousePointerClick,
  PencilRuler,
  PlaySquare,
  Plug,
  ScrollText,
  Settings,
  X,
  type LucideIcon,
} from "lucide-react";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { useListView } from "../api/useListView";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import { BrowserRecorderPanel } from "../components/BrowserRecorderPanel";
import { PromptScenarioGenerator } from "../components/PromptScenarioGenerator";
import { RunScenarioButton } from "../components/RunScenarioButton";
import { ScenarioForm, type ScenarioFormMode } from "../components/ScenarioForm";
import { RunModeBadge, StatusBadge } from "../components/badges";
import { navigate, useHashParam } from "../router";
import { formatDateTime } from "../util/time";
import { ScenarioTestWorkbench } from "./Playground";
import { PromotionInbox } from "./scenarios/PromotionInbox";
import { ScenarioReleasesPanel } from "./scenarios/ScenarioReleasesPanel";
import { ScenarioVersionsPanel } from "./scenarios/ScenarioVersionsPanel";
import type { RunItem, ScenarioItem, SiteItem } from "../api/types";

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

type CorridorQueryState = "checking" | "error" | "ready";
type CorridorStatus = "ready" | "needs" | "blocked" | "checking";

function AutomationStartChooser({
  onBrowserText,
  onBrowserRecord,
  onTemplate,
  onDocument,
  onConnector,
  onManual,
}: {
  onBrowserText: () => void;
  onBrowserRecord: () => void;
  onTemplate: () => void;
  onDocument: () => void;
  onConnector: () => void;
  onManual: () => void;
}): JSX.Element {
  return (
    <section className="panel automation-start-chooser" aria-label="자동화 시작 방식">
      <div className="automation-start-head">
        <div>
          <h2>어떤 자동화로 시작할까요?</h2>
          <p className="subtle">업무 유형을 먼저 고르면 필요한 준비 단계와 제작 화면으로 바로 이어집니다.</p>
        </div>
        <button className="btn" type="button" onClick={onBrowserRecord}>
          <MousePointerClick size={14} aria-hidden="true" />
          브라우저 녹화로 만들기
        </button>
      </div>
      <div className="automation-start-grid">
        <AutomationStartCard
          icon={Globe}
          title="브라우저 업무 자동화"
          description="웹 포털 조회, 입력, 다운로드처럼 화면을 보며 처리하는 반복 업무를 말로 시작합니다."
          badge="추천"
          primary
          actionLabel="말로 시작"
          actionAriaLabel="브라우저 업무 자동화"
          onAction={onBrowserText}
        />
        <AutomationStartCard
          icon={ListChecks}
          title="템플릿에서 시작"
          description="검토된 업무 템플릿을 골라 실행 입력값과 시작 주소를 미리 채웁니다."
          actionLabel="템플릿 보기"
          actionAriaLabel="템플릿에서 시작"
          onAction={onTemplate}
        />
        <AutomationStartCard
          icon={FileSearch}
          title="문서/IDP 자동화"
          description="문서 추출, 검증 큐, 증빙 연결이 중심인 업무는 문서 자동화에서 시작합니다."
          actionLabel="문서 자동화 열기"
          actionAriaLabel="문서/IDP 자동화"
          onAction={onDocument}
        />
        <AutomationStartCard
          icon={Plug}
          title="API/커넥터 자동화"
          description="브라우저보다 재사용 커넥터나 외부 연동 후보가 먼저인 업무를 확인합니다."
          actionLabel="커넥터 보기"
          actionAriaLabel="API/커넥터 자동화"
          onAction={onConnector}
        />
        <AutomationStartCard
          icon={PencilRuler}
          title="직접 설계"
          description="자연어 초안이 맞지 않는 예외 상황에서만 이름과 정의를 직접 입력합니다."
          actionLabel="양식 열기"
          actionAriaLabel="직접 설계"
          onAction={onManual}
        />
        <AutomationStartCard
          icon={Bot}
          title="AI Agent/MCP 자동화"
          description="Agent와 MCP 기반 자동화는 제품 계약과 보안 경계가 정해진 뒤 활성화합니다."
          badge="결정 필요"
          disabled
        />
      </div>
    </section>
  );
}

function AutomationStartCard({
  icon: Icon,
  title,
  description,
  badge,
  actionLabel,
  actionAriaLabel,
  onAction,
  primary = false,
  disabled = false,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  badge?: string;
  actionLabel?: string;
  actionAriaLabel?: string;
  onAction?: () => void;
  primary?: boolean;
  disabled?: boolean;
}): JSX.Element {
  return (
    <article className={`automation-start-card${primary ? " primary" : ""}${disabled ? " disabled" : ""}`} aria-disabled={disabled || undefined}>
      <span className="automation-start-icon">
        <Icon size={18} aria-hidden="true" />
      </span>
      <div className="automation-start-copy">
        <span className="automation-start-title-row">
          <h3>{title}</h3>
          {badge !== undefined && <span className={`badge ${disabled ? "muted" : "blue"}`}>{badge}</span>}
        </span>
        <p className="subtle">{description}</p>
      </div>
      {disabled ? (
        <span className="automation-start-disabled-note">활성화 대기</span>
      ) : (
        <button className={primary ? "btn primary" : "btn"} type="button" onClick={onAction} aria-label={actionAriaLabel}>
          {actionLabel}
        </button>
      )}
    </article>
  );
}

interface CorridorAction {
  readonly label: string;
  readonly run: () => void;
  readonly primary?: boolean;
}

interface CorridorStep {
  readonly key: string;
  readonly label: string;
  readonly status: CorridorStatus;
  readonly detail: string;
  readonly action?: CorridorAction;
}

function queryState(query: { readonly isLoading: boolean; readonly isError: boolean; readonly data?: unknown }): CorridorQueryState {
  if (query.isError) return "error";
  if (query.isLoading || query.data === undefined) return "checking";
  return "ready";
}

function corridorStatusLabel(status: CorridorStatus): string {
  switch (status) {
    case "ready":
      return "준비됨";
    case "needs":
      return "확인 필요";
    case "blocked":
      return "차단";
    case "checking":
      return "확인 중";
  }
}

function corridorTone(status: CorridorStatus): "green" | "amber" | "red" | "blue" {
  switch (status) {
    case "ready":
      return "green";
    case "blocked":
      return "red";
    case "checking":
      return "blue";
    case "needs":
      return "amber";
  }
}

function siteStep(
  state: CorridorQueryState,
  sites: readonly SiteItem[],
  canCreateSite: boolean,
  canUpdateSite: boolean,
): CorridorStep {
  if (state === "checking") {
    return { key: "site", label: "사이트", status: "checking", detail: "등록된 실행 대상 사이트를 확인하고 있습니다." };
  }
  if (state === "error") {
    return {
      key: "site",
      label: "사이트",
      status: "needs",
      detail: "사이트 목록을 불러오지 못했습니다. 설정 화면에서 상태를 다시 확인하세요.",
      action: canCreateSite || canUpdateSite ? { label: "사이트 설정 확인", run: () => navigate("security", { section: "sites" }) } : undefined,
    };
  }
  const approved = sites.filter((site) => site.approval_status === "approved");
  if (approved.length > 0) {
    return { key: "site", label: "사이트", status: "ready", detail: `${approved.length}개 승인된 실행 대상이 있습니다.` };
  }
  if (sites.length > 0) {
    return {
      key: "site",
      label: "사이트",
      status: "blocked",
      detail: "등록된 사이트가 있지만 아직 승인된 실행 대상은 없습니다.",
      action: canUpdateSite ? { label: "사이트 승인 상태 보기", run: () => navigate("security", { section: "sites" }) } : undefined,
    };
  }
  return {
    key: "site",
    label: "사이트",
    status: "needs",
    detail: "첫 자동화를 실행할 대상 사이트를 먼저 등록하세요.",
    action: canCreateSite ? { label: "사이트 등록", run: () => navigate("security", { section: "sites", intent: "site-create" }), primary: true } : undefined,
  };
}

function sessionStep(
  state: CorridorQueryState,
  sites: readonly SiteItem[],
  firstMissingSession: SiteItem | null,
  canCaptureSession: boolean,
): CorridorStep {
  if (state === "checking") {
    return { key: "session", label: "로그인 세션", status: "checking", detail: "로그인이 필요한 사이트의 세션 상태를 확인하고 있습니다." };
  }
  if (state === "error") {
    return {
      key: "session",
      label: "로그인 세션",
      status: "needs",
      detail: "세션 준비도를 확인하지 못했습니다. 알 수 없는 상태는 준비 완료로 보지 않습니다.",
      action: canCaptureSession ? { label: "세션 설정 확인", run: () => navigate("security", { section: "sites" }) } : undefined,
    };
  }
  const loginSites = sites.filter((site) => site.approval_status === "approved" && site.login_capable === true);
  if (loginSites.length === 0) {
    return {
      key: "session",
      label: "로그인 세션",
      status: "needs",
      detail: "로그인 대상 사이트가 정해지면 세션 등록 여부를 확인합니다.",
    };
  }
  const ready = loginSites.filter((site) => site.session_ready === true);
  if (ready.length > 0) {
    return { key: "session", label: "로그인 세션", status: "ready", detail: `${ready.length}개 로그인 대상의 세션이 준비됐습니다.` };
  }
  return {
    key: "session",
    label: "로그인 세션",
    status: "needs",
    detail: "로그인이 필요한 사이트가 있지만 저장된 세션 증거가 없습니다.",
    action:
      canCaptureSession && firstMissingSession !== null
        ? { label: "세션 등록", run: () => navigate("security", { section: "sites", site: firstMissingSession.site_profile_id }), primary: true }
        : undefined,
  };
}

function draftStep(
  state: CorridorQueryState,
  scenarios: readonly ScenarioItem[],
  canCreateScenario: boolean,
  onCreateDraft: () => void,
): CorridorStep {
  if (state === "checking") {
    return { key: "draft", label: "자동화 초안", status: "checking", detail: "저장된 자동화 초안을 확인하고 있습니다." };
  }
  if (state === "error") {
    return {
      key: "draft",
      label: "자동화 초안",
      status: "needs",
      detail: "초안 목록을 불러오지 못했습니다. 다시 확인하거나 새 초안을 만들 수 있습니다.",
      action: canCreateScenario ? { label: "초안 만들기", run: onCreateDraft } : undefined,
    };
  }
  if (scenarios.length > 0) {
    return { key: "draft", label: "자동화 초안", status: "ready", detail: `${scenarios.length}개 초안 또는 자동화가 있습니다.` };
  }
  return {
    key: "draft",
    label: "자동화 초안",
    status: "needs",
    detail: "말로 업무를 설명해 첫 초안을 만들 수 있습니다.",
    action: canCreateScenario ? { label: "초안 만들기", run: onCreateDraft, primary: true } : undefined,
  };
}

function testStep(
  state: CorridorQueryState,
  runs: readonly RunItem[],
  latestScenario: ScenarioItem | undefined,
  canCreateRun: boolean,
): CorridorStep {
  if (state === "checking") {
    return { key: "test", label: "테스트 실행", status: "checking", detail: "최근 테스트 실행 이력을 확인하고 있습니다." };
  }
  if (state === "error") {
    return {
      key: "test",
      label: "테스트 실행",
      status: "needs",
      detail: "실행 이력을 불러오지 못했습니다. 테스트 화면에서 직접 확인하세요.",
      action: canCreateRun ? { label: "테스트 화면", run: () => navigate("scenarioStudio", { focus: "test" }) } : undefined,
    };
  }
  const testRuns = runs.filter((run) => run.run_mode === "test");
  if (testRuns.length > 0) {
    return { key: "test", label: "테스트 실행", status: "ready", detail: `${testRuns.length}개 테스트 실행 이력이 있습니다.` };
  }
  return {
    key: "test",
    label: "테스트 실행",
    status: "needs",
    detail: latestScenario === undefined ? "초안을 만든 뒤 계획 확인과 테스트 실행으로 이어갑니다." : "저장된 초안으로 계획을 확인하고 테스트하세요.",
    action:
      canCreateRun && latestScenario !== undefined
        ? { label: "계획 확인으로 이동", run: () => navigate("scenarioStudio", { scenario: latestScenario.scenario_id, focus: "test" }), primary: true }
        : undefined,
  };
}

function evidenceStep(
  state: CorridorQueryState,
  completedRun: RunItem | null,
  canReadEvidence: boolean,
): CorridorStep {
  if (state === "checking") {
    return { key: "evidence", label: "증빙", status: "checking", detail: "완료된 실행과 증빙 확인 경로를 찾고 있습니다." };
  }
  if (state === "error") {
    return {
      key: "evidence",
      label: "증빙",
      status: "needs",
      detail: "증빙 상태를 확인하지 못했습니다. 실행 상세에서 다시 확인하세요.",
      action: canReadEvidence ? { label: "증빙 화면", run: () => navigate("runTrace", { focus: "artifacts" }) } : undefined,
    };
  }
  if (completedRun !== null) {
    return {
      key: "evidence",
      label: "증빙",
      status: "needs",
      detail: "완료된 실행이 있습니다. 증빙 목록은 실행 상세에서 확인해야 합니다.",
      action: canReadEvidence ? { label: "증빙 확인", run: () => navigate("runTrace", { run: completedRun.run_id, focus: "artifacts" }), primary: true } : undefined,
    };
  }
  return { key: "evidence", label: "증빙", status: "needs", detail: "테스트를 완료한 뒤 실행 산출물과 감사 증빙을 확인합니다." };
}

function ScenarioSetupCorridor({
  sites,
  siteState,
  scenarios,
  scenarioState,
  recentRuns,
  runState,
  latestScenario,
  latestCompletedRun,
  firstLoginSiteNeedingSession,
  canCreateSite,
  canUpdateSite,
  canCaptureSession,
  canCreateScenario,
  canCreateRun,
  canReadEvidence,
  onCreateDraft,
}: {
  sites: readonly SiteItem[];
  siteState: CorridorQueryState;
  scenarios: readonly ScenarioItem[];
  scenarioState: CorridorQueryState;
  recentRuns: readonly RunItem[];
  runState: CorridorQueryState;
  latestScenario: ScenarioItem | undefined;
  latestCompletedRun: RunItem | null;
  firstLoginSiteNeedingSession: SiteItem | null;
  canCreateSite: boolean;
  canUpdateSite: boolean;
  canCaptureSession: boolean;
  canCreateScenario: boolean;
  canCreateRun: boolean;
  canReadEvidence: boolean;
  onCreateDraft: () => void;
}): JSX.Element {
  const steps = [
    siteStep(siteState, sites, canCreateSite, canUpdateSite),
    sessionStep(siteState, sites, firstLoginSiteNeedingSession, canCaptureSession),
    draftStep(scenarioState, scenarios, canCreateScenario, onCreateDraft),
    testStep(runState, recentRuns, latestScenario, canCreateRun),
    evidenceStep(runState, latestCompletedRun, canReadEvidence),
  ];
  const firstAction = steps.find((step) => step.status !== "ready" && step.action !== undefined)?.action;
  return (
    <section className="panel setup-corridor" aria-label="자동화 준비 단계">
      <div className="panel-head">
        <div>
          <h2>자동화 준비 단계</h2>
          <p className="subtle">사이트, 세션, 초안, 테스트, 증빙을 현재 확인된 데이터 기준으로 보여줍니다.</p>
        </div>
        {firstAction !== undefined && (
          <button className="btn primary" type="button" onClick={firstAction.run}>
            다음: {firstAction.label}
          </button>
        )}
      </div>
      <ol className="setup-corridor-steps">
        {steps.map((step) => (
          <li key={step.key} className={`setup-corridor-step ${step.status}`}>
            <span className={`badge ${corridorTone(step.status)}`}>{corridorStatusLabel(step.status)}</span>
            <span className="setup-corridor-copy">
              <strong>{step.label}</strong>
              <span className="subtle">{step.detail}</span>
            </span>
            {step.action !== undefined && (
              <button className={step.action.primary === true ? "btn primary" : "btn"} type="button" onClick={step.action.run}>
                {step.action.label}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

type FocusTab = "plan" | "test" | "links" | "activity" | "versions" | "settings";

const FOCUS_TABS: readonly { readonly key: FocusTab; readonly label: string; readonly icon: LucideIcon }[] = [
  { key: "plan", label: "설계", icon: ListChecks },
  { key: "test", label: "테스트", icon: PlaySquare },
  { key: "links", label: "연결", icon: FileCheck2 },
  { key: "activity", label: "활동", icon: ScrollText },
  { key: "versions", label: "버전", icon: ClipboardCheck },
  { key: "settings", label: "설정", icon: Settings },
];

function FocusedScenarioStudio({
  scenario,
  requestedScenarioId,
  latestRun,
  recentRuns,
  loading,
  canCreateRun,
  canReadEvidence,
  canUpdateScenario,
  onTest,
  onEvidence,
  onEdit,
  onVersions,
  onReleases,
  onExit,
}: {
  scenario: ScenarioItem | null;
  requestedScenarioId: string | null;
  latestRun: RunItem | null;
  recentRuns: readonly RunItem[];
  loading: boolean;
  canCreateRun: boolean;
  canReadEvidence: boolean;
  canUpdateScenario: boolean;
  onTest: (scenarioId: string) => void;
  onEvidence: (runId: string) => void;
  onEdit: (scenario: ScenarioItem) => void;
  onVersions: (scenario: ScenarioItem) => void;
  onReleases: (scenario: ScenarioItem) => void;
  onExit: () => void;
}): JSX.Element {
  const [activeTab, setActiveTab] = useState<FocusTab>("plan");

  useEffect(() => {
    setActiveTab("plan");
  }, [scenario?.scenario_id, requestedScenarioId]);

  if (scenario === null) {
    return (
      <section className="panel focused-studio" aria-label="집중 자동화 스튜디오">
        <div className="panel-head">
          <div>
            <h2>{loading ? "자동화 불러오는 중" : "자동화를 찾을 수 없습니다"}</h2>
            <p className="subtle">
              {loading
                ? "선택한 자동화의 최신 목록과 실행 상태를 확인하고 있습니다."
                : requestedScenarioId === null
                  ? "목록에서 자동화를 선택하면 집중 작업 화면을 열 수 있습니다."
                  : "요청한 자동화가 현재 목록에 없습니다. 보관되었거나 권한이 바뀌었는지 확인해 주세요."}
            </p>
          </div>
          <button className="btn" type="button" onClick={onExit}>
            <X size={14} aria-hidden="true" />
            목록으로
          </button>
        </div>
      </section>
    );
  }

  const latestRunTime = formatDateTime(latestRun?.as_of ?? latestRun?.updated_at);
  const hasEvidencePath = latestRun !== null && canReadEvidence;
  const runCompleted = latestRun?.status === "completed";

  return (
    <section className="panel focused-studio" aria-label="집중 자동화 스튜디오">
      <div className="focused-studio-bar">
        <div>
          <p className="eyebrow">집중 자동화 스튜디오</p>
          <h2>{scenario.name}</h2>
          <div className="inline-facts">
            <span className="badge blue">v{scenario.version}</span>
            <span className={`badge ${scenario.promotion_status === "prod" ? "green" : "muted"}`}>
              {scenario.promotion_status === "prod" ? "운영 기준" : "초안"}
            </span>
            {latestRun !== null && <StatusBadge status={latestRun.status} />}
          </div>
        </div>
        <span className="focused-studio-actions">
          <button className="btn primary" type="button" onClick={() => onTest(scenario.scenario_id)} disabled={!canCreateRun}>
            <PlaySquare size={14} aria-hidden="true" />
            테스트
          </button>
          <button className="btn" type="button" onClick={() => latestRun !== null && onEvidence(latestRun.run_id)} disabled={!hasEvidencePath}>
            <ClipboardCheck size={14} aria-hidden="true" />
            증빙
          </button>
          <button className="btn icon-btn" type="button" aria-label="집중 작업 닫기" onClick={onExit}>
            <X size={15} aria-hidden="true" />
          </button>
        </span>
      </div>

      <div className="focused-studio-tabs" role="tablist" aria-label="자동화 작업 탭">
        {FOCUS_TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              className={activeTab === tab.key ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.key}
              onClick={() => setActiveTab(tab.key)}
            >
              <Icon size={14} aria-hidden="true" />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="focused-studio-grid">
        <div className="focused-studio-main" role="tabpanel" aria-label={`${FOCUS_TABS.find((tab) => tab.key === activeTab)?.label ?? "작업"} 내용`}>
          {activeTab === "plan" && (
            <ol className="focus-step-list">
              <li>
                <span className="badge green">준비됨</span>
                <strong>현재 초안 v{scenario.version}</strong>
                <p className="subtle">세부 IR은 기본 화면 뒤에 두고, 이 화면에서는 업무 순서와 다음 행동만 확인합니다.</p>
              </li>
              <li>
                <span className={`badge ${latestRun === null ? "amber" : "green"}`}>{latestRun === null ? "확인 필요" : "기록 있음"}</span>
                <strong>테스트 실행</strong>
                <p className="subtle">
                  {latestRun === null
                    ? "아직 연결된 최근 테스트 실행이 없습니다. 먼저 테스트를 돌려 결과를 남기세요."
                    : `최근 실행은 ${latestRunTime} 기준으로 ${latestRun.status} 상태입니다.`}
                </p>
              </li>
              <li>
                <span className={`badge ${runCompleted ? "green" : "amber"}`}>{runCompleted ? "확인 가능" : "대기"}</span>
                <strong>증빙 확인</strong>
                <p className="subtle">
                  {runCompleted ? "완료된 실행의 산출물과 감사 증빙으로 이어질 수 있습니다." : "성공 실행이 생기면 증빙 확인이 첫 번째 후속 행동입니다."}
                </p>
              </li>
            </ol>
          )}
          {activeTab === "test" && (
            <div className="focused-studio-copy">
              <h3>테스트로 바로 확인</h3>
              <p className="subtle">아래 작업대에서 선택된 자동화를 테스트 모드로 실행하고, 완료되면 실행 기록의 증빙 영역으로 이어집니다.</p>
              <button className="btn primary" type="button" onClick={() => onTest(scenario.scenario_id)} disabled={!canCreateRun}>
                <PlaySquare size={14} aria-hidden="true" />
                테스트 작업대로 이동
              </button>
            </div>
          )}
          {activeTab === "links" && (
            <div className="focused-studio-copy">
              <h3>사이트·세션·보안 연결</h3>
              <p className="subtle">정확한 준비 상태는 위 준비 단계가 기준입니다. 알 수 없는 값은 준비됨으로 표시하지 않습니다.</p>
              <button className="btn" type="button" onClick={() => navigate("security", { section: "sites" })}>
                사이트·세션 확인
              </button>
            </div>
          )}
          {activeTab === "activity" && (
            <div className="focused-studio-copy focused-activity">
              <h3>최근 활동</h3>
              <p className="subtle">상세 감사는 감사 이력이 기준입니다. 이 요약에는 실행 metadata만 표시합니다.</p>
              {recentRuns.length === 0 ? (
                <p className="form-alert amber" role="note">아직 이 자동화에 연결된 최근 실행이 없습니다. 감사 이벤트는 실행 후 확인해야 합니다.</p>
              ) : (
                <ol className="focus-timeline">
                  {recentRuns.map((run) => (
                    <li key={run.run_id}>
                      <span className="focus-timeline-marker" aria-hidden="true" />
                      <div>
                        <strong>{formatDateTime(run.as_of ?? run.updated_at)}</strong>
                        <p className="subtle">실행 상태 metadata · 감사 이벤트 확인 필요</p>
                        <span className="inline-facts">
                          <StatusBadge status={run.status} />
                          {run.run_mode !== undefined && <RunModeBadge runMode={run.run_mode} />}
                        </span>
                      </div>
                      <span className="inline-actions">
                        <button className="btn" type="button" onClick={() => navigate("runTrace", { run: run.run_id, focus: "artifacts" })}>
                          실행 증빙
                        </button>
                        <button className="btn" type="button" onClick={() => navigate("auditExplorer")}>
                          감사 이력
                        </button>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
          {activeTab === "versions" && (
            <div className="focused-studio-copy">
              <h3>버전과 배포</h3>
              <p className="subtle">버전 이력과 배포 판단은 기존 관리 패널을 그대로 사용합니다.</p>
              <span className="inline-actions">
                <button className="btn" type="button" onClick={() => onVersions(scenario)}>
                  버전 이력
                </button>
                <button className="btn" type="button" onClick={() => onReleases(scenario)}>
                  배포 상태
                </button>
              </span>
            </div>
          )}
          {activeTab === "settings" && (
            <div className="focused-studio-copy">
              <h3>자동화 설정</h3>
              <p className="subtle">이름과 정의 수정은 권한이 있을 때만 열립니다. 운영 기준 지정은 관리 작업에서 별도로 승인 흐름을 탑니다.</p>
              <button className="btn" type="button" onClick={() => onEdit(scenario)} disabled={!canUpdateScenario}>
                <Settings size={14} aria-hidden="true" />
                설정 편집
              </button>
            </div>
          )}
        </div>
        <aside className="focused-studio-rail" aria-label="최근 상태 요약">
          <div>
            <strong>최근 실행</strong>
            <p className="subtle">{latestRun === null ? "아직 연결된 최근 실행 없음" : latestRunTime}</p>
            {latestRun !== null && (
              <span className="inline-facts">
                <StatusBadge status={latestRun.status} />
                {latestRun.run_mode !== undefined && <RunModeBadge runMode={latestRun.run_mode} />}
              </span>
            )}
          </div>
          <div>
            <strong>다음 추천</strong>
            <p className="subtle">{runCompleted ? "증빙을 먼저 확인하고 운영 예약으로 이어가세요." : "테스트 실행으로 자동화가 실제로 동작하는지 확인하세요."}</p>
          </div>
        </aside>
      </div>
    </section>
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
