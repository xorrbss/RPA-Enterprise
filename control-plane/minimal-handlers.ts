import type {
  ControlPlaneHandler,
  ControlPlaneRequestContext,
  ControlPlaneResponse,
} from "../ts/control-plane-contract";
import type { ControlPlaneHandlerMap } from "./operation-registry";
import type { ApiErrorResponseCode } from "./errors";
import { ApiResponseException } from "./errors";
import type {
  ArtifactAccessGate,
  ArtifactAccessSubject,
  ArtifactRedactionStatus,
  IsoDateTime,
  RunId,
  TenantId,
} from "../ts/security-middleware-contract";
import type { HumanTaskKind, HumanTaskState, RunState, WorkitemState } from "../ts/state-machine-types";
import { HUMANTASK_TERMINAL, RUN_TERMINAL } from "../ts/state-machine-types";

export interface MinimalRun {
  run_id: string;
  tenant_id: string;
  scenario_id: string;
  scenario_version_id: string;
  status: RunState;
  attempts: number;
  as_of: string;
  workitem_id?: string;
  worker_id?: string | null;
  progress_node?: string | null;
}

export interface MinimalHumanTask {
  human_task_id: string;
  tenant_id: string;
  state: HumanTaskState;
  kind: HumanTaskKind;
  assignee?: string;
  assignee_role?: string;
  run_id?: string;
  timeout_at?: string;
  on_timeout?: "fail" | "escalate";
  payload?: unknown;
}

export interface MinimalWorkitem {
  workitem_id: string;
  tenant_id: string;
  status: WorkitemState;
  attempts: number;
  unique_reference?: string;
  checked_out_by?: string | null;
  checked_out_at?: string | null;
  run_id?: string;
  target_id?: string;
}

export interface MinimalArtifact {
  artifact_id: string;
  tenant_id: string;
  run_id?: string;
  step_id?: string | null;
  attempt?: number | null;
  type?: string;
  media_type?: string | null;
  filename?: string | null;
  byte_size?: number | null;
  duration_ms?: number | null;
  redaction_status: ArtifactRedactionStatus;
  retention_until?: string | null;
  legal_hold?: boolean;
  created_at?: string;
  deleted_at?: string;
  quarantine?: boolean;
  ref: string;
  body: unknown;
}

export interface MinimalRunStep {
  step_id: string;
  tenant_id: string;
  run_id: string;
  node_id: string;
  action: string;
  status: string;
  attempt?: number;
  cache_mode?: string;
  started_at?: string | null;
  ended_at?: string | null;
  duration_ms?: number | null;
  artifact_ids?: readonly string[];
  stagehand_calls?: readonly Record<string, unknown>[];
  exception?: { class?: string; code?: string } | null;
}

export interface MinimalRunTrigger {
  trigger_id: string;
  tenant_id: string;
  scenario_version_id: string;
  trigger_type: "cron" | "webhook";
  status: "enabled" | "paused" | "archived";
  cron_expression: string | null;
  timezone: string | null;
  webhook_secret_ref: string | null;
  webhook_secret_configured: boolean;
  params: Readonly<Record<string, unknown>>;
  catchup_policy: "skip_missed" | "fire_once";
  max_concurrent_runs: number;
  next_fire_at?: string | null;
  created_by?: string;
  created_at?: string;
  updated_at?: string;
}

export interface MinimalRunTriggerFire {
  fire_id: string;
  tenant_id: string;
  trigger_id: string;
  fire_key: string;
  status: "queued" | "skipped" | "failed";
  scheduled_for: string;
  run_id?: string | null;
  failure_reason?: unknown;
  created_at?: string;
}

export type MinimalAutomationIdeaStage =
  | "intake"
  | "assess"
  | "approved"
  | "build"
  | "operate"
  | "rejected"
  | "archived";

export interface MinimalAutomationIdea {
  id: string;
  tenant_id: string;
  title: string;
  description: string;
  business_owner: string;
  department: string;
  source: "manual" | "process_mining" | "task_mining" | "imported";
  stage: MinimalAutomationIdeaStage;
  priority: "low" | "medium" | "high" | "critical";
  score: number;
  scenario_id?: string | null;
  run_trigger_id?: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface MinimalRoiEstimate {
  id: string;
  tenant_id: string;
  automation_idea_id: string;
  frequency_per_month: number;
  minutes_per_case: number;
  exception_rate: number;
  hourly_cost: number;
  implementation_effort: number;
  monthly_hours_saved: number;
  estimated_monthly_value: number;
  payback_months: number | null;
  confidence: "low" | "medium" | "high";
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface MinimalAuditLogItem {
  audit_id: string;
  tenant_id: string;
  sequence_no: number;
  actor: { subject_id: string | null; roles: readonly string[] };
  action: string;
  outcome: "allow" | "deny" | "blocked" | "error";
  reason?: string | null;
  correlation_id: string;
  idempotency_key: string;
  occurred_at: string;
  payload_schema_ref: string;
  retention_until?: string | null;
  legal_hold?: boolean;
  previous_hash?: string | null;
  hash: string;
  created_at?: string;
}

export interface MinimalConnectorCatalogItem {
  catalog_id: string;
  connector_id: string;
  name: string;
  kind: "browser" | "api" | "file" | "notification" | "data";
  status: "available" | "candidate" | "requires_admin" | "blocked";
}

export interface MinimalTemplateCatalogItem {
  catalog_id: string;
  template_id: string;
  connector_id: string;
  name: string;
  kind: "browser_workflow" | "api_workflow" | "file_workflow" | "notification_workflow";
  status: "available" | "candidate" | "requires_admin" | "blocked";
}

export interface MinimalGatewayPolicy {
  id: string;
  tenant_id: string;
  model: string;
  version: number;
  capabilities: Readonly<Record<string, unknown>>;
  budget: Readonly<Record<string, unknown>>;
  fallback_config?: unknown;
  is_default?: boolean;
}

export interface MinimalSite {
  site_profile_id: string;
  tenant_id: string;
  risk: "red" | "amber" | "green";
  approved: boolean;
  approval_reason?: string;
  approval_expires_at?: string;
  circuit_state?: "closed" | "open" | "half_open";
  page_state_selectors?: unknown;
}

export interface MinimalSiteElement {
  element_id: string;
  tenant_id: string;
  site_profile_id: string;
  element_key: string;
  label: string;
  selector: string;
  element_type: "button" | "input" | "link" | "table" | "row" | "field" | "message" | "other";
  stability: "stable" | "review_needed" | "broken";
  source: "manual" | "pbd" | "capture" | "imported";
  sample_url?: string | null;
  notes?: string | null;
  usage_count?: number;
  last_verified_at?: string | null;
  updated_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface MinimalCaptureSession {
  capture_session_id: string;
  tenant_id: string;
  site_profile_id: string;
  status: "launching" | "awaiting_login" | "capturing" | "captured" | "failed" | "expired";
  detail?: string | null;
  updated_at?: string;
}

export type MinimalBrowserRecordingStatus = "recording" | "completed" | "discarded" | "failed";
export type MinimalBrowserRecordingEventType = "navigate" | "click" | "input" | "select" | "submit" | "wait";

export interface MinimalBrowserRecordingSession {
  recording_session_id: string;
  tenant_id: string;
  site_profile_id: string;
  name: string;
  start_url: string;
  status: MinimalBrowserRecordingStatus;
  event_count: number;
  draft_ir?: unknown;
  validation_report?: unknown;
  updated_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface MinimalBrowserRecordingEvent {
  event_id: string;
  tenant_id: string;
  recording_session_id: string;
  seq: number;
  event_type: MinimalBrowserRecordingEventType;
  selector?: string | null;
  element_key?: string | null;
  label?: string | null;
  url?: string | null;
  value_preview?: string | null;
  captured_at?: string;
  created_at?: string;
}

export type MinimalDocumentJobStatus = "created" | "extracted" | "validation_required" | "validated" | "failed";
export type MinimalDocumentExtractionStatus = "completed" | "validation_required" | "failed";

export interface MinimalDocumentFieldSchema {
  key: string;
  label?: string;
  type?: "text" | "number" | "date" | "boolean";
  required?: boolean;
  aliases?: readonly string[];
  patterns?: readonly string[];
  min_confidence?: number;
}

export interface MinimalDocumentJob {
  document_job_id: string;
  tenant_id: string;
  source_artifact_id: string;
  source_run_id: string;
  document_type: string;
  field_schema: readonly MinimalDocumentFieldSchema[];
  status: MinimalDocumentJobStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface MinimalDocumentExtraction {
  document_extraction_id: string;
  tenant_id: string;
  document_job_id: string;
  engine: "built_in_deterministic_text_v1";
  status: MinimalDocumentExtractionStatus;
  fields: readonly Record<string, unknown>[];
  missing_fields: readonly string[];
  validation_human_task_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MinimalControlPlaneSeed {
  runs?: readonly MinimalRun[];
  humanTasks?: readonly MinimalHumanTask[];
  workitems?: readonly MinimalWorkitem[];
  artifacts?: readonly MinimalArtifact[];
  runSteps?: readonly MinimalRunStep[];
  runTriggers?: readonly MinimalRunTrigger[];
  runTriggerFires?: readonly MinimalRunTriggerFire[];
  automationIdeas?: readonly MinimalAutomationIdea[];
  roiEstimates?: readonly MinimalRoiEstimate[];
  auditLog?: readonly MinimalAuditLogItem[];
  connectors?: readonly MinimalConnectorCatalogItem[];
  templates?: readonly MinimalTemplateCatalogItem[];
  documentJobs?: readonly MinimalDocumentJob[];
  documentExtractions?: readonly MinimalDocumentExtraction[];
  gatewayPolicies?: readonly MinimalGatewayPolicy[];
  sites?: readonly MinimalSite[];
  siteElements?: readonly MinimalSiteElement[];
  captureSessions?: readonly MinimalCaptureSession[];
  browserRecordingSessions?: readonly MinimalBrowserRecordingSession[];
  browserRecordingEvents?: readonly MinimalBrowserRecordingEvent[];
}

export interface MinimalControlPlaneServices {
  getAuthReadiness(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  createRun(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  getRun(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listRuns(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listRunSteps(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  streamRunSteps(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listRunArtifacts(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  abortRun(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listRunTriggers(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  createRunTrigger(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  getRunTrigger(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  updateRunTrigger(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  pauseRunTrigger(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  resumeRunTrigger(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listRunTriggerFires(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listOpsAlerts(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  getOpsHealth(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listAutomationIdeas(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  createAutomationIdea(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  getAutomationIdea(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  updateAutomationIdea(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  transitionAutomationIdea(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  upsertRoiEstimate(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  getRoiEstimate(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listAuditLog(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  exportAuditLog(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listConnectors(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listTemplates(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listDocumentJobs(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  createDocumentJob(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  getDocumentJob(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  extractDocumentJob(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  getDocumentExtraction(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  createDocumentValidationTask(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  validateScenario(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  promoteScenario(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  promoteScenarioFromRun(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  archiveScenario(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listScenarioVersions(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  getScenarioVersion(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  rollbackScenario(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listHumanTasks(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  startHumanTask(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  resolveHumanTask(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  assignHumanTask(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  escalateHumanTask(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listWorkitems(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  replayDeadLetter(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  getArtifact(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listGatewayPolicies(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  getGatewayPolicy(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  createGatewayPolicy(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  updateGatewayPolicy(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  deleteGatewayPolicy(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listSites(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  approveSite(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listSessionCaptures(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  updateSitePageState(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listSiteElements(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  createSiteElement(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  updateSiteElement(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  probeSiteElement(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  deleteSiteElement(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listBrowserRecordings(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  startBrowserRecording(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listBrowserRecordingEvents(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  appendBrowserRecordingEvents(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  completeBrowserRecording(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
}

export class InMemoryControlPlaneServices implements MinimalControlPlaneServices {
  private runSequence = 0;
  private triggerSequence = 0;
  private ideaSequence = 0;
  private roiSequence = 0;
  private documentJobSequence = 0;
  private documentExtractionSequence = 0;
  private documentTaskSequence = 0;
  private recordingSequence = 0;
  private recordingEventSequence = 0;
  private readonly runs = new Map<string, MinimalRun>();
  private readonly humanTasks = new Map<string, MinimalHumanTask>();
  private readonly workitems = new Map<string, MinimalWorkitem>();
  private readonly artifacts = new Map<string, MinimalArtifact>();
  private readonly runSteps: MinimalRunStep[] = [];
  private readonly runTriggers = new Map<string, MinimalRunTrigger>();
  private readonly runTriggerFires: MinimalRunTriggerFire[] = [];
  private readonly automationIdeas = new Map<string, MinimalAutomationIdea>();
  private readonly roiEstimates = new Map<string, MinimalRoiEstimate>();
  private readonly auditLog: MinimalAuditLogItem[] = [];
  private readonly connectors: MinimalConnectorCatalogItem[] = [];
  private readonly templates: MinimalTemplateCatalogItem[] = [];
  private readonly documentJobs = new Map<string, MinimalDocumentJob>();
  private readonly documentExtractions = new Map<string, MinimalDocumentExtraction>();
  private readonly gatewayPolicies = new Map<string, MinimalGatewayPolicy>();
  private readonly sites = new Map<string, MinimalSite>();
  private readonly siteElements = new Map<string, MinimalSiteElement>();
  private readonly captureSessions: MinimalCaptureSession[] = [];
  private readonly browserRecordingSessions = new Map<string, MinimalBrowserRecordingSession>();
  private readonly browserRecordingEvents: MinimalBrowserRecordingEvent[] = [];
  private readonly artifactGate: ArtifactAccessGate;

  constructor(artifactGate: ArtifactAccessGate, seed: MinimalControlPlaneSeed = {}) {
    this.artifactGate = artifactGate;
    for (const run of seed.runs ?? []) this.runs.set(key(run.tenant_id, run.run_id), { ...run });
    for (const task of seed.humanTasks ?? []) {
      this.humanTasks.set(key(task.tenant_id, task.human_task_id), { ...task });
    }
    for (const item of seed.workitems ?? []) this.workitems.set(key(item.tenant_id, item.workitem_id), { ...item });
    for (const artifact of seed.artifacts ?? []) {
      this.artifacts.set(key(artifact.tenant_id, artifact.artifact_id), { ...artifact });
    }
    this.runSteps.push(...(seed.runSteps ?? []).map((step) => ({ ...step })));
    for (const trigger of seed.runTriggers ?? []) {
      this.runTriggers.set(key(trigger.tenant_id, trigger.trigger_id), { ...trigger });
    }
    this.runTriggerFires.push(...(seed.runTriggerFires ?? []).map((fire) => ({ ...fire })));
    for (const idea of seed.automationIdeas ?? []) {
      this.automationIdeas.set(key(idea.tenant_id, idea.id), { ...idea });
    }
    for (const roi of seed.roiEstimates ?? []) {
      this.roiEstimates.set(key(roi.tenant_id, roi.automation_idea_id), { ...roi });
    }
    this.auditLog.push(...(seed.auditLog ?? []).map((row) => ({ ...row })));
    this.connectors.push(...(seed.connectors ?? []).map((row) => ({ ...row })));
    this.templates.push(...(seed.templates ?? []).map((row) => ({ ...row })));
    for (const job of seed.documentJobs ?? []) {
      this.documentJobs.set(key(job.tenant_id, job.document_job_id), { ...job });
    }
    for (const extraction of seed.documentExtractions ?? []) {
      this.documentExtractions.set(key(extraction.tenant_id, extraction.document_job_id), { ...extraction });
    }
    for (const policy of seed.gatewayPolicies ?? []) {
      this.gatewayPolicies.set(key(policy.tenant_id, policy.model), { ...policy });
    }
    for (const site of seed.sites ?? []) this.sites.set(key(site.tenant_id, site.site_profile_id), { ...site });
    for (const element of seed.siteElements ?? []) this.siteElements.set(key(element.tenant_id, element.element_id), { ...element });
    this.captureSessions.push(...(seed.captureSessions ?? []).map((session) => ({ ...session })));
    for (const session of seed.browserRecordingSessions ?? []) {
      this.browserRecordingSessions.set(key(session.tenant_id, session.recording_session_id), { ...session });
    }
    this.browserRecordingEvents.push(...(seed.browserRecordingEvents ?? []).map((event) => ({ ...event })));
  }

  async getAuthReadiness(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    return { status: 200, body: minimalAuthReadiness(ctx) };
  }

  async createRun(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const body = requireBody(ctx);
    const runId = `run-${++this.runSequence}`;
    const params = requireRecord(body, "params");
    const asOf = typeof params.as_of === "string" ? params.as_of : new Date().toISOString();
    const scenarioVersionId = requireString(body, "scenario_version_id");
    const run: MinimalRun = {
      run_id: runId,
      tenant_id: tenant(ctx),
      scenario_id: scenarioIdFromVersionId(scenarioVersionId),
      scenario_version_id: scenarioVersionId,
      status: "queued",
      attempts: 0,
      as_of: asOf,
      workitem_id: optionalString(body, "workitem_id"),
      worker_id: null,
      progress_node: null,
    };
    this.runs.set(key(run.tenant_id, run.run_id), run);
    return { status: 201, body: run };
  }

  async getRun(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const run = this.runs.get(key(tenant(ctx), requireParam(ctx, "run_id")));
    if (run === undefined) throw new ApiResponseException("RUN_NOT_FOUND");
    return { status: 200, body: run };
  }

  async listRuns(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const status = optionalQueryString(ctx, "status");
    const scenarioVersionId = optionalQueryString(ctx, "scenario_version_id");
    const items = [...this.runs.values()].filter(
      (run) =>
        run.tenant_id === tenant(ctx) &&
        (status === undefined || run.status === status) &&
        (scenarioVersionId === undefined || run.scenario_version_id === scenarioVersionId),
    );
    return page(items);
  }

  async listRunSteps(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const runId = requireParam(ctx, "run_id");
    const items = this.runSteps
      .filter((step) => step.tenant_id === tenant(ctx) && step.run_id === runId)
      .map((step) => ({
        step_id: step.step_id,
        node_id: step.node_id,
        action: step.action,
        status: step.status,
        attempt: step.attempt ?? 0,
        cache_mode: step.cache_mode ?? "bypass",
        started_at: step.started_at ?? null,
        ended_at: step.ended_at ?? null,
        duration_ms: step.duration_ms ?? null,
        artifact_ids: step.artifact_ids ?? [],
        stagehand_calls: step.stagehand_calls ?? [],
        exception:
          step.exception === undefined || step.exception === null
            ? null
            : {
                class: step.exception.class ?? "system",
                code: step.exception.code ?? "UNKNOWN",
              },
      }));
    return page(items);
  }

  async streamRunSteps(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const runId = requireParam(ctx, "run_id");
    const run = this.runs.get(key(tenant(ctx), runId));
    const stepCount = this.runSteps.filter((step) => step.tenant_id === tenant(ctx) && step.run_id === runId).length;
    return {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body:
        `event: run_steps_changed\n` +
        `data: ${JSON.stringify({ run_id: runId, status: run?.status ?? null, step_count: stepCount })}\n\n` +
        `event: run_steps_closed\n` +
        `data: ${JSON.stringify({ run_id: runId, status: run?.status ?? null })}\n\n`,
    };
  }

  async listRunArtifacts(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const runId = requireParam(ctx, "run_id");
    const items = [...this.artifacts.values()]
      .filter(
        (artifact) =>
          artifact.tenant_id === tenant(ctx) &&
          artifact.run_id === runId &&
          artifact.deleted_at === undefined &&
          artifact.quarantine !== true &&
          (artifact.redaction_status === "redacted" || artifact.redaction_status === "not_required"),
      )
      .map((artifact) => ({
        artifact_id: artifact.artifact_id,
        step_id: artifact.step_id ?? null,
        attempt: artifact.attempt ?? null,
        type: artifact.type ?? "artifact",
        media_type: artifact.media_type ?? null,
        filename: artifact.filename ?? null,
        byte_size: artifact.byte_size ?? null,
        duration_ms: artifact.duration_ms ?? null,
        redaction_status: artifact.redaction_status,
        retention_until: artifact.retention_until ?? null,
        legal_hold: artifact.legal_hold ?? false,
        created_at: artifact.created_at ?? "1970-01-01T00:00:00.000Z",
      }));
    return page(items);
  }

  async abortRun(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const run = this.runs.get(key(tenant(ctx), requireParam(ctx, "run_id")));
    if (run === undefined) throw new ApiResponseException("RUN_NOT_FOUND");
    if (RUN_TERMINAL.includes(run.status) || run.status === "completing") {
      throw new ApiResponseException("RUN_ALREADY_TERMINAL");
    }
    if (run.status === "suspending") {
      throw new ApiResponseException("WORKITEM_CHECKOUT_CONFLICT", {
        reason: "run_bookmark_in_progress",
        status: run.status,
      });
    }

    run.status = "cancelled";
    this.runs.set(key(run.tenant_id, run.run_id), run);
    return { status: 202, body: run };
  }

  async listRunTriggers(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const status = optionalQueryString(ctx, "status");
    const items = [...this.runTriggers.values()].filter(
      (trigger) => trigger.tenant_id === tenant(ctx) && (status === undefined || trigger.status === status),
    );
    return page(items);
  }

  async createRunTrigger(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const body = requireBody(ctx);
    const now = new Date().toISOString();
    const params = body.params === undefined ? {} : requireRecord(body, "params");
    const triggerType = body.trigger_type === "webhook" ? "webhook" : "cron";
    const trigger: MinimalRunTrigger = {
      trigger_id: `trigger-${++this.triggerSequence}`,
      tenant_id: tenant(ctx),
      scenario_version_id: requireString(body, "scenario_version_id"),
      trigger_type: triggerType,
      status: "enabled",
      cron_expression: triggerType === "webhook" ? null : requireString(body, "cron_expression"),
      timezone: triggerType === "webhook" ? null : requireString(body, "timezone"),
      webhook_secret_ref: triggerType === "webhook" ? requireString(body, "webhook_secret_ref") : null,
      webhook_secret_configured: triggerType === "webhook",
      params,
      catchup_policy: optionalCatchupPolicy(body) ?? "skip_missed",
      max_concurrent_runs: optionalPositiveInteger(body, "max_concurrent_runs") ?? 1,
      next_fire_at: triggerType === "webhook" ? null : optionalString(body, "next_fire_at") ?? null,
      created_by: ctx.principal.subjectId,
      created_at: now,
      updated_at: now,
    };
    this.runTriggers.set(key(trigger.tenant_id, trigger.trigger_id), trigger);
    return { status: 201, body: trigger };
  }

  async getRunTrigger(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    return { status: 200, body: this.requireRunTrigger(ctx) };
  }

  async updateRunTrigger(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const trigger = this.requireRunTrigger(ctx);
    const body = requireBody(ctx);
    const updated: MinimalRunTrigger = {
      ...trigger,
      cron_expression: trigger.trigger_type === "webhook" ? null : optionalString(body, "cron_expression") ?? trigger.cron_expression,
      timezone: trigger.trigger_type === "webhook" ? null : optionalString(body, "timezone") ?? trigger.timezone,
      webhook_secret_ref: trigger.trigger_type === "webhook" ? optionalString(body, "webhook_secret_ref") ?? trigger.webhook_secret_ref : null,
      webhook_secret_configured: trigger.trigger_type === "webhook" && (optionalString(body, "webhook_secret_ref") ?? trigger.webhook_secret_ref) !== null,
      params: body.params === undefined ? trigger.params : requireRecord(body, "params"),
      catchup_policy: optionalCatchupPolicy(body) ?? trigger.catchup_policy,
      max_concurrent_runs: optionalPositiveInteger(body, "max_concurrent_runs") ?? trigger.max_concurrent_runs,
      next_fire_at: trigger.trigger_type === "webhook" ? null : body.next_fire_at === null ? null : optionalString(body, "next_fire_at") ?? trigger.next_fire_at ?? null,
      updated_at: new Date().toISOString(),
    };
    this.runTriggers.set(key(updated.tenant_id, updated.trigger_id), updated);
    return { status: 200, body: updated };
  }

  async pauseRunTrigger(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const trigger = this.requireRunTrigger(ctx);
    const updated: MinimalRunTrigger = { ...trigger, status: "paused", updated_at: new Date().toISOString() };
    this.runTriggers.set(key(updated.tenant_id, updated.trigger_id), updated);
    return { status: 200, body: updated };
  }

  async resumeRunTrigger(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const trigger = this.requireRunTrigger(ctx);
    const updated: MinimalRunTrigger = { ...trigger, status: "enabled", updated_at: new Date().toISOString() };
    this.runTriggers.set(key(updated.tenant_id, updated.trigger_id), updated);
    return { status: 200, body: updated };
  }

  async listRunTriggerFires(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const triggerId = requireParam(ctx, "trigger_id");
    const items = this.runTriggerFires.filter(
      (fire) => fire.tenant_id === tenant(ctx) && fire.trigger_id === triggerId,
    );
    return page(items);
  }

  async listOpsAlerts(_ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    return page([]);
  }

  async getOpsHealth(_ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    return {
      status: 200,
      body: {
        status: "ok",
        detected_at: new Date().toISOString(),
        queue: { available: false, pending_jobs: null },
        browser_leases: { reserved: 0, active: 0, draining: 0, expired: 0, expired_open: 0, next_expiry_at: null },
        stale_runs: { nonterminal_over_15m: 0, oldest_updated_at: null },
      },
    };
  }

  async listAutomationIdeas(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const stage = optionalQueryString(ctx, "stage");
    const owner = optionalQueryString(ctx, "owner");
    const department = optionalQueryString(ctx, "department");
    const items = [...this.automationIdeas.values()].filter((idea) =>
      idea.tenant_id === tenant(ctx)
      && (stage === undefined || idea.stage === stage)
      && (owner === undefined || idea.business_owner === owner)
      && (department === undefined || idea.department === department),
    );
    return page(items);
  }

  async createAutomationIdea(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const body = requireBody(ctx);
    const now = new Date().toISOString();
    const idea: MinimalAutomationIdea = {
      id: `idea-${++this.ideaSequence}`,
      tenant_id: tenant(ctx),
      title: requireString(body, "title"),
      description: requireString(body, "description"),
      business_owner: requireString(body, "business_owner"),
      department: requireString(body, "department"),
      source: optionalAutomationSource(body) ?? "manual",
      stage: "intake",
      priority: optionalAutomationPriority(body) ?? "medium",
      score: optionalScore(body) ?? 0,
      scenario_id: optionalString(body, "scenario_id") ?? null,
      run_trigger_id: optionalString(body, "run_trigger_id") ?? null,
      created_by: ctx.principal.subjectId,
      created_at: now,
      updated_at: now,
    };
    this.automationIdeas.set(key(idea.tenant_id, idea.id), idea);
    return { status: 201, body: idea };
  }

  async getAutomationIdea(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    return { status: 200, body: this.requireAutomationIdea(ctx) };
  }

  async updateAutomationIdea(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const idea = this.requireAutomationIdea(ctx);
    const body = requireBody(ctx);
    const updated: MinimalAutomationIdea = {
      ...idea,
      title: optionalString(body, "title") ?? idea.title,
      description: optionalString(body, "description") ?? idea.description,
      business_owner: optionalString(body, "business_owner") ?? idea.business_owner,
      department: optionalString(body, "department") ?? idea.department,
      priority: optionalAutomationPriority(body) ?? idea.priority,
      score: optionalScore(body) ?? idea.score,
      scenario_id: body.scenario_id === null ? null : optionalString(body, "scenario_id") ?? idea.scenario_id ?? null,
      run_trigger_id: body.run_trigger_id === null
        ? null
        : optionalString(body, "run_trigger_id") ?? idea.run_trigger_id ?? null,
      updated_at: new Date().toISOString(),
    };
    this.automationIdeas.set(key(updated.tenant_id, updated.id), updated);
    return { status: 200, body: updated };
  }

  async transitionAutomationIdea(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const idea = this.requireAutomationIdea(ctx);
    const targetStage = requireAutomationStage(requireBody(ctx), "stage");
    if (!allowedAutomationTransitions(idea.stage).includes(targetStage)) {
      throw new ApiResponseException("IR_SCHEMA_INVALID", {
        reason: "illegal_automation_idea_transition",
        from: idea.stage,
        to: targetStage,
      });
    }
    const updated: MinimalAutomationIdea = { ...idea, stage: targetStage, updated_at: new Date().toISOString() };
    this.automationIdeas.set(key(updated.tenant_id, updated.id), updated);
    return { status: 200, body: updated };
  }

  async upsertRoiEstimate(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const idea = this.requireAutomationIdea(ctx);
    const body = requireBody(ctx);
    const now = new Date().toISOString();
    const frequencyPerMonth = requireFiniteNumber(body, "frequency_per_month");
    const minutesPerCase = requireFiniteNumber(body, "minutes_per_case");
    const exceptionRate = requireFiniteNumber(body, "exception_rate");
    const hourlyCost = requireFiniteNumber(body, "hourly_cost");
    const implementationEffort = requireFiniteNumber(body, "implementation_effort");
    const monthlyHoursSaved = (frequencyPerMonth * minutesPerCase * (1 - exceptionRate)) / 60;
    const estimatedMonthlyValue = monthlyHoursSaved * hourlyCost;
    const existing = this.roiEstimates.get(key(tenant(ctx), idea.id));
    const estimate: MinimalRoiEstimate = {
      id: existing?.id ?? `roi-${++this.roiSequence}`,
      tenant_id: tenant(ctx),
      automation_idea_id: idea.id,
      frequency_per_month: frequencyPerMonth,
      minutes_per_case: minutesPerCase,
      exception_rate: exceptionRate,
      hourly_cost: hourlyCost,
      implementation_effort: implementationEffort,
      monthly_hours_saved: monthlyHoursSaved,
      estimated_monthly_value: estimatedMonthlyValue,
      payback_months: estimatedMonthlyValue > 0 ? implementationEffort / estimatedMonthlyValue : null,
      confidence: optionalRoiConfidence(body) ?? "medium",
      created_by: existing?.created_by ?? ctx.principal.subjectId,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.roiEstimates.set(key(estimate.tenant_id, estimate.automation_idea_id), estimate);
    return { status: 200, body: estimate };
  }

  async getRoiEstimate(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const ideaId = requireParam(ctx, "idea_id");
    const estimate = this.roiEstimates.get(key(tenant(ctx), ideaId));
    if (estimate === undefined) throw new ApiResponseException("RESOURCE_NOT_FOUND");
    return { status: 200, body: estimate };
  }

  async listAuditLog(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    return page(this.filteredAuditLog(ctx));
  }

  async exportAuditLog(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const format = optionalQueryString(ctx, "format");
    if (format !== undefined && format !== "csv") throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "invalid_export_format" });
    return {
      status: 200,
      headers: { "content-type": "text/csv; charset=utf-8" },
      body: auditCsv(this.filteredAuditLog(ctx)),
    };
  }

  private filteredAuditLog(ctx: ControlPlaneRequestContext): MinimalAuditLogItem[] {
    const action = optionalQueryString(ctx, "action");
    const outcome = optionalQueryString(ctx, "outcome");
    const actor = optionalQueryString(ctx, "actor");
    const correlationId = optionalQueryString(ctx, "correlation_id");
    return this.auditLog.filter((row) =>
      row.tenant_id === tenant(ctx)
      && (action === undefined || row.action === action)
      && (outcome === undefined || row.outcome === outcome)
      && (actor === undefined || row.actor.subject_id === actor)
      && (correlationId === undefined || row.correlation_id === correlationId),
    );
  }

  async listConnectors(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const kind = optionalQueryString(ctx, "kind");
    const status = optionalQueryString(ctx, "status");
    const items = this.connectors.filter((row) =>
      (kind === undefined || row.kind === kind)
      && (status === undefined || row.status === status),
    );
    return page(items);
  }

  async listTemplates(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const kind = optionalQueryString(ctx, "kind");
    const status = optionalQueryString(ctx, "status");
    const connectorId = optionalQueryString(ctx, "connector_id");
    const items = this.templates.filter((row) =>
      (kind === undefined || row.kind === kind)
      && (status === undefined || row.status === status)
      && (connectorId === undefined || row.connector_id === connectorId),
    );
    return page(items);
  }

  async listDocumentJobs(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const status = optionalQueryString(ctx, "status");
    const items = [...this.documentJobs.values()].filter(
      (job) => job.tenant_id === tenant(ctx) && (status === undefined || job.status === status),
    );
    return page(items);
  }

  async createDocumentJob(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const body = requireBody(ctx);
    const sourceArtifactId = requireString(body, "source_artifact_id");
    const artifact = this.artifacts.get(key(tenant(ctx), sourceArtifactId));
    if (
      artifact === undefined
      || artifact.deleted_at !== undefined
      || artifact.quarantine === true
      || (artifact.redaction_status !== "redacted" && artifact.redaction_status !== "not_required")
    ) {
      throw new ApiResponseException("RESOURCE_NOT_FOUND");
    }
    const mediaType = artifact.media_type?.split(";")[0]?.trim().toLowerCase();
    if (mediaType === undefined || (!mediaType.startsWith("text/") && mediaType !== "application/json" && mediaType !== "application/csv")) {
      throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "unsupported_document_artifact_media_type" });
    }
    if (artifact.run_id === undefined) {
      throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "source_artifact_requires_run" });
    }
    const now = new Date().toISOString();
    const job: MinimalDocumentJob = {
      document_job_id: `document-job-${++this.documentJobSequence}`,
      tenant_id: tenant(ctx),
      source_artifact_id: sourceArtifactId,
      source_run_id: artifact.run_id,
      document_type: requireString(body, "document_type"),
      field_schema: requireDocumentFieldSchema(body),
      status: "created",
      created_by: ctx.principal.subjectId,
      created_at: now,
      updated_at: now,
    };
    this.documentJobs.set(key(job.tenant_id, job.document_job_id), job);
    return { status: 201, body: job };
  }

  async getDocumentJob(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    return { status: 200, body: this.requireDocumentJob(ctx) };
  }

  async extractDocumentJob(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const job = this.requireDocumentJob(ctx);
    const now = new Date().toISOString();
    const missingFields = job.field_schema.filter((field) => field.required === true).map((field) => field.key);
    const extraction: MinimalDocumentExtraction = {
      document_extraction_id: `document-extraction-${++this.documentExtractionSequence}`,
      tenant_id: tenant(ctx),
      document_job_id: job.document_job_id,
      engine: "built_in_deterministic_text_v1",
      status: missingFields.length > 0 ? "validation_required" : "completed",
      fields: job.field_schema.map((field) => ({
        key: field.key,
        label: field.label ?? field.key,
        value: null,
        confidence: 0,
        status: field.required === true ? "missing" : "missing_optional",
        source: "minimal_handler",
      })),
      missing_fields: missingFields,
      validation_human_task_id: null,
      created_at: now,
      updated_at: now,
    };
    const updatedJob: MinimalDocumentJob = {
      ...job,
      status: extraction.status === "completed" ? "extracted" : "validation_required",
      updated_at: now,
    };
    this.documentJobs.set(key(updatedJob.tenant_id, updatedJob.document_job_id), updatedJob);
    this.documentExtractions.set(key(extraction.tenant_id, extraction.document_job_id), extraction);
    return { status: 200, body: extraction };
  }

  async getDocumentExtraction(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const job = this.requireDocumentJob(ctx);
    const extraction = this.documentExtractions.get(key(tenant(ctx), job.document_job_id));
    if (extraction === undefined) throw new ApiResponseException("RESOURCE_NOT_FOUND");
    return { status: 200, body: extraction };
  }

  async createDocumentValidationTask(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const job = this.requireDocumentJob(ctx);
    const extraction = this.documentExtractions.get(key(tenant(ctx), job.document_job_id));
    if (extraction === undefined) throw new ApiResponseException("RESOURCE_NOT_FOUND");
    if (extraction.status !== "validation_required") {
      throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "document_validation_not_required" });
    }
    if (extraction.validation_human_task_id !== undefined && extraction.validation_human_task_id !== null) {
      return documentValidationTaskResponse(extraction);
    }
    const taskId = `document-human-task-${++this.documentTaskSequence}`;
    const task: MinimalHumanTask = {
      human_task_id: taskId,
      tenant_id: tenant(ctx),
      state: "open",
      kind: "validation",
      assignee_role: "reviewer",
      run_id: job.source_run_id,
      on_timeout: "fail",
      payload: {
        document_job_id: job.document_job_id,
        document_type: job.document_type,
        review_reason: "missing_or_low_confidence_fields",
        extracted_fields: extraction.fields,
      },
    };
    this.humanTasks.set(key(task.tenant_id, task.human_task_id), task);
    const updated: MinimalDocumentExtraction = { ...extraction, validation_human_task_id: taskId, updated_at: new Date().toISOString() };
    this.documentExtractions.set(key(updated.tenant_id, updated.document_job_id), updated);
    return documentValidationTaskResponse(updated);
  }

  async validateScenario(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    requireParam(ctx, "scenario_id");
    requireBody(ctx);
    return {
      status: 200,
      body: {
        valid: true,
        diagnostics: [],
      },
    };
  }

  async promoteScenario(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const nextVersion = requireIfMatchNextVersion(ctx, "SCENARIO_VERSION_CONFLICT");
    const scenarioId = requireParam(ctx, "scenario_id");
    const body = requireBody(ctx);
    const response = {
      scenario_id: scenarioId,
      tenant_id: tenant(ctx),
      version: nextVersion,
      promoted_target: requireString(body, "target"),
    };
    return { status: 200, headers: { ETag: String(nextVersion) }, body: response };
  }

  async promoteScenarioFromRun(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const scenarioId = requireParam(ctx, "scenario_id");
    const runId = requireString(requireBody(ctx), "run_id");
    const run = this.runs.get(key(tenant(ctx), runId));
    if (run === undefined) throw new ApiResponseException("RESOURCE_NOT_FOUND");
    if (run.scenario_id !== scenarioId) {
      throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "run_not_for_scenario" });
    }
    if (run.status !== "completed") {
      throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "run_not_completed", status: run.status });
    }
    return {
      status: 201,
      body: {
        scenario_id: scenarioId,
        version: 2,
        scenario_version_id: `${scenarioId}:v2`,
        promotion_status: "draft",
        promoted_node_ids: [run.progress_node ?? "start"],
        skipped: [],
      },
    };
  }

  async archiveScenario(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    if (ctx.ifMatch?.kind !== "match") {
      throw new ApiResponseException("SCENARIO_VERSION_CONFLICT");
    }
    const scenarioId = requireParam(ctx, "scenario_id");
    const response = {
      scenario_id: scenarioId,
      tenant_id: tenant(ctx),
      version: ctx.ifMatch.currentVersion,
      archived: true,
    };
    return { status: 200, headers: { ETag: String(ctx.ifMatch.currentVersion) }, body: response };
  }

  async listScenarioVersions(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const scenarioId = requireParam(ctx, "scenario_id");
    return page([{
      scenario_id: scenarioId,
      version_id: `${scenarioId}:v1`,
      version: 1,
      promotion_status: "draft",
    }]);
  }

  async getScenarioVersion(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const scenarioId = requireParam(ctx, "scenario_id");
    const version = Number(requireParam(ctx, "version"));
    const safeVersion = Number.isFinite(version) && version > 0 ? version : 1;
    return {
      status: 200,
      headers: { ETag: String(safeVersion) },
      body: {
        scenario_id: scenarioId,
        version_id: `${scenarioId}:v${safeVersion}`,
        version: safeVersion,
        promotion_status: "draft",
        ir: { meta: { name: scenarioId, version: safeVersion }, start: "done", nodes: { done: { terminal: "success" } } },
      },
    };
  }

  async rollbackScenario(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const nextVersion = requireIfMatchNextVersion(ctx, "SCENARIO_VERSION_CONFLICT");
    const scenarioId = requireParam(ctx, "scenario_id");
    const sourceVersion = Number(requireParam(ctx, "version"));
    const response = {
      scenario_id: scenarioId,
      tenant_id: tenant(ctx),
      version: nextVersion,
      promotion_status: "draft",
      rolled_back_from: Number.isFinite(sourceVersion) ? sourceVersion : ctx.params.version,
    };
    return { status: 200, headers: { ETag: String(nextVersion) }, body: response };
  }

  async listHumanTasks(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const status = optionalQueryString(ctx, "status");
    const kindFilter = optionalQueryString(ctx, "kind");
    const assignee = optionalQueryString(ctx, "assignee");
    const items = [...this.humanTasks.values()].filter(
      (task) =>
        task.tenant_id === tenant(ctx) &&
        (status === undefined || task.state === status) &&
        (kindFilter === undefined || task.kind === kindFilter) &&
        (assignee === undefined || task.assignee === assignee),
    );
    return page(items);
  }

  async startHumanTask(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const task = this.requireHumanTask(ctx);
    ensureHumanTaskOpen(task);
    task.state = "in_progress";
    return { status: 200, body: task };
  }

  async resolveHumanTask(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const task = this.requireHumanTask(ctx);
    requireBody(ctx);
    ensureHumanTaskOpen(task);
    task.state = "resolved";
    return { status: 200, body: task };
  }

  async assignHumanTask(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const task = this.requireHumanTask(ctx);
    const body = requireBody(ctx);
    ensureHumanTaskOpen(task);
    task.assignee = requireString(body, "assignee");
    task.state = "assigned";
    return { status: 200, body: task };
  }

  async escalateHumanTask(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const task = this.requireHumanTask(ctx);
    if (HUMANTASK_TERMINAL.includes(task.state)) throw new ApiResponseException("HUMAN_TASK_EXPIRED");
    if (task.state === "escalated") {
      throw new ApiResponseException("IR_SCHEMA_INVALID", {
        reason: "invalid_state_for_command",
        state: task.state,
      });
    }
    throw new ApiResponseException("CONTROL_PLANE_INTERNAL_ERROR", {
      reason: "human_task_pending_side_effects_unsupported",
      pending: ["reassignAssignee"],
    });
  }

  async listWorkitems(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const status = optionalQueryString(ctx, "status");
    const targetId = optionalQueryString(ctx, "target_id");
    const items = [...this.workitems.values()].filter(
      (item) =>
        item.tenant_id === tenant(ctx) &&
        (status === undefined || item.status === status) &&
        (targetId === undefined || item.target_id === targetId),
    );
    return page(items);
  }

  async replayDeadLetter(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    return {
      status: 202,
      body: {
        dead_letter_id: requireParam(ctx, "dead_letter_id"),
        status: "accepted",
        restored_state: "new",
      },
    };
  }

  async getArtifact(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const artifact = this.artifacts.get(key(tenant(ctx), requireParam(ctx, "artifact_id")));
    if (artifact === undefined) throw new ApiResponseException("RESOURCE_NOT_FOUND");

    const subject: ArtifactAccessSubject = {
      artifactId: artifact.artifact_id,
      objectRef: artifact.ref as ArtifactAccessSubject["objectRef"],
      tenantId: ctx.principal.tenantId,
      runId: artifact.run_id as RunId | undefined,
      redactionStatus: artifact.redaction_status,
      deletedAt: artifact.deleted_at as IsoDateTime | undefined,
      quarantine: artifact.quarantine,
    };
    const decision = await this.artifactGate.check(ctx.principal, subject);
    if (decision.kind === "deny") throw new ApiResponseException(decision.code, { stage: decision.stage });

    return {
      status: 200,
      body: {
        artifact_id: artifact.artifact_id,
        ref: decision.objectRef,
        body: artifact.body,
      },
    };
  }

  async listGatewayPolicies(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const items = [...this.gatewayPolicies.values()]
      .filter((policy) => policy.tenant_id === tenant(ctx))
      .sort((left, right) => Number(right.is_default === true) - Number(left.is_default === true) || left.model.localeCompare(right.model));
    return page(items);
  }

  async getGatewayPolicy(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const model = optionalQueryString(ctx, "model") ?? "default";
    return { status: 200, body: this.gatewayPolicy(ctx.principal.tenantId, model) };
  }

  async createGatewayPolicy(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const body = requireBody(ctx);
    const model = requireString(body, "model");
    const mapKey = key(tenant(ctx), model);
    if (this.gatewayPolicies.has(mapKey)) {
      throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "policy_model_in_use", model });
    }
    const policy: MinimalGatewayPolicy = {
      id: `gateway-policy:${model}`,
      tenant_id: tenant(ctx),
      model,
      version: 1,
      capabilities: requireRecord(body, "capabilities"),
      budget: requireRecord(body, "budget"),
      fallback_config: body.fallback_config ?? body.fallback,
      is_default: body.is_default === true,
    };
    this.gatewayPolicies.set(mapKey, policy);
    return { status: 201, headers: { ETag: "1" }, body: policy };
  }

  async updateGatewayPolicy(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const nextVersion = requireIfMatchNextVersion(ctx, "POLICY_VERSION_CONFLICT");
    const body = requireBody(ctx);
    const model = requireString(body, "model");
    const policy: MinimalGatewayPolicy = {
      id: `gateway-policy:${model}`,
      tenant_id: tenant(ctx),
      model,
      version: nextVersion,
      capabilities: requireRecord(body, "capabilities"),
      budget: requireRecord(body, "budget"),
      fallback_config: body.fallback_config ?? body.fallback,
      is_default: body.is_default === true,
    };
    this.gatewayPolicies.set(key(policy.tenant_id, policy.model), policy);
    return { status: 200, headers: { ETag: String(nextVersion) }, body: policy };
  }

  async deleteGatewayPolicy(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    if (ctx.ifMatch?.kind !== "match") {
      throw new ApiResponseException("POLICY_VERSION_CONFLICT");
    }
    const model = requireQueryString(ctx, "model");
    const mapKey = key(tenant(ctx), model);
    if (!this.gatewayPolicies.delete(mapKey)) {
      throw new ApiResponseException("RESOURCE_NOT_FOUND");
    }
    return { status: 200, body: { model, deleted: true } };
  }

  async listSites(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const risk = optionalQueryString(ctx, "risk");
    const items = [...this.sites.values()].filter(
      (site) => site.tenant_id === tenant(ctx) && (risk === undefined || site.risk === risk),
    );
    return page(items);
  }

  async approveSite(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const siteId = requireParam(ctx, "site_profile_id");
    const mapKey = key(tenant(ctx), siteId);
    const site =
      this.sites.get(mapKey) ??
      ({
        site_profile_id: siteId,
        tenant_id: tenant(ctx),
        risk: "red",
        approved: false,
        circuit_state: "closed",
      } satisfies MinimalSite);
    const body = isRecord(ctx.body) ? ctx.body : {};
    site.approved = true;
    site.approval_reason = optionalString(body, "reason");
    site.approval_expires_at = optionalString(body, "expires_at");
    this.sites.set(mapKey, site);
    return { status: 200, body: site };
  }

  async listSessionCaptures(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const siteId = requireParam(ctx, "site_profile_id");
    const items = this.captureSessions
      .filter((session) => session.tenant_id === tenant(ctx) && session.site_profile_id === siteId)
      .map((session) => ({
        capture_session_id: session.capture_session_id,
        status: session.status,
        detail: session.detail ?? null,
        updated_at: session.updated_at ?? "2026-06-13T00:00:00.000Z",
      }));
    return page(items);
  }

  async updateSitePageState(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const siteId = requireParam(ctx, "site_profile_id");
    const mapKey = key(tenant(ctx), siteId);
    const site = this.sites.get(mapKey);
    if (site === undefined) throw new ApiResponseException("RESOURCE_NOT_FOUND");
    const body = isRecord(ctx.body) ? ctx.body : {};
    site.page_state_selectors = Object.prototype.hasOwnProperty.call(body, "page_state_selectors")
      ? body.page_state_selectors
      : site.page_state_selectors;
    this.sites.set(mapKey, site);
    return {
      status: 200,
      body: {
        site_profile_id: siteId,
        page_state_selectors: site.page_state_selectors ?? null,
        page_state_summary: { configured: site.page_state_selectors !== undefined && site.page_state_selectors !== null },
      },
    };
  }

  async listSiteElements(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const siteId = requireParam(ctx, "site_profile_id");
    this.requireSite(ctx, siteId);
    const stability = optionalQueryString(ctx, "stability");
    const search = optionalQueryString(ctx, "search")?.toLowerCase();
    const items = [...this.siteElements.values()].filter(
      (element) =>
        element.tenant_id === tenant(ctx) &&
        element.site_profile_id === siteId &&
        (stability === undefined || element.stability === stability) &&
        (search === undefined ||
          element.element_key.toLowerCase().includes(search) ||
          element.label.toLowerCase().includes(search) ||
          element.selector.toLowerCase().includes(search)),
    );
    return page(items);
  }

  async createSiteElement(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const siteId = requireParam(ctx, "site_profile_id");
    this.requireSite(ctx, siteId);
    const body = requireBody(ctx);
    const elementKey = requireString(body, "element_key");
    if ([...this.siteElements.values()].some((element) => element.tenant_id === tenant(ctx) && element.site_profile_id === siteId && element.element_key === elementKey)) {
      throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "element_key_already_exists" });
    }
    const now = new Date().toISOString();
    const element: MinimalSiteElement = {
      element_id: `element-${this.siteElements.size + 1}`,
      tenant_id: tenant(ctx),
      site_profile_id: siteId,
      element_key: elementKey,
      label: requireString(body, "label"),
      selector: requireString(body, "selector"),
      element_type: optionalString(body, "element_type") as MinimalSiteElement["element_type"] | undefined ?? "other",
      stability: optionalString(body, "stability") as MinimalSiteElement["stability"] | undefined ?? "stable",
      source: optionalString(body, "source") as MinimalSiteElement["source"] | undefined ?? "manual",
      sample_url: optionalString(body, "sample_url") ?? null,
      notes: optionalString(body, "notes") ?? null,
      usage_count: 0,
      last_verified_at: null,
      updated_by: ctx.principal.subjectId,
      created_at: now,
      updated_at: now,
    };
    this.siteElements.set(key(element.tenant_id, element.element_id), element);
    return { status: 201, body: element };
  }

  async updateSiteElement(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const siteId = requireParam(ctx, "site_profile_id");
    this.requireSite(ctx, siteId);
    const element = this.requireSiteElement(ctx, siteId);
    const body = requireBody(ctx);
    if (typeof body.label === "string") element.label = body.label;
    if (typeof body.selector === "string") element.selector = body.selector;
    if (typeof body.element_type === "string") element.element_type = body.element_type as MinimalSiteElement["element_type"];
    if (typeof body.stability === "string") element.stability = body.stability as MinimalSiteElement["stability"];
    if (Object.prototype.hasOwnProperty.call(body, "sample_url")) element.sample_url = optionalString(body, "sample_url") ?? null;
    if (Object.prototype.hasOwnProperty.call(body, "notes")) element.notes = optionalString(body, "notes") ?? null;
    if (Object.prototype.hasOwnProperty.call(body, "last_verified_at")) element.last_verified_at = optionalString(body, "last_verified_at") ?? null;
    element.updated_by = ctx.principal.subjectId;
    element.updated_at = new Date().toISOString();
    this.siteElements.set(key(element.tenant_id, element.element_id), element);
    return { status: 200, body: element };
  }

  async probeSiteElement(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const siteId = requireParam(ctx, "site_profile_id");
    this.requireSite(ctx, siteId);
    const element = this.requireSiteElement(ctx, siteId);
    const body = isRecord(ctx.body) ? ctx.body : {};
    const sampleUrl = optionalString(body, "sample_url") ?? element.sample_url ?? null;
    return {
      status: 200,
      body: {
        element_id: element.element_id,
        site_profile_id: element.site_profile_id,
        selector: element.selector,
        sample_url: sampleUrl,
        probe_status: "not_run",
        match_count: null,
        reason_code: sampleUrl === null ? "SAMPLE_URL_REQUIRED" : "SELECTOR_PROBE_PROVIDER_UNAVAILABLE",
        checked_at: new Date().toISOString(),
        element,
      },
    };
  }

  async deleteSiteElement(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const siteId = requireParam(ctx, "site_profile_id");
    this.requireSite(ctx, siteId);
    const elementId = requireParam(ctx, "element_id");
    const mapKey = key(tenant(ctx), elementId);
    const element = this.siteElements.get(mapKey);
    if (element === undefined || element.site_profile_id !== siteId) throw new ApiResponseException("RESOURCE_NOT_FOUND");
    this.siteElements.delete(mapKey);
    return { status: 200, body: { element_id: elementId, deleted: true } };
  }

  async listBrowserRecordings(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const siteId = requireParam(ctx, "site_profile_id");
    this.requireSite(ctx, siteId);
    const status = optionalQueryString(ctx, "status");
    const items = [...this.browserRecordingSessions.values()].filter(
      (session) =>
        session.tenant_id === tenant(ctx) &&
        session.site_profile_id === siteId &&
        (status === undefined || session.status === status),
    ).map((session) => this.browserRecordingResponse(session));
    return page(items);
  }

  async startBrowserRecording(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const siteId = requireParam(ctx, "site_profile_id");
    this.requireSite(ctx, siteId);
    const body = requireBody(ctx);
    const now = new Date().toISOString();
    const session: MinimalBrowserRecordingSession = {
      recording_session_id: `recording-${++this.recordingSequence}`,
      tenant_id: tenant(ctx),
      site_profile_id: siteId,
      name: requireString(body, "name"),
      start_url: optionalString(body, "start_url") ?? "https://example.invalid/",
      status: "recording",
      event_count: 0,
      draft_ir: null,
      validation_report: null,
      updated_by: ctx.principal.subjectId,
      created_at: now,
      updated_at: now,
    };
    this.browserRecordingSessions.set(key(session.tenant_id, session.recording_session_id), session);
    return { status: 201, body: this.browserRecordingResponse(session) };
  }

  async listBrowserRecordingEvents(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const siteId = requireParam(ctx, "site_profile_id");
    const recording = this.requireBrowserRecording(ctx, siteId);
    const items = this.browserRecordingEvents
      .filter((event) => event.tenant_id === tenant(ctx) && event.recording_session_id === recording.recording_session_id)
      .sort((left, right) => left.seq - right.seq)
      .map((event) => this.browserRecordingEventResponse(event));
    return page(items);
  }

  async appendBrowserRecordingEvents(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const siteId = requireParam(ctx, "site_profile_id");
    const recording = this.requireBrowserRecording(ctx, siteId);
    if (recording.status !== "recording") {
      throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "recording_session_not_active", status: recording.status });
    }
    const body = requireBody(ctx);
    const rawEvents = body.events;
    if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
      throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "events_required" });
    }
    const now = new Date().toISOString();
    let nextSeq = this.browserRecordingEvents
      .filter((event) => event.tenant_id === tenant(ctx) && event.recording_session_id === recording.recording_session_id)
      .reduce((max, event) => Math.max(max, event.seq), 0);
    const appended: MinimalBrowserRecordingEvent[] = rawEvents.map((item) => {
      if (!isRecord(item)) throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "recording_event_expected_object" });
      return {
        event_id: `recording-event-${++this.recordingEventSequence}`,
        tenant_id: tenant(ctx),
        recording_session_id: recording.recording_session_id,
        seq: ++nextSeq,
        event_type: requireBrowserRecordingEventType(item, "event_type"),
        selector: optionalString(item, "selector") ?? null,
        element_key: optionalString(item, "element_key") ?? null,
        label: optionalString(item, "label") ?? null,
        url: optionalString(item, "url") ?? null,
        value_preview: optionalString(item, "value_preview") ?? null,
        captured_at: now,
        created_at: now,
      };
    });
    this.browserRecordingEvents.push(...appended);
    recording.event_count = nextSeq;
    recording.updated_by = ctx.principal.subjectId;
    recording.updated_at = now;
    this.browserRecordingSessions.set(key(recording.tenant_id, recording.recording_session_id), recording);
    return {
      status: 200,
      body: {
        recording_session_id: recording.recording_session_id,
        appended: appended.length,
        event_count: recording.event_count,
      },
    };
  }

  async completeBrowserRecording(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const siteId = requireParam(ctx, "site_profile_id");
    const recording = this.requireBrowserRecording(ctx, siteId);
    const events = this.browserRecordingEvents
      .filter((event) => event.tenant_id === tenant(ctx) && event.recording_session_id === recording.recording_session_id)
      .sort((left, right) => left.seq - right.seq);
    recording.status = "completed";
    recording.event_count = events.length;
    recording.draft_ir = draftIrFromRecording(recording, events);
    recording.validation_report = { errors: [], warnings: [] };
    recording.updated_by = ctx.principal.subjectId;
    recording.updated_at = new Date().toISOString();
    this.browserRecordingSessions.set(key(recording.tenant_id, recording.recording_session_id), recording);
    return { status: 200, body: this.browserRecordingResponse(recording) };
  }

  getHumanTaskForAuthorization(tenantId: TenantId, humanTaskId: string): MinimalHumanTask | undefined {
    return this.humanTasks.get(key(tenantId, humanTaskId));
  }

  private requireHumanTask(ctx: ControlPlaneRequestContext): MinimalHumanTask {
    const task = this.humanTasks.get(key(tenant(ctx), requireParam(ctx, "human_task_id")));
    if (task === undefined) throw new ApiResponseException("RESOURCE_NOT_FOUND");
    return task;
  }

  private requireRunTrigger(ctx: ControlPlaneRequestContext): MinimalRunTrigger {
    const trigger = this.runTriggers.get(key(tenant(ctx), requireParam(ctx, "trigger_id")));
    if (trigger === undefined) throw new ApiResponseException("RESOURCE_NOT_FOUND");
    return trigger;
  }

  private requireSite(ctx: ControlPlaneRequestContext, siteId: string): MinimalSite {
    const site = this.sites.get(key(tenant(ctx), siteId));
    if (site === undefined) throw new ApiResponseException("RESOURCE_NOT_FOUND");
    return site;
  }

  private requireSiteElement(ctx: ControlPlaneRequestContext, siteId: string): MinimalSiteElement {
    const element = this.siteElements.get(key(tenant(ctx), requireParam(ctx, "element_id")));
    if (element === undefined || element.site_profile_id !== siteId) throw new ApiResponseException("RESOURCE_NOT_FOUND");
    return element;
  }

  private requireBrowserRecording(ctx: ControlPlaneRequestContext, siteId: string): MinimalBrowserRecordingSession {
    this.requireSite(ctx, siteId);
    const recording = this.browserRecordingSessions.get(key(tenant(ctx), requireParam(ctx, "recording_session_id")));
    if (recording === undefined || recording.site_profile_id !== siteId) throw new ApiResponseException("RESOURCE_NOT_FOUND");
    return recording;
  }

  private browserRecordingResponse(session: MinimalBrowserRecordingSession): Record<string, unknown> {
    return {
      recording_session_id: session.recording_session_id,
      site_profile_id: session.site_profile_id,
      name: session.name,
      start_url: session.start_url,
      status: session.status,
      event_count: session.event_count,
      draft_ir: session.draft_ir ?? null,
      validation_report: session.validation_report ?? null,
      updated_by: session.updated_by ?? null,
      created_at: session.created_at ?? "2026-06-13T00:00:00.000Z",
      updated_at: session.updated_at ?? "2026-06-13T00:00:00.000Z",
    };
  }

  private browserRecordingEventResponse(event: MinimalBrowserRecordingEvent): Record<string, unknown> {
    return {
      event_id: event.event_id,
      recording_session_id: event.recording_session_id,
      seq: event.seq,
      event_type: event.event_type,
      selector: event.selector ?? null,
      element_key: event.element_key ?? null,
      label: event.label ?? null,
      url: event.url ?? null,
      value_preview: event.value_preview ?? null,
      captured_at: event.captured_at ?? "2026-06-13T00:00:00.000Z",
      created_at: event.created_at ?? "2026-06-13T00:00:00.000Z",
    };
  }

  private requireAutomationIdea(ctx: ControlPlaneRequestContext): MinimalAutomationIdea {
    const idea = this.automationIdeas.get(key(tenant(ctx), requireParam(ctx, "idea_id")));
    if (idea === undefined) throw new ApiResponseException("RESOURCE_NOT_FOUND");
    return idea;
  }

  private requireDocumentJob(ctx: ControlPlaneRequestContext): MinimalDocumentJob {
    const job = this.documentJobs.get(key(tenant(ctx), requireParam(ctx, "job_id")));
    if (job === undefined) throw new ApiResponseException("RESOURCE_NOT_FOUND");
    return job;
  }

  private gatewayPolicy(tenantId: TenantId, model: string): MinimalGatewayPolicy {
    const existing = this.gatewayPolicies.get(key(tenantId, model));
    if (existing !== undefined) return existing;
    return {
      id: `gateway-policy:${model}`,
      tenant_id: tenantId,
      model,
      version: 1,
      capabilities: {},
      budget: {},
    };
  }
}

export function createMinimalControlPlaneHandlers(services: MinimalControlPlaneServices): ControlPlaneHandlerMap {
  const bind = (handler: (ctx: ControlPlaneRequestContext) => Promise<ControlPlaneResponse>): ControlPlaneHandler =>
    handler.bind(services);

  return {
    getAuthReadiness: bind(services.getAuthReadiness),
    createRun: bind(services.createRun),
    getRun: bind(services.getRun),
    listRuns: bind(services.listRuns),
    listRunSteps: bind(services.listRunSteps),
    streamRunSteps: bind(services.streamRunSteps),
    listRunArtifacts: bind(services.listRunArtifacts),
    abortRun: bind(services.abortRun),
    listRunTriggers: bind(services.listRunTriggers),
    createRunTrigger: bind(services.createRunTrigger),
    getRunTrigger: bind(services.getRunTrigger),
    updateRunTrigger: bind(services.updateRunTrigger),
    pauseRunTrigger: bind(services.pauseRunTrigger),
    resumeRunTrigger: bind(services.resumeRunTrigger),
    listRunTriggerFires: bind(services.listRunTriggerFires),
    listOpsAlerts: bind(services.listOpsAlerts),
    getOpsHealth: bind(services.getOpsHealth),
    listAutomationIdeas: bind(services.listAutomationIdeas),
    createAutomationIdea: bind(services.createAutomationIdea),
    getAutomationIdea: bind(services.getAutomationIdea),
    updateAutomationIdea: bind(services.updateAutomationIdea),
    transitionAutomationIdea: bind(services.transitionAutomationIdea),
    upsertRoiEstimate: bind(services.upsertRoiEstimate),
    getRoiEstimate: bind(services.getRoiEstimate),
    listAuditLog: bind(services.listAuditLog),
    exportAuditLog: bind(services.exportAuditLog),
    listConnectors: bind(services.listConnectors),
    listTemplates: bind(services.listTemplates),
    listDocumentJobs: bind(services.listDocumentJobs),
    createDocumentJob: bind(services.createDocumentJob),
    getDocumentJob: bind(services.getDocumentJob),
    extractDocumentJob: bind(services.extractDocumentJob),
    getDocumentExtraction: bind(services.getDocumentExtraction),
    createDocumentValidationTask: bind(services.createDocumentValidationTask),
    validateScenario: bind(services.validateScenario),
    promoteScenario: bind(services.promoteScenario),
    promoteScenarioFromRun: bind(services.promoteScenarioFromRun),
    archiveScenario: bind(services.archiveScenario),
    listScenarioVersions: bind(services.listScenarioVersions),
    getScenarioVersion: bind(services.getScenarioVersion),
    rollbackScenario: bind(services.rollbackScenario),
    listHumanTasks: bind(services.listHumanTasks),
    startHumanTask: bind(services.startHumanTask),
    resolveHumanTask: bind(services.resolveHumanTask),
    assignHumanTask: bind(services.assignHumanTask),
    escalateHumanTask: bind(services.escalateHumanTask),
    listWorkitems: bind(services.listWorkitems),
    replayDeadLetter: bind(services.replayDeadLetter),
    getArtifact: bind(services.getArtifact),
    listGatewayPolicies: bind(services.listGatewayPolicies),
    getGatewayPolicy: bind(services.getGatewayPolicy),
    createGatewayPolicy: bind(services.createGatewayPolicy),
    updateGatewayPolicy: bind(services.updateGatewayPolicy),
    deleteGatewayPolicy: bind(services.deleteGatewayPolicy),
    listSites: bind(services.listSites),
    approveSite: bind(services.approveSite),
    listSessionCaptures: bind(services.listSessionCaptures),
    updateSitePageState: bind(services.updateSitePageState),
    listSiteElements: bind(services.listSiteElements),
    createSiteElement: bind(services.createSiteElement),
    updateSiteElement: bind(services.updateSiteElement),
    probeSiteElement: bind(services.probeSiteElement),
    deleteSiteElement: bind(services.deleteSiteElement),
    listBrowserRecordings: bind(services.listBrowserRecordings),
    startBrowserRecording: bind(services.startBrowserRecording),
    listBrowserRecordingEvents: bind(services.listBrowserRecordingEvents),
    appendBrowserRecordingEvents: bind(services.appendBrowserRecordingEvents),
    completeBrowserRecording: bind(services.completeBrowserRecording),
  };
}

function key(tenantId: string, id: string): string {
  return `${tenantId}:${id}`;
}

function tenant(ctx: ControlPlaneRequestContext): string {
  return ctx.principal.tenantId;
}

function page(items: readonly unknown[]): ControlPlaneResponse {
  return { status: 200, body: { items, next_cursor: null } };
}

function minimalAuthReadiness(ctx: ControlPlaneRequestContext): Record<string, unknown> {
  const claims = ctx.principal.claims;
  return {
    status: "warning",
    enterprise_sso_ready: false,
    provider: {
      mode: "hs256",
      configuration_source: "test_default",
      algorithm: "HS256",
      jwks_url_configured: false,
      jwks_host: null,
      issuer_configured: false,
      issuer: null,
      audience_configured: false,
      audience: null,
    },
    claim_mapping: {
      subject_claim: "sub",
      tenant_claim: "tenant_id",
      roles_claim: "roles",
      expiry_claim: "exp",
      display_name_claim: "name",
      email_claim: "email",
    },
    role_mapping: {
      configured: false,
      mapped_values: 0,
    },
    required_claims: [
      { claim: "sub", label: "처리자 식별", required: true, present: typeof claims.sub === "string" && claims.sub.length > 0, mapped_to: "current_principal.subject_id" },
      { claim: "tenant_id", label: "테넌트 경계", required: true, present: typeof claims.tenant_id === "string" && claims.tenant_id.length > 0, mapped_to: "current_principal.tenant_id" },
      { claim: "roles", label: "역할 매핑", required: true, present: Array.isArray(claims.roles), mapped_to: "current_principal.roles" },
      { claim: "exp", label: "만료 시간", required: true, present: typeof claims.exp === "number", mapped_to: "인증 만료 검증" },
      { claim: "name", label: "표시 이름", required: false, present: typeof claims.name === "string" && claims.name.length > 0, mapped_to: "담당자 디렉터리 표시명" },
      { claim: "email", label: "이메일", required: false, present: typeof claims.email === "string" && claims.email.length > 0, mapped_to: "담당자 디렉터리 이메일" },
    ],
    current_principal: {
      subject_id: ctx.principal.subjectId,
      tenant_id: ctx.principal.tenantId,
      roles: ctx.principal.roles,
      source: ctx.principal.source,
      display_name: typeof claims.name === "string" && claims.name.length > 0 ? claims.name : null,
      email: typeof claims.email === "string" && claims.email.length > 0 ? claims.email : null,
    },
    operational_gaps: [
      "운영 SSO 검증을 위해 RS256/JWKS 모드가 필요합니다.",
      "토큰 발급자(issuer) 검증이 설정되지 않았습니다.",
      "토큰 대상(audience) 검증이 설정되지 않았습니다.",
    ],
  };
}

function auditCsv(items: readonly MinimalAuditLogItem[]): string {
  const header = [
    "audit_id",
    "sequence_no",
    "actor_subject_id",
    "actor_roles",
    "action",
    "outcome",
    "reason",
    "correlation_id",
    "idempotency_key",
    "occurred_at",
    "payload_schema_ref",
    "retention_until",
    "legal_hold",
    "previous_hash",
    "hash",
    "created_at",
  ];
  const lines = items.map((item) => [
    item.audit_id,
    String(item.sequence_no),
    item.actor.subject_id ?? "",
    item.actor.roles.join(";"),
    item.action,
    item.outcome,
    item.reason ?? "",
    item.correlation_id,
    item.idempotency_key,
    item.occurred_at,
    item.payload_schema_ref,
    item.retention_until ?? "",
    String(item.legal_hold ?? false),
    item.previous_hash ?? "",
    item.hash,
    item.created_at ?? "",
  ].map(csvCell).join(","));
  return [header.join(","), ...lines].join("\n");
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function ensureHumanTaskOpen(task: MinimalHumanTask): void {
  if (HUMANTASK_TERMINAL.includes(task.state)) {
    throw new ApiResponseException("HUMAN_TASK_EXPIRED");
  }
}

function requireParam(ctx: ControlPlaneRequestContext, name: string): string {
  const value = ctx.params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "missing_path_param", name });
  }
  return value;
}

function optionalQueryString(ctx: ControlPlaneRequestContext, name: string): string | undefined {
  const value = ctx.query[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireQueryString(ctx: ControlPlaneRequestContext, name: string): string {
  const value = optionalQueryString(ctx, name);
  if (value === undefined) {
    throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "missing_query_param", name });
  }
  return value;
}

function requireBody(ctx: ControlPlaneRequestContext): Record<string, unknown> {
  if (!isRecord(ctx.body)) {
    throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "expected_object_body" });
  }
  return ctx.body;
}

function requireString(record: Readonly<Record<string, unknown>>, keyName: string): string {
  const value = record[keyName];
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "missing_required_string", key: keyName });
  }
  return value;
}

function optionalString(record: Readonly<Record<string, unknown>>, keyName: string): string | undefined {
  const value = record[keyName];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalCatchupPolicy(record: Readonly<Record<string, unknown>>): "skip_missed" | "fire_once" | undefined {
  const value = record.catchup_policy;
  if (value === undefined) return undefined;
  if (value === "skip_missed" || value === "fire_once") return value;
  throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "invalid_catchup_policy" });
}

function optionalAutomationSource(
  record: Readonly<Record<string, unknown>>,
): "manual" | "process_mining" | "task_mining" | "imported" | undefined {
  const value = record.source;
  if (value === undefined) return undefined;
  if (value === "manual" || value === "process_mining" || value === "task_mining" || value === "imported") return value;
  throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "invalid_automation_idea_source" });
}

function optionalAutomationPriority(
  record: Readonly<Record<string, unknown>>,
): "low" | "medium" | "high" | "critical" | undefined {
  const value = record.priority;
  if (value === undefined) return undefined;
  if (value === "low" || value === "medium" || value === "high" || value === "critical") return value;
  throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "invalid_automation_idea_priority" });
}

function requireAutomationStage(record: Readonly<Record<string, unknown>>, keyName: string): MinimalAutomationIdeaStage {
  const value = record[keyName];
  if (
    value === "intake"
    || value === "assess"
    || value === "approved"
    || value === "build"
    || value === "operate"
    || value === "rejected"
    || value === "archived"
  ) {
    return value;
  }
  throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "invalid_automation_idea_stage" });
}

function allowedAutomationTransitions(stage: MinimalAutomationIdeaStage): readonly MinimalAutomationIdeaStage[] {
  switch (stage) {
    case "intake":
      return ["assess", "archived"];
    case "assess":
      return ["approved", "rejected", "archived"];
    case "approved":
      return ["build", "archived"];
    case "build":
      return ["operate", "archived"];
    case "operate":
    case "rejected":
      return ["archived"];
    case "archived":
      return [];
  }
}

function optionalRoiConfidence(record: Readonly<Record<string, unknown>>): "low" | "medium" | "high" | undefined {
  const value = record.confidence;
  if (value === undefined) return undefined;
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "invalid_roi_confidence" });
}

function requireBrowserRecordingEventType(
  record: Readonly<Record<string, unknown>>,
  keyName: string,
): MinimalBrowserRecordingEventType {
  const value = record[keyName];
  if (
    value === "navigate" ||
    value === "click" ||
    value === "input" ||
    value === "select" ||
    value === "submit" ||
    value === "wait"
  ) {
    return value;
  }
  throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "invalid_browser_recording_event_type" });
}

function draftIrFromRecording(
  session: MinimalBrowserRecordingSession,
  events: readonly MinimalBrowserRecordingEvent[],
): Record<string, unknown> {
  const nodes: Record<string, unknown> = {};
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const start = events.length === 0 ? "done" : "step_01";
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const nodeId = `step_${String(index + 1).padStart(2, "0")}`;
    const next = index === events.length - 1 ? "done" : `step_${String(index + 2).padStart(2, "0")}`;
    nodes[nodeId] = {
      what: [recordingActionFromEvent(event, properties, required)],
      ...(event.event_type === "submit" ? { side_effect: { kind: "submit", idempotency_key: `recorded_submit_${event.seq}` } } : {}),
      next,
    };
  }
  nodes.done = { terminal: "success" };
  return {
    meta: { name: session.name, version: 1, studio_mode: "easy" },
    ...(Object.keys(properties).length > 0 ? { params_schema: { type: "object", properties, required } } : {}),
    start,
    nodes,
  };
}

function recordingActionFromEvent(
  event: MinimalBrowserRecordingEvent,
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  const label = event.label ?? event.element_key ?? event.selector ?? event.url ?? event.event_type;
  if (event.event_type === "navigate") {
    const keyName = event.seq === 1 ? "entry_url" : `url_${event.seq}`;
    properties[keyName] = { type: "string", format: "uri", default: event.url ?? "https://example.invalid/" };
    required.push(keyName);
    return { action: "navigate", url_ref: keyName };
  }
  if (event.event_type === "input") {
    const keyName = `input_${event.seq}`;
    properties[keyName] = { type: "string", description: `${label} input` };
    required.push(keyName);
    return { action: "act", instruction: `${label} input`, args: { fill_selector: event.selector ?? "", value_ref: keyName } };
  }
  if (event.event_type === "select") {
    return { action: "act", instruction: `${label} select`, args: { select_selector: event.selector ?? "", select_value: event.value_preview ?? "" } };
  }
  if (event.event_type === "wait") {
    return { action: "observe", instruction: `${label} wait`, args: { selector: event.selector ?? "" } };
  }
  return { action: "act", instruction: `${label} click`, args: { click_selector: event.selector ?? "" } };
}

function optionalScore(record: Readonly<Record<string, unknown>>): number | undefined {
  const value = record.score;
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100) return value;
  throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "invalid_score" });
}

function requireFiniteNumber(record: Readonly<Record<string, unknown>>, keyName: string): number {
  const value = record[keyName];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "missing_required_number", key: keyName });
}

function optionalPositiveInteger(record: Readonly<Record<string, unknown>>, keyName: string): number | undefined {
  const value = record[keyName];
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
  throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "invalid_positive_integer", key: keyName });
}

function scenarioIdFromVersionId(scenarioVersionId: string): string {
  const marker = scenarioVersionId.indexOf(":");
  if (marker > 0) return scenarioVersionId.slice(0, marker);
  return `scenario-for-${scenarioVersionId}`;
}

function requireRecord(record: Readonly<Record<string, unknown>>, keyName: string): Readonly<Record<string, unknown>> {
  const value = record[keyName];
  if (!isRecord(value)) {
    throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "missing_required_object", key: keyName });
  }
  return value;
}

function requireDocumentFieldSchema(record: Readonly<Record<string, unknown>>): readonly MinimalDocumentFieldSchema[] {
  const value = record.field_schema;
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "missing_required_array", key: "field_schema" });
  }
  return value.map((item) => {
    if (!isRecord(item)) throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "document_field_expected_object" });
    return {
      key: requireString(item, "key"),
      label: optionalString(item, "label"),
      type: requireDocumentFieldType(item),
      required: item.required === true,
      aliases: optionalStringArray(item, "aliases"),
      patterns: optionalStringArray(item, "patterns"),
      min_confidence: typeof item.min_confidence === "number" ? item.min_confidence : undefined,
    };
  });
}

function requireDocumentFieldType(record: Readonly<Record<string, unknown>>): MinimalDocumentFieldSchema["type"] {
  const value = record.type;
  if (value === undefined) return "text";
  if (value === "text" || value === "number" || value === "date" || value === "boolean") return value;
  throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "invalid_document_field_type" });
}

function optionalStringArray(record: Readonly<Record<string, unknown>>, keyName: string): readonly string[] | undefined {
  const value = record[keyName];
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "invalid_string_array", key: keyName });
}

function documentValidationTaskResponse(extraction: MinimalDocumentExtraction): ControlPlaneResponse {
  if (extraction.validation_human_task_id === undefined || extraction.validation_human_task_id === null) {
    throw new ApiResponseException("RESOURCE_NOT_FOUND");
  }
  return {
    status: 201,
    body: {
      human_task_id: extraction.validation_human_task_id,
      state: "open",
      result_schema: {
        version: "business_form_v1",
        fields: extraction.missing_fields.map((keyName) => ({ key: keyName, label: keyName, type: "text", required: true })),
      },
      artifact_refs: [],
    },
  };
}

function requireIfMatchNextVersion(ctx: ControlPlaneRequestContext, code: ApiErrorResponseCode): number {
  if (ctx.ifMatch?.kind !== "match") {
    throw new ApiResponseException(code);
  }
  return ctx.ifMatch.nextVersion;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
