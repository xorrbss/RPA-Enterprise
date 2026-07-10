import type { ListParams } from "./types-common";
import type { HumanTaskPolicySnapshot } from "./types-human-tasks";

export type RunPriority = "low" | "medium" | "high" | "critical";
export type RunMode = "prod" | "test";

export interface RunItem {
  readonly run_id: string;
  readonly status: string;
  readonly priority?: RunPriority;
  readonly run_mode?: RunMode;
  // 실행 식별성 — 목록에서 어떤 자동화의 실행인지 식별(서버 scenarios JOIN 투영).
  readonly scenario_id?: string;
  readonly scenario_name?: string;
  readonly current_node: string | null;
  readonly as_of: string | null;
  // runs.started_at/ended_at 표시 전용 투영(F5 소요 시간) — 미시작/미종결은 null(경과 추정 금지).
  readonly started_at?: string | null;
  readonly ended_at?: string | null;
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

// POST /v1/dlq/replay-all 결과 — 적격 전체 일괄 재처리 집계. conflicts=이미 처리/진행 중, truncated=캡(500) 초과 잔여.
export interface ReplayAllDlqResult {
  readonly kind: "workitem" | "sink";
  readonly attempted: number;
  readonly replayed: number;
  readonly conflicts: number;
  readonly truncated: boolean;
}

/** workitem DLQ(dead_letter) + sink DLQ(sink_deliveries) 공용. status는 DEAD_LETTER 통지(ApiError 아님). */
export interface DeadLetterItem {
  readonly dead_letter_id: string;
  readonly kind: "workitem" | "sink";
  readonly status: string;
  readonly source_id: string | null;
  readonly sink_idempotency_key?: string;
  // reason_code(error-catalog ErrorCode)·created_at은 workitem DLQ만 투영(sink는 부재 — api-surface §4).
  // sink_idempotency_key와 동일한 kind별 비대칭 optional.
  readonly reason_code?: string;
  readonly created_at?: string;
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
  readonly priority?: RunPriority;
  readonly run_mode?: RunMode;
  readonly scenario_id?: string;
  readonly scenario_name?: string;
  readonly scenario_version_id?: string;
  readonly worker_id: string | null;
  readonly attempts: number;
  readonly as_of: string | null;
  // 실행 원본 파라미터(params_schema 검증 완료 값) — '수정 입력 재실행' 프리필용.
  readonly params?: Record<string, unknown> | null;
  // runs.started_at/ended_at 표시 전용 투영(F5 소요 시간) — 미시작/미종결은 null(경과 추정 금지).
  readonly started_at?: string | null;
  readonly ended_at?: string | null;
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
  // parsed_json에서 서버가 추출·마스킹한 1줄 요약. fill/select 값과 secret-like 문자열은 미노출.
  readonly action_summary?: string | null;
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
  readonly step_id?: string | null;
  readonly attempt?: number | null;
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

// POST /v1/runs 응답(server.ts: { run_id, status:"queued", as_of }). 실행 시작 직후 그 run 상세로 드릴다운하기 위해 run_id 가 필요.
export interface CreateRunResult {
  readonly run_id: string;
  readonly status: string;
  readonly as_of?: string | null;
  readonly priority?: RunPriority;
  readonly run_mode: RunMode;
}

export interface CreateRunBody {
  readonly scenario_version_id: string;
  readonly params: Record<string, unknown>;
  readonly workitem_id?: string;
  // 다정책+기본없음 테넌트에서 어느 LLM 모델로 실행할지 명시(서버 createRun model 해소; 미지정 시 기본/단일정책 자동해소,
  // 다정책+기본없음이면 model_required 422). gateway_policies.model 값.
  readonly model?: string;
  readonly priority?: RunPriority;
  readonly run_mode?: RunMode;
}

export interface RerunRunBody {
  readonly mode: "same_input" | "edited_input";
  readonly params?: Record<string, unknown>;
  readonly reason?: string | null;
}

export interface RerunRunResult {
  readonly rerun_id: string;
  readonly source_run_id: string;
  readonly run_id: string;
  readonly status: string;
  readonly mode: "same_input" | "edited_input";
  readonly as_of: string;
  readonly run_mode: RunMode;
}

export interface ResumeRunResult {
  readonly run_id: string;
  readonly status: "resume_requested";
  readonly previous_status: "suspended" | "resume_requested";
}

export type WebAttendedRunRequestStatus = "requested" | "run_queued" | "blocked" | "cancelled";
export type RunResumeRequestStatus = "requested" | "reenqueued";

export interface WebAttendedRunRequestConsent {
  readonly summary: string;
  readonly evidence_ref?: string | null;
  readonly input_refs?: readonly string[];
}

export interface WebAttendedRunRequestCreate {
  readonly scenario_version_id: string;
  readonly params: Record<string, unknown>;
  readonly model?: string | null;
  readonly priority?: RunPriority;
  readonly human_task_id?: string | null;
  readonly consent: WebAttendedRunRequestConsent;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly legal_hold?: boolean;
}

export interface WebAttendedRunRequest {
  readonly request_id: string;
  readonly scenario_version_id: string;
  readonly run_id: string | null;
  readonly human_task_id: string | null;
  readonly status: WebAttendedRunRequestStatus;
  readonly requested_by: string;
  readonly request_idempotency_key: string;
  readonly consent_summary: string;
  readonly consent_evidence_ref: string | null;
  readonly input_refs: readonly string[];
  readonly human_task_policy: HumanTaskPolicySnapshot;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly requested_at: string;
  readonly updated_at: string;
  readonly legal_hold: boolean;
}

export interface WebAttendedRunRequestListParams extends ListParams {
  readonly status?: WebAttendedRunRequestStatus;
  readonly run_id?: string;
  readonly human_task_id?: string;
}

export interface RunResumeRequest {
  readonly request_id: string;
  readonly run_id: string;
  readonly human_task_id: string | null;
  readonly status: RunResumeRequestStatus;
  readonly previous_run_status: "suspended" | "resume_requested";
  readonly requested_by: string;
  readonly reason: string | null;
  readonly input_refs: readonly string[];
  readonly human_task_policy: HumanTaskPolicySnapshot;
  readonly audit_correlation_id: string;
  readonly request_idempotency_key: string;
  readonly requested_at: string;
  readonly updated_at: string;
  readonly legal_hold: boolean;
}

export interface RunResumeRequestListParams extends ListParams {
  readonly status?: RunResumeRequestStatus;
  readonly run_id?: string;
  readonly human_task_id?: string;
}

export interface PrioritizeRunBody {
  readonly priority: RunPriority;
  readonly reason?: string | null;
}

export interface PrioritizeRunResult {
  readonly run_id: string;
  readonly status: "queued";
  readonly previous_priority: RunPriority;
  readonly priority: RunPriority;
}
