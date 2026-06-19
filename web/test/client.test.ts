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

  test("listRunSteps → GET /v1/runs/{id}/steps + Bearer (단계 트레이스 read 배선)", async () => {
    const { calls, client } = harness({ body: { items: [], next_cursor: null } });
    await client.listRunSteps("run-9", { limit: 100 });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/runs/run-9/steps?limit=100");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-123");
  });

  test("listRunArtifacts → GET /v1/runs/{id}/artifacts + Bearer (artifact 목록 read 배선)", async () => {
    const { calls, client } = harness({ body: { items: [], next_cursor: null } });
    await client.listRunArtifacts("run-9", { limit: 100 });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/runs/run-9/artifacts?limit=100");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-123");
  });

  test("listScenarioGenerationArtifacts → GET /v1/scenario-generations/{id}/artifacts + Bearer", async () => {
    const { calls, client } = harness({ body: { items: [], next_cursor: null } });
    await client.listScenarioGenerationArtifacts("gen-9", { limit: 50 });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/scenario-generations/gen-9/artifacts?limit=50");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-123");
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

  test("scenario lifecycle → 운영 해제·보관·버전 목록·롤백 경로", async () => {
    const { calls, client } = harness({ body: { items: [], next_cursor: null } });
    await client.setScenarioPromotion("scn-1", 3, "draft", "idem-draft");
    await client.archiveScenario("scn-1", 3, "idem-archive");
    await client.listScenarioVersions("scn-1");
    await client.rollbackScenario("scn-1", 1, 3, "idem-rollback");

    expect(calls[0]?.url).toBe("http://api.test/v1/scenarios/scn-1/promote");
    expect(calls[0]?.headers.get("if-match")).toBe("3");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("idem-draft");
    expect(calls[0]?.body).toEqual({ target: "draft" });
    expect(calls[1]?.url).toBe("http://api.test/v1/scenarios/scn-1/archive");
    expect(calls[1]?.headers.get("if-match")).toBe("3");
    expect(calls[2]?.method).toBe("GET");
    expect(calls[2]?.url).toBe("http://api.test/v1/scenarios/scn-1/versions");
    expect(calls[3]?.url).toBe("http://api.test/v1/scenarios/scn-1/versions/1/rollback");
    expect(calls[3]?.headers.get("if-match")).toBe("3");
    expect(calls[3]?.headers.get("idempotency-key")).toBe("idem-rollback");
  });

  test("getGatewayPolicy → ETag(version) 헤더를 body.version으로 병합", async () => {
    const { calls, client } = harness({ body: { model: "gpt-4o", capabilities: {} }, headers: { ETag: "7" } });
    const policy = await client.getGatewayPolicy("gpt-4o");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/gateway/policy?model=gpt-4o");
    expect(policy.version).toBe(7);
    expect(policy.model).toBe("gpt-4o");
  });

  test("gateway policy CRUD 경로 → list/create/delete + 기본 정책 플래그", async () => {
    const { calls, client } = harness({ body: { items: [{ model: "gpt-4o", version: 1, is_default: true }], next_cursor: null } });
    await client.listGatewayPolicies();
    await client.createGatewayPolicy(
      {
        model: "gpt-4.1-mini",
        capabilities: { maxContextTokens: 8000 },
        budget: { maxInputTokens: 100, maxOutputTokens: 100, maxCost: 1 },
        fallback_config: null,
        is_default: true,
      },
      "idem-create-gw",
    );
    await client.deleteGatewayPolicy("gpt-4.1-mini", 3, "idem-delete-gw");

    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/gateway/policies");
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.url).toBe("http://api.test/v1/gateway/policy");
    expect(calls[1]?.headers.get("idempotency-key")).toBe("idem-create-gw");
    expect(calls[1]?.body).toEqual({
      model: "gpt-4.1-mini",
      capabilities: { maxContextTokens: 8000 },
      budget: { maxInputTokens: 100, maxOutputTokens: 100, maxCost: 1 },
      fallback_config: null,
      is_default: true,
    });
    expect(calls[2]?.method).toBe("DELETE");
    expect(calls[2]?.url).toBe("http://api.test/v1/gateway/policy?model=gpt-4.1-mini");
    expect(calls[2]?.headers.get("if-match")).toBe("3");
    expect(calls[2]?.headers.get("idempotency-key")).toBe("idem-delete-gw");
  });

  test("getGatewayPolicy → ETag 부재 시 version undefined(편집 차단 가드)", async () => {
    const { client } = harness({ body: { model: "gpt-4o" } });
    const policy = await client.getGatewayPolicy();
    expect(policy.version).toBeUndefined();
  });

  test("updateGatewayPolicy → PUT /v1/gateway/policy + If-Match + Idempotency-Key + body", async () => {
    const { calls, client } = harness({ body: { model: "gpt-4o", version: 3 } });
    await client.updateGatewayPolicy(2, { model: "gpt-4o", capabilities: { maxContextTokens: 8000 }, budget: { maxInputTokens: 100, maxOutputTokens: 100, maxCost: 1 } }, "idem-gw");
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toBe("http://api.test/v1/gateway/policy");
    expect(calls[0]?.headers.get("if-match")).toBe("2");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("idem-gw");
    expect(calls[0]?.body).toEqual({ model: "gpt-4o", capabilities: { maxContextTokens: 8000 }, budget: { maxInputTokens: 100, maxOutputTokens: 100, maxCost: 1 } });
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

  test("detail GET-by-id 경로", async () => {
    const { calls, client } = harness({ body: { run_id: "r1", status: "running", worker_id: null, attempts: 1, as_of: null } });
    await client.getRun("r1");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/runs/r1");
    const w = harness({ body: {} });
    await w.client.getHumanTask("ht-9");
    expect(w.calls[0]?.url).toBe("http://api.test/v1/human-tasks/ht-9");
  });

  test("getArtifact → GET /v1/artifacts/{id} + Bearer (산출물 조회 배선)", async () => {
    const { calls, client } = harness({ body: { artifact_id: "a1", type: "screenshot", sha256: "h", redaction_status: "redacted", retention_until: null, content: "redacted" } });
    const art = await client.getArtifact("a1");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/artifacts/a1");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-123");
    expect(art.content).toBe("redacted");
    expect(art.redaction_status).toBe("redacted");
  });

  test("getArtifactBlob → GET /v1/artifacts/{id}/blob + Bearer", async () => {
    const { calls, client } = harness({ body: "binary" });
    const blob = await client.getArtifactBlob("a1");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/artifacts/a1/blob");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-123");
    expect(calls[0]?.headers.get("accept")).toBe("*/*");
    expect(blob).toBeInstanceOf(Blob);
  });

  test("getScenarioGenerationArtifact → scoped generation artifact body route + Bearer", async () => {
    const { calls, client } = harness({
      body: {
        artifact_id: "a1",
        generation_id: "g1",
        type: "scenario_generation_llm_output",
        sha256: "h",
        redaction_status: "redacted",
        retention_until: null,
        content: "redacted planner output",
      },
    });
    const artifact = await client.getScenarioGenerationArtifact("g1", "a1");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/scenario-generations/g1/artifacts/a1");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-123");
    expect(artifact.generation_id).toBe("g1");
    expect(artifact.content).toBe("redacted planner output");
  });

  test("validateScenario → POST .../validate + body=IR", async () => {
    const { calls, client } = harness({ body: { valid: true, report: {} } });
    const ir = { nodes: [{ id: "n1" }] };
    await client.validateScenario("scn-1", ir, "k");
    expect(calls[0]?.url).toBe("http://api.test/v1/scenarios/scn-1/validate");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual(ir);
  });

  test("createRun → POST /v1/runs + body{scenario_version_id, params} + Idempotency-Key", async () => {
    const { calls, client } = harness({ body: { run_id: "x" } });
    await client.createRun({ scenario_version_id: "sv-1", params: {} }, "idem-run");
    expect(calls[0]?.url).toBe("http://api.test/v1/runs");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("idem-run");
    expect(calls[0]?.body).toEqual({ scenario_version_id: "sv-1", params: {} });
  });

  test("generateScenario → POST /v1/scenario-generations + Idempotency-Key + evidence", async () => {
    const { calls, client } = harness({ body: { generation_id: "g1", status: "run_queued", blockers: [] } });
    await client.generateScenario(
      {
        prompt: "주문 목록 확인",
        mode: "save_and_run",
        start_url: "https://example.test/orders",
        evidence: { screenshot: "each_step", video: "always" },
      },
      "idem-generate",
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("http://api.test/v1/scenario-generations");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("idem-generate");
    expect(calls[0]?.body).toEqual({
      prompt: "주문 목록 확인",
      mode: "save_and_run",
      start_url: "https://example.test/orders",
      evidence: { screenshot: "each_step", video: "always" },
    });
  });

  test("getScenarioGeneration → GET /v1/scenario-generations/{id}", async () => {
    const { calls, client } = harness({ body: { generation_id: "g1", status: "saved", blockers: [] } });
    await client.getScenarioGeneration("00000000-0000-0000-0000-0000000000a1");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://api.test/v1/scenario-generations/00000000-0000-0000-0000-0000000000a1");
  });

  test("listScenarioGenerations → GET /v1/scenario-generations + query", async () => {
    const { calls: generationCalls, client: generationClient } = harness({ body: { items: [], next_cursor: null } });
    await generationClient.listScenarioGenerations({ limit: 10, cursor: "cursor-1", status: "blocked" });
    expect(generationCalls[0]?.method).toBe("GET");
    expect(generationCalls[0]?.url).toBe("http://api.test/v1/scenario-generations?limit=10&cursor=cursor-1&status=blocked");
  });

  test("replayDeadLetter(sink) -> POST .../replay?kind=sink + Idempotency-Key", async () => {
    const { calls, client } = harness({ body: { status: "new" } });
    await client.replayDeadLetter("dl-1", "idem-sink", "sink");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("http://api.test/v1/dlq/dl-1/replay?kind=sink");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("idem-sink");
  });

  test("replayDeadLetter(workitem) → ?kind=workitem", async () => {
    const { calls, client } = harness({ body: { status: "new" } });
    await client.replayDeadLetter("dl-2", "idem-wi", "workitem");
    expect(calls[0]?.url).toBe("http://api.test/v1/dlq/dl-2/replay?kind=workitem");
  });

  test("createSite → POST /v1/sites + body + Idempotency-Key (사이트 온보딩 배선)", async () => {
    const { calls, client } = harness({ body: { site_profile_id: "s1" } });
    const selectors = {
      loginUrl: "https://login.office.hiworks.com",
      authenticatedWhen: { selector: ".user-menu" },
      flags: { reviews_visible: { kind: "min_count", selector: ".review-item", n: 1 } },
    };
    await client.createSite({ name: "하이웍스", url_pattern: "https://login.office.hiworks.com", risk: "green", page_state_selectors: selectors }, "idem-site");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("http://api.test/v1/sites");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("idem-site");
    expect(calls[0]?.body).toEqual({ name: "하이웍스", url_pattern: "https://login.office.hiworks.com", risk: "green", page_state_selectors: selectors });
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
