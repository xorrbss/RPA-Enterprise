import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { FileVideo, Image, Play } from "lucide-react";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { SiteCreateForm, type CreatedSite } from "./SiteCreateForm";
import { errorLabel, StatusBadge } from "./badges";
import { navigate, useHashParam } from "../router";
import {
  ApiError,
  type Paginated,
  type ScenarioGenerationPlanner,
  type ScenarioGenerationRequest,
  type ScenarioGenerationRunRequest,
  type ScenarioGenerationResult,
  type SiteItem,
} from "../api/types";
import { AdvancedSettings } from "./prompt-generator/AdvancedSettings";
import { GenerationHistory } from "./prompt-generator/GenerationHistory";
import { GenerationResult } from "./prompt-generator/GenerationResult";
import {
  DEFAULT_AVAILABLE_PLANNERS,
  FALLBACK_SCREENSHOT_POLICIES,
  FALLBACK_VIDEO_POLICIES,
  PROMPT_EXAMPLES,
  START_URL_REPAIR_BLOCKERS,
  TARGET_REPAIR_BLOCKERS,
  canRunGenerationWithCorrections,
  correctionGuideError,
  createdSiteToItem,
  draftStartUrl,
  draftTarget,
  extractFirstHttpUrl,
  firstAllowedPolicy,
  hasAnyBlocker,
  httpOrigin,
  modelRequiredOf,
  paramsInputTextFromDraftIr,
  parseParamsText,
  screenshotPolicyLabel,
  singleMatchingSiteForUrl,
  siteLabel,
  siteNetworkLabel,
  siteSessionLabel,
  videoPolicyLabel,
  type CorrectionGuideState,
  type ScreenshotPolicy,
  type VideoPolicy,
} from "./prompt-generator/helpers";

export function PromptScenarioGenerator(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const qc = useQueryClient();
  const prefillSiteId = useHashParam("site");
  const prefillStartUrl = useHashParam("start_url");
  const prefillBrowserIdentityId = useHashParam("browser_identity");
  const prefillNetworkPolicyId = useHashParam("network_policy");
  const prefillConnectorId = useHashParam("connector_id");
  const prefillTemplateId = useHashParam("template_id");
  const prefillPrompt = useHashParam("prompt");
  const prefillName = useHashParam("name");
  const prefillParams = useHashParam("params");
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
  const hashPrefillKeyRef = useRef<string | null>(null);
  const templatePrefillKeyRef = useRef<string | null>(null);
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

  function currentCorrectionGuide(generation: ScenarioGenerationResult): CorrectionGuideState {
    const targetValues = [siteProfileId.trim(), browserIdentityId.trim(), networkPolicyId.trim()];
    const targetPartial = targetValues.some((value) => value.length > 0) && targetValues.some((value) => value.length === 0);
    const startOrigin = httpOrigin(startUrl);
    const selectedSiteOrigin = selectedSite?.url_pattern === undefined ? null : httpOrigin(selectedSite.url_pattern);
    const needsStartUrl = hasAnyBlocker(generation.blockers, START_URL_REPAIR_BLOCKERS);
    const needsTarget = hasAnyBlocker(generation.blockers, TARGET_REPAIR_BLOCKERS);
    const targetStartUrlMatches =
      !generation.blockers.includes("target_start_url_site_mismatch") ||
      selectedSiteOrigin === null ||
      startOrigin === null ||
      selectedSiteOrigin === startOrigin;
    return {
      needsStartUrl,
      needsTarget,
      needsVideoPolicy: generation.blockers.includes("video_recording_port_not_configured"),
      needsParams: generation.blockers.includes("params_context_redacted_value_required"),
      startUrlReady: startUrl.trim().length > 0,
      targetReady: targetValues.every((value) => value.length > 0),
      targetPartial,
      targetStartUrlMatches,
      videoPolicyReady: video === "never",
      paramsReady: paramsText.trim().length > 0,
      hasSelectableSites: (sites.data?.items ?? []).length > 0,
      canCreateSite,
    };
  }

  useEffect(() => {
    const key = JSON.stringify([prefillConnectorId, prefillTemplateId, prefillPrompt, prefillName, prefillParams]);
    if (templatePrefillKeyRef.current === key) return;
    if (
      prefillConnectorId === null &&
      prefillTemplateId === null &&
      prefillPrompt === null &&
      prefillName === null &&
      prefillParams === null
    ) {
      return;
    }

    templatePrefillKeyRef.current = key;
    if (prefillPrompt !== null) setPrompt(prefillPrompt);
    if (prefillName !== null) setName(prefillName);
    if (prefillParams !== null) {
      setParamsText(prefillParams);
      setAdvancedOpen(true);
      setDeveloperOpen(true);
    }
    if (prefillConnectorId !== null || prefillTemplateId !== null) setMode("save");
    setLocalError(null);
    setResult(null);
  }, [prefillConnectorId, prefillName, prefillParams, prefillPrompt, prefillTemplateId]);

  useEffect(() => {
    const key = JSON.stringify([prefillSiteId, prefillStartUrl, prefillBrowserIdentityId, prefillNetworkPolicyId]);
    if (hashPrefillKeyRef.current === key) return;
    hashPrefillKeyRef.current = key;
    if (
      prefillSiteId === null &&
      prefillStartUrl === null &&
      prefillBrowserIdentityId === null &&
      prefillNetworkPolicyId === null
    ) {
      return;
    }

    targetManuallyEditedRef.current = true;
    if (prefillSiteId !== null) setSiteProfileId(prefillSiteId);
    if (prefillStartUrl !== null) {
      setStartUrl(prefillStartUrl);
      autoStartUrlRef.current = prefillStartUrl;
    }
    if (prefillBrowserIdentityId !== null) setBrowserIdentityId(prefillBrowserIdentityId);
    if (prefillNetworkPolicyId !== null) setNetworkPolicyId(prefillNetworkPolicyId);
  }, [prefillBrowserIdentityId, prefillNetworkPolicyId, prefillSiteId, prefillStartUrl]);

  useEffect(() => {
    const detectedUrl = extractFirstHttpUrl(prompt);
    if (detectedUrl === null) return;

    const currentStartUrl = startUrl.trim();
    if (currentStartUrl.length > 0 && currentStartUrl !== autoStartUrlRef.current) return;

    autoStartUrlRef.current = detectedUrl;
    if (currentStartUrl !== detectedUrl) {
      setStartUrl(detectedUrl);
    }

    if (targetManuallyEditedRef.current) return;
    const matchedSite = singleMatchingSiteForUrl(detectedUrl, sites.data?.items ?? []);
    if (matchedSite === null) return;

    setSiteProfileId(matchedSite.site_profile_id);
    applySiteDefaults(matchedSite);
  }, [prompt, sites.data?.items, startUrl]);

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

  const mutation = useMutation({
    mutationFn: async (body: ScenarioGenerationRequest) => {
      return api.generateScenario(body, crypto.randomUUID());
    },
    onSuccess: (next) => {
      setResult(next);
      setLocalError(null);
      setModelRequired(null);
      setCheckedModel("");
      void qc.invalidateQueries({ queryKey: ["scenarios"] });
      void qc.invalidateQueries({ queryKey: ["scenario-generations"] });
      qc.setQueryData(["scenario-generation", next.generation_id], next);
      if (next.run_id !== null) {
        void qc.invalidateQueries({ queryKey: ["runs"] });
        navigate("runTrace", { run: next.run_id, generation: next.generation_id, focus: "artifacts" });
      }
    },
    onError: (error) => {
      handleMutationError(error);
    },
  });

  const runMutation = useMutation({
    mutationFn: async ({ generation, body }: { generation: ScenarioGenerationResult; body: ScenarioGenerationRunRequest }) => {
      return api.runScenarioGeneration(generation.generation_id, body, crypto.randomUUID());
    },
    onSuccess: (next) => {
      setResult(next);
      setLocalError(null);
      setModelRequired(null);
      setCheckedModel("");
      void qc.invalidateQueries({ queryKey: ["scenarios"] });
      void qc.invalidateQueries({ queryKey: ["scenario-generations"] });
      qc.setQueryData(["scenario-generation", next.generation_id], next);
      if (next.run_id !== null) {
        void qc.invalidateQueries({ queryKey: ["runs"] });
        navigate("runTrace", { run: next.run_id, generation: next.generation_id, focus: "artifacts" });
      }
    },
    onError: (error) => {
      handleMutationError(error);
    },
  });

  function handleMutationError(error: unknown): void {
    const mr = error instanceof ApiError && error.code === "IR_SCHEMA_INVALID" ? modelRequiredOf(error.body) : null;
    if (mr !== null) {
      setModelRequired(mr);
      setLocalError(`AI 모델을 지정해야 합니다 (정책 ${mr.available}개, 기본 미지정). 모델명 입력 후 확인하고 다시 실행하세요.`);
      return;
    }
    setLocalError(errorLabel(error));
  }

  function buildRequest(): ScenarioGenerationRequest {
    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt.length === 0) {
      throw new Error("자연어 요청을 입력하세요.");
    }
    const targetValues = [siteProfileId.trim(), browserIdentityId.trim(), networkPolicyId.trim()];
    const hasAnyTarget = targetValues.some((v) => v.length > 0);
    const hasFullTarget = targetValues.every((v) => v.length > 0);
    if (hasAnyTarget && !hasFullTarget) {
      throw new Error("사이트, 로그인 세션, 보안 정책을 모두 준비하세요.");
    }
    const [site, identity, network] = targetValues as [string, string, string];
    const params = parseParamsText(paramsText);
    return {
      prompt: trimmedPrompt,
      ...(name.trim().length > 0 ? { name: name.trim() } : {}),
      mode,
      planner,
      ...(model.trim().length > 0 ? { model: model.trim() } : {}),
      ...(startUrl.trim().length > 0 ? { start_url: startUrl.trim() } : {}),
      ...(params !== undefined ? { params } : {}),
      ...(hasFullTarget
        ? { target: { site_profile_id: site, browser_identity_id: identity, network_policy_id: network } }
        : {}),
      evidence: { screenshot, video },
    };
  }

  function buildRunRequest(): ScenarioGenerationRunRequest {
    const targetValues = [siteProfileId.trim(), browserIdentityId.trim(), networkPolicyId.trim()];
    const hasAnyTarget = targetValues.some((v) => v.length > 0);
    const hasFullTarget = targetValues.every((v) => v.length > 0);
    if (hasAnyTarget && !hasFullTarget) {
      throw new Error("사이트, 로그인 세션, 보안 정책을 모두 준비하세요.");
    }
    const [site, identity, network] = targetValues as [string, string, string];
    const params = parseParamsText(paramsText);
    return {
      ...(startUrl.trim().length > 0 ? { start_url: startUrl.trim() } : {}),
      ...(params !== undefined ? { params } : {}),
      ...(hasFullTarget
        ? { target: { site_profile_id: site, browser_identity_id: identity, network_policy_id: network } }
        : {}),
      ...(model.trim().length > 0 ? { model: model.trim() } : {}),
      evidence: { screenshot, video },
    };
  }

  function submit(): void {
    setLocalError(null);
    if (needModel) {
      setLocalError("AI 모델을 입력하고 확인을 완료한 뒤 다시 실행하세요.");
      return;
    }
    if (evidenceSettingsLoading) {
      setLocalError("증거 저장 설정을 확인한 뒤 다시 실행하세요.");
      return;
    }
    try {
      const body = buildRequest();
      mutation.mutate(body);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "요청 실패");
    }
  }

  function runWithCorrections(generation: ScenarioGenerationResult): void {
    setLocalError(null);
    if (!canRunGenerationWithCorrections(generation)) {
      setLocalError("이 생성 결과는 보정 실행을 시작할 수 없습니다.");
      return;
    }
    if (needModel) {
      setLocalError("AI 모델을 입력하고 확인을 완료한 뒤 다시 실행하세요.");
      return;
    }
    const guide = currentCorrectionGuide(generation);
    const guideError = correctionGuideError(guide);
    if (guideError !== null) {
      setLocalError(guideError);
      return;
    }
    try {
      const body = buildRunRequest();
      runMutation.mutate({ generation, body });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "요청 실패");
    }
  }

  function selectGeneration(item: ScenarioGenerationResult): void {
    setResult(item);
    setModel(item.model ?? "");
    setScreenshot(item.evidence_policy.screenshot ?? "each_step");
    setScreenshotTouched(true);
    setVideo(item.evidence_policy.video ?? "never");
    setVideoTouched(true);
    setParamsText(paramsInputTextFromDraftIr(item.draft_ir, item.params_context));
    autoStartUrlRef.current = null;
    targetManuallyEditedRef.current = true;
    setStartUrl(draftStartUrl(item.draft_ir) ?? "");
    const target = draftTarget(item.draft_ir);
    setSiteProfileId(target?.site_profile_id ?? "");
    setBrowserIdentityId(target?.browser_identity_id ?? "");
    setNetworkPolicyId(target?.network_policy_id ?? "");
    qc.setQueryData(["scenario-generation", item.generation_id], item);
  }

  const correctionGuide = result === null ? null : currentCorrectionGuide(result);

  return (
    <section className="panel scenario-generator">
      <div className="panel-head">
        <h2>말로 설명해 만들기</h2>
      </div>
      <div className="scenario-generator-body">
        <div className="prompt-examples" role="group" aria-label="예시 프롬프트">
          <span className="subtle">예시로 시작하기</span>
          {PROMPT_EXAMPLES.map((ex) => (
            <button
              key={ex.label}
              type="button"
              className="prompt-example-chip"
              aria-label={`예시 프롬프트 채우기: ${ex.label}`}
              onClick={() => setPrompt(ex.prompt)}
            >
              {ex.label}
            </button>
          ))}
        </div>
        <label className="field field-wide">
          <span>자연어 요청</span>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={4}
            placeholder="예: https://example.com 에서 오늘 신규 주문 목록을 확인하고 요약해줘"
          />
        </label>
        <div className="form-grid">
          <label className="field">
            <span>시작 주소</span>
            <input ref={startUrlInputRef} value={startUrl} onChange={(event) => handleStartUrlChange(event.target.value)} placeholder="https://..." />
          </label>
          <label className="field">
            <span>사이트</span>
            <select ref={siteSelectRef} value={siteProfileId} onChange={(event) => selectSite(event.target.value)}>
              <option value="">사이트 선택 안 함</option>
              {(sites.data?.items ?? []).map((site) => (
                <option key={site.site_profile_id} value={site.site_profile_id}>
                  {siteLabel(site)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>AI 모델</span>
            <select aria-label="AI 모델" value={model} onChange={(event) => handleModelChange(event.target.value)}>
              <option value="">{defaultGatewayPolicy === null ? "기본 AI 모델 사용" : `기본 AI 모델 사용 (${defaultGatewayPolicy.model})`}</option>
              {gatewayPolicies.map((policy) => (
                <option key={policy.model} value={policy.model}>
                  {policy.model}
                  {policy.is_default === true ? " · 기본" : ""}
                </option>
              ))}
            </select>
            {modelRequired !== null && (
              <span className="model-confirm-row">
                <button className="btn" type="button" onClick={() => setCheckedModel(model.trim())} disabled={model.trim().length === 0 || policyCheck.isFetching}>
                  확인
                </button>
                <span className="subtle" role="status">
                  {policyCheck.isFetching
                    ? "AI 모델 확인 중..."
                    : modelConfirmed
                      ? `확인됨 - '${policyCheck.data?.model ?? checkedModel}' 사용`
                      : checkedModel.length > 0 && checkedModel === model.trim() && policyCheck.isError
                        ? `'${checkedModel}'을 사용할 수 없습니다. AI 모델명을 확인하세요.`
                        : "AI 모델을 선택하고 확인 후 다시 실행하세요."}
                </span>
              </span>
            )}
          </label>
          <div className="field field-wide" ref={siteCreateRef}>
            <SiteCreateForm
              embedded
              title="새 사이트 온보딩"
              triggerLabel="등록"
              initialUrl={startUrl}
              openSignal={siteCreateOpenSignal}
              onCreated={handleInlineSiteCreated}
            />
          </div>
        </div>
        <div className="target-summary" aria-label="실행 대상 요약">
          <span>
            <span className="subtle">로그인 세션</span>
            <strong>{siteSessionLabel(selectedSite)}</strong>
          </span>
          <span>
            <span className="subtle">보안 정책</span>
            <strong>{siteNetworkLabel(selectedSite)}</strong>
          </span>
          <span>
            <span className="subtle">AI 모델</span>
            <strong>{model.trim().length > 0 ? model.trim() : defaultGatewayPolicy?.model ?? "기본값 자동 선택"}</strong>
          </span>
        </div>
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
          <button className="btn primary" type="button" onClick={submit} disabled={mutation.isPending || needModel || evidenceSettingsLoading}>
            <Play size={15} aria-hidden="true" />
            {mutation.isPending ? "생성 중…" : evidenceSettingsLoading ? "증거 설정 확인 중…" : actionLabel}
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
            runPending={runMutation.isPending}
            modelConfirmationRequired={needModel}
            onRunWithCorrections={runWithCorrections}
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
          onSelect={selectGeneration}
        />
      </div>
    </section>
  );
}
