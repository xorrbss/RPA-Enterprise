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
  | "listRunResumeRequests"
  | "listWebAttendedRunRequests"
  | "createWebAttendedRunRequest"
  | "listRunTriggers"
  | "createRunTrigger"
  | "getRunTrigger"
  | "updateRunTrigger"
  | "pauseRunTrigger"
  | "resumeRunTrigger"
  | "listRunTriggerFires"
  | "listOpsAlerts"
  | "ackOpsAlert"
  | "listOpsAlertDeliveries"
  | "recordOpsAlertDelivery"
  | "sendOpsAlertWebhookDelivery"
  | "getOpsHealth"
  | "getProductionReadiness"
  | "listProductionReadinessEvidence"
  | "recordProductionReadinessEvidence"
  | "listAiGovernanceEvidence"
  | "recordAiGovernanceEvidence"
  | "listProcessMiningImports"
  | "createProcessMiningImport"
  | "listAutomationIdeas"
  | "createAutomationIdea"
  | "getAutomationIdea"
  | "updateAutomationIdea"
  | "transitionAutomationIdea"
  | "upsertRoiEstimate"
  | "getRoiEstimate"
  | "listRoiActualEvidence"
  | "recordRoiActualEvidence"
  | "listAutomationAdoptionEvidence"
  | "recordAutomationAdoptionEvidence"
  | "exportOffboardingData"
  | "listAuditLog"
  | "exportAuditLog"
  | "listConnectors"
  | "listTemplates"
  | "listConnectorProfiles"
  | "createConnectorProfile"
  | "certifyConnectorProfile"
  | "listIntegrationHandoffs"
  | "createIntegrationHandoff"
  | "dispatchIntegrationHandoff"
  | "recordIntegrationHandoffCallback"
  | "listDocumentJobs"
  | "createDocumentJob"
  | "getDocumentJob"
  | "extractDocumentJob"
  | "recordExternalDocumentExtraction"
  | "getDocumentExtraction"
  | "createDocumentValidationTask"
  | "validateScenario"
  | "promoteScenario"
  | "promoteScenarioFromRun"
  | "archiveScenario"
  | "listScenarioVersions"
  | "getScenarioVersion"
  | "rollbackScenario"
  | "certifyScenarioVersion"
  | "setScenarioVersionGovernanceStage"
  | "revokeScenarioCertification"
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
    operationId: "listRunResumeRequests",
    method: "GET",
    path: "/v1/run-resume-requests",
    querySchemaRef: "#/components/schemas/RunResumeRequestListQuery",
    responseSchemaRef: "#/components/schemas/RunResumeRequestPage",
    rbacAction: "run.read",
  }),
  operation({
    operationId: "listWebAttendedRunRequests",
    method: "GET",
    path: "/v1/web-attended/run-requests",
    querySchemaRef: "#/components/schemas/WebAttendedRunRequestListQuery",
    responseSchemaRef: "#/components/schemas/WebAttendedRunRequestPage",
    rbacAction: "run.read",
  }),
  operation({
    operationId: "createWebAttendedRunRequest",
    method: "POST",
    path: "/v1/web-attended/run-requests",
    requestBodySchemaRef: "#/components/schemas/WebAttendedRunRequestCreate",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/WebAttendedRunRequest",
    rbacAction: "run.create",
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
    operationId: "ackOpsAlert",
    method: "POST",
    path: "/v1/ops-alerts/{alert_id}/ack",
    paramsSchemaRef: "#/components/schemas/OpsAlertPathParams",
    requestBodySchemaRef: "#/components/schemas/OpsAlertAckRequest",
    requestBodyRequired: false,
    responseSchemaRef: "#/components/schemas/OpsAlert",
    rbacAction: "ops_alert.ack",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "listOpsAlertDeliveries",
    method: "GET",
    path: "/v1/ops-alerts/{alert_id}/deliveries",
    paramsSchemaRef: "#/components/schemas/OpsAlertPathParams",
    querySchemaRef: "#/components/schemas/OpsAlertDeliveryListQuery",
    responseSchemaRef: "#/components/schemas/OpsNotificationDeliveryPage",
    rbacAction: "ops_alert.read",
  }),
  operation({
    operationId: "recordOpsAlertDelivery",
    method: "POST",
    path: "/v1/ops-alerts/{alert_id}/deliveries",
    paramsSchemaRef: "#/components/schemas/OpsAlertPathParams",
    requestBodySchemaRef: "#/components/schemas/OpsNotificationDeliveryRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/OpsNotificationDelivery",
    rbacAction: "ops_alert.deliver",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "sendOpsAlertWebhookDelivery",
    method: "POST",
    path: "/v1/ops-alerts/{alert_id}/deliveries/send-webhook",
    paramsSchemaRef: "#/components/schemas/OpsAlertPathParams",
    requestBodySchemaRef: "#/components/schemas/OpsNotificationWebhookSendRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/OpsNotificationAttempt",
    rbacAction: "ops_alert.deliver",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "getOpsHealth",
    method: "GET",
    path: "/v1/ops/health",
    responseSchemaRef: "#/components/schemas/OpsHealth",
    rbacAction: "ops_alert.read",
  }),
  operation({
    operationId: "getProductionReadiness",
    method: "GET",
    path: "/v1/ops/production-readiness",
    responseSchemaRef: "#/components/schemas/ProductionReadiness",
    rbacAction: "ops_alert.read",
  }),
  operation({
    operationId: "listProductionReadinessEvidence",
    method: "GET",
    path: "/v1/ops/production-readiness/evidence",
    querySchemaRef: "#/components/schemas/ProductionReadinessEvidenceListQuery",
    responseSchemaRef: "#/components/schemas/ProductionReadinessEvidencePage",
    rbacAction: "ops_alert.read",
  }),
  operation({
    operationId: "recordProductionReadinessEvidence",
    method: "POST",
    path: "/v1/ops/production-readiness/evidence",
    requestBodySchemaRef: "#/components/schemas/ProductionReadinessEvidenceRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/ProductionReadinessEvidence",
    rbacAction: "ops_readiness.manage",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "listAiGovernanceEvidence",
    method: "GET",
    path: "/v1/ai-governance/evidence",
    querySchemaRef: "#/components/schemas/AiGovernanceEvidenceListQuery",
    responseSchemaRef: "#/components/schemas/AiGovernanceEvidencePage",
    rbacAction: "ai_governance.read",
  }),
  operation({
    operationId: "recordAiGovernanceEvidence",
    method: "POST",
    path: "/v1/ai-governance/evidence",
    requestBodySchemaRef: "#/components/schemas/AiGovernanceEvidenceRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/AiGovernanceEvidence",
    rbacAction: "ai_governance.manage",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "listProcessMiningImports",
    method: "GET",
    path: "/v1/process-mining/imports",
    querySchemaRef: "#/components/schemas/ProcessMiningImportListQuery",
    responseSchemaRef: "#/components/schemas/ProcessMiningImportPage",
    rbacAction: "automation_idea.read",
  }),
  operation({
    operationId: "createProcessMiningImport",
    method: "POST",
    path: "/v1/process-mining/imports",
    requestBodySchemaRef: "#/components/schemas/ProcessMiningImportCreateRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/ProcessMiningImport",
    rbacAction: "automation_idea.manage",
    requiresIdempotencyKey: true,
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
    operationId: "exportOffboardingData",
    method: "GET",
    path: "/v1/offboarding/export",
    querySchemaRef: "#/components/schemas/OffboardingExportQuery",
    responseSchemaRef: "#/components/schemas/OffboardingExportCsv",
    rbacAction: "tenant_data.export",
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
    operationId: "listConnectorProfiles",
    method: "GET",
    path: "/v1/connector-profiles",
    querySchemaRef: "#/components/schemas/ConnectorProfileListQuery",
    responseSchemaRef: "#/components/schemas/ConnectorProfilePage",
    rbacAction: "connector.read",
  }),
  operation({
    operationId: "createConnectorProfile",
    method: "POST",
    path: "/v1/connector-profiles",
    requestBodySchemaRef: "#/components/schemas/ConnectorProfileCreateRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/ConnectorProfile",
    rbacAction: "connector.enable",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "certifyConnectorProfile",
    method: "POST",
    path: "/v1/connector-profiles/{profile_id}/certifications",
    requestBodySchemaRef: "#/components/schemas/ConnectorCertificationRequest",
    requestBodyRequired: true,
    paramsSchemaRef: "#/components/schemas/ConnectorProfilePathParams",
    responseSchemaRef: "#/components/schemas/ConnectorCertification",
    rbacAction: "connector.enable",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "listIntegrationHandoffs",
    method: "GET",
    path: "/v1/integration-handoffs",
    querySchemaRef: "#/components/schemas/IntegrationHandoffListQuery",
    responseSchemaRef: "#/components/schemas/IntegrationHandoffPage",
    rbacAction: "integration.handoff",
  }),
  operation({
    operationId: "createIntegrationHandoff",
    method: "POST",
    path: "/v1/integration-handoffs",
    requestBodySchemaRef: "#/components/schemas/IntegrationHandoffCreateRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/IntegrationHandoff",
    rbacAction: "integration.handoff",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "dispatchIntegrationHandoff",
    method: "POST",
    path: "/v1/integration-handoffs/{handoff_id}/dispatch",
    paramsSchemaRef: "#/components/schemas/IntegrationHandoffPathParams",
    requestBodySchemaRef: "#/components/schemas/IntegrationHandoffDispatchRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/IntegrationHandoffDispatchAttempt",
    rbacAction: "integration.handoff",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "recordIntegrationHandoffCallback",
    method: "POST",
    path: "/v1/integration-handoffs/{handoff_id}/callback",
    paramsSchemaRef: "#/components/schemas/IntegrationHandoffPathParams",
    requestBodySchemaRef: "#/components/schemas/IntegrationHandoffCallbackRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/IntegrationHandoff",
    rbacAction: "integration.handoff",
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
    operationId: "recordExternalDocumentExtraction",
    method: "POST",
    path: "/v1/document-jobs/{job_id}/external-extractions",
    paramsSchemaRef: "#/components/schemas/DocumentJobPathParams",
    requestBodySchemaRef: "#/components/schemas/ExternalDocumentExtractionRequest",
    requestBodyRequired: true,
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
    operationId: "listRoiActualEvidence",
    method: "GET",
    path: "/v1/automation-ideas/{idea_id}/roi-actuals",
    paramsSchemaRef: "#/components/schemas/AutomationIdeaPathParams",
    querySchemaRef: "#/components/schemas/RoiActualEvidenceListQuery",
    responseSchemaRef: "#/components/schemas/RoiActualEvidencePage",
    rbacAction: "automation_idea.read",
  }),
  operation({
    operationId: "recordRoiActualEvidence",
    method: "POST",
    path: "/v1/automation-ideas/{idea_id}/roi-actuals",
    paramsSchemaRef: "#/components/schemas/AutomationIdeaPathParams",
    requestBodySchemaRef: "#/components/schemas/RoiActualEvidenceRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/RoiActualEvidence",
    rbacAction: "automation_idea.manage",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "listAutomationAdoptionEvidence",
    method: "GET",
    path: "/v1/automation-ideas/{idea_id}/adoption-evidence",
    paramsSchemaRef: "#/components/schemas/AutomationIdeaPathParams",
    querySchemaRef: "#/components/schemas/AutomationAdoptionEvidenceListQuery",
    responseSchemaRef: "#/components/schemas/AutomationAdoptionEvidencePage",
    rbacAction: "automation_idea.read",
  }),
  operation({
    operationId: "recordAutomationAdoptionEvidence",
    method: "POST",
    path: "/v1/automation-ideas/{idea_id}/adoption-evidence",
    paramsSchemaRef: "#/components/schemas/AutomationIdeaPathParams",
    requestBodySchemaRef: "#/components/schemas/AutomationAdoptionEvidenceRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/AutomationAdoptionEvidence",
    rbacAction: "automation_idea.manage",
    requiresIdempotencyKey: true,
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
    operationId: "certifyScenarioVersion",
    method: "POST",
    path: "/v1/scenarios/{scenario_id}/versions/{version}/certify",
    paramsSchemaRef: "#/components/schemas/ScenarioVersionPathParams",
    requestBodySchemaRef: "#/components/schemas/ScenarioCertificationRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/ScenarioVersion",
    rbacAction: "scenario.certify",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "setScenarioVersionGovernanceStage",
    method: "POST",
    path: "/v1/scenarios/{scenario_id}/versions/{version}/governance-stage",
    paramsSchemaRef: "#/components/schemas/ScenarioVersionPathParams",
    requestBodySchemaRef: "#/components/schemas/ScenarioGovernanceStageRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/ScenarioVersion",
    rbacAction: "scenario.certify",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "revokeScenarioCertification",
    method: "POST",
    path: "/v1/scenarios/{scenario_id}/versions/{version}/revoke-certification",
    paramsSchemaRef: "#/components/schemas/ScenarioVersionPathParams",
    requestBodySchemaRef: "#/components/schemas/ScenarioCertificationRevokeRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/ScenarioVersion",
    rbacAction: "scenario.certify",
    requiresIdempotencyKey: true,
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

const requireProcessMiningImportBody = (schemaRef: string): BoundaryValidator => ({
  schemaRef,
  validate(input: unknown): BoundaryValidationResult {
    if (!isRecord(input)) {
      return validationFailure({ schemaRef, reason: "expected_object" });
    }

    for (const prop of ["source_system", "source_owner_ref", "schema_version", "import_evidence_ref", "lineage_ref", "import_summary"] as const) {
      if (typeof input[prop] !== "string" || input[prop].length === 0) {
        return validationFailure({ schemaRef, reason: "missing_required_string", prop });
      }
    }

    const sourceType = input.source_type;
    if (sourceType !== "process_mining" && sourceType !== "task_mining" && sourceType !== "monitoring_export" && sourceType !== "api_import") {
      return validationFailure({ schemaRef, reason: "invalid_source_type", prop: "source_type" });
    }
    if (input.status !== undefined && input.status !== "received" && input.status !== "processed" && input.status !== "blocked") {
      return validationFailure({ schemaRef, reason: "invalid_import_status", prop: "status" });
    }
    if (
      input.anonymization_mode !== undefined &&
      input.anonymization_mode !== "aggregated_alias" &&
      input.anonymization_mode !== "pseudonymized" &&
      input.anonymization_mode !== "not_applicable"
    ) {
      return validationFailure({ schemaRef, reason: "invalid_anonymization_mode", prop: "anonymization_mode" });
    }
    if (input.status === "blocked" && (typeof input.blocked_reason !== "string" || input.blocked_reason.length === 0)) {
      return validationFailure({ schemaRef, reason: "blocked_reason_required", prop: "blocked_reason" });
    }
    if (input.status !== undefined && input.status !== "blocked" && input.blocked_reason !== undefined) {
      return validationFailure({ schemaRef, reason: "blocked_reason_requires_blocked_status", prop: "blocked_reason" });
    }
    if (typeof input.row_count !== "number" || !Number.isInteger(input.row_count) || input.row_count < 1) {
      return validationFailure({ schemaRef, reason: "invalid_row_count", prop: "row_count" });
    }
    if (
      typeof input.candidate_count !== "number" ||
      !Number.isInteger(input.candidate_count) ||
      input.candidate_count < 0 ||
      input.candidate_count > input.row_count
    ) {
      return validationFailure({ schemaRef, reason: "invalid_candidate_count", prop: "candidate_count" });
    }
    if (!isRecord(input.schema_mapping)) {
      return validationFailure({ schemaRef, reason: "schema_mapping_required", prop: "schema_mapping" });
    }
    const requiredMappingKeys = sourceType === "task_mining"
      ? ["task_name", "application_alias", "timestamp"]
      : ["case_id", "activity", "timestamp"];
    for (const prop of requiredMappingKeys) {
      if (typeof input.schema_mapping[prop] !== "string" || input.schema_mapping[prop].length === 0) {
        return validationFailure({ schemaRef, reason: "schema_mapping_required_key_missing", prop: `schema_mapping.${prop}` });
      }
    }

    return { valid: true, value: input };
  },
});

const requireIntegrationHandoffDispatchBody = (schemaRef: string): BoundaryValidator => ({
  schemaRef,
  validate(input: unknown): BoundaryValidationResult {
    if (!isRecord(input)) {
      return validationFailure({ schemaRef, reason: "expected_object" });
    }
    if (typeof input.endpoint_secret_ref !== "string" || input.endpoint_secret_ref.length === 0) {
      return validationFailure({ schemaRef, reason: "missing_required_string", prop: "endpoint_secret_ref" });
    }
    if (!Array.isArray(input.allowed_hosts) || input.allowed_hosts.length === 0) {
      return validationFailure({ schemaRef, reason: "missing_required_array", prop: "allowed_hosts" });
    }
    if (input.allowed_hosts.some((host) => typeof host !== "string" || host.length === 0)) {
      return validationFailure({ schemaRef, reason: "invalid_array_item", prop: "allowed_hosts" });
    }
    return { valid: true, value: input };
  },
});

const opsNotificationHostRe = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function isOpsNotificationSecretRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("secret://") && value.length > "secret://".length && value.length <= 500;
}

function containsOpsNotificationForbiddenEvidence(value: string): boolean {
  return containsProductionEvidenceSecretOrEndpoint(value) ||
    /https?:\/\//i.test(value) ||
    /hooks\.slack\.com/i.test(value) ||
    /\bbearer\s+[a-z0-9._~+/=-]{8,}/i.test(value) ||
    /\b(token|password|secret)=/i.test(value);
}

function validateOpsNotificationSafeString(value: unknown, prop: string, schemaRef: string): BoundaryValidationFailure | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return validationFailure({ schemaRef, reason: "missing_required_string", prop });
  }
  if (value.length > 1000 || containsOpsNotificationForbiddenEvidence(value)) {
    return validationFailure({ schemaRef, reason: "secret_or_raw_endpoint_forbidden", prop });
  }
  return null;
}

function validateOpsNotificationMetadata(input: unknown, schemaRef: string): BoundaryValidationFailure | null {
  if (input === undefined) return null;
  if (!isRecord(input)) {
    return validationFailure({ schemaRef, reason: "metadata_must_be_object", prop: "metadata" });
  }
  const text = JSON.stringify(input);
  if (text.length > 4000 || containsOpsNotificationForbiddenEvidence(text)) {
    return validationFailure({ schemaRef, reason: "secret_or_raw_endpoint_forbidden", prop: "metadata" });
  }
  return null;
}

const requireOpsNotificationDeliveryBody = (schemaRef: string): BoundaryValidator => ({
  schemaRef,
  validate(input: unknown): BoundaryValidationResult {
    if (!isRecord(input)) {
      return validationFailure({ schemaRef, reason: "expected_object" });
    }
    for (const prop of ["channel", "provider_alias", "status", "receipt_at", "summary"] as const) {
      const failure = validateOpsNotificationSafeString(input[prop], prop, schemaRef);
      if (failure !== null) return failure;
    }
    if (!isOpsNotificationSecretRef(input.endpoint_secret_ref)) {
      return validationFailure({ schemaRef, reason: "invalid_secret_ref", prop: "endpoint_secret_ref" });
    }
    for (const prop of ["credential_secret_ref", "callback_signature_secret_ref"] as const) {
      if (input[prop] !== undefined && input[prop] !== null && !isOpsNotificationSecretRef(input[prop])) {
        return validationFailure({ schemaRef, reason: "invalid_secret_ref", prop });
      }
    }
    if ((input.status === "sent" || input.status === "delivered") && (typeof input.receipt_id !== "string" || input.receipt_id.length === 0)) {
      return validationFailure({ schemaRef, reason: "receipt_id_required_for_successful_delivery", prop: "receipt_id" });
    }
    if (input.status === "failed" && (typeof input.error_code !== "string" || input.error_code.length === 0)) {
      return validationFailure({ schemaRef, reason: "error_code_required_for_failed_delivery", prop: "error_code" });
    }
    if (input.status !== "failed" && input.error_code !== undefined && input.error_code !== null) {
      return validationFailure({ schemaRef, reason: "error_code_for_successful_delivery_forbidden", prop: "error_code" });
    }
    const metadataFailure = validateOpsNotificationMetadata(input.metadata, schemaRef);
    if (metadataFailure !== null) return metadataFailure;
    return { valid: true, value: input };
  },
});

const requireOpsNotificationWebhookSendBody = (schemaRef: string): BoundaryValidator => ({
  schemaRef,
  validate(input: unknown): BoundaryValidationResult {
    if (!isRecord(input)) {
      return validationFailure({ schemaRef, reason: "expected_object" });
    }
    if (!isOpsNotificationSecretRef(input.endpoint_secret_ref)) {
      return validationFailure({ schemaRef, reason: "invalid_secret_ref", prop: "endpoint_secret_ref" });
    }
    for (const prop of ["route_policy_ref"] as const) {
      const failure = validateOpsNotificationSafeString(input[prop], prop, schemaRef);
      if (failure !== null) return failure;
    }
    if (!Array.isArray(input.allowed_hosts) || input.allowed_hosts.length === 0) {
      return validationFailure({ schemaRef, reason: "missing_required_array", prop: "allowed_hosts" });
    }
    if (
      input.allowed_hosts.length > 20 ||
      input.allowed_hosts.some((host) =>
        typeof host !== "string" ||
        host.length === 0 ||
        host.length > 253 ||
        host.includes("://") ||
        host.includes("/") ||
        host.includes(":") ||
        host === "localhost" ||
        !opsNotificationHostRe.test(host)
      )
    ) {
      return validationFailure({ schemaRef, reason: "invalid_array_item", prop: "allowed_hosts" });
    }
    if (
      input.callback_signature_secret_ref !== undefined &&
      input.callback_signature_secret_ref !== null &&
      !isOpsNotificationSecretRef(input.callback_signature_secret_ref)
    ) {
      return validationFailure({ schemaRef, reason: "invalid_secret_ref", prop: "callback_signature_secret_ref" });
    }
    for (const prop of ["provider_alias", "recipient_group_ref", "summary"] as const) {
      if (input[prop] !== undefined && input[prop] !== null) {
        const failure = validateOpsNotificationSafeString(input[prop], prop, schemaRef);
        if (failure !== null) return failure;
      }
    }
    const metadataFailure = validateOpsNotificationMetadata(input.metadata, schemaRef);
    if (metadataFailure !== null) return metadataFailure;
    return { valid: true, value: input };
  },
});

const containsProductionEvidenceSecretOrEndpoint = (value: string): boolean =>
  /https?:\/\//i.test(value) ||
  /hooks\.slack\.com/i.test(value) ||
  /bearer\s+[a-z0-9._-]+/i.test(value) ||
  /\b(?:endpoint_url|webhook_url|dashboard_url|dsn|url)\s*[:=]/i.test(value) ||
  /\b(?:api[_-]?key|secret|token|password|credential|authorization|webhook_secret)\s*[:=]/i.test(value) ||
  /"(?:api[_-]?key|secret|token|password|credential|authorization|webhook_secret)"\s*:/i.test(value) ||
  /\b(?:raw[_-]?url|endpoint[_-]?url|resolved[_-]?secret(?:[_-]?ref)?|plaintext[_-]?secret)\b/i.test(value) ||
  /\b(?:raw[_-]?roster(?:[_-]?rows)?|raw[_-]?user[_-]?list(?:[_-]?rows)?|raw[_-]?training[_-]?(?:document|docs?)(?:[_-]?body)?|roster[_-]?rows|training[_-]?roster|user[_-]?list[_-]?rows)\b/i.test(value) ||
  /\b(?:raw\s+(?:rosters?|user\s+lists?|training\s+documents?)|rosters?|user\s+lists?|training\s+documents?)\b/i.test(value);

const productionReadinessEvidenceTypes = new Set([
  "external_alert_delivery",
  "managed_backup_restore_drill",
  "slo_oncall_signoff",
  "observability_telemetry_wiring",
  "support_training_completion",
]);

const productionReadinessEvidenceStatuses = new Set(["valid", "failed"]);

const aiGovernanceEvidenceTypes = new Set([
  "model_registry",
  "prompt_registry",
  "eval_result",
  "cost_control",
  "human_override",
]);

const aiGovernanceEvidenceStatuses = new Set(["valid", "failed", "deferred"]);

const containsAiGovernanceForbiddenEvidence = (value: string): boolean =>
  containsProductionEvidenceSecretOrEndpoint(value) ||
  /\b(?:api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|credential|authorization)\s*[:=]\s*\S{4,}/i.test(value) ||
  /"(?:api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|credential|authorization)"\s*:/i.test(value) ||
  /\b(?:raw[_-]?prompt|prompt[_-]?text|prompt[_-]?body|raw[_-]?output|output[_-]?text|output[_-]?body)\b/i.test(value) ||
  /"(?:raw[_-]?prompt|prompt[_-]?text|prompt[_-]?body|raw[_-]?output|output[_-]?text|output[_-]?body|payload|body)"\s*:/i.test(value);

function requireAiMetadataString(
  metadata: Record<string, unknown>,
  key: string,
  schemaRef: string,
  reason: string,
): BoundaryValidationFailure | null {
  const value = metadata[key];
  if (typeof value !== "string" || value.length === 0 || value.length > 300) {
    return validationFailure({ schemaRef, reason, prop: `metadata.${key}` });
  }
  if (containsAiGovernanceForbiddenEvidence(value)) {
    return validationFailure({ schemaRef, reason: "secret_or_raw_ai_evidence_value_forbidden", prop: `metadata.${key}` });
  }
  return null;
}

function requireAiMetadataDate(metadata: Record<string, unknown>, key: string, schemaRef: string, reason: string): BoundaryValidationFailure | null {
  const stringFailure = requireAiMetadataString(metadata, key, schemaRef, reason);
  if (stringFailure !== null) return stringFailure;
  if (!Number.isFinite(Date.parse(metadata[key] as string))) {
    return validationFailure({ schemaRef, reason: "invalid_ai_governance_metadata_datetime", prop: `metadata.${key}` });
  }
  return null;
}

function requireAiMetadataNumber(
  metadata: Record<string, unknown>,
  key: string,
  schemaRef: string,
  reason: string,
): BoundaryValidationFailure | null {
  const value = metadata[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return validationFailure({ schemaRef, reason, prop: `metadata.${key}` });
  }
  return null;
}

function requireAiMetadataBooleanTrue(
  metadata: Record<string, unknown>,
  key: string,
  schemaRef: string,
  reason: string,
): BoundaryValidationFailure | null {
  if (metadata[key] !== true) {
    return validationFailure({ schemaRef, reason, prop: `metadata.${key}` });
  }
  return null;
}

function validateAiGovernanceTypeMetadata(input: Record<string, unknown>, schemaRef: string): BoundaryValidationFailure | null {
  if (input.status !== "valid") return null;
  if (!isRecord(input.metadata)) {
    return validationFailure({ schemaRef, reason: "valid_ai_governance_metadata_required", prop: "metadata" });
  }
  const metadata = input.metadata;
  if (input.evidence_type === "model_registry") {
    for (const key of ["provider_alias", "model_alias", "model_version", "data_retention_policy_ref", "tenant_allowlist_ref"] as const) {
      const failure = requireAiMetadataString(metadata, key, schemaRef, "model_registry_metadata_required");
      if (failure !== null) return failure;
    }
    const riskTier = metadata.risk_tier;
    if (riskTier !== "low" && riskTier !== "medium" && riskTier !== "high") {
      return validationFailure({ schemaRef, reason: "model_registry_risk_tier_invalid", prop: "metadata.risk_tier" });
    }
    return requireAiMetadataDate(metadata, "approved_at", schemaRef, "model_registry_metadata_required");
  }
  if (input.evidence_type === "prompt_registry") {
    for (const key of ["prompt_template_id", "prompt_template_version", "owner_ref", "eval_suite_ref", "rollback_target_ref"] as const) {
      const failure = requireAiMetadataString(metadata, key, schemaRef, "prompt_registry_metadata_required");
      if (failure !== null) return failure;
    }
    return requireAiMetadataDate(metadata, "approved_at", schemaRef, "prompt_registry_metadata_required");
  }
  if (input.evidence_type === "eval_result") {
    for (const key of ["eval_suite_ref", "dataset_ref"] as const) {
      const failure = requireAiMetadataString(metadata, key, schemaRef, "eval_result_metadata_required");
      if (failure !== null) return failure;
    }
    const sampledAtFailure = requireAiMetadataDate(metadata, "sampled_at", schemaRef, "eval_result_metadata_required");
    if (sampledAtFailure !== null) return sampledAtFailure;
    const passRateFailure = requireAiMetadataNumber(metadata, "pass_rate", schemaRef, "eval_result_metadata_required");
    if (passRateFailure !== null) return passRateFailure;
    const passRate = metadata.pass_rate as number;
    if (passRate < 0 || passRate > 1) return validationFailure({ schemaRef, reason: "eval_result_pass_rate_invalid", prop: "metadata.pass_rate" });
    for (const key of ["prompt_injection_passed", "data_leakage_passed", "hallucination_passed", "policy_block_passed"] as const) {
      const failure = requireAiMetadataBooleanTrue(metadata, key, schemaRef, "eval_result_required_check_failed");
      if (failure !== null) return failure;
    }
    return null;
  }
  if (input.evidence_type === "cost_control") {
    for (const key of ["budget_ref", "scope_ref", "anomaly_alert_ref"] as const) {
      const failure = requireAiMetadataString(metadata, key, schemaRef, "cost_control_metadata_required");
      if (failure !== null) return failure;
    }
    const monthlyFailure = requireAiMetadataNumber(metadata, "monthly_limit", schemaRef, "cost_control_metadata_required");
    if (monthlyFailure !== null) return monthlyFailure;
    const capFailure = requireAiMetadataNumber(metadata, "per_run_cap", schemaRef, "cost_control_metadata_required");
    if (capFailure !== null) return capFailure;
    const monthlyLimit = metadata.monthly_limit as number;
    const perRunCap = metadata.per_run_cap as number;
    if (monthlyLimit <= 0) return validationFailure({ schemaRef, reason: "cost_control_monthly_limit_invalid", prop: "metadata.monthly_limit" });
    if (perRunCap <= 0 || perRunCap > monthlyLimit) {
      return validationFailure({ schemaRef, reason: "cost_control_per_run_cap_invalid", prop: "metadata.per_run_cap" });
    }
    return requireAiMetadataDate(metadata, "effective_at", schemaRef, "cost_control_metadata_required");
  }
  for (const key of ["override_actor_ref", "reason_code", "audit_event_ref"] as const) {
    const failure = requireAiMetadataString(metadata, key, schemaRef, "human_override_metadata_required");
    if (failure !== null) return failure;
  }
  const action = metadata.override_action;
  if (
    action !== "accepted_ai_output" &&
    action !== "rejected_ai_output" &&
    action !== "corrected_ai_output" &&
    action !== "escalated_to_human" &&
    action !== "rolled_back_prompt"
  ) {
    return validationFailure({ schemaRef, reason: "human_override_action_invalid", prop: "metadata.override_action" });
  }
  return requireAiMetadataDate(metadata, "occurred_at", schemaRef, "human_override_metadata_required");
}

const scenarioGovernanceStages = new Set(["review", "pilot", "deprecated"]);

const containsScenarioGovernanceForbiddenEvidence = (value: string): boolean =>
  containsProductionEvidenceSecretOrEndpoint(value) ||
  /"(?:api[_-]?key|secret|token|password|credential|authorization|webhook_secret)"\s*:/i.test(value) ||
  /\b(?:raw[_-]?url|endpoint[_-]?url|resolved[_-]?secret[_-]?ref|resolved[_-]?secret|plaintext[_-]?secret)\b/i.test(value) ||
  /\b(?:raw[_-]?approval[_-]?packet|approval[_-]?packet|approval[_-]?body|raw[_-]?roster|roster[_-]?rows|training[_-]?roster)\b/i.test(value);

const requireScenarioGovernanceStageBody = (schemaRef: string): BoundaryValidator => ({
  schemaRef,
  validate(input: unknown): BoundaryValidationResult {
    if (!isRecord(input)) {
      return validationFailure({ schemaRef, reason: "expected_object" });
    }
    for (const prop of ["stage", "reason", "evidence_ref"] as const) {
      if (typeof input[prop] !== "string" || input[prop].length === 0) {
        return validationFailure({ schemaRef, reason: "missing_required_string", prop });
      }
    }
    if (!scenarioGovernanceStages.has(input.stage as string)) {
      return validationFailure({ schemaRef, reason: "invalid_governance_stage", prop: "stage" });
    }
    for (const prop of ["reason", "evidence_ref"] as const) {
      if (containsScenarioGovernanceForbiddenEvidence(input[prop] as string)) {
        return validationFailure({ schemaRef, reason: "secret_or_raw_evidence_value_forbidden", prop });
      }
    }
    if (input.metadata !== undefined) {
      if (!isRecord(input.metadata)) {
        return validationFailure({ schemaRef, reason: "metadata_must_be_object", prop: "metadata" });
      }
      const metadataText = JSON.stringify(input.metadata);
      if (metadataText.length > 8000 || containsScenarioGovernanceForbiddenEvidence(metadataText)) {
        return validationFailure({ schemaRef, reason: "secret_or_raw_evidence_value_forbidden", prop: "metadata" });
      }
    }
    if (input.legal_hold !== undefined && typeof input.legal_hold !== "boolean") {
      return validationFailure({ schemaRef, reason: "legal_hold_must_be_boolean", prop: "legal_hold" });
    }
    return { valid: true, value: input };
  },
});

const requireProductionReadinessEvidenceBody = (schemaRef: string): BoundaryValidator => {
  const base = requireObject(schemaRef, ["evidence_type", "status", "evidence_at", "summary"]);
  return {
    schemaRef,
    validate(input: unknown): BoundaryValidationResult {
      const baseResult = base.validate(input);
      if (!baseResult.valid) return baseResult;
      if (!isRecord(input)) return validationFailure({ schemaRef, reason: "expected_object" });

      const evidenceType = input.evidence_type as string;
      const status = input.status as string;
      if (!productionReadinessEvidenceTypes.has(evidenceType)) {
        return validationFailure({ schemaRef, reason: "invalid_production_readiness_evidence_type", prop: "evidence_type" });
      }
      if (!productionReadinessEvidenceStatuses.has(status)) {
        return validationFailure({ schemaRef, reason: "invalid_production_readiness_evidence_status", prop: "status" });
      }
      if (typeof input.summary === "string" && containsProductionEvidenceSecretOrEndpoint(input.summary)) {
        return validationFailure({ schemaRef, reason: "secret_or_raw_evidence_value_forbidden", prop: "summary" });
      }
      if (typeof input.evidence_ref === "string" && containsProductionEvidenceSecretOrEndpoint(input.evidence_ref)) {
        return validationFailure({ schemaRef, reason: "secret_or_raw_evidence_value_forbidden", prop: "evidence_ref" });
      }
      if (input.metadata !== undefined && containsProductionEvidenceSecretOrEndpoint(JSON.stringify(input.metadata))) {
        return validationFailure({ schemaRef, reason: "secret_or_raw_evidence_value_forbidden", prop: "metadata" });
      }
      if (input.status === "valid") {
        if (typeof input.expires_at !== "string" || input.expires_at.length === 0) {
          return validationFailure({ schemaRef, reason: "expires_at_required_for_valid_evidence", prop: "expires_at" });
        }
        if (!Number.isFinite(Date.parse(input.expires_at))) {
          return validationFailure({ schemaRef, reason: "invalid_expires_at", prop: "expires_at" });
        }
      }
      if (input.evidence_type === "external_alert_delivery" && input.status === "valid") {
        if (typeof input.evidence_ref !== "string" || input.evidence_ref.length === 0) {
          return validationFailure({ schemaRef, reason: "external_alert_delivery_evidence_ref_required", prop: "evidence_ref" });
        }
        if (!isRecord(input.metadata)) {
          return validationFailure({ schemaRef, reason: "external_alert_delivery_metadata_required", prop: "metadata" });
        }
        for (const prop of ["channel", "provider_alias", "receipt_id", "receipt_at"] as const) {
          if (typeof input.metadata[prop] !== "string" || input.metadata[prop].length === 0) {
            return validationFailure({ schemaRef, reason: "external_alert_delivery_metadata_required", prop: `metadata.${prop}` });
          }
        }
        const channel = input.metadata.channel;
        if (typeof channel !== "string" || !["teams", "slack", "email", "webhook"].includes(channel)) {
          return validationFailure({ schemaRef, reason: "external_alert_delivery_channel_invalid", prop: "metadata.channel" });
        }
        if (input.metadata.delivery_status !== "delivered") {
          return validationFailure({ schemaRef, reason: "external_alert_delivery_status_must_be_delivered", prop: "metadata.delivery_status" });
        }
        const receiptAt = input.metadata.receipt_at;
        if (typeof receiptAt !== "string" || !Number.isFinite(Date.parse(receiptAt))) {
          return validationFailure({ schemaRef, reason: "invalid_receipt_at", prop: "metadata.receipt_at" });
        }
      }
      if (input.evidence_type === "slo_oncall_signoff" && input.status === "valid") {
        if (typeof input.evidence_ref !== "string" || input.evidence_ref.length === 0) {
          return validationFailure({ schemaRef, reason: "slo_oncall_evidence_ref_required", prop: "evidence_ref" });
        }
        if (!isRecord(input.metadata)) {
          return validationFailure({ schemaRef, reason: "slo_oncall_metadata_required", prop: "metadata" });
        }
        for (const prop of ["slo_dashboard", "severity_model", "oncall_rota", "raci_ref", "support_hours"] as const) {
          if (typeof input.metadata[prop] !== "string" || input.metadata[prop].length === 0) {
            return validationFailure({ schemaRef, reason: "slo_oncall_metadata_required", prop: `metadata.${prop}` });
          }
        }
      }
      if (input.evidence_type === "support_training_completion" && input.status === "valid") {
        if (typeof input.evidence_ref !== "string" || input.evidence_ref.length === 0) {
          return validationFailure({ schemaRef, reason: "support_training_evidence_ref_required", prop: "evidence_ref" });
        }
        if (!isRecord(input.metadata)) {
          return validationFailure({ schemaRef, reason: "support_training_metadata_required", prop: "metadata" });
        }
        for (const prop of ["support_model_ref", "training_completion_ref", "completed_at"] as const) {
          if (typeof input.metadata[prop] !== "string" || input.metadata[prop].length === 0) {
            return validationFailure({ schemaRef, reason: "support_training_metadata_required", prop: `metadata.${prop}` });
          }
        }
        if (
          typeof input.metadata.trained_role_count !== "number" ||
          !Number.isInteger(input.metadata.trained_role_count) ||
          input.metadata.trained_role_count <= 0
        ) {
          return validationFailure({ schemaRef, reason: "support_training_role_count_invalid", prop: "metadata.trained_role_count" });
        }
        if (
          typeof input.metadata.trained_user_count !== "number" ||
          !Number.isInteger(input.metadata.trained_user_count) ||
          input.metadata.trained_user_count <= 0
        ) {
          return validationFailure({ schemaRef, reason: "support_training_user_count_invalid", prop: "metadata.trained_user_count" });
        }
        if (
          typeof input.metadata.coverage_percent !== "number" ||
          !Number.isFinite(input.metadata.coverage_percent) ||
          input.metadata.coverage_percent < 0 ||
          input.metadata.coverage_percent > 100
        ) {
          return validationFailure({ schemaRef, reason: "support_training_coverage_invalid", prop: "metadata.coverage_percent" });
        }
        const completedAt = input.metadata.completed_at;
        if (typeof completedAt !== "string" || !Number.isFinite(Date.parse(completedAt))) {
          return validationFailure({ schemaRef, reason: "invalid_completed_at", prop: "metadata.completed_at" });
        }
      }
      if (input.evidence_type === "observability_telemetry_wiring" && input.status === "valid") {
        if (typeof input.evidence_ref !== "string" || input.evidence_ref.length === 0) {
          return validationFailure({ schemaRef, reason: "observability_telemetry_evidence_ref_required", prop: "evidence_ref" });
        }
        if (!isRecord(input.metadata)) {
          return validationFailure({ schemaRef, reason: "observability_telemetry_metadata_required", prop: "metadata" });
        }
        for (const prop of ["collector_ref", "dashboard_ref", "alert_route_ref", "sampled_at"] as const) {
          if (typeof input.metadata[prop] !== "string" || input.metadata[prop].length === 0) {
            return validationFailure({ schemaRef, reason: "observability_telemetry_metadata_required", prop: `metadata.${prop}` });
          }
        }
        if (input.metadata.exporter !== "prometheus" && input.metadata.exporter !== "otlp") {
          return validationFailure({ schemaRef, reason: "observability_telemetry_exporter_invalid", prop: "metadata.exporter" });
        }
        const sampledAt = input.metadata.sampled_at;
        if (typeof sampledAt !== "string" || !Number.isFinite(Date.parse(sampledAt))) {
          return validationFailure({ schemaRef, reason: "invalid_sampled_at", prop: "metadata.sampled_at" });
        }
      }
      if (input.evidence_type === "managed_backup_restore_drill" && input.status === "valid") {
        if (typeof input.evidence_ref !== "string" || input.evidence_ref.length === 0) {
          return validationFailure({ schemaRef, reason: "managed_backup_restore_evidence_ref_required", prop: "evidence_ref" });
        }
        if (!isRecord(input.metadata)) {
          return validationFailure({ schemaRef, reason: "managed_backup_restore_metadata_required", prop: "metadata" });
        }
        for (const prop of ["backup_policy_ref", "restore_scope", "restore_completed_at"] as const) {
          if (typeof input.metadata[prop] !== "string" || input.metadata[prop].length === 0) {
            return validationFailure({ schemaRef, reason: "managed_backup_restore_metadata_required", prop: `metadata.${prop}` });
          }
        }
        if (typeof input.metadata.rto_minutes !== "number" || input.metadata.rto_minutes <= 0 || input.metadata.rto_minutes > 120) {
          return validationFailure({ schemaRef, reason: "managed_backup_restore_rto_target_missed", prop: "metadata.rto_minutes" });
        }
        if (typeof input.metadata.rpo_minutes !== "number" || input.metadata.rpo_minutes <= 0 || input.metadata.rpo_minutes > 15) {
          return validationFailure({ schemaRef, reason: "managed_backup_restore_rpo_target_missed", prop: "metadata.rpo_minutes" });
        }
      }

      return { valid: true, value: input };
    },
  };
};

const requireRoiActualEvidenceBody = (schemaRef: string): BoundaryValidator => ({
  schemaRef,
  validate(input: unknown): BoundaryValidationResult {
    if (!isRecord(input)) {
      return validationFailure({ schemaRef, reason: "expected_object" });
    }
    for (const prop of ["period_start", "period_end", "evidence_ref", "summary"] as const) {
      if (typeof input[prop] !== "string" || input[prop].length === 0) {
        return validationFailure({ schemaRef, reason: "missing_required_string", prop });
      }
    }
    for (const prop of ["actual_transaction_count", "actual_failure_rate", "human_intervention_minutes", "reprocessing_minutes"] as const) {
      if (typeof input[prop] !== "number" || !Number.isFinite(input[prop])) {
        return validationFailure({ schemaRef, reason: "missing_required_number", prop });
      }
    }
    return { valid: true, value: input };
  },
});

const adoptionEvidenceTypes = new Set([
  "pilot_charter_signoff",
  "raci_signoff",
  "training_completion",
  "support_model_signoff",
]);

const adoptionEvidenceStatuses = new Set(["valid", "failed", "deferred"]);

const requireAutomationAdoptionEvidenceBody = (schemaRef: string): BoundaryValidator => ({
  schemaRef,
  validate(input: unknown): BoundaryValidationResult {
    if (!isRecord(input)) {
      return validationFailure({ schemaRef, reason: "expected_object" });
    }
    for (const prop of ["evidence_type", "status", "evidence_at", "summary"] as const) {
      if (typeof input[prop] !== "string" || input[prop].length === 0) {
        return validationFailure({ schemaRef, reason: "missing_required_string", prop });
      }
    }
    const evidenceType = input.evidence_type as string;
    const status = input.status as string;
    const evidenceAt = input.evidence_at as string;
    const summary = input.summary as string;
    if (!adoptionEvidenceTypes.has(evidenceType)) {
      return validationFailure({ schemaRef, reason: "invalid_adoption_evidence_type", prop: "evidence_type" });
    }
    if (!adoptionEvidenceStatuses.has(status)) {
      return validationFailure({ schemaRef, reason: "invalid_adoption_evidence_status", prop: "status" });
    }
    if (!Number.isFinite(Date.parse(evidenceAt))) {
      return validationFailure({ schemaRef, reason: "invalid_evidence_at", prop: "evidence_at" });
    }
    if (input.expires_at !== undefined && input.expires_at !== null && (
      typeof input.expires_at !== "string" || !Number.isFinite(Date.parse(input.expires_at))
    )) {
      return validationFailure({ schemaRef, reason: "invalid_expires_at", prop: "expires_at" });
    }
    if (containsProductionEvidenceSecretOrEndpoint(summary)) {
      return validationFailure({ schemaRef, reason: "secret_or_endpoint_value_forbidden", prop: "summary" });
    }
    if (typeof input.evidence_ref === "string" && containsProductionEvidenceSecretOrEndpoint(input.evidence_ref)) {
      return validationFailure({ schemaRef, reason: "secret_or_endpoint_value_forbidden", prop: "evidence_ref" });
    }
    if (input.metadata !== undefined) {
      const metadataText = JSON.stringify(input.metadata);
      if (containsProductionEvidenceSecretOrEndpoint(metadataText)) {
        return validationFailure({ schemaRef, reason: "secret_or_endpoint_value_forbidden", prop: "metadata" });
      }
      if (metadataText.length > 8000 || /\b(?:raw_document|document_body|training_roster|roster_rows)\b/i.test(metadataText)) {
        return validationFailure({ schemaRef, reason: "raw_document_or_roster_forbidden", prop: "metadata" });
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

const requireAiGovernanceEvidenceBody = (schemaRef: string): BoundaryValidator => ({
  schemaRef,
  validate(input: unknown): BoundaryValidationResult {
    if (!isRecord(input)) {
      return validationFailure({ schemaRef, reason: "expected_object" });
    }
    const allowed = new Set([
      "evidence_type",
      "subject_ref",
      "status",
      "evidence_at",
      "expires_at",
      "summary",
      "evidence_ref",
      "policy_decision_ref",
      "audit_correlation_id",
      "metadata",
      "legal_hold",
    ]);
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) return validationFailure({ schemaRef, reason: "additional_property", key });
    }
    for (const prop of ["evidence_type", "subject_ref", "status", "evidence_at", "summary"] as const) {
      if (typeof input[prop] !== "string" || input[prop].length === 0) {
        return validationFailure({ schemaRef, reason: "missing_required_string", prop });
      }
    }
    if (typeof input.evidence_type !== "string" || !aiGovernanceEvidenceTypes.has(input.evidence_type)) {
      return validationFailure({ schemaRef, reason: "invalid_ai_governance_evidence_type", prop: "evidence_type" });
    }
    if (typeof input.status !== "string" || !aiGovernanceEvidenceStatuses.has(input.status)) {
      return validationFailure({ schemaRef, reason: "invalid_ai_governance_evidence_status", prop: "status" });
    }
    if (typeof input.evidence_at !== "string" || !Number.isFinite(Date.parse(input.evidence_at))) {
      return validationFailure({ schemaRef, reason: "invalid_evidence_at", prop: "evidence_at" });
    }
    if (input.expires_at !== undefined && input.expires_at !== null && (
      typeof input.expires_at !== "string" || !Number.isFinite(Date.parse(input.expires_at))
    )) {
      return validationFailure({ schemaRef, reason: "invalid_expires_at", prop: "expires_at" });
    }
    const summary = input.summary;
    if (typeof summary !== "string" || containsAiGovernanceForbiddenEvidence(summary)) {
      return validationFailure({ schemaRef, reason: "secret_or_raw_ai_evidence_value_forbidden", prop: "summary" });
    }
    for (const prop of ["subject_ref", "evidence_ref", "policy_decision_ref"] as const) {
      const value = input[prop];
      if (typeof value === "string" && containsAiGovernanceForbiddenEvidence(value)) {
        return validationFailure({ schemaRef, reason: "secret_or_raw_ai_evidence_value_forbidden", prop });
      }
    }
    if (input.metadata !== undefined) {
      if (!isRecord(input.metadata)) return validationFailure({ schemaRef, reason: "metadata_must_be_object", prop: "metadata" });
      if (containsAiGovernanceForbiddenEvidence(JSON.stringify(input.metadata))) {
        return validationFailure({ schemaRef, reason: "secret_or_raw_ai_evidence_value_forbidden", prop: "metadata" });
      }
    }
    if (input.status === "valid") {
      for (const prop of ["evidence_ref", "policy_decision_ref", "audit_correlation_id"] as const) {
        if (typeof input[prop] !== "string" || input[prop].length === 0) {
          return validationFailure({ schemaRef, reason: "valid_ai_governance_linkage_required", prop });
        }
      }
      if (input.evidence_type !== "human_override" && (typeof input.expires_at !== "string" || input.expires_at.length === 0)) {
        return validationFailure({ schemaRef, reason: "expires_at_required_for_valid_ai_governance_evidence", prop: "expires_at" });
      }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.audit_correlation_id as string)) {
        return validationFailure({ schemaRef, reason: "invalid_audit_correlation_id", prop: "audit_correlation_id" });
      }
      const metadataFailure = validateAiGovernanceTypeMetadata(input, schemaRef);
      if (metadataFailure !== null) return metadataFailure;
    }
    if (input.legal_hold !== undefined && typeof input.legal_hold !== "boolean") {
      return validationFailure({ schemaRef, reason: "legal_hold_must_be_boolean", prop: "legal_hold" });
    }
    return { valid: true, value: input };
  },
});

const requireProductionReadinessEvidenceQuery = (schemaRef: string): BoundaryValidator => ({
  schemaRef,
  validate(input: unknown): BoundaryValidationResult {
    if (!isRecord(input)) {
      return validationFailure({ schemaRef, reason: "expected_query_object" });
    }
    if (
      input.evidence_type !== undefined &&
      (typeof input.evidence_type !== "string" || !productionReadinessEvidenceTypes.has(input.evidence_type))
    ) {
      return validationFailure({ schemaRef, reason: "invalid_production_readiness_evidence_type", prop: "evidence_type" });
    }
    return { valid: true, value: input };
  },
});

const requireAiGovernanceEvidenceQuery = (schemaRef: string): BoundaryValidator => ({
  schemaRef,
  validate(input: unknown): BoundaryValidationResult {
    if (!isRecord(input)) {
      return validationFailure({ schemaRef, reason: "expected_query_object" });
    }
    if (
      input.evidence_type !== undefined &&
      (typeof input.evidence_type !== "string" || !aiGovernanceEvidenceTypes.has(input.evidence_type))
    ) {
      return validationFailure({ schemaRef, reason: "invalid_ai_governance_evidence_type", prop: "evidence_type" });
    }
    if (
      input.status !== undefined &&
      (typeof input.status !== "string" || !aiGovernanceEvidenceStatuses.has(input.status))
    ) {
      return validationFailure({ schemaRef, reason: "invalid_ai_governance_evidence_status", prop: "status" });
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

const requireWebAttendedRunRequestCreateBody = (schemaRef: string): BoundaryValidator => ({
  schemaRef,
  validate(input: unknown): BoundaryValidationResult {
    if (!isRecord(input)) {
      return validationFailure({ schemaRef, reason: "expected_object" });
    }
    const allowed = new Set(["scenario_version_id", "params", "model", "priority", "human_task_id", "consent", "metadata", "legal_hold"]);
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) {
        return validationFailure({ schemaRef, reason: "additional_property", key });
      }
    }
    if (typeof input.scenario_version_id !== "string" || input.scenario_version_id.length === 0) {
      return validationFailure({ schemaRef, reason: "missing_required_string", prop: "scenario_version_id" });
    }
    if (!isRecord(input.params)) {
      return validationFailure({ schemaRef, reason: "missing_required_object", prop: "params" });
    }
    if (input.model !== undefined && input.model !== null && (typeof input.model !== "string" || input.model.length === 0)) {
      return validationFailure({ schemaRef, reason: "invalid_optional_string", prop: "model" });
    }
    if (input.priority !== undefined && input.priority !== "low" && input.priority !== "medium" && input.priority !== "high" && input.priority !== "critical") {
      return validationFailure({ schemaRef, reason: "invalid_priority" });
    }
    if (input.human_task_id !== undefined && input.human_task_id !== null && (typeof input.human_task_id !== "string" || input.human_task_id.length === 0)) {
      return validationFailure({ schemaRef, reason: "invalid_optional_string", prop: "human_task_id" });
    }
    if (!isRecord(input.consent)) {
      return validationFailure({ schemaRef, reason: "missing_required_object", prop: "consent" });
    }
    const consent = input.consent;
    for (const key of Object.keys(consent)) {
      if (key !== "summary" && key !== "evidence_ref" && key !== "input_refs") {
        return validationFailure({ schemaRef, reason: "additional_property", prop: "consent", key });
      }
    }
    if (typeof consent.summary !== "string" || consent.summary.length === 0) {
      return validationFailure({ schemaRef, reason: "missing_required_string", prop: "consent.summary" });
    }
    if (consent.evidence_ref !== undefined && consent.evidence_ref !== null && (typeof consent.evidence_ref !== "string" || consent.evidence_ref.length === 0)) {
      return validationFailure({ schemaRef, reason: "invalid_optional_string", prop: "consent.evidence_ref" });
    }
    if (consent.input_refs !== undefined) {
      if (!Array.isArray(consent.input_refs) || consent.input_refs.some((item) => typeof item !== "string" || item.length === 0)) {
        return validationFailure({ schemaRef, reason: "invalid_optional_array", prop: "consent.input_refs" });
      }
    }
    if (input.metadata !== undefined && !isRecord(input.metadata)) {
      return validationFailure({ schemaRef, reason: "invalid_optional_object", prop: "metadata" });
    }
    if (input.legal_hold !== undefined && typeof input.legal_hold !== "boolean") {
      return validationFailure({ schemaRef, reason: "invalid_optional_boolean", prop: "legal_hold" });
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

const requireExternalDocumentExtractionBody = (schemaRef: string): BoundaryValidator => ({
  schemaRef,
  validate(input: unknown): BoundaryValidationResult {
    if (!isRecord(input)) {
      return validationFailure({ schemaRef, reason: "expected_object" });
    }
    const allowed = new Set(["provider_alias", "receipt_id", "normalized_schema_ref", "evidence_ref", "fields", "metadata", "legal_hold"]);
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) return validationFailure({ schemaRef, reason: "additional_property", key });
    }
    for (const prop of ["provider_alias", "receipt_id", "normalized_schema_ref"]) {
      if (typeof input[prop] !== "string" || input[prop].length === 0) {
        return validationFailure({ schemaRef, reason: "missing_required_string", prop });
      }
    }
    if (!Array.isArray(input.fields) || input.fields.length === 0) {
      return validationFailure({ schemaRef, reason: "missing_required_array", prop: "fields" });
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
  ["createWebAttendedRunRequest", requireWebAttendedRunRequestCreateBody("#/components/schemas/WebAttendedRunRequestCreate")],
  ["createRunTrigger", requireRunTriggerCreateBody("#/components/schemas/RunTriggerCreateRequest")],
  ["updateRunTrigger", requireObject("#/components/schemas/RunTriggerUpdateRequest")],
  ["pauseRunTrigger", requireObject("#/components/schemas/RunTriggerCommandRequest", [], true)],
  ["resumeRunTrigger", requireObject("#/components/schemas/RunTriggerCommandRequest", [], true)],
  ["ackOpsAlert", requireObject("#/components/schemas/OpsAlertAckRequest", [], true)],
  ["recordOpsAlertDelivery", requireOpsNotificationDeliveryBody("#/components/schemas/OpsNotificationDeliveryRequest")],
  ["sendOpsAlertWebhookDelivery", requireOpsNotificationWebhookSendBody("#/components/schemas/OpsNotificationWebhookSendRequest")],
  ["recordProductionReadinessEvidence", requireProductionReadinessEvidenceBody("#/components/schemas/ProductionReadinessEvidenceRequest")],
  ["recordAiGovernanceEvidence", requireAiGovernanceEvidenceBody("#/components/schemas/AiGovernanceEvidenceRequest")],
  ["createProcessMiningImport", requireProcessMiningImportBody("#/components/schemas/ProcessMiningImportCreateRequest")],
  ["createAutomationIdea", requireObject("#/components/schemas/AutomationIdeaCreateRequest", ["title", "description", "business_owner", "department"])],
  ["createDocumentJob", requireDocumentJobCreateBody("#/components/schemas/DocumentJobCreateRequest")],
  ["extractDocumentJob", requireObject("#/components/schemas/DocumentJobCommandRequest", [], true)],
  ["recordExternalDocumentExtraction", requireExternalDocumentExtractionBody("#/components/schemas/ExternalDocumentExtractionRequest")],
  ["createDocumentValidationTask", requireObject("#/components/schemas/DocumentJobCommandRequest", [], true)],
  ["updateAutomationIdea", requireObject("#/components/schemas/AutomationIdeaUpdateRequest")],
  ["transitionAutomationIdea", requireObject("#/components/schemas/AutomationIdeaTransitionRequest", ["stage"])],
  ["upsertRoiEstimate", requireObject("#/components/schemas/RoiEstimateRequest")],
  ["recordRoiActualEvidence", requireRoiActualEvidenceBody("#/components/schemas/RoiActualEvidenceRequest")],
  ["recordAutomationAdoptionEvidence", requireAutomationAdoptionEvidenceBody("#/components/schemas/AutomationAdoptionEvidenceRequest")],
  ["createConnectorProfile", requireObject("#/components/schemas/ConnectorProfileCreateRequest", ["connector_id", "profile_name", "owner_ref"])],
  ["certifyConnectorProfile", requireObject("#/components/schemas/ConnectorCertificationRequest", ["status", "reason"])],
  ["createIntegrationHandoff", requireObject("#/components/schemas/IntegrationHandoffCreateRequest", ["provider_alias", "job_ref", "payload_ref"])],
  ["dispatchIntegrationHandoff", requireIntegrationHandoffDispatchBody("#/components/schemas/IntegrationHandoffDispatchRequest")],
  ["recordIntegrationHandoffCallback", requireObject("#/components/schemas/IntegrationHandoffCallbackRequest", ["external_job_id", "status", "receipt_id"])],
  ["validateScenario", requireObject("#/components/schemas/ValidateRequest")],
  ["promoteScenario", requireObject("#/components/schemas/PromoteRequest", ["target"])],
  ["promoteScenarioFromRun", requireObject("#/components/schemas/PromoteScenarioFromRunRequest", ["run_id"])],
  ["archiveScenario", requireObject("#/components/schemas/ScenarioCommandRequest", [], true)],
  ["rollbackScenario", requireObject("#/components/schemas/ScenarioCommandRequest", [], true)],
  ["certifyScenarioVersion", requireObject("#/components/schemas/ScenarioCertificationRequest", ["reason"])],
  ["setScenarioVersionGovernanceStage", requireScenarioGovernanceStageBody("#/components/schemas/ScenarioGovernanceStageRequest")],
  ["revokeScenarioCertification", requireObject("#/components/schemas/ScenarioCertificationRevokeRequest", ["reason"])],
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
  ["ackOpsAlert", requireParams("#/components/schemas/OpsAlertPathParams", ["alert_id"])],
  ["listOpsAlertDeliveries", requireParams("#/components/schemas/OpsAlertPathParams", ["alert_id"])],
  ["recordOpsAlertDelivery", requireParams("#/components/schemas/OpsAlertPathParams", ["alert_id"])],
  ["sendOpsAlertWebhookDelivery", requireParams("#/components/schemas/OpsAlertPathParams", ["alert_id"])],
  ["getAutomationIdea", requireParams("#/components/schemas/AutomationIdeaPathParams", ["idea_id"])],
  ["getDocumentJob", requireParams("#/components/schemas/DocumentJobPathParams", ["job_id"])],
  ["extractDocumentJob", requireParams("#/components/schemas/DocumentJobPathParams", ["job_id"])],
  ["recordExternalDocumentExtraction", requireParams("#/components/schemas/DocumentJobPathParams", ["job_id"])],
  ["getDocumentExtraction", requireParams("#/components/schemas/DocumentJobPathParams", ["job_id"])],
  ["createDocumentValidationTask", requireParams("#/components/schemas/DocumentJobPathParams", ["job_id"])],
  ["updateAutomationIdea", requireParams("#/components/schemas/AutomationIdeaPathParams", ["idea_id"])],
  ["transitionAutomationIdea", requireParams("#/components/schemas/AutomationIdeaPathParams", ["idea_id"])],
  ["upsertRoiEstimate", requireParams("#/components/schemas/AutomationIdeaPathParams", ["idea_id"])],
  ["getRoiEstimate", requireParams("#/components/schemas/AutomationIdeaPathParams", ["idea_id"])],
  ["listRoiActualEvidence", requireParams("#/components/schemas/AutomationIdeaPathParams", ["idea_id"])],
  ["recordRoiActualEvidence", requireParams("#/components/schemas/AutomationIdeaPathParams", ["idea_id"])],
  ["listAutomationAdoptionEvidence", requireParams("#/components/schemas/AutomationIdeaPathParams", ["idea_id"])],
  ["recordAutomationAdoptionEvidence", requireParams("#/components/schemas/AutomationIdeaPathParams", ["idea_id"])],
  ["certifyConnectorProfile", requireParams("#/components/schemas/ConnectorProfilePathParams", ["profile_id"])],
  ["dispatchIntegrationHandoff", requireParams("#/components/schemas/IntegrationHandoffPathParams", ["handoff_id"])],
  ["recordIntegrationHandoffCallback", requireParams("#/components/schemas/IntegrationHandoffPathParams", ["handoff_id"])],
  ["validateScenario", requireParams("#/components/schemas/ScenarioPathParams", ["scenario_id"])],
  ["promoteScenario", requireParams("#/components/schemas/ScenarioPathParams", ["scenario_id"])],
  ["promoteScenarioFromRun", requireParams("#/components/schemas/ScenarioPathParams", ["scenario_id"])],
  ["archiveScenario", requireParams("#/components/schemas/ScenarioPathParams", ["scenario_id"])],
  ["listScenarioVersions", requireParams("#/components/schemas/ScenarioPathParams", ["scenario_id"])],
  ["getScenarioVersion", requireParams("#/components/schemas/ScenarioVersionPathParams", ["scenario_id", "version"])],
  ["rollbackScenario", requireParams("#/components/schemas/ScenarioVersionPathParams", ["scenario_id", "version"])],
  ["certifyScenarioVersion", requireParams("#/components/schemas/ScenarioVersionPathParams", ["scenario_id", "version"])],
  ["setScenarioVersionGovernanceStage", requireParams("#/components/schemas/ScenarioVersionPathParams", ["scenario_id", "version"])],
  ["revokeScenarioCertification", requireParams("#/components/schemas/ScenarioVersionPathParams", ["scenario_id", "version"])],
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
  ["listRunResumeRequests", passQuery("#/components/schemas/RunResumeRequestListQuery")],
  ["listWebAttendedRunRequests", passQuery("#/components/schemas/WebAttendedRunRequestListQuery")],
  ["listRunTriggers", passQuery("#/components/schemas/RunTriggerListQuery")],
  ["listRunTriggerFires", passQuery("#/components/schemas/RunTriggerFireListQuery")],
  ["listOpsAlerts", passQuery("#/components/schemas/OpsAlertListQuery")],
  ["listOpsAlertDeliveries", passQuery("#/components/schemas/OpsAlertDeliveryListQuery")],
  ["listProductionReadinessEvidence", requireProductionReadinessEvidenceQuery("#/components/schemas/ProductionReadinessEvidenceListQuery")],
  ["listAiGovernanceEvidence", requireAiGovernanceEvidenceQuery("#/components/schemas/AiGovernanceEvidenceListQuery")],
  ["listProcessMiningImports", passQuery("#/components/schemas/ProcessMiningImportListQuery")],
  ["listAutomationIdeas", passQuery("#/components/schemas/AutomationIdeaListQuery")],
  ["listRoiActualEvidence", passQuery("#/components/schemas/RoiActualEvidenceListQuery")],
  ["listAutomationAdoptionEvidence", passQuery("#/components/schemas/AutomationAdoptionEvidenceListQuery")],
  ["listDocumentJobs", passQuery("#/components/schemas/DocumentJobListQuery")],
  ["exportOffboardingData", passQuery("#/components/schemas/OffboardingExportQuery")],
  ["listAuditLog", passQuery("#/components/schemas/AuditLogListQuery")],
  ["exportAuditLog", passQuery("#/components/schemas/AuditLogExportQuery")],
  ["listConnectors", passQuery("#/components/schemas/ConnectorCatalogListQuery")],
  ["listTemplates", passQuery("#/components/schemas/TemplateCatalogListQuery")],
  ["listConnectorProfiles", passQuery("#/components/schemas/ConnectorProfileListQuery")],
  ["listIntegrationHandoffs", passQuery("#/components/schemas/IntegrationHandoffListQuery")],
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
