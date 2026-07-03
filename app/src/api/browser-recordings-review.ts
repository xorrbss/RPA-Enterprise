import type { StudioValidationStage, ValidationReport } from "../../../codegen/types";
import { compileScenario, studioValidationStagesFromCompile } from "./compile-pipeline";
import type {
  RecordingEventRow,
  RecordingEventType,
  RecordingReviewStatus,
  SelectorConfidence,
  SiteElementLookupRow,
} from "./browser-recordings-store";

export interface RecordingReviewBlocker {
  readonly code: string;
  readonly severity: "blocker" | "warning";
  readonly stage: "well_formed" | "runnable" | "operable" | "prod_ready";
  readonly event_seq?: number;
  readonly node_id?: string;
  readonly message: string;
}

export interface RecordingSelectorConfidence {
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

export interface RecordingRepairSuggestion {
  readonly code: string;
  readonly event_seq?: number;
  readonly node_id?: string;
  readonly message: string;
}

export interface RecordingObjectRepoChangeset {
  readonly action: "reuse" | "candidate_create";
  readonly event_seq: number;
  readonly element_key: string | null;
  readonly label: string;
  readonly selector: string;
}

export interface RecordingReviewReport {
  readonly review_status: Exclude<RecordingReviewStatus, "not_started" | "promoted_to_studio" | "discarded">;
  readonly blockers: readonly RecordingReviewBlocker[];
  readonly selector_confidence: readonly RecordingSelectorConfidence[];
  readonly repair_suggestions: readonly RecordingRepairSuggestion[];
  readonly object_repo_changeset: readonly RecordingObjectRepoChangeset[];
  readonly evidence: {
    readonly recording_session_id: string;
    readonly validation_stage_count: number;
    readonly event_count: number;
  };
}

export function assessRecordingReview(
  recordingId: string,
  events: readonly RecordingEventRow[],
  elementLookup: ReadonlyMap<string, SiteElementLookupRow>,
  validationReport: ValidationReport & { readonly stages: readonly StudioValidationStage[] },
): RecordingReviewReport {
  const blockers: RecordingReviewBlocker[] = validationReport.errors.map((issue, index) => ({
    code: "compile_error",
    severity: "blocker",
    stage: "well_formed",
    message: `Static validation error ${issue.rule ?? issue.code ?? index + 1}`,
    ...(typeof issue.nodeId === "string" ? { node_id: issue.nodeId } : {}),
  }));
  const selectorConfidence: RecordingSelectorConfidence[] = [];
  const repairSuggestions: RecordingRepairSuggestion[] = [];
  const objectRepoChangeset: RecordingObjectRepoChangeset[] = [];

  for (const event of events) {
    if (!eventNeedsSelector(event.event_type)) continue;
    const nodeId = nodeIdForSeq(event.seq);
    const element = elementLookup.get(event.id);
    const selector = element?.selector ?? event.selector;
    const label = element?.label ?? event.label ?? event.element_key ?? event.event_type;
    if (selector === null || selector === undefined || selector.trim() === "") {
      blockers.push({
        code: "selector_missing",
        severity: "blocker",
        stage: "runnable",
        event_seq: event.seq,
        node_id: nodeId,
        message: "Recorded action is missing a DOM selector.",
      });
      repairSuggestions.push({
        code: "record_step_again",
        event_seq: event.seq,
        node_id: nodeId,
        message: "Record this step again or bind it to an Object Repository element before Studio promotion.",
      });
      continue;
    }

    if (element !== undefined) {
      const confidence = confidenceForElement(element);
      selectorConfidence.push({
        event_seq: event.seq,
        node_id: nodeId,
        label,
        selector,
        element_key: element.element_key,
        source: "object_repository",
        confidence,
        reason_code: confidence === "high" ? "object_repository_stable" : "object_repository_needs_probe",
        candidates: [{ element_key: element.element_key, label: element.label, selector: element.selector, confidence }],
      });
      objectRepoChangeset.push({
        action: "reuse",
        event_seq: event.seq,
        element_key: element.element_key,
        label: element.label,
        selector: element.selector,
      });
      if (confidence === "low" || confidence === "unknown") {
        blockers.push({
          code: "selector_confidence_low",
          severity: "blocker",
          stage: "runnable",
          event_seq: event.seq,
          node_id: nodeId,
          message: "Object Repository selector is broken or unverified.",
        });
      }
      continue;
    }

    selectorConfidence.push({
      event_seq: event.seq,
      node_id: nodeId,
      label,
      selector,
      element_key: event.element_key,
      source: "recorded_selector",
      confidence: "medium",
      reason_code: "recorded_selector_not_in_repository",
      candidates: [],
    });
    objectRepoChangeset.push({
      action: "candidate_create",
      event_seq: event.seq,
      element_key: event.element_key,
      label,
      selector,
    });
    repairSuggestions.push({
      code: "promote_selector_to_object_repository",
      event_seq: event.seq,
      node_id: nodeId,
      message: "Add this recorded selector to the Object Repository and run a probe to raise confidence.",
    });
  }

  return {
    review_status: blockers.some((blocker) => blocker.severity === "blocker") ? "review_needed" : "ready_for_studio",
    blockers,
    selector_confidence: selectorConfidence,
    repair_suggestions: repairSuggestions,
    object_repo_changeset: objectRepoChangeset,
    evidence: {
      recording_session_id: recordingId,
      validation_stage_count: validationReport.stages.length,
      event_count: events.length,
    },
  };
}

function eventNeedsSelector(eventType: RecordingEventType): boolean {
  return eventType === "click" || eventType === "input" || eventType === "select" || eventType === "submit";
}

function nodeIdForSeq(seq: number): string {
  return `step_${String(seq).padStart(2, "0")}`;
}

function confidenceForElement(element: SiteElementLookupRow): SelectorConfidence {
  if (element.confidence !== "unknown") return element.confidence;
  if (element.stability === "stable") return "high";
  if (element.stability === "review_needed") return "medium";
  return "low";
}

export function validateDraftIr(
  draftIr: unknown,
  signedCommandRefs: readonly string[] | undefined,
): { readonly valid: boolean; readonly report: ValidationReport & { readonly stages: readonly StudioValidationStage[] } } {
  const outcome = compileScenario(draftIr, { signedCommandRefs });
  const stages = studioValidationStagesFromCompile(outcome);
  if (outcome.ok) return { valid: true, report: { ...outcome.report, stages } };
  if (outcome.report !== undefined) return { valid: false, report: { ...outcome.report, stages } };
  return {
    valid: false,
    report: {
      errors: [{
        rule: "V1",
        reason: "schema_invalid",
        code: outcome.code,
        detail: safeDetail(outcome.details),
      }],
      warnings: [],
      stages,
    },
  };
}

function safeDetail(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 2000);
  } catch {
    return "schema validation failed";
  }
}
