// 제어평면 read 응답 타입(api-surface §1·§3·§4, app/src/api/reads.ts 매핑 기준).

export interface Paginated<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

export interface RunItem {
  readonly run_id: string;
  readonly status: string;
  readonly current_node: string | null;
  readonly as_of: string | null;
  readonly updated_at?: string | null;
  readonly failure_reason?: FailureReason | null;
}

// mapWorkitem(app/src/api/reads.ts) 실 투영과 1:1. attempts/checked_out_by/checked_out_at/run_id는
// workitems 행의 실 컬럼·run 역참조(항상 키 직렬화 → required). target_id는 컬럼 부재(release-decisions #6)로
// 영구 null이라 제거(current_node와 동형의 죽은 필드 — 창작 제거이지 은폐 아님).
export interface WorkitemItem {
  readonly workitem_id: string;
  readonly status: string;
  readonly unique_reference: string;
  readonly attempts: number;
  readonly checked_out_by: string | null;
  readonly checked_out_at: string | null;
  readonly run_id: string | null;
}

// mapHumanTask 실 투영과 1:1. on_timeout=human_tasks.on_timeout 실 컬럼(타임아웃 시 동작). payload(kind별 본문)는
// inline 저장 부재(payload_ref만)라 v1 미포함(fabrication 회피).
export interface HumanTaskItem {
  readonly human_task_id: string;
  readonly state: string;
  readonly kind: string;
  readonly assignee: string | null;
  readonly timeout: string | null;
  readonly on_timeout: string | null;
  readonly run_id: string | null;
}

/** workitem DLQ(dead_letter) + sink DLQ(sink_deliveries) 공용. status는 DEAD_LETTER 통지(ApiError 아님). */
export interface DeadLetterItem {
  readonly dead_letter_id: string;
  readonly kind: "workitem" | "sink";
  readonly status: string;
  readonly source_id: string | null;
  readonly sink_idempotency_key?: string;
}

export interface ScenarioItem {
  readonly scenario_id: string;
  readonly name: string;
  readonly version: number;
  readonly latest_version_id: string;
  readonly promotion_status?: string;
}

export interface SiteItem {
  readonly site_profile_id: string;
  readonly risk: string;
  readonly approval_status: string;
  readonly circuit_status: string;
  readonly name?: string;
  readonly url_pattern?: string;
  // 운영자-보조 세션 캡처 가능 여부(reads.ts 투영). loginUrl 설정 사이트만 '세션 등록' 노출.
  readonly login_capable?: boolean;
  readonly session_ready?: boolean;
  readonly session_expires_at?: string | null;
  readonly default_browser_identity_id?: string | null;
  readonly default_network_policy_id?: string | null;
}

// GET /v1/artifacts/{id} 응답(api-surface §5; reads.ts). content는 redacted 본문(at rest 마스킹 — 평문 없음).
export interface ArtifactDetail {
  readonly artifact_id: string;
  readonly type: string;
  readonly media_type?: string | null;
  readonly filename?: string | null;
  readonly byte_size?: number | null;
  readonly duration_ms?: number | null;
  readonly sha256: string;
  readonly redaction_status: string;
  readonly retention_until: string | null;
  readonly content: string;
}

export interface RunDetail {
  readonly run_id: string;
  readonly status: string;
  readonly worker_id: string | null;
  readonly attempts: number;
  readonly as_of: string | null;
  readonly updated_at?: string | null;
  readonly failure_reason?: FailureReason | null;
}

export interface FailureReason {
  readonly code: string;
  readonly message: string;
}

// GET /v1/runs/{id}/steps 항목(api-surface §1 각주⁶). 비민감 요약+참조만 — 본문/증빙은 artifact_ids→GET /v1/artifacts/{id}.
export interface StagehandCallSummary {
  readonly model: string;
  readonly transport: string;
  readonly stream_status: string | null;
  readonly ttfb_ms: number | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cost: string | null; // numeric → string
}
export interface StepSummary {
  readonly step_id: string;
  readonly node_id: string;
  readonly attempt: number;
  readonly action: string;
  readonly status: string;
  readonly cache_mode: string;
  readonly artifact_ids: string[];
  readonly stagehand_calls: StagehandCallSummary[];
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly duration_ms: number | null;
  readonly exception: { class: string; code: string } | null;
}

// 하이웍스 결재 수집 행(수집 run의 extract 아티팩트 content = JSON `{ rows: ApprovalRow[] }`). 고정 계약(api-surface 기록).
// doc_ref: 하이웍스 office origin 절대 URL(결재 run의 navigate 대상) — 필수·actionable(없으면 건별 결재 불가).
export interface ApprovalRow {
  readonly doc_ref: string;
  readonly approval_id?: string;
  readonly title: string;
  readonly status: string;
  readonly doc_type: string;
  readonly drafter: string;
  readonly drafted_at?: string;
}

// GET /v1/runs/{id}/artifacts 항목(api-surface §5 각주⁵). metadata-only — content/object_ref/sha256 미노출.
export interface RunArtifactItem {
  readonly artifact_id: string;
  readonly type: string;
  readonly media_type?: string | null;
  readonly filename?: string | null;
  readonly byte_size?: number | null;
  readonly duration_ms?: number | null;
  readonly redaction_status: string;
  readonly retention_until: string | null;
  readonly legal_hold: boolean;
  readonly created_at: string;
}

export type GenerationArtifactItem = RunArtifactItem;

export interface GenerationArtifactDetail extends ArtifactDetail {
  readonly generation_id: string;
}

export interface ScenarioDetail {
  readonly scenario_id: string;
  readonly name: string;
  readonly version: number;
  readonly promotion_status: string;
  // GET 상세는 IR 본문을 포함(편집 prefill). 목록(ScenarioItem)에는 없음.
  readonly ir?: unknown;
}

export interface ScenarioVersionItem {
  readonly version_id: string;
  readonly version: number;
  readonly promotion_status: string;
  readonly created_at: string;
  readonly promoted_at: string | null;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly report: unknown;
}

/** scenario 생성(POST)·편집(PUT) 응답. */
export interface ScenarioMutationResult {
  readonly scenario_id: string;
  readonly version: number;
  readonly promotion_status: string;
}

// POST /v1/runs 응답(server.ts: { run_id, status:"queued", as_of }). 실행 시작 직후 그 run 상세로 드릴다운하기 위해 run_id 가 필요.
export interface CreateRunResult {
  readonly run_id: string;
  readonly status: string;
  readonly as_of?: string | null;
}

export interface CreateRunBody {
  readonly scenario_version_id: string;
  readonly params: Record<string, unknown>;
  readonly workitem_id?: string;
  // 다정책+기본없음 테넌트에서 어느 LLM 모델로 실행할지 명시(서버 createRun model 해소; 미지정 시 기본/단일정책 자동해소,
  // 다정책+기본없음이면 model_required 422). gateway_policies.model 값.
  readonly model?: string;
}

export interface ScenarioGenerationTarget {
  readonly site_profile_id: string;
  readonly browser_identity_id: string;
  readonly network_policy_id: string;
}

export interface ScenarioGenerationEvidence {
  readonly screenshot?: "never" | "failure" | "each_step";
  readonly video?: "never" | "failure" | "always";
}

export interface ScenarioGenerationCapabilities {
  readonly planner?: {
    readonly default_planner: ScenarioGenerationPlanner;
    readonly available: ReadonlyArray<ScenarioGenerationPlanner>;
  };
  readonly visual_evidence: {
    readonly screenshot: {
      readonly enabled: boolean;
      readonly policies: ReadonlyArray<"never" | "failure" | "each_step">;
      readonly default_policy: "never" | "failure" | "each_step";
    };
    readonly video: {
      readonly enabled: boolean;
      readonly policies: ReadonlyArray<"never" | "failure" | "always">;
      readonly default_policy: "never" | "failure" | "always";
      readonly artifact_type: "video_masked";
      readonly media_type: "video/webm";
    };
  };
}

export type ScenarioGenerationPlanner = "deterministic_mvp" | "llm_v1";

export interface ScenarioGenerationRequest {
  readonly prompt: string;
  readonly name?: string;
  readonly mode?: "draft_only" | "save" | "save_and_run";
  readonly planner?: ScenarioGenerationPlanner;
  readonly start_url?: string;
  readonly target?: ScenarioGenerationTarget;
  readonly params?: Record<string, unknown>;
  readonly model?: string | null;
  readonly evidence?: ScenarioGenerationEvidence;
}

export interface ScenarioGenerationRunRequest {
  readonly target?: ScenarioGenerationTarget;
  readonly start_url?: string;
  readonly params?: Record<string, unknown>;
  readonly model?: string | null;
  readonly evidence?: ScenarioGenerationEvidence;
}

export interface ScenarioGenerationResult {
  readonly generation_id: string;
  readonly mode: "draft_only" | "save" | "save_and_run";
  readonly status: "drafted" | "saved" | "run_queued" | "blocked" | "failed";
  readonly prompt_hash: string;
  readonly prompt_redacted_ref?: string | null;
  readonly planner: ScenarioGenerationPlanner;
  readonly model?: string | null;
  readonly scenario_id: string | null;
  readonly scenario_version_id: string | null;
  readonly run_id: string | null;
  readonly evidence_policy: ScenarioGenerationEvidence;
  readonly blockers: readonly string[];
  readonly draft_ir: unknown;
  readonly validation_report: unknown;
  readonly created_at: string;
  readonly created_by: string;
}

// POST /v1/approvals/decide body(닫힌 shape — 백엔드 parseDecideBody 정합). reject 는 reason 필수(엔드포인트 강제).
export interface ScenarioGenerationList {
  readonly items: readonly ScenarioGenerationResult[];
  readonly next_cursor: string | null;
}

export interface ScenarioGenerationListParams extends ListParams {
  readonly status?: ScenarioGenerationResult["status"];
}

export interface ScenarioGenerationArtifactList {
  readonly items: readonly GenerationArtifactItem[];
  readonly next_cursor: string | null;
}

export interface DecideApprovalBody {
  readonly source_run_id: string; // 인박스를 노출한 수집 run
  readonly doc_ref: string; // 결재 문서 참조(approval origin 절대 URL)
  readonly decision: "approve" | "reject";
  readonly reason?: string;
}

// POST /v1/approvals/decide 201 응답. spawned_run_id = 내부에서 스폰된 결재 처리 run(콘솔이 폴링·딥링크).
export interface DecideApprovalResult {
  readonly decision_id: string;
  readonly source_run_id: string;
  readonly doc_ref: string;
  readonly decision: "approve" | "reject";
  readonly spawned_run_id: string;
}

export interface GatewayPolicy {
  readonly model: string;
  // 낙관적 동시성 토큰(GET ETag = gateway_policies.version). PUT If-Match에 사용. ETag 부재 시 undefined → 편집 차단.
  readonly version?: number;
  readonly capabilities?: Record<string, unknown>;
  readonly budget?: Record<string, unknown>;
  readonly fallback?: Record<string, unknown> | null;
  readonly is_default?: boolean;
}

// PUT /v1/gateway/policy body(닫힌 shape — 백엔드 parsePolicyBody와 정합). model이 갱신 대상 정책 키.
export interface GatewayPolicyUpdate {
  readonly model: string;
  readonly capabilities: Record<string, unknown>;
  readonly budget: Record<string, unknown>;
  readonly fallback_config?: Record<string, unknown> | null;
  readonly is_default?: boolean;
}

export interface ListParams {
  limit?: number;
  cursor?: string;
  status?: string;
  kind?: string;
  risk?: string;
  assignee?: string;
  run_id?: string;
  // query-bag: 뷰별 추가 필터(model 등)를 허용. URLSearchParams로 직렬화.
  [k: string]: string | number | undefined;
}

/** 제어평면 ApiError(error-catalog) 본문. */
export interface ApiErrorBody {
  readonly code: string;
  readonly message?: string;
  readonly details?: Record<string, unknown>;
  readonly correlation_id?: string;
}

export class ApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    readonly body: ApiErrorBody | null,
  ) {
    super(body?.message ?? code);
    this.name = "ApiError";
  }
}
