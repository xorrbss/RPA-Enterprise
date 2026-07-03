import { ApiError, type ListParams } from "./types";

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
export function parseEtagVersion(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number.parseInt(value.replace(/^W\//, "").replace(/^"|"$/g, ""), 10);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

export function queryString(p?: ListParams): string {
  if (p === undefined) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) {
    if (v !== undefined && v !== null) sp.set(k, String(v));
  }
  const s = sp.toString();
  return s.length > 0 ? `?${s}` : "";
}

export function createHttpHelpers(opts: HttpApiClientOptions) {
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

  async function getBlob(path: string, accept: string): Promise<Blob> {
    const res = await doFetch(`${opts.baseUrl}${path}`, {
      method: "GET",
      headers: { Accept: accept, ...authHeaders() },
    });
    return parseBlobOrThrow(res);
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
        // 본문이 있을 때만 Content-Type 부여 — 무본문 변이(DELETE·bodyless PUT)에서 ct=json + 빈 본문이
        // 나가면 서버 JSON 파서가 FST_ERR_CTP_EMPTY_JSON_BODY 를 던져 500 이 된다(빈 본문에 ct 미부여).
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
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

  return { doFetch, authHeaders, parseOrThrow, parseBlobOrThrow, get, getText, getBlob, send, post, watchRunSteps };
}
