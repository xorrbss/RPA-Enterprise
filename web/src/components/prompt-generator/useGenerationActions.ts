import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { MutableRefObject } from "react";

import { useApiClient } from "../../api/context";
import { errorLabel } from "../badges";
import { navigate } from "../../router";
import {
  ApiError,
  type ScenarioGenerationPlanner,
  type ScenarioGenerationRequest,
  type ScenarioGenerationRunRequest,
  type ScenarioGenerationResult,
  type SiteItem,
} from "../../api/types";
import {
  START_URL_REPAIR_BLOCKERS,
  TARGET_REPAIR_BLOCKERS,
  canRunGenerationWithCorrections,
  correctionGuideError,
  draftStartUrl,
  draftTarget,
  hasAnyBlocker,
  httpOrigin,
  modelRequiredOf,
  paramsInputTextFromDraftIr,
  parseParamsText,
  type CorrectionGuideState,
  type ScreenshotPolicy,
  type VideoPolicy,
} from "./helpers";

export interface GenerationActionsInput {
  readonly prompt: string;
  readonly name: string;
  readonly mode: ScenarioGenerationRequest["mode"];
  readonly planner: ScenarioGenerationPlanner;
  readonly model: string;
  readonly startUrl: string;
  readonly paramsText: string;
  readonly siteProfileId: string;
  readonly browserIdentityId: string;
  readonly networkPolicyId: string;
  readonly screenshot: ScreenshotPolicy;
  readonly video: VideoPolicy;
  readonly selectedSite: SiteItem | null;
  readonly siteItems: readonly SiteItem[] | undefined;
  readonly canCreateSite: boolean;
  readonly needModel: boolean;
  readonly evidenceSettingsLoading: boolean;
  readonly autoStartUrlRef: MutableRefObject<string | null>;
  readonly targetManuallyEditedRef: MutableRefObject<boolean>;
  readonly setResult: (value: ScenarioGenerationResult | null) => void;
  readonly setLocalError: (value: string | null) => void;
  readonly setModelRequired: (value: { available: number } | null) => void;
  readonly setCheckedModel: (value: string) => void;
  readonly setModel: (value: string) => void;
  readonly setScreenshot: (value: ScreenshotPolicy) => void;
  readonly setScreenshotTouched: (value: boolean) => void;
  readonly setVideo: (value: VideoPolicy) => void;
  readonly setVideoTouched: (value: boolean) => void;
  readonly setParamsText: (value: string) => void;
  readonly setStartUrl: (value: string) => void;
  readonly setSiteProfileId: (value: string) => void;
  readonly setBrowserIdentityId: (value: string) => void;
  readonly setNetworkPolicyId: (value: string) => void;
}

export interface GenerationActions {
  readonly generatePending: boolean;
  readonly runPending: boolean;
  readonly submit: () => void;
  readonly runWithCorrections: (generation: ScenarioGenerationResult) => void;
  readonly selectGeneration: (item: ScenarioGenerationResult) => void;
  readonly currentCorrectionGuide: (generation: ScenarioGenerationResult) => CorrectionGuideState;
}

// 생성/보정 실행 액션: 요청 조립 → mutation → 성공 시 캐시 반영·실행 추적 이동, 실패 시 모델 지정 요구/오류 표기.
export function useGenerationActions(input: GenerationActionsInput): GenerationActions {
  const api = useApiClient();
  const qc = useQueryClient();
  const {
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
    siteItems,
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
  } = input;

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
      hasSelectableSites: (siteItems ?? []).length > 0,
      canCreateSite,
    };
  }

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
      throw new Error("사이트, 로그인 세션, 보안 정책을 모두 준비하세요. 아래 사이트·세션 설정에서 바로 확인할 수 있습니다.");
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
      throw new Error("사이트, 로그인 세션, 보안 정책을 모두 준비하세요. 아래 사이트·세션 설정에서 바로 확인할 수 있습니다.");
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

  return {
    generatePending: mutation.isPending,
    runPending: runMutation.isPending,
    submit,
    runWithCorrections,
    selectGeneration,
    currentCorrectionGuide,
  };
}
