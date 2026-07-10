import { useEffect, useMemo } from "react";

import type { ScenarioGenerationCapabilities, ScenarioGenerationPlanner } from "../../api/types";
import {
  DEFAULT_AVAILABLE_PLANNERS,
  FALLBACK_SCREENSHOT_POLICIES,
  FALLBACK_VIDEO_POLICIES,
  firstAllowedPolicy,
  type ScreenshotPolicy,
  type VideoPolicy,
} from "./helpers";

// capabilities(서버 허용 정책) → 증거·플래너 폼 상태 정합 동기화.
// PromptScenarioGenerator 에서 의미 단위로 분리(F3 — 파일 500줄 게이트). 동작 불변 이동.
export function useEvidencePolicySync(input: {
  readonly capabilities: ScenarioGenerationCapabilities | undefined;
  readonly screenshot: ScreenshotPolicy;
  readonly screenshotTouched: boolean;
  readonly setScreenshot: (value: ScreenshotPolicy) => void;
  readonly video: VideoPolicy;
  readonly videoTouched: boolean;
  readonly setVideo: (value: VideoPolicy) => void;
  readonly planner: ScenarioGenerationPlanner;
  readonly setPlanner: (value: ScenarioGenerationPlanner) => void;
}): {
  readonly screenshotPolicies: readonly ScreenshotPolicy[];
  readonly screenshotRecordingEnabled: boolean;
  readonly screenshotLoaded: boolean;
  readonly videoPolicies: readonly VideoPolicy[];
  readonly videoRecordingEnabled: boolean;
  readonly availablePlanners: readonly ScenarioGenerationPlanner[];
} {
  const { capabilities, screenshot, screenshotTouched, setScreenshot, video, videoTouched, setVideo, planner, setPlanner } = input;
  const screenshotCapability = capabilities?.visual_evidence.screenshot;
  const screenshotRecordingEnabled = screenshotCapability?.enabled === true;
  const screenshotPolicies = useMemo<readonly ScreenshotPolicy[]>(
    () => (screenshotCapability?.policies.length ? screenshotCapability.policies : FALLBACK_SCREENSHOT_POLICIES),
    [screenshotCapability?.policies],
  );
  const screenshotDefaultPolicy = screenshotCapability?.default_policy ?? (screenshotRecordingEnabled ? "each_step" : "never");
  const videoCapability = capabilities?.visual_evidence.video;
  const videoRecordingEnabled = videoCapability?.enabled === true;
  const videoPolicies = useMemo<readonly VideoPolicy[]>(
    () => (videoCapability?.policies.length ? videoCapability.policies : FALLBACK_VIDEO_POLICIES),
    [videoCapability?.policies],
  );
  const videoDefaultPolicy = videoCapability?.default_policy ?? (videoRecordingEnabled ? "always" : "never");
  const plannerCapability = capabilities?.planner;
  const availablePlanners = plannerCapability?.available ?? DEFAULT_AVAILABLE_PLANNERS;
  const defaultPlanner = plannerCapability?.default_planner ?? "deterministic_mvp";

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
  }, [screenshot, screenshotCapability, screenshotDefaultPolicy, screenshotPolicies, screenshotTouched, setScreenshot]);

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
  }, [video, videoCapability, videoDefaultPolicy, videoPolicies, videoTouched, setVideo]);

  useEffect(() => {
    if (!availablePlanners.includes(planner)) {
      setPlanner(defaultPlanner);
    }
  }, [availablePlanners, defaultPlanner, planner, setPlanner]);

  return {
    screenshotPolicies,
    screenshotRecordingEnabled,
    screenshotLoaded: screenshotCapability !== undefined,
    videoPolicies,
    videoRecordingEnabled,
    availablePlanners,
  };
}
