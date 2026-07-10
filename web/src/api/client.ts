// 주입형 ApiClient 포트 + HTTP 구현. 테스트는 동일 인터페이스의 fake를 주입(백엔드 무의존).
import type { GatewayCallSummary, GatewayPolicy, RunSummary, RunTrends } from "./types";
import type { ApiClientCore } from "./client-contract-core";
import type { ApiClientOps } from "./client-contract-ops";
import { createHttpHelpers, parseEtagVersion, queryString, type HttpApiClientOptions } from "./client-http";

export type { HttpApiClientOptions, RunStepStreamEvent } from "./client-http";

export interface ApiClient extends ApiClientCore, ApiClientOps {}

export function createHttpApiClient(opts: HttpApiClientOptions): ApiClient {
  const { doFetch, authHeaders, parseOrThrow, parseBlobOrThrow, get, getText, getBlob, send, post, watchRunSteps } =
    createHttpHelpers(opts);

  return {
    getCapabilities: () => get(`/v1/capabilities`),
    listOffboardingPurgeRequests: () => get(`/v1/offboarding/purge-requests`),
    createOffboardingPurgeRequest: (reason, idempotencyKey) =>
      post(`/v1/offboarding/purge-requests`, idempotencyKey, { reason }),
    decideOffboardingPurgeRequest: (requestId, decision, idempotencyKey, reason) =>
      post(`/v1/offboarding/purge-requests/${encodeURIComponent(requestId)}/decide`, idempotencyKey, reason !== undefined ? { decision, reason } : { decision }),
    cancelOffboardingPurgeRequest: (requestId, idempotencyKey) =>
      post(`/v1/offboarding/purge-requests/${encodeURIComponent(requestId)}/cancel`, idempotencyKey, {}),
    listRuns: (p) => get(`/v1/runs${queryString(p)}`),
    search: (q, limit = 20) => get(`/v1/search${queryString({ q, limit })}`),
    listRunSteps: (runId, p) => get(`/v1/runs/${runId}/steps${queryString(p)}`),
    watchRunSteps,
    listRunArtifacts: (runId, p) => get(`/v1/runs/${runId}/artifacts${queryString(p)}`),
    listScenarioGenerationArtifacts: (generationId, p) => get(`/v1/scenario-generations/${generationId}/artifacts${queryString(p)}`),
    listScenarioGenerationResultArtifacts: (generationId, p) =>
      get(`/v1/scenario-generations/${generationId}/result-artifacts${queryString(p)}`),
    listWorkitems: (p) => get(`/v1/workitems${queryString(p)}`),
    listHumanTasks: (p) => get(`/v1/human-tasks${queryString(p)}`),
    listPrincipals: (p) => get(`/v1/principals${queryString(p)}`),
    listDlq: (kind, p) => get(`/v1/dlq${queryString({ ...p, kind })}`),
    listScenarios: (p) => get(`/v1/scenarios${queryString(p)}`),
    listRunTriggers: (p) => get(`/v1/run-triggers${queryString(p)}`),
    getRunTrigger: (triggerId) => get(`/v1/run-triggers/${triggerId}`),
    createRunTrigger: (body, key) => post(`/v1/run-triggers`, key, body),
    updateRunTrigger: (triggerId, body, key) =>
      send("PATCH", `/v1/run-triggers/${triggerId}`, body, { "Idempotency-Key": key }),
    pauseRunTrigger: (triggerId, key) => post(`/v1/run-triggers/${triggerId}/pause`, key),
    resumeRunTrigger: (triggerId, key) => post(`/v1/run-triggers/${triggerId}/resume`, key),
    listRunTriggerFires: (triggerId, p) => get(`/v1/run-triggers/${triggerId}/fires${queryString(p)}`),
    listOpsAlerts: (p) => get(`/v1/ops-alerts${queryString(p)}`),
    ackOpsAlert: (alertId, idempotencyKey, comment) =>
      post(`/v1/ops-alerts/${encodeURIComponent(alertId)}/ack`, idempotencyKey, comment !== undefined ? { comment } : {}),
    listOpsAlertDeliveries: (alertId, p) =>
      get(`/v1/ops-alerts/${encodeURIComponent(alertId)}/deliveries${queryString(p)}`),
    recordOpsAlertDelivery: (alertId, body, idempotencyKey) =>
      post(`/v1/ops-alerts/${encodeURIComponent(alertId)}/deliveries`, idempotencyKey, body),
    sendOpsAlertWebhookDelivery: (alertId, body, idempotencyKey) =>
      post(`/v1/ops-alerts/${encodeURIComponent(alertId)}/deliveries/send-webhook`, idempotencyKey, body),
    listOpsAlertNotificationRoutes: (p) => get(`/v1/ops-alert-routes${queryString(p)}`),
    createOpsAlertNotificationRoute: (body, idempotencyKey) => post(`/v1/ops-alert-routes`, idempotencyKey, body),
    updateOpsAlertNotificationRoute: (routeId, body, idempotencyKey) =>
      send("PATCH", `/v1/ops-alert-routes/${encodeURIComponent(routeId)}`, body, { "Idempotency-Key": idempotencyKey }),
    deleteOpsAlertNotificationRoute: (routeId, idempotencyKey) =>
      send("DELETE", `/v1/ops-alert-routes/${encodeURIComponent(routeId)}`, undefined, { "Idempotency-Key": idempotencyKey }),
    getOpsHealth: () => get(`/v1/ops/health`),
    getProductionReadiness: () => get(`/v1/ops/production-readiness`),
    listProductionReadinessEvidence: (p) => get(`/v1/ops/production-readiness/evidence${queryString(p)}`),
    recordProductionReadinessEvidence: (body, idempotencyKey) => post(`/v1/ops/production-readiness/evidence`, idempotencyKey, body),
    listAiGovernanceEvidence: (p) => get(`/v1/ai-governance/evidence${queryString(p)}`),
    getAiGovernanceEvidenceSummary: (p) => get(`/v1/ai-governance/evidence/summary${queryString(p)}`),
    recordAiGovernanceEvidence: (body, idempotencyKey) => post(`/v1/ai-governance/evidence`, idempotencyKey, body),
    getAiGovernanceRuntimePolicy: () => get(`/v1/ai-governance/runtime-policy`),
    upsertAiGovernanceRuntimePolicy: (body, idempotencyKey) =>
      send("PUT", `/v1/ai-governance/runtime-policy`, body, { "Idempotency-Key": idempotencyKey }),
    listBotPools: (p) => get(`/v1/bot-pools${queryString(p)}`),
    getAutomationPerformanceReport: (month, runMode = "prod") =>
      get(`/v1/reports/automation-performance${queryString({ ...(month !== undefined ? { month } : {}), run_mode: runMode })}`),
    exportAutomationPerformanceReportCsv: (month, runMode = "prod") =>
      getText(`/v1/reports/automation-performance/export${queryString({ ...(month !== undefined ? { month } : {}), run_mode: runMode, format: "csv" })}`, "text/csv"),
    exportAutomationPerformanceReportXlsx: (month, runMode = "prod") =>
      getBlob(
        `/v1/reports/automation-performance/export${queryString({ ...(month !== undefined ? { month } : {}), run_mode: runMode, format: "xlsx" })}`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    exportAutomationPerformanceReportPocMarkdown: (month, runMode = "prod") =>
      getText(
        `/v1/reports/automation-performance/export${queryString({ ...(month !== undefined ? { month } : {}), run_mode: runMode, format: "poc_markdown" })}`,
        "text/markdown",
      ),
    listProcessMiningImports: (p) => get(`/v1/process-mining/imports${queryString(p)}`),
    createProcessMiningImport: (body, key) => post(`/v1/process-mining/imports`, key, body),
    listAutomationIdeas: (p) => get(`/v1/automation-ideas${queryString(p)}`),
    listAuditLog: (p) => get(`/v1/audit-log${queryString(p)}`),
    getAuditLogSummary: (p) => get(`/v1/audit-log/summary${queryString(p)}`),
    exportAuditLogCsv: (p) => getText(`/v1/audit-log/export${queryString({ ...p, format: "csv" })}`, "text/csv"),
    listAuditVerificationRuns: (p) => get(`/v1/audit-log/verification-runs${queryString(p)}`),
    runAuditVerification: (idempotencyKey, body) => post(`/v1/audit-log/verification-runs/verify`, idempotencyKey, body ?? {}),
    getAuthReadiness: () => get(`/v1/auth/readiness`),
    listConnectors: (p) => get(`/v1/connectors${queryString(p)}`),
    listTemplates: (p) => get(`/v1/templates${queryString(p)}`),
    listConnectorProfiles: (p) => get(`/v1/connector-profiles${queryString(p)}`),
    createConnectorProfile: (body, key) => post(`/v1/connector-profiles`, key, body),
    certifyConnectorProfile: (profileId, body, key) =>
      post(`/v1/connector-profiles/${encodeURIComponent(profileId)}/certifications`, key, body),
    listIntegrationHandoffs: (p) => get(`/v1/integration-handoffs${queryString(p)}`),
    createIntegrationHandoff: (body, key) => post(`/v1/integration-handoffs`, key, body),
    dispatchIntegrationHandoff: (handoffId, body, key) => post(`/v1/integration-handoffs/${handoffId}/dispatch`, key, body),
    recordIntegrationHandoffCallback: (handoffId, body) => send("POST", `/v1/integration-handoffs/${handoffId}/callback`, body),
    listRunResumeRequests: (p) => get(`/v1/run-resume-requests${queryString(p)}`),
    listWebAttendedRunRequests: (p) => get(`/v1/web-attended/run-requests${queryString(p)}`),
    createWebAttendedRunRequest: (body, key) => post(`/v1/web-attended/run-requests`, key, body),
    listDocumentJobs: (p) => get(`/v1/document-jobs${queryString(p)}`),
    createDocumentJob: (body, key) => post(`/v1/document-jobs`, key, body),
    getDocumentJob: (jobId) => get(`/v1/document-jobs/${jobId}`),
    extractDocumentJob: (jobId, key) => post(`/v1/document-jobs/${jobId}/extract`, key),
    recordExternalDocumentExtraction: (jobId, body, key) => post(`/v1/document-jobs/${jobId}/external-extractions`, key, body),
    getDocumentExtraction: (jobId) => get(`/v1/document-jobs/${jobId}/extraction`),
    createDocumentValidationTask: (jobId, key) => post(`/v1/document-jobs/${jobId}/validation-task`, key),
    createAutomationIdea: (body, key) => post(`/v1/automation-ideas`, key, body),
    getAutomationIdea: (ideaId) => get(`/v1/automation-ideas/${ideaId}`),
    updateAutomationIdea: (ideaId, body, key) =>
      send("PATCH", `/v1/automation-ideas/${ideaId}`, body, { "Idempotency-Key": key }),
    transitionAutomationIdea: (ideaId, stage, key) => post(`/v1/automation-ideas/${ideaId}/transition`, key, { stage }),
    upsertRoiEstimate: (ideaId, body, key) => post(`/v1/automation-ideas/${ideaId}/roi-estimate`, key, body),
    getRoiEstimate: (ideaId) => get(`/v1/automation-ideas/${ideaId}/roi-estimate`),
    listAutomationAdoptionEvidence: (ideaId, p) =>
      get(`/v1/automation-ideas/${ideaId}/adoption-evidence${queryString(p)}`),
    recordAutomationAdoptionEvidence: (ideaId, body, key) =>
      post(`/v1/automation-ideas/${ideaId}/adoption-evidence`, key, body),
    listRoiActualEvidence: (ideaId, p) => get(`/v1/automation-ideas/${ideaId}/roi-actuals${queryString(p)}`),
    recordRoiActualEvidence: (ideaId, body, key) => post(`/v1/automation-ideas/${ideaId}/roi-actuals`, key, body),
    getRoiActualSuggestion: (ideaId, p) =>
      get(
        `/v1/automation-ideas/${ideaId}/roi-actuals/suggestion?period_start=${encodeURIComponent(p.period_start)}&period_end=${encodeURIComponent(p.period_end)}`,
      ),
    listSites: (p) => get(`/v1/sites${queryString(p)}`),
    listSiteElements: (siteId, p) => get(`/v1/sites/${siteId}/elements${queryString(p)}`),
    createSiteElement: (siteId, body, key) => post(`/v1/sites/${siteId}/elements`, key, body),
    updateSiteElement: (siteId, elementId, body, key) =>
      send("PATCH", `/v1/sites/${siteId}/elements/${elementId}`, body, { "Idempotency-Key": key }),
    probeSiteElement: (siteId, elementId, body, key) =>
      post(`/v1/sites/${siteId}/elements/${elementId}/probe`, key, body),
    deleteSiteElement: (siteId, elementId, key) =>
      send("DELETE", `/v1/sites/${siteId}/elements/${elementId}`, undefined, { "Idempotency-Key": key }),
    listBrowserRecordings: (siteId, p) => get(`/v1/sites/${siteId}/recordings${queryString(p)}`),
    startBrowserRecording: (siteId, body, key) => post(`/v1/sites/${siteId}/recordings`, key, body),
    listBrowserRecordingEvents: (siteId, recordingId, p) =>
      get(`/v1/sites/${siteId}/recordings/${recordingId}/events${queryString(p)}`),
    appendBrowserRecordingEvents: (siteId, recordingId, body, key) =>
      post(`/v1/sites/${siteId}/recordings/${recordingId}/events`, key, body),
    completeBrowserRecording: (siteId, recordingId, key) =>
      post(`/v1/sites/${siteId}/recordings/${recordingId}/complete`, key),
    promoteRecordingToStudio: (siteId, recordingId, key) =>
      post(`/v1/sites/${siteId}/recordings/${recordingId}/promote-to-studio`, key),
    listSessionCaptures: (siteId) => get(`/v1/sites/${siteId}/session/capture`),
    listGatewayPolicies: () => get(`/v1/gateway/policies`),
    getGatewayCallSummary: (days) => get<GatewayCallSummary>(`/v1/gateway/call-summary${days !== undefined ? `?days=${days}` : ""}`),
    getGatewayPolicy: async (model) => {
      // GET은 ETag(=version) 헤더로 동시성 토큰을 노출 → PUT If-Match의 선행 read. body shape는 불변.
      const res = await doFetch(`${opts.baseUrl}/v1/gateway/policy${queryString(model ? { model } : undefined)}`, {
        method: "GET",
        headers: { Accept: "application/json", ...authHeaders() },
      });
      const body = await parseOrThrow<GatewayPolicy>(res);
      const version = parseEtagVersion(res.headers.get("etag"));
      return version !== undefined ? { ...body, version } : body;
    },
    createGatewayPolicy: (body, key) => post(`/v1/gateway/policy`, key, body),
    updateGatewayPolicy: (version, body, key) =>
      send("PUT", `/v1/gateway/policy`, body, { "If-Match": String(version), "Idempotency-Key": key }),
    deleteGatewayPolicy: (model, version, key) =>
      send("DELETE", `/v1/gateway/policy${queryString({ model })}`, undefined, {
        "If-Match": String(version),
        "Idempotency-Key": key,
      }),
    abortRun: (runId, idempotencyKey) => post(`/v1/runs/${runId}/abort`, idempotencyKey),
    pauseRun: (runId, idempotencyKey, reason) => post(`/v1/runs/${runId}/pause`, idempotencyKey, reason !== undefined ? { reason } : {}),
    rerunRun: (runId, body, idempotencyKey) => post(`/v1/runs/${runId}/rerun`, idempotencyKey, body),
    resumeRun: (runId, idempotencyKey, reason) => post(`/v1/runs/${runId}/resume`, idempotencyKey, reason !== undefined ? { reason } : {}),
    prioritizeRun: (runId, body, idempotencyKey) => post(`/v1/runs/${runId}/priority`, idempotencyKey, body),
    replayDeadLetter: (deadLetterId, idempotencyKey, kind) => post(`/v1/dlq/${deadLetterId}/replay${queryString({ kind })}`, idempotencyKey),
    replayAllDlq: (kind, idempotencyKey) => post(`/v1/dlq/replay-all${queryString({ kind })}`, idempotencyKey),
    approveSite: (siteId, key, opts) => post(`/v1/sites/${siteId}/approve`, key, opts ?? {}),
    listSiteApprovals: (siteId) => get(`/v1/sites/${siteId}/approvals`),
    createSite: (body, key) => post(`/v1/sites`, key, body),
    updateSite: (siteId, name, key) => send("PATCH", `/v1/sites/${siteId}`, { name }, { "Idempotency-Key": key }),
    updateSitePageState: (siteId, pageStateSelectors, key) =>
      send("PATCH", `/v1/sites/${siteId}/page-state`, { page_state_selectors: pageStateSelectors }, { "Idempotency-Key": key }),
    createPrincipal: (body, key) => post(`/v1/principals`, key, body),
    updatePrincipal: (principalId, body, key) => send("PATCH", `/v1/principals/${principalId}`, body, { "Idempotency-Key": key }),
    deletePrincipal: (principalId, key) => send("DELETE", `/v1/principals/${principalId}`, undefined, { "Idempotency-Key": key }),
    listScimProviders: () => get(`/v1/scim/providers`),
    createScimProvider: (body, key) => post(`/v1/scim/providers`, key, body),
    updateScimProvider: (providerKey, body, key) =>
      send("PATCH", `/v1/scim/providers/${encodeURIComponent(providerKey)}`, body, { "Idempotency-Key": key }),
    decommissionScimProvider: (providerKey, body, key) =>
      post(`/v1/scim/providers/${encodeURIComponent(providerKey)}/decommission`, key, body),
    listScimGroupRoleMappings: (providerKey) =>
      get(`/v1/scim/providers/${encodeURIComponent(providerKey)}/group-role-mappings`),
    importScimGroupRoleMappings: (providerKey, body, key) =>
      post(`/v1/scim/providers/${encodeURIComponent(providerKey)}/group-role-mappings/import`, key, body),
    createScimGroupRoleMapping: (providerKey, body, key) =>
      post(`/v1/scim/providers/${encodeURIComponent(providerKey)}/group-role-mappings`, key, body),
    updateScimGroupRoleMapping: (providerKey, mappingId, body, key) =>
      send("PATCH", `/v1/scim/providers/${encodeURIComponent(providerKey)}/group-role-mappings/${encodeURIComponent(mappingId)}`, body, {
        "Idempotency-Key": key,
      }),
    listPrincipalRoleAssignments: (principalId, p) => get(`/v1/principals/${principalId}/role-assignments${queryString(p)}`),
    listRoleAssignments: (p) => get(`/v1/role-assignments${queryString(p)}`),
    grantPrincipalRole: (principalId, body, key) => post(`/v1/principals/${principalId}/role-assignments`, key, body),
    revokeRoleAssignment: (assignmentId, reason, key) => post(`/v1/role-assignments/${assignmentId}/revoke`, key, { reason }),
    captureSession: (siteId, key) => post(`/v1/sites/${siteId}/session/capture`, key, {}),
    assignHumanTask: (id, assignee, key) => post(`/v1/human-tasks/${id}/assign`, key, { assignee }),
    startHumanTask: (id, key) => post(`/v1/human-tasks/${id}/start`, key),
    resolveHumanTask: (id, key, result) => post(`/v1/human-tasks/${id}/resolve`, key, result !== undefined ? { result } : {}),
    escalateHumanTask: (id, key, reason) => post(`/v1/human-tasks/${id}/escalate`, key, reason !== undefined ? { reason } : {}),
    promoteScenario: (scenarioId, version, key) =>
      post(`/v1/scenarios/${scenarioId}/promote`, key, { target: "prod" }, { "If-Match": String(version) }),
    promoteScenarioFromRun: (scenarioId, runId, key) => post(`/v1/scenarios/${scenarioId}/promote-from-run`, key, { run_id: runId }),
    setScenarioPromotion: (scenarioId, version, target, key) =>
      post(`/v1/scenarios/${scenarioId}/promote`, key, { target }, { "If-Match": String(version) }),
    listScenarioEnvironmentBindings: (scenarioId) => get(`/v1/scenarios/${scenarioId}/environment-bindings`),
    listScenarioReleases: (scenarioId, p) => get(`/v1/scenarios/${scenarioId}/releases${queryString(p)}`),
    createScenarioRelease: (scenarioId, body, key) => post(`/v1/scenarios/${scenarioId}/releases`, key, body),
    getScenarioRelease: (releaseId) => get(`/v1/scenario-releases/${releaseId}`),
    submitScenarioRelease: (releaseId, key) => post(`/v1/scenario-releases/${releaseId}/submit`, key),
    approveScenarioRelease: (releaseId, reason, key) =>
      post(`/v1/scenario-releases/${releaseId}/approve`, key, reason !== null ? { reason } : {}),
    rejectScenarioRelease: (releaseId, reason, key) => post(`/v1/scenario-releases/${releaseId}/reject`, key, { reason }),
    deployScenarioRelease: (releaseId, latestVersion, key) =>
      post(`/v1/scenario-releases/${releaseId}/deploy`, key, {}, { "If-Match": String(latestVersion) }),
    rollbackScenarioRelease: (releaseId, latestVersion, key) =>
      post(`/v1/scenario-releases/${releaseId}/rollback`, key, {}, { "If-Match": String(latestVersion) }),
    certifyScenarioVersion: (scenarioId, version, reason, expiresAt, key) =>
      post(`/v1/scenarios/${scenarioId}/versions/${version}/certify`, key, expiresAt !== null ? { reason, expires_at: expiresAt } : { reason }),
    revokeScenarioCertification: (scenarioId, version, reason, key) =>
      post(`/v1/scenarios/${scenarioId}/versions/${version}/revoke-certification`, key, { reason }),
    setScenarioVersionGovernanceStage: (scenarioId, version, body, key) =>
      post(`/v1/scenarios/${scenarioId}/versions/${version}/governance-stage`, key, body),
    archiveScenario: (scenarioId, version, key) =>
      post(`/v1/scenarios/${scenarioId}/archive`, key, {}, { "If-Match": String(version) }),
    createPromotionRequest: (scenarioId, version, reason, key) =>
      post(`/v1/scenarios/${scenarioId}/promotion-requests`, key, { version, reason }),
    listPromotionRequests: () => get(`/v1/scenarios/promotion-requests`),
    listConcurrencyPolicies: () => get(`/v1/credentials/concurrency`),
    registerCredentialBinding: (body, key) => post(`/v1/credentials`, key, body),
    rotateCredentialBinding: (body, key) => post(`/v1/credentials/rotate`, key, body),
    decommissionCredentialBinding: (body, key) => post(`/v1/credentials/decommission`, key, body),
    deleteCredentialBinding: (credentialRef, siteProfileId, key) =>
      send("DELETE", `/v1/credentials${queryString({ credential_ref: credentialRef, site_profile_id: siteProfileId })}`, undefined, {
        "Idempotency-Key": key,
      }),
    listWorkerPools: () => get(`/v1/worker-pools`),
    createWorkerPool: (body, key) => post(`/v1/worker-pools`, key, body),
    updateWorkerPool: (poolKey, body, key) =>
      send("PATCH", `/v1/worker-pools/${encodeURIComponent(poolKey)}`, body, { "Idempotency-Key": key }),
    deleteWorkerPool: (poolKey, key) =>
      send("DELETE", `/v1/worker-pools/${encodeURIComponent(poolKey)}`, undefined, { "Idempotency-Key": key }),
    assignWorkerToPool: (poolKey, workerId, key) =>
      send("PUT", `/v1/worker-pools/${encodeURIComponent(poolKey)}/workers/${encodeURIComponent(workerId)}`, undefined, { "Idempotency-Key": key }),
    removeWorkerFromPool: (poolKey, workerId, key) =>
      send("DELETE", `/v1/worker-pools/${encodeURIComponent(poolKey)}/workers/${encodeURIComponent(workerId)}`, undefined, { "Idempotency-Key": key }),
    assignWorkerPool: (poolKey, key) => send("PUT", `/v1/worker-pool`, { pool_key: poolKey }, { "Idempotency-Key": key }),
    unassignWorkerPool: (key) => send("DELETE", `/v1/worker-pool`, undefined, { "Idempotency-Key": key }),
    decidePromotionRequest: (scenarioId, requestId, decision, reason, key) =>
      post(
        `/v1/scenarios/${scenarioId}/promotion-requests/${requestId}/decide`,
        key,
        reason !== undefined && reason.trim() !== "" ? { decision, reason: reason.trim() } : { decision },
      ),
    listScenarioVersions: (scenarioId) => get(`/v1/scenarios/${scenarioId}/versions`),
    rollbackScenario: (scenarioId, sourceVersion, latestVersion, key) =>
      post(`/v1/scenarios/${scenarioId}/versions/${sourceVersion}/rollback`, key, {}, { "If-Match": String(latestVersion) }),
    getRun: (id) => get(`/v1/runs/${id}`),
    getRunSummary: (runMode) => get<RunSummary>(`/v1/runs/summary${runMode !== undefined ? `?run_mode=${runMode}` : ""}`),
    getRunTrends: (days, runMode) => {
      const params = new URLSearchParams();
      if (days !== undefined) params.set("days", String(days));
      if (runMode !== undefined) params.set("run_mode", runMode);
      const qs = params.toString();
      return get<RunTrends>(`/v1/runs/trends${qs.length > 0 ? `?${qs}` : ""}`);
    },
    getWorkitem: (id) => get(`/v1/workitems/${id}`),
    getHumanTask: (id) => get(`/v1/human-tasks/${id}`),
    getScenario: (id) => get(`/v1/scenarios/${id}`),
    getSite: (id) => get(`/v1/sites/${id}`),
    getArtifact: (id) => get(`/v1/artifacts/${id}`),
    getArtifactBlob: async (id) => {
      const res = await doFetch(`${opts.baseUrl}/v1/artifacts/${id}/blob`, {
        method: "GET",
        headers: { Accept: "*/*", ...authHeaders() },
      });
      return parseBlobOrThrow(res);
    },
    getScenarioGenerationArtifact: (generationId, artifactId) =>
      get(`/v1/scenario-generations/${generationId}/artifacts/${artifactId}`),
    validateScenario: (scenarioId, ir, key) => post(`/v1/scenarios/${scenarioId}/validate`, key, ir),
    createScenario: (ir) => send("POST", `/v1/scenarios`, ir),
    updateScenario: (scenarioId, ir, version) =>
      send("PUT", `/v1/scenarios/${scenarioId}`, ir, { "If-Match": String(version) }),
    generateScenario: (body, key) => post(`/v1/scenario-generations`, key, body),
    runScenarioGeneration: (generationId, body, key) => post(`/v1/scenario-generations/${generationId}/run`, key, body),
    reviseScenarioGeneration: (generationId, body, key) => post(`/v1/scenario-generations/${generationId}/revise`, key, body),
    getScenarioGenerationCapabilities: () => get(`/v1/scenario-generations/capabilities`),
    listScenarioGenerations: (p) => get(`/v1/scenario-generations${queryString(p)}`),
    getScenarioGeneration: (generationId) => get(`/v1/scenario-generations/${generationId}`),
    createRun: (body, key) => post(`/v1/runs`, key, body),
    decideApproval: (body, key) => post(`/v1/approvals/decide`, key, body),
    fanOutApprovals: (sourceRunId, key, enableAuto) =>
      post(`/v1/approvals/fan-out`, key, { source_run_id: sourceRunId, ...(enableAuto === true ? { enable_auto: true } : {}) }),
  };
}
