import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { FileVideo, Image, Play } from "lucide-react";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import type { CreatedSite } from "./SiteCreateForm";
import { StatusBadge } from "./badges";
import { navigate } from "../router";
import {
  type Paginated,
  type ScenarioGenerationPlanner,
  type ScenarioGenerationRequest,
  type ScenarioGenerationResult,
  type SiteItem,
} from "../api/types";
import { AdvancedSettings } from "./prompt-generator/AdvancedSettings";
import { GenerationHistory } from "./prompt-generator/GenerationHistory";
import { GenerationResult } from "./prompt-generator/GenerationResult";
import { GenerationTestAction } from "./prompt-generator/GenerationTestAction";
import { GeneratorFormFields } from "./prompt-generator/GeneratorFormFields";
import { GeneratorFormShell } from "./prompt-generator/GeneratorFormShell";
import { useGenerationActions } from "./prompt-generator/useGenerationActions";
import { usePrefill } from "./prompt-generator/usePrefill";
import { TestProgress } from "./easy-create/TestProgress";
import { useEasyGeneration, type EasyGenerationPhase } from "./easy-create/useEasyGeneration";
import {
  createdSiteToItem,
  screenshotPolicyLabel,
  videoPolicyLabel,
  type ScreenshotPolicy,
  type VideoPolicy,
} from "./prompt-generator/helpers";
import { useEvidencePolicySync } from "./prompt-generator/useEvidencePolicySync";

export function PromptScenarioGenerator({
  defaultMode = "save_and_run",
  onPhaseChange,
}: {
  readonly defaultMode?: ScenarioGenerationRequest["mode"];
  // F3: 원패스 phase 를 호스트(만들기 홈)에 통지 — 홈이 phase 매트릭스(§3.3)로 섹션 노출을 게이팅한다.
  readonly onPhaseChange?: (phase: EasyGenerationPhase) => void;
} = {}): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const qc = useQueryClient();
  const sites = useQuery({ queryKey: ["sites", "scenario-generator"], queryFn: () => api.listSites({ limit: 100 }) });
  const policies = useQuery({
    queryKey: ["gateway-policies", "scenario-generator"],
    queryFn: () => api.listGatewayPolicies(),
    retry: false,
  });
  const capabilities = useQuery({
    queryKey: ["scenario-generation-capabilities"],
    queryFn: () => api.getScenarioGenerationCapabilities(),
    retry: false,
  });
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<ScenarioGenerationRequest["mode"]>(defaultMode);
  // E1: create가 기본 랜딩이 되며 mode 딥링크(#create?mode=…)가 이미 마운트된 생성기에 도달한다 —
  // 초기값 고정이면 딥링크가 무시되므로 defaultMode 변경을 동기화한다(입력 중 초안은 보존, 리마운트 없음).
  useEffect(() => {
    setMode(defaultMode);
  }, [defaultMode]);
  const [startUrl, setStartUrl] = useState("");
  const [siteProfileId, setSiteProfileId] = useState("");
  const [browserIdentityId, setBrowserIdentityId] = useState("");
  const [networkPolicyId, setNetworkPolicyId] = useState("");
  const [model, setModel] = useState("");
  const [modelRequired, setModelRequired] = useState<{ available: number } | null>(null);
  const [checkedModel, setCheckedModel] = useState("");
  const [paramsText, setParamsText] = useState("");
  const [planner, setPlanner] = useState<ScenarioGenerationPlanner>("deterministic_mvp");
  const [screenshot, setScreenshot] = useState<ScreenshotPolicy>("each_step");
  const [screenshotTouched, setScreenshotTouched] = useState(false);
  const [video, setVideo] = useState<VideoPolicy>("never");
  const [videoTouched, setVideoTouched] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [result, setResultState] = useState<ScenarioGenerationResult | null>(null);
  // F3: 홈 안 테스트 실행 추적(TESTING). 해시 미보존 — 새로고침 시 IDLE 복귀 수용(YAGNI, 레지스터 기록).
  const [testRunId, setTestRunId] = useState<string | null>(null);
  // F3: PREVIEW/TESTING 의 입력 폼 접힘("요청 고치기") 상태 — 새 결과가 오면 접는다.
  const [formOpen, setFormOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [siteCreateOpenSignal, setSiteCreateOpenSignal] = useState(0);
  // 고급 설정(<details>) 펼침 상태 — 모델 지정 필요·params 보정 시 자동으로 펼쳐 묻힘(무음 no-op) 방지.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [developerOpen, setDeveloperOpen] = useState(false);
  const [paramsJsonOpen, setParamsJsonOpen] = useState(false);

  // F3: 결과 교체/초기화 시 테스트 추적·폼 접힘을 함께 리셋 — 이전 실행 진행이 새 초안에 붙는 오표시 방지.
  function setResult(next: ScenarioGenerationResult | null): void {
    setResultState(next);
    setTestRunId(null);
    setFormOpen(false);
  }
  const startUrlInputRef = useRef<HTMLInputElement | null>(null);
  const siteSelectRef = useRef<HTMLSelectElement | null>(null);
  const paramsInputRef = useRef<HTMLTextAreaElement | null>(null);
  const siteCreateRef = useRef<HTMLDivElement | null>(null);
  const autoStartUrlRef = useRef<string | null>(null);
  const targetManuallyEditedRef = useRef(false);
  const canCreateSite = can("site.create");

  const actionLabel = mode === "save_and_run" ? "저장 후 실행" : mode === "save" ? "자동화 초안 만들기" : "초안 생성";
  const evidenceSettingsLoading = capabilities.isLoading;
  const {
    screenshotPolicies,
    screenshotRecordingEnabled,
    screenshotLoaded,
    videoPolicies,
    videoRecordingEnabled,
    availablePlanners,
  } = useEvidencePolicySync({
    capabilities: capabilities.data,
    screenshot,
    screenshotTouched,
    setScreenshot,
    video,
    videoTouched,
    setVideo,
    planner,
    setPlanner,
  });
  const policyCheck = useQuery({
    queryKey: ["scenario-generator-model-check", checkedModel],
    queryFn: () => api.getGatewayPolicy(checkedModel),
    enabled: modelRequired !== null && checkedModel.length > 0,
    retry: false,
  });
  const modelConfirmed = checkedModel.length > 0 && checkedModel === model.trim() && policyCheck.isSuccess;
  const needModel = modelRequired !== null && !modelConfirmed;

  const selectedSite = useMemo(
    () => (sites.data?.items ?? []).find((s) => s.site_profile_id === siteProfileId) ?? null,
    [sites.data?.items, siteProfileId],
  );
  const gatewayPolicies = policies.data?.items ?? [];
  const defaultGatewayPolicy = gatewayPolicies.find((policy) => policy.is_default === true) ?? null;

  function applySiteDefaults(site: SiteItem): void {
    setBrowserIdentityId(site.default_browser_identity_id ?? "");
    setNetworkPolicyId(site.default_network_policy_id ?? "");
  }

  function markTargetManuallyEdited(): void {
    targetManuallyEditedRef.current = true;
  }

  // 접힌 폼(<details>)이 펼쳐진 다음 프레임에 포커스/스크롤 — 닫힌 요소에 대한 무음 no-op 방지.
  function afterFormOpen(reveal: () => void): void {
    setFormOpen(true);
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(reveal);
      return;
    }
    window.setTimeout(reveal, 0);
  }

  function focusField(element: HTMLElement | null): void {
    afterFormOpen(() => {
      element?.focus();
      element?.scrollIntoView?.({ block: "center" });
    });
  }

  function openDeveloperThen(focus: () => void): void {
    setAdvancedOpen(true);
    setDeveloperOpen(true);
    afterFormOpen(focus);
  }

  function openInlineSiteCreate(): void {
    setSiteCreateOpenSignal((value) => value + 1);
    afterFormOpen(() => siteCreateRef.current?.scrollIntoView?.({ block: "center" }));
  }

  function openSiteSecurity(siteId?: string): void {
    if (siteId === undefined) {
      navigate("security", { section: "sites" });
      return;
    }
    navigate("security", { section: "sites", site: siteId });
  }

  function handleStartUrlChange(nextStartUrl: string): void {
    if (nextStartUrl !== autoStartUrlRef.current) {
      autoStartUrlRef.current = null;
    }
    setStartUrl(nextStartUrl);
  }

  function handleSiteProfileIdChange(nextSiteProfileId: string): void {
    markTargetManuallyEdited();
    setSiteProfileId(nextSiteProfileId);
  }

  function handleBrowserIdentityIdChange(nextBrowserIdentityId: string): void {
    markTargetManuallyEdited();
    setBrowserIdentityId(nextBrowserIdentityId);
  }

  function handleNetworkPolicyIdChange(nextNetworkPolicyId: string): void {
    markTargetManuallyEdited();
    setNetworkPolicyId(nextNetworkPolicyId);
  }

  function handleModelChange(nextModel: string): void {
    setModel(nextModel);
    if (nextModel.trim() !== checkedModel) setCheckedModel("");
  }

  function selectSite(nextSiteId: string): void {
    markTargetManuallyEdited();
    setSiteProfileId(nextSiteId);
    if (nextSiteId.length === 0) {
      setBrowserIdentityId("");
      setNetworkPolicyId("");
      return;
    }
    const site = (sites.data?.items ?? []).find((s) => s.site_profile_id === nextSiteId);
    if (site !== undefined) applySiteDefaults(site);
    if (startUrl.trim().length === 0 && site?.url_pattern !== undefined) {
      setStartUrl(site.url_pattern);
    }
  }

  function handleInlineSiteCreated(created: CreatedSite): void {
    markTargetManuallyEdited();
    const site = createdSiteToItem(created);
    qc.setQueryData<Paginated<SiteItem> | undefined>(["sites", "scenario-generator"], (current) => {
      const items = current?.items ?? [];
      const nextItems = items.some((item) => item.site_profile_id === site.site_profile_id)
        ? items.map((item) => (item.site_profile_id === site.site_profile_id ? { ...item, ...site } : item))
        : [site, ...items];
      return { items: nextItems, next_cursor: current?.next_cursor ?? null };
    });
    // 낙관적 항목의 "확인 중" 사실값을 서버 진본으로 교체 — 무효화로 곧 재조회.
    void qc.invalidateQueries({ queryKey: ["sites", "scenario-generator"] });
    setSiteProfileId(site.site_profile_id);
    setBrowserIdentityId(site.default_browser_identity_id ?? "");
    setNetworkPolicyId(site.default_network_policy_id ?? "");
    if (startUrl.trim().length === 0 && site.url_pattern !== undefined) {
      setStartUrl(site.url_pattern);
    }
  }

  usePrefill({
    prompt,
    startUrl,
    siteItems: sites.data?.items,
    autoStartUrlRef,
    targetManuallyEditedRef,
    setPrompt,
    setName,
    setParamsText,
    setAdvancedOpen,
    setDeveloperOpen,
    setMode,
    setLocalError,
    setResult,
    setStartUrl,
    setSiteProfileId,
    setBrowserIdentityId,
    setNetworkPolicyId,
    applySiteDefaults,
  });

  const actions = useGenerationActions({
    prompt,
    name,
    mode,
    planner,
    model,
    startUrl,
    paramsText,
    siteProfileId,
    browserIdentityId,
    networkPolicyId,
    screenshot,
    video,
    selectedSite,
    siteItems: sites.data?.items,
    canCreateSite,
    needModel,
    evidenceSettingsLoading,
    autoStartUrlRef,
    targetManuallyEditedRef,
    setResult,
    setLocalError,
    setModelRequired,
    setCheckedModel,
    setModel,
    setScreenshot,
    setScreenshotTouched,
    setVideo,
    setVideoTouched,
    setParamsText,
    setStartUrl,
    setSiteProfileId,
    setBrowserIdentityId,
    setNetworkPolicyId,
  });

  const correctionGuide = result === null ? null : actions.currentCorrectionGuide(result);

  // F3: 원패스 phase(§3.2) — 파생 계산만, 전이 로직은 기존 actions 가 소유.
  const phase = useEasyGeneration({ generating: actions.generatePending, result, testRunId });
  useEffect(() => {
    onPhaseChange?.(phase);
  }, [onPhaseChange, phase]);
  // 모델 지정 요구가 접힌 폼 뒤에 묻히지 않게 자동 펼침(조용한 무반응 금지).
  useEffect(() => {
    if (modelRequired !== null) setFormOpen(true);
  }, [modelRequired]);

  const requestLine = prompt.trim().split("\n")[0]?.slice(0, 80) ?? "";
  const requestSummary = requestLine.length > 0 ? requestLine : "요청 내용 보호됨";

  const formBlock = (
    <>
      <GeneratorFormFields
          prompt={prompt}
          onPromptChange={setPrompt}
          startUrl={startUrl}
          onStartUrlChange={handleStartUrlChange}
          startUrlInputRef={startUrlInputRef}
          siteSelectRef={siteSelectRef}
          siteItems={sites.data?.items}
          siteProfileId={siteProfileId}
          onSelectSite={selectSite}
          model={model}
          onModelChange={handleModelChange}
          gatewayPolicies={gatewayPolicies}
          defaultGatewayPolicy={defaultGatewayPolicy}
          modelRequired={modelRequired}
          modelConfirmed={modelConfirmed}
          checkedModel={checkedModel}
          onConfirmModel={() => setCheckedModel(model.trim())}
          policyCheckFetching={policyCheck.isFetching}
          policyCheckError={policyCheck.isError}
          policyCheckModel={policyCheck.data?.model}
          siteCreateRef={siteCreateRef}
          siteCreateOpenSignal={siteCreateOpenSignal}
          onSiteCreated={handleInlineSiteCreated}
          selectedSite={selectedSite}
          canCreateSite={canCreateSite}
          onOpenSiteCreate={openInlineSiteCreate}
          onOpenSiteSecurity={openSiteSecurity}
        />
        <AdvancedSettings
          advancedOpen={advancedOpen}
          onAdvancedToggle={setAdvancedOpen}
          name={name}
          onName={setName}
          mode={mode}
          onMode={setMode}
          planner={planner}
          onPlanner={setPlanner}
          availablePlanners={availablePlanners}
          screenshot={screenshot}
          onScreenshot={(next) => { setScreenshotTouched(true); setScreenshot(next); }}
          screenshotPolicies={screenshotPolicies}
          screenshotLoaded={screenshotLoaded}
          screenshotRecordingEnabled={screenshotRecordingEnabled}
          video={video}
          onVideo={(next) => { setVideoTouched(true); setVideo(next); }}
          videoPolicies={videoPolicies}
          videoRecordingEnabled={videoRecordingEnabled}
          developerOpen={developerOpen}
          onDeveloperToggle={setDeveloperOpen}
          selectedSite={selectedSite}
          siteProfileId={siteProfileId}
          browserIdentityId={browserIdentityId}
          networkPolicyId={networkPolicyId}
          onSiteProfileId={handleSiteProfileIdChange}
          onBrowserIdentityId={handleBrowserIdentityIdChange}
          onNetworkPolicyId={handleNetworkPolicyIdChange}
          paramsText={paramsText}
          onParamsText={setParamsText}
          paramsJsonOpen={paramsJsonOpen}
          onParamsJsonToggle={setParamsJsonOpen}
          paramsInputRef={paramsInputRef}
        />
        {selectedSite !== null && (
          <div className="inline-facts" role="status">
            <span className="subtle">위험도</span>
            <StatusBadge status={selectedSite.risk} />
            <span className="subtle">승인</span>
            <StatusBadge status={selectedSite.approval_status} />
            <span className="subtle">자동 차단</span>
            <StatusBadge status={selectedSite.circuit_status} kind="circuit" />
          </div>
        )}
        <div className="generator-actions">
          <button
            className="btn primary"
            type="button"
            aria-label={actionLabel}
            title={actionLabel}
            onClick={actions.submit}
            disabled={actions.generatePending || needModel || evidenceSettingsLoading}
          >
            <Play size={15} aria-hidden="true" />
            {actions.generatePending ? "생성 중…" : evidenceSettingsLoading ? "증거 설정 확인 중…" : actionLabel}
          </button>
          <span className="evidence-chip">
            <Image size={14} aria-hidden="true" />
            {screenshotPolicyLabel(screenshot)}
          </span>
          <span className="evidence-chip">
            <FileVideo size={14} aria-hidden="true" />
            {videoPolicyLabel(video)}
          </span>
        </div>
    </>
  );

  // F3 phase 매트릭스(§3.3): GENERATING=폼 잠금+진행 표시(나머지 숨김), PREVIEW=접힌 요약+결과가 주인공,
  // TESTING=결과 유지+TestProgress 홈 내 렌더(화면 이동 없음). 오류는 접힘 밖에 상시 표기(묻힘 금지).
  return (
    <section className="panel scenario-generator">
      <div className="panel-head">
        <h2>말로 설명해 만들기</h2>
      </div>
      <div className="scenario-generator-body">
        <GeneratorFormShell phase={phase} requestSummary={requestSummary} formOpen={formOpen} onFormOpenChange={setFormOpen}>
          {formBlock}
        </GeneratorFormShell>
        {localError !== null && (
          <div className="form-alert red" role="alert">
            {localError}
          </div>
        )}
        {phase !== "GENERATING" && result !== null && (
          <GenerationResult
            result={result}
            correctionGuide={correctionGuide}
            runPending={actions.runPending}
            modelConfirmationRequired={needModel}
            onRunWithCorrections={actions.runWithCorrections}
            onRevised={actions.selectGeneration}
            onFocusStartUrl={() => focusField(startUrlInputRef.current)}
            onFocusTarget={() => focusField(siteSelectRef.current)}
            onOpenSiteCreate={openInlineSiteCreate}
            onFocusParams={() => {
              setParamsJsonOpen(true);
              openDeveloperThen(() => focusField(paramsInputRef.current));
            }}
            onDisableVideoEvidence={() => {
              setVideoTouched(true);
              setVideo("never");
            }}
            testAction={
              result.scenario_id === null ? undefined : (
                <GenerationTestAction scenarioId={result.scenario_id} onStarted={setTestRunId} />
              )
            }
          />
        )}
        {phase === "TESTING" && result !== null && testRunId !== null && (
          <TestProgress runId={testRunId} ir={result.draft_ir} />
        )}
        {phase !== "GENERATING" && (
          <details
            className="developer-details generation-history-details"
            open={historyOpen}
            onToggle={(event) => setHistoryOpen((event.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>최근 생성 이력·다음 액션 보기</summary>
            <GenerationHistory
              selectedGenerationId={result?.generation_id ?? null}
              onSelect={actions.selectGeneration}
            />
          </details>
        )}
      </div>
    </section>
  );
}
