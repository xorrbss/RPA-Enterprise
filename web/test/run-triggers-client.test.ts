import { describe, expect, test } from "vitest";

import { createHttpApiClient } from "../src/api/client";

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function harness(response: { status?: number; body?: unknown } = {}) {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body !== undefined && init.body !== null ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(response.body ?? { items: [], next_cursor: null }), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const client = createHttpApiClient({ baseUrl: "http://api.test", getToken: () => "jwt-123", fetchImpl });
  return { calls, client };
}

describe("Run Trigger HttpApiClient contract", () => {
  test("uses contracted paths and idempotency headers", async () => {
    const { calls, client } = harness();

    await client.listRunTriggers({ status: "enabled", limit: 20 });
    await client.createRunTrigger(
      {
        scenario_version_id: "sv-1",
        cron_expression: "0 9 * * *",
        timezone: "Asia/Seoul",
        params: {},
      },
      "idem-trigger-create",
    );
    await client.updateRunTrigger("tr-1", { cron_expression: "30 8 * * 1" }, "idem-trigger-update");
    await client.pauseRunTrigger("tr-1", "idem-trigger-pause");
    await client.resumeRunTrigger("tr-1", "idem-trigger-resume");
    await client.getRunTrigger("tr-1");
    await client.listRunTriggerFires("tr-1", { limit: 10 });

    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/run-triggers?status=enabled&limit=20");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-123");
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.url).toBe("http://api.test/v1/run-triggers");
    expect(calls[1]?.headers.get("idempotency-key")).toBe("idem-trigger-create");
    expect(calls[1]?.body).toEqual({
      scenario_version_id: "sv-1",
      cron_expression: "0 9 * * *",
      timezone: "Asia/Seoul",
      params: {},
    });
    expect(calls[2]?.method).toBe("PATCH");
    expect(calls[2]?.url).toBe("http://api.test/v1/run-triggers/tr-1");
    expect(calls[2]?.headers.get("idempotency-key")).toBe("idem-trigger-update");
    expect(calls[2]?.body).toEqual({ cron_expression: "30 8 * * 1" });
    expect(calls[3]?.method).toBe("POST");
    expect(calls[3]?.url).toBe("http://api.test/v1/run-triggers/tr-1/pause");
    expect(calls[3]?.headers.get("idempotency-key")).toBe("idem-trigger-pause");
    expect(calls[4]?.method).toBe("POST");
    expect(calls[4]?.url).toBe("http://api.test/v1/run-triggers/tr-1/resume");
    expect(calls[4]?.headers.get("idempotency-key")).toBe("idem-trigger-resume");
    expect(calls[5]?.method).toBe("GET");
    expect(calls[5]?.url).toBe("http://api.test/v1/run-triggers/tr-1");
    expect(calls[6]?.method).toBe("GET");
    expect(calls[6]?.url).toBe("http://api.test/v1/run-triggers/tr-1/fires?limit=10");
  });
});
