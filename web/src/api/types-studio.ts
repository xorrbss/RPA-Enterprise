import type { ListParams } from "./types-common";
import type { ScenarioMutationResult, StudioValidationStage, StudioValidationStageName } from "./types-scenarios";

export type BrowserRecordingStatus = "recording" | "completed" | "discarded" | "failed";
export type BrowserRecordingReviewStatus =
  | "not_started"
  | "review_needed"
  | "ready_for_studio"
  | "promoted_to_studio"
  | "discarded";
export type BrowserRecordingEventType = "navigate" | "click" | "input" | "select" | "submit" | "wait";
export type SelectorConfidence = "high" | "medium" | "low" | "unknown";

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
  readonly stages?: readonly StudioValidationStage[];
}

export interface BrowserRecordingReviewBlocker {
  readonly code: string;
  readonly severity: "blocker" | "warning";
  readonly stage: StudioValidationStageName;
  readonly event_seq?: number;
  readonly node_id?: string;
  readonly message: string;
}

export interface BrowserRecordingSelectorConfidence {
  readonly event_seq: number;
  readonly node_id: string;
  readonly label: string;
  readonly selector: string;
  readonly element_key: string | null;
  readonly source: "object_repository" | "recorded_selector";
  readonly confidence: SelectorConfidence;
  readonly reason_code: string;
  readonly candidates: readonly {
    readonly element_key: string;
    readonly label: string;
    readonly selector: string;
    readonly confidence: SelectorConfidence;
  }[];
}

export interface BrowserRecordingRepairSuggestion {
  readonly code: string;
  readonly event_seq?: number;
  readonly node_id?: string;
  readonly message: string;
}

export interface BrowserRecordingObjectRepoChangeset {
  readonly action: "reuse" | "candidate_create";
  readonly event_seq: number;
  readonly element_key: string | null;
  readonly label: string;
  readonly selector: string;
}

export interface BrowserRecordingReviewReport {
  readonly review_status: "review_needed" | "ready_for_studio";
  readonly blockers: readonly BrowserRecordingReviewBlocker[];
  readonly selector_confidence: readonly BrowserRecordingSelectorConfidence[];
  readonly repair_suggestions: readonly BrowserRecordingRepairSuggestion[];
  readonly object_repo_changeset: readonly BrowserRecordingObjectRepoChangeset[];
  readonly evidence: {
    readonly recording_session_id: string;
    readonly validation_stage_count: number;
    readonly event_count: number;
  };
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
  readonly review_status: BrowserRecordingReviewStatus;
  readonly review_report: BrowserRecordingReviewReport | null;
  readonly promoted_scenario_id: string | null;
  readonly promoted_scenario_version: number | null;
  readonly promoted_studio_project_id: string | null;
  readonly promoted_studio_graph_version: number | null;
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

export interface PromoteRecordingToStudioResult extends ScenarioMutationResult {
  readonly recording_session_id: string;
  readonly site_profile_id: string;
  readonly studio_project_id: string;
  readonly studio_graph_version_id: string | null;
  readonly studio_graph_version: number;
  readonly review_status: BrowserRecordingReviewStatus;
}
