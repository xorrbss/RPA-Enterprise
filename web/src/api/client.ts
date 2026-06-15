// 주입형 ApiClient 포트 + HTTP 구현. 테스트는 동일 인터페이스의 fake를 주입(백엔드 무의존).
import {
  ApiError,
  type DeadLetterItem,
  type GatewayPolicy,
  type HumanTaskItem,
  type ListParams,
  type Paginated,
  type RunItem,
  type ScenarioItem,
  type SiteItem,
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

  async function get<T>(path: string): Promise<T> {
    const token = opts.getToken();
    const res = await doFetch(`${opts.baseUrl}${path}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
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

  return {
    listRuns: (p) => get(`/v1/runs${queryString(p)}`),
    listWorkitems: (p) => get(`/v1/workitems${queryString(p)}`),
    listHumanTasks: (p) => get(`/v1/human-tasks${queryString(p)}`),
    listDlq: (kind, p) => get(`/v1/dlq${queryString({ ...p, kind })}`),
    listScenarios: (p) => get(`/v1/scenarios${queryString(p)}`),
    listSites: (p) => get(`/v1/sites${queryString(p)}`),
    getGatewayPolicy: (model) => get(`/v1/gateway/policy${queryString(model ? { model } : undefined)}`),
  };
}
