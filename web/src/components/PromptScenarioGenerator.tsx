import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { FileVideo, Image, Play, WandSparkles } from "lucide-react";

import { useApiClient } from "../api/context";
import { GenerationArtifactsPanel } from "./GenerationArtifactsPanel";
import { errorLabel, StatusBadge } from "./badges";
import { navigate } from "../router";
import type {
  ScenarioGenerationEvidence,
  ScenarioGenerationPlanner,
  ScenarioGenerationRequest,
  ScenarioGenerationRunRequest,
  ScenarioGenerationResult,
  SiteItem,
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
]);

type ScreenshotPolicy = "never" | "failure" | "each_step";
type VideoPolicy = "never" | "failure" | "always";
const DEFAULT_AVAILABLE_PLANNERS: readonly ScenarioGenerationPlanner[] = ["deterministic_mvp"];

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

function blockerSummary(blockers: readonly string[]): string | null {
  if (blockers.length === 0) return null;
  const visible = blockers.slice(0, 2).map((blocker) => BLOCKER_LABELS[blocker] ?? blocker);
  const suffix = blockers.length > visible.length ? ` 외 ${blockers.length - visible.length}건` : "";
  return `${visible.join(" · ")}${suffix}`;
}

function historyActionLabel(item: ScenarioGenerationResult): string {
  if (item.run_id !== null) return "결과·산출물 보기";
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

function siteLabel(site: SiteItem): string {
  const name = site.name ?? site.site_profile_id.slice(0, 8);
  return site.url_pattern !== undefined ? `${name} (${site.url_pattern})` : name;
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
  const history = useQuery({
    queryKey: ["scenario-generations", "recent", historyStatus ?? "all"],
    queryFn: () => api.listScenarioGenerations({ limit: 8, ...(historyStatus !== undefined ? { status: historyStatus } : {}) }),
    refetchInterval: 15_000,
  });
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<ScenarioGenerationRequest["mode"]>("save_and_run");
  const [startUrl, setStartUrl] = useState("");
  const [siteProfileId, setSiteProfileId] = useState("");
  const [browserIdentityId, setBrowserIdentityId] = useState("");
  const [networkPolicyId, setNetworkPolicyId] = useState("");
  const [model, setModel] = useState("");
  const [planner, setPlanner] = useState<ScenarioGenerationPlanner>("deterministic_mvp");
  const [screenshot, setScreenshot] = useState<ScreenshotPolicy>("each_step");
  const [video, setVideo] = useState<VideoPolicy>("never");
  const [videoTouched, setVideoTouched] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [result, setResult] = useState<ScenarioGenerationResult | null>(null);

  const actionLabel = mode === "save_and_run" ? "저장 후 실행" : mode === "save" ? "저장" : "초안 생성";
  const videoCapability = capabilities.data?.visual_evidence.video;
  const videoRecordingEnabled = videoCapability?.enabled === true;
  const videoPolicies = useMemo<readonly VideoPolicy[]>(
    () => (videoCapability?.policies.length ? videoCapability.policies : ["never", "failure", "always"]),
    [videoCapability?.policies],
  );
  const videoDefaultPolicy = videoCapability?.default_policy ?? (videoRecordingEnabled ? "always" : "never");
  const plannerCapability = capabilities.data?.planner;
  const availablePlanners = plannerCapability?.available ?? DEFAULT_AVAILABLE_PLANNERS;
  const defaultPlanner = plannerCapability?.default_planner ?? "deterministic_mvp";

  const selectedSite = useMemo(
    () => (sites.data?.items ?? []).find((s) => s.site_profile_id === siteProfileId) ?? null,
    [sites.data?.items, siteProfileId],
  );

  function selectSite(nextSiteId: string): void {
    setSiteProfileId(nextSiteId);
    if (nextSiteId.length === 0) {
      setBrowserIdentityId("");
      setNetworkPolicyId("");
      return;
    }
    const site = (sites.data?.items ?? []).find((s) => s.site_profile_id === nextSiteId);
    if (site?.default_browser_identity_id !== undefined && site.default_browser_identity_id !== null) {
      setBrowserIdentityId(site.default_browser_identity_id);
    }
    if (site?.default_network_policy_id !== undefined && site.default_network_policy_id !== null) {
      setNetworkPolicyId(site.default_network_policy_id);
    }
    if (startUrl.trim().length === 0 && site?.url_pattern !== undefined) {
      setStartUrl(site.url_pattern);
    }
  }

  useEffect(() => {
    if (videoCapability === undefined) return;
    if (!videoCapability.enabled) {
      if (!videoCapability.policies.includes(video)) {
        setVideo("never");
      }
      return;
    }
    if (!videoTouched && video === "never" && videoCapability.policies.includes(videoDefaultPolicy)) {
      setVideo(videoDefaultPolicy);
    }
  }, [video, videoCapability, videoDefaultPolicy, videoTouched]);

  useEffect(() => {
    if (!availablePlanners.includes(planner)) {
      setPlanner(defaultPlanner);
    }
  }, [availablePlanners, defaultPlanner, planner]);

  const mutation = useMutation({
    mutationFn: async () => {
      const body = buildRequest();
      return api.generateScenario(body, crypto.randomUUID());
    },
    onSuccess: (next) => {
      setResult(next);
      setLocalError(null);
      void qc.invalidateQueries({ queryKey: ["scenarios"] });
      void qc.invalidateQueries({ queryKey: ["scenario-generations"] });
      qc.setQueryData(["scenario-generation", next.generation_id], next);
      if (next.run_id !== null) {
        void qc.invalidateQueries({ queryKey: ["runs"] });
        navigate("runTrace", { run: next.run_id, generation: next.generation_id, focus: "artifacts" });
      }
    },
    onError: (error) => {
      setLocalError(errorLabel(error));
    },
  });

  const runMutation = useMutation({
    mutationFn: async (generation: ScenarioGenerationResult) => {
      const body = buildRunRequest();
      return api.runScenarioGeneration(generation.generation_id, body, crypto.randomUUID());
    },
    onSuccess: (next) => {
      setResult(next);
      setLocalError(null);
      void qc.invalidateQueries({ queryKey: ["scenarios"] });
      void qc.invalidateQueries({ queryKey: ["scenario-generations"] });
      qc.setQueryData(["scenario-generation", next.generation_id], next);
      if (next.run_id !== null) {
        void qc.invalidateQueries({ queryKey: ["runs"] });
        navigate("runTrace", { run: next.run_id, generation: next.generation_id, focus: "artifacts" });
      }
    },
    onError: (error) => {
      setLocalError(errorLabel(error));
    },
  });

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
    return {
      prompt: trimmedPrompt,
      ...(name.trim().length > 0 ? { name: name.trim() } : {}),
      mode,
      planner,
      ...(model.trim().length > 0 ? { model: model.trim() } : {}),
      ...(startUrl.trim().length > 0 ? { start_url: startUrl.trim() } : {}),
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
    return {
      ...(startUrl.trim().length > 0 ? { start_url: startUrl.trim() } : {}),
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
    try {
      mutation.mutate();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "요청 실패");
    }
  }

  function runWithCorrections(generation: ScenarioGenerationResult): void {
    setLocalError(null);
    try {
      runMutation.mutate(generation);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "요청 실패");
    }
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
            <input value={startUrl} onChange={(event) => setStartUrl(event.target.value)} placeholder="https://..." />
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
              list="scenario-generator-models"
              placeholder="기본 정책 사용"
            />
            <datalist id="scenario-generator-models">
              {(policies.data?.items ?? []).map((policy) => (
                <option key={policy.model} value={policy.model} />
              ))}
            </datalist>
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
          <label className="field">
            <span>사이트 ID</span>
            <input value={siteProfileId} onChange={(event) => setSiteProfileId(event.target.value)} placeholder="site_profile_id" />
          </label>
          <label className="field">
            <span>브라우저 ID</span>
            <input value={browserIdentityId} onChange={(event) => setBrowserIdentityId(event.target.value)} placeholder="browser_identity_id" />
          </label>
          <label className="field">
            <span>네트워크 정책 ID</span>
            <input value={networkPolicyId} onChange={(event) => setNetworkPolicyId(event.target.value)} placeholder="network_policy_id" />
          </label>
          <label className="field">
            <span>스크린샷</span>
            <select value={screenshot} onChange={(event) => setScreenshot(event.target.value as ScreenshotPolicy)}>
              <option value="each_step">매 단계</option>
              <option value="failure">실패 시</option>
              <option value="never">저장 안 함</option>
            </select>
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
          <button className="btn primary" type="button" onClick={submit} disabled={mutation.isPending}>
            <Play size={15} aria-hidden="true" />
            {mutation.isPending ? "생성 중…" : actionLabel}
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
            onRunWithCorrections={runWithCorrections}
          />
        )}
        <GenerationHistory
          items={history.data?.items ?? []}
          loading={history.isLoading}
          error={history.error === null ? null : errorLabel(history.error)}
          onRefresh={() => void history.refetch()}
          blockedOnly={historyStatus === "blocked"}
          onBlockedOnlyChange={(next) => setHistoryStatus(next ? "blocked" : undefined)}
          selectedGenerationId={result?.generation_id ?? null}
          onSelect={(item) => {
            setResult(item);
            qc.setQueryData(["scenario-generation", item.generation_id], item);
          }}
        />
      </div>
    </section>
  );
}

function GenerationResult({
  result,
  runPending,
  onRunWithCorrections,
}: {
  result: ScenarioGenerationResult;
  runPending: boolean;
  onRunWithCorrections: (generation: ScenarioGenerationResult) => void;
}): JSX.Element {
  const canRunWithCorrections = canRunGenerationWithCorrections(result);
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
      {result.blockers.length > 0 && (
        <ul className="blocker-list">
          {result.blockers.map((blocker) => (
            <li key={blocker}>{BLOCKER_LABELS[blocker] ?? blocker}</li>
          ))}
        </ul>
      )}
      <GenerationArtifactsPanel generationId={result.generation_id} />
      {canRunWithCorrections && (
        <button className="btn primary" type="button" onClick={() => onRunWithCorrections(result)} disabled={runPending}>
          <Play size={15} aria-hidden="true" />
          {runPending ? "실행 보정 중" : "보정값으로 실행"}
        </button>
      )}
      {result.run_id !== null && (
        <button className="btn" type="button" onClick={() => navigate("runTrace", { run: result.run_id!, generation: result.generation_id, focus: "artifacts" })}>
          실행 결과·산출물 보기
        </button>
      )}
    </div>
  );
}

function GenerationHistory({
  items,
  loading,
  error,
  onRefresh,
  blockedOnly,
  onBlockedOnlyChange,
  selectedGenerationId,
  onSelect,
}: {
  items: readonly ScenarioGenerationResult[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  blockedOnly: boolean;
  onBlockedOnlyChange: (next: boolean) => void;
  selectedGenerationId: string | null;
  onSelect: (item: ScenarioGenerationResult) => void;
}): JSX.Element {
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
        <button className="linklike" type="button" onClick={onRefresh}>
          새로고침
        </button>
      </div>
      {loading && <p className="muted">불러오는 중</p>}
      {error !== null && <p className="form-alert red">{error}</p>}
      {!loading && items.length === 0 && <p className="muted">최근 생성이 없습니다.</p>}
      {items.length > 0 && (
        <div className="generation-history-list">
          {items.map((item) => {
            const diagnostic = blockerSummary(item.blockers);
            const isSelected = item.generation_id === selectedGenerationId;
            const runId = item.run_id;
            return (
              <div className="generation-history-row" key={item.generation_id} aria-current={isSelected ? "true" : undefined}>
                <span className={`badge ${generationStatusTone(item.status)}`}>{generationStatusLabel(item.status)}</span>
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
                <span className="subtle">다음</span>
                {runId !== null ? (
                  <button className="linklike" type="button" onClick={() => navigate("runTrace", { run: runId, generation: item.generation_id, focus: "artifacts" })}>
                    {historyActionLabel(item)}
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
    </div>
  );
}

function formatGenerationTime(value: string | undefined): string {
  if (value === undefined) return "-";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";
  return date.toLocaleString();
}
