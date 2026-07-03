import type {
  AiGovernanceEvidence,
  AiGovernanceEvidenceListParams,
  AiGovernanceEvidenceRequest,
  AiGovernanceRuntimePolicy,
  AiGovernanceRuntimePolicyEnvelope,
  AiGovernanceRuntimePolicyRequest,
  AuditLogExportParams,
  AuditLogItem,
  AuditLogListParams,
  AuditVerificationRun,
  AuditVerificationRunListParams,
  AuthReadiness,
  AutomationAdoptionEvidenceItem,
  AutomationAdoptionEvidenceListParams,
  AutomationAdoptionEvidencePage,
  AutomationAdoptionEvidenceRequest,
  AutomationIdeaCreateBody,
  AutomationIdeaItem,
  AutomationIdeaListParams,
  AutomationIdeaStage,
  AutomationIdeaUpdateBody,
  AutomationPerformanceReport,
  AutomationPerformanceRunMode,
  BotPoolItem,
  ConcurrencyPolicy,
  ConnectorCatalogItem,
  ConnectorCatalogListParams,
  ConnectorCertification,
  ConnectorCertificationRequest,
  ConnectorProfile,
  ConnectorProfileCreateRequest,
  ConnectorProfileListParams,
  CredentialBindingRequest,
  CredentialBindingResult,
  CredentialDecommissionRequest,
  CredentialDecommissionResult,
  CredentialRotateRequest,
  CredentialRotateResult,
  DocumentExtraction,
  DocumentJobCreateBody,
  DocumentJobItem,
  DocumentJobListParams,
  DocumentValidationTaskResult,
  ExternalDocumentExtractionBody,
  GatewayCallSummary,
  GatewayPolicy,
  GatewayPolicyUpdate,
  IntegrationHandoff,
  IntegrationHandoffCallbackRequest,
  IntegrationHandoffCreateRequest,
  IntegrationHandoffDispatchAttempt,
  IntegrationHandoffDispatchRequest,
  IntegrationHandoffListParams,
  ListParams,
  OffboardingPurgeRequestItem,
  OffboardingPurgeRequestPage,
  OpsAlertItem,
  OpsAlertListParams,
  OpsAlertNotificationRoute,
  OpsAlertNotificationRouteCreateRequest,
  OpsAlertNotificationRouteDeleteResult,
  OpsAlertNotificationRouteUpdateRequest,
  OpsHealth,
  OpsNotificationAttempt,
  OpsNotificationDelivery,
  OpsNotificationDeliveryRequest,
  OpsNotificationWebhookSendRequest,
  Paginated,
  PrincipalItem,
  ProcessMiningImportCreateBody,
  ProcessMiningImportItem,
  ProcessMiningImportListParams,
  ProductionReadiness,
  ProductionReadinessEvidence,
  ProductionReadinessEvidenceRequest,
  ProductionReadinessEvidenceType,
  RoiActualEvidence,
  RoiActualEvidenceRequest,
  RoiActualSuggestion,
  RoiEstimate,
  RoiEstimateRequest,
  RoleAssignmentItem,
  RuntimeCapabilities,
  ScimGroupRoleMappingImportBody,
  ScimGroupRoleMappingImportResult,
  ScimGroupRoleMappingItem,
  ScimProviderCreateBody,
  ScimProviderDecommissionBody,
  ScimProviderDecommissionResult,
  ScimProviderItem,
  ScimProviderUpdateBody,
  TemplateCatalogItem,
  TemplateCatalogListParams,
  WorkerPoolList,
  WorkerPoolMutationBody,
} from "./types";

export interface ApiClientOps {
  getCapabilities(): Promise<RuntimeCapabilities>;
  // 오프보딩 삭제 원장(O2/O3) — 조회는 admin(tenant_data.export), 명령은 admin(tenant_data.purge.*).
  listOffboardingPurgeRequests(): Promise<OffboardingPurgeRequestPage>;
  createOffboardingPurgeRequest(reason: string, idempotencyKey: string): Promise<OffboardingPurgeRequestItem>;
  decideOffboardingPurgeRequest(requestId: string, decision: "approved" | "rejected", idempotencyKey: string, reason?: string): Promise<OffboardingPurgeRequestItem>;
  cancelOffboardingPurgeRequest(requestId: string, idempotencyKey: string): Promise<OffboardingPurgeRequestItem>;
  listPrincipals(p?: ListParams): Promise<Paginated<PrincipalItem>>;
  listOpsAlerts(p?: OpsAlertListParams): Promise<Paginated<OpsAlertItem>>;
  ackOpsAlert(alertId: string, idempotencyKey: string, comment?: string): Promise<OpsAlertItem>;
  listOpsAlertDeliveries(alertId: string, p?: ListParams): Promise<Paginated<OpsNotificationDelivery>>;
  recordOpsAlertDelivery(alertId: string, body: OpsNotificationDeliveryRequest, idempotencyKey: string): Promise<OpsNotificationDelivery>;
  sendOpsAlertWebhookDelivery(alertId: string, body: OpsNotificationWebhookSendRequest, idempotencyKey: string): Promise<OpsNotificationAttempt>;
  listOpsAlertNotificationRoutes(p?: ListParams): Promise<Paginated<OpsAlertNotificationRoute>>;
  createOpsAlertNotificationRoute(body: OpsAlertNotificationRouteCreateRequest, idempotencyKey: string): Promise<OpsAlertNotificationRoute>;
  updateOpsAlertNotificationRoute(routeId: string, body: OpsAlertNotificationRouteUpdateRequest, idempotencyKey: string): Promise<OpsAlertNotificationRoute>;
  deleteOpsAlertNotificationRoute(routeId: string, idempotencyKey: string): Promise<OpsAlertNotificationRouteDeleteResult>;
  getOpsHealth(): Promise<OpsHealth>;
  getProductionReadiness(): Promise<ProductionReadiness>;
  listProductionReadinessEvidence(p?: ListParams & { evidence_type?: ProductionReadinessEvidenceType }): Promise<Paginated<ProductionReadinessEvidence>>;
  recordProductionReadinessEvidence(body: ProductionReadinessEvidenceRequest, idempotencyKey: string): Promise<ProductionReadinessEvidence>;
  listAiGovernanceEvidence(p?: AiGovernanceEvidenceListParams): Promise<Paginated<AiGovernanceEvidence>>;
  recordAiGovernanceEvidence(body: AiGovernanceEvidenceRequest, idempotencyKey: string): Promise<AiGovernanceEvidence>;
  getAiGovernanceRuntimePolicy(): Promise<AiGovernanceRuntimePolicyEnvelope>;
  upsertAiGovernanceRuntimePolicy(body: AiGovernanceRuntimePolicyRequest, idempotencyKey: string): Promise<AiGovernanceRuntimePolicy>;
  listBotPools(p?: ListParams): Promise<Paginated<BotPoolItem>>;
  getAutomationPerformanceReport(month?: string, runMode?: AutomationPerformanceRunMode): Promise<AutomationPerformanceReport>;
  exportAutomationPerformanceReportCsv(month?: string, runMode?: AutomationPerformanceRunMode): Promise<string>;
  exportAutomationPerformanceReportXlsx?(month?: string, runMode?: AutomationPerformanceRunMode): Promise<Blob>;
  exportAutomationPerformanceReportPocMarkdown?(month?: string, runMode?: AutomationPerformanceRunMode): Promise<string>;
  listProcessMiningImports(p?: ProcessMiningImportListParams): Promise<Paginated<ProcessMiningImportItem>>;
  createProcessMiningImport(body: ProcessMiningImportCreateBody, idempotencyKey: string): Promise<ProcessMiningImportItem>;
  listAutomationIdeas(p?: AutomationIdeaListParams): Promise<Paginated<AutomationIdeaItem>>;
  listAuditLog(p?: AuditLogListParams): Promise<Paginated<AuditLogItem>>;
  exportAuditLogCsv(p?: AuditLogExportParams): Promise<string>;
  listAuditVerificationRuns(p?: AuditVerificationRunListParams): Promise<Paginated<AuditVerificationRun>>;
  runAuditVerification(idempotencyKey: string, body?: { legal_hold?: boolean }): Promise<AuditVerificationRun>;
  getAuthReadiness(): Promise<AuthReadiness>;
  listConnectors(p?: ConnectorCatalogListParams): Promise<Paginated<ConnectorCatalogItem>>;
  listTemplates(p?: TemplateCatalogListParams): Promise<Paginated<TemplateCatalogItem>>;
  listConnectorProfiles(p?: ConnectorProfileListParams): Promise<Paginated<ConnectorProfile>>;
  createConnectorProfile(body: ConnectorProfileCreateRequest, idempotencyKey: string): Promise<ConnectorProfile>;
  certifyConnectorProfile(profileId: string, body: ConnectorCertificationRequest, idempotencyKey: string): Promise<ConnectorCertification>;
  listIntegrationHandoffs(p?: IntegrationHandoffListParams): Promise<Paginated<IntegrationHandoff>>;
  createIntegrationHandoff(body: IntegrationHandoffCreateRequest, idempotencyKey: string): Promise<IntegrationHandoff>;
  dispatchIntegrationHandoff(handoffId: string, body: IntegrationHandoffDispatchRequest, idempotencyKey: string): Promise<IntegrationHandoffDispatchAttempt>;
  recordIntegrationHandoffCallback(handoffId: string, body: IntegrationHandoffCallbackRequest): Promise<IntegrationHandoff>;
  listDocumentJobs(p?: DocumentJobListParams): Promise<Paginated<DocumentJobItem>>;
  createDocumentJob(body: DocumentJobCreateBody, idempotencyKey: string): Promise<DocumentJobItem>;
  getDocumentJob(jobId: string): Promise<DocumentJobItem>;
  extractDocumentJob(jobId: string, idempotencyKey: string): Promise<DocumentExtraction>;
  recordExternalDocumentExtraction(jobId: string, body: ExternalDocumentExtractionBody, idempotencyKey: string): Promise<DocumentExtraction>;
  getDocumentExtraction(jobId: string): Promise<DocumentExtraction>;
  createDocumentValidationTask(jobId: string, idempotencyKey: string): Promise<DocumentValidationTaskResult>;
  createAutomationIdea(body: AutomationIdeaCreateBody, idempotencyKey: string): Promise<AutomationIdeaItem>;
  getAutomationIdea(ideaId: string): Promise<AutomationIdeaItem>;
  updateAutomationIdea(ideaId: string, body: AutomationIdeaUpdateBody, idempotencyKey: string): Promise<AutomationIdeaItem>;
  transitionAutomationIdea(ideaId: string, stage: AutomationIdeaStage, idempotencyKey: string): Promise<AutomationIdeaItem>;
  upsertRoiEstimate(ideaId: string, body: RoiEstimateRequest, idempotencyKey: string): Promise<RoiEstimate>;
  getRoiEstimate(ideaId: string): Promise<RoiEstimate>;
  listAutomationAdoptionEvidence(ideaId: string, p?: AutomationAdoptionEvidenceListParams): Promise<AutomationAdoptionEvidencePage>;
  recordAutomationAdoptionEvidence(
    ideaId: string,
    body: AutomationAdoptionEvidenceRequest,
    idempotencyKey: string,
  ): Promise<AutomationAdoptionEvidenceItem>;
  listRoiActualEvidence(ideaId: string, p?: ListParams): Promise<Paginated<RoiActualEvidence>>;
  recordRoiActualEvidence(ideaId: string, body: RoiActualEvidenceRequest, idempotencyKey: string): Promise<RoiActualEvidence>;
  getRoiActualSuggestion(ideaId: string, p: { period_start: string; period_end: string }): Promise<RoiActualSuggestion>;
  listGatewayPolicies(): Promise<Paginated<GatewayPolicy>>;
  getGatewayPolicy(model?: string): Promise<GatewayPolicy>;
  // LLM 호출 사용량/비용 집계(분석; GET /v1/gateway/call-summary). days=윈도우(기본 30).
  getGatewayCallSummary(days?: number): Promise<GatewayCallSummary>;
  createGatewayPolicy(body: GatewayPolicyUpdate, idempotencyKey: string): Promise<GatewayPolicy>;
  // admin gateway policy 갱신: PUT If-Match(현재 version) + Idempotency-Key + body. 충돌→POLICY_VERSION_CONFLICT(412),
  // 예산>컨텍스트→LLM_CAPABILITY_MISMATCH(422), 권한 없음→AUTHZ_FORBIDDEN(403) 표면화.
  updateGatewayPolicy(version: number, body: GatewayPolicyUpdate, idempotencyKey: string): Promise<unknown>;
  deleteGatewayPolicy(model: string, version: number, idempotencyKey: string): Promise<unknown>;
  // 담당자 디렉터리 수동 등록/수정/삭제(admin=principal.manage, api-surface §3). 중복 sub→422, 미존재→404.
  createPrincipal(body: { sub: string; display_name: string; email?: string | null }, idempotencyKey: string): Promise<PrincipalItem>;
  updatePrincipal(principalId: string, body: { display_name?: string; email?: string | null }, idempotencyKey: string): Promise<PrincipalItem>;
  deletePrincipal(principalId: string, idempotencyKey: string): Promise<unknown>;
  listScimProviders(): Promise<Paginated<ScimProviderItem>>;
  createScimProvider(
    body: ScimProviderCreateBody,
    idempotencyKey: string,
  ): Promise<ScimProviderItem>;
  updateScimProvider(
    providerKey: string,
    body: ScimProviderUpdateBody,
    idempotencyKey: string,
  ): Promise<ScimProviderItem>;
  decommissionScimProvider(
    providerKey: string,
    body: ScimProviderDecommissionBody,
    idempotencyKey: string,
  ): Promise<ScimProviderDecommissionResult>;
  listScimGroupRoleMappings(providerKey: string): Promise<Paginated<ScimGroupRoleMappingItem>>;
  importScimGroupRoleMappings(
    providerKey: string,
    body: ScimGroupRoleMappingImportBody,
    idempotencyKey: string,
  ): Promise<ScimGroupRoleMappingImportResult>;
  createScimGroupRoleMapping(
    providerKey: string,
    body: { external_group: string; role: string; description?: string | null },
    idempotencyKey: string,
  ): Promise<ScimGroupRoleMappingItem>;
  updateScimGroupRoleMapping(
    providerKey: string,
    mappingId: string,
    body: { role?: string; status?: "active" | "disabled"; description?: string | null },
    idempotencyKey: string,
  ): Promise<ScimGroupRoleMappingItem>;
  listPrincipalRoleAssignments(principalId: string, p?: ListParams): Promise<Paginated<RoleAssignmentItem>>;
  listRoleAssignments(p?: ListParams & { principal_sub?: string; role?: string; status?: string }): Promise<Paginated<RoleAssignmentItem>>;
  grantPrincipalRole(
    principalId: string,
    body: { role: string; reason?: string | null; expires_at?: string | null },
    idempotencyKey: string,
  ): Promise<RoleAssignmentItem>;
  revokeRoleAssignment(assignmentId: string, reason: string, idempotencyKey: string): Promise<RoleAssignmentItem>;
  listConcurrencyPolicies(): Promise<Paginated<ConcurrencyPolicy>>;
  // DG-4: 자격증명 *참조*(SecretRef 경로) 등록/삭제. ⛔ 시크릿 값은 보내지 않는다(경로 식별자 + 한도만). credential.manage(admin).
  registerCredentialBinding(body: CredentialBindingRequest, idempotencyKey: string): Promise<CredentialBindingResult>;
  rotateCredentialBinding(body: CredentialRotateRequest, idempotencyKey: string): Promise<CredentialRotateResult>;
  decommissionCredentialBinding(
    body: CredentialDecommissionRequest,
    idempotencyKey: string,
  ): Promise<CredentialDecommissionResult>;
  deleteCredentialBinding(credentialRef: string, siteProfileId: string, idempotencyKey: string): Promise<unknown>;
  // DG-3 전용 워커 풀(admin worker_pool.manage): 풀 레지스트리 + 호출 테넌트 배정 관리.
  listWorkerPools(): Promise<WorkerPoolList>;
  createWorkerPool(body: { pool_key: string; description?: string; max_concurrency?: number; priority?: string }, idempotencyKey: string): Promise<unknown>;
  updateWorkerPool(poolKey: string, body: WorkerPoolMutationBody, idempotencyKey: string): Promise<unknown>;
  deleteWorkerPool(poolKey: string, idempotencyKey: string): Promise<unknown>;
  assignWorkerToPool(poolKey: string, workerId: string, idempotencyKey: string): Promise<unknown>;
  removeWorkerFromPool(poolKey: string, workerId: string, idempotencyKey: string): Promise<unknown>;
  assignWorkerPool(poolKey: string, idempotencyKey: string): Promise<unknown>;
  unassignWorkerPool(idempotencyKey: string): Promise<unknown>;
}
