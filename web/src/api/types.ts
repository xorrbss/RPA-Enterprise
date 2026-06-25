// 제어평면 read 응답 타입(api-surface §1·§3·§4, app/src/api/reads.ts 매핑 기준).

export interface Paginated<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

// run outcome 집계(api-surface §1 GET /v1/runs/summary). by_status=runs.status별 정확 카운트(부재 status는 키 생략).
// success_rate=completed/(completed+failed_business+failed_system), 분모 0이면 null(0/0 단정 금지).
export interface RunSummary {
  readonly by_status: Record<string, number>;
  readonly success_rate: number | null;
  readonly total: number;
  // cache_hit_rate(§E): ActionPlanCache 조회 적중률. by_mode=run_steps.cache_mode별 카운트,
  // hit_rate=hit/(조회=non-bypass), 조회 0이면 null. (bypass=캐시 미조회 → 분모 제외)
  readonly cache: { readonly by_mode: Record<string, number>; readonly hit_rate: number | null };
}

// run outcome 일별 추세(api-surface §1 GET /v1/runs/trends). 윈도우 내 모든 날 포함(0건 날도 — 스파크라인 연속).
// success_rate=completed/(completed+failed_business+failed_system), 그 날 분모 0이면 null(0/0 단정 금지).
export interface RunTrendPoint {
  readonly day: string;
  readonly completed: number;
  readonly failed_business: number;
  readonly failed_system: number;
  readonly total: number;
  readonly success_rate: number | null;
}

export interface RunTrends {
  readonly window_days: number;
  readonly timezone: string;
  readonly points: readonly RunTrendPoint[];
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

// mapHumanTask 실 투영과 1:1. on_timeout=human_tasks.on_timeout 실 컬럼(타임아웃 시 동작).
// V2 검증 워크벤치용 payload/result_schema/artifact_refs/result를 포함하되 artifact 본문은 Artifacts API로 별도 조회한다.
export interface HumanTaskItem {
  readonly human_task_id: string;
  readonly state: string;
  readonly kind: string;
  readonly assignee: string | null;
  readonly timeout: string | null;
  readonly on_timeout: string | null;
  readonly run_id: string | null;
  readonly payload?: Record<string, unknown> | null;
  readonly result_schema?: Record<string, unknown> | null;
  readonly artifact_refs?: readonly string[];
  readonly result?: HumanTaskResolution | null;
  readonly escalation_reason?: string | null; // H5 이관 사유(optional). 재배정 담당자 맥락.
  readonly escalated_by?: string | null;
  readonly escalated_at?: string | null;
}

export interface HumanTaskResolution {
  readonly decision: "approve" | "reject" | "correct" | "retry";
  readonly corrections?: Record<string, unknown>;
  readonly reason?: string;
  readonly confidence?: number;
  readonly notes?: string;
}

export type HumanTaskBusinessFormFieldType = "text" | "textarea" | "number" | "boolean" | "date" | "select";

export interface HumanTaskBusinessFormField {
  readonly key: string;
  readonly label: string;
  readonly type: HumanTaskBusinessFormFieldType;
  readonly required?: boolean;
  readonly options?: readonly string[];
  readonly help_text?: string;
}

export interface HumanTaskBusinessFormSchema {
  readonly version: "business_form_v1";
  readonly fields: readonly HumanTaskBusinessFormField[];
}

/**
 * 테넌트 담당자 디렉터리 항목(principals 테이블). 배정값은 `sub`(PrincipalId=JWT sub, 자유형)이고 `display_name`은
 * picker 표시이름. `principal_id`는 surrogate uuid(커서/식별), `source`는 쓰기 경로(jwt|manual). 자유 입력 폴백은 유지
 * (디렉터리 미등록 sub도 직접 배정 가능).
 */
export interface PrincipalItem {
  readonly principal_id: string;
  readonly sub: string;
  readonly display_name: string;
  readonly email: string | null;
  readonly source: "jwt" | "manual";
}

export type AuthReadinessStatus = "ok" | "warning" | "blocked";

export interface AuthReadiness {
  readonly status: AuthReadinessStatus;
  readonly enterprise_sso_ready: boolean;
  readonly provider: {
    readonly mode: "hs256" | "jwks";
    readonly configuration_source: "deployment_config" | "test_default";
    readonly algorithm: "HS256" | "RS256";
    readonly jwks_url_configured: boolean;
    readonly jwks_host: string | null;
    readonly issuer_configured: boolean;
    readonly issuer: string | null;
    readonly audience_configured: boolean;
    readonly audience: string | null;
  };
  readonly claim_mapping: {
    readonly subject_claim: string;
    readonly tenant_claim: string;
    readonly roles_claim: string;
    readonly expiry_claim: string;
    readonly display_name_claim: string;
    readonly email_claim: string;
  };
  readonly role_mapping: {
    readonly configured: boolean;
    readonly mapped_values: number;
  };
  readonly required_claims: readonly {
    readonly claim: string;
    readonly label: string;
    readonly required: boolean;
    readonly present: boolean;
    readonly mapped_to: string;
  }[];
  readonly current_principal: {
    readonly subject_id: string;
    readonly tenant_id: string;
    readonly roles: readonly string[];
    readonly source: "jwt" | "session";
    readonly display_name: string | null;
    readonly email: string | null;
  };
  readonly operational_gaps: readonly string[];
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

export interface ScenarioItem {
  readonly scenario_id: string;
  readonly name: string;
  readonly version: number;
  readonly latest_version_id: string;
  readonly promotion_status?: string;
}

// maker-checker prod 승격 요청(D4) — approver 인박스 항목.
export interface PromotionRequest {
  readonly request_id: string;
  readonly scenario_id: string;
  readonly scenario_name: string;
  readonly version: number;
  readonly reason: string;
  readonly requested_by: string;
  readonly created_at: string;
}

export type RunTriggerType = "cron" | "webhook";

export interface RunTriggerItem {
  readonly trigger_id: string;
  readonly scenario_version_id: string;
  readonly trigger_type: RunTriggerType;
  readonly status: "enabled" | "paused" | "archived";
  readonly cron_expression: string | null;
  readonly timezone: string | null;
  readonly webhook_secret_ref: string | null;
  readonly webhook_secret_configured?: boolean;
  readonly params: Record<string, unknown>;
  readonly catchup_policy: "skip_missed" | "fire_once";
  readonly max_concurrent_runs: number;
  readonly next_fire_at: string | null;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RunTriggerCreateBody {
  readonly trigger_type?: RunTriggerType;
  readonly scenario_version_id: string;
  readonly cron_expression?: string;
  readonly timezone?: string;
  readonly webhook_secret_ref?: string;
  readonly params?: Record<string, unknown>;
  readonly catchup_policy?: "skip_missed" | "fire_once";
  readonly max_concurrent_runs?: number;
  readonly next_fire_at?: string | null;
}

export interface RunTriggerUpdateBody {
  readonly cron_expression?: string;
  readonly timezone?: string;
  readonly webhook_secret_ref?: string;
  readonly params?: Record<string, unknown>;
  readonly catchup_policy?: "skip_missed" | "fire_once";
  readonly max_concurrent_runs?: number;
  readonly next_fire_at?: string | null;
}

export interface RunTriggerFireItem {
  readonly fire_id: string;
  readonly trigger_id: string;
  readonly fire_key: string;
  readonly status: "queued" | "skipped" | "failed";
  readonly scheduled_for: string;
  readonly run_id: string | null;
  readonly failure_reason: Record<string, unknown> | null;
  readonly created_at: string;
}

export type OpsAlertSeverity = "critical" | "warning" | "info";
export type OpsAlertSource = "run_sla" | "human_task_sla" | "trigger_fire" | "failure_spike" | "dlq";

export interface OpsAlertItem {
  readonly alert_id: string;
  readonly severity: OpsAlertSeverity;
  readonly source: OpsAlertSource;
  readonly title: string;
  readonly detail: string;
  readonly subject_type: "run" | "human_task" | "run_trigger" | "dlq";
  readonly subject_id: string | null;
  readonly status: "open";
  readonly recommended_action: string;
  readonly route: string | null;
  readonly detected_at: string;
  readonly due_at?: string | null;
}

export interface OpsAlertListParams extends ListParams {
  readonly severity?: OpsAlertSeverity;
  readonly source?: OpsAlertSource;
}

export type OpsHealthStatus = "ok" | "warning" | "critical";

export interface OpsHealth {
  readonly status: OpsHealthStatus;
  readonly detected_at: string;
  readonly queue: {
    readonly available: boolean;
    readonly pending_jobs: number | null;
  };
  readonly browser_leases: {
    readonly reserved: number;
    readonly active: number;
    readonly draining: number;
    readonly expired: number;
    readonly expired_open: number;
    readonly next_expiry_at: string | null;
  };
  readonly stale_runs: {
    readonly nonterminal_over_15m: number;
    readonly oldest_updated_at: string | null;
  };
}

export type BotPoolHealth = "ok" | "warning" | "critical";

export interface BotPoolItem {
  readonly bot_pool_id: string;
  readonly name: string;
  readonly kind: "browser";
  readonly capacity_slots: number;
  readonly workers: {
    readonly total: number;
    readonly active: number;
    readonly draining: number;
    readonly dead: number;
    readonly stale: number;
    readonly open_circuit: number;
  };
  readonly leases: {
    readonly reserved: number;
    readonly active: number;
    readonly draining: number;
    readonly expired_open: number;
    readonly next_expiry_at: string | null;
  };
  readonly queue: {
    readonly pending_runs: number;
    readonly due_triggers: number;
  };
  readonly health: BotPoolHealth;
  readonly health_reason: string;
}

export type AutomationIdeaStage = "intake" | "assess" | "approved" | "build" | "operate" | "rejected" | "archived";
export type AutomationIdeaPriority = "low" | "medium" | "high" | "critical";
export type AutomationIdeaSource = "manual" | "process_mining" | "task_mining" | "imported";
export type RoiConfidence = "low" | "medium" | "high";

export interface AutomationIdeaItem {
  readonly idea_id: string;
  readonly title: string;
  readonly description: string;
  readonly business_owner: string;
  readonly department: string;
  readonly source: AutomationIdeaSource;
  readonly stage: AutomationIdeaStage;
  readonly priority: AutomationIdeaPriority;
  readonly score: number;
  readonly scenario_id: string | null;
  readonly run_trigger_id: string | null;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface AutomationIdeaListParams extends ListParams {
  readonly stage?: AutomationIdeaStage;
  readonly owner?: string;
  readonly department?: string;
}

export interface AutomationIdeaCreateBody {
  readonly title: string;
  readonly description: string;
  readonly business_owner: string;
  readonly department: string;
  readonly source?: AutomationIdeaSource;
  readonly priority?: AutomationIdeaPriority;
  readonly score?: number;
}

export interface AutomationIdeaUpdateBody {
  readonly title?: string;
  readonly description?: string;
  readonly business_owner?: string;
  readonly department?: string;
  readonly priority?: AutomationIdeaPriority;
  readonly score?: number;
  readonly scenario_id?: string | null;
  readonly run_trigger_id?: string | null;
}

export interface RoiEstimateRequest {
  readonly frequency_per_month: number;
  readonly minutes_per_case: number;
  readonly exception_rate: number;
  readonly hourly_cost: number;
  readonly implementation_effort: number;
  readonly confidence?: RoiConfidence;
}

export interface RoiEstimate {
  readonly roi_estimate_id: string;
  readonly automation_idea_id: string;
  readonly frequency_per_month: number;
  readonly minutes_per_case: number;
  readonly exception_rate: number;
  readonly hourly_cost: number;
  readonly implementation_effort: number;
  readonly monthly_hours_saved: number;
  readonly estimated_monthly_value: number;
  readonly payback_months: number | null;
  readonly confidence: RoiConfidence;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export type AuditOutcome = "allow" | "deny" | "blocked" | "error";

export interface AuditLogActor {
  readonly subject_id: string | null;
  readonly roles: readonly string[];
}

export interface AuditLogItem {
  readonly audit_id: string;
  readonly sequence_no: number;
  readonly actor: AuditLogActor;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly reason: string | null;
  readonly correlation_id: string;
  readonly idempotency_key: string;
  readonly occurred_at: string;
  readonly payload_schema_ref: string;
  readonly retention_until: string | null;
  readonly legal_hold: boolean;
  readonly previous_hash: string | null;
  readonly hash: string;
  readonly created_at: string;
}

export interface AuditLogListParams extends ListParams {
  readonly action?: string;
  readonly outcome?: AuditOutcome;
  readonly actor?: string;
  readonly correlation_id?: string;
}

export interface AuditLogExportParams extends AuditLogListParams {
  readonly format?: "csv";
}

export type ConnectorCatalogKind = "browser" | "api" | "file" | "notification" | "data";
export type CatalogStatus = "available" | "candidate" | "requires_admin" | "blocked";
export type TemplateCatalogKind = "browser_workflow" | "api_workflow" | "file_workflow" | "notification_workflow";

export interface ConnectorManifestPermissions {
  readonly api: readonly ("migrateSchema" | "registerTargets" | "readConfig")[];
  readonly network: false;
  readonly secret_refs: readonly string[];
}

export interface ConnectorCatalogItem {
  readonly catalog_id: string;
  readonly connector_id: string;
  readonly name: string;
  readonly kind: ConnectorCatalogKind;
  readonly category: string;
  readonly status: CatalogStatus;
  readonly priority: "P0" | "P1" | "P2" | "P3";
  readonly summary: string;
  readonly best_for: readonly string[];
  readonly supported_actions: readonly string[];
  readonly template_ids: readonly string[];
  readonly required_rbac_actions: readonly string[];
  readonly required_secret_refs: readonly string[];
  readonly allowed_domains: readonly string[];
  readonly manifest_permissions: ConnectorManifestPermissions;
  readonly implementation_state: string;
  readonly security_notes: readonly string[];
  readonly created_at: string;
  readonly updated_at: string;
}

export interface TemplateCatalogItem {
  readonly catalog_id: string;
  readonly template_id: string;
  readonly connector_id: string;
  readonly name: string;
  readonly kind: TemplateCatalogKind;
  readonly status: CatalogStatus;
  readonly priority: "P0" | "P1" | "P2" | "P3";
  readonly summary: string;
  readonly best_for: readonly string[];
  readonly required_params: readonly string[];
  readonly required_secret_refs: readonly string[];
  readonly produced_ir_pattern: string;
  readonly success_criteria: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ConnectorCatalogListParams extends ListParams {
  readonly kind?: ConnectorCatalogKind;
  readonly status?: CatalogStatus;
}

export interface TemplateCatalogListParams extends ListParams {
  readonly connector_id?: string;
  readonly kind?: TemplateCatalogKind;
  readonly status?: CatalogStatus;
}

export type DocumentJobStatus = "created" | "extracted" | "validation_required" | "validated" | "failed";
export type DocumentExtractionStatus = "completed" | "validation_required" | "failed";
export type DocumentFieldType = "text" | "number" | "date" | "boolean";
export type DocumentFieldStatus = "extracted" | "missing" | "low_confidence";
export type DocumentFieldSource = "json" | "csv" | "pattern" | "label" | "missing";

export interface DocumentFieldSchema {
  readonly key: string;
  readonly label?: string;
  readonly type?: DocumentFieldType;
  readonly required?: boolean;
  readonly aliases?: readonly string[];
  readonly patterns?: readonly string[];
  readonly min_confidence?: number;
}

export interface DocumentJobItem {
  readonly document_job_id: string;
  readonly source_artifact_id: string;
  readonly source_run_id: string;
  readonly document_type: string;
  readonly field_schema: readonly DocumentFieldSchema[];
  readonly status: DocumentJobStatus;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface DocumentJobListParams extends ListParams {
  readonly status?: DocumentJobStatus;
}

export interface DocumentJobCreateBody {
  readonly source_artifact_id: string;
  readonly document_type: string;
  readonly field_schema: readonly DocumentFieldSchema[];
}

export interface DocumentExtractionField {
  readonly key: string;
  readonly label: string;
  readonly value: string | null;
  readonly confidence: number;
  readonly status: DocumentFieldStatus;
  readonly source: DocumentFieldSource;
}

export interface DocumentExtraction {
  readonly document_extraction_id: string;
  readonly document_job_id: string;
  readonly engine: "built_in_deterministic_text_v1";
  readonly status: DocumentExtractionStatus;
  readonly fields: readonly DocumentExtractionField[];
  readonly missing_fields: readonly string[];
  readonly validation_human_task_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface DocumentValidationTaskResult {
  readonly human_task_id: string;
  readonly state: string;
  readonly result_schema: HumanTaskBusinessFormSchema | Record<string, unknown>;
  readonly artifact_refs: readonly string[];
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
  readonly page_state_summary?: SitePageStateSummary;
  readonly page_state_selectors?: unknown | null;
}

export interface SitePageStateSummary {
  readonly configured: boolean;
  readonly login_url_configured: boolean;
  readonly authenticated_selector_configured: boolean;
  readonly flag_count: number;
  readonly flags: readonly string[];
}

export interface SitePageStateUpdateResult {
  readonly site_profile_id: string;
  readonly page_state_selectors: unknown | null;
  readonly page_state_summary: SitePageStateSummary;
}

export type SiteElementType = "button" | "input" | "link" | "table" | "row" | "field" | "message" | "other";
export type SiteElementStability = "stable" | "review_needed" | "broken";
export type SiteElementSource = "manual" | "pbd" | "capture" | "imported";

export interface SiteElementItem {
  readonly element_id: string;
  readonly site_profile_id: string;
  readonly element_key: string;
  readonly label: string;
  readonly selector: string;
  readonly element_type: SiteElementType;
  readonly stability: SiteElementStability;
  readonly source: SiteElementSource;
  readonly sample_url: string | null;
  readonly notes: string | null;
  readonly usage_count: number;
  readonly last_verified_at: string | null;
  readonly updated_by: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface SiteElementListParams extends ListParams {
  readonly site_profile_id?: string;
  readonly stability?: SiteElementStability;
  readonly search?: string;
}

export interface SiteElementCreateBody {
  readonly element_key: string;
  readonly label: string;
  readonly selector: string;
  readonly element_type?: SiteElementType;
  readonly stability?: SiteElementStability;
  readonly source?: SiteElementSource;
  readonly sample_url?: string;
  readonly notes?: string;
}

export interface SiteElementUpdateBody {
  readonly label?: string;
  readonly selector?: string;
  readonly element_type?: SiteElementType;
  readonly stability?: SiteElementStability;
  readonly sample_url?: string | null;
  readonly notes?: string | null;
}

export type SiteElementProbeStatus = "matched" | "not_found" | "invalid_selector" | "failed" | "not_run";

export interface SiteElementProbeRequest {
  readonly sample_url?: string;
}

export interface SiteElementProbeResponse {
  readonly element_id: string;
  readonly site_profile_id: string;
  readonly selector: string;
  readonly sample_url: string | null;
  readonly probe_status: SiteElementProbeStatus;
  readonly match_count: number | null;
  readonly reason_code: string | null;
  readonly checked_at: string;
  readonly element: SiteElementItem;
}

export interface SiteElementDeleteResult {
  readonly element_id: string;
  readonly deleted: boolean;
}

export type BrowserRecordingStatus = "recording" | "completed" | "discarded" | "failed";
export type BrowserRecordingEventType = "navigate" | "click" | "input" | "select" | "submit" | "wait";

export interface BrowserRecordingValidationIssue {
  readonly rule?: string;
  readonly reason?: string;
  readonly code?: string;
  readonly nodeId?: string;
  readonly node_id?: string;
  readonly detail?: string;
  readonly message?: string;
}

export interface BrowserRecordingValidationReport {
  readonly errors: readonly BrowserRecordingValidationIssue[];
  readonly warnings: readonly BrowserRecordingValidationIssue[];
}

export interface BrowserRecordingSession {
  readonly recording_session_id: string;
  readonly site_profile_id: string;
  readonly name: string;
  readonly start_url: string;
  readonly status: BrowserRecordingStatus;
  readonly event_count: number;
  readonly draft_ir: Record<string, unknown> | null;
  readonly validation_report: BrowserRecordingValidationReport | null;
  readonly updated_by: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface BrowserRecordingListParams extends ListParams {
  readonly status?: BrowserRecordingStatus;
}

export interface BrowserRecordingStartBody {
  readonly name: string;
  readonly start_url?: string;
}

export interface BrowserRecordingEvent {
  readonly event_id: string;
  readonly recording_session_id: string;
  readonly seq: number;
  readonly event_type: BrowserRecordingEventType;
  readonly selector: string | null;
  readonly element_key: string | null;
  readonly label: string | null;
  readonly url: string | null;
  readonly value_preview: string | null;
  readonly captured_at: string;
  readonly created_at: string;
}

export interface BrowserRecordingAppendEvent {
  readonly event_type: BrowserRecordingEventType;
  readonly selector?: string;
  readonly element_key?: string;
  readonly label?: string;
  readonly url?: string;
  readonly value_preview?: string;
}

export interface BrowserRecordingAppendEventsBody {
  readonly events: readonly BrowserRecordingAppendEvent[];
}

export interface BrowserRecordingAppendResult {
  readonly recording_session_id: string;
  readonly appended: number;
  readonly event_count: number;
}

export type CaptureSessionStatus = "launching" | "awaiting_login" | "capturing" | "captured" | "failed" | "expired";

export interface CaptureSessionItem {
  readonly capture_session_id: string;
  readonly status: CaptureSessionStatus;
  readonly detail: string | null;
  readonly updated_at: string;
}

// POST /v1/sites response. New sites include default run target IDs for generation prefill.
export interface SiteCreateResult {
  readonly site_profile_id: string;
  readonly name: string;
  readonly url_pattern: string;
  readonly risk: string;
  readonly approved: boolean;
  readonly default_browser_identity_id: string;
  readonly default_network_policy_id: string;
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
  readonly scenario_id?: string;
  readonly scenario_version_id?: string;
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

export interface PromoteFromRunResult extends ScenarioMutationResult {
  readonly scenario_version_id: string;
  readonly promoted_node_ids: readonly string[];
  readonly skipped: readonly { readonly nodeId: string; readonly reason: string }[];
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
  readonly params_context?: Record<string, unknown>;
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
  readonly run_id?: string;
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

// LLM 호출 사용량/비용 집계(api-surface §6 GET /v1/gateway/call-summary). 모델별 + 전체 합계. 토큰/비용이 전부
// NULL이면 합도 null(0 단정 금지). cost는 numeric 정밀도 보존(string).
export interface GatewayCallSummaryModel {
  readonly model: string;
  readonly calls: number;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cost: string | null;
}

export interface GatewayCallSummary {
  readonly window_days: number;
  readonly total: { readonly calls: number; readonly input_tokens: number | null; readonly output_tokens: number | null; readonly cost: string | null };
  readonly by_model: readonly GatewayCallSummaryModel[];
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
