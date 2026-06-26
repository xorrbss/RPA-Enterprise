import assert from "node:assert/strict";

import { apiErrorResponse, ApiResponseException, exceptionResponse } from "../control-plane/errors";
import {
  createControlPlaneValidatorRegistry,
  createFastifyCompatibleRoutes,
  createRouteBinder,
  CONTROL_PLANE_OPERATION_BINDINGS,
  staticRbacAction,
} from "../control-plane/operation-registry";
import {
  createMinimalControlPlaneHandlers,
  InMemoryControlPlaneServices,
} from "../control-plane/minimal-handlers";
import {
  createFakeControlPlaneScaffold,
  createInMemoryAuthorizationResolver,
  FakeControlPlaneRunner,
} from "../control-plane/fake-request-runner";
import type {
  ControlPlaneRequestContext,
  IfMatchDecision,
  OperationId,
} from "../ts/control-plane-contract";
import type {
  ArtifactAccessGate,
  ArtifactAccessSubject,
  AuthenticatedPrincipal,
  CanonicalRequestHash,
  CorrelationId,
  PrincipalId,
  TenantBindingStatement,
  TenantId,
} from "../ts/security-middleware-contract";
import type { ArtifactRef } from "../ts/core-types";

const tenantId = "11111111-1111-4111-8111-111111111111" as TenantId;
const otherTenantId = "22222222-2222-4222-8222-222222222222" as TenantId;
const principal: AuthenticatedPrincipal = {
  subjectId: "principal-1" as PrincipalId,
  tenantId,
  roles: ["admin"],
  source: "jwt",
  claims: {},
};
const tenantBinding: TenantBindingStatement = {
  sql: "SET LOCAL app.tenant_id = $1",
  values: [tenantId],
};

class FixtureArtifactGate implements ArtifactAccessGate {
  async check(_principal: AuthenticatedPrincipal, artifact: ArtifactAccessSubject) {
    if (artifact.redactionStatus !== "redacted" && artifact.redactionStatus !== "not_required") {
      return {
        kind: "deny" as const,
        stage: "redaction" as const,
        code: "ARTIFACT_NOT_REDACTED" as const,
        reason: "artifact is not redacted",
      };
    }
    if (artifact.quarantine === true) {
      return {
        kind: "deny" as const,
        stage: "redaction" as const,
        code: "ARTIFACT_NOT_REDACTED" as const,
        reason: "artifact is quarantined",
      };
    }
    return { kind: "allow" as const, objectRef: artifact.objectRef };
  }
}

const services = new InMemoryControlPlaneServices(new FixtureArtifactGate(), {
  runs: [{
    run_id: "run-existing",
    tenant_id: tenantId,
    scenario_id: "scenario-1",
    scenario_version_id: "sv-1",
    status: "running",
    attempts: 0,
    as_of: "2026-06-13T00:00:00Z",
  }, {
    run_id: "run-completed",
    tenant_id: tenantId,
    scenario_id: "scenario-1",
    scenario_version_id: "sv-1",
    status: "completed",
    attempts: 1,
    as_of: "2026-06-13T00:00:00Z",
    progress_node: "submit",
  }, {
    run_id: "run-suspending",
    tenant_id: tenantId,
    scenario_id: "scenario-1",
    scenario_version_id: "sv-1",
    status: "suspending",
    attempts: 0,
    as_of: "2026-06-13T00:00:00Z",
  }, {
    run_id: "run-other-tenant",
    tenant_id: otherTenantId,
    scenario_id: "scenario-1",
    scenario_version_id: "sv-1",
    status: "running",
    attempts: 0,
    as_of: "2026-06-13T00:00:00Z",
  }],
  humanTasks: [{
    human_task_id: "task-open",
    tenant_id: tenantId,
    state: "in_progress",
    kind: "captcha",
    run_id: "run-existing",
  }, {
    human_task_id: "task-assign",
    tenant_id: tenantId,
    state: "open",
    kind: "captcha",
    run_id: "run-existing",
  }, {
    human_task_id: "task-expired",
    tenant_id: tenantId,
    state: "expired",
    kind: "captcha",
    run_id: "run-existing",
  }],
  workitems: [{
    workitem_id: "wi-1",
    tenant_id: tenantId,
    status: "processing",
    attempts: 1,
    target_id: "target-1",
  }],
  artifacts: [{
    artifact_id: "artifact-pending",
    tenant_id: tenantId,
    run_id: "run-existing",
    type: "screenshot",
    media_type: "image/png",
    filename: "pending.png",
    byte_size: 512,
    duration_ms: null,
    redaction_status: "pending",
    retention_until: null,
    legal_hold: false,
    created_at: "2026-06-13T00:00:00.000Z",
    ref: "artifact://pending",
    body: { secret: "[redacted]" },
  }, {
    artifact_id: "artifact-redacted",
    tenant_id: tenantId,
    run_id: "run-existing",
    step_id: "step-1",
    attempt: 1,
    type: "video",
    media_type: "video/webm",
    filename: "run-recording.webm",
    byte_size: 4096,
    duration_ms: 1200,
    redaction_status: "redacted",
    retention_until: null,
    legal_hold: false,
    created_at: "2026-06-13T00:00:01.000Z",
    ref: "artifact://redacted",
    body: { ok: true },
  }, {
    artifact_id: "artifact-quarantined",
    tenant_id: tenantId,
    run_id: "run-existing",
    type: "screenshot",
    media_type: "image/png",
    filename: "quarantined.png",
    byte_size: 2048,
    duration_ms: null,
    redaction_status: "redacted",
    retention_until: null,
    legal_hold: false,
    created_at: "2026-06-13T00:00:02.000Z",
    quarantine: true,
    ref: "artifact://quarantined",
    body: { quarantined: true },
  }],
  runSteps: [{
    step_id: "step-1",
    tenant_id: tenantId,
    run_id: "run-existing",
    node_id: "extract_results",
    action: "extract",
    status: "success",
    attempt: 1,
    cache_mode: "miss",
    started_at: "2026-06-13T00:00:00.000Z",
    ended_at: "2026-06-13T00:00:01.000Z",
    duration_ms: 1000,
    artifact_ids: ["artifact-redacted"],
    stagehand_calls: [{
      model: "gpt-4o-mini",
      transport: "sse",
      stream_status: "done",
      input_tokens: 128,
      output_tokens: 32,
      cost: "0.001",
    }],
    exception: null,
  }],
  runTriggers: [{
    trigger_id: "trigger-existing",
    tenant_id: tenantId,
    scenario_version_id: "sv-1",
    trigger_type: "cron",
    status: "enabled",
    cron_expression: "0 9 * * 1-5",
    timezone: "Asia/Seoul",
    webhook_secret_ref: null,
    webhook_secret_configured: false,
    params: { region: "KR" },
    catchup_policy: "skip_missed",
    max_concurrent_runs: 1,
    next_fire_at: "2026-06-24T00:00:00.000Z",
  }],
  runTriggerFires: [{
    fire_id: "fire-existing",
    tenant_id: tenantId,
    trigger_id: "trigger-existing",
    fire_key: "trigger-existing:2026-06-24T00:00:00.000Z",
    status: "queued",
    scheduled_for: "2026-06-24T00:00:00.000Z",
    run_id: "run-existing",
  }],
  automationIdeas: [{
    id: "idea-existing",
    tenant_id: tenantId,
    title: "Invoice portal reconciliation",
    description: "Match supplier invoice status across a browser portal and finance queue.",
    business_owner: "finance-ops",
    department: "Finance",
    source: "manual",
    stage: "intake",
    priority: "high",
    score: 72,
    scenario_id: null,
    run_trigger_id: null,
    created_by: "principal-1",
    created_at: "2026-06-13T00:00:00.000Z",
    updated_at: "2026-06-13T00:00:00.000Z",
  }],
  roiEstimates: [{
    id: "roi-existing",
    tenant_id: tenantId,
    automation_idea_id: "idea-existing",
    frequency_per_month: 120,
    minutes_per_case: 8,
    exception_rate: 0.1,
    hourly_cost: 40000,
    implementation_effort: 3200000,
    monthly_hours_saved: 14.4,
    estimated_monthly_value: 576000,
    payback_months: 5.555555555555555,
    confidence: "medium",
    created_by: "principal-1",
    created_at: "2026-06-13T00:00:00.000Z",
    updated_at: "2026-06-13T00:00:00.000Z",
  }],
  auditLog: [{
    audit_id: "audit-existing",
    tenant_id: tenantId,
    sequence_no: 1,
    actor: { subject_id: "principal-1", roles: ["admin"] },
    action: "artifact.read",
    outcome: "allow",
    reason: "artifact disclosed",
    correlation_id: "11111111-1111-4111-8111-111111111199",
    idempotency_key: "audit-fixture-1",
    occurred_at: "2026-06-15T00:00:00Z",
    payload_schema_ref: "audit/security-boundary-decision@1",
    retention_until: "2026-09-15T00:00:00Z",
    legal_hold: false,
    previous_hash: null,
    hash: "sha256:fixture",
    created_at: "2026-06-15T00:00:00Z",
  }],
  connectors: [{
    catalog_id: "91000000-0000-4000-8000-000000000001",
    connector_id: "sap-web",
    name: "SAP Web / ERP Portal",
    kind: "browser",
    status: "candidate",
  }],
  templates: [{
    catalog_id: "92000000-0000-4000-8000-000000000001",
    template_id: "sap-web-list-extract",
    connector_id: "sap-web",
    name: "SAP list extract",
    kind: "browser_workflow",
    status: "candidate",
  }],
  gatewayPolicies: [{
    id: "gp-default",
    tenant_id: tenantId,
    model: "default",
    version: 1,
    capabilities: { jsonMode: true },
    budget: { maxCost: 1 },
  }],
  sites: [{
    site_profile_id: "site-red",
    tenant_id: tenantId,
    risk: "red",
    approved: false,
    circuit_state: "closed",
  }],
  siteElements: [{
    element_id: "element-submit",
    tenant_id: tenantId,
    site_profile_id: "site-red",
    element_key: "SubmitButton",
    label: "Submit button",
    selector: "button[type=submit]",
    element_type: "button",
    stability: "stable",
    source: "manual",
    usage_count: 2,
    created_at: "2026-06-13T00:00:00.000Z",
    updated_at: "2026-06-13T00:00:00.000Z",
  }],
  captureSessions: [{
    capture_session_id: "capture-existing",
    tenant_id: tenantId,
    site_profile_id: "site-red",
    status: "awaiting_login",
    detail: "operator login pending",
    updated_at: "2026-06-13T00:00:00.000Z",
  }, {
    capture_session_id: "capture-other-tenant",
    tenant_id: otherTenantId,
    site_profile_id: "site-red",
    status: "captured",
    updated_at: "2026-06-13T00:00:00.000Z",
  }],
  browserRecordingSessions: [{
    recording_session_id: "recording-existing",
    tenant_id: tenantId,
    site_profile_id: "site-red",
    name: "Existing browser recording",
    start_url: "https://portal.example.test/invoices",
    status: "recording",
    event_count: 1,
    draft_ir: null,
    validation_report: null,
    updated_by: "principal-1",
    created_at: "2026-06-13T00:00:00.000Z",
    updated_at: "2026-06-13T00:00:00.000Z",
  }],
  browserRecordingEvents: [{
    event_id: "recording-event-existing",
    tenant_id: tenantId,
    recording_session_id: "recording-existing",
    seq: 1,
    event_type: "navigate",
    url: "https://portal.example.test/invoices",
    selector: null,
    element_key: null,
    label: "Invoice portal",
    value_preview: null,
    captured_at: "2026-06-13T00:00:00.000Z",
    created_at: "2026-06-13T00:00:00.000Z",
  }],
});

const handlers = createMinimalControlPlaneHandlers(services);
const registry = createControlPlaneValidatorRegistry();
const binder = createRouteBinder(handlers, registry);

const operationIds = CONTROL_PLANE_OPERATION_BINDINGS.map((binding) => binding.operationId);
for (const operationId of [
  "getAuthReadiness",
  "createRun",
  "getRun",
  "listRunSteps",
  "streamRunSteps",
  "listRunArtifacts",
  "listRuns",
  "abortRun",
  "listRunTriggers",
  "createRunTrigger",
  "getRunTrigger",
  "updateRunTrigger",
  "pauseRunTrigger",
  "resumeRunTrigger",
  "listRunTriggerFires",
  "listOpsAlerts",
  "ackOpsAlert",
  "getOpsHealth",
  "listAutomationIdeas",
  "createAutomationIdea",
  "getAutomationIdea",
  "updateAutomationIdea",
  "transitionAutomationIdea",
  "upsertRoiEstimate",
  "getRoiEstimate",
  "listAuditLog",
  "exportAuditLog",
  "listConnectors",
  "listTemplates",
  "validateScenario",
  "promoteScenario",
  "promoteScenarioFromRun",
  "archiveScenario",
  "listScenarioVersions",
  "getScenarioVersion",
  "rollbackScenario",
  "listHumanTasks",
  "startHumanTask",
  "resolveHumanTask",
  "assignHumanTask",
  "escalateHumanTask",
  "listWorkitems",
  "replayDeadLetter",
  "getArtifact",
  "listGatewayPolicies",
  "getGatewayPolicy",
  "createGatewayPolicy",
  "updateGatewayPolicy",
  "deleteGatewayPolicy",
  "listSites",
  "approveSite",
  "listSessionCaptures",
  "updateSitePageState",
  "listSiteElements",
  "createSiteElement",
  "updateSiteElement",
  "probeSiteElement",
  "deleteSiteElement",
  "listBrowserRecordings",
  "startBrowserRecording",
  "listBrowserRecordingEvents",
  "appendBrowserRecordingEvents",
  "completeBrowserRecording",
] satisfies OperationId[]) {
  assert.ok(operationIds.includes(operationId), `operation binding missing ${operationId}`);
}

assert.equal(registry.getOperation("createRun").requiresAuth, true);
assert.equal(registry.getOperation("getAuthReadiness").requiresAuth, true);
assert.equal(registry.getOperation("createRun").requiresTenantBinding, true);
assert.equal(registry.getOperation("createRun").requiresIdempotencyKey, true);
assert.equal(registry.getOperation("promoteScenario").ifMatch?.entity, "scenario_version");
assert.equal(registry.getOperation("promoteScenarioFromRun").requiresIdempotencyKey, true);
assert.equal(registry.getOperation("createRunTrigger").requiresIdempotencyKey, true);
assert.equal(registry.getOperation("pauseRunTrigger").requiresIdempotencyKey, true);
assert.equal(registry.getOperation("resumeRunTrigger").requiresIdempotencyKey, true);
assert.equal(registry.getOperation("ackOpsAlert").requiresIdempotencyKey, true);
assert.equal(registry.getOperation("createAutomationIdea").requiresIdempotencyKey, true);
assert.equal(registry.getOperation("updateAutomationIdea").requiresIdempotencyKey, true);
assert.equal(registry.getOperation("transitionAutomationIdea").requiresIdempotencyKey, true);
assert.equal(registry.getOperation("upsertRoiEstimate").requiresIdempotencyKey, true);
assert.equal(registry.getOperation("archiveScenario").ifMatch?.entity, "scenario_version");
assert.equal(registry.getOperation("rollbackScenario").ifMatch?.entity, "scenario_version");
assert.equal(registry.getOperation("archiveScenario").requiresIdempotencyKey, true);
assert.equal(registry.getOperation("rollbackScenario").requiresIdempotencyKey, true);
assert.equal(registry.getOperation("createGatewayPolicy").requiresIdempotencyKey, true);
assert.equal(registry.getOperation("updateGatewayPolicy").ifMatch?.entity, "gateway_policy");
assert.equal(registry.getOperation("deleteGatewayPolicy").ifMatch?.entity, "gateway_policy");
assert.equal(registry.getOperation("deleteGatewayPolicy").requiresIdempotencyKey, true);
assert.equal(registry.getOperation("createSiteElement").requiresIdempotencyKey, true);
assert.equal(registry.getOperation("updateSiteElement").requiresIdempotencyKey, true);
assert.equal(registry.getOperation("probeSiteElement").requiresIdempotencyKey, true);
assert.equal(registry.getOperation("deleteSiteElement").requiresIdempotencyKey, true);
assert.equal(registry.getOperation("startBrowserRecording").requiresIdempotencyKey, true);
assert.equal(registry.getOperation("appendBrowserRecordingEvents").requiresIdempotencyKey, true);
assert.equal(registry.getOperation("completeBrowserRecording").requiresIdempotencyKey, true);
assert.equal(staticRbacAction("createRun"), "run.create");
assert.equal(staticRbacAction("getAuthReadiness"), "principal.read");
assert.equal(staticRbacAction("abortRun"), "run.abort");
assert.equal(staticRbacAction("listRunSteps"), "run.read");
assert.equal(staticRbacAction("streamRunSteps"), "run.read");
assert.equal(staticRbacAction("listRunArtifacts"), "artifact.read");
assert.equal(staticRbacAction("listRunTriggers"), "trigger.read");
assert.equal(staticRbacAction("createRunTrigger"), "trigger.manage");
assert.equal(staticRbacAction("pauseRunTrigger"), "trigger.manage");
assert.equal(staticRbacAction("resumeRunTrigger"), "trigger.manage");
assert.equal(staticRbacAction("listRunTriggerFires"), "trigger.read");
assert.equal(staticRbacAction("listOpsAlerts"), "ops_alert.read");
assert.equal(staticRbacAction("ackOpsAlert"), "ops_alert.ack");
assert.equal(staticRbacAction("getOpsHealth"), "ops_alert.read");
assert.equal(staticRbacAction("listAutomationIdeas"), "automation_idea.read");
assert.equal(staticRbacAction("createAutomationIdea"), "automation_idea.manage");
assert.equal(staticRbacAction("getAutomationIdea"), "automation_idea.read");
assert.equal(staticRbacAction("updateAutomationIdea"), "automation_idea.manage");
assert.equal(staticRbacAction("transitionAutomationIdea"), "automation_idea.manage");
assert.equal(staticRbacAction("upsertRoiEstimate"), "automation_idea.manage");
assert.equal(staticRbacAction("getRoiEstimate"), "automation_idea.read");
assert.equal(staticRbacAction("listAuditLog"), "audit.read");
assert.equal(staticRbacAction("exportAuditLog"), "audit.read");
assert.equal(staticRbacAction("listConnectors"), "connector.read");
assert.equal(staticRbacAction("listTemplates"), "connector.read");
assert.equal(staticRbacAction("validateScenario"), "scenario.read");
assert.equal(staticRbacAction("promoteScenario"), "scenario.promote");
assert.equal(staticRbacAction("promoteScenarioFromRun"), "scenario.promote");
assert.equal(staticRbacAction("archiveScenario"), "scenario.update");
assert.equal(staticRbacAction("listScenarioVersions"), "scenario.read");
assert.equal(staticRbacAction("getScenarioVersion"), "scenario.read");
assert.equal(staticRbacAction("rollbackScenario"), "scenario.update");
assert.equal(staticRbacAction("assignHumanTask"), "human_task.assign");
assert.equal(staticRbacAction("escalateHumanTask"), "human_task.escalate");
assert.equal(staticRbacAction("listGatewayPolicies"), "gateway_policy.read");
assert.equal(staticRbacAction("getGatewayPolicy"), "gateway_policy.read");
assert.equal(staticRbacAction("createGatewayPolicy"), "gateway_policy.edit");
assert.equal(staticRbacAction("updateGatewayPolicy"), "gateway_policy.edit");
assert.equal(staticRbacAction("deleteGatewayPolicy"), "gateway_policy.edit");
assert.equal(staticRbacAction("listSessionCaptures"), "session.capture");
assert.equal(staticRbacAction("updateSitePageState"), "site.update");
assert.equal(staticRbacAction("listSiteElements"), "site.read");
assert.equal(staticRbacAction("createSiteElement"), "site.update");
assert.equal(staticRbacAction("updateSiteElement"), "site.update");
assert.equal(staticRbacAction("probeSiteElement"), "site.update");
assert.equal(staticRbacAction("deleteSiteElement"), "site.update");
assert.equal(staticRbacAction("listBrowserRecordings"), "site.read");
assert.equal(staticRbacAction("startBrowserRecording"), "site.update");
assert.equal(staticRbacAction("appendBrowserRecordingEvents"), "site.update");
assert.equal(staticRbacAction("completeBrowserRecording"), "site.update");
assert.throws(() => registry.getOperation("unknownOperation" as OperationId), /No control-plane operation binding/);

assert.equal(registry.getBodyValidator("createRun")?.validate({}).valid, false);
assert.equal(registry.getBodyValidator("createRun")?.validate({ scenario_version_id: "sv-1" }).valid, false);
assert.equal(registry.getBodyValidator("createRun")?.validate({ scenario_version_id: "sv-1", params: {} }).valid, true);
assert.equal(registry.getBodyValidator("createRun")?.validate({ scenario_version_id: "sv-1", params: {}, model: "gpt-4o-mini" }).valid, true);
assert.equal(registry.getBodyValidator("createRun")?.validate({ scenario_version_id: "sv-1", params: {}, tenant_id: "t1" }).valid, false);
assert.equal(registry.getBodyValidator("createRun")?.validate({ scenario_version_id: "sv-1", params: {}, model: "gpt-4o-mini", tenant_id: "t1" }).valid, false);
assert.equal(registry.getBodyValidator("promoteScenarioFromRun")?.validate({}).valid, false);
assert.equal(registry.getBodyValidator("promoteScenarioFromRun")?.validate({ run_id: "run-completed" }).valid, true);
assert.equal(registry.getBodyValidator("createRunTrigger")?.validate({}).valid, false);
assert.equal(registry.getBodyValidator("createRunTrigger")?.validate({
  scenario_version_id: "sv-1",
  cron_expression: "0 9 * * 1-5",
  timezone: "Asia/Seoul",
}).valid, true);
assert.equal(registry.getBodyValidator("createRunTrigger")?.validate({
  trigger_type: "webhook",
  scenario_version_id: "sv-1",
  webhook_secret_ref: "secret://tenant-a/run-trigger/webhook",
}).valid, true);
assert.equal(registry.getBodyValidator("createRunTrigger")?.validate({
  trigger_type: "webhook",
  scenario_version_id: "sv-1",
  webhook_secret_ref: "secret://tenant-a/run-trigger/webhook",
  cron_expression: "0 9 * * 1-5",
}).valid, false);
assert.equal(registry.getBodyValidator("createAutomationIdea")?.validate({}).valid, false);
assert.equal(registry.getBodyValidator("createAutomationIdea")?.validate({
  title: "Portal invoice triage",
  description: "Prioritize invoice exceptions from a browser portal.",
  business_owner: "finance-ops",
  department: "Finance",
}).valid, true);
assert.equal(registry.getBodyValidator("transitionAutomationIdea")?.validate({}).valid, false);
assert.equal(registry.getBodyValidator("transitionAutomationIdea")?.validate({ stage: "assess" }).valid, true);
assert.equal(registry.getBodyValidator("upsertRoiEstimate")?.validate({
  frequency_per_month: 100,
  minutes_per_case: 5,
  exception_rate: 0.1,
  hourly_cost: 35000,
  implementation_effort: 1200000,
}).valid, true);
assert.equal(registry.getBodyValidator("assignHumanTask")?.validate({}).valid, false);
assert.equal(registry.getBodyValidator("assignHumanTask")?.validate({ assignee: "reviewer-1" }).valid, true);
assert.equal(registry.getBodyValidator("ackOpsAlert")?.validate({ comment: "확인 중" }).valid, true);
assert.equal(registry.getBodyValidator("createGatewayPolicy")?.validate({ budget: { maxCost: 1 } }).valid, false);
assert.equal(registry.getBodyValidator("createGatewayPolicy")?.validate({ model: "codex", capabilities: {}, budget: {} }).valid, true);
assert.equal(registry.getBodyValidator("updateGatewayPolicy")?.validate({ budget: { maxCost: 1 } }).valid, false);
assert.equal(registry.getBodyValidator("updateSitePageState")?.validate({ page_state_selectors: { flags: {} } }).valid, true);
assert.equal(registry.getBodyValidator("createSiteElement")?.validate({}).valid, false);
assert.equal(registry.getBodyValidator("createSiteElement")?.validate({ element_key: "SubmitButton", label: "Submit", selector: "button[type=submit]" }).valid, true);
assert.equal(registry.getBodyValidator("updateSiteElement")?.validate({ selector: "#submit" }).valid, true);
assert.equal(registry.getBodyValidator("probeSiteElement")?.validate({ sample_url: "https://portal.example.test/form" }).valid, true);
assert.equal(registry.getBodyValidator("startBrowserRecording")?.validate({}).valid, false);
assert.equal(registry.getBodyValidator("startBrowserRecording")?.validate({ name: "Portal recording" }).valid, true);
assert.equal(registry.getBodyValidator("appendBrowserRecordingEvents")?.validate({}).valid, false);
assert.equal(registry.getBodyValidator("appendBrowserRecordingEvents")?.validate({ events: [] }).valid, false);
assert.equal(registry.getBodyValidator("appendBrowserRecordingEvents")?.validate({ events: [{}] }).valid, false);
assert.equal(registry.getBodyValidator("appendBrowserRecordingEvents")?.validate({ events: [{ event_type: "navigate" }] }).valid, false);
assert.equal(registry.getBodyValidator("appendBrowserRecordingEvents")?.validate({ events: [{ event_type: "click" }] }).valid, false);
assert.equal(registry.getBodyValidator("appendBrowserRecordingEvents")?.validate({ events: [{ event_type: "select", selector: "select[name=status]" }] }).valid, false);
assert.equal(registry.getBodyValidator("appendBrowserRecordingEvents")?.validate({ events: [{ event_type: "click", selector: "button" }] }).valid, true);
assert.equal(registry.getBodyValidator("appendBrowserRecordingEvents")?.validate({ events: [{ event_type: "navigate", url: "https://portal.example.test/form" }] }).valid, true);
assert.equal(registry.getBodyValidator("appendBrowserRecordingEvents")?.validate({ events: [{ event_type: "select", selector: "select[name=status]", value_preview: "approved" }] }).valid, true);
assert.equal(registry.getParamsValidator("getRun")?.validate({}).valid, false);
assert.equal(registry.getParamsValidator("getRun")?.validate({ run_id: "run-existing" }).valid, true);
assert.equal(registry.getParamsValidator("listRunSteps")?.validate({ run_id: "run-existing" }).valid, true);
assert.equal(registry.getParamsValidator("streamRunSteps")?.validate({ run_id: "run-existing" }).valid, true);
assert.equal(registry.getParamsValidator("listRunArtifacts")?.validate({ run_id: "run-existing" }).valid, true);
assert.equal(registry.getParamsValidator("getRunTrigger")?.validate({ trigger_id: "trigger-existing" }).valid, true);
assert.equal(registry.getParamsValidator("listRunTriggerFires")?.validate({ trigger_id: "trigger-existing" }).valid, true);
assert.equal(registry.getParamsValidator("getAutomationIdea")?.validate({ idea_id: "idea-existing" }).valid, true);
assert.equal(registry.getParamsValidator("getRoiEstimate")?.validate({ idea_id: "idea-existing" }).valid, true);
assert.equal(registry.getParamsValidator("assignHumanTask")?.validate({ human_task_id: "task-open" }).valid, true);
assert.equal(registry.getParamsValidator("listSessionCaptures")?.validate({ site_profile_id: "site-red" }).valid, true);
assert.equal(registry.getParamsValidator("updateSitePageState")?.validate({ site_profile_id: "site-red" }).valid, true);
assert.equal(registry.getParamsValidator("listSiteElements")?.validate({ site_profile_id: "site-red" }).valid, true);
assert.equal(registry.getParamsValidator("updateSiteElement")?.validate({ site_profile_id: "site-red", element_id: "el-submit" }).valid, true);
assert.equal(registry.getParamsValidator("probeSiteElement")?.validate({ site_profile_id: "site-red", element_id: "el-submit" }).valid, true);
assert.equal(registry.getParamsValidator("listBrowserRecordings")?.validate({ site_profile_id: "site-red" }).valid, true);
assert.equal(registry.getParamsValidator("appendBrowserRecordingEvents")?.validate({ site_profile_id: "site-red", recording_session_id: "recording-existing" }).valid, true);
assert.equal(registry.getParamsValidator("ackOpsAlert")?.validate({ alert_id: "bot_pool:browser-default" }).valid, true);
assert.equal(registry.getQueryValidator("listRuns")?.validate(undefined).valid, false);
assert.equal(registry.getQueryValidator("listRunTriggers")?.validate({ status: "enabled" }).valid, true);
assert.equal(registry.getQueryValidator("listRunTriggerFires")?.validate({}).valid, true);
assert.equal(registry.getQueryValidator("listOpsAlerts")?.validate({ severity: "critical", source: "run_sla" }).valid, true);
assert.equal(registry.getQueryValidator("listOpsAlerts")?.validate({ severity: "warning", source: "failure_spike" }).valid, true);
assert.equal(registry.getQueryValidator("listOpsAlerts")?.validate({ source: "bot_pool", status: "acknowledged" }).valid, true);
assert.equal(registry.getQueryValidator("listAutomationIdeas")?.validate({ stage: "intake" }).valid, true);
assert.equal(registry.getQueryValidator("listAuditLog")?.validate({ action: "artifact.read", outcome: "allow" }).valid, true);
assert.equal(registry.getQueryValidator("exportAuditLog")?.validate({ action: "artifact.read", outcome: "allow", format: "csv" }).valid, true);
assert.equal(registry.getQueryValidator("listConnectors")?.validate({ kind: "browser", status: "candidate" }).valid, true);
assert.equal(registry.getQueryValidator("listTemplates")?.validate({ connector_id: "sap-web" }).valid, true);
assert.equal(registry.getQueryValidator("listSiteElements")?.validate({ stability: "stable", search: "submit" }).valid, true);
assert.equal(registry.getQueryValidator("listBrowserRecordings")?.validate({ status: "recording" }).valid, true);
assert.equal(registry.getQueryValidator("listBrowserRecordingEvents")?.validate({}).valid, true);
assert.equal(registry.getQueryValidator("deleteGatewayPolicy")?.validate({}).valid, false);
assert.equal(registry.getQueryValidator("deleteGatewayPolicy")?.validate({ model: "codex" }).valid, true);

const runRoute = binder.bind("createRun");
assert.equal(runRoute.method, "POST");
assert.equal(runRoute.url, "/v1/runs");
assert.deepEqual(runRoute.preHandlers, [
  "correlation",
  "authenticate",
  "bindTenant",
  "openApiValidate",
  "rbac",
  "idempotencyReplay",
  "ifMatch",
  "handler",
  "errorMapper",
]);
assert.throws(() => createRouteBinder({}, registry).bind("getRun"), /No control-plane handler/);

const fastifyRoutes = createFastifyCompatibleRoutes([binder.bind("getRun")], {
  async inject() {
    return { status: 200, body: { ok: true } };
  },
});
assert.equal(fastifyRoutes[0]?.url, "/v1/runs/:run_id");

const created = await handlers.createRun!(ctx("createRun", {
  method: "POST",
  path: "/v1/runs",
  body: { scenario_version_id: "sv-2", params: { as_of: "2026-06-13T10:00:00Z" } },
}));
assert.equal(created.status, 201);
assert.equal((created.body as { status: string }).status, "queued");
assert.equal((created.body as { as_of: string }).as_of, "2026-06-13T10:00:00Z");

const listed = await handlers.listRuns!(ctx("listRuns", {
  method: "GET",
  path: "/v1/runs",
  query: { status: "running" },
}));
assert.equal((listed.body as { items: unknown[] }).items.length, 1);

const aborted = await handlers.abortRun!(ctx("abortRun", {
  method: "POST",
  path: "/v1/runs/{run_id}/abort",
  params: { run_id: "run-existing" },
}));
assert.equal(aborted.status, 202);
assert.equal((aborted.body as { status: string }).status, "cancelled");
await assertApiError(
  () => handlers.abortRun!(ctx("abortRun", { method: "POST", path: "/v1/runs/{run_id}/abort", params: { run_id: "run-existing" } })),
  "RUN_ALREADY_TERMINAL",
);
await assertApiError(
  () => handlers.abortRun!(ctx("abortRun", { method: "POST", path: "/v1/runs/{run_id}/abort", params: { run_id: "run-suspending" } })),
  "WORKITEM_CHECKOUT_CONFLICT",
);

const triggerList = await handlers.listRunTriggers!(ctx("listRunTriggers", {
  method: "GET",
  path: "/v1/run-triggers",
  query: { status: "enabled" },
}));
assert.equal((triggerList.body as { items: unknown[] }).items.length, 1);
const triggerCreated = await handlers.createRunTrigger!(ctx("createRunTrigger", {
  method: "POST",
  path: "/v1/run-triggers",
  body: {
    scenario_version_id: "sv-2",
    cron_expression: "30 8 * * 1-5",
    timezone: "Asia/Seoul",
    params: { team: "finance" },
    catchup_policy: "fire_once",
    max_concurrent_runs: 2,
  },
}));
assert.equal(triggerCreated.status, 201);
assert.equal((triggerCreated.body as { status: string }).status, "enabled");
assert.equal((triggerCreated.body as { trigger_type: string }).trigger_type, "cron");
const webhookTriggerCreated = await handlers.createRunTrigger!(ctx("createRunTrigger", {
  method: "POST",
  path: "/v1/run-triggers",
  body: {
    trigger_type: "webhook",
    scenario_version_id: "sv-3",
    webhook_secret_ref: "secret://tenant-a/run-trigger/webhook",
  },
}));
assert.equal(webhookTriggerCreated.status, 201);
assert.equal((webhookTriggerCreated.body as { trigger_type: string }).trigger_type, "webhook");
assert.equal((webhookTriggerCreated.body as { webhook_secret_configured: boolean }).webhook_secret_configured, true);
const triggerId = (triggerCreated.body as { trigger_id: string }).trigger_id;
const triggerPaused = await handlers.pauseRunTrigger!(ctx("pauseRunTrigger", {
  method: "POST",
  path: "/v1/run-triggers/{trigger_id}/pause",
  params: { trigger_id: triggerId },
}));
assert.equal((triggerPaused.body as { status: string }).status, "paused");
const triggerResumed = await handlers.resumeRunTrigger!(ctx("resumeRunTrigger", {
  method: "POST",
  path: "/v1/run-triggers/{trigger_id}/resume",
  params: { trigger_id: triggerId },
}));
assert.equal((triggerResumed.body as { status: string }).status, "enabled");
const triggerFires = await handlers.listRunTriggerFires!(ctx("listRunTriggerFires", {
  method: "GET",
  path: "/v1/run-triggers/{trigger_id}/fires",
  params: { trigger_id: "trigger-existing" },
}));
assert.equal((triggerFires.body as { items: unknown[] }).items.length, 1);
const alertAcked = await handlers.ackOpsAlert!(ctx("ackOpsAlert", {
  method: "POST",
  path: "/v1/ops-alerts/{alert_id}/ack",
  params: { alert_id: "bot_pool:browser-default" },
  body: { comment: "확인 중" },
}));
assert.equal((alertAcked.body as { status: string }).status, "acknowledged");
assert.equal((alertAcked.body as { source: string }).source, "bot_pool");
const opsHealth = await handlers.getOpsHealth!(ctx("getOpsHealth", {
  method: "GET",
  path: "/v1/ops/health",
}));
assert.equal((opsHealth.body as { status: string }).status, "ok");

const ideaList = await handlers.listAutomationIdeas!(ctx("listAutomationIdeas", {
  method: "GET",
  path: "/v1/automation-ideas",
  query: { stage: "intake" },
}));
assert.equal((ideaList.body as { items: unknown[] }).items.length, 1);
const ideaCreated = await handlers.createAutomationIdea!(ctx("createAutomationIdea", {
  method: "POST",
  path: "/v1/automation-ideas",
  body: {
    title: "Vendor portal status checks",
    description: "Check vendor payment status in a browser portal and flag exceptions.",
    business_owner: "finance-ops",
    department: "Finance",
    priority: "high",
    score: 80,
  },
}));
assert.equal(ideaCreated.status, 201);
const ideaId = (ideaCreated.body as { id: string }).id;
const ideaTransitioned = await handlers.transitionAutomationIdea!(ctx("transitionAutomationIdea", {
  method: "POST",
  path: "/v1/automation-ideas/{idea_id}/transition",
  params: { idea_id: ideaId },
  body: { stage: "assess" },
}));
assert.equal((ideaTransitioned.body as { stage: string }).stage, "assess");
const roiEstimate = await handlers.upsertRoiEstimate!(ctx("upsertRoiEstimate", {
  method: "POST",
  path: "/v1/automation-ideas/{idea_id}/roi-estimate",
  params: { idea_id: ideaId },
  body: {
    frequency_per_month: 120,
    minutes_per_case: 8,
    exception_rate: 0.1,
    hourly_cost: 40000,
    implementation_effort: 3200000,
    confidence: "medium",
  },
}));
assert.equal(roiEstimate.status, 200);
assert.equal((roiEstimate.body as { monthly_hours_saved: number }).monthly_hours_saved, 14.4);
const roiFetched = await handlers.getRoiEstimate!(ctx("getRoiEstimate", {
  method: "GET",
  path: "/v1/automation-ideas/{idea_id}/roi-estimate",
  params: { idea_id: ideaId },
}));
assert.equal((roiFetched.body as { estimated_monthly_value: number }).estimated_monthly_value, 576000);
const auditList = await handlers.listAuditLog!(ctx("listAuditLog", {
  method: "GET",
  path: "/v1/audit-log",
  query: { action: "artifact.read", outcome: "allow" },
}));
assert.equal((auditList.body as { items: unknown[] }).items.length, 1);
assert.equal(((auditList.body as { items: Array<{ payload?: unknown }> }).items[0]).payload, undefined);
const auditExport = await handlers.exportAuditLog!(ctx("exportAuditLog", {
  method: "GET",
  path: "/v1/audit-log/export",
  query: { action: "artifact.read", outcome: "allow", format: "csv" },
}));
assert.equal(auditExport.status, 200);
assert.ok(String(auditExport.headers?.["content-type"] ?? "").includes("text/csv"));
assert.ok(String(auditExport.body).includes("audit_id"));
assert.equal(String(auditExport.body).split("\n")[0]?.split(",").includes("payload"), false);
const authReadiness = await handlers.getAuthReadiness!(ctx("getAuthReadiness", {
  method: "GET",
  path: "/v1/auth/readiness",
}));
assert.equal(authReadiness.status, 200);
assert.equal((authReadiness.body as { provider: { mode: string } }).provider.mode, "hs256");
assert.equal((authReadiness.body as { enterprise_sso_ready: boolean }).enterprise_sso_ready, false);
assert.equal((authReadiness.body as { current_principal: { subject_id: string } }).current_principal.subject_id, "principal-1");
const connectorList = await handlers.listConnectors!(ctx("listConnectors", {
  method: "GET",
  path: "/v1/connectors",
  query: { kind: "browser", status: "candidate" },
}));
assert.equal((connectorList.body as { items: Array<{ connector_id: string }> }).items[0]?.connector_id, "sap-web");
const templateList = await handlers.listTemplates!(ctx("listTemplates", {
  method: "GET",
  path: "/v1/templates",
  query: { connector_id: "sap-web" },
}));
assert.equal((templateList.body as { items: Array<{ template_id: string }> }).items[0]?.template_id, "sap-web-list-extract");

const resolved = await handlers.resolveHumanTask!(ctx("resolveHumanTask", {
  method: "POST",
  path: "/v1/human-tasks/{human_task_id}/resolve",
  params: { human_task_id: "task-open" },
  body: { result: "ok" },
}));
assert.equal((resolved.body as { state: string }).state, "resolved");
const assigned = await handlers.assignHumanTask!(ctx("assignHumanTask", {
  method: "POST",
  path: "/v1/human-tasks/{human_task_id}/assign",
  params: { human_task_id: "task-assign" },
  body: { assignee: "reviewer-1" },
}));
assert.equal((assigned.body as { state: string }).state, "assigned");
assert.equal((assigned.body as { assignee: string }).assignee, "reviewer-1");
await assertApiError(
  () => handlers.escalateHumanTask!(ctx("escalateHumanTask", {
    method: "POST",
    path: "/v1/human-tasks/{human_task_id}/escalate",
    params: { human_task_id: "task-assign" },
  })),
  "CONTROL_PLANE_INTERNAL_ERROR",
);
await assertApiError(
  () => handlers.startHumanTask!(ctx("startHumanTask", { method: "POST", path: "/v1/human-tasks/{human_task_id}/start", params: { human_task_id: "task-open" } })),
  "HUMAN_TASK_EXPIRED",
);

await assertApiError(
  () => handlers.getArtifact!(ctx("getArtifact", { method: "GET", path: "/v1/artifacts/{artifact_id}", params: { artifact_id: "artifact-pending" } })),
  "ARTIFACT_NOT_REDACTED",
);
await assertApiError(
  () => handlers.getArtifact!(ctx("getArtifact", { method: "GET", path: "/v1/artifacts/{artifact_id}", params: { artifact_id: "artifact-quarantined" } })),
  "ARTIFACT_NOT_REDACTED",
);
const artifact = await handlers.getArtifact!(ctx("getArtifact", {
  method: "GET",
  path: "/v1/artifacts/{artifact_id}",
  params: { artifact_id: "artifact-redacted" },
}));
assert.equal(artifact.status, 200);
assert.equal((artifact.body as { ref: string }).ref, "artifact://redacted");

const stepList = await handlers.listRunSteps!(ctx("listRunSteps", {
  method: "GET",
  path: "/v1/runs/{run_id}/steps",
  params: { run_id: "run-existing" },
}));
assert.equal(stepList.status, 200);
const stepItems = (stepList.body as { items: Array<Record<string, unknown>> }).items;
assert.equal(stepItems.length, 1);
assert.equal(stepItems[0]?.step_id, "step-1");
assert.deepEqual(stepItems[0]?.artifact_ids, ["artifact-redacted"]);
assert.equal(Object.prototype.hasOwnProperty.call(stepItems[0], "output"), false);
assert.equal(Object.prototype.hasOwnProperty.call(stepItems[0], "page_state_before"), false);

const stepStream = await handlers.streamRunSteps!(ctx("streamRunSteps", {
  method: "GET",
  path: "/v1/runs/{run_id}/steps/stream",
  params: { run_id: "run-existing" },
}));
assert.equal(stepStream.status, 200);
assert.ok(String(stepStream.headers?.["content-type"] ?? "").includes("text/event-stream"));
assert.ok(String(stepStream.body).includes("event: run_steps_changed"));

const artifactList = await handlers.listRunArtifacts!(ctx("listRunArtifacts", {
  method: "GET",
  path: "/v1/runs/{run_id}/artifacts",
  params: { run_id: "run-existing" },
}));
assert.equal(artifactList.status, 200);
const artifactItems = (artifactList.body as { items: Array<Record<string, unknown>> }).items;
assert.equal(artifactItems.length, 1);
assert.equal(artifactItems[0]?.artifact_id, "artifact-redacted");
assert.equal(artifactItems[0]?.step_id, "step-1");
assert.equal(artifactItems[0]?.attempt, 1);
assert.equal(artifactItems[0]?.media_type, "video/webm");
assert.equal(artifactItems[0]?.duration_ms, 1200);
assert.equal(Object.prototype.hasOwnProperty.call(artifactItems[0], "ref"), false);
assert.equal(Object.prototype.hasOwnProperty.call(artifactItems[0], "body"), false);

const promoted = await handlers.promoteScenario!(ctx("promoteScenario", {
  method: "POST",
  path: "/v1/scenarios/{scenario_id}/promote",
  params: { scenario_id: "scenario-1" },
  body: { target: "prod" },
  ifMatch: { kind: "match", currentVersion: 1, nextVersion: 2 },
}));
assert.equal(promoted.headers?.ETag, "2");

const promotedFromRun = await handlers.promoteScenarioFromRun!(ctx("promoteScenarioFromRun", {
  method: "POST",
  path: "/v1/scenarios/{scenario_id}/promote-from-run",
  params: { scenario_id: "scenario-1" },
  body: { run_id: "run-completed" },
}));
assert.equal(promotedFromRun.status, 201);
assert.equal((promotedFromRun.body as { scenario_version_id: string }).scenario_version_id, "scenario-1:v2");
assert.deepEqual((promotedFromRun.body as { promoted_node_ids: string[] }).promoted_node_ids, ["submit"]);

const scenarioVersions = await handlers.listScenarioVersions!(ctx("listScenarioVersions", {
  method: "GET",
  path: "/v1/scenarios/{scenario_id}/versions",
  params: { scenario_id: "scenario-1" },
}));
assert.equal((scenarioVersions.body as { items: unknown[] }).items.length, 1);

const scenarioVersion = await handlers.getScenarioVersion!(ctx("getScenarioVersion", {
  method: "GET",
  path: "/v1/scenarios/{scenario_id}/versions/{version}",
  params: { scenario_id: "scenario-1", version: "1" },
}));
assert.equal(scenarioVersion.headers?.ETag, "1");

const rolledBack = await handlers.rollbackScenario!(ctx("rollbackScenario", {
  method: "POST",
  path: "/v1/scenarios/{scenario_id}/versions/{version}/rollback",
  params: { scenario_id: "scenario-1", version: "1" },
  ifMatch: { kind: "match", currentVersion: 2, nextVersion: 3 },
}));
assert.equal(rolledBack.headers?.ETag, "3");

const archived = await handlers.archiveScenario!(ctx("archiveScenario", {
  method: "POST",
  path: "/v1/scenarios/{scenario_id}/archive",
  params: { scenario_id: "scenario-1" },
  ifMatch: { kind: "match", currentVersion: 3, nextVersion: 4 },
}));
assert.equal(archived.headers?.ETag, "3");

const listedPolicies = await handlers.listGatewayPolicies!(ctx("listGatewayPolicies", {
  method: "GET",
  path: "/v1/gateway/policies",
}));
assert.equal((listedPolicies.body as { items: unknown[] }).items.length, 1);

const createdPolicy = await handlers.createGatewayPolicy!(ctx("createGatewayPolicy", {
  method: "POST",
  path: "/v1/gateway/policy",
  body: { model: "codex-new", capabilities: { jsonMode: true }, budget: { maxCost: 2 }, is_default: true },
}));
assert.equal(createdPolicy.status, 201);
assert.equal(createdPolicy.headers?.ETag, "1");
assert.equal((createdPolicy.body as { is_default: boolean }).is_default, true);
await assertApiError(
  () => handlers.createGatewayPolicy!(ctx("createGatewayPolicy", {
    method: "POST",
    path: "/v1/gateway/policy",
    body: { model: "codex-new", capabilities: {}, budget: {} },
  })),
  "IR_SCHEMA_INVALID",
);

const policy = await handlers.updateGatewayPolicy!(ctx("updateGatewayPolicy", {
  method: "PUT",
  path: "/v1/gateway/policy",
  body: { model: "default", capabilities: { jsonMode: true }, budget: { maxCost: 1 } },
  ifMatch: { kind: "match", currentVersion: 1, nextVersion: 2 },
}));
assert.equal(policy.headers?.ETag, "2");

const deletedPolicy = await handlers.deleteGatewayPolicy!(ctx("deleteGatewayPolicy", {
  method: "DELETE",
  path: "/v1/gateway/policy",
  query: { model: "codex-new" },
  ifMatch: { kind: "match", currentVersion: 1, nextVersion: 2 },
}));
assert.equal((deletedPolicy.body as { deleted: boolean }).deleted, true);
await assertApiError(
  () => handlers.deleteGatewayPolicy!(ctx("deleteGatewayPolicy", {
    method: "DELETE",
    path: "/v1/gateway/policy",
    query: { model: "missing-policy" },
    ifMatch: { kind: "match", currentVersion: 1, nextVersion: 2 },
  })),
  "RESOURCE_NOT_FOUND",
);

const site = await handlers.approveSite!(ctx("approveSite", {
  method: "POST",
  path: "/v1/sites/{site_profile_id}/approve",
  params: { site_profile_id: "site-red" },
  body: { reason: "approved for smoke" },
}));
assert.equal((site.body as { approved: boolean }).approved, true);
const captures = await handlers.listSessionCaptures!(ctx("listSessionCaptures", {
  method: "GET",
  path: "/v1/sites/{site_profile_id}/session/capture",
  params: { site_profile_id: "site-red" },
}));
assert.equal((captures.body as { items: Array<{ capture_session_id: string }> }).items.length, 1);
assert.equal((captures.body as { items: Array<{ capture_session_id: string }> }).items[0]?.capture_session_id, "capture-existing");
const updatedPageState = await handlers.updateSitePageState!(ctx("updateSitePageState", {
  method: "PATCH",
  path: "/v1/sites/{site_profile_id}/page-state",
  params: { site_profile_id: "site-red" },
  body: { page_state_selectors: { flags: { blocked: { kind: "present", selector: ".blocked" } } } },
}));
assert.equal((updatedPageState.body as { site_profile_id: string }).site_profile_id, "site-red");
const listedElements = await handlers.listSiteElements!(ctx("listSiteElements", {
  method: "GET",
  path: "/v1/sites/{site_profile_id}/elements",
  params: { site_profile_id: "site-red" },
  query: { stability: "stable" },
}));
assert.equal((listedElements.body as { items: Array<{ element_key: string }> }).items[0]?.element_key, "SubmitButton");
const createdElement = await handlers.createSiteElement!(ctx("createSiteElement", {
  method: "POST",
  path: "/v1/sites/{site_profile_id}/elements",
  params: { site_profile_id: "site-red" },
  body: { element_key: "SearchInput", label: "Search input", selector: "input[name=q]", element_type: "input" },
}));
assert.equal((createdElement.body as { stability: string }).stability, "stable");
const updatedElement = await handlers.updateSiteElement!(ctx("updateSiteElement", {
  method: "PATCH",
  path: "/v1/sites/{site_profile_id}/elements/{element_id}",
  params: { site_profile_id: "site-red", element_id: "element-submit" },
  body: { selector: "button.submit", stability: "review_needed" },
}));
assert.equal((updatedElement.body as { selector: string }).selector, "button.submit");
const probedElement = await handlers.probeSiteElement!(ctx("probeSiteElement", {
  method: "POST",
  path: "/v1/sites/{site_profile_id}/elements/{element_id}/probe",
  params: { site_profile_id: "site-red", element_id: "element-submit" },
  body: { sample_url: "https://portal.example.test/form" },
}));
assert.equal((probedElement.body as { probe_status: string }).probe_status, "not_run");
assert.equal((probedElement.body as { reason_code: string }).reason_code, "SELECTOR_PROBE_PROVIDER_UNAVAILABLE");
const deletedElement = await handlers.deleteSiteElement!(ctx("deleteSiteElement", {
  method: "DELETE",
  path: "/v1/sites/{site_profile_id}/elements/{element_id}",
  params: { site_profile_id: "site-red", element_id: "element-submit" },
}));
assert.equal((deletedElement.body as { deleted: boolean }).deleted, true);
const recordingList = await handlers.listBrowserRecordings!(ctx("listBrowserRecordings", {
  method: "GET",
  path: "/v1/sites/{site_profile_id}/recordings",
  params: { site_profile_id: "site-red" },
  query: { status: "recording" },
}));
assert.equal((recordingList.body as { items: Array<{ recording_session_id: string }> }).items[0]?.recording_session_id, "recording-existing");
const recordingEvents = await handlers.listBrowserRecordingEvents!(ctx("listBrowserRecordingEvents", {
  method: "GET",
  path: "/v1/sites/{site_profile_id}/recordings/{recording_session_id}/events",
  params: { site_profile_id: "site-red", recording_session_id: "recording-existing" },
}));
assert.equal((recordingEvents.body as { items: Array<{ event_type: string }> }).items[0]?.event_type, "navigate");
const createdRecording = await handlers.startBrowserRecording!(ctx("startBrowserRecording", {
  method: "POST",
  path: "/v1/sites/{site_profile_id}/recordings",
  params: { site_profile_id: "site-red" },
  body: { name: "Vendor portal recording", start_url: "https://portal.example.test/vendors" },
}));
assert.equal(createdRecording.status, 201);
const recordingId = (createdRecording.body as { recording_session_id: string }).recording_session_id;
const appendedRecordingEvents = await handlers.appendBrowserRecordingEvents!(ctx("appendBrowserRecordingEvents", {
  method: "POST",
  path: "/v1/sites/{site_profile_id}/recordings/{recording_session_id}/events",
  params: { site_profile_id: "site-red", recording_session_id: recordingId },
  body: { events: [{ event_type: "click", selector: "button[type=submit]", label: "Submit" }] },
}));
assert.equal((appendedRecordingEvents.body as { appended: number }).appended, 1);
const completedRecording = await handlers.completeBrowserRecording!(ctx("completeBrowserRecording", {
  method: "POST",
  path: "/v1/sites/{site_profile_id}/recordings/{recording_session_id}/complete",
  params: { site_profile_id: "site-red", recording_session_id: recordingId },
}));
assert.equal((completedRecording.body as { status: string }).status, "completed");
assert.equal(typeof (completedRecording.body as { draft_ir: unknown }).draft_ir, "object");
assert.deepEqual((completedRecording.body as { validation_report: unknown }).validation_report, { errors: [], warnings: [] });

assert.deepEqual(apiErrorResponse("AUTHZ_FORBIDDEN", "corr").status, 403);
assert.equal(exceptionResponse(new ApiResponseException("RUN_NOT_FOUND"), "corr").status, 404);

const scaffold = createFakeControlPlaneScaffold({
  humanTasks: [{
    human_task_id: "task-escalate-rbac",
    tenant_id: tenantId,
    state: "open",
    kind: "captcha",
    run_id: "run-existing",
  }, {
    human_task_id: "task-assignee-scope",
    tenant_id: tenantId,
    state: "in_progress",
    kind: "captcha",
    run_id: "run-existing",
    assignee: "other-principal",
    assignee_role: "reviewer",
  }, {
    human_task_id: "task-assignee-role-scope",
    tenant_id: tenantId,
    state: "in_progress",
    kind: "captcha",
    run_id: "run-existing",
    assignee: "principal-1",
    assignee_role: "approver",
  }, {
    human_task_id: "task-assignee-ok",
    tenant_id: tenantId,
    state: "in_progress",
    kind: "captcha",
    run_id: "run-existing",
    assignee: "principal-1",
    assignee_role: "reviewer",
  }],
});
const baseHeaders = {
  authorization: "Bearer fixture",
  "x-tenant-id": tenantId,
  "x-subject-id": "principal-1",
};
const unmatchedRoute = await scaffold.runner.inject({
  method: "GET",
  url: "/v1/no-such-route",
  headers: { ...baseHeaders, "x-roles": "admin" },
});
assert.equal(unmatchedRoute.status, 404);
assert.equal((unmatchedRoute.body as { code: string }).code, "RESOURCE_NOT_FOUND");

const missingIdempotency = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/runs",
  headers: { ...baseHeaders, "x-roles": "admin" },
  body: { scenario_version_id: "sv-2", params: {} },
});
assert.equal(missingIdempotency.status, 422);
assert.equal((missingIdempotency.body as { code: string }).code, "IR_SCHEMA_INVALID");
const viewerCreate = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/runs",
  headers: { ...baseHeaders, "x-roles": "viewer", "idempotency-key": "run-create-viewer" },
  body: { scenario_version_id: "sv-2", params: {} },
});
assert.equal(viewerCreate.status, 403);
assert.equal((viewerCreate.body as { code: string }).code, "AUTHZ_FORBIDDEN");
assert.equal("reason" in (viewerCreate.body as Record<string, unknown>), false);
assert.equal("action" in (viewerCreate.body as Record<string, unknown>), false);
const viewerValidateScenario = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/scenarios/sv-1/validate",
  headers: { ...baseHeaders, "x-roles": "viewer" },
  body: { dry_run: true },
});
assert.equal(viewerValidateScenario.status, 200);
const viewerPromoteScenario = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/scenarios/sv-1/promote",
  headers: { ...baseHeaders, "x-roles": "viewer", "idempotency-key": "viewer-promote", "if-match": "1" },
  body: { target: "prod" },
});
assert.equal(viewerPromoteScenario.status, 403);
assert.equal((viewerPromoteScenario.body as { code: string }).code, "AUTHZ_FORBIDDEN");
const gatewayPolicyFromRunner = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/gateway/policy",
  headers: { ...baseHeaders, "x-roles": "admin", "idempotency-key": "gateway-create-1" },
  body: { model: "scaffold-gw", capabilities: { jsonMode: true }, budget: { maxCost: 1 } },
});
assert.equal(gatewayPolicyFromRunner.status, 201);
const deletedGatewayPolicyFromRunner = await scaffold.runner.inject({
  method: "DELETE",
  url: "/v1/gateway/policy?model=scaffold-gw",
  headers: { ...baseHeaders, "x-roles": "admin", "idempotency-key": "gateway-delete-1", "if-match": "1" },
});
assert.equal(deletedGatewayPolicyFromRunner.status, 200);
assert.equal((deletedGatewayPolicyFromRunner.body as { deleted: boolean }).deleted, true);
const invalidRoleClaim = await scaffold.runner.inject({
  method: "GET",
  url: "/v1/runs/run-existing",
  headers: { ...baseHeaders, "x-roles": "viewer,bogus" },
});
assert.equal(invalidRoleClaim.status, 403);
assert.equal((invalidRoleClaim.body as { code: string }).code, "AUTHZ_FORBIDDEN");
const adminAfterViewerDeny = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/runs",
  headers: { ...baseHeaders, "x-roles": "admin", "idempotency-key": "run-create-viewer" },
  body: { scenario_version_id: "sv-2", params: {} },
});
assert.equal(adminAfterViewerDeny.status, 201);

const inFlight = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/runs",
  headers: { ...baseHeaders, "x-roles": "admin", "idempotency-key": "run-create-1" },
  body: { scenario_version_id: "sv-2", params: {} },
});
assert.equal(inFlight.status, 201);
const secondCreate = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/runs",
  headers: { ...baseHeaders, "x-roles": "admin", "idempotency-key": "run-create-2" },
  body: { scenario_version_id: "sv-3", params: {} },
});
assert.equal(secondCreate.status, 201);
const mismatch = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/runs",
  headers: { ...baseHeaders, "x-roles": "admin", "idempotency-key": "run-create-2" },
  body: { scenario_version_id: "sv-4", params: {} },
});
assert.equal(mismatch.status, 412);
assert.equal((mismatch.body as { code: string }).code, "SCENARIO_VERSION_CONFLICT");

const inFlightScaffold = createFakeControlPlaneScaffold();
const inFlightDeps: typeof inFlightScaffold.deps = {
  ...inFlightScaffold.deps,
  idempotency: {
    async reserve() {
      return { kind: "in_flight", recordId: "idem-processing", status: "processing" as const };
    },
    async saveResult() {},
    async saveFailure() {},
    async release() {},
  },
};
const inFlightRunner = new FakeControlPlaneRunner({
  routes: inFlightScaffold.routes,
  deps: inFlightDeps,
  authorizationResolver: createInMemoryAuthorizationResolver(inFlightScaffold.services),
});
const inFlightResponse = await inFlightRunner.inject({
  method: "POST",
  url: "/v1/runs",
  headers: { ...baseHeaders, "x-roles": "admin", "idempotency-key": "run-create-processing" },
  body: { scenario_version_id: "sv-2", params: {} },
});
assert.equal(inFlightResponse.status, 409);
assert.equal((inFlightResponse.body as { code: string }).code, "WORKITEM_CHECKOUT_CONFLICT");

const operatorEscalate = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/human-tasks/task-escalate-rbac/escalate",
  headers: { ...baseHeaders, "x-roles": "operator", "idempotency-key": "escalate-operator" },
  body: {},
});
assert.equal(operatorEscalate.status, 403);
assert.equal((operatorEscalate.body as { code: string }).code, "AUTHZ_FORBIDDEN");
const reviewerEscalate = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/human-tasks/task-escalate-rbac/escalate",
  headers: { ...baseHeaders, "x-roles": "reviewer", "idempotency-key": "escalate-reviewer" },
  body: {},
});
assert.equal(reviewerEscalate.status, 500);
assert.equal((reviewerEscalate.body as { code: string }).code, "CONTROL_PLANE_INTERNAL_ERROR");
const wrongAssigneeResolve = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/human-tasks/task-assignee-scope/resolve",
  headers: { ...baseHeaders, "x-roles": "reviewer", "idempotency-key": "resolve-wrong-assignee" },
  body: { result: "ok" },
});
assert.equal(wrongAssigneeResolve.status, 403);
assert.equal((wrongAssigneeResolve.body as { code: string }).code, "AUTHZ_FORBIDDEN");
const wrongAssigneeRoleResolve = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/human-tasks/task-assignee-role-scope/resolve",
  headers: { ...baseHeaders, "x-roles": "reviewer", "idempotency-key": "resolve-wrong-assignee-role" },
  body: { result: "ok" },
});
assert.equal(wrongAssigneeRoleResolve.status, 403);
assert.equal((wrongAssigneeRoleResolve.body as { code: string }).code, "AUTHZ_FORBIDDEN");
const matchingAssigneeResolve = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/human-tasks/task-assignee-ok/resolve",
  headers: { ...baseHeaders, "x-roles": "reviewer", "idempotency-key": "resolve-matching-assignee" },
  body: { result: "ok" },
});
assert.equal(matchingAssigneeResolve.status, 200);
assert.equal((matchingAssigneeResolve.body as { state: string }).state, "resolved");

console.log("api smoke: control-plane route registry, validators, auth/tenant/RBAC, idempotency replay/mismatch/in-flight, If-Match, gateway policy CRUD, unmatched route, and redaction-gated artifact access covered");
console.log("control-plane fixtures: ALL PASS");

function ctx(operationId: OperationId, overrides: {
  method: ControlPlaneRequestContext["method"];
  path: ControlPlaneRequestContext["path"];
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  ifMatch?: IfMatchDecision;
}): ControlPlaneRequestContext {
  return {
    method: overrides.method,
    path: overrides.path,
    operationId,
    headers: {},
    params: overrides.params ?? {},
    query: overrides.query ?? {},
    body: overrides.body,
    principal,
    tenantBinding,
    authorization: undefined,
    idempotency: undefined,
    ifMatch: overrides.ifMatch,
    correlationId: "corr" as CorrelationId,
    requestHash: "sha256:fixture" as CanonicalRequestHash,
  };
}

async function assertApiError(
  fn: () => Promise<unknown>,
  code: ApiResponseException["code"],
): Promise<void> {
  try {
    await fn();
  } catch (error: unknown) {
    if (isApiResponseExceptionLike(error)) {
      assert.equal(error.code, code);
      return;
    }
    throw error;
  }
  throw new Error(`expected ${code}`);
}

function isApiResponseExceptionLike(error: unknown): error is { code: ApiResponseException["code"] } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  );
}
