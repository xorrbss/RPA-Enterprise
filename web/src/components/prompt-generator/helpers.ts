import { errorCodeLabel } from "../badges";
import type {
  ApiErrorBody,
  ScenarioGenerationEvidence,
  ScenarioGenerationPlanner,
  ScenarioGenerationResult,
  ScenarioItem,
  SiteItem,
} from "../../api/types";

export type ScreenshotPolicy = "never" | "failure" | "each_step";
export type VideoPolicy = "never" | "failure" | "always";

export interface CorrectionGuideState {
  readonly needsStartUrl: boolean;
  readonly needsTarget: boolean;
  readonly needsVideoPolicy: boolean;
  readonly needsParams: boolean;
  readonly startUrlReady: boolean;
  readonly targetReady: boolean;
  readonly targetPartial: boolean;
  readonly targetStartUrlMatches: boolean;
  readonly videoPolicyReady: boolean;
  readonly paramsReady: boolean;
  readonly hasSelectableSites: boolean;
  readonly canCreateSite: boolean;
}

const BLOCKER_LABELS: Record<string, string> = {
  target_start_url_site_mismatch: "시작 주소가 선택한 사이트 주소와 일치하지 않습니다.",
  target_required_for_auto_run: "실행 대상이 필요합니다.",
  start_url_required_for_auto_run: "시작 주소가 필요합니다.",
  side_effect_prompt_requires_review: "쓰기 작업은 검토 후 실행해야 합니다.",
  site_profile_not_found: "사이트를 찾을 수 없습니다.",
  browser_identity_not_found: "로그인 세션을 찾을 수 없습니다.",
  browser_identity_site_mismatch: "로그인 세션이 선택한 사이트에 속하지 않습니다.",
  network_policy_not_found: "보안 정책을 찾을 수 없습니다.",
  network_policy_domain_mismatch: "보안 정책이 사이트 도메인을 허용하지 않습니다.",
  site_profile_blocked: "사이트 승인이 필요합니다.",
  video_recording_port_not_configured: "서버에서 동영상 녹화가 비활성화되어 있습니다.",
  params_context_redacted_value_required: "보안상 숨겨진 실행 입력값이 있어 값을 다시 입력해야 합니다.",
  pagination_page_limit_exceeded: "자동 반복 페이지 상한을 넘었습니다. 최대 페이지 수를 10 이하로 줄여 주세요.",
  compile_failed: "자동 생성한 자동화 정의를 검증하지 못했습니다. 운영자 검토가 필요합니다.",
  scenario_generation_failed: "자동화 생성에 실패했습니다. 검토 사유를 확인해 주세요.",
  site_profile_unresolved_for_start_url: "이 시작 주소와 매칭되는 사이트가 없습니다. 사이트를 새로 등록하세요.",
  site_profile_ambiguous_for_start_url: "이 시작 주소와 매칭되는 사이트가 여러 개입니다. 실행 대상을 직접 선택하세요.",
  browser_identity_unresolved_for_start_url: "이 사이트에 사용할 로그인 세션이 없습니다. 사이트를 등록하면 함께 생성됩니다.",
  network_policy_unresolved_for_start_url: "이 시작 주소를 허용하는 보안 정책이 없습니다. 사이트를 등록하면 함께 생성됩니다.",
  network_policy_ambiguous_for_start_url: "이 시작 주소를 허용하는 보안 정책이 여러 개입니다. 실행 대상을 직접 선택하세요.",
};

const GENERIC_BLOCKER_LABEL = "자동 생성에 실패했습니다. 검토 사유를 확인해 주세요.";

export const PROMPT_EXAMPLES: ReadonlyArray<{ readonly label: string; readonly prompt: string }> = [
  { label: "목록 수집", prompt: "사내 게시판에서 오늘 등록된 공지 목록의 제목과 작성자, 등록일을 모아줘" },
  { label: "결재 처리", prompt: "하이웍스 결재함에서 대기 중인 지출 품의 문서의 제목과 금액, 기안자를 확인해줘" },
  { label: "첨부 다운로드", prompt: "전자세금계산서 페이지에서 이번 달 청구서 PDF 파일 목록을 확인해줘" },
  { label: "양식 입력", prompt: "고객 문의 접수 화면에 정해진 양식대로 입력하고 제출 결과를 확인해줘" },
  { label: "로그인 후 조회", prompt: "ERP에 로그인한 뒤 미수금 현황 화면에서 거래처별 잔액을 조회해줘" },
];

export function blockerLabel(blocker: string): string {
  const mapped = BLOCKER_LABELS[blocker];
  if (mapped !== undefined) return mapped;
  const fromErrorCode = errorCodeLabel(blocker);
  return fromErrorCode !== blocker ? fromErrorCode : GENERIC_BLOCKER_LABEL;
}

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
  "site_profile_unresolved_for_start_url",
  "site_profile_ambiguous_for_start_url",
  "browser_identity_unresolved_for_start_url",
  "network_policy_unresolved_for_start_url",
  "network_policy_ambiguous_for_start_url",
  "video_recording_port_not_configured",
  "params_context_redacted_value_required",
]);

export const START_URL_REPAIR_BLOCKERS: ReadonlySet<string> = new Set(["start_url_required_for_auto_run", "target_start_url_site_mismatch"]);
export const TARGET_REPAIR_BLOCKERS: ReadonlySet<string> = new Set([
  "target_required_for_auto_run",
  "target_start_url_site_mismatch",
  "site_profile_not_found",
  "site_profile_blocked",
  "browser_identity_not_found",
  "browser_identity_site_mismatch",
  "network_policy_not_found",
  "network_policy_domain_mismatch",
  "site_profile_unresolved_for_start_url",
  "site_profile_ambiguous_for_start_url",
  "browser_identity_unresolved_for_start_url",
  "network_policy_unresolved_for_start_url",
  "network_policy_ambiguous_for_start_url",
]);

export const DEFAULT_AVAILABLE_PLANNERS: readonly ScenarioGenerationPlanner[] = ["deterministic_mvp"];
export const FALLBACK_SCREENSHOT_POLICIES: readonly ScreenshotPolicy[] = ["never", "failure", "each_step"];
export const FALLBACK_VIDEO_POLICIES: readonly VideoPolicy[] = ["never", "failure", "always"];

export function plannerLabel(value: ScenarioGenerationPlanner): string {
  return value === "llm_v1" ? "AI 생성" : "기본 생성";
}

export function generationStatusLabel(status: ScenarioGenerationResult["status"]): string {
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

export function generationStatusTone(status: ScenarioGenerationResult["status"]): string {
  if (status === "run_queued" || status === "saved" || status === "drafted") return status === "run_queued" ? "blue" : "green";
  return status === "blocked" ? "red" : "amber";
}

export function screenshotPolicyLabel(value: ScenarioGenerationEvidence["screenshot"]): string {
  if (value === "each_step") return "단계별 이미지";
  if (value === "failure") return "실패 이미지";
  return "이미지 없음";
}

export function videoPolicyLabel(value: ScenarioGenerationEvidence["video"]): string {
  if (value === "always") return "전체 영상";
  if (value === "failure") return "실패 영상";
  return "영상 없음";
}

export function hasRequestedImageEvidence(policy: ScenarioGenerationEvidence): boolean {
  return policy.screenshot !== "never";
}

export function hasRequestedVideoEvidence(policy: ScenarioGenerationEvidence): boolean {
  return policy.video !== "never";
}

export function evidenceStorageStatusLabel(policy: ScenarioGenerationEvidence): string {
  const image = hasRequestedImageEvidence(policy);
  const video = hasRequestedVideoEvidence(policy);
  if (image && video) return "이미지·동영상 저장 요청됨";
  if (image) return "이미지 저장 요청됨";
  if (video) return "동영상 저장 요청됨";
  return "이미지·동영상 저장 안 함";
}

export function evidenceReviewActionLabel(policy: ScenarioGenerationEvidence): string {
  const image = hasRequestedImageEvidence(policy);
  const video = hasRequestedVideoEvidence(policy);
  if (image && video) return "이미지·동영상 결과 확인";
  if (image) return "이미지 결과 확인";
  if (video) return "동영상 결과 확인";
  return "실행 결과 확인";
}

export function firstAllowedPolicy<T extends string>(policies: readonly T[], preferred: T, fallback: T): T {
  if (policies.includes(preferred)) return preferred;
  return policies[0] ?? fallback;
}

export function blockerSummary(blockers: readonly string[]): string | null {
  if (blockers.length === 0) return null;
  const visible = blockers.slice(0, 2).map((blocker) => blockerLabel(blocker));
  const suffix = blockers.length > visible.length ? ` 외 ${blockers.length - visible.length}건` : "";
  return `${visible.join(" · ")}${suffix}`;
}

export function historyActionLabel(item: ScenarioGenerationResult): string {
  if (item.run_id !== null) return evidenceReviewActionLabel(item.evidence_policy);
  if (item.status === "blocked") return "검토 사유·산출물 보기";
  if (item.status === "saved") return "저장본 확인";
  if (item.status === "drafted") return "초안 확인";
  return "검토 사유 보기";
}

export function canRunGenerationWithCorrections(result: ScenarioGenerationResult): boolean {
  return (
    result.run_id === null &&
    result.scenario_version_id !== null &&
    (result.status === "blocked" || result.status === "saved") &&
    result.blockers.every((blocker) => RUN_REPAIRABLE_BLOCKERS.has(blocker))
  );
}

export function hasAnyBlocker(blockers: readonly string[], repairSet: ReadonlySet<string>): boolean {
  return blockers.some((blocker) => repairSet.has(blocker));
}

export function correctionGuideReady(guide: CorrectionGuideState): boolean {
  return (
    (!guide.needsStartUrl || guide.startUrlReady) &&
    (!guide.needsTarget || guide.targetReady) &&
    guide.targetStartUrlMatches &&
    (!guide.needsVideoPolicy || guide.videoPolicyReady) &&
    (!guide.needsParams || guide.paramsReady)
  );
}

export function correctionGuideError(guide: CorrectionGuideState): string | null {
  if (guide.needsStartUrl && !guide.startUrlReady) return "시작 주소를 입력한 뒤 다시 실행하세요.";
  if (guide.needsTarget && guide.targetPartial) return "사이트, 로그인 세션, 보안 정책을 모두 준비하세요.";
  if (guide.needsTarget && !guide.targetReady) return "기존 사이트를 선택하거나 새 사이트를 등록해 실행 대상을 채우세요.";
  if (!guide.targetStartUrlMatches) return "시작 주소와 선택한 사이트 주소를 맞춘 뒤 다시 실행하세요.";
  if (guide.needsVideoPolicy && !guide.videoPolicyReady) return "동영상 녹화를 끄고 다시 실행하세요.";
  if (guide.needsParams && !guide.paramsReady) return "마스킹된 실행 입력값을 다시 입력한 뒤 실행하세요.";
  return null;
}

export function hasVisibleCorrectionSteps(guide: CorrectionGuideState): boolean {
  return guide.needsStartUrl || guide.needsTarget || guide.needsVideoPolicy || guide.needsParams || !guide.targetStartUrlMatches;
}

export function modelRequiredOf(body: ApiErrorBody | null): { available: number } | null {
  const details = body?.details;
  if (details === undefined || details.reason !== "model_required") return null;
  const available = typeof details.available === "number" ? details.available : 0;
  return { available };
}

export function siteLabel(site: SiteItem): string {
  const name = site.name ?? "사이트명 미정";
  return site.url_pattern !== undefined ? `${name} (${site.url_pattern})` : name;
}

export function siteSessionLabel(site: SiteItem | null): string {
  if (site === null) return "사이트 선택 시 자동 연결";
  if (site.default_browser_identity_id === null || site.default_browser_identity_id === undefined) return "기본 로그인 세션 없음";
  if (site.session_ready === false) return "세션 등록 필요";
  return "기본 로그인 세션 사용";
}

export function siteNetworkLabel(site: SiteItem | null): string {
  if (site === null) return "사이트 선택 시 자동 적용";
  return site.default_network_policy_id === null || site.default_network_policy_id === undefined ? "기본 보안 정책 없음" : "사이트 기본 보안 정책 사용";
}

export function siteTargetSummary(site: SiteItem | null, siteProfileId: string): string {
  if (site !== null) return siteLabel(site);
  return siteProfileId.trim().length > 0 ? "직접 지정된 사이트" : "사이트 선택 필요";
}

export function browserIdentityTargetSummary(site: SiteItem | null, browserIdentityId: string): string {
  if (browserIdentityId.trim().length === 0) return "로그인 세션 확인 필요";
  if (site !== null && site.default_browser_identity_id === browserIdentityId.trim()) return siteSessionLabel(site);
  return "직접 지정된 로그인 세션";
}

export function networkPolicyTargetSummary(site: SiteItem | null, networkPolicyId: string): string {
  if (networkPolicyId.trim().length === 0) return "보안 정책 확인 필요";
  if (site !== null && site.default_network_policy_id === networkPolicyId.trim()) return siteNetworkLabel(site);
  return "직접 지정된 보안 정책";
}

// URL 감지·params 파싱·draft 추출은 draft-params.ts 로 분리(helpers <500 유지). consumer 호환 위해 re-export.
export {
  createdSiteToItem,
  draftStartUrl,
  draftTarget,
  extractFirstHttpUrl,
  httpOrigin,
  paramsFieldsFromText,
  paramsInputTextFromDraftIr,
  paramsTextWithField,
  parseParamsText,
  singleMatchingSiteForUrl,
} from "./draft-params";

export function scenarioNameMap(items: readonly ScenarioItem[]): ReadonlyMap<string, string> {
  return new Map(items.map((item) => [item.scenario_id, item.name]));
}

export function historyMatchesSearch(item: ScenarioGenerationResult, search: string, scenarioNameById: ReadonlyMap<string, string>): boolean {
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

export function formatGenerationTime(value: string | undefined): string {
  if (value === undefined) return "-";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";
  return date.toLocaleString();
}
