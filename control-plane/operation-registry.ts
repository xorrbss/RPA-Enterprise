import type {
  BoundaryValidationFailure,
  BoundaryValidationResult,
  BoundaryValidator,
  ControlPlaneHandler,
  ControlPlanePath,
  FastifyRouteScaffold,
  HttpMethod,
  IfMatchContract,
  OpenApiOperationBinding,
  OpenApiValidatorRegistry,
  OperationId,
  RouteBinder,
} from "../ts/control-plane-contract";
import type { RbacAction } from "../ts/security-middleware-contract";

export type SupportedControlPlaneOperationId = Extract<
  OperationId,
  | "getAuthReadiness"
  | "createRun"
  | "getRun"
  | "listRunSteps"
  | "streamRunSteps"
  | "listRunArtifacts"
  | "listRuns"
  | "abortRun"
  | "listRunTriggers"
  | "createRunTrigger"
  | "getRunTrigger"
  | "updateRunTrigger"
  | "pauseRunTrigger"
  | "resumeRunTrigger"
  | "listRunTriggerFires"
  | "listOpsAlerts"
  | "getOpsHealth"
  | "listAutomationIdeas"
  | "createAutomationIdea"
  | "getAutomationIdea"
  | "updateAutomationIdea"
  | "transitionAutomationIdea"
  | "upsertRoiEstimate"
  | "getRoiEstimate"
  | "listAuditLog"
  | "exportAuditLog"
  | "listConnectors"
  | "listTemplates"
  | "listDocumentJobs"
  | "createDocumentJob"
  | "getDocumentJob"
  | "extractDocumentJob"
  | "getDocumentExtraction"
  | "createDocumentValidationTask"
  | "validateScenario"
  | "promoteScenario"
  | "promoteScenarioFromRun"
  | "archiveScenario"
  | "listScenarioVersions"
  | "getScenarioVersion"
  | "rollbackScenario"
  | "listHumanTasks"
  | "startHumanTask"
  | "resolveHumanTask"
  | "assignHumanTask"
  | "escalateHumanTask"
  | "listWorkitems"
  | "replayDeadLetter"
  | "getArtifact"
  | "listGatewayPolicies"
  | "getGatewayPolicy"
  | "createGatewayPolicy"
  | "updateGatewayPolicy"
  | "deleteGatewayPolicy"
  | "listSites"
  | "approveSite"
  | "listSessionCaptures"
  | "updateSitePageState"
  | "listSiteElements"
  | "createSiteElement"
  | "updateSiteElement"
  | "probeSiteElement"
  | "deleteSiteElement"
  | "listBrowserRecordings"
  | "startBrowserRecording"
  | "listBrowserRecordingEvents"
  | "appendBrowserRecordingEvents"
  | "completeBrowserRecording"
>;

export type ControlPlaneHandlerMap = Readonly<Partial<Record<OperationId, ControlPlaneHandler>>>;

type OperationBindingInit = Omit<
  OpenApiOperationBinding,
  "requiresAuth" | "requiresTenantBinding" | "requiresIdempotencyKey"
> & {
  operationId: SupportedControlPlaneOperationId;
  requiresIdempotencyKey?: boolean;
};

const scenarioIfMatch: IfMatchContract = {
  entity: "scenario_version",
  headerRequired: true,
  conflictCode: "SCENARIO_VERSION_CONFLICT",
};

const gatewayPolicyIfMatch: IfMatchContract = {
  entity: "gateway_policy",
  headerRequired: true,
  conflictCode: "POLICY_VERSION_CONFLICT",
};

const operation = (init: OperationBindingInit): OpenApiOperationBinding => ({
  requiresAuth: true,
  requiresTenantBinding: true,
  requiresIdempotencyKey: init.requiresIdempotencyKey ?? false,
  ...init,
});

export const CONTROL_PLANE_OPERATION_BINDINGS: readonly OpenApiOperationBinding[] = [
  operation({
    operationId: "getAuthReadiness",
    method: "GET",
    path: "/v1/auth/readiness",
    responseSchemaRef: "#/components/schemas/AuthReadiness",
    rbacAction: "principal.read",
  }),
  operation({
    operationId: "createRun",
    method: "POST",
    path: "/v1/runs",
    requestBodySchemaRef: "#/components/schemas/RunCreateRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/Run",
    requiresIdempotencyKey: true,
    rbacAction: "run.create",
  }),
  operation({
    operationId: "listRuns",
    method: "GET",
    path: "/v1/runs",
    querySchemaRef: "#/components/schemas/RunListQuery",
    responseSchemaRef: "#/components/schemas/RunPage",
    rbacAction: "run.read",
  }),
  operation({
    operationId: "getRun",
    method: "GET",
    path: "/v1/runs/{run_id}",
    paramsSchemaRef: "#/components/schemas/RunPathParams",
    responseSchemaRef: "#/components/schemas/Run",
    rbacAction: "run.read",
  }),
  operation({
    operationId: "listRunSteps",
    method: "GET",
    path: "/v1/runs/{run_id}/steps",
    paramsSchemaRef: "#/components/schemas/RunPathParams",
    responseSchemaRef: "#/components/schemas/RunStepList",
    rbacAction: "run.read",
  }),
  operation({
    operationId: "streamRunSteps",
    method: "GET",
    path: "/v1/runs/{run_id}/steps/stream",
    paramsSchemaRef: "#/components/schemas/RunPathParams",
    responseSchemaRef: "#/components/schemas/RunStepStream",
    rbacAction: "run.read",
  }),
  operation({
    operationId: "listRunArtifacts",
    method: "GET",
    path: "/v1/runs/{run_id}/artifacts",
    paramsSchemaRef: "#/components/schemas/RunPathParams",
    responseSchemaRef: "#/components/schemas/RunArtifactList",
    rbacAction: "artifact.read",
  }),
  operation({
    operationId: "abortRun",
    method: "POST",
    path: "/v1/runs/{run_id}/abort",
    paramsSchemaRef: "#/components/schemas/RunPathParams",
    requestBodySchemaRef: "#/components/schemas/AbortRequest",
    requestBodyRequired: false,
    responseSchemaRef: "#/components/schemas/Run",
    rbacAction: "run.abort",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "listRunTriggers",
    method: "GET",
    path: "/v1/run-triggers",
    querySchemaRef: "#/components/schemas/RunTriggerListQuery",
    responseSchemaRef: "#/components/schemas/RunTriggerPage",
    rbacAction: "trigger.read",
  }),
  operation({
    operationId: "createRunTrigger",
    method: "POST",
    path: "/v1/run-triggers",
    requestBodySchemaRef: "#/components/schemas/RunTriggerCreateRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/RunTrigger",
    rbacAction: "trigger.manage",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "getRunTrigger",
    method: "GET",
    path: "/v1/run-triggers/{trigger_id}",
    paramsSchemaRef: "#/components/schemas/RunTriggerPathParams",
    responseSchemaRef: "#/components/schemas/RunTrigger",
    rbacAction: "trigger.read",
  }),
  operation({
    operationId: "updateRunTrigger",
    method: "PATCH",
    path: "/v1/run-triggers/{trigger_id}",
    paramsSchemaRef: "#/components/schemas/RunTriggerPathParams",
    requestBodySchemaRef: "#/components/schemas/RunTriggerUpdateRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/RunTrigger",
    rbacAction: "trigger.manage",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "pauseRunTrigger",
    method: "POST",
    path: "/v1/run-triggers/{trigger_id}/pause",
    paramsSchemaRef: "#/components/schemas/RunTriggerPathParams",
    requestBodySchemaRef: "#/components/schemas/RunTriggerCommandRequest",
    requestBodyRequired: false,
    responseSchemaRef: "#/components/schemas/RunTrigger",
    rbacAction: "trigger.manage",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "resumeRunTrigger",
    method: "POST",
    path: "/v1/run-triggers/{trigger_id}/resume",
    paramsSchemaRef: "#/components/schemas/RunTriggerPathParams",
    requestBodySchemaRef: "#/components/schemas/RunTriggerCommandRequest",
    requestBodyRequired: false,
    responseSchemaRef: "#/components/schemas/RunTrigger",
    rbacAction: "trigger.manage",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "listRunTriggerFires",
    method: "GET",
    path: "/v1/run-triggers/{trigger_id}/fires",
    paramsSchemaRef: "#/components/schemas/RunTriggerPathParams",
    querySchemaRef: "#/components/schemas/RunTriggerFireListQuery",
    responseSchemaRef: "#/components/schemas/RunTriggerFirePage",
    rbacAction: "trigger.read",
  }),
  operation({
    operationId: "listOpsAlerts",
    method: "GET",
    path: "/v1/ops-alerts",
    querySchemaRef: "#/components/schemas/OpsAlertListQuery",
    responseSchemaRef: "#/components/schemas/OpsAlertPage",
    rbacAction: "ops_alert.read",
  }),
  operation({
    operationId: "getOpsHealth",
    method: "GET",
    path: "/v1/ops/health",
    responseSchemaRef: "#/components/schemas/OpsHealth",
    rbacAction: "ops_alert.read",
  }),
  operation({
    operationId: "listAutomationIdeas",
    method: "GET",
    path: "/v1/automation-ideas",
    querySchemaRef: "#/components/schemas/AutomationIdeaListQuery",
    responseSchemaRef: "#/components/schemas/AutomationIdeaPage",
    rbacAction: "automation_idea.read",
  }),
  operation({
    operationId: "listAuditLog",
    method: "GET",
    path: "/v1/audit-log",
    querySchemaRef: "#/components/schemas/AuditLogListQuery",
    responseSchemaRef: "#/components/schemas/AuditLogPage",
    rbacAction: "audit.read",
  }),
  operation({
    operationId: "exportAuditLog",
    method: "GET",
    path: "/v1/audit-log/export",
    querySchemaRef: "#/components/schemas/AuditLogExportQuery",
    responseSchemaRef: "#/components/schemas/AuditLogExportCsv",
    rbacAction: "audit.read",
  }),
  operation({
    operationId: "listConnectors",
    method: "GET",
    path: "/v1/connectors",
    querySchemaRef: "#/components/schemas/ConnectorCatalogListQuery",
    responseSchemaRef: "#/components/schemas/ConnectorCatalogPage",
    rbacAction: "connector.read",
  }),
  operation({
    operationId: "listTemplates",
    method: "GET",
    path: "/v1/templates",
    querySchemaRef: "#/components/schemas/TemplateCatalogListQuery",
    responseSchemaRef: "#/components/schemas/TemplateCatalogPage",
    rbacAction: "connector.read",
  }),
  operation({
    operationId: "listDocumentJobs",
    method: "GET",
    path: "/v1/document-jobs",
    querySchemaRef: "#/components/schemas/DocumentJobListQuery",
    responseSchemaRef: "#/components/schemas/DocumentJobPage",
    rbacAction: "document_job.read",
  }),
  operation({
    operationId: "createDocumentJob",
    method: "POST",
    path: "/v1/document-jobs",
    requestBodySchemaRef: "#/components/schemas/DocumentJobCreateRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/DocumentJob",
    rbacAction: "document_job.manage",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "getDocumentJob",
    method: "GET",
    path: "/v1/document-jobs/{job_id}",
    paramsSchemaRef: "#/components/schemas/DocumentJobPathParams",
    responseSchemaRef: "#/components/schemas/DocumentJob",
    rbacAction: "document_job.read",
  }),
  operation({
    operationId: "extractDocumentJob",
    method: "POST",
    path: "/v1/document-jobs/{job_id}/extract",
    paramsSchemaRef: "#/components/schemas/DocumentJobPathParams",
    requestBodySchemaRef: "#/components/schemas/DocumentJobCommandRequest",
    requestBodyRequired: false,
    responseSchemaRef: "#/components/schemas/DocumentExtraction",
    rbacAction: "document_job.manage",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "getDocumentExtraction",
    method: "GET",
    path: "/v1/document-jobs/{job_id}/extraction",
    paramsSchemaRef: "#/components/schemas/DocumentJobPathParams",
    responseSchemaRef: "#/components/schemas/DocumentExtraction",
    rbacAction: "document_job.read",
  }),
  operation({
    operationId: "createDocumentValidationTask",
    method: "POST",
    path: "/v1/document-jobs/{job_id}/validation-task",
    paramsSchemaRef: "#/components/schemas/DocumentJobPathParams",
    requestBodySchemaRef: "#/components/schemas/DocumentJobCommandRequest",
    requestBodyRequired: false,
    responseSchemaRef: "#/components/schemas/DocumentValidationTask",
    rbacAction: "document_job.manage",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "createAutomationIdea",
    method: "POST",
    path: "/v1/automation-ideas",
    requestBodySchemaRef: "#/components/schemas/AutomationIdeaCreateRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/AutomationIdea",
    rbacAction: "automation_idea.manage",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "getAutomationIdea",
    method: "GET",
    path: "/v1/automation-ideas/{idea_id}",
    paramsSchemaRef: "#/components/schemas/AutomationIdeaPathParams",
    responseSchemaRef: "#/components/schemas/AutomationIdea",
    rbacAction: "automation_idea.read",
  }),
  operation({
    operationId: "updateAutomationIdea",
    method: "PATCH",
    path: "/v1/automation-ideas/{idea_id}",
    paramsSchemaRef: "#/components/schemas/AutomationIdeaPathParams",
    requestBodySchemaRef: "#/components/schemas/AutomationIdeaUpdateRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/AutomationIdea",
    rbacAction: "automation_idea.manage",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "transitionAutomationIdea",
    method: "POST",
    path: "/v1/automation-ideas/{idea_id}/transition",
    paramsSchemaRef: "#/components/schemas/AutomationIdeaPathParams",
    requestBodySchemaRef: "#/components/schemas/AutomationIdeaTransitionRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/AutomationIdea",
    rbacAction: "automation_idea.manage",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "upsertRoiEstimate",
    method: "POST",
    path: "/v1/automation-ideas/{idea_id}/roi-estimate",
    paramsSchemaRef: "#/components/schemas/AutomationIdeaPathParams",
    requestBodySchemaRef: "#/components/schemas/RoiEstimateRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/RoiEstimate",
    rbacAction: "automation_idea.manage",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "getRoiEstimate",
    method: "GET",
    path: "/v1/automation-ideas/{idea_id}/roi-estimate",
    paramsSchemaRef: "#/components/schemas/AutomationIdeaPathParams",
    responseSchemaRef: "#/components/schemas/RoiEstimate",
    rbacAction: "automation_idea.read",
  }),
  operation({
    operationId: "validateScenario",
    method: "POST",
    path: "/v1/scenarios/{scenario_id}/validate",
    paramsSchemaRef: "#/components/schemas/ScenarioPathParams",
    requestBodySchemaRef: "#/components/schemas/ValidateRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/ValidationReport",
    rbacAction: "scenario.read",
  }),
  operation({
    operationId: "promoteScenario",
    method: "POST",
    path: "/v1/scenarios/{scenario_id}/promote",
    paramsSchemaRef: "#/components/schemas/ScenarioPathParams",
    requestBodySchemaRef: "#/components/schemas/PromoteRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/Scenario",
    rbacAction: "scenario.promote",
    requiresIdempotencyKey: true,
    ifMatch: scenarioIfMatch,
  }),
  operation({
    operationId: "promoteScenarioFromRun",
    method: "POST",
    path: "/v1/scenarios/{scenario_id}/promote-from-run",
    paramsSchemaRef: "#/components/schemas/ScenarioPathParams",
    requestBodySchemaRef: "#/components/schemas/PromoteScenarioFromRunRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/PromoteScenarioFromRunResponse",
    rbacAction: "scenario.promote",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "archiveScenario",
    method: "POST",
    path: "/v1/scenarios/{scenario_id}/archive",
    paramsSchemaRef: "#/components/schemas/ScenarioPathParams",
    requestBodySchemaRef: "#/components/schemas/ScenarioCommandRequest",
    requestBodyRequired: false,
    responseSchemaRef: "#/components/schemas/Scenario",
    rbacAction: "scenario.update",
    requiresIdempotencyKey: true,
    ifMatch: scenarioIfMatch,
  }),
  operation({
    operationId: "listScenarioVersions",
    method: "GET",
    path: "/v1/scenarios/{scenario_id}/versions",
    paramsSchemaRef: "#/components/schemas/ScenarioPathParams",
    responseSchemaRef: "#/components/schemas/ScenarioVersionPage",
    rbacAction: "scenario.read",
  }),
  operation({
    operationId: "getScenarioVersion",
    method: "GET",
    path: "/v1/scenarios/{scenario_id}/versions/{version}",
    paramsSchemaRef: "#/components/schemas/ScenarioVersionPathParams",
    responseSchemaRef: "#/components/schemas/ScenarioVersion",
    rbacAction: "scenario.read",
  }),
  operation({
    operationId: "rollbackScenario",
    method: "POST",
    path: "/v1/scenarios/{scenario_id}/versions/{version}/rollback",
    paramsSchemaRef: "#/components/schemas/ScenarioVersionPathParams",
    requestBodySchemaRef: "#/components/schemas/ScenarioCommandRequest",
    requestBodyRequired: false,
    responseSchemaRef: "#/components/schemas/Scenario",
    rbacAction: "scenario.update",
    requiresIdempotencyKey: true,
    ifMatch: scenarioIfMatch,
  }),
  operation({
    operationId: "listHumanTasks",
    method: "GET",
    path: "/v1/human-tasks",
    querySchemaRef: "#/components/schemas/HumanTaskListQuery",
    responseSchemaRef: "#/components/schemas/HumanTaskPage",
    rbacAction: "human_task.read",
  }),
  operation({
    operationId: "startHumanTask",
    method: "POST",
    path: "/v1/human-tasks/{human_task_id}/start",
    paramsSchemaRef: "#/components/schemas/HumanTaskPathParams",
    responseSchemaRef: "#/components/schemas/HumanTask",
    rbacAction: "human_task.start",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "resolveHumanTask",
    method: "POST",
    path: "/v1/human-tasks/{human_task_id}/resolve",
    paramsSchemaRef: "#/components/schemas/HumanTaskPathParams",
    requestBodySchemaRef: "#/components/schemas/HumanTaskResolveRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/HumanTask",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "assignHumanTask",
    method: "POST",
    path: "/v1/human-tasks/{human_task_id}/assign",
    paramsSchemaRef: "#/components/schemas/HumanTaskPathParams",
    requestBodySchemaRef: "#/components/schemas/HumanTaskAssignRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/HumanTask",
    rbacAction: "human_task.assign",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "escalateHumanTask",
    method: "POST",
    path: "/v1/human-tasks/{human_task_id}/escalate",
    paramsSchemaRef: "#/components/schemas/HumanTaskPathParams",
    requestBodySchemaRef: "#/components/schemas/HumanTaskEscalateRequest",
    requestBodyRequired: false,
    responseSchemaRef: "#/components/schemas/HumanTask",
    rbacAction: "human_task.escalate",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "listWorkitems",
    method: "GET",
    path: "/v1/workitems",
    querySchemaRef: "#/components/schemas/WorkitemListQuery",
    responseSchemaRef: "#/components/schemas/WorkitemPage",
    rbacAction: "workitem.read",
  }),
  operation({
    operationId: "replayDeadLetter",
    method: "POST",
    path: "/v1/dlq/{dead_letter_id}/replay",
    paramsSchemaRef: "#/components/schemas/DeadLetterPathParams",
    responseSchemaRef: "#/components/schemas/ReplayResult",
    rbacAction: "dlq.replay",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "getArtifact",
    method: "GET",
    path: "/v1/artifacts/{artifact_id}",
    paramsSchemaRef: "#/components/schemas/ArtifactPathParams",
    responseSchemaRef: "#/components/schemas/Artifact",
  }),
  operation({
    operationId: "listGatewayPolicies",
    method: "GET",
    path: "/v1/gateway/policies",
    responseSchemaRef: "#/components/schemas/GatewayPolicyList",
    rbacAction: "gateway_policy.read",
  }),
  operation({
    operationId: "getGatewayPolicy",
    method: "GET",
    path: "/v1/gateway/policy",
    querySchemaRef: "#/components/schemas/GatewayPolicyQuery",
    responseSchemaRef: "#/components/schemas/GatewayPolicy",
    rbacAction: "gateway_policy.read",
  }),
  operation({
    operationId: "createGatewayPolicy",
    method: "POST",
    path: "/v1/gateway/policy",
    requestBodySchemaRef: "#/components/schemas/GatewayPolicy",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/GatewayPolicy",
    rbacAction: "gateway_policy.edit",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "updateGatewayPolicy",
    method: "PUT",
    path: "/v1/gateway/policy",
    requestBodySchemaRef: "#/components/schemas/GatewayPolicy",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/GatewayPolicy",
    rbacAction: "gateway_policy.edit",
    requiresIdempotencyKey: true,
    ifMatch: gatewayPolicyIfMatch,
  }),
  operation({
    operationId: "deleteGatewayPolicy",
    method: "DELETE",
    path: "/v1/gateway/policy",
    querySchemaRef: "#/components/schemas/GatewayPolicyQuery",
    responseSchemaRef: "#/components/schemas/GatewayPolicyDeleteResponse",
    rbacAction: "gateway_policy.edit",
    requiresIdempotencyKey: true,
    ifMatch: gatewayPolicyIfMatch,
  }),
  operation({
    operationId: "listSites",
    method: "GET",
    path: "/v1/sites",
    querySchemaRef: "#/components/schemas/SiteListQuery",
    responseSchemaRef: "#/components/schemas/SitePage",
  }),
  operation({
    operationId: "approveSite",
    method: "POST",
    path: "/v1/sites/{site_profile_id}/approve",
    paramsSchemaRef: "#/components/schemas/SitePathParams",
    requestBodySchemaRef: "#/components/schemas/SiteApproveRequest",
    requestBodyRequired: false,
    responseSchemaRef: "#/components/schemas/Site",
    rbacAction: "site.approve",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "listSessionCaptures",
    method: "GET",
    path: "/v1/sites/{site_profile_id}/session/capture",
    paramsSchemaRef: "#/components/schemas/SitePathParams",
    responseSchemaRef: "#/components/schemas/CaptureSessionPage",
    rbacAction: "session.capture",
  }),
  operation({
    operationId: "updateSitePageState",
    method: "PATCH",
    path: "/v1/sites/{site_profile_id}/page-state",
    paramsSchemaRef: "#/components/schemas/SitePathParams",
    requestBodySchemaRef: "#/components/schemas/SitePageStateUpdateRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/SitePageStateUpdateResponse",
    rbacAction: "site.update",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "listSiteElements",
    method: "GET",
    path: "/v1/sites/{site_profile_id}/elements",
    paramsSchemaRef: "#/components/schemas/SitePathParams",
    querySchemaRef: "#/components/schemas/SiteElementListQuery",
    responseSchemaRef: "#/components/schemas/SiteElementPage",
    rbacAction: "site.read",
  }),
  operation({
    operationId: "createSiteElement",
    method: "POST",
    path: "/v1/sites/{site_profile_id}/elements",
    paramsSchemaRef: "#/components/schemas/SitePathParams",
    requestBodySchemaRef: "#/components/schemas/SiteElementCreateRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/SiteElement",
    rbacAction: "site.update",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "updateSiteElement",
    method: "PATCH",
    path: "/v1/sites/{site_profile_id}/elements/{element_id}",
    paramsSchemaRef: "#/components/schemas/SiteElementPathParams",
    requestBodySchemaRef: "#/components/schemas/SiteElementUpdateRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/SiteElement",
    rbacAction: "site.update",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "probeSiteElement",
    method: "POST",
    path: "/v1/sites/{site_profile_id}/elements/{element_id}/probe",
    paramsSchemaRef: "#/components/schemas/SiteElementPathParams",
    requestBodySchemaRef: "#/components/schemas/SiteElementProbeRequest",
    requestBodyRequired: false,
    responseSchemaRef: "#/components/schemas/SiteElementProbeResponse",
    rbacAction: "site.update",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "deleteSiteElement",
    method: "DELETE",
    path: "/v1/sites/{site_profile_id}/elements/{element_id}",
    paramsSchemaRef: "#/components/schemas/SiteElementPathParams",
    responseSchemaRef: "#/components/schemas/SiteElementDeleteResponse",
    rbacAction: "site.update",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "listBrowserRecordings",
    method: "GET",
    path: "/v1/sites/{site_profile_id}/recordings",
    paramsSchemaRef: "#/components/schemas/SitePathParams",
    querySchemaRef: "#/components/schemas/BrowserRecordingListQuery",
    responseSchemaRef: "#/components/schemas/BrowserRecordingPage",
    rbacAction: "site.read",
  }),
  operation({
    operationId: "startBrowserRecording",
    method: "POST",
    path: "/v1/sites/{site_profile_id}/recordings",
    paramsSchemaRef: "#/components/schemas/SitePathParams",
    requestBodySchemaRef: "#/components/schemas/BrowserRecordingStartRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/BrowserRecordingSession",
    rbacAction: "site.update",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "listBrowserRecordingEvents",
    method: "GET",
    path: "/v1/sites/{site_profile_id}/recordings/{recording_session_id}/events",
    paramsSchemaRef: "#/components/schemas/BrowserRecordingPathParams",
    querySchemaRef: "#/components/schemas/BrowserRecordingEventListQuery",
    responseSchemaRef: "#/components/schemas/BrowserRecordingEventPage",
    rbacAction: "site.read",
  }),
  operation({
    operationId: "appendBrowserRecordingEvents",
    method: "POST",
    path: "/v1/sites/{site_profile_id}/recordings/{recording_session_id}/events",
    paramsSchemaRef: "#/components/schemas/BrowserRecordingPathParams",
    requestBodySchemaRef: "#/components/schemas/BrowserRecordingAppendEventsRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/BrowserRecordingAppendEventsResponse",
    rbacAction: "site.update",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "completeBrowserRecording",
    method: "POST",
    path: "/v1/sites/{site_profile_id}/recordings/{recording_session_id}/complete",
    paramsSchemaRef: "#/components/schemas/BrowserRecordingPathParams",
    responseSchemaRef: "#/components/schemas/BrowserRecordingSession",
    rbacAction: "site.update",
    requiresIdempotencyKey: true,
  }),
];

const operationById = new Map(CONTROL_PLANE_OPERATION_BINDINGS.map((item) => [item.operationId, item]));

const validationFailure = (details: unknown): BoundaryValidationFailure => ({
  valid: false,
  code: "IR_SCHEMA_INVALID",
  details,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireObject =
  (schemaRef: string, requiredStringProps: readonly string[] = [], allowUndefined = false): BoundaryValidator =>
  ({
    schemaRef,
    validate(input: unknown): BoundaryValidationResult {
      if (input === undefined && allowUndefined) {
        return { valid: true, value: undefined };
      }

      if (!isRecord(input)) {
        return validationFailure({ schemaRef, reason: "expected_object" });
      }

      for (const prop of requiredStringProps) {
        if (typeof input[prop] !== "string" || input[prop].length === 0) {
          return validationFailure({ schemaRef, reason: "missing_required_string", prop });
        }
      }

      return { valid: true, value: input };
    },
  });

const requireParams = (schemaRef: string, keys: readonly string[]): BoundaryValidator =>
  ({
    schemaRef,
    validate(input: unknown): BoundaryValidationResult {
      if (!isRecord(input)) {
        return validationFailure({ schemaRef, reason: "expected_params_object" });
      }

      for (const key of keys) {
        if (typeof input[key] !== "string" || input[key].length === 0) {
          return validationFailure({ schemaRef, reason: "missing_path_param", key });
        }
      }

      return { valid: true, value: input };
    },
  });

const passQuery = (schemaRef: string): BoundaryValidator => ({
  schemaRef,
  validate(input: unknown): BoundaryValidationResult {
    if (!isRecord(input)) {
      return validationFailure({ schemaRef, reason: "expected_query_object" });
    }

    return { valid: true, value: input };
  },
});

const requireQuery = (schemaRef: string, keys: readonly string[]): BoundaryValidator => ({
  schemaRef,
  validate(input: unknown): BoundaryValidationResult {
    if (!isRecord(input)) {
      return validationFailure({ schemaRef, reason: "expected_query_object" });
    }

    for (const key of keys) {
      if (typeof input[key] !== "string" || input[key].length === 0) {
        return validationFailure({ schemaRef, reason: "missing_query_param", key });
      }
    }

    return { valid: true, value: input };
  },
});

const requireRunCreateBody = (schemaRef: string): BoundaryValidator => ({
  schemaRef,
  validate(input: unknown): BoundaryValidationResult {
    if (!isRecord(input)) {
      return validationFailure({ schemaRef, reason: "expected_object" });
    }
    for (const key of Object.keys(input)) {
      if (key !== "scenario_version_id" && key !== "params" && key !== "workitem_id" && key !== "model") {
        return validationFailure({ schemaRef, reason: "additional_property", key });
      }
    }
    if (typeof input.scenario_version_id !== "string" || input.scenario_version_id.length === 0) {
      return validationFailure({ schemaRef, reason: "missing_required_string", prop: "scenario_version_id" });
    }
    if (!isRecord(input.params)) {
      return validationFailure({ schemaRef, reason: "missing_required_object", prop: "params" });
    }
    if (input.workitem_id !== undefined && (typeof input.workitem_id !== "string" || input.workitem_id.length === 0)) {
      return validationFailure({ schemaRef, reason: "invalid_optional_string", prop: "workitem_id" });
    }
    if (input.model !== undefined && (typeof input.model !== "string" || input.model.length === 0)) {
      return validationFailure({ schemaRef, reason: "invalid_optional_string", prop: "model" });
    }
    return { valid: true, value: input };
  },
});

const requireRunTriggerCreateBody = (schemaRef: string): BoundaryValidator => ({
  schemaRef,
  validate(input: unknown): BoundaryValidationResult {
    if (!isRecord(input)) {
      return validationFailure({ schemaRef, reason: "expected_object" });
    }
    const allowed = new Set([
      "trigger_type",
      "scenario_version_id",
      "cron_expression",
      "timezone",
      "webhook_secret_ref",
      "params",
      "catchup_policy",
      "max_concurrent_runs",
      "next_fire_at",
    ]);
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) {
        return validationFailure({ schemaRef, reason: "additional_property", key });
      }
    }
    if (typeof input.scenario_version_id !== "string" || input.scenario_version_id.length === 0) {
      return validationFailure({ schemaRef, reason: "missing_required_string", prop: "scenario_version_id" });
    }
    const triggerType = input.trigger_type ?? "cron";
    if (triggerType === "webhook") {
      if (typeof input.webhook_secret_ref !== "string" || !input.webhook_secret_ref.startsWith("secret://")) {
        return validationFailure({ schemaRef, reason: "missing_required_string", prop: "webhook_secret_ref" });
      }
      if (input.cron_expression !== undefined || input.timezone !== undefined || input.next_fire_at !== undefined) {
        return validationFailure({ schemaRef, reason: "webhook_trigger_forbids_cron_fields" });
      }
      return { valid: true, value: input };
    }
    if (triggerType !== "cron") {
      return validationFailure({ schemaRef, reason: "invalid_trigger_type" });
    }
    if (typeof input.cron_expression !== "string" || input.cron_expression.length === 0) {
      return validationFailure({ schemaRef, reason: "missing_required_string", prop: "cron_expression" });
    }
    if (typeof input.timezone !== "string" || input.timezone.length === 0) {
      return validationFailure({ schemaRef, reason: "missing_required_string", prop: "timezone" });
    }
    if (input.webhook_secret_ref !== undefined) {
      return validationFailure({ schemaRef, reason: "cron_trigger_forbids_webhook_secret_ref" });
    }
    return { valid: true, value: input };
  },
});

const requireDocumentJobCreateBody = (schemaRef: string): BoundaryValidator => ({
  schemaRef,
  validate(input: unknown): BoundaryValidationResult {
    if (!isRecord(input)) {
      return validationFailure({ schemaRef, reason: "expected_object" });
    }
    for (const key of Object.keys(input)) {
      if (key !== "source_artifact_id" && key !== "document_type" && key !== "field_schema") {
        return validationFailure({ schemaRef, reason: "additional_property", key });
      }
    }
    if (typeof input.source_artifact_id !== "string" || input.source_artifact_id.length === 0) {
      return validationFailure({ schemaRef, reason: "missing_required_string", prop: "source_artifact_id" });
    }
    if (typeof input.document_type !== "string" || input.document_type.length === 0) {
      return validationFailure({ schemaRef, reason: "missing_required_string", prop: "document_type" });
    }
    if (!Array.isArray(input.field_schema) || input.field_schema.length === 0) {
      return validationFailure({ schemaRef, reason: "missing_required_array", prop: "field_schema" });
    }
    return { valid: true, value: input };
  },
});

const browserRecordingEventTypes = new Set(["navigate", "click", "input", "select", "submit", "wait"]);

const requireBrowserRecordingAppendEventsBody = (schemaRef: string): BoundaryValidator => ({
  schemaRef,
  validate(input: unknown): BoundaryValidationResult {
    if (!isRecord(input)) {
      return validationFailure({ schemaRef, reason: "expected_object" });
    }
    if (!Array.isArray(input.events) || input.events.length === 0 || input.events.length > 100) {
      return validationFailure({ schemaRef, reason: "missing_required_array", prop: "events" });
    }
    for (const [index, event] of input.events.entries()) {
      if (!isRecord(event)) {
        return validationFailure({ schemaRef, reason: "event_object_required", index });
      }
      const eventType = event.event_type;
      if (typeof eventType !== "string" || !browserRecordingEventTypes.has(eventType)) {
        return validationFailure({ schemaRef, reason: "invalid_event_type", index });
      }
      if (eventType === "navigate" && (typeof event.url !== "string" || event.url.length === 0)) {
        return validationFailure({ schemaRef, reason: "navigate_url_required", index });
      }
      if (
        (eventType === "click" || eventType === "input" || eventType === "select" || eventType === "submit") &&
        (typeof event.selector !== "string" || event.selector.length === 0)
      ) {
        return validationFailure({ schemaRef, reason: "selector_required", index });
      }
      if (eventType === "select" && (typeof event.value_preview !== "string" || event.value_preview.length === 0)) {
        return validationFailure({ schemaRef, reason: "select_value_required", index });
      }
    }
    return { valid: true, value: input };
  },
});

const bodyValidators: ReadonlyMap<OperationId, BoundaryValidator> = new Map<OperationId, BoundaryValidator>([
  ["createRun", requireRunCreateBody("#/components/schemas/RunCreateRequest")],
  ["abortRun", requireObject("#/components/schemas/AbortRequest", [], true)],
  ["createRunTrigger", requireRunTriggerCreateBody("#/components/schemas/RunTriggerCreateRequest")],
  ["updateRunTrigger", requireObject("#/components/schemas/RunTriggerUpdateRequest")],
  ["pauseRunTrigger", requireObject("#/components/schemas/RunTriggerCommandRequest", [], true)],
  ["resumeRunTrigger", requireObject("#/components/schemas/RunTriggerCommandRequest", [], true)],
  ["createAutomationIdea", requireObject("#/components/schemas/AutomationIdeaCreateRequest", ["title", "description", "business_owner", "department"])],
  ["createDocumentJob", requireDocumentJobCreateBody("#/components/schemas/DocumentJobCreateRequest")],
  ["extractDocumentJob", requireObject("#/components/schemas/DocumentJobCommandRequest", [], true)],
  ["createDocumentValidationTask", requireObject("#/components/schemas/DocumentJobCommandRequest", [], true)],
  ["updateAutomationIdea", requireObject("#/components/schemas/AutomationIdeaUpdateRequest")],
  ["transitionAutomationIdea", requireObject("#/components/schemas/AutomationIdeaTransitionRequest", ["stage"])],
  ["upsertRoiEstimate", requireObject("#/components/schemas/RoiEstimateRequest")],
  ["validateScenario", requireObject("#/components/schemas/ValidateRequest")],
  ["promoteScenario", requireObject("#/components/schemas/PromoteRequest", ["target"])],
  ["promoteScenarioFromRun", requireObject("#/components/schemas/PromoteScenarioFromRunRequest", ["run_id"])],
  ["archiveScenario", requireObject("#/components/schemas/ScenarioCommandRequest", [], true)],
  ["rollbackScenario", requireObject("#/components/schemas/ScenarioCommandRequest", [], true)],
  ["resolveHumanTask", requireObject("#/components/schemas/HumanTaskResolveRequest")],
  ["assignHumanTask", requireObject("#/components/schemas/HumanTaskAssignRequest", ["assignee"])],
  ["escalateHumanTask", requireObject("#/components/schemas/HumanTaskEscalateRequest", [], true)],
  ["createGatewayPolicy", requireObject("#/components/schemas/GatewayPolicy", ["model"])],
  ["updateGatewayPolicy", requireObject("#/components/schemas/GatewayPolicy", ["model"])],
  ["approveSite", requireObject("#/components/schemas/SiteApproveRequest", [], true)],
  ["updateSitePageState", requireObject("#/components/schemas/SitePageStateUpdateRequest")],
  ["createSiteElement", requireObject("#/components/schemas/SiteElementCreateRequest", ["element_key", "label", "selector"])],
  ["updateSiteElement", requireObject("#/components/schemas/SiteElementUpdateRequest")],
  ["probeSiteElement", requireObject("#/components/schemas/SiteElementProbeRequest", [], true)],
  ["startBrowserRecording", requireObject("#/components/schemas/BrowserRecordingStartRequest", ["name"])],
  ["appendBrowserRecordingEvents", requireBrowserRecordingAppendEventsBody("#/components/schemas/BrowserRecordingAppendEventsRequest")],
]);

const paramsValidators: ReadonlyMap<OperationId, BoundaryValidator> = new Map<OperationId, BoundaryValidator>([
  ["getRun", requireParams("#/components/schemas/RunPathParams", ["run_id"])],
  ["listRunSteps", requireParams("#/components/schemas/RunPathParams", ["run_id"])],
  ["streamRunSteps", requireParams("#/components/schemas/RunPathParams", ["run_id"])],
  ["listRunArtifacts", requireParams("#/components/schemas/RunPathParams", ["run_id"])],
  ["abortRun", requireParams("#/components/schemas/RunPathParams", ["run_id"])],
  ["getRunTrigger", requireParams("#/components/schemas/RunTriggerPathParams", ["trigger_id"])],
  ["updateRunTrigger", requireParams("#/components/schemas/RunTriggerPathParams", ["trigger_id"])],
  ["pauseRunTrigger", requireParams("#/components/schemas/RunTriggerPathParams", ["trigger_id"])],
  ["resumeRunTrigger", requireParams("#/components/schemas/RunTriggerPathParams", ["trigger_id"])],
  ["listRunTriggerFires", requireParams("#/components/schemas/RunTriggerPathParams", ["trigger_id"])],
  ["getAutomationIdea", requireParams("#/components/schemas/AutomationIdeaPathParams", ["idea_id"])],
  ["getDocumentJob", requireParams("#/components/schemas/DocumentJobPathParams", ["job_id"])],
  ["extractDocumentJob", requireParams("#/components/schemas/DocumentJobPathParams", ["job_id"])],
  ["getDocumentExtraction", requireParams("#/components/schemas/DocumentJobPathParams", ["job_id"])],
  ["createDocumentValidationTask", requireParams("#/components/schemas/DocumentJobPathParams", ["job_id"])],
  ["updateAutomationIdea", requireParams("#/components/schemas/AutomationIdeaPathParams", ["idea_id"])],
  ["transitionAutomationIdea", requireParams("#/components/schemas/AutomationIdeaPathParams", ["idea_id"])],
  ["upsertRoiEstimate", requireParams("#/components/schemas/AutomationIdeaPathParams", ["idea_id"])],
  ["getRoiEstimate", requireParams("#/components/schemas/AutomationIdeaPathParams", ["idea_id"])],
  ["validateScenario", requireParams("#/components/schemas/ScenarioPathParams", ["scenario_id"])],
  ["promoteScenario", requireParams("#/components/schemas/ScenarioPathParams", ["scenario_id"])],
  ["promoteScenarioFromRun", requireParams("#/components/schemas/ScenarioPathParams", ["scenario_id"])],
  ["archiveScenario", requireParams("#/components/schemas/ScenarioPathParams", ["scenario_id"])],
  ["listScenarioVersions", requireParams("#/components/schemas/ScenarioPathParams", ["scenario_id"])],
  ["getScenarioVersion", requireParams("#/components/schemas/ScenarioVersionPathParams", ["scenario_id", "version"])],
  ["rollbackScenario", requireParams("#/components/schemas/ScenarioVersionPathParams", ["scenario_id", "version"])],
  ["startHumanTask", requireParams("#/components/schemas/HumanTaskPathParams", ["human_task_id"])],
  ["resolveHumanTask", requireParams("#/components/schemas/HumanTaskPathParams", ["human_task_id"])],
  ["assignHumanTask", requireParams("#/components/schemas/HumanTaskPathParams", ["human_task_id"])],
  ["escalateHumanTask", requireParams("#/components/schemas/HumanTaskPathParams", ["human_task_id"])],
  ["replayDeadLetter", requireParams("#/components/schemas/DeadLetterPathParams", ["dead_letter_id"])],
  ["getArtifact", requireParams("#/components/schemas/ArtifactPathParams", ["artifact_id"])],
  ["approveSite", requireParams("#/components/schemas/SitePathParams", ["site_profile_id"])],
  ["listSessionCaptures", requireParams("#/components/schemas/SitePathParams", ["site_profile_id"])],
  ["updateSitePageState", requireParams("#/components/schemas/SitePathParams", ["site_profile_id"])],
  ["listSiteElements", requireParams("#/components/schemas/SitePathParams", ["site_profile_id"])],
  ["createSiteElement", requireParams("#/components/schemas/SitePathParams", ["site_profile_id"])],
  ["updateSiteElement", requireParams("#/components/schemas/SiteElementPathParams", ["site_profile_id", "element_id"])],
  ["probeSiteElement", requireParams("#/components/schemas/SiteElementPathParams", ["site_profile_id", "element_id"])],
  ["deleteSiteElement", requireParams("#/components/schemas/SiteElementPathParams", ["site_profile_id", "element_id"])],
  ["listBrowserRecordings", requireParams("#/components/schemas/SitePathParams", ["site_profile_id"])],
  ["startBrowserRecording", requireParams("#/components/schemas/SitePathParams", ["site_profile_id"])],
  [
    "listBrowserRecordingEvents",
    requireParams("#/components/schemas/BrowserRecordingPathParams", ["site_profile_id", "recording_session_id"]),
  ],
  [
    "appendBrowserRecordingEvents",
    requireParams("#/components/schemas/BrowserRecordingPathParams", ["site_profile_id", "recording_session_id"]),
  ],
  [
    "completeBrowserRecording",
    requireParams("#/components/schemas/BrowserRecordingPathParams", ["site_profile_id", "recording_session_id"]),
  ],
]);

const queryValidators: ReadonlyMap<OperationId, BoundaryValidator> = new Map<OperationId, BoundaryValidator>([
  ["listRuns", passQuery("#/components/schemas/RunListQuery")],
  ["listRunTriggers", passQuery("#/components/schemas/RunTriggerListQuery")],
  ["listRunTriggerFires", passQuery("#/components/schemas/RunTriggerFireListQuery")],
  ["listOpsAlerts", passQuery("#/components/schemas/OpsAlertListQuery")],
  ["listAutomationIdeas", passQuery("#/components/schemas/AutomationIdeaListQuery")],
  ["listDocumentJobs", passQuery("#/components/schemas/DocumentJobListQuery")],
  ["listAuditLog", passQuery("#/components/schemas/AuditLogListQuery")],
  ["exportAuditLog", passQuery("#/components/schemas/AuditLogExportQuery")],
  ["listConnectors", passQuery("#/components/schemas/ConnectorCatalogListQuery")],
  ["listTemplates", passQuery("#/components/schemas/TemplateCatalogListQuery")],
  ["listHumanTasks", passQuery("#/components/schemas/HumanTaskListQuery")],
  ["listWorkitems", passQuery("#/components/schemas/WorkitemListQuery")],
  ["getGatewayPolicy", passQuery("#/components/schemas/GatewayPolicyQuery")],
  ["deleteGatewayPolicy", requireQuery("#/components/schemas/GatewayPolicyQuery", ["model"])],
  ["listSites", passQuery("#/components/schemas/SiteListQuery")],
  ["listSiteElements", passQuery("#/components/schemas/SiteElementListQuery")],
  ["listBrowserRecordings", passQuery("#/components/schemas/BrowserRecordingListQuery")],
  ["listBrowserRecordingEvents", passQuery("#/components/schemas/BrowserRecordingEventListQuery")],
]);

export function createControlPlaneValidatorRegistry(): OpenApiValidatorRegistry {
  return {
    getOperation(operationId: OperationId): OpenApiOperationBinding {
      const binding = operationById.get(operationId);
      if (binding === undefined) {
        throw new Error(`No control-plane operation binding for ${operationId}`);
      }
      return binding;
    },
    getBodyValidator(operationId: OperationId): BoundaryValidator | undefined {
      return bodyValidators.get(operationId);
    },
    getParamsValidator(operationId: OperationId): BoundaryValidator | undefined {
      return paramsValidators.get(operationId);
    },
    getQueryValidator(operationId: OperationId): BoundaryValidator | undefined {
      return queryValidators.get(operationId);
    },
  };
}

export function createRouteBinder(
  handlers: ControlPlaneHandlerMap,
  validators: OpenApiValidatorRegistry = createControlPlaneValidatorRegistry(),
): RouteBinder {
  return {
    bind(operationId: OperationId): FastifyRouteScaffold {
      const operationBinding = validators.getOperation(operationId);
      const handler = handlers[operationId];
      if (handler === undefined) {
        throw new Error(`No control-plane handler for ${operationId}`);
      }

      return {
        method: operationBinding.method,
        url: operationBinding.path,
        operationId,
        validators: {
          body: validators.getBodyValidator(operationId),
          params: validators.getParamsValidator(operationId),
          query: validators.getQueryValidator(operationId),
        },
        preHandlers: [
          "correlation",
          "authenticate",
          "bindTenant",
          "openApiValidate",
          "rbac",
          "idempotencyReplay",
          "ifMatch",
          "handler",
          "errorMapper",
        ],
        handler,
      };
    },
  };
}

export interface FastifyLikeRequest {
  method?: string;
  url?: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  params?: unknown;
  query?: unknown;
  body?: unknown;
}

export interface FastifyLikeReply {
  code(status: number): FastifyLikeReply;
  headers(values: Readonly<Record<string, string>>): FastifyLikeReply;
  send(body: unknown): unknown;
}

export interface FastifyLikeRouteOptions {
  method: HttpMethod;
  url: string;
  handler(request: FastifyLikeRequest, reply: FastifyLikeReply): Promise<unknown>;
}

export interface ControlPlaneInjectRunner {
  inject(request: {
    method: HttpMethod;
    url: string;
    headers?: Readonly<Record<string, string | undefined>>;
    body?: unknown;
  }): Promise<{ status: number; headers?: Readonly<Record<string, string>>; body: unknown }>;
}

export function toFastifyUrl(path: ControlPlanePath): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

export function createFastifyCompatibleRoutes(
  routes: readonly FastifyRouteScaffold[],
  runner: ControlPlaneInjectRunner,
): readonly FastifyLikeRouteOptions[] {
  return routes.map((route) => ({
    method: route.method,
    url: toFastifyUrl(route.url),
    async handler(request: FastifyLikeRequest, reply: FastifyLikeReply): Promise<unknown> {
      const response = await runner.inject({
        method: route.method,
        url: request.url ?? route.url,
        headers: normalizeFastifyHeaders(request.headers),
        body: request.body,
      });
      if (response.headers !== undefined) {
        reply.headers(response.headers);
      }
      return reply.code(response.status).send(response.body);
    },
  }));
}

export function staticRbacAction(operationId: OperationId): RbacAction | undefined {
  return operationById.get(operationId)?.rbacAction;
}

function normalizeFastifyHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return normalized;
}
