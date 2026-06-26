/**
 * D7 e2e — 빌드된 운영 콘솔(web/dist)을 실제 Chrome에서 로드해 부팅/렌더/라우팅을 검증.
 *
 * jsdom 스모크와 달리 실제 Vite 번들을 실 브라우저에서 실행한다(런타임 에러/CSS/라우팅 회귀 포착).
 * 백엔드는 띄우지 않고 `/api/*` fetch를 puppeteer 인터셉트로 스텁한다(클라이언트↔API 계약은
 * web/test/client.test.ts가 별도 검증). web 소스는 import하지 않아 패키지 경계가 깔끔하다.
 *
 * 실행: `npm --prefix app run test:console-e2e` (Chrome 필요; CHROME_PATH로 재정의 가능).
 * 사전: web/dist 필요 — 없으면 `npm --prefix web run build`.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer, { type HTTPRequest, type Page } from "puppeteer-core";

const DIST = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const SEEDED_RUN_ID = "11111111-aaaa-bbbb-cccc-000000000001";
const SEEDED_WORKITEM_REF = "wi-e2e";
const RUN_DETAIL_LABEL = "실행 추적 상세 보기";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function findChrome(): string | null {
  const env = process.env.CHROME_PATH?.trim();
  if (env !== undefined && env.length > 0 && existsSync(env)) return env;
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

function contentType(ext: string): string {
  if (ext === ".js") return "text/javascript";
  if (ext === ".css") return "text/css";
  if (ext === ".html") return "text/html";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function apiFixture(url: URL): unknown {
  const { pathname, searchParams } = url;
  if (pathname === "/api/v1/runs") {
    const status = searchParams.get("status");
    // current_node 는 백엔드(reads-runs)가 계약 미약속으로 영구 null 을 반환한다 — fixture 도 null(백엔드가 못 만드는
    //   값을 e2e 에서 창작하지 않는다; api-reads.int·web/fake-client 와 동형 fabrication-guard).
    const seededRun = {
      run_id: SEEDED_RUN_ID,
      status: "running",
      priority: "medium",
      current_node: null,
      as_of: "2026-06-24T09:00:00.000Z",
      updated_at: "2026-06-24T09:00:00.000Z",
      failure_reason: null,
    };
    return { items: status === null || status === "running" ? [seededRun] : [], next_cursor: null };
  }
  if (pathname === "/api/v1/workitems") {
    return { items: [{ workitem_id: "55550000-aaaa-bbbb-cccc-000000000001", status: "new", unique_reference: SEEDED_WORKITEM_REF, target_id: null }], next_cursor: null };
  }
  if (pathname === "/api/v1/human-tasks") {
    return { items: [], next_cursor: null };
  }
  if (pathname === "/api/v1/dlq") {
    return { items: [], next_cursor: null };
  }
  if (pathname === "/api/v1/sites") {
    return { items: [], next_cursor: null };
  }
  if (pathname === "/api/v1/ops-alerts") {
    return { items: [], next_cursor: null };
  }
  if (pathname === "/api/v1/ops/health") {
    return {
      status: "ok",
      detected_at: "2026-06-24T09:00:00.000Z",
      queue: { available: true, pending_jobs: 0 },
      browser_leases: { reserved: 0, active: 0, draining: 0, expired: 0, expired_open: 0, next_expiry_at: null },
      stale_runs: { nonterminal_over_15m: 0, oldest_updated_at: null },
    };
  }
  if (pathname === "/api/v1/gateway/policy") {
    return { model: "gpt-4o-mini", capabilities: { jsonMode: true } };
  }
  if (pathname === "/api/v1/gateway/call-summary") {
    return { window_days: 30, total: { calls: 0, input_tokens: null, output_tokens: null, cost: null }, by_model: [] };
  }
  if (pathname === "/api/v1/reports/automation-performance") {
    return {
      month: "2026-06",
      timezone: "Asia/Seoul",
      period_start: "2026-05-31T15:00:00.000Z",
      period_end: "2026-06-30T15:00:00.000Z",
      summary: {
        total_runs: 1,
        completed: 1,
        failed_business: 0,
        failed_system: 0,
        success_rate: 1,
        rerun_count: 0,
        reprocessing_rate: 0,
        estimated_hours_saved: 1,
        estimated_value: 40000,
        implementation_effort: 0,
        net_value: 40000,
        value_to_cost_ratio: null,
        payback_months: null,
        gateway_cost: 0.25,
        cost_by_status: { completed: 0.25, failed_business: 0, failed_system: 0, other: 0 },
        failed_cost: 0,
        rerun_cost: 0,
        avg_cost_per_run: 0.25,
        cost_per_completed_run: 0.25,
        llm_call_cost: null,
        run_vs_call_cost_delta: null,
        roi_idea_count: 1,
        roi_confidence: { low: 0, medium: 1, high: 0 },
      },
      cost_by_model: [],
      failure_top: [],
      by_workflow: [
        {
          scenario_id: "00000000-0000-4000-8000-0000000000a1",
          scenario_name: "E2E invoice lookup",
          total_runs: 1,
          completed: 1,
          failed_business: 0,
          failed_system: 0,
          success_rate: 1,
          rerun_count: 0,
          reprocessing_rate: 0,
          estimated_hours_saved: 1,
          estimated_value: 40000,
          implementation_effort: 0,
          net_value: 40000,
          value_to_cost_ratio: null,
          payback_months: null,
          gateway_cost: 0.25,
          cost_by_status: { completed: 0.25, failed_business: 0, failed_system: 0, other: 0 },
          rerun_cost: 0,
          avg_cost_per_run: 0.25,
          cost_per_completed_run: 0.25,
          roi_idea_count: 1,
          roi_confidence: { low: 0, medium: 1, high: 0 },
        },
      ],
      trends: [
        {
          day: "2026-06-25",
          total_runs: 1,
          completed: 1,
          failed_business: 0,
          failed_system: 0,
          success_rate: 1,
          rerun_count: 0,
          reprocessing_rate: 0,
          estimated_hours_saved: 1,
          estimated_value: 40000,
          gateway_cost: 0.25,
          cost_by_status: { completed: 0.25, failed_business: 0, failed_system: 0, other: 0 },
          rerun_cost: 0,
          avg_cost_per_run: 0.25,
          cost_per_completed_run: 0.25,
          cost_delta_from_previous_day: null,
        },
      ],
    };
  }
  if (pathname === "/api/v1/runs/summary") {
    return { by_status: { running: 1 }, success_rate: null, total: 1, cache: { by_mode: { bypass: 1 }, hit_rate: null } };
  }
  if (pathname === "/api/v1/runs/trends") {
    return {
      window_days: 30,
      timezone: "Asia/Seoul",
      points: [
        { day: "2026-06-23", completed: 1, failed_business: 0, failed_system: 0, total: 1, success_rate: 1 },
        { day: "2026-06-24", completed: 0, failed_business: 0, failed_system: 0, total: 0, success_rate: null },
        { day: "2026-06-25", completed: 1, failed_business: 0, failed_system: 1, total: 2, success_rate: 0.5 },
      ],
    };
  }
  // human-tasks / dlq / sites / scenarios 등 → 빈 페이지(정직)
  return { items: [], next_cursor: null };
}

async function debugSnapshot(
  page: Page,
  apiRequests: readonly string[],
  pageErrors: readonly string[],
  consoleErrors: readonly string[],
): Promise<string> {
  const pageState = await page.evaluate(() => ({
    url: location.href,
    h1: document.querySelector("h1")?.textContent ?? null,
    body: document.body.innerText.slice(0, 1_200),
    titled: Array.from(document.querySelectorAll("[title]"))
      .slice(0, 12)
      .map((el) => ({
        text: (el.textContent ?? "").trim().slice(0, 80),
        title: el.getAttribute("title"),
        ariaLabel: el.getAttribute("aria-label"),
      })),
  }));
  return JSON.stringify(
    {
      page: pageState,
      apiRequests: apiRequests.slice(-20),
      pageErrors,
      consoleErrors: consoleErrors.slice(-10),
    },
    null,
    2,
  );
}

async function waitForDashboardSeed(
  page: Page,
  apiRequests: readonly string[],
  pageErrors: readonly string[],
  consoleErrors: readonly string[],
): Promise<void> {
  let status: unknown;
  try {
    const result = await page.waitForFunction(
      (runId, detailLabel) => {
        const body = document.body.innerText;
        if (body.includes("화면을 표시하지 못했습니다")) return "error-boundary";

        const recentPanel = Array.from(document.querySelectorAll("section"))
          .find((section) => (section.textContent ?? "").includes("최근 실행"));
        if (recentPanel === undefined) return false;

        const panelText = recentPanel.textContent ?? "";
        const elements = Array.from(recentPanel.querySelectorAll("button, [title], [aria-label]"));
        const hasRunIdentity =
          panelText.includes(runId) ||
          panelText.includes(runId.slice(0, 8)) ||
          elements.some((el) => (el.getAttribute("title") ?? "").includes(runId));
        const hasDetailControl = elements.some((el) =>
          (el.getAttribute("aria-label") ?? "") === detailLabel ||
          (el.textContent ?? "").includes("상세 보기")
        );
        const hasRunningStatus = panelText.includes("실행 중");
        return hasRunIdentity && hasDetailControl && hasRunningStatus ? "ready" : false;
      },
      { timeout: 15_000 },
      SEEDED_RUN_ID,
      RUN_DETAIL_LABEL,
    );
    status = await result.jsonValue();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`dashboard seed run was not rendered before timeout: ${message}\n${await debugSnapshot(page, apiRequests, pageErrors, consoleErrors)}`);
  }
  if (status === "ready") return;
  throw new Error(`dashboard rendered ${String(status)}: ${await debugSnapshot(page, apiRequests, pageErrors, consoleErrors)}`);
}

async function waitForWorkitemSeed(
  page: Page,
  apiRequests: readonly string[],
  pageErrors: readonly string[],
  consoleErrors: readonly string[],
): Promise<void> {
  let status: unknown;
  try {
    const result = await page.waitForFunction(
      (workitemRef) => {
        const body = document.body.innerText;
        if (body.includes("화면을 표시하지 못했습니다")) return "error-boundary";
        return body.includes(workitemRef) ? "ready" : false;
      },
      { timeout: 15_000 },
      SEEDED_WORKITEM_REF,
    );
    status = await result.jsonValue();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`workitem seed row was not rendered before timeout: ${message}\n${await debugSnapshot(page, apiRequests, pageErrors, consoleErrors)}`);
  }
  if (status === "ready") return;
  throw new Error(`workitem route rendered ${String(status)}: ${await debugSnapshot(page, apiRequests, pageErrors, consoleErrors)}`);
}

async function main(): Promise<void> {
  const chrome = findChrome();
  if (chrome === null) {
    console.log("SKIP: Chrome/Chromium not found (set CHROME_PATH). e2e는 Chrome 환경에서 실행됩니다.");
    process.exit(0);
  }
  if (!existsSync(join(DIST, "index.html"))) {
    console.error("FAIL: web/dist 없음 — 먼저 `npm --prefix web run build` 실행 필요");
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    let p = (req.url ?? "/").split("?")[0];
    if (p === "/") p = "/index.html";
    let file = join(DIST, p.replace(/^\/+/, ""));
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html"); // SPA fallback
    res.writeHead(200, { "content-type": contentType(extname(file)) });
    res.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server addr");
  const base = `http://127.0.0.1:${addr.port}`;

  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const apiRequests: string[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e: unknown) => pageErrors.push(e instanceof Error ? e.message : String(e)));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    await page.evaluateOnNewDocument(() => {
      try {
        localStorage.setItem("rpa.token", "e2e-token");
      } catch {
        /* ignore */
      }
    });
    await page.setRequestInterception(true);
    page.on("request", (req: HTTPRequest) => {
      const url = new URL(req.url());
      if (url.pathname.startsWith("/api/")) {
        apiRequests.push(`${url.pathname}${url.search}`);
        void req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(apiFixture(url)) });
      } else {
        void req.continue();
      }
    });

    // 1) 기본 라우트(dashboard) 부팅 + 시드 실행 렌더
    await page.goto(`${base}/`, { waitUntil: "networkidle0", timeout: 30_000 });
    await page.waitForSelector("h1", { timeout: 15_000 });
    await waitForDashboardSeed(page, apiRequests, pageErrors, consoleErrors);
    const dash = await page.evaluate(() => document.body.innerText);
    const dashboardTitle = await page.$eval("h1", (el) => el.textContent ?? "");
    check("dashboard 부팅 + 운영 대시보드 제목", dashboardTitle === "RPA 운영 대시보드", dashboardTitle);
    check("dashboard 최근 실행 행 렌더", dash.includes("상세 보기") || dash.includes(SEEDED_RUN_ID.slice(0, 8)), dash.slice(0, 300));
    check("시드 실행이 '실행 중'으로 표시(StatusBadge 한국어 라벨)", dash.includes("실행 중"), dash.slice(0, 200));
    check("사이드바 18 nav 렌더", await page.$$eval("nav.sidebar button", (b) => b.length) === 18);

    // 2) 해시 라우팅 → workitems, 시드 작업항목 렌더
    await page.evaluate(() => {
      location.hash = "#workitems";
    });
    await waitForWorkitemSeed(page, apiRequests, pageErrors, consoleErrors);
    const h1 = await page.$eval("h1", (el) => el.textContent ?? "");
    check("라우팅 후 탑바 제목 = 작업 목록", h1 === "작업 목록", h1);
    check("시드 작업항목(wi-e2e) 렌더", (await page.evaluate(() => document.body.innerText)).includes(SEEDED_WORKITEM_REF));

    // 3) 런타임 에러 없음(번들 무결성)
    check("브라우저 페이지 에러 없음", pageErrors.length === 0 && consoleErrors.length === 0, [...pageErrors, ...consoleErrors].join("; "));
  } finally {
    await browser.close();
    server.close();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D7 console browser e2e green (real Chrome, built dist, stubbed API)");
  process.exit(0);
}

main().catch((e) => {
  console.error("e2e fatal:", e);
  process.exit(1);
});
