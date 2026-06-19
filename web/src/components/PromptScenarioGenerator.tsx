import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { FileVideo, Image, Play, WandSparkles } from "lucide-react";

import { useApiClient } from "../api/context";
import { GenerationArtifactsPanel } from "./GenerationArtifactsPanel";
import { SiteCreateForm, type CreatedSite } from "./SiteCreateForm";
import { errorLabel, StatusBadge } from "./badges";
import { navigate } from "../router";
import {
  ApiError,
  type ApiErrorBody,
  type Paginated,
  type ScenarioGenerationEvidence,
  type ScenarioGenerationPlanner,
  type ScenarioGenerationRequest,
  type ScenarioGenerationRunRequest,
  type ScenarioGenerationResult,
  type ScenarioItem,
  type SiteItem,
} from "../api/types";

const BLOCKER_LABELS: Record<string, string> = {
  target_start_url_site_mismatch: "시작 URL이 선택한 사이트의 origin과 일치하지 않습니다.",
  target_required_for_auto_run: "실행 대상이 필요합니다.",
  start_url_required_for_auto_run: "시작 URL이 필요합니다.",
  side_effect_prompt_requires_review: "쓰기 작업은 검토 후 실행해야 합니다.",
  site_profile_not_found: "사이트를 찾을 수 없습니다.",
  browser_identity_not_found: "브라우저 ID를 찾을 수 없습니다.",
  browser_identity_site_mismatch: "브라우저 ID가 선택한 사이트에 속하지 않습니다.",
  network_policy_not_found: "네트워크 정책을 찾을 수 없습니다.",
  network_policy_domain_mismatch: "네트워크 정책이 사이트 도메인을 허용하지 않습니다.",
  site_profile_blocked: "사이트 승인이 필요합니다.",
  video_recording_port_not_configured: "서버에서 동영상 녹화가 비활성화되어 있습니다.",
  params_context_redacted_value_required: "마스킹된 실행 params가 있어 값을 다시 입력해야 합니다.",
  pagination_page_limit_exceeded: "자동 반복 페이지 상한을 넘었습니다. max_pages를 10 이하로 줄여 주세요.",
};

const RUN_REPAIRABLE_BLOCKERS: ReadonlySet<string> = new Set([
  "target_required_for_auto_run",
  "start_url_required_for_auto_run",
  "target_start_url_site_mismatch",
  "site_profile_not_found",
  "site_profile_blocked",
  "browser_identity_not_found",
  "browser_identity_site_mismatch",
  "network_policy_not_found",
  "network_policy_domain_mismatch",
  "video_recording_port_not_configured",
  "params_context_redacted_value_required",
]);

type ScreenshotPolicy = "never" | "failure" | "each_step";
type VideoPolicy = "never" | "failure" | "always";
const DEFAULT_AVAILABLE_PLANNERS: readonly ScenarioGenerationPlanner[] = ["deterministic_mvp"];
const FALLBACK_SCREENSHOT_POLICIES: readonly ScreenshotPolicy[] = ["never", "failure", "each_step"];
const FALLBACK_VIDEO_POLICIES: readonly VideoPolicy[] = ["never", "failure", "always"];

function plannerLabel(value: ScenarioGenerationPlanner): string {
  return value === "llm_v1" ? "LLM Planner" : "MVP Planner";
}

function generationStatusLabel(status: ScenarioGenerationResult["status"]): string {
  switch (status) {
    case "drafted":
      return "초안 생성";
    case "saved":
      return "저장됨";
    case "run_queued":
      return "실행 대기";
    case "blocked":
      return "차단됨";
    case "failed":
      return "실패";
  }
}

function generationStatusTone(status: ScenarioGenerationResult["status"]): string {
  if (status === "run_queued" || status === "saved" || status === "drafted") return status === "run_queued" ? "blue" : "green";
  return status === "blocked" ? "red" : "amber";
}

function compactId(value: string | null): string {
  return value === null ? "-" : value.slice(0, 8);
}

function screenshotPolicyLabel(value: ScenarioGenerationEvidence["screenshot"]): string {
  if (value === "each_step") return "단계별 이미지";
  if (value === "failure") return "실패 이미지";
  return "이미지 없음";
}

function videoPolicyLabel(value: ScenarioGenerationEvidence["video"]): string {
  if (value === "always") return "전체 영상";
  if (value === "failure") return "실패 영상";
  return "영상 없음";
}

function hasRequestedImageEvidence(policy: ScenarioGenerationEvidence): boolean {
  return policy.screenshot !== "never";
}

function hasRequestedVideoEvidence(policy: ScenarioGenerationEvidence): boolean {
  return policy.video !== "never";
}

function evidenceStorageStatusLabel(policy: ScenarioGenerationEvidence): string {
  const image = hasRequestedImageEvidence(policy);
  const video = hasRequestedVideoEvidence(policy);
  if (image && video) return "이미지·동영상 저장 요청됨";
  if (image) return "이미지 저장 요청됨";
  if (video) return "동영상 저장 요청됨";
  return "이미지·동영상 저장 안 함";
}

function evidenceReviewActionLabel(policy: ScenarioGenerationEvidence): string {
  const image = hasRequestedImageEvidence(policy);
  const video = hasRequestedVideoEvidence(policy);
  if (image && video) return "이미지·동영상 결과 확인";
  if (image) return "이미지 결과 확인";
  if (video) return "동영상 결과 확인";
  return "실행 결과 확인";
}

function EvidenceStorageChip({ policy }: { policy: ScenarioGenerationEvidence }): JSX.Element {
  return (
    <span className="evidence-chip" aria-label={`증거 저장 상태: ${evidenceStorageStatusLabel(policy)}`}>
      {hasRequestedImageEvidence(policy) && <Image size={14} aria-hidden="true" />}
      {hasRequestedVideoEvidence(policy) && <FileVideo size={14} aria-hidden="true" />}
      {evidenceStorageStatusLabel(policy)}
    </span>
  );
}

function firstAllowedPolicy<T extends string>(policies: readonly T[], preferred: T, fallback: T): T {
  if (policies.includes(preferred)) return preferred;
  return policies[0] ?? fallback;
}

function blockerSummary(blockers: readonly string[]): string | null {
  if (blockers.length === 0) return null;
  const visible = blockers.slice(0, 2).map((blocker) => BLOCKER_LABELS[blocker] ?? blocker);
  const suffix = blockers.length > visible.length ? ` 외 ${blockers.length - visible.length}건` : "";
  return `${visible.join(" · ")}${suffix}`;
}

function historyActionLabel(item: ScenarioGenerationResult): string {
  if (item.run_id !== null) return evidenceReviewActionLabel(item.evidence_policy);
  if (item.status === "blocked") return "진단·산출물 보기";
  if (item.status === "saved") return "저장본 확인";
  if (item.status === "drafted") return "초안 확인";
  return "진단 보기";
}

function canRunGenerationWithCorrections(result: ScenarioGenerationResult): boolean {
  return (
    result.run_id === null &&
    result.scenario_version_id !== null &&
    (result.status === "blocked" || result.status === "saved") &&
    result.blockers.every((blocker) => RUN_REPAIRABLE_BLOCKERS.has(blocker))
  );
}

function modelRequiredOf(body: ApiErrorBody | null): { available: number } | null {
  const details = body?.details;
  if (details === undefined || details.reason !== "model_required") return null;
  const available = typeof details.available === "number" ? details.available : 0;
  return { available };
}

function siteLabel(site: SiteItem): string {
  const name = site.name ?? site.site_profile_id.slice(0, 8);
  return site.url_pattern !== undefined ? `${name} (${site.url_pattern})` : name;
}

const HTTP_URL_TOKEN_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_URL_PUNCTUATION_PATTERN = /[.,!?;:\u3002\uff0e\u3001\uff0c\uff01\uff1f\uff1b\uff1a\u2026]+$/u;
const TRAILING_URL_QUOTES_PATTERN = /["'\u201d\u2019]+$/u;
const CLOSING_URL_BRACKETS: Readonly<Record<string, string>> = {
  ")": "(",
  "]": "[",
  "}": "{",
  ">": "<",
  "\uff09": "\uff08",
  "\u3009": "\u3008",
  "\u300b": "\u300a",
  "\u300d": "\u300c",
  "\u300f": "\u300e",
  "\u3011": "\u3010",
};

function countCharacter(value: string, character: string): number {
  let count = 0;
  for (const next of value) {
    if (next === character) count += 1;
  }
  return count;
}

function trimUnmatchedClosingUrlBracket(value: string): string {
  const last = value[value.length - 1];
  if (last === undefined) return value;
  const opening = CLOSING_URL_BRACKETS[last];
  if (opening === undefined) return value;
  return countCharacter(value, last) > countCharacter(value, opening) ? value.slice(0, -1) : value;
}

function trimTrailingUrlToken(value: string): string {
  let next = value;
  for (;;) {
    const previous = next;
    next = trimUnmatchedClosingUrlBracket(next.replace(TRAILING_URL_PUNCTUATION_PATTERN, "").replace(TRAILING_URL_QUOTES_PATTERN, ""));
    if (next === previous) return next;
  }
}

function httpOrigin(value: string): string | null {
  const trimmed = trimTrailingUrlToken(value.trim());
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function extractFirstHttpUrl(value: string): string | null {
  HTTP_URL_TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTTP_URL_TOKEN_PATTERN.exec(value)) !== null) {
    const candidate = trimTrailingUrlToken(match[0]);
    if (candidate.length > 0 && httpOrigin(candidate) !== null) return candidate;
  }
  return null;
}

function singleMatchingSiteForUrl(url: string, sites: readonly SiteItem[]): SiteItem | null {
  const origin = httpOrigin(url);
  if (origin === null) return null;
  const matches = sites.filter((site) => site.url_pattern !== undefined && httpOrigin(site.url_pattern) === origin);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function createdSiteToItem(site: CreatedSite): SiteItem {
  return {
    site_profile_id: site.site_profile_id,
    name: site.name,
    url_pattern: site.url_pattern,
    risk: site.risk ?? "green",
    approval_status: site.approved === true ? "approved" : "pending",
    circuit_status: "closed",
    default_browser_identity_id: null,
    default_network_policy_id: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordField(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const next = value[key];
  return isRecord(next) ? next : null;
}

function nonEmptyStringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const next = value[key];
  return typeof next === "string" && next.trim().length > 0 ? next.trim() : null;
}

function parseParamsText(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("params JSON 형식이 올바르지 않습니다.");
  }
  if (!isRecord(parsed)) {
    throw new Error("params JSON은 객체여야 합니다.");
  }
  return parsed;
}

function paramsInputTextFromDraftIr(draftIr: unknown, paramsContext?: Record<string, unknown>): string {
  const params = nonEmptyRecord(paramsContext) ?? recordField(draftIr, "params") ?? paramsDefaultsFromDraftIr(draftIr);
  return params === null ? "" : JSON.stringify(params, null, 2);
}

function nonEmptyRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && Object.keys(value).length > 0 ? value : null;
}

function paramsDefaultsFromDraftIr(draftIr: unknown): Record<string, unknown> | null {
  const paramsSchema = recordField(draftIr, "params_schema");
  const properties = recordField(paramsSchema, "properties");
  if (properties === null) return null;
  const defaults: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(properties)) {
    if (!isRecord(property) || !Object.prototype.hasOwnProperty.call(property, "default")) continue;
    defaults[key] = property.default;
  }
  return Object.keys(defaults).length > 0 ? defaults : null;
}

function draftStartUrl(draftIr: unknown): string | null {
  const params = recordField(draftIr, "params") ?? paramsDefaultsFromDraftIr(draftIr);
  const paramsStartUrl = nonEmptyStringField(params, "start_url");
  return (
    nonEmptyStringField(draftIr, "start_url") ??
    nonEmptyStringField(recordField(draftIr, "meta"), "start_url") ??
    nonEmptyStringField(recordField(draftIr, "request"), "start_url") ??
    paramsStartUrl
  );
}

function draftTarget(draftIr: unknown): ScenarioGenerationRequest["target"] | null {
  const target = recordField(draftIr, "target") ?? recordField(recordField(draftIr, "request"), "target");
  const siteProfileId = nonEmptyStringField(target, "site_profile_id");
  const browserIdentityId = nonEmptyStringField(target, "browser_identity_id");
  const networkPolicyId = nonEmptyStringField(target, "network_policy_id");
  if (siteProfileId === null || browserIdentityId === null || networkPolicyId === null) return null;
  return {
    site_profile_id: siteProfileId,
    browser_identity_id: browserIdentityId,
    network_policy_id: networkPolicyId,
  };
}

export function PromptScenarioGenerator(): JSX.Element {
  const api = useApiClient();
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
  const [historyStatus, setHistoryStatus] = useState<ScenarioGenerationResult["status"] | undefined>(undefined);
  const [historySearch, setHistorySearch] = useState("");
  const [historyCursorStack, setHistoryCursorStack] = useState<string[]>([]);
  const historyCursor = historyCursorStack[historyCursorStack.length - 1];
  const history = useQuery({
    queryKey: ["scenario-generations", "recent", historyStatus ?? "all", historyCursor ?? "p0"],
    queryFn: () =>
      api.listScenarioGenerations({
        limit: 8,
        ...(historyStatus !== undefined ? { status: historyStatus } : {}),
        ...(historyCursor !== undefined ? { cursor: historyCursor } : {}),
      }),
    refetchInterval: 15_000,
  });
  const scenariosForHistory = useQuery({
    queryKey: ["scenarios"],
    queryFn: () => api.listScenarios({ limit: 50 }),
    refetchInterval: 10_000,
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
  const autoStartUrlRef = useRef<string | null>(null);
  const targetManuallyEditedRef = useRef(false);

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
  const scenarioNameById = useMemo(() => scenarioNameMap(scenariosForHistory.data?.items ?? []), [scenariosForHistory.data?.items]);

  function applySiteDefaults(site: SiteItem): void {
    setBrowserIdentityId(site.default_browser_identity_id ?? "");
    setNetworkPolicyId(site.default_network_policy_id ?? "");
  }

  function markTargetManuallyEdited(): void {
    targetManuallyEditedRef.current = true;
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
    setSiteProfileId(site.site_profile_id);
    setBrowserIdentityId(site.default_browser_identity_id ?? "");
    setNetworkPolicyId(site.default_network_policy_id ?? "");
    if (startUrl.trim().length === 0 && site.url_pattern !== undefined) {
      setStartUrl(site.url_pattern);
    }
  }

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
    if (!videoTouched && video === "never" && videoCapability.policies.includes(videoDefaultPolicy)) {
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
      throw new Error("사이트, 브라우저 ID, 네트워크 정책 ID를 모두 입력하세요.");
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
        ? {
            target: {
              site_profile_id: site,
              browser_identity_id: identity,
              network_policy_id: network,
            },
          }
        : {}),
      evidence: { screenshot, video },
    };
  }

  function buildRunRequest(): ScenarioGenerationRunRequest {
    const targetValues = [siteProfileId.trim(), browserIdentityId.trim(), networkPolicyId.trim()];
    const hasAnyTarget = targetValues.some((v) => v.length > 0);
    const hasFullTarget = targetValues.every((v) => v.length > 0);
    if (hasAnyTarget && !hasFullTarget) {
      throw new Error("사이트, 브라우저 ID, 네트워크 정책 ID를 모두 입력하세요.");
    }
    const [site, identity, network] = targetValues as [string, string, string];
    const params = parseParamsText(paramsText);
    return {
      ...(startUrl.trim().length > 0 ? { start_url: startUrl.trim() } : {}),
      ...(params !== undefined ? { params } : {}),
      ...(hasFullTarget
        ? {
            target: {
              site_profile_id: site,
              browser_identity_id: identity,
              network_policy_id: network,
            },
          }
        : {}),
      ...(model.trim().length > 0 ? { model: model.trim() } : {}),
      evidence: { screenshot, video },
    };
  }

  function submit(): void {
    setLocalError(null);
    if (needModel) {
      setLocalError("AI 모델을 입력하고 정책 확인을 완료한 뒤 다시 실행하세요.");
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
    if (needModel) {
      setLocalError("AI 모델을 입력하고 정책 확인을 완료한 뒤 다시 실행하세요.");
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

  return (
    <section className="panel scenario-generator">
      <div className="panel-head">
        <h2>자연어 자동화</h2>
        <span className="badge blue">
          <WandSparkles size={14} aria-hidden="true" />
          {plannerLabel(planner)}
        </span>
      </div>
      <div className="scenario-generator-body">
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
            <span>시나리오 이름</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="비워두면 자동 생성" />
          </label>
          <label className="field">
            <span>시작 URL</span>
            <input value={startUrl} onChange={(event) => handleStartUrlChange(event.target.value)} placeholder="https://..." />
          </label>
          <label className="field">
            <span>처리 방식</span>
            <select value={mode} onChange={(event) => setMode(event.target.value as ScenarioGenerationRequest["mode"])}>
              <option value="save_and_run">저장 후 실행</option>
              <option value="save">저장만</option>
              <option value="draft_only">초안만</option>
            </select>
          </label>
          <label className="field">
            <span>Planner</span>
            <select value={planner} onChange={(event) => setPlanner(event.target.value as ScenarioGenerationPlanner)}>
              {availablePlanners.map((option) => (
                <option key={option} value={option}>
                  {plannerLabel(option)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>AI 모델</span>
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              aria-label="AI 모델"
              list="scenario-generator-models"
              placeholder="기본 정책 사용"
            />
            <datalist id="scenario-generator-models">
              {(policies.data?.items ?? []).map((policy) => (
                <option key={policy.model} value={policy.model} />
              ))}
            </datalist>
            {modelRequired !== null && (
              <span style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
                <button
                  className="btn"
                  type="button"
                  onClick={() => setCheckedModel(model.trim())}
                  disabled={model.trim().length === 0 || policyCheck.isFetching}
                >
                  확인
                </button>
                <span className="subtle" role="status">
                  {policyCheck.isFetching
                    ? "모델 정책 확인 중..."
                    : modelConfirmed
                      ? `확인됨 - 정책 '${policyCheck.data?.model ?? checkedModel}' 사용`
                      : checkedModel.length > 0 && checkedModel === model.trim() && policyCheck.isError
                        ? `'${checkedModel}' 정책을 찾을 수 없습니다. 모델명을 확인하세요.`
                        : "모델명을 입력하고 정책 확인 후 다시 실행하세요."}
                </span>
              </span>
            )}
          </label>
          <label className="field">
            <span>사이트</span>
            <select value={siteProfileId} onChange={(event) => selectSite(event.target.value)}>
              <option value="">직접 입력 또는 생략</option>
              {(sites.data?.items ?? []).map((site) => (
                <option key={site.site_profile_id} value={site.site_profile_id}>
                  {siteLabel(site)}
                </option>
              ))}
            </select>
          </label>
          <div className="field field-wide">
            <SiteCreateForm
              embedded
              title="새 사이트 온보딩"
              triggerLabel="등록"
              initialUrl={startUrl}
              onCreated={handleInlineSiteCreated}
            />
          </div>
          <label className="field">
            <span>사이트 ID</span>
            <input value={siteProfileId} onChange={(event) => handleSiteProfileIdChange(event.target.value)} placeholder="site_profile_id" />
          </label>
          <label className="field">
            <span>브라우저 ID</span>
            <input value={browserIdentityId} onChange={(event) => handleBrowserIdentityIdChange(event.target.value)} placeholder="browser_identity_id" />
          </label>
          <label className="field">
            <span>네트워크 정책 ID</span>
            <input value={networkPolicyId} onChange={(event) => handleNetworkPolicyIdChange(event.target.value)} placeholder="network_policy_id" />
          </label>
          <label className="field">
            <span>스크린샷</span>
            <select
              value={screenshot}
              onChange={(event) => {
                setScreenshotTouched(true);
                setScreenshot(event.target.value as ScreenshotPolicy);
              }}
            >
              {screenshotPolicies.map((policy) => (
                <option key={policy} value={policy}>
                  {policy === "never" ? "저장 안 함" : policy === "each_step" ? "매 단계" : "실패 시"}
                </option>
              ))}
            </select>
            {screenshotCapability !== undefined && !screenshotRecordingEnabled && <span className="muted">스크린샷 비활성</span>}
          </label>
          <label className="field">
            <span>동영상</span>
            <select
              aria-label="동영상"
              value={video}
              onChange={(event) => {
                setVideoTouched(true);
                setVideo(event.target.value as VideoPolicy);
              }}
            >
              {videoPolicies.map((policy) => (
                <option key={policy} value={policy}>
                  {policy === "never" ? "저장 안 함" : policy === "always" ? "전체 실행" : "실패 시"}
                </option>
              ))}
            </select>
            {!videoRecordingEnabled && <span className="muted">영상 녹화 비활성</span>}
          </label>
        </div>
        <label className="field field-wide">
          <span>생성/실행 params JSON</span>
          <textarea
            value={paramsText}
            onChange={(event) => setParamsText(event.target.value)}
            rows={4}
            spellCheck={false}
            placeholder='{"entry_url":"https://example.com"}'
          />
        </label>
        {selectedSite !== null && (
          <div className="inline-facts" role="status">
            <span className="subtle">위험도</span>
            <StatusBadge status={selectedSite.risk} />
            <span className="subtle">승인</span>
            <StatusBadge status={selectedSite.approval_status} />
            <span className="subtle">서킷</span>
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
            runPending={runMutation.isPending}
            modelConfirmationRequired={needModel}
            onRunWithCorrections={runWithCorrections}
          />
        )}
        <GenerationHistory
          items={history.data?.items ?? []}
          loading={history.isLoading}
          error={history.error === null ? null : errorLabel(history.error)}
          onRefresh={() => void history.refetch()}
          blockedOnly={historyStatus === "blocked"}
          onBlockedOnlyChange={(next) => {
            setHistoryStatus(next ? "blocked" : undefined);
            setHistoryCursorStack([]);
          }}
          search={historySearch}
          onSearchChange={(next) => {
            setHistorySearch(next);
            setHistoryCursorStack([]);
          }}
          scenarioNameById={scenarioNameById}
          hasPrev={historyCursorStack.length > 0}
          hasNext={(history.data?.next_cursor ?? null) !== null}
          pageIndex={historyCursorStack.length}
          onPrev={() => setHistoryCursorStack((stack) => stack.slice(0, -1))}
          onNext={() => {
            const nextCursor = history.data?.next_cursor ?? null;
            if (nextCursor !== null) setHistoryCursorStack((stack) => [...stack, nextCursor]);
          }}
          selectedGenerationId={result?.generation_id ?? null}
          onSelect={(item) => {
            selectGeneration(item);
          }}
        />
      </div>
    </section>
  );
}

function GenerationResult({
  result,
  runPending,
  modelConfirmationRequired,
  onRunWithCorrections,
}: {
  result: ScenarioGenerationResult;
  runPending: boolean;
  modelConfirmationRequired: boolean;
  onRunWithCorrections: (generation: ScenarioGenerationResult) => void;
}): JSX.Element {
  const canRunWithCorrections = canRunGenerationWithCorrections(result);
  const resultActionLabel = evidenceReviewActionLabel(result.evidence_policy);
  return (
    <div className="generation-result" role="status">
      <div className="generation-result-head">
        <span className={`badge ${generationStatusTone(result.status)}`}>{generationStatusLabel(result.status)}</span>
        <code>{result.generation_id.slice(0, 8)}</code>
      </div>
      <div className="result-grid">
        <span className="subtle">scenario</span>
        <code>{compactId(result.scenario_id)}</code>
        <span className="subtle">version</span>
        <code>{compactId(result.scenario_version_id)}</code>
        <span className="subtle">run</span>
        <code>{compactId(result.run_id)}</code>
        <span className="subtle">model</span>
        <code>{result.model ?? "-"}</code>
        <span className="subtle">planner</span>
        <code>{plannerLabel(result.planner)}</code>
      </div>
      {result.evidence_policy !== undefined && (
        <div className="inline-facts" aria-label="evidence policy">
          <span className="evidence-chip">
            <Image size={14} aria-hidden="true" />
            {screenshotPolicyLabel(result.evidence_policy.screenshot)}
          </span>
          <span className="evidence-chip">
            <FileVideo size={14} aria-hidden="true" />
            {videoPolicyLabel(result.evidence_policy.video)}
          </span>
        </div>
      )}
      {result.run_id !== null && (
        <div className="inline-facts" aria-label="evidence handoff">
          <span className="badge blue">실행 기록 연결</span>
          <EvidenceStorageChip policy={result.evidence_policy} />
          <span className="subtle">실행 기록 산출물에서 확인</span>
        </div>
      )}
      {result.blockers.length > 0 && (
        <ul className="blocker-list">
          {result.blockers.map((blocker) => (
            <li key={blocker}>{BLOCKER_LABELS[blocker] ?? blocker}</li>
          ))}
        </ul>
      )}
      <GenerationArtifactsPanel generationId={result.generation_id} />
      {canRunWithCorrections && (
        <>
          <button
            className="btn primary"
            type="button"
            onClick={() => onRunWithCorrections(result)}
            disabled={runPending || modelConfirmationRequired}
          >
            <Play size={15} aria-hidden="true" />
            {runPending ? "실행 보정 중" : "보정값으로 실행"}
          </button>
          {modelConfirmationRequired && <span className="subtle">AI 모델 확인 후 실행할 수 있습니다.</span>}
        </>
      )}
      {result.run_id !== null && (
        <button className="btn" type="button" onClick={() => navigate("runTrace", { run: result.run_id!, generation: result.generation_id, focus: "artifacts" })}>
          {hasRequestedImageEvidence(result.evidence_policy) && <Image size={15} aria-hidden="true" />}
          {hasRequestedVideoEvidence(result.evidence_policy) && <FileVideo size={15} aria-hidden="true" />}
          {!hasRequestedImageEvidence(result.evidence_policy) && !hasRequestedVideoEvidence(result.evidence_policy) && <Play size={15} aria-hidden="true" />}
          {resultActionLabel}
        </button>
      )}
    </div>
  );
}

function scenarioNameMap(items: readonly ScenarioItem[]): ReadonlyMap<string, string> {
  return new Map(items.map((item) => [item.scenario_id, item.name]));
}

function GenerationHistory({
  items,
  loading,
  error,
  onRefresh,
  blockedOnly,
  onBlockedOnlyChange,
  search,
  onSearchChange,
  scenarioNameById,
  hasPrev,
  hasNext,
  pageIndex,
  onPrev,
  onNext,
  selectedGenerationId,
  onSelect,
}: {
  items: readonly ScenarioGenerationResult[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  blockedOnly: boolean;
  onBlockedOnlyChange: (next: boolean) => void;
  search: string;
  onSearchChange: (next: string) => void;
  scenarioNameById: ReadonlyMap<string, string>;
  hasPrev: boolean;
  hasNext: boolean;
  pageIndex: number;
  onPrev: () => void;
  onNext: () => void;
  selectedGenerationId: string | null;
  onSelect: (item: ScenarioGenerationResult) => void;
}): JSX.Element {
  const filteredItems = items.filter((item) => historyMatchesSearch(item, search, scenarioNameById));
  return (
    <div className="generation-history">
      <div className="generation-history-head">
        <h3>최근 생성 · 다음 액션</h3>
        <div className="segmented small" role="group" aria-label="generation filter">
          <button className={!blockedOnly ? "active" : ""} type="button" onClick={() => onBlockedOnlyChange(false)}>
            전체
          </button>
          <button className={blockedOnly ? "active" : ""} type="button" onClick={() => onBlockedOnlyChange(true)}>
            차단
          </button>
        </div>
        <label className="generation-history-search">
          <input
            aria-label="생성 검색"
            value={search}
            onChange={(event) => onSearchChange(event.currentTarget.value)}
            placeholder="이름·ID·모델 검색"
            type="search"
          />
        </label>
        <button className="linklike" type="button" onClick={onRefresh}>
          새로고침
        </button>
      </div>
      {loading && <p className="muted">불러오는 중</p>}
      {error !== null && <p className="form-alert red">{error}</p>}
      {!loading && items.length === 0 && <p className="muted">최근 생성이 없습니다.</p>}
      {!loading && items.length > 0 && filteredItems.length === 0 && <p className="muted">현재 페이지에서 일치하는 생성이 없습니다.</p>}
      {filteredItems.length > 0 && (
        <div className="generation-history-list">
          {filteredItems.map((item) => {
            const diagnostic = blockerSummary(item.blockers);
            const isSelected = item.generation_id === selectedGenerationId;
            const runId = item.run_id;
            const scenarioName = item.scenario_id === null ? undefined : scenarioNameById.get(item.scenario_id);
            return (
              <div className="generation-history-row" key={item.generation_id} aria-current={isSelected ? "true" : undefined}>
                <span className={`badge ${generationStatusTone(item.status)}`}>{generationStatusLabel(item.status)}</span>
                {scenarioName !== undefined ? (
                  <span className="subtle" title={item.scenario_id ?? undefined}>
                    시나리오: {scenarioName}
                  </span>
                ) : (
                  <span className="subtle" title={item.prompt_redacted_ref ?? item.prompt_hash}>
                    prompt: {item.prompt_redacted_ref ?? item.prompt_hash.slice(0, 12)}
                  </span>
                )}
                <code>{item.generation_id.slice(0, 8)}</code>
                <span className="subtle">{formatGenerationTime(item.created_at)}</span>
                <span className="subtle">{plannerLabel(item.planner)}</span>
                {item.model !== undefined && item.model !== null && <span className="subtle">{item.model}</span>}
                {diagnostic !== null && (
                  <span className="subtle" title={item.blockers.join(", ")}>
                    진단: {diagnostic}
                  </span>
                )}
                {item.status === "saved" && item.run_id === null && <span className="subtle">실행 연결 없음</span>}
                {runId !== null && <EvidenceStorageChip policy={item.evidence_policy} />}
                <span className="subtle">다음</span>
                {runId !== null ? (
                  <button className="linklike" type="button" onClick={() => navigate("runTrace", { run: runId, generation: item.generation_id, focus: "artifacts" })}>
                    {evidenceReviewActionLabel(item.evidence_policy)}
                  </button>
                ) : (
                  <button className="linklike" type="button" onClick={() => onSelect(item)}>
                    {historyActionLabel(item)}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {(hasPrev || hasNext) && (
        <div className="generation-history-pager">
          <button className="btn" type="button" onClick={onPrev} disabled={!hasPrev}>
            이전
          </button>
          <span className="subtle">{pageIndex + 1} 페이지</span>
          <button className="btn" type="button" onClick={onNext} disabled={!hasNext}>
            다음
          </button>
        </div>
      )}
    </div>
  );
}

function historyMatchesSearch(item: ScenarioGenerationResult, search: string, scenarioNameById: ReadonlyMap<string, string>): boolean {
  const query = search.trim().toLocaleLowerCase();
  if (query.length === 0) return true;
  const scenarioName = item.scenario_id === null ? undefined : scenarioNameById.get(item.scenario_id);
  return [
    scenarioName,
    item.generation_id,
    item.scenario_id,
    item.scenario_version_id,
    item.run_id,
    item.model,
    item.planner,
    item.status,
    evidenceStorageStatusLabel(item.evidence_policy),
    evidenceReviewActionLabel(item.evidence_policy),
    item.prompt_hash,
    item.prompt_redacted_ref,
    item.created_by,
    ...item.blockers,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .some((value) => value.toLocaleLowerCase().includes(query));
}

function formatGenerationTime(value: string | undefined): string {
  if (value === undefined) return "-";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";
  return date.toLocaleString();
}
