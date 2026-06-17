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
}

export interface WorkitemItem {
  readonly workitem_id: string;
  readonly status: string;
  readonly unique_reference: string;
  readonly target_id: string | null;
}

export interface HumanTaskItem {
  readonly human_task_id: string;
  readonly state: string;
  readonly kind: string;
  readonly assignee: string | null;
  readonly timeout: string | null;
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
}

export interface SiteItem {
  readonly site_profile_id: string;
  readonly risk: string;
  readonly approval_status: string;
  readonly circuit_status: string;
  readonly name?: string;
  // 운영자-보조 세션 캡처 가능 여부(reads.ts 투영). loginUrl 설정 사이트만 '세션 등록' 노출.
  readonly login_capable?: boolean;
}

// GET /v1/artifacts/{id} 응답(api-surface §5; reads.ts). content는 redacted 본문(at rest 마스킹 — 평문 없음).
export interface ArtifactDetail {
  readonly artifact_id: string;
  readonly type: string;
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

// GET /v1/runs/{id}/artifacts 항목(api-surface §5 각주⁵). metadata-only — content/object_ref/sha256 미노출.
export interface RunArtifactItem {
  readonly artifact_id: string;
  readonly type: string;
  readonly redaction_status: string;
  readonly retention_until: string | null;
  readonly legal_hold: boolean;
  readonly created_at: string;
}

export interface ScenarioDetail {
  readonly scenario_id: string;
  readonly name: string;
  readonly version: number;
  readonly promotion_status: string;
  // GET 상세는 IR 본문을 포함(편집 prefill). 목록(ScenarioItem)에는 없음.
  readonly ir?: unknown;
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

export interface CreateRunBody {
  readonly scenario_version_id: string;
  readonly params?: Record<string, unknown>;
  readonly workitem_id?: string;
  // 다정책+기본없음 테넌트에서 어느 LLM 모델로 실행할지 명시(서버 createRun model 해소; 미지정 시 기본/단일정책 자동해소,
  // 다정책+기본없음이면 model_required 422). gateway_policies.model 값.
  readonly model?: string;
}

export interface GatewayPolicy {
  readonly model: string;
  // 낙관적 동시성 토큰(GET ETag = gateway_policies.version). PUT If-Match에 사용. ETag 부재 시 undefined → 편집 차단.
  readonly version?: number;
  readonly capabilities?: Record<string, unknown>;
  readonly budget?: Record<string, unknown>;
  readonly fallback?: Record<string, unknown>;
}

// PUT /v1/gateway/policy body(닫힌 shape — 백엔드 parsePolicyBody와 정합). model이 갱신 대상 정책 키.
export interface GatewayPolicyUpdate {
  readonly model: string;
  readonly capabilities: Record<string, unknown>;
  readonly budget: Record<string, unknown>;
  readonly fallback_config?: Record<string, unknown> | null;
}

export interface ListParams {
  limit?: number;
  cursor?: string;
  status?: string;
  kind?: string;
  risk?: string;
  assignee?: string;
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
