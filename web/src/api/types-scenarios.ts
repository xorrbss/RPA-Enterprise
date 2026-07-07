import type { ListParams } from "./types-common";
import type { ArtifactDetail, RunArtifactItem } from "./types-runs";

export type ScenarioEnvironment = "dev" | "staging" | "prod";
export type ScenarioReleaseTarget = "staging" | "prod";
export type ScenarioReleaseStatus = "draft" | "submitted" | "approved" | "rejected" | "deployed" | "rolled_back" | "cancelled";
export type ScenarioCertificationStatus = "uncertified" | "certified" | "revoked";
export type ScenarioGovernanceStage = "dev" | "review" | "pilot" | "certified" | "deprecated";
export type ScenarioGovernanceTransitionStage = "review" | "pilot" | "deprecated";

export interface ScenarioVersionGovernanceStageBody {
  readonly stage: ScenarioGovernanceTransitionStage;
  readonly reason: string;
  readonly evidence_ref: string;
  readonly metadata?: Record<string, unknown>;
  readonly legal_hold?: boolean;
}

export interface ScenarioCertification {
  readonly status: ScenarioCertificationStatus;
  readonly governance_stage: ScenarioGovernanceStage;
  readonly governance_reason: string | null;
  readonly governance_evidence_ref: string | null;
  readonly governance_metadata: Record<string, unknown> | null;
  readonly governance_updated_by: string | null;
  readonly governance_updated_at: string | null;
  readonly certified_by: string | null;
  readonly certified_at: string | null;
  readonly expires_at: string | null;
  readonly reason: string | null;
  readonly revoked_by: string | null;
  readonly revoked_at: string | null;
  readonly revoke_reason: string | null;
  readonly valid_for_prod: boolean;
}

export interface ScenarioEnvironmentBinding {
  readonly binding_id: string;
  readonly scenario_id: string;
  readonly environment: ScenarioEnvironment;
  readonly scenario_version_id: string;
  readonly version: number;
  readonly release_id: string | null;
  readonly activated_by: string;
  readonly activated_at: string;
}

export interface ScenarioReleaseEvent {
  readonly event_id: string;
  readonly event_type: string;
  readonly actor_sub: string;
  readonly reason: string | null;
  readonly created_at: string;
}

export interface ScenarioReleaseItem {
  readonly release_id: string;
  readonly scenario_id: string;
  readonly source_version_id: string;
  readonly source_version: number;
  readonly target_environment: ScenarioReleaseTarget;
  readonly status: ScenarioReleaseStatus;
  readonly package_hash: string;
  readonly validation_report: unknown;
  readonly certification: ScenarioCertification;
  readonly requested_by: string;
  readonly requested_at: string;
  readonly submitted_at: string | null;
  readonly approved_by: string | null;
  readonly approved_at: string | null;
  readonly rejected_by: string | null;
  readonly rejected_at: string | null;
  readonly rejection_reason: string | null;
  readonly deployed_by: string | null;
  readonly deployed_at: string | null;
  readonly rollback_of_release_id: string | null;
  readonly reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly events?: readonly ScenarioReleaseEvent[];
  readonly current_binding?: ScenarioEnvironmentBinding | null;
}

export interface ScenarioItem {
  readonly scenario_id: string;
  readonly name: string;
  readonly version: number;
  readonly latest_version_id: string;
  readonly promotion_status?: string;
  readonly certification?: ScenarioCertification;
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

export type StudioValidationStageName =
  | "well_formed"
  | "runnable"
  | "operable"
  | "prod_ready";
export type StudioValidationStageStatus = "pass" | "failed" | "blocked" | "not_run";

export interface StudioValidationStage {
  readonly stage: StudioValidationStageName;
  readonly status: StudioValidationStageStatus;
  readonly reason_code: string;
  readonly detail: string;
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
  readonly certification?: ScenarioCertification;
  readonly ir?: unknown;
}

export interface ScenarioVersionItem {
  readonly version_id: string;
  readonly version: number;
  readonly promotion_status: string;
  readonly certification: ScenarioCertification;
  readonly created_at: string;
  readonly promoted_at: string | null;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly report: unknown;
  readonly stages?: readonly StudioValidationStage[];
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
