import { describe, expect, test } from "vitest";

import { createHttpApiClient } from "../src/api/client";
import { ApiError } from "../src/api/types";

// 실 HttpApiClient의 요청 구성(경로·헤더·body)이 제어평면 계약(api-surface)과 일치하는지 검증.
// fetchImpl 주입으로 라이브 서버 없이 결정적으로 캡처. smoke/a11y는 fake 포트라 이 경로를 안 탄다.

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function harness(response: { status?: number; body?: unknown; headers?: Record<string, string> } = {}) {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body !== undefined && init.body !== null ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(response.body ?? {}), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json", ...(response.headers ?? {}) },
    });
  }) as typeof fetch;
  const client = createHttpApiClient({ baseUrl: "http://api.test", getToken: () => "jwt-123", fetchImpl });
  return { calls, client };
}

describe("HttpApiClient 계약", () => {
  test("listRuns → GET /v1/runs?limit=50 + Bearer", async () => {
    const { calls, client } = harness({ body: { items: [], next_cursor: null } });
    await client.listRuns({ limit: 50 });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/runs?limit=50");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-123");
  });

  test("listDlq(sink) → kind=sink 쿼리", async () => {
    const { calls, client } = harness({ body: { items: [], next_cursor: null } });
    await client.listDlq("sink", { limit: 10 });
    expect(calls[0]?.url).toBe("http://api.test/v1/dlq?limit=10&kind=sink");
  });

  test("abortRun → POST .../abort + Idempotency-Key + 빈 body", async () => {
    const { calls, client } = harness({ body: { status: "cancelled" } });
    await client.abortRun("run-1", "idem-abc");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("http://api.test/v1/runs/run-1/abort");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("idem-abc");
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(calls[0]?.body).toEqual({});
  });

  test("promoteScenario → POST .../promote + If-Match + body{target:prod}", async () => {
    const { calls, client } = harness({ body: { version: 3 } });
    await client.promoteScenario("scn-1", 3, "idem-xyz");
    expect(calls[0]?.url).toBe("http://api.test/v1/scenarios/scn-1/promote");
    expect(calls[0]?.headers.get("if-match")).toBe("3");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("idem-xyz");
    expect(calls[0]?.body).toEqual({ target: "prod" });
  });

  test("resolveHumanTask(result) → body{result}", async () => {
    const { calls, client } = harness();
    await client.resolveHumanTask("ht-1", "k1", { outcome: "approved" });
    expect(calls[0]?.url).toBe("http://api.test/v1/human-tasks/ht-1/resolve");
    expect(calls[0]?.body).toEqual({ result: { outcome: "approved" } });
  });

  test("assignHumanTask → body{assignee}", async () => {
    const { calls, client } = harness();
    await client.assignHumanTask("ht-2", "user-9", "k2");
    expect(calls[0]?.body).toEqual({ assignee: "user-9" });
  });

  test("4xx 응답 → ApiError(code, httpStatus) 표면화 (조용한 실패 금지)", async () => {
    const { client } = harness({ status: 409, body: { code: "RUN_ABORTED" } });
    await expect(client.abortRun("run-x", "k")).rejects.toMatchObject({ httpStatus: 409, code: "RUN_ABORTED" });
    await expect(client.abortRun("run-x", "k")).rejects.toBeInstanceOf(ApiError);
  });

  test("토큰 없으면 Authorization 미첨부", async () => {
    const calls: Captured[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: undefined });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const client = createHttpApiClient({ baseUrl: "http://api.test", getToken: () => null, fetchImpl });
    await client.listSites();
    expect(calls[0]?.headers.has("authorization")).toBe(false);
  });
});
