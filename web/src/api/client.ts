// 주입형 ApiClient 포트 + HTTP 구현. 테스트는 동일 인터페이스의 fake를 주입(백엔드 무의존).
import {
  ApiError,
  type CreateRunBody,
  type DeadLetterItem,
  type GatewayPolicy,
  type HumanTaskItem,
  type ListParams,
  type Paginated,
  type RunDetail,
  type RunItem,
  type ScenarioDetail,
  type ScenarioItem,
  type SiteItem,
  type ValidationResult,
  type WorkitemItem,
} from "./types";

export interface ApiClient {
  listRuns(p?: ListParams): Promise<Paginated<RunItem>>;
  listWorkitems(p?: ListParams): Promise<Paginated<WorkitemItem>>;
  listHumanTasks(p?: ListParams): Promise<Paginated<HumanTaskItem>>;
  listDlq(kind: "workitem" | "sink", p?: ListParams): Promise<Paginated<DeadLetterItem>>;
  listScenarios(p?: ListParams): Promise<Paginated<ScenarioItem>>;
  listSites(p?: ListParams): Promise<Paginated<SiteItem>>;
  getGatewayPolicy(model?: string): Promise<GatewayPolicy>;
  // 운영자 명령(POST + Idempotency-Key). 어휘체인 abort→cancelled, W10 replay.
  abortRun(runId: string, idempotencyKey: string): Promise<unknown>;
  replayDeadLetter(deadLetterId: string, idempotencyKey: string): Promise<unknown>;
  // human-task 전이(api-surface §4 / app human-tasks.ts 실 shape): assign{assignee}·start(무body)·
  // resolve{result?}·escalate{reason?}. 권한/assignee 범위는 백엔드가 강제(거부 시 AUTHZ_FORBIDDEN 표면화).
  assignHumanTask(id: string, assignee: string, idempotencyKey: string): Promise<unknown>;
  startHumanTask(id: string, idempotencyKey: string): Promise<unknown>;
  resolveHumanTask(id: string, idempotencyKey: string, result?: Record<string, unknown>): Promise<unknown>;
  escalateHumanTask(id: string, idempotencyKey: string, reason?: string): Promise<unknown>;
  // scenario 승격: If-Match(현재 version) + body{target:"prod"} + Idempotency-Key. 충돌→SCENARIO_VERSION_CONFLICT 표면화.
  promoteScenario(scenarioId: string, version: number, idempotencyKey: string): Promise<unknown>;
  // 상세 GET-by-id(RLS 스코프, 미존재/타테넌트→404). drill-down 뷰의 선행.
  getRun(runId: string): Promise<RunDetail>;
  getWorkitem(id: string): Promise<WorkitemItem>;
  getHumanTask(id: string): Promise<HumanTaskItem>;
  getScenario(id: string): Promise<ScenarioDetail>;
  getSite(id: string): Promise<SiteItem>;
  // scenario validate(V1–V11 dry-run, 비변이 POST, body=IR). run 생성(멱등 명령).
  validateScenario(scenarioId: string, ir: unknown, idempotencyKey: string): Promise<ValidationResult>;
  createRun(body: CreateRunBody, idempotencyKey: string): Promise<unknown>;
}

export interface HttpApiClientOptions {
  readonly baseUrl: string;
  readonly getToken: () => string | null;
  readonly fetchImpl?: typeof fetch;
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

  async function get<T>(path: string): Promise<T> {
    const res = await doFetch(`${opts.baseUrl}${path}`, {
      method: "GET",
      headers: { Accept: "application/json", ...authHeaders() },
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
    listWorkitems: (p) => get(`/v1/workitems${queryString(p)}`),
    listHumanTasks: (p) => get(`/v1/human-tasks${queryString(p)}`),
    listDlq: (kind, p) => get(`/v1/dlq${queryString({ ...p, kind })}`),
    listScenarios: (p) => get(`/v1/scenarios${queryString(p)}`),
    listSites: (p) => get(`/v1/sites${queryString(p)}`),
    getGatewayPolicy: (model) => get(`/v1/gateway/policy${queryString(model ? { model } : undefined)}`),
    abortRun: (runId, idempotencyKey) => post(`/v1/runs/${runId}/abort`, idempotencyKey),
    replayDeadLetter: (deadLetterId, idempotencyKey) => post(`/v1/dlq/${deadLetterId}/replay`, idempotencyKey),
    assignHumanTask: (id, assignee, key) => post(`/v1/human-tasks/${id}/assign`, key, { assignee }),
    startHumanTask: (id, key) => post(`/v1/human-tasks/${id}/start`, key),
    resolveHumanTask: (id, key, result) => post(`/v1/human-tasks/${id}/resolve`, key, result !== undefined ? { result } : {}),
    escalateHumanTask: (id, key, reason) => post(`/v1/human-tasks/${id}/escalate`, key, reason !== undefined ? { reason } : {}),
    promoteScenario: (scenarioId, version, key) =>
      post(`/v1/scenarios/${scenarioId}/promote`, key, { target: "prod" }, { "If-Match": String(version) }),
    getRun: (id) => get(`/v1/runs/${id}`),
    getWorkitem: (id) => get(`/v1/workitems/${id}`),
    getHumanTask: (id) => get(`/v1/human-tasks/${id}`),
    getScenario: (id) => get(`/v1/scenarios/${id}`),
    getSite: (id) => get(`/v1/sites/${id}`),
    validateScenario: (scenarioId, ir, key) => post(`/v1/scenarios/${scenarioId}/validate`, key, ir),
    createRun: (body, key) => post(`/v1/runs`, key, body),
  };
}
