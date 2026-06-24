import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { FileVideo, Image, Play } from "lucide-react";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { GenerationArtifactsPanel } from "./GenerationArtifactsPanel";
import { SiteCreateForm, type CreatedSite } from "./SiteCreateForm";
import { errorCodeLabel, errorLabel, StatusBadge } from "./badges";
import { navigate, useHashParam } from "../router";
import { urlRefLabel } from "../api/scenario-params";
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

// AI 생성기 예시 프롬프트 — 무엇을 적어야 할지 막막한 운영자가 클릭 한 번으로 textarea를 채워 시작한다.
// 라벨은 '쉬운 만들기' 템플릿 어휘(목록 수집/결재 처리/첨부 다운로드/양식 입력/로그인 후 조회)와 맞춘다.
// 예시 문장은 textarea placeholder("…신규 주문 목록을 확인하고 요약…")와 중복되지 않게 작성.
const PROMPT_EXAMPLES: ReadonlyArray<{ readonly label: string; readonly prompt: string }> = [
  { label: "목록 수집", prompt: "사내 게시판에서 오늘 등록된 공지 목록의 제목과 작성자, 등록일을 모아줘" },
  { label: "결재 처리", prompt: "하이웍스 결재함에서 대기 중인 지출 품의 문서의 제목과 금액, 기안자를 확인해줘" },
  { label: "첨부 다운로드", prompt: "전자세금계산서 페이지에서 이번 달 청구서 PDF 파일 목록을 확인해줘" },
  { label: "양식 입력", prompt: "고객 문의 접수 화면에 정해진 양식대로 입력하고 제출 결과를 확인해줘" },
  { label: "로그인 후 조회", prompt: "ERP에 로그인한 뒤 미수금 현황 화면에서 거래처별 잔액을 조회해줘" },
];

// 운영자 표면: 매핑된 blocker 라벨 → ErrorCode 한글(reason이 ErrorCode일 때) → generic 한글 폴백.
// raw 영문 코드 노출 금지(비기술 운영자 레지스터), 진단정보 최대 보존(조용한 공백 금지).
function blockerLabel(blocker: string): string {
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

const START_URL_REPAIR_BLOCKERS: ReadonlySet<string> = new Set(["start_url_required_for_auto_run", "target_start_url_site_mismatch"]);
const TARGET_REPAIR_BLOCKERS: ReadonlySet<string> = new Set([
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

interface CorrectionGuideState {
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

type ScreenshotPolicy = "never" | "failure" | "each_step";
type VideoPolicy = "never" | "failure" | "always";
const DEFAULT_AVAILABLE_PLANNERS: readonly ScenarioGenerationPlanner[] = ["deterministic_mvp"];
const FALLBACK_SCREENSHOT_POLICIES: readonly ScreenshotPolicy[] = ["never", "failure", "each_step"];
const FALLBACK_VIDEO_POLICIES: readonly VideoPolicy[] = ["never", "failure", "always"];

function plannerLabel(value: ScenarioGenerationPlanner): string {
  return value === "llm_v1" ? "AI 생성" : "기본 생성";
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
  const visible = blockers.slice(0, 2).map((blocker) => blockerLabel(blocker));
  const suffix = blockers.length > visible.length ? ` 외 ${blockers.length - visible.length}건` : "";
  return `${visible.join(" · ")}${suffix}`;
}

function historyActionLabel(item: ScenarioGenerationResult): string {
  if (item.run_id !== null) return evidenceReviewActionLabel(item.evidence_policy);
  if (item.status === "blocked") return "검토 사유·산출물 보기";
  if (item.status === "saved") return "저장본 확인";
  if (item.status === "drafted") return "초안 확인";
  return "검토 사유 보기";
}

function canRunGenerationWithCorrections(result: ScenarioGenerationResult): boolean {
  return (
    result.run_id === null &&
    result.scenario_version_id !== null &&
    (result.status === "blocked" || result.status === "saved") &&
    result.blockers.every((blocker) => RUN_REPAIRABLE_BLOCKERS.has(blocker))
  );
}

function hasAnyBlocker(blockers: readonly string[], repairSet: ReadonlySet<string>): boolean {
  return blockers.some((blocker) => repairSet.has(blocker));
}

function correctionGuideReady(guide: CorrectionGuideState): boolean {
  return (
    (!guide.needsStartUrl || guide.startUrlReady) &&
    (!guide.needsTarget || guide.targetReady) &&
    guide.targetStartUrlMatches &&
    (!guide.needsVideoPolicy || guide.videoPolicyReady) &&
    (!guide.needsParams || guide.paramsReady)
  );
}

function correctionGuideError(guide: CorrectionGuideState): string | null {
  if (guide.needsStartUrl && !guide.startUrlReady) return "시작 주소를 입력한 뒤 다시 실행하세요.";
  if (guide.needsTarget && guide.targetPartial) return "사이트, 로그인 세션, 보안 정책을 모두 준비하세요.";
  if (guide.needsTarget && !guide.targetReady) return "기존 사이트를 선택하거나 새 사이트를 등록해 실행 대상을 채우세요.";
  if (!guide.targetStartUrlMatches) return "시작 주소와 선택한 사이트 주소를 맞춘 뒤 다시 실행하세요.";
  if (guide.needsVideoPolicy && !guide.videoPolicyReady) return "동영상 녹화를 끄고 다시 실행하세요.";
  if (guide.needsParams && !guide.paramsReady) return "마스킹된 실행 입력값을 다시 입력한 뒤 실행하세요.";
  return null;
}

function modelRequiredOf(body: ApiErrorBody | null): { available: number } | null {
  const details = body?.details;
  if (details === undefined || details.reason !== "model_required") return null;
  const available = typeof details.available === "number" ? details.available : 0;
  return { available };
}

function siteLabel(site: SiteItem): string {
  const name = site.name ?? "사이트명 미정";
  return site.url_pattern !== undefined ? `${name} (${site.url_pattern})` : name;
}

function siteSessionLabel(site: SiteItem | null): string {
  if (site === null) return "사이트 선택 시 자동 연결";
  if (site.default_browser_identity_id === null || site.default_browser_identity_id === undefined) return "기본 로그인 세션 없음";
  if (site.session_ready === false) return "세션 등록 필요";
  return "기본 로그인 세션 사용";
}

function siteNetworkLabel(site: SiteItem | null): string {
  if (site === null) return "사이트 선택 시 자동 적용";
  return site.default_network_policy_id === null || site.default_network_policy_id === undefined ? "기본 보안 정책 없음" : "사이트 기본 보안 정책 사용";
}

function siteTargetSummary(site: SiteItem | null, siteProfileId: string): string {
  if (site !== null) return siteLabel(site);
  return siteProfileId.trim().length > 0 ? "직접 지정된 사이트" : "사이트 선택 필요";
}

function browserIdentityTargetSummary(site: SiteItem | null, browserIdentityId: string): string {
  if (browserIdentityId.trim().length === 0) return "로그인 세션 확인 필요";
  if (site !== null && site.default_browser_identity_id === browserIdentityId.trim()) return siteSessionLabel(site);
  return "직접 지정된 로그인 세션";
}

function networkPolicyTargetSummary(site: SiteItem | null, networkPolicyId: string): string {
  if (networkPolicyId.trim().length === 0) return "보안 정책 확인 필요";
  if (site !== null && site.default_network_policy_id === networkPolicyId.trim()) return siteNetworkLabel(site);
  return "직접 지정된 보안 정책";
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

// 신규 생성 사이트의 낙관적 표시 — 서버가 보내지 않은 값(risk 미제공·circuit_status 부재)은 단정하지 않고
//   중립 "확인 중" 센티넬로 둔다(날조 금지). 호출부에서 sites 쿼리를 무효화해 곧 실제 서버 값으로 대체된다.
const PENDING_FACT = "확인 중";
function createdSiteToItem(site: CreatedSite): SiteItem {
  return {
    site_profile_id: site.site_profile_id,
    name: site.name,
    url_pattern: site.url_pattern,
    risk: site.risk ?? PENDING_FACT,
    approval_status: site.approved === true ? "approved" : "pending",
    circuit_status: PENDING_FACT,
    default_browser_identity_id: site.default_browser_identity_id ?? null,
    default_network_policy_id: site.default_network_policy_id ?? null,
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
    throw new Error("실행 입력값 형식이 올바르지 않습니다. 여러 항목을 담은 객체 형태로 입력하세요.");
  }
  if (!isRecord(parsed)) {
    throw new Error("실행 입력값은 여러 항목을 담은 객체 형태여야 합니다.");
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

interface ParamFieldView {
  key: string;
  label: string;
  value: string;
  valueType: string;
}

function paramsFieldsFromText(value: string): { fields: ParamFieldView[]; invalid: boolean } {
  try {
    const params = parseParamsText(value);
    if (params === undefined) return { fields: [], invalid: false };
    return {
      fields: Object.entries(params).map(([key, fieldValue]) => ({
        key,
        label: urlRefLabel(key),
        value: paramValueToInput(fieldValue),
        valueType: paramValueTypeLabel(fieldValue),
      })),
      invalid: false,
    };
  } catch {
    return { fields: [], invalid: true };
  }
}

function paramValueToInput(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

function paramValueTypeLabel(value: unknown): string {
  if (Array.isArray(value)) return "목록";
  if (value === null) return "빈 값";
  if (typeof value === "number") return "숫자";
  if (typeof value === "boolean") return "true/false";
  if (typeof value === "object") return "복합 값";
  return "텍스트";
}

function coerceParamInput(raw: string, previous: unknown): unknown {
  const trimmed = raw.trim();
  if (typeof previous === "number") {
    const parsed = Number(trimmed);
    return trimmed.length > 0 && Number.isFinite(parsed) ? parsed : raw;
  }
  if (typeof previous === "boolean") {
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
  }
  if (previous !== null && typeof previous === "object") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function paramsTextWithField(currentText: string, key: string, raw: string): string {
  const current = parseParamsText(currentText) ?? {};
  return JSON.stringify({ ...current, [key]: coerceParamInput(raw, current[key]) }, null, 2);
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
  const scenarioNameById = useMemo(() => scenarioNameMap(scenariosForHistory.data?.items ?? []), [scenariosForHistory.data?.items]);

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
      throw new Error("사이트, 로그인 세션, 보안 정책을 모두 준비하세요.");
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
        <details className="advanced-settings" open={advancedOpen} onToggle={(event) => setAdvancedOpen((event.currentTarget as HTMLDetailsElement).open)}>
          <summary>고급 설정 (이름·처리 방식·생성 방식·증거) — 대부분 비워두면 기본값으로 동작합니다</summary>
          <div className="form-grid">
            <label className="field">
              <span>자동화 이름</span>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="비워두면 자동 생성" />
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
              <span>생성 방식</span>
              <select value={planner} onChange={(event) => setPlanner(event.target.value as ScenarioGenerationPlanner)}>
                {availablePlanners.map((option) => (
                  <option key={option} value={option}>
                    {plannerLabel(option)}
                  </option>
                ))}
              </select>
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
          <details
            className="developer-details"
            open={developerOpen}
            onToggle={(event) => setDeveloperOpen((event.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>운영자 세부값 (대상 선택값·실행 입력값)</summary>
            <p className="developer-note">
              사이트를 선택하면 로그인 세션과 보안 정책은 자동으로 채워집니다. 직접 입력은 기존 자동화 이관이나 운영 보정이 필요할 때만 사용하세요.
            </p>
            <div className="target-operator-summary" aria-label="선택된 실행 대상">
              <span>
                <span className="subtle">사이트</span>
                <strong>{siteTargetSummary(selectedSite, siteProfileId)}</strong>
              </span>
              <span>
                <span className="subtle">로그인 세션</span>
                <strong>{browserIdentityTargetSummary(selectedSite, browserIdentityId)}</strong>
              </span>
              <span>
                <span className="subtle">보안 정책</span>
                <strong>{networkPolicyTargetSummary(selectedSite, networkPolicyId)}</strong>
              </span>
            </div>
            <details className="developer-details target-id-details">
              <summary>고급/원문 선택값 직접 입력</summary>
              <p className="developer-note">외부 이관, 장애 보정, 지원 요청처럼 정확한 내부 선택값을 알고 있을 때만 수정합니다.</p>
              <div className="form-grid">
                <label className="field">
                  <span>사이트 선택값</span>
                  <input value={siteProfileId} onChange={(event) => handleSiteProfileIdChange(event.target.value)} placeholder="사이트를 선택하면 자동 입력" />
                </label>
                <label className="field">
                  <span>로그인 세션 선택값</span>
                  <input value={browserIdentityId} onChange={(event) => handleBrowserIdentityIdChange(event.target.value)} placeholder="사이트 기본 로그인 세션" />
                </label>
                <label className="field">
                  <span>보안 정책 선택값</span>
                  <input value={networkPolicyId} onChange={(event) => handleNetworkPolicyIdChange(event.target.value)} placeholder="사이트 기본 보안 정책" />
                </label>
              </div>
            </details>
            <div className="field field-wide">
              <span>실행 입력값</span>
              <ExecutionParamsEditor paramsText={paramsText} onChange={setParamsText} />
              <small className="field-help">필요한 경우에만 값을 입력합니다. 일반 사용자는 사이트 선택만으로 충분합니다.</small>
              <details
                className="developer-details params-json-details"
                open={paramsJsonOpen}
                onToggle={(event) => setParamsJsonOpen((event.currentTarget as HTMLDetailsElement).open)}
              >
                <summary>고급/원문 입력값 보기</summary>
                <textarea
                  ref={paramsInputRef}
                  aria-label="고급/원문 입력값"
                  value={paramsText}
                  onChange={(event) => setParamsText(event.target.value)}
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

function hasVisibleCorrectionSteps(guide: CorrectionGuideState): boolean {
  return guide.needsStartUrl || guide.needsTarget || guide.needsVideoPolicy || guide.needsParams || !guide.targetStartUrlMatches;
}

function ReadinessBadge({ ready }: { ready: boolean }): JSX.Element {
  return <span className={`badge ${ready ? "green" : "amber"}`}>{ready ? "준비됨" : "필요"}</span>;
}

function BlockedCorrectionGuide({
  guide,
  onFocusStartUrl,
  onFocusTarget,
  onOpenSiteCreate,
  onFocusParams,
  onDisableVideoEvidence,
}: {
  guide: CorrectionGuideState;
  onFocusStartUrl: () => void;
  onFocusTarget: () => void;
  onOpenSiteCreate: () => void;
  onFocusParams: () => void;
  onDisableVideoEvidence: () => void;
}): JSX.Element {
  return (
    <div className="site-create-inline recovery-guide" aria-label="실행 전 보정 안내">
      <strong>실행 전 보정</strong>
      <ul className="recovery-guide-list">
        {guide.needsStartUrl && (
          <li className="recovery-guide-row">
            <span className="inline-facts recovery-guide-main">
              <ReadinessBadge ready={guide.startUrlReady} />
              <span>시작 주소</span>
              <span className="subtle">{guide.startUrlReady ? "입력됨" : "자동 실행에 필요한 첫 페이지 주소를 입력하세요."}</span>
            </span>
            <button className="linklike" type="button" onClick={onFocusStartUrl}>
              시작 주소 입력
            </button>
          </li>
        )}
        {guide.needsTarget && (
          <li className="recovery-guide-row">
            <span className="inline-facts recovery-guide-main">
              <ReadinessBadge ready={guide.targetReady} />
              <span>실행 대상</span>
              <span className="subtle">
                {guide.targetReady
                  ? "사이트·로그인 세션·보안 정책이 준비됐습니다."
                  : guide.targetPartial
                    ? "실행 대상 구성을 완료하세요."
                    : "기존 사이트를 선택하거나 새 사이트를 등록하세요."}
              </span>
            </span>
            <span className="inline-facts recovery-guide-actions">
              {guide.hasSelectableSites && (
                <button className="linklike" type="button" onClick={onFocusTarget}>
                  사이트 선택
                </button>
              )}
              {guide.canCreateSite && (
                <button className="linklike" type="button" onClick={onOpenSiteCreate}>
                  새 사이트 등록
                </button>
              )}
            </span>
          </li>
        )}
        {!guide.targetStartUrlMatches && (
          <li className="recovery-guide-row">
            <span className="inline-facts recovery-guide-main">
              <ReadinessBadge ready={false} />
              <span>사이트 주소 일치</span>
              <span className="subtle">시작 주소와 선택한 사이트 주소를 맞추세요.</span>
            </span>
            <span className="inline-facts recovery-guide-actions">
              <button className="linklike" type="button" onClick={onFocusStartUrl}>
                시작 주소 확인
              </button>
              <button className="linklike" type="button" onClick={onFocusTarget}>
                사이트 확인
              </button>
            </span>
          </li>
        )}
        {guide.needsVideoPolicy && (
          <li className="recovery-guide-row">
            <span className="inline-facts recovery-guide-main">
              <ReadinessBadge ready={guide.videoPolicyReady} />
              <span>동영상 증거</span>
              <span className="subtle">{guide.videoPolicyReady ? "동영상 저장 안 함" : "녹화 포트가 없으면 동영상을 끄고 실행하세요."}</span>
            </span>
            <button className="linklike" type="button" onClick={onDisableVideoEvidence}>
              동영상 끄기
            </button>
          </li>
        )}
        {guide.needsParams && (
          <li className="recovery-guide-row">
            <span className="inline-facts recovery-guide-main">
              <ReadinessBadge ready={guide.paramsReady} />
              <span>실행 입력값</span>
              <span className="subtle">{guide.paramsReady ? "입력됨" : "마스킹된 값을 다시 입력하세요."}</span>
            </span>
            <button className="linklike" type="button" onClick={onFocusParams}>
              입력값 수정
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}

function ExecutionParamsEditor({
  paramsText,
  onChange,
}: {
  paramsText: string;
  onChange: (next: string) => void;
}): JSX.Element {
  const { fields, invalid } = useMemo(() => paramsFieldsFromText(paramsText), [paramsText]);
  if (invalid) {
    return (
      <p className="form-alert red" role="status">
        실행 입력값 형식이 올바르지 않습니다. 고급/원문 입력값 보기에서 여러 항목을 담은 형태로 수정하세요.
      </p>
    );
  }
  if (fields.length === 0) {
    return <p className="empty-state">추가 실행 입력값이 없습니다. 필요한 경우 고급/원문 입력값 보기에서 값을 추가하세요.</p>;
  }
  return (
    <div className="params-field-editor" aria-label="실행 입력값">
      {fields.map((field) => (
        <label className="field" key={field.key}>
          <span>{field.label}</span>
          <input
            aria-label={field.label}
            value={field.value}
            onChange={(event) => onChange(paramsTextWithField(paramsText, field.key, event.target.value))}
            placeholder={field.valueType === "숫자" ? "예: 3" : "값 입력"}
          />
          <small className="field-help">{field.valueType}</small>
        </label>
      ))}
    </div>
  );
}

function GenerationResult({
  result,
  correctionGuide,
  runPending,
  modelConfirmationRequired,
  onRunWithCorrections,
  onFocusStartUrl,
  onFocusTarget,
  onOpenSiteCreate,
  onFocusParams,
  onDisableVideoEvidence,
}: {
  result: ScenarioGenerationResult;
  correctionGuide: CorrectionGuideState | null;
  runPending: boolean;
  modelConfirmationRequired: boolean;
  onRunWithCorrections: (generation: ScenarioGenerationResult) => void;
  onFocusStartUrl: () => void;
  onFocusTarget: () => void;
  onOpenSiteCreate: () => void;
  onFocusParams: () => void;
  onDisableVideoEvidence: () => void;
}): JSX.Element {
  const canRunWithCorrections = canRunGenerationWithCorrections(result);
  const correctionReady = correctionGuide === null || correctionGuideReady(correctionGuide);
  const resultActionLabel = evidenceReviewActionLabel(result.evidence_policy);
  return (
    <div className="generation-result" role="status">
      <div className="generation-result-head">
        <span className={`badge ${generationStatusTone(result.status)}`}>{generationStatusLabel(result.status)}</span>
      </div>
      <div className="result-grid">
        <span className="subtle">자동화</span>
        <strong>{result.scenario_id === null ? "아직 저장 전" : "저장됨"}</strong>
        <span className="subtle">버전</span>
        <strong>{result.scenario_version_id === null ? "아직 없음" : "생성됨"}</strong>
        <span className="subtle">실행</span>
        <strong>{result.run_id === null ? "아직 실행 전" : "실행 기록 연결됨"}</strong>
        <span className="subtle">AI 모델</span>
        <strong>{result.model ?? "기본값 자동 선택"}</strong>
        <span className="subtle">AI 방식</span>
        <strong>{plannerLabel(result.planner)}</strong>
      </div>
      <details className="developer-details result-raw-details">
        <summary>고급/원문 식별값 보기</summary>
        <div className="result-grid">
          <span className="subtle">생성 추적 번호</span>
          <code>{result.generation_id}</code>
          <span className="subtle">자동화 추적 번호</span>
          <code>{result.scenario_id ?? "-"}</code>
          <span className="subtle">버전 추적 번호</span>
          <code>{result.scenario_version_id ?? "-"}</code>
          <span className="subtle">실행 추적 번호</span>
          <code>{result.run_id ?? "-"}</code>
        </div>
      </details>
      {result.evidence_policy !== undefined && (
        <div className="inline-facts" aria-label="증거 저장 설정">
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
        <div className="inline-facts" aria-label="실행 기록 연결">
          <span className="badge blue">실행 기록 연결</span>
          <EvidenceStorageChip policy={result.evidence_policy} />
          <span className="subtle">실행 기록 산출물에서 확인</span>
        </div>
      )}
      {result.blockers.length > 0 && (
        <div className="blocker-section" aria-label="검토 필요 사유">
          <strong>검토 필요 사유</strong>
          <ul className="blocker-list">
            {result.blockers.map((blocker) => (
              <li key={blocker}>{blockerLabel(blocker)}</li>
            ))}
          </ul>
        </div>
      )}
      {canRunWithCorrections && correctionGuide !== null && hasVisibleCorrectionSteps(correctionGuide) && (
        <BlockedCorrectionGuide
          guide={correctionGuide}
          onFocusStartUrl={onFocusStartUrl}
          onFocusTarget={onFocusTarget}
          onOpenSiteCreate={onOpenSiteCreate}
          onFocusParams={onFocusParams}
          onDisableVideoEvidence={onDisableVideoEvidence}
        />
      )}
      <GenerationArtifactsPanel generationId={result.generation_id} />
      {result.run_id !== null && (
        <GenerationArtifactsPanel generationId={result.generation_id} source="result" title="실행 결과 증빙" />
      )}
      {canRunWithCorrections && (
        <>
          <button
            className="btn primary"
            type="button"
            onClick={() => onRunWithCorrections(result)}
            disabled={runPending || modelConfirmationRequired || !correctionReady}
          >
            <Play size={15} aria-hidden="true" />
            {runPending ? "실행 보정 중" : "보정값으로 실행"}
          </button>
          {modelConfirmationRequired && <span className="subtle">AI 모델 확인 후 실행할 수 있습니다.</span>}
        </>
      )}
      {result.scenario_id !== null && (
        <div className="inline-actions" aria-label="저장된 자동화 연결">
          <button className="btn" type="button" onClick={() => navigate("playground", { scenario: result.scenario_id! })}>
            자동화 보기
          </button>
          <button className="btn" type="button" onClick={() => navigate("automationOps", { scenario: result.scenario_id! })}>
            운영 예약
          </button>
          <button className="btn" type="button" onClick={() => navigate("coePipeline", { scenario: result.scenario_id! })}>
            CoE 연결
          </button>
        </div>
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
        <div className="segmented small" role="group" aria-label="생성 이력 필터">
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
            placeholder="이름·상태·AI 모델 검색"
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
                  <span className="subtle">
                    자동화: {scenarioName}
                  </span>
                ) : (
                  <span className="subtle">
                    요청 내용 보호됨
                  </span>
                )}
                <span className="subtle">{formatGenerationTime(item.created_at)}</span>
                <span className="subtle">{plannerLabel(item.planner)}</span>
                {item.model !== undefined && item.model !== null && <span className="subtle">{item.model}</span>}
                {diagnostic !== null && (
                  <span className="subtle">
                    검토 필요 사유: {diagnostic}
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
                {item.status === "saved" && item.run_id === null && item.scenario_id !== null && (
                  <>
                    <button className="linklike" type="button" onClick={() => navigate("automationOps", { scenario: item.scenario_id! })}>
                      운영 예약
                    </button>
                    <button className="linklike" type="button" onClick={() => navigate("coePipeline", { scenario: item.scenario_id! })}>
                      CoE 연결
                    </button>
                  </>
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
