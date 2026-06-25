import type { Ref } from "react";

import type { ScenarioGenerationPlanner, ScenarioGenerationRequest, SiteItem } from "../../api/types";
import { ExecutionParamsEditor } from "./ExecutionParamsEditor";
import {
  browserIdentityTargetSummary,
  networkPolicyTargetSummary,
  plannerLabel,
  siteTargetSummary,
  type ScreenshotPolicy,
  type VideoPolicy,
} from "./helpers";

// 고급 설정(이름·처리 방식·생성 방식·증거 + 운영자 세부값) — 펼침 상태와 폼 값은 상위가 소유하고 prop 으로 받는 순수 표현 블록.
export function AdvancedSettings(props: {
  advancedOpen: boolean;
  onAdvancedToggle: (open: boolean) => void;
  name: string;
  onName: (next: string) => void;
  mode: ScenarioGenerationRequest["mode"];
  onMode: (next: ScenarioGenerationRequest["mode"]) => void;
  planner: ScenarioGenerationPlanner;
  onPlanner: (next: ScenarioGenerationPlanner) => void;
  availablePlanners: readonly ScenarioGenerationPlanner[];
  screenshot: ScreenshotPolicy;
  onScreenshot: (next: ScreenshotPolicy) => void;
  screenshotPolicies: readonly ScreenshotPolicy[];
  screenshotLoaded: boolean;
  screenshotRecordingEnabled: boolean;
  video: VideoPolicy;
  onVideo: (next: VideoPolicy) => void;
  videoPolicies: readonly VideoPolicy[];
  videoRecordingEnabled: boolean;
  developerOpen: boolean;
  onDeveloperToggle: (open: boolean) => void;
  selectedSite: SiteItem | null;
  siteProfileId: string;
  browserIdentityId: string;
  networkPolicyId: string;
  onSiteProfileId: (next: string) => void;
  onBrowserIdentityId: (next: string) => void;
  onNetworkPolicyId: (next: string) => void;
  paramsText: string;
  onParamsText: (next: string) => void;
  paramsJsonOpen: boolean;
  onParamsJsonToggle: (open: boolean) => void;
  paramsInputRef: Ref<HTMLTextAreaElement>;
}): JSX.Element {
  return (
    <details className="advanced-settings" open={props.advancedOpen} onToggle={(event) => props.onAdvancedToggle((event.currentTarget as HTMLDetailsElement).open)}>
      <summary>고급 설정 (이름·처리 방식·생성 방식·증거) — 대부분 비워두면 기본값으로 동작합니다</summary>
      <div className="form-grid">
        <label className="field">
          <span>자동화 이름</span>
          <input value={props.name} onChange={(event) => props.onName(event.target.value)} placeholder="비워두면 자동 생성" />
        </label>
        <label className="field">
          <span>처리 방식</span>
          <select value={props.mode} onChange={(event) => props.onMode(event.target.value as ScenarioGenerationRequest["mode"])}>
            <option value="save_and_run">저장 후 실행</option>
            <option value="save">저장만</option>
            <option value="draft_only">초안만</option>
          </select>
        </label>
        <label className="field">
          <span>생성 방식</span>
          <select value={props.planner} onChange={(event) => props.onPlanner(event.target.value as ScenarioGenerationPlanner)}>
            {props.availablePlanners.map((option) => (
              <option key={option} value={option}>
                {plannerLabel(option)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>스크린샷</span>
          <select
            value={props.screenshot}
            onChange={(event) => props.onScreenshot(event.target.value as ScreenshotPolicy)}
          >
            {props.screenshotPolicies.map((policy) => (
              <option key={policy} value={policy}>
                {policy === "never" ? "저장 안 함" : policy === "each_step" ? "매 단계" : "실패 시"}
              </option>
            ))}
          </select>
          {props.screenshotLoaded && !props.screenshotRecordingEnabled && <span className="muted">스크린샷 비활성</span>}
        </label>
        <label className="field">
          <span>동영상</span>
          <select
            aria-label="동영상"
            value={props.video}
            onChange={(event) => props.onVideo(event.target.value as VideoPolicy)}
          >
            {props.videoPolicies.map((policy) => (
              <option key={policy} value={policy}>
                {policy === "never" ? "저장 안 함" : policy === "always" ? "전체 실행" : "실패 시"}
              </option>
            ))}
          </select>
          {!props.videoRecordingEnabled && <span className="muted">영상 녹화 비활성</span>}
        </label>
      </div>
      <details
        className="developer-details"
        open={props.developerOpen}
        onToggle={(event) => props.onDeveloperToggle((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>운영자 세부값 (대상 선택값·실행 입력값)</summary>
        <p className="developer-note">
          사이트를 선택하면 로그인 세션과 보안 정책은 자동으로 채워집니다. 직접 입력은 기존 자동화 이관이나 운영 보정이 필요할 때만 사용하세요.
        </p>
        <div className="target-operator-summary" aria-label="선택된 실행 대상">
          <span>
            <span className="subtle">사이트</span>
            <strong>{siteTargetSummary(props.selectedSite, props.siteProfileId)}</strong>
          </span>
          <span>
            <span className="subtle">로그인 세션</span>
            <strong>{browserIdentityTargetSummary(props.selectedSite, props.browserIdentityId)}</strong>
          </span>
          <span>
            <span className="subtle">보안 정책</span>
            <strong>{networkPolicyTargetSummary(props.selectedSite, props.networkPolicyId)}</strong>
          </span>
        </div>
        <details className="developer-details target-id-details">
          <summary>고급/원문 선택값 직접 입력</summary>
          <p className="developer-note">외부 이관, 장애 보정, 지원 요청처럼 정확한 내부 선택값을 알고 있을 때만 수정합니다.</p>
          <div className="form-grid">
            <label className="field">
              <span>사이트 선택값</span>
              <input value={props.siteProfileId} onChange={(event) => props.onSiteProfileId(event.target.value)} placeholder="사이트를 선택하면 자동 입력" />
            </label>
            <label className="field">
              <span>로그인 세션 선택값</span>
              <input value={props.browserIdentityId} onChange={(event) => props.onBrowserIdentityId(event.target.value)} placeholder="사이트 기본 로그인 세션" />
            </label>
            <label className="field">
              <span>보안 정책 선택값</span>
              <input value={props.networkPolicyId} onChange={(event) => props.onNetworkPolicyId(event.target.value)} placeholder="사이트 기본 보안 정책" />
            </label>
          </div>
        </details>
        <div className="field field-wide">
          <span>실행 입력값</span>
          <ExecutionParamsEditor paramsText={props.paramsText} onChange={props.onParamsText} />
          <small className="field-help">필요한 경우에만 값을 입력합니다. 일반 사용자는 사이트 선택만으로 충분합니다.</small>
          <details
            className="developer-details params-json-details"
            open={props.paramsJsonOpen}
            onToggle={(event) => props.onParamsJsonToggle((event.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>고급/원문 입력값 보기</summary>
            <textarea
              ref={props.paramsInputRef}
              aria-label="고급/원문 입력값"
              value={props.paramsText}
              onChange={(event) => props.onParamsText(event.target.value)}
              rows={4}
              spellCheck={false}
              placeholder={`{
  "entry_url": "https://example.com",
  "max_pages": 3
}`}
            />
          </details>
        </div>
      </details>
    </details>
  );
}
