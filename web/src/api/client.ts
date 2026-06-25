// 주입형 ApiClient 포트 + HTTP 구현. 테스트는 동일 인터페이스의 fake를 주입(백엔드 무의존).
import {
  ApiError,
  type BrowserRecordingAppendEventsBody,
  type BrowserRecordingAppendResult,
  type BrowserRecordingEvent,
  type BrowserRecordingListParams,
  type BrowserRecordingSession,
  type BrowserRecordingStartBody,
  type BotPoolItem,
  type AuditLogItem,
  type AuditLogExportParams,
  type AuditLogListParams,
  type AuthReadiness,
  type AutomationIdeaCreateBody,
  type AutomationIdeaItem,
  type AutomationIdeaListParams,
  type AutomationIdeaStage,
  type AutomationIdeaUpdateBody,
  type ArtifactDetail,
  type CaptureSessionItem,
  type ConnectorCatalogItem,
  type ConnectorCatalogListParams,
  type CreateRunBody,
  type CreateRunResult,
  type DecideApprovalBody,
  type DecideApprovalResult,
  type DeadLetterItem,
  type ReplayAllDlqResult,
  type DocumentExtraction,
  type DocumentJobCreateBody,
  type DocumentJobItem,
  type DocumentJobListParams,
  type DocumentValidationTaskResult,
  type GatewayCallSummary,
  type GatewayPolicy,
  type GatewayPolicyUpdate,
  type GenerationArtifactDetail,
  type GenerationArtifactItem,
  type HumanTaskItem,
  type HumanTaskResolution,
  type ListParams,
  type OpsAlertItem,
  type OpsAlertListParams,
  type OpsHealth,
  type Paginated,
  type PromoteFromRunResult,
  type PrincipalItem,
  type RoiEstimate,
  type RoiEstimateRequest,
  type RunDetail,
  type RunTriggerCreateBody,
  type RunTriggerFireItem,
  type RunTriggerItem,
  type RunTriggerUpdateBody,
  type RunItem,
  type RunSummary,
  type RunTrends,
  type ScenarioDetail,
  type ScenarioGenerationList,
  type ScenarioGenerationListParams,
  type ScenarioGenerationCapabilities,
  type ScenarioGenerationRequest,
  type ScenarioGenerationRunRequest,
  type ScenarioGenerationResult,
  type ScenarioItem,
  type PromotionRequest,
  type ConcurrencyPolicy,
  type CredentialBindingRequest,
  type CredentialBindingResult,
  type RunArtifactItem,
  type ScenarioMutationResult,
  type ScenarioVersionItem,
  type SiteCreateResult,
  type SiteElementCreateBody,
  type SiteElementDeleteResult,
  type SiteElementItem,
  type SiteElementListParams,
  type SiteElementProbeRequest,
  type SiteElementProbeResponse,
  type SiteElementUpdateBody,
  type SiteItem,
  type SitePageStateUpdateResult,
  type StepSummary,
  type TemplateCatalogItem,
  type TemplateCatalogListParams,
  type ValidationResult,
  type WorkitemItem,
} from "./types";

export interface ApiClient {
  listRuns(p?: ListParams): Promise<Paginated<RunItem>>;
  // run 하위 단계 트레이스(api-surface §1). 비민감 요약+참조만(본문은 artifact_ids→getArtifact).
  listRunSteps(runId: string, p?: ListParams): Promise<Paginated<StepSummary>>;
  watchRunSteps(runId: string, onChange: (event: RunStepStreamEvent) => void): () => void;
  // run 하위 artifact 목록(api-surface §5). metadata-only(본문은 artifact_id→getArtifact).
  listRunArtifacts(runId: string, p?: ListParams): Promise<Paginated<RunArtifactItem>>;
  listScenarioGenerationArtifacts(generationId: string, p?: ListParams): Promise<Paginated<GenerationArtifactItem>>;
  listScenarioGenerationResultArtifacts(generationId: string, p?: ListParams): Promise<Paginated<GenerationArtifactItem>>;
  listWorkitems(p?: ListParams): Promise<Paginated<WorkitemItem>>;
  listHumanTasks(p?: ListParams): Promise<Paginated<HumanTaskItem>>;
  listPrincipals(p?: ListParams): Promise<Paginated<PrincipalItem>>;
  listDlq(kind: "workitem" | "sink", p?: ListParams): Promise<Paginated<DeadLetterItem>>;
  listScenarios(p?: ListParams): Promise<Paginated<ScenarioItem>>;
  listRunTriggers(p?: ListParams): Promise<Paginated<RunTriggerItem>>;
  getRunTrigger(triggerId: string): Promise<RunTriggerItem>;
  createRunTrigger(body: RunTriggerCreateBody, idempotencyKey: string): Promise<RunTriggerItem>;
  updateRunTrigger(triggerId: string, body: RunTriggerUpdateBody, idempotencyKey: string): Promise<RunTriggerItem>;
  pauseRunTrigger(triggerId: string, idempotencyKey: string): Promise<RunTriggerItem>;
  resumeRunTrigger(triggerId: string, idempotencyKey: string): Promise<RunTriggerItem>;
  listRunTriggerFires(triggerId: string, p?: ListParams): Promise<Paginated<RunTriggerFireItem>>;
  listOpsAlerts(p?: OpsAlertListParams): Promise<Paginated<OpsAlertItem>>;
  getOpsHealth(): Promise<OpsHealth>;
  listBotPools(p?: ListParams): Promise<Paginated<BotPoolItem>>;
  listAutomationIdeas(p?: AutomationIdeaListParams): Promise<Paginated<AutomationIdeaItem>>;
  listAuditLog(p?: AuditLogListParams): Promise<Paginated<AuditLogItem>>;
  exportAuditLogCsv(p?: AuditLogExportParams): Promise<string>;
  getAuthReadiness(): Promise<AuthReadiness>;
  listConnectors(p?: ConnectorCatalogListParams): Promise<Paginated<ConnectorCatalogItem>>;
  listTemplates(p?: TemplateCatalogListParams): Promise<Paginated<TemplateCatalogItem>>;
  listDocumentJobs(p?: DocumentJobListParams): Promise<Paginated<DocumentJobItem>>;
  createDocumentJob(body: DocumentJobCreateBody, idempotencyKey: string): Promise<DocumentJobItem>;
  getDocumentJob(jobId: string): Promise<DocumentJobItem>;
  extractDocumentJob(jobId: string, idempotencyKey: string): Promise<DocumentExtraction>;
  getDocumentExtraction(jobId: string): Promise<DocumentExtraction>;
  createDocumentValidationTask(jobId: string, idempotencyKey: string): Promise<DocumentValidationTaskResult>;
  createAutomationIdea(body: AutomationIdeaCreateBody, idempotencyKey: string): Promise<AutomationIdeaItem>;
  getAutomationIdea(ideaId: string): Promise<AutomationIdeaItem>;
  updateAutomationIdea(ideaId: string, body: AutomationIdeaUpdateBody, idempotencyKey: string): Promise<AutomationIdeaItem>;
  transitionAutomationIdea(ideaId: string, stage: AutomationIdeaStage, idempotencyKey: string): Promise<AutomationIdeaItem>;
  upsertRoiEstimate(ideaId: string, body: RoiEstimateRequest, idempotencyKey: string): Promise<RoiEstimate>;
  getRoiEstimate(ideaId: string): Promise<RoiEstimate>;
  listSites(p?: ListParams): Promise<Paginated<SiteItem>>;
  listSiteElements(siteId: string, p?: SiteElementListParams): Promise<Paginated<SiteElementItem>>;
  createSiteElement(siteId: string, body: SiteElementCreateBody, idempotencyKey: string): Promise<SiteElementItem>;
  updateSiteElement(siteId: string, elementId: string, body: SiteElementUpdateBody, idempotencyKey: string): Promise<SiteElementItem>;
  probeSiteElement(siteId: string, elementId: string, body: SiteElementProbeRequest, idempotencyKey: string): Promise<SiteElementProbeResponse>;
  deleteSiteElement(siteId: string, elementId: string, idempotencyKey: string): Promise<SiteElementDeleteResult>;
  listBrowserRecordings(siteId: string, p?: BrowserRecordingListParams): Promise<Paginated<BrowserRecordingSession>>;
  startBrowserRecording(siteId: string, body: BrowserRecordingStartBody, idempotencyKey: string): Promise<BrowserRecordingSession>;
  listBrowserRecordingEvents(siteId: string, recordingId: string, p?: ListParams): Promise<Paginated<BrowserRecordingEvent>>;
  appendBrowserRecordingEvents(
    siteId: string,
    recordingId: string,
    body: BrowserRecordingAppendEventsBody,
    idempotencyKey: string,
  ): Promise<BrowserRecordingAppendResult>;
  completeBrowserRecording(siteId: string, recordingId: string, idempotencyKey: string): Promise<BrowserRecordingSession>;
  listSessionCaptures(siteId: string): Promise<Paginated<CaptureSessionItem>>;
  listGatewayPolicies(): Promise<Paginated<GatewayPolicy>>;
  getGatewayPolicy(model?: string): Promise<GatewayPolicy>;
  // LLM 호출 사용량/비용 집계(분석; GET /v1/gateway/call-summary). days=윈도우(기본 30).
  getGatewayCallSummary(days?: number): Promise<GatewayCallSummary>;
  createGatewayPolicy(body: GatewayPolicyUpdate, idempotencyKey: string): Promise<GatewayPolicy>;
  // admin gateway policy 갱신: PUT If-Match(현재 version) + Idempotency-Key + body. 충돌→POLICY_VERSION_CONFLICT(412),
  // 예산>컨텍스트→LLM_CAPABILITY_MISMATCH(422), 권한 없음→AUTHZ_FORBIDDEN(403) 표면화.
  updateGatewayPolicy(version: number, body: GatewayPolicyUpdate, idempotencyKey: string): Promise<unknown>;
  deleteGatewayPolicy(model: string, version: number, idempotencyKey: string): Promise<unknown>;
  // 운영자 명령(POST + Idempotency-Key). 어휘체인 abort→cancelled, W10 replay.
  abortRun(runId: string, idempotencyKey: string): Promise<unknown>;
  // DLQ 재처리(W10). kind로 workitem/sink 분기(백엔드 `?kind=` — sink는 별도 OperationId 멱등 네임스페이스).
  replayDeadLetter(deadLetterId: string, idempotencyKey: string, kind: "workitem" | "sink"): Promise<unknown>;
  // DLQ 전체 일괄 재처리(현재 페이지 한도 없이 적격 전체, 캡 500; api-surface §4). 자연 멱등이라 Idempotency-Key 불요(헤더는 무해).
  replayAllDlq(kind: "workitem" | "sink", idempotencyKey: string): Promise<ReplayAllDlqResult>;
  // 사이트 risk 승인(approver). Idempotency-Key + body{reason?,expires_at?} → approval_status=approved.
  approveSite(siteId: string, idempotencyKey: string, opts?: { reason?: string; expires_at?: string }): Promise<unknown>;
  // 사이트 신규 등록(operator+, api-surface §7 POST /v1/sites). Idempotency-Key + body. url_pattern은 http(s) origin.
  createSite(body: { name: string; url_pattern: string; risk?: string; page_state_selectors?: unknown }, idempotencyKey: string): Promise<SiteCreateResult>;
  // 사이트 이름 수정(operator+, api-surface §7 PATCH /v1/sites/{id}). Idempotency-Key + body{name}. 중복 name→422.
  updateSite(siteId: string, name: string, idempotencyKey: string): Promise<unknown>;
  updateSitePageState(siteId: string, pageStateSelectors: unknown | null, idempotencyKey: string): Promise<SitePageStateUpdateResult>;
  // 담당자 디렉터리 수동 등록/수정/삭제(admin=principal.manage, api-surface §3). 중복 sub→422, 미존재→404.
  createPrincipal(body: { sub: string; display_name: string; email?: string | null }, idempotencyKey: string): Promise<PrincipalItem>;
  updatePrincipal(principalId: string, body: { display_name?: string; email?: string | null }, idempotencyKey: string): Promise<PrincipalItem>;
  deletePrincipal(principalId: string, idempotencyKey: string): Promise<unknown>;
  // 운영자-보조 세션 등록(operator+, POST /v1/sites/{id}/session/capture). headful 로그인창을 띄워 운영자가 직접 로그인 → 세션 저장.
  // login_url 은 사이트 설정(page_state_selectors.loginUrl)에서 해소 — 사이트별 로그인 URL.
  captureSession(siteId: string, idempotencyKey: string): Promise<unknown>;
  // human-task 전이(api-surface §4 / app human-tasks.ts 실 shape): assign{assignee}·start(무body)·
  // resolve{result?}·escalate{reason?}. 권한/assignee 범위는 백엔드가 강제(거부 시 AUTHZ_FORBIDDEN 표면화).
  assignHumanTask(id: string, assignee: string, idempotencyKey: string): Promise<unknown>;
  startHumanTask(id: string, idempotencyKey: string): Promise<unknown>;
  resolveHumanTask(id: string, idempotencyKey: string, result?: HumanTaskResolution | Record<string, unknown>): Promise<unknown>;
  escalateHumanTask(id: string, idempotencyKey: string, reason?: string): Promise<unknown>;
  // scenario 승격: If-Match(현재 version) + body{target:"prod"} + Idempotency-Key. 충돌→SCENARIO_VERSION_CONFLICT 표면화.
  promoteScenario(scenarioId: string, version: number, idempotencyKey: string): Promise<unknown>;
  promoteScenarioFromRun(scenarioId: string, runId: string, idempotencyKey: string): Promise<PromoteFromRunResult>;
  setScenarioPromotion(scenarioId: string, version: number, target: "prod" | "draft", idempotencyKey: string): Promise<unknown>;
  archiveScenario(scenarioId: string, version: number, idempotencyKey: string): Promise<unknown>;
  createPromotionRequest(scenarioId: string, version: number, reason: string, idempotencyKey: string): Promise<unknown>;
  listPromotionRequests(): Promise<Paginated<PromotionRequest>>;
  decidePromotionRequest(scenarioId: string, requestId: string, decision: "approve" | "reject", reason: string | undefined, idempotencyKey: string): Promise<unknown>;
  listConcurrencyPolicies(): Promise<Paginated<ConcurrencyPolicy>>;
  // DG-4: 자격증명 *참조*(SecretRef 경로) 등록/삭제. ⛔ 시크릿 값은 보내지 않는다(경로 식별자 + 한도만). credential.manage(admin).
  registerCredentialBinding(body: CredentialBindingRequest, idempotencyKey: string): Promise<CredentialBindingResult>;
  deleteCredentialBinding(credentialRef: string, siteProfileId: string, idempotencyKey: string): Promise<unknown>;
  listScenarioVersions(scenarioId: string): Promise<Paginated<ScenarioVersionItem>>;
  rollbackScenario(scenarioId: string, sourceVersion: number, latestVersion: number, idempotencyKey: string): Promise<ScenarioMutationResult>;
  // 상세 GET-by-id(RLS 스코프, 미존재/타테넌트→404). drill-down 뷰의 선행.
  getRun(runId: string): Promise<RunDetail>;
  // run outcome 집계(관찰성). status별 정확 카운트 + 성공률(api-surface §1 GET /v1/runs/summary).
  getRunSummary(): Promise<RunSummary>;
  // run outcome 일별 추세(분석; api-surface §1 GET /v1/runs/trends). days=조회 윈도우(기본 30, [1,90] 서버 클램프).
  getRunTrends(days?: number): Promise<RunTrends>;
  getWorkitem(id: string): Promise<WorkitemItem>;
  getHumanTask(id: string): Promise<HumanTaskItem>;
  getScenario(id: string): Promise<ScenarioDetail>;
  getSite(id: string): Promise<SiteItem>;
  // 산출물 본문 조회(api-surface §5). redaction→RBAC 2단 게이트 + audit boundary. 미존재/미redacted/타테넌트→404, 권한없음→403.
  getArtifact(id: string): Promise<ArtifactDetail>;
  getArtifactBlob(id: string): Promise<Blob>;
  getScenarioGenerationArtifact(generationId: string, artifactId: string): Promise<GenerationArtifactDetail>;
  // scenario validate(V1–V11 dry-run, 비변이 POST, body=IR). run 생성(멱등 명령).
  validateScenario(scenarioId: string, ir: unknown, idempotencyKey: string): Promise<ValidationResult>;
  // scenario 생성(POST body=IR, 컴파일 파이프라인 통과 시 draft 저장)·편집(PUT If-Match=현재 version → 새 draft version).
  // 둘 다 Idempotency-Key 불요(api-surface §35). 무효 IR/충돌은 ApiError로 표면화.
  createScenario(ir: unknown): Promise<ScenarioMutationResult>;
  updateScenario(scenarioId: string, ir: unknown, version: number): Promise<ScenarioMutationResult>;
  generateScenario(body: ScenarioGenerationRequest, idempotencyKey: string): Promise<ScenarioGenerationResult>;
  runScenarioGeneration(generationId: string, body: ScenarioGenerationRunRequest, idempotencyKey: string): Promise<ScenarioGenerationResult>;
  getScenarioGenerationCapabilities(): Promise<ScenarioGenerationCapabilities>;
  listScenarioGenerations(p?: ScenarioGenerationListParams): Promise<ScenarioGenerationList>;
  getScenarioGeneration(generationId: string): Promise<ScenarioGenerationResult>;
  createRun(body: CreateRunBody, idempotencyKey: string): Promise<CreateRunResult>;
  // 건별 결재(승인/반려, approver+). Idempotency-Key + body{source_run_id, doc_ref, decision, reason?}.
  //   동일 키 replay → 동일 spawned_run_id, 다른 키·동일(run,doc) → APPROVAL_ALREADY_DECIDED(409). 백엔드가 RBAC 최종 강제.
  decideApproval(body: DecideApprovalBody, idempotencyKey: string): Promise<DecideApprovalResult>;
}

export interface HttpApiClientOptions {
  readonly baseUrl: string;
  readonly getToken: () => string | null;
  readonly fetchImpl?: typeof fetch;
}

export interface RunStepStreamEvent {
  readonly run_id: string;
  readonly status: string | null;
  readonly step_count?: number;
  readonly last_step_at?: string | null;
  readonly run_updated_at?: string | null;
}

function parseRunStepStreamFrame(frame: string): RunStepStreamEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split(/\n/)) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  if (event !== "run_steps_changed" && event !== "run_steps_closed") return null;
  try {
    const parsed = JSON.parse(data.join("\n")) as Partial<RunStepStreamEvent>;
    return typeof parsed.run_id === "string"
      ? {
          run_id: parsed.run_id,
          status: typeof parsed.status === "string" ? parsed.status : null,
          step_count: typeof parsed.step_count === "number" ? parsed.step_count : undefined,
          last_step_at: typeof parsed.last_step_at === "string" ? parsed.last_step_at : null,
          run_updated_at: typeof parsed.run_updated_at === "string" ? parsed.run_updated_at : null,
        }
      : null;
  } catch {
    return null;
  }
}

// ETag(약한 접두/따옴표 허용) → version(int). 백엔드 parseIfMatch 규약과 동일. 부재/무효 → undefined(편집 차단).
function parseEtagVersion(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number.parseInt(value.replace(/^W\//, "").replace(/^"|"$/g, ""), 10);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

function queryString(p?: ListParams): string {
  if (p === undefined) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) {
    if (v !== undefined && v !== null) sp.set(k, String(v));
  }
  const s = sp.toString();
  return s.length > 0 ? `?${s}` : "";
}

export function createHttpApiClient(opts: HttpApiClientOptions): ApiClient {
  const doFetch = opts.fetchImpl ?? fetch;

  function authHeaders(): Record<string, string> {
    const token = opts.getToken();
    return token !== null ? { Authorization: `Bearer ${token}` } : {};
  }

  async function parseOrThrow<T>(res: Response): Promise<T> {
    if (!res.ok) {
      // 조용한 실패 금지: 4xx/5xx 본문(ApiError)을 타입화해 표면화.
      let body = null;
      try {
        body = (await res.json()) as { code?: string; message?: string };
      } catch {
        body = null;
      }
      throw new ApiError(res.status, body?.code ?? `HTTP_${res.status}`, body as never);
    }
    return (await res.json()) as T;
  }

  async function parseBlobOrThrow(res: Response): Promise<Blob> {
    if (!res.ok) {
      let body = null;
      try {
        body = (await res.json()) as { code?: string; message?: string };
      } catch {
        body = null;
      }
      throw new ApiError(res.status, body?.code ?? `HTTP_${res.status}`, body as never);
    }
    return res.blob();
  }

  async function parseTextOrThrow(res: Response): Promise<string> {
    if (!res.ok) {
      let body = null;
      try {
        body = (await res.json()) as { code?: string; message?: string };
      } catch {
        body = null;
      }
      throw new ApiError(res.status, body?.code ?? `HTTP_${res.status}`, body as never);
    }
    return res.text();
  }

  async function get<T>(path: string): Promise<T> {
    const res = await doFetch(`${opts.baseUrl}${path}`, {
      method: "GET",
      headers: { Accept: "application/json", ...authHeaders() },
    });
    return parseOrThrow<T>(res);
  }

  async function getText(path: string, accept: string): Promise<string> {
    const res = await doFetch(`${opts.baseUrl}${path}`, {
      method: "GET",
      headers: { Accept: accept, ...authHeaders() },
    });
    return parseTextOrThrow(res);
  }

  // Idempotency-Key 없는 변이(scenario create/update). If-Match 등은 extraHeaders로.
  async function send<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const res = await doFetch(`${opts.baseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(extraHeaders ?? {}),
        ...authHeaders(),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return parseOrThrow<T>(res);
  }

  async function post<T>(
    path: string,
    idempotencyKey: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const res = await doFetch(`${opts.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        ...(extraHeaders ?? {}),
        ...authHeaders(),
      },
      body: JSON.stringify(body ?? {}),
    });
    return parseOrThrow<T>(res);
  }

  function watchRunSteps(runId: string, onChange: (event: RunStepStreamEvent) => void): () => void {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await doFetch(`${opts.baseUrl}/v1/runs/${runId}/steps/stream`, {
          method: "GET",
          headers: { Accept: "text/event-stream", ...authHeaders() },
          signal: controller.signal,
        });
        if (!res.ok || res.body === null) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!controller.signal.aborted) {
          const read = await reader.read();
          if (read.done) break;
          buffer += decoder.decode(read.value, { stream: true });
          const frames = buffer.split(/\n\n/);
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const parsed = parseRunStepStreamFrame(frame);
            if (parsed !== null) onChange(parsed);
          }
        }
        if (buffer.trim().length > 0) {
          const parsed = parseRunStepStreamFrame(buffer);
          if (parsed !== null) onChange(parsed);
        }
      } catch (err) {
        if (!controller.signal.aborted) console.warn("run steps stream failed", err);
      }
    })();
    return () => controller.abort();
  }

  return {
    listRuns: (p) => get(`/v1/runs${queryString(p)}`),
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
    getOpsHealth: () => get(`/v1/ops/health`),
    listBotPools: (p) => get(`/v1/bot-pools${queryString(p)}`),
    listAutomationIdeas: (p) => get(`/v1/automation-ideas${queryString(p)}`),
    listAuditLog: (p) => get(`/v1/audit-log${queryString(p)}`),
    exportAuditLogCsv: (p) => getText(`/v1/audit-log/export${queryString({ ...p, format: "csv" })}`, "text/csv"),
    getAuthReadiness: () => get(`/v1/auth/readiness`),
    listConnectors: (p) => get(`/v1/connectors${queryString(p)}`),
    listTemplates: (p) => get(`/v1/templates${queryString(p)}`),
    listDocumentJobs: (p) => get(`/v1/document-jobs${queryString(p)}`),
    createDocumentJob: (body, key) => post(`/v1/document-jobs`, key, body),
    getDocumentJob: (jobId) => get(`/v1/document-jobs/${jobId}`),
    extractDocumentJob: (jobId, key) => post(`/v1/document-jobs/${jobId}/extract`, key),
    getDocumentExtraction: (jobId) => get(`/v1/document-jobs/${jobId}/extraction`),
    createDocumentValidationTask: (jobId, key) => post(`/v1/document-jobs/${jobId}/validation-task`, key),
    createAutomationIdea: (body, key) => post(`/v1/automation-ideas`, key, body),
    getAutomationIdea: (ideaId) => get(`/v1/automation-ideas/${ideaId}`),
    updateAutomationIdea: (ideaId, body, key) =>
      send("PATCH", `/v1/automation-ideas/${ideaId}`, body, { "Idempotency-Key": key }),
    transitionAutomationIdea: (ideaId, stage, key) => post(`/v1/automation-ideas/${ideaId}/transition`, key, { stage }),
    upsertRoiEstimate: (ideaId, body, key) => post(`/v1/automation-ideas/${ideaId}/roi-estimate`, key, body),
    getRoiEstimate: (ideaId) => get(`/v1/automation-ideas/${ideaId}/roi-estimate`),
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
    replayDeadLetter: (deadLetterId, idempotencyKey, kind) => post(`/v1/dlq/${deadLetterId}/replay${queryString({ kind })}`, idempotencyKey),
    replayAllDlq: (kind, idempotencyKey) => post(`/v1/dlq/replay-all${queryString({ kind })}`, idempotencyKey),
    approveSite: (siteId, key, opts) => post(`/v1/sites/${siteId}/approve`, key, opts ?? {}),
    createSite: (body, key) => post(`/v1/sites`, key, body),
    updateSite: (siteId, name, key) => send("PATCH", `/v1/sites/${siteId}`, { name }, { "Idempotency-Key": key }),
    updateSitePageState: (siteId, pageStateSelectors, key) =>
      send("PATCH", `/v1/sites/${siteId}/page-state`, { page_state_selectors: pageStateSelectors }, { "Idempotency-Key": key }),
    createPrincipal: (body, key) => post(`/v1/principals`, key, body),
    updatePrincipal: (principalId, body, key) => send("PATCH", `/v1/principals/${principalId}`, body, { "Idempotency-Key": key }),
    deletePrincipal: (principalId, key) => send("DELETE", `/v1/principals/${principalId}`, undefined, { "Idempotency-Key": key }),
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
    archiveScenario: (scenarioId, version, key) =>
      post(`/v1/scenarios/${scenarioId}/archive`, key, {}, { "If-Match": String(version) }),
    createPromotionRequest: (scenarioId, version, reason, key) =>
      post(`/v1/scenarios/${scenarioId}/promotion-requests`, key, { version, reason }),
    listPromotionRequests: () => get(`/v1/scenarios/promotion-requests`),
    listConcurrencyPolicies: () => get(`/v1/credentials/concurrency`),
    registerCredentialBinding: (body, key) => post(`/v1/credentials`, key, body),
    deleteCredentialBinding: (credentialRef, siteProfileId, key) =>
      send("DELETE", `/v1/credentials${queryString({ credential_ref: credentialRef, site_profile_id: siteProfileId })}`, undefined, {
        "Idempotency-Key": key,
      }),
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
    getRunSummary: () => get<RunSummary>("/v1/runs/summary"),
    getRunTrends: (days) => get<RunTrends>(`/v1/runs/trends${days !== undefined ? `?days=${days}` : ""}`),
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
    getScenarioGenerationCapabilities: () => get(`/v1/scenario-generations/capabilities`),
    listScenarioGenerations: (p) => get(`/v1/scenario-generations${queryString(p)}`),
    getScenarioGeneration: (generationId) => get(`/v1/scenario-generations/${generationId}`),
    createRun: (body, key) => post(`/v1/runs`, key, body),
    decideApproval: (body, key) => post(`/v1/approvals/decide`, key, body),
  };
}
