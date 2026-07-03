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
import { GeneratorFormFields } from "./prompt-generator/GeneratorFormFields";
import { useGenerationActions } from "./prompt-generator/useGenerationActions";
import { usePrefill } from "./prompt-generator/usePrefill";
import {
  DEFAULT_AVAILABLE_PLANNERS,
  FALLBACK_SCREENSHOT_POLICIES,
  FALLBACK_VIDEO_POLICIES,
  createdSiteToItem,
  firstAllowedPolicy,
  screenshotPolicyLabel,
  videoPolicyLabel,
  type ScreenshotPolicy,
  type VideoPolicy,
} from "./prompt-generator/helpers";

export function PromptScenarioGenerator(): JSX.Element {
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
  const [mode, setMode] = useState<ScenarioGenerationRequest["mode"]>("save_and_run");
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
  const [result, setResult] = useState<ScenarioGenerationResult | null>(null);
  const [siteCreateOpenSignal, setSiteCreateOpenSignal] = useState(0);
  // 고급 설정(<details>) 펼침 상태 — 모델 지정 필요·params 보정 시 자동으로 펼쳐 묻힘(무음 no-op) 방지.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [developerOpen, setDeveloperOpen] = useState(false);
  const [paramsJsonOpen, setParamsJsonOpen] = useState(false);
  const startUrlInputRef = useRef<HTMLInputElement | null>(null);
  const siteSelectRef = useRef<HTMLSelectElement | null>(null);
  const paramsInputRef = useRef<HTMLTextAreaElement | null>(null);
  const siteCreateRef = useRef<HTMLDivElement | null>(null);
  const autoStartUrlRef = useRef<string | null>(null);
  const targetManuallyEditedRef = useRef(false);
  const canCreateSite = can("site.create");

  const actionLabel = mode === "save_and_run" ? "저장 후 실행" : mode === "save" ? "저장" : "초안 생성";
  const evidenceSettingsLoading = capabilities.isLoading;
  const screenshotCapability = capabilities.data?.visual_evidence.screenshot;
  const screenshotRecordingEnabled = screenshotCapability?.enabled === true;
  const screenshotPolicies = useMemo<readonly ScreenshotPolicy[]>(
    () => (screenshotCapability?.policies.length ? screenshotCapability.policies : FALLBACK_SCREENSHOT_POLICIES),
    [screenshotCapability?.policies],
  );
  const screenshotDefaultPolicy = screenshotCapability?.default_policy ?? (screenshotRecordingEnabled ? "each_step" : "never");
  const videoCapability = capabilities.data?.visual_evidence.video;
  const videoRecordingEnabled = videoCapability?.enabled === true;
  const videoPolicies = useMemo<readonly VideoPolicy[]>(
    () => (videoCapability?.policies.length ? videoCapability.policies : FALLBACK_VIDEO_POLICIES),
    [videoCapability?.policies],
  );
  const videoDefaultPolicy = videoCapability?.default_policy ?? (videoRecordingEnabled ? "always" : "never");
  const plannerCapability = capabilities.data?.planner;
  const availablePlanners = plannerCapability?.available ?? DEFAULT_AVAILABLE_PLANNERS;
  const defaultPlanner = plannerCapability?.default_planner ?? "deterministic_mvp";
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

  function focusField(element: HTMLElement | null): void {
    element?.focus();
    element?.scrollIntoView?.({ block: "center" });
  }

  function openDeveloperThen(focus: () => void): void {
    setAdvancedOpen(true);
    setDeveloperOpen(true);
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(focus);
      return;
    }
    window.setTimeout(focus, 0);
  }

  function openInlineSiteCreate(): void {
    setSiteCreateOpenSignal((value) => value + 1);
    const reveal = () => siteCreateRef.current?.scrollIntoView?.({ block: "center" });
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(reveal);
      return;
    }
    window.setTimeout(reveal, 0);
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

  useEffect(() => {
    if (screenshotCapability === undefined) return;
    if (!screenshotCapability.enabled) {
      const next = firstAllowedPolicy(screenshotPolicies, "never", "never");
      if (screenshot !== next) setScreenshot(next);
      return;
    }
    if (!screenshotPolicies.includes(screenshot)) {
      setScreenshot(firstAllowedPolicy(screenshotPolicies, screenshotDefaultPolicy, "never"));
      return;
    }
    if (!screenshotTouched && screenshot !== screenshotDefaultPolicy && screenshotPolicies.includes(screenshotDefaultPolicy)) {
      setScreenshot(screenshotDefaultPolicy);
    }
  }, [screenshot, screenshotCapability, screenshotDefaultPolicy, screenshotPolicies, screenshotTouched]);

  useEffect(() => {
    if (videoCapability === undefined) return;
    if (!videoCapability.enabled) {
      const next = firstAllowedPolicy(videoPolicies, "never", "never");
      if (video !== next) setVideo(next);
      return;
    }
    if (!videoPolicies.includes(video)) {
      setVideo(firstAllowedPolicy(videoPolicies, videoDefaultPolicy, "never"));
      return;
    }
    if (!videoTouched && video === "never" && videoPolicies.includes(videoDefaultPolicy)) {
      setVideo(videoDefaultPolicy);
    }
  }, [video, videoCapability, videoDefaultPolicy, videoPolicies, videoTouched]);

  useEffect(() => {
    if (!availablePlanners.includes(planner)) {
      setPlanner(defaultPlanner);
    }
  }, [availablePlanners, defaultPlanner, planner]);

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

  return (
    <section className="panel scenario-generator">
      <div className="panel-head">
        <h2>말로 설명해 만들기</h2>
      </div>
      <div className="scenario-generator-body">
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
          screenshotLoaded={screenshotCapability !== undefined}
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
            {actions.generatePending ? "생성 중…" : evidenceSettingsLoading ? "증거 설정 확인 중…" : "자동화 초안 만들기"}
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
        {localError !== null && (
          <div className="form-alert red" role="alert">
            {localError}
          </div>
        )}
        {result !== null && (
          <GenerationResult
            result={result}
            correctionGuide={correctionGuide}
            runPending={actions.runPending}
            modelConfirmationRequired={needModel}
            onRunWithCorrections={actions.runWithCorrections}
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
          />
        )}
        <GenerationHistory
          selectedGenerationId={result?.generation_id ?? null}
          onSelect={actions.selectGeneration}
        />
      </div>
    </section>
  );
}
