#!/usr/bin/env node
/**
 * 컨테이너 end-to-end 실행 스모크 — "배포 아티팩트가 실제로 자동화를 실행하는가".
 *
 * 지금까지의 기동 스모크는 "스택이 뜬다"까지만 증명한다. 이 스크립트는 배포된 API 로 사이트·시나리오를 만들고
 * run 을 큐에 넣어, **컨테이너 안의 워커가 이미지에 설치된 Chromium 으로** 그 run 을 completed 까지 몰고 가는지
 * 확인한다. 모든 단계가 실 HTTP(제어평면) → 실 graphile 큐 → 실 워커 경로다(목/페이크 없음).
 *
 * 시나리오는 LLM 을 쓰지 않는다(navigate → observe → flags 분기 → success): PageState flags 는 site_profiles
 * 의 page_state_selectors 로 산출되므로 Codex 없이도 완주한다.
 *
 * 실행:
 *   JWT_HS256_SECRET=<API 와 동일> node scripts/container-e2e-run.mjs
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const API = process.env.RPA_API_BASE ?? "http://127.0.0.1:8080";
const TENANT = process.env.RPA_E2E_TENANT ?? "00000000-0000-4000-8000-0000000000e2";
const ENTRY_URL = process.env.RPA_E2E_ENTRY_URL ?? "http://fixture/";
const SITE_ORIGIN = new URL(ENTRY_URL).origin;
const POLL_ATTEMPTS = Number(process.env.RPA_E2E_POLL_ATTEMPTS ?? "90");
const TERMINAL = new Set(["completed", "cancelled", "failed_business", "failed_system"]);

function mintToken() {
  const result = spawnSync(
    process.execPath,
    ["scripts/mint-operator-token.mjs", "--tenant", TENANT, "--sub", "container-e2e", "--roles", "admin"],
    { cwd: ROOT, encoding: "utf8", env: process.env },
  );
  if (result.status !== 0) {
    fail(`operator token mint failed: ${(result.stderr ?? "").trim()}`);
  }
  const token = result.stdout.trim();
  if (token.length === 0) fail("operator token mint produced no token");
  return token;
}

async function call(token, method, path, body) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["idempotency-key"] = randomUUID();
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

function expect(label, result, wanted) {
  if (!wanted.includes(result.status)) {
    fail(`${label} -> HTTP ${result.status}: ${JSON.stringify(result.body)}`);
  }
  console.log(`  OK  ${label} -> ${result.status}`);
  return result.body;
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const SITE = {
  name: "컨테이너 스모크 사이트",
  url_pattern: SITE_ORIGIN,
  risk: "green",
  page_state_selectors: {
    authenticatedWhen: { selector: ".user-menu" },
    flags: {
      reviews_visible: { kind: "min_count", selector: ".review-item", n: 1 },
      not_found: { kind: "present", selector: ".empty-results" },
    },
  },
};

// target 은 싣지 않는다 — 저장 시점에 시작 URL origin 으로 site/identity/network_policy 가 추론·주입된다.
const SCENARIO_IR = {
  meta: { name: `컨테이너 스모크 — 리뷰 수집 ${Date.now()}`, version: 1 },
  params_schema: {
    type: "object",
    properties: { entry_url: { type: "string", title: "시작 URL", format: "uri", default: ENTRY_URL } },
    required: ["entry_url"],
    additionalProperties: false,
  },
  start: "open",
  nodes: {
    open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "check" },
    check: {
      what: [{ action: "observe" }],
      on: [
        { when: "flags.not_found", target: "empty", priority: 2 },
        { when: "flags.reviews_visible", target: "done", priority: 1 },
      ],
    },
    done: { terminal: "success" },
    empty: { terminal: "success_empty" },
  },
};

async function main() {
  console.log(`container e2e: API=${API} entry=${ENTRY_URL}`);
  const token = mintToken();

  expect("POST /v1/sites", await call(token, "POST", "/v1/sites", SITE), [200, 201]);
  const scenario = expect("POST /v1/scenarios", await call(token, "POST", "/v1/scenarios", SCENARIO_IR), [201]);

  const detail = expect(
    `GET /v1/scenarios/${scenario.scenario_id}`,
    await call(token, "GET", `/v1/scenarios/${scenario.scenario_id}`),
    [200],
  );
  const versionId = detail.version_id ?? detail.versions?.[0]?.version_id;
  if (typeof versionId !== "string") {
    fail(`scenario detail carries no version_id: ${JSON.stringify(detail)}`);
  }

  const run = expect(
    "POST /v1/runs",
    await call(token, "POST", "/v1/runs", { scenario_version_id: versionId, params: { entry_url: ENTRY_URL } }),
    [201, 202],
  );
  const runId = run.run_id ?? run.id;
  if (typeof runId !== "string") fail(`run create carries no run id: ${JSON.stringify(run)}`);
  console.log(`  run ${runId} queued — waiting for the containerized worker to drive it`);

  let last = "";
  for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
    const state = await call(token, "GET", `/v1/runs/${runId}`);
    if (state.status !== 200) fail(`GET /v1/runs/${runId} -> ${state.status}: ${JSON.stringify(state.body)}`);
    const status = state.body?.status;
    if (status !== last) {
      console.log(`  [${attempt}] run status: ${status}`);
      last = status;
    }
    if (TERMINAL.has(status)) {
      if (status === "completed") {
        console.log(`\nPASS: the containerized worker drove the run to '${status}' with the image's Chromium`);
        return;
      }
      fail(`run reached terminal '${status}' instead of 'completed': ${JSON.stringify(state.body)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  fail(`run did not reach a terminal state within ${POLL_ATTEMPTS} polls (last='${last}')`);
}

main().catch((err) => {
  fail(`container e2e threw: ${String(err)}`);
});
