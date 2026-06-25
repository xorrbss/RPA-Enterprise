import type { ScenarioGenerationEvidence } from "../../api/types";
import { TERMINAL } from "./constants";
import { screenshotRequestLabel, videoRequestLabel } from "./artifact-helpers";

export function EvidenceStorageReadout({
  policy,
  counts,
  runStatus,
  loaded,
}: {
  policy: ScenarioGenerationEvidence | undefined;
  counts: { screenshots: number; videos: number; pending: number };
  runStatus: string | undefined;
  loaded: boolean;
}): JSX.Element | null {
  if (policy === undefined) return null;
  const terminal = runStatus !== undefined && TERMINAL.has(runStatus);
  const nonTerminal = runStatus !== undefined && !terminal;
  const failed =
    runStatus === "failed_business" || runStatus === "failed_system";
  const missingFailureScreenshot =
    loaded &&
    failed &&
    policy.screenshot === "failure" &&
    counts.screenshots === 0;
  const missingScreenshot =
    loaded &&
    terminal &&
    policy.screenshot === "each_step" &&
    counts.screenshots === 0;
  const missingVideo =
    loaded && terminal && policy.video === "always" && counts.videos === 0;
  const waitingScreenshot =
    loaded &&
    nonTerminal &&
    (policy.screenshot === "each_step" || policy.screenshot === "failure") &&
    counts.screenshots === 0;
  const waitingVideo =
    loaded &&
    nonTerminal &&
    (policy.video === "always" || policy.video === "failure") &&
    counts.videos === 0;

  return (
    <div
      className="inline-facts"
      role="status"
      aria-label="evidence storage"
      style={{ marginTop: 8 }}
    >
      <span className="subtle">
        요청 이미지: {screenshotRequestLabel(policy.screenshot)}
      </span>
      <span className="subtle">
        요청 동영상: {videoRequestLabel(policy.video)}
      </span>
      <span className="badge blue">저장 이미지 {counts.screenshots}</span>
      <span className="badge amber">저장 동영상 {counts.videos}</span>
      {counts.pending > 0 && (
        <span className="badge muted">처리 대기 {counts.pending}</span>
      )}
      {waitingScreenshot && (
        <span className="badge muted">
          {policy.screenshot === "failure"
            ? "실패 시 이미지 저장 대기"
            : "이미지 저장 대기"}
        </span>
      )}
      {waitingVideo && (
        <span className="badge muted">
          {policy.video === "failure"
            ? "실패 시 동영상 저장 대기"
            : "동영상 저장 대기"}
        </span>
      )}
      {missingFailureScreenshot && (
        <span className="badge amber">실패 스크린샷 미표시(처리 중 가능)</span>
      )}
      {missingScreenshot && (
        <span className="badge amber">요청 이미지 미표시(처리 중 가능)</span>
      )}
      {missingVideo && (
        <span className="badge amber">요청 동영상 미표시(처리 중 가능)</span>
      )}
    </div>
  );
}
