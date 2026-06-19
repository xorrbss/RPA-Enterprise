// 주입형 ApiClient 포트 + HTTP 구현. 테스트는 동일 인터페이스의 fake를 주입(백엔드 무의존).
import {
  ApiError,
  type ArtifactDetail,
  type CreateRunBody,
  type CreateRunResult,
  type DecideApprovalBody,
  type DecideApprovalResult,
  type DeadLetterItem,
  type GatewayPolicy,
  type GatewayPolicyUpdate,
  type GenerationArtifactDetail,
  type GenerationArtifactItem,
  type HumanTaskItem,
  type ListParams,
  type Paginated,
  type RunDetail,
  type RunItem,
  type ScenarioDetail,
  type ScenarioGenerationList,
  type ScenarioGenerationListParams,
  type ScenarioGenerationCapabilities,
  type ScenarioGenerationRequest,
  type ScenarioGenerationRunRequest,
  type ScenarioGenerationResult,
  type ScenarioItem,
  type RunArtifactItem,
  type ScenarioMutationResult,
  type ScenarioVersionItem,
  type SiteItem,
  type StepSummary,
  type ValidationResult,
  type WorkitemItem,
} from "./types";

export interface ApiClient {
  listRuns(p?: ListParams): Promise<Paginated<RunItem>>;
  // run 하위 단계 트레이스(api-surface §1). 비민감 요약+참조만(본문은 artifact_ids→getArtifact).
  listRunSteps(runId: string, p?: ListParams): Promise<Paginated<StepSummary>>;
  // run 하위 artifact 목록(api-surface §5). metadata-only(본문은 artifact_id→getArtifact).
  listRunArtifacts(runId: string, p?: ListParams): Promise<Paginated<RunArtifactItem>>;
  listScenarioGenerationArtifacts(generationId: string, p?: ListParams): Promise<Paginated<GenerationArtifactItem>>;
  listWorkitems(p?: ListParams): Promise<Paginated<WorkitemItem>>;
  listHumanTasks(p?: ListParams): Promise<Paginated<HumanTaskItem>>;
  listDlq(kind: "workitem" | "sink", p?: ListParams): Promise<Paginated<DeadLetterItem>>;
  listScenarios(p?: ListParams): Promise<Paginated<ScenarioItem>>;
  listSites(p?: ListParams): Promise<Paginated<SiteItem>>;
  listGatewayPolicies(): Promise<Paginated<GatewayPolicy>>;
  getGatewayPolicy(model?: string): Promise<GatewayPolicy>;
  createGatewayPolicy(body: GatewayPolicyUpdate, idempotencyKey: string): Promise<GatewayPolicy>;
  // admin gateway policy 갱신: PUT If-Match(현재 version) + Idempotency-Key + body. 충돌→POLICY_VERSION_CONFLICT(412),
  // 예산>컨텍스트→LLM_CAPABILITY_MISMATCH(422), 권한 없음→AUTHZ_FORBIDDEN(403) 표면화.
  updateGatewayPolicy(version: number, body: GatewayPolicyUpdate, idempotencyKey: string): Promise<unknown>;
  deleteGatewayPolicy(model: string, version: number, idempotencyKey: string): Promise<unknown>;
  // 운영자 명령(POST + Idempotency-Key). 어휘체인 abort→cancelled, W10 replay.
  abortRun(runId: string, idempotencyKey: string): Promise<unknown>;
  // DLQ 재처리(W10). kind로 workitem/sink 분기(백엔드 `?kind=` — sink는 별도 OperationId 멱등 네임스페이스).
  replayDeadLetter(deadLetterId: string, idempotencyKey: string, kind: "workitem" | "sink"): Promise<unknown>;
  // 사이트 risk 승인(approver). Idempotency-Key + body{reason?,expires_at?} → approval_status=approved.
  approveSite(siteId: string, idempotencyKey: string, opts?: { reason?: string; expires_at?: string }): Promise<unknown>;
  // 사이트 신규 등록(operator+, api-surface §7 POST /v1/sites). Idempotency-Key + body. url_pattern은 http(s) origin.
  createSite(body: { name: string; url_pattern: string; risk?: string; page_state_selectors?: unknown }, idempotencyKey: string): Promise<unknown>;
  // 사이트 이름 수정(operator+, api-surface §7 PATCH /v1/sites/{id}). Idempotency-Key + body{name}. 중복 name→422.
  updateSite(siteId: string, name: string, idempotencyKey: string): Promise<unknown>;
  // 운영자-보조 세션 등록(operator+, POST /v1/sites/{id}/session/capture). headful 로그인창을 띄워 운영자가 직접 로그인 → 세션 저장.
  // login_url 은 사이트 설정(page_state_selectors.loginUrl)에서 해소 — 사이트별 로그인 URL.
  captureSession(siteId: string, idempotencyKey: string): Promise<unknown>;
  // human-task 전이(api-surface §4 / app human-tasks.ts 실 shape): assign{assignee}·start(무body)·
  // resolve{result?}·escalate{reason?}. 권한/assignee 범위는 백엔드가 강제(거부 시 AUTHZ_FORBIDDEN 표면화).
  assignHumanTask(id: string, assignee: string, idempotencyKey: string): Promise<unknown>;
  startHumanTask(id: string, idempotencyKey: string): Promise<unknown>;
  resolveHumanTask(id: string, idempotencyKey: string, result?: Record<string, unknown>): Promise<unknown>;
  escalateHumanTask(id: string, idempotencyKey: string, reason?: string): Promise<unknown>;
  // scenario 승격: If-Match(현재 version) + body{target:"prod"} + Idempotency-Key. 충돌→SCENARIO_VERSION_CONFLICT 표면화.
  promoteScenario(scenarioId: string, version: number, idempotencyKey: string): Promise<unknown>;
  setScenarioPromotion(scenarioId: string, version: number, target: "prod" | "draft", idempotencyKey: string): Promise<unknown>;
  archiveScenario(scenarioId: string, version: number, idempotencyKey: string): Promise<unknown>;
  listScenarioVersions(scenarioId: string): Promise<Paginated<ScenarioVersionItem>>;
  rollbackScenario(scenarioId: string, sourceVersion: number, latestVersion: number, idempotencyKey: string): Promise<ScenarioMutationResult>;
  // 상세 GET-by-id(RLS 스코프, 미존재/타테넌트→404). drill-down 뷰의 선행.
  getRun(runId: string): Promise<RunDetail>;
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

  async function get<T>(path: string): Promise<T> {
    const res = await doFetch(`${opts.baseUrl}${path}`, {
      method: "GET",
      headers: { Accept: "application/json", ...authHeaders() },
    });
    return parseOrThrow<T>(res);
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

  return {
    listRuns: (p) => get(`/v1/runs${queryString(p)}`),
    listRunSteps: (runId, p) => get(`/v1/runs/${runId}/steps${queryString(p)}`),
    listRunArtifacts: (runId, p) => get(`/v1/runs/${runId}/artifacts${queryString(p)}`),
    listScenarioGenerationArtifacts: (generationId, p) => get(`/v1/scenario-generations/${generationId}/artifacts${queryString(p)}`),
    listWorkitems: (p) => get(`/v1/workitems${queryString(p)}`),
    listHumanTasks: (p) => get(`/v1/human-tasks${queryString(p)}`),
    listDlq: (kind, p) => get(`/v1/dlq${queryString({ ...p, kind })}`),
    listScenarios: (p) => get(`/v1/scenarios${queryString(p)}`),
    listSites: (p) => get(`/v1/sites${queryString(p)}`),
    listGatewayPolicies: () => get(`/v1/gateway/policies`),
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
    approveSite: (siteId, key, opts) => post(`/v1/sites/${siteId}/approve`, key, opts ?? {}),
    createSite: (body, key) => post(`/v1/sites`, key, body),
    updateSite: (siteId, name, key) => send("PATCH", `/v1/sites/${siteId}`, { name }, { "Idempotency-Key": key }),
    captureSession: (siteId, key) => post(`/v1/sites/${siteId}/session/capture`, key, {}),
    assignHumanTask: (id, assignee, key) => post(`/v1/human-tasks/${id}/assign`, key, { assignee }),
    startHumanTask: (id, key) => post(`/v1/human-tasks/${id}/start`, key),
    resolveHumanTask: (id, key, result) => post(`/v1/human-tasks/${id}/resolve`, key, result !== undefined ? { result } : {}),
    escalateHumanTask: (id, key, reason) => post(`/v1/human-tasks/${id}/escalate`, key, reason !== undefined ? { reason } : {}),
    promoteScenario: (scenarioId, version, key) =>
      post(`/v1/scenarios/${scenarioId}/promote`, key, { target: "prod" }, { "If-Match": String(version) }),
    setScenarioPromotion: (scenarioId, version, target, key) =>
      post(`/v1/scenarios/${scenarioId}/promote`, key, { target }, { "If-Match": String(version) }),
    archiveScenario: (scenarioId, version, key) =>
      post(`/v1/scenarios/${scenarioId}/archive`, key, {}, { "If-Match": String(version) }),
    listScenarioVersions: (scenarioId) => get(`/v1/scenarios/${scenarioId}/versions`),
    rollbackScenario: (scenarioId, sourceVersion, latestVersion, key) =>
      post(`/v1/scenarios/${scenarioId}/versions/${sourceVersion}/rollback`, key, {}, { "If-Match": String(latestVersion) }),
    getRun: (id) => get(`/v1/runs/${id}`),
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
