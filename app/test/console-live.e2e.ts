/**
 * D7 라이브 e2e — 실 브라우저 → 실 Fastify 제어평면 → 실 PostgreSQL 전 구간.
 *
 * 빌드된 콘솔(web/dist)을 실 Chrome에서 로드하고, /api/* 를 실 buildServer(temp-PG)로 프록시한다.
 * read(실 API에서 시드 데이터 렌더)와 명령(DLQ 재처리 W10 → DB 변이)을 한 번에 검증한다.
 * 실행 파이프라인(worker/executor/LLM)은 불요 — 명령은 시드된 DB 행에 직접 작용한다.
 *
 * 실행(temp PG15 게이트 + Chrome):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app run test:console-live-e2e
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";
import puppeteer, { type HTTPRequest } from "puppeteer-core";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import { createPool, withTenantTx } from "../src/db/pool";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIST = join(ROOT, "web", "dist");
const SCHEMA = "rpa_console_live";
const TENANT = "00000000-0000-0000-0000-0000000000e7";
const SCEN = "70000000-0000-0000-0000-00000000e701";
const SVER = "70000000-0000-0000-0000-00000000e702";
const RUN = "71000000-0000-0000-0000-00000000e701";
const WI = "75000000-0000-0000-0000-00000000e701";
const DL = "77000000-0000-0000-0000-00000000e701";
const RUN_SUSP = "71000000-0000-0000-0000-00000000e7a2"; // 사람확인 대기 중인 suspended run(R13 대상)
const HT = "73000000-0000-0000-0000-00000000e701"; // in_progress human_task(exception)
const SUBJECT = "00000000-0000-0000-0000-00000000e7de"; // 운영자 subject = human_task assignee(assignee scope 통과)
const SECRET = new TextEncoder().encode("console-live-e2e-secret-do-not-use-in-prod-0123456789");

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
  return [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((c) => existsSync(c)) ?? null;
}

function contentType(ext: string): string {
  if (ext === ".js") return "text/javascript";
  if (ext === ".css") return "text/css";
  if (ext === ".html") return "text/html";
  return "application/octet-stream";
}

async function main(): Promise<void> {
  const chrome = findChrome();
  if (chrome === null) {
    console.log("SKIP: Chrome/Chromium not found (set CHROME_PATH).");
    process.exit(0);
  }
  if (!existsSync(join(DIST, "index.html"))) {
    console.error("FAIL: web/dist 없음 — `npm --prefix web run build` 먼저");
    process.exit(1);
  }

  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  let api: Awaited<ReturnType<typeof buildServer>> | null = null;
  let apiPort = 0;
  let proxy: http.Server | null = null;
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    // 1) 스키마 + 마이그레이션 + 시드
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(readFileSync(join(ROOT, "db", "migration_concurrency_idempotency.sql"), "utf8"));
      await setup.query(readFileSync(join(ROOT, "db", "migration_core_entities.sql"), "utf8"));
    } finally {
      setup.release();
    }
    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'live-e2e')`, [SCEN, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir) VALUES ($1,$2,$3,1,'prod','{"nodes":[]}'::jsonb)`,
        [SVER, TENANT, SCEN],
      );
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, as_of) VALUES ($1,$2,$3,'running',$1,1,'2026-06-15T00:00:00Z')`,
        [RUN, TENANT, SVER],
      );
      await c.query(
        `INSERT INTO workitems (id, tenant_id, connector_id, unique_reference, status, attempts) VALUES ($1,$2,'reviews','wi-live','abandoned',3)`,
        [WI, TENANT],
      );
      await c.query(
        `INSERT INTO dead_letter (id, tenant_id, workitem_id, reason_code, replayable) VALUES ($1,$2,$3,'DEAD_LETTER',true)`,
        [DL, TENANT, WI],
      );
      // 사람확인 대기 라이프사이클: suspended run + in_progress human_task(exception, assignee=운영자).
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, as_of) VALUES ($1,$2,$3,'suspended',$1,1,'2026-06-15T00:00:00Z')`,
        [RUN_SUSP, TENANT, SVER],
      );
      await c.query(
        `INSERT INTO human_tasks (id, tenant_id, run_id, kind, state, assignee, assignee_role, expires_at)
         VALUES ($1,$2,$3,'exception','in_progress',$4::uuid,'reviewer','2026-07-01T00:00:00Z')`,
        [HT, TENANT, RUN_SUSP, SUBJECT],
      );
    });
    console.log("seeded run(running) + workitem(abandoned) + dead_letter + suspended-run/in_progress-human_task");

    // 2) 실 Fastify 제어평면 + listen
    // resolve(R13) → run_resume 잡 인큐 경계(step2): e2e 는 잡 소비를 검증하지 않으므로 no-op. 미제공 시 resolve loud throw.
    const noopEnqueuer: RunEnqueuer = { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {}, async enqueueRunResume() {} };
    const signedCommandRegistry: SignedCommandRegistry = {
      async listAllowedCommandRefs() {
        return { kind: "available", snapshot: { sourceRef: "secret://staging/registry" as SecretRef, commands: [] } };
      },
    };
    api = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer: noopEnqueuer,
      signedCommandRegistry,
    });
    await api.ready();
    await api.listen({ port: 0, host: "127.0.0.1" });
    const apiAddr = api.server.address();
    if (apiAddr === null || typeof apiAddr === "string") throw new Error("api addr");
    apiPort = apiAddr.port;

    // 3) 정적(dist) + /api 역프록시 서버(same-origin → CORS 불요)
    proxy = http.createServer((req, res) => {
      const reqUrl = req.url ?? "/";
      if (reqUrl.startsWith("/api/")) {
        const upstreamPath = reqUrl.slice("/api".length); // /api/v1/.. → /v1/..
        const headers = { ...req.headers };
        delete headers.host;
        const pReq = http.request({ host: "127.0.0.1", port: apiPort, method: req.method, path: upstreamPath, headers }, (pRes) => {
          res.writeHead(pRes.statusCode ?? 502, pRes.headers);
          pRes.pipe(res);
        });
        pReq.on("error", () => {
          res.writeHead(502);
          res.end("proxy error");
        });
        req.pipe(pReq);
        return;
      }
      let p = reqUrl.split("?")[0];
      if (p === "/") p = "/index.html";
      let file = join(DIST, p.replace(/^\/+/, ""));
      if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");
      res.writeHead(200, { "content-type": contentType(extname(file)) });
      res.end(readFileSync(file));
    });
    await new Promise<void>((resolve) => proxy!.listen(0, "127.0.0.1", resolve));
    const proxyAddr = proxy.address();
    if (proxyAddr === null || typeof proxyAddr === "string") throw new Error("proxy addr");
    const base = `http://127.0.0.1:${proxyAddr.port}`;

    // 4) operator JWT(run.read·workitem.read·dlq.replay)
    const token = await new SignJWT({ sub: SUBJECT, tenant_id: TENANT, roles: ["operator", "reviewer", "approver", "admin"] })
      .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("10m").sign(SECRET);

    // 5) 실 브라우저 구동
    browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (e: unknown) => pageErrors.push(e instanceof Error ? e.message : String(e)));
    page.on("dialog", (d) => void d.accept()); // 명령 확인창 자동 수락
    await page.evaluateOnNewDocument((t: string) => {
      try {
        localStorage.setItem("rpa.token", t);
      } catch {
        /* ignore */
      }
    }, token);

    // dashboard: 실 API에서 시드 run(running) 렌더 — StatusBadge가 한국어 라벨('실행 중')로 표시
    await page.goto(`${base}/`, { waitUntil: "networkidle0", timeout: 30_000 });
    await page.waitForFunction(() => document.body.innerText.includes("실행 중"), { timeout: 15_000 });
    check("실 API read → 시드 run('실행 중') 렌더", (await page.evaluate(() => document.body.innerText)).includes("실행 중"));

    // workitems: DLQ 패널에 시드 dead_letter 렌더
    await page.evaluate(() => {
      location.hash = "#workitems";
    });
    await page.waitForFunction(() => Array.from(document.querySelectorAll("button")).some((b) => b.textContent === "재처리"), { timeout: 15_000 });
    check("실 API read → workitem DLQ 렌더(재처리 버튼)", true);

    // 명령: DLQ 재처리(W10) → DB 변이 확인
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "재처리");
      (btn as HTMLButtonElement | undefined)?.click();
    });
    // 포커스 트랩 확인 다이얼로그(RQ-013) → '확인' 클릭으로 명령 디스패치(native confirm 대체).
    await page.waitForFunction(() => Array.from(document.querySelectorAll("[role=dialog] button")).some((b) => b.textContent === "확인"), { timeout: 15_000 });
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("[role=dialog] button")).find((b) => b.textContent === "확인");
      (btn as HTMLButtonElement | undefined)?.click();
    });
    // 워크아이템이 new로 전이될 때까지 폴링(실 DB)
    let workitemStatus = "";
    for (let i = 0; i < 30; i += 1) {
      workitemStatus = await withTenantTx(pool, TENANT, async (c) => {
        const r = await c.query<{ status: string }>(`SELECT status FROM workitems WHERE id=$1::uuid`, [WI]);
        return r.rows[0]?.status ?? "";
      });
      if (workitemStatus === "new") break;
      await new Promise((r) => setTimeout(r, 300));
    }
    check("DLQ 재처리(W10) → workitem abandoned→new (실 DB)", workitemStatus === "new", `status=${workitemStatus}`);
    const replayedAt = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ replayed_at: Date | null }>(`SELECT replayed_at FROM dead_letter WHERE id=$1::uuid`, [DL]);
      return r.rows[0]?.replayed_at ?? null;
    });
    check("dead_letter.replayed_at 마킹(중복 복원 방지)", replayedAt !== null);

    // 명령: 자동화 실행(run-create) — scenarioStudio '실행' 클릭(패널 열기) → '실행 시작' 클릭 → 새 queued run(실 DB).
    // 시드 IR은 nodes 없음(url_ref 키 없음) → 패널은 추가 입력 없이 '실행 시작' 활성.
    await page.evaluate(() => {
      location.hash = "#scenarioStudio";
    });
    await page.waitForFunction(() => Array.from(document.querySelectorAll("button")).some((b) => b.textContent === "실행"), { timeout: 15_000 });
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "실행");
      (btn as HTMLButtonElement | undefined)?.click();
    });
    await page.waitForFunction(() => Array.from(document.querySelectorAll("button")).some((b) => b.textContent === "실행 시작"), { timeout: 15_000 });
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "실행 시작");
      (btn as HTMLButtonElement | undefined)?.click();
    });
    let queuedRuns = 0;
    for (let i = 0; i < 30; i += 1) {
      queuedRuns = await withTenantTx(pool, TENANT, async (c) => {
        const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM runs WHERE scenario_version_id=$1::uuid AND status='queued'`, [SVER]);
        return Number(r.rows[0]?.n ?? "0");
      });
      if (queuedRuns >= 1) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    check("자동화 실행(run-create) → 새 queued run (실 DB)", queuedRuns >= 1, `queued=${queuedRuns}`);

    // 명령: 사람확인 처리완료(resolve) — humanTasks '처리완료' 클릭 → task resolved + 연계 run resume_requested(H3+R13).
    await page.evaluate(() => {
      location.hash = "#humanTasks";
    });
    await page.waitForFunction(() => Array.from(document.querySelectorAll("button")).some((b) => b.textContent === "처리완료"), { timeout: 15_000 });
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "처리완료");
      (btn as HTMLButtonElement | undefined)?.click();
    });
    // 포커스 트랩 확인 다이얼로그(RQ-013) → '확인' 클릭.
    await page.waitForFunction(() => Array.from(document.querySelectorAll("[role=dialog] button")).some((b) => b.textContent === "확인"), { timeout: 15_000 });
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("[role=dialog] button")).find((b) => b.textContent === "확인");
      (btn as HTMLButtonElement | undefined)?.click();
    });
    let htState = "";
    let suspRunState = "";
    for (let i = 0; i < 30; i += 1) {
      const row = await withTenantTx(pool, TENANT, async (c) => {
        const ht = await c.query<{ state: string }>(`SELECT state FROM human_tasks WHERE id=$1::uuid`, [HT]);
        const run = await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [RUN_SUSP]);
        return { task: ht.rows[0]?.state ?? "", run: run.rows[0]?.status ?? "" };
      });
      htState = row.task;
      suspRunState = row.run;
      if (htState === "resolved" && suspRunState === "resume_requested") break;
      await new Promise((r) => setTimeout(r, 300));
    }
    check("사람확인 처리완료(resolve) → human_task resolved (실 DB)", htState === "resolved", `state=${htState}`);
    check("처리완료 → 연계 run resume_requested (R13, 실 DB)", suspRunState === "resume_requested", `run=${suspRunState}`);

    check("브라우저 페이지 에러 없음", pageErrors.length === 0, pageErrors.join("; "));
  } finally {
    if (browser !== null) await browser.close();
    if (proxy !== null) await new Promise<void>((resolve) => proxy!.close(() => resolve()));
    if (api !== null) await api.close();
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D7 console LIVE e2e green (browser → Fastify → PostgreSQL, read + W10 replay)");
  process.exit(0);
}

main().catch((e) => {
  console.error("live e2e fatal:", e);
  process.exit(1);
});
