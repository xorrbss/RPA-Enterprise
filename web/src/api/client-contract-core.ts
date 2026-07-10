import type {
  ArtifactDetail,
  BrowserRecordingAppendEventsBody,
  BrowserRecordingAppendResult,
  BrowserRecordingEvent,
  BrowserRecordingListParams,
  BrowserRecordingSession,
  BrowserRecordingStartBody,
  CaptureSessionItem,
  CreateRunBody,
  CreateRunResult,
  DeadLetterItem,
  DecideApprovalBody,
  DecideApprovalResult,
  FanOutApprovalsResult,
  GenerationArtifactDetail,
  GenerationArtifactItem,
  GlobalSearchResult,
  HumanTaskItem,
  HumanTaskResolution,
  ListParams,
  Paginated,
  PrioritizeRunBody,
  PrioritizeRunResult,
  PromoteFromRunResult,
  PromoteRecordingToStudioResult,
  PromotionRequest,
  ReplayAllDlqResult,
  RerunRunBody,
  RerunRunResult,
  ResumeRunResult,
  RunArtifactItem,
  RunDetail,
  RunItem,
  RunMode,
  RunResumeRequest,
  RunResumeRequestListParams,
  RunSummary,
  RunTrends,
  RunTriggerCreateBody,
  RunTriggerFireItem,
  RunTriggerItem,
  RunTriggerUpdateBody,
  ScenarioDetail,
  ScenarioEnvironmentBinding,
  ScenarioGenerationCapabilities,
  ScenarioGenerationList,
  ScenarioGenerationListParams,
  ScenarioGenerationRequest,
  ScenarioGenerationResult,
  ScenarioGenerationReviseRequest,
  ScenarioGenerationRunRequest,
  ScenarioItem,
  ScenarioMutationResult,
  ScenarioReleaseItem,
  ScenarioReleaseTarget,
  ScenarioVersionGovernanceStageBody,
  ScenarioVersionItem,
  SiteApprovalItem,
  SiteCreateResult,
  SiteElementCreateBody,
  SiteElementDeleteResult,
  SiteElementItem,
  SiteElementListParams,
  SiteElementProbeRequest,
  SiteElementProbeResponse,
  SiteElementUpdateBody,
  SiteItem,
  SitePageStateUpdateResult,
  StepSummary,
  ValidationResult,
  WebAttendedRunRequest,
  WebAttendedRunRequestCreate,
  WebAttendedRunRequestListParams,
  WorkitemItem,
} from "./types";
import type { RunStepStreamEvent } from "./client-http";

export interface ApiClientCore {
  listRuns(p?: ListParams): Promise<Paginated<RunItem>>;
  search(query: string, limit?: number): Promise<GlobalSearchResult>;
  // run 하위 단계 트레이스(api-surface §1). 비민감 요약+참조만(본문은 artifact_ids→getArtifact).
  listRunSteps(runId: string, p?: ListParams): Promise<Paginated<StepSummary>>;
  watchRunSteps(runId: string, onChange: (event: RunStepStreamEvent) => void): () => void;
  // run 하위 artifact 목록(api-surface §5). metadata-only(본문은 artifact_id→getArtifact).
  listRunArtifacts(runId: string, p?: ListParams): Promise<Paginated<RunArtifactItem>>;
  listScenarioGenerationArtifacts(generationId: string, p?: ListParams): Promise<Paginated<GenerationArtifactItem>>;
  listScenarioGenerationResultArtifacts(generationId: string, p?: ListParams): Promise<Paginated<GenerationArtifactItem>>;
  listWorkitems(p?: ListParams): Promise<Paginated<WorkitemItem>>;
  listHumanTasks(p?: ListParams): Promise<Paginated<HumanTaskItem>>;
  listDlq(kind: "workitem" | "sink", p?: ListParams): Promise<Paginated<DeadLetterItem>>;
  listScenarios(p?: ListParams): Promise<Paginated<ScenarioItem>>;
  listRunTriggers(p?: ListParams): Promise<Paginated<RunTriggerItem>>;
  getRunTrigger(triggerId: string): Promise<RunTriggerItem>;
  createRunTrigger(body: RunTriggerCreateBody, idempotencyKey: string): Promise<RunTriggerItem>;
  updateRunTrigger(triggerId: string, body: RunTriggerUpdateBody, idempotencyKey: string): Promise<RunTriggerItem>;
  pauseRunTrigger(triggerId: string, idempotencyKey: string): Promise<RunTriggerItem>;
  resumeRunTrigger(triggerId: string, idempotencyKey: string): Promise<RunTriggerItem>;
  listRunTriggerFires(triggerId: string, p?: ListParams): Promise<Paginated<RunTriggerFireItem>>;
  listRunResumeRequests(p?: RunResumeRequestListParams): Promise<Paginated<RunResumeRequest>>;
  listWebAttendedRunRequests(p?: WebAttendedRunRequestListParams): Promise<Paginated<WebAttendedRunRequest>>;
  createWebAttendedRunRequest(body: WebAttendedRunRequestCreate, idempotencyKey: string): Promise<WebAttendedRunRequest>;
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
  promoteRecordingToStudio(siteId: string, recordingId: string, idempotencyKey: string): Promise<PromoteRecordingToStudioResult>;
  listSessionCaptures(siteId: string): Promise<Paginated<CaptureSessionItem>>;
  // 운영자 명령(POST + Idempotency-Key). 어휘체인 abort→cancelled, W10 replay.
  abortRun(runId: string, idempotencyKey: string): Promise<unknown>;
  pauseRun(runId: string, idempotencyKey: string, reason?: string | null): Promise<unknown>;
  rerunRun(runId: string, body: RerunRunBody, idempotencyKey: string): Promise<RerunRunResult>;
  resumeRun(runId: string, idempotencyKey: string, reason?: string | null): Promise<ResumeRunResult>;
  prioritizeRun(runId: string, body: PrioritizeRunBody, idempotencyKey: string): Promise<PrioritizeRunResult>;
  // DLQ 재처리(W10). kind로 workitem/sink 분기(백엔드 `?kind=` — sink는 별도 OperationId 멱등 네임스페이스).
  replayDeadLetter(deadLetterId: string, idempotencyKey: string, kind: "workitem" | "sink"): Promise<unknown>;
  // DLQ 전체 일괄 재처리(현재 페이지 한도 없이 적격 전체, 캡 500; api-surface §4). 자연 멱등이라 Idempotency-Key 불요(헤더는 무해).
  replayAllDlq(kind: "workitem" | "sink", idempotencyKey: string): Promise<ReplayAllDlqResult>;
  // 사이트 risk 승인(approver). Idempotency-Key + body{reason?,expires_at?} → approval_status=approved.
  approveSite(siteId: string, idempotencyKey: string, opts?: { reason?: string; expires_at?: string }): Promise<unknown>;
  // 사이트 승인 이력(site.read, api-surface §6) — 누가/언제/왜/만료. 최신순 최대 20건.
  listSiteApprovals(siteId: string): Promise<Paginated<SiteApprovalItem>>;
  // 사이트 신규 등록(operator+, api-surface §7 POST /v1/sites). Idempotency-Key + body. url_pattern은 http(s) origin.
  createSite(body: { name: string; url_pattern: string; risk?: string; page_state_selectors?: unknown }, idempotencyKey: string): Promise<SiteCreateResult>;
  // 사이트 이름 수정(operator+, api-surface §7 PATCH /v1/sites/{id}). Idempotency-Key + body{name}. 중복 name→422.
  updateSite(siteId: string, name: string, idempotencyKey: string): Promise<unknown>;
  updateSitePageState(siteId: string, pageStateSelectors: unknown | null, idempotencyKey: string): Promise<SitePageStateUpdateResult>;
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
  listScenarioEnvironmentBindings(scenarioId: string): Promise<Paginated<ScenarioEnvironmentBinding>>;
  listScenarioReleases(scenarioId: string, p?: ListParams): Promise<Paginated<ScenarioReleaseItem>>;
  createScenarioRelease(
    scenarioId: string,
    body: { source_version: number; target_environment: ScenarioReleaseTarget; reason?: string | null },
    idempotencyKey: string,
  ): Promise<ScenarioReleaseItem>;
  getScenarioRelease(releaseId: string): Promise<ScenarioReleaseItem>;
  submitScenarioRelease(releaseId: string, idempotencyKey: string): Promise<ScenarioReleaseItem>;
  approveScenarioRelease(releaseId: string, reason: string | null, idempotencyKey: string): Promise<ScenarioReleaseItem>;
  rejectScenarioRelease(releaseId: string, reason: string, idempotencyKey: string): Promise<ScenarioReleaseItem>;
  deployScenarioRelease(releaseId: string, latestVersion: number, idempotencyKey: string): Promise<ScenarioReleaseItem>;
  rollbackScenarioRelease(releaseId: string, latestVersion: number, idempotencyKey: string): Promise<ScenarioReleaseItem>;
  certifyScenarioVersion(scenarioId: string, version: number, reason: string, expiresAt: string | null, idempotencyKey: string): Promise<ScenarioVersionItem>;
  revokeScenarioCertification(scenarioId: string, version: number, reason: string, idempotencyKey: string): Promise<ScenarioVersionItem>;
  setScenarioVersionGovernanceStage(
    scenarioId: string,
    version: number,
    body: ScenarioVersionGovernanceStageBody,
    idempotencyKey: string,
  ): Promise<ScenarioVersionItem>;
  archiveScenario(scenarioId: string, version: number, idempotencyKey: string): Promise<unknown>;
  createPromotionRequest(scenarioId: string, version: number, reason: string, idempotencyKey: string): Promise<unknown>;
  listPromotionRequests(): Promise<Paginated<PromotionRequest>>;
  decidePromotionRequest(scenarioId: string, requestId: string, decision: "approve" | "reject", reason: string | undefined, idempotencyKey: string): Promise<unknown>;
  listScenarioVersions(scenarioId: string): Promise<Paginated<ScenarioVersionItem>>;
  rollbackScenario(scenarioId: string, sourceVersion: number, latestVersion: number, idempotencyKey: string): Promise<ScenarioMutationResult>;
  // 상세 GET-by-id(RLS 스코프, 미존재/타테넌트→404). drill-down 뷰의 선행.
  getRun(runId: string): Promise<RunDetail>;
  // run outcome 집계(관찰성). status별 정확 카운트 + 성공률(api-surface §1 GET /v1/runs/summary).
  // runMode 지정 시 해당 실행 구분만 집계 — 대시보드 카드와 드릴다운 목록의 모집단 통일.
  getRunSummary(runMode?: RunMode): Promise<RunSummary>;
  // run outcome 일별 추세(분석; api-surface §1 GET /v1/runs/trends). days=조회 윈도우(기본 30, [1,90] 서버 클램프).
  getRunTrends(days?: number, runMode?: RunMode): Promise<RunTrends>;
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
  // F2: 말로 고치기 — 서버측 합성 재생성(api-surface §2.5 revise, Idempotency-Key 필수).
  //   412 SCENARIO_VERSION_CONFLICT(base_version_mismatch/concurrent_version_insert) / 422 IR_SCHEMA_INVALID
  //   + details.reason(instruction_required·instruction_too_long·prompt_too_long·prompt_not_retained·
  //   scenario_not_persisted)은 ApiError로 표면화.
  reviseScenarioGeneration(generationId: string, body: ScenarioGenerationReviseRequest, idempotencyKey: string): Promise<ScenarioGenerationResult>;
  getScenarioGenerationCapabilities(): Promise<ScenarioGenerationCapabilities>;
  listScenarioGenerations(p?: ScenarioGenerationListParams): Promise<ScenarioGenerationList>;
  getScenarioGeneration(generationId: string): Promise<ScenarioGenerationResult>;
  createRun(body: CreateRunBody, idempotencyKey: string): Promise<CreateRunResult>;
  // 건별 결재(승인/반려, approver+). Idempotency-Key + body{source_run_id, doc_ref, decision, reason?}.
  //   동일 키 replay → 동일 spawned_run_id, 다른 키·동일(run,doc) → APPROVAL_ALREADY_DECIDED(409). 백엔드가 RBAC 최종 강제.
  decideApproval(body: DecideApprovalBody, idempotencyKey: string): Promise<DecideApprovalResult>;
  // 수집 목록 fan-out — 각 행을 검토 run(@human_task)으로 일괄 스폰(approver+). Idempotency-Key + body{source_run_id}.
  //   행별 claim 으로 중복 스폰 차단(재호출 시 already_fanned_out 스킵). 검토 run 은 범용 '사람 확인' 인박스에서 사람 판정 대기.
  fanOutApprovals(sourceRunId: string, idempotencyKey: string, enableAuto?: boolean): Promise<FanOutApprovalsResult>;
}
