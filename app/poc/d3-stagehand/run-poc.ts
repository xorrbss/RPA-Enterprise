/**
 * D3 PoC 러너 — architecture.md §9.2 Stagehand v3 결정형 CDP page API 커버리지 10항목 실측.
 *
 * 각 항목: PASS(고수준 메서드) / PASS(sendCDP — 동일 세션 raw CDP, §9.5) / GAP(미지원) / ERROR.
 * Stagehand `act`/`observe`/`extract`(LLM) 미사용 — §9.1 결정형 utility + PageStateResolver 우선.
 * 결과를 콘솔 표 + D3-POC-EVIDENCE.md 로 기록(가정 금지: 라이브 실행 증거).
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Stagehand } from "@browserbasehq/stagehand";

import { FIXTURE_ORIGIN, startFixtureServer } from "./fixture.js";
import { PAGESTATE_FLAG_KEYS, resolvePageState, type CdpPage } from "./pagestate.js";

const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

interface Locator {
  setInputFiles(files: string | string[]): Promise<void>;
  click(opts?: object): Promise<void>;
  fill(value: string): Promise<void>;
  type(text: string, opts?: object): Promise<void>;
  count(): Promise<number>;
}
interface PocPage extends CdpPage {
  goto(url: string, opts?: object): Promise<unknown>;
  reload(opts?: object): Promise<unknown>;
  title(): Promise<string>;
  locator(sel: string): Locator;
}

type Status = "PASS" | "PASS(sendCDP)" | "GAP" | "ERROR";
type Result = { n: number; name: string; status: Status; via: string; detail: string };

const results: Result[] = [];
const rec = (n: number, name: string, status: Status, via: string, detail: string) =>
  results.push({ n, name, status, via, detail });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = await startFixtureServer();
  const downloadDir = mkdtempSync(join(tmpdir(), "d3poc-dl-"));
  const cdpDownloadDir = mkdtempSync(join(tmpdir(), "d3poc-cdpdl-"));
  const uploadFile = join(tmpdir(), "d3poc-upload.txt");
  writeFileSync(uploadFile, "hello-upload");

  const sh = new Stagehand({
    env: "LOCAL",
    verbose: 0,
    disablePino: true,
    localBrowserLaunchOptions: {
      executablePath: CHROME,
      headless: true,
      acceptDownloads: true,
      downloadsPath: downloadDir,
    },
  });

  await sh.init();
  const ctx = sh.context;
  const page = (await ctx.newPage(`${FIXTURE_ORIGIN}/?auth=authed&data=reviews&next=1`)) as unknown as PocPage;

  // ── 1. navigate(goto)/reload ──────────────────────────────────────────────
  try {
    await page.goto(`${FIXTURE_ORIGIN}/?auth=authed&data=reviews&next=1`);
    const t1 = await page.title();
    await page.reload();
    const t2 = await page.title();
    rec(1, "navigate(goto)/reload", "PASS", "page.goto/reload", `title="${t1}" reload-title="${t2}"`);
  } catch (e) {
    rec(1, "navigate(goto)/reload", "ERROR", "page.goto/reload", String(e));
  }

  // ── 2. DOM structuralHash (landmark role/name path 정규화) ─────────────────
  try {
    const a = await resolvePageState(page);
    await page.reload();
    const b = await resolvePageState(page);
    const stable = a.dom.structuralHash === b.dom.structuralHash;
    rec(
      2,
      "DOM structuralHash",
      stable ? "PASS(sendCDP)" : "GAP",
      "Accessibility.getFullAXTree via page.sendCDP",
      `hash=${a.dom.structuralHash} stable-on-reload=${stable} landmarks=${a.dom.landmarks.length}`,
    );
  } catch (e) {
    rec(2, "DOM structuralHash", "ERROR", "sendCDP", String(e));
  }

  // ── 3. visibleTextHash · landmarks[] · frames[](iframe) ───────────────────
  try {
    const ps = await resolvePageState(page);
    const roles = ps.dom.landmarks.map((l) => l.role);
    const hasCore = ["banner", "navigation", "main", "contentinfo"].every((r) => roles.includes(r));
    const okFrames = ps.dom.frames.length >= 1;
    rec(
      3,
      "visibleTextHash·landmarks·frames",
      hasCore && okFrames && ps.dom.visibleTextHash.length > 0 ? "PASS(sendCDP)" : "GAP",
      "page.evaluate + AXTree + page.frames()",
      `roles=[${roles.join(",")}] frames=${ps.dom.frames.length} textHash=${ps.dom.visibleTextHash}`,
    );
  } catch (e) {
    rec(3, "visibleTextHash·landmarks·frames", "ERROR", "evaluate/AXTree", String(e));
  }

  // ── 4. element by selector / role+name ────────────────────────────────────
  try {
    const bySel = await page.locator("#dl").count();
    // role+name: a11y 트리에서 role=button & name="로그아웃" 매칭(고수준 getByRole 부재 → AXTree).
    const { nodes } = await page.sendCDP<{ nodes: Array<{ role?: { value?: string }; name?: { value?: string } }> }>(
      "Accessibility.getFullAXTree",
    );
    const byRoleName = nodes.some((n) => n.role?.value === "button" && n.name?.value === "로그아웃");
    const status: Status = bySel >= 1 && byRoleName ? "PASS(sendCDP)" : bySel >= 1 ? "GAP" : "ERROR";
    rec(
      4,
      "element by selector / role+name",
      status,
      "page.locator(css) + AXTree role/name match",
      `selector#dl=${bySel} role=button,name=로그아웃 matched=${byRoleName}`,
    );
  } catch (e) {
    rec(4, "element by selector / role+name", "ERROR", "locator/AXTree", String(e));
  }

  // ── 5. download (파일 캡처 + download_dir_ref 격리) ───────────────────────
  try {
    // 5a) 격리 디렉토리 지정: Browser.setDownloadBehavior(eventsEnabled) via sendCDP.
    await page.sendCDP("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: cdpDownloadDir,
      eventsEnabled: true,
    });
    await page.locator("#dl").click();
    let files: string[] = [];
    for (let i = 0; i < 20; i++) {
      files = readdirSync(cdpDownloadDir).filter((f) => !f.endsWith(".crdownload"));
      if (files.includes("report.csv")) break;
      await sleep(150);
    }
    const got = files.includes("report.csv");
    rec(
      5,
      "download (+dir 격리)",
      got ? "PASS(sendCDP)" : "GAP",
      "Browser.setDownloadBehavior(downloadPath) via sendCDP",
      `dir=<temp>/d3poc-cdpdl-* files=[${files.join(",")}]`,
    );
  } catch (e) {
    rec(5, "download (+dir 격리)", "ERROR", "sendCDP/click", String(e));
  }

  // ── 6. upload (file input) ────────────────────────────────────────────────
  try {
    await page.locator("#file").setInputFiles(uploadFile);
    const attached = await page.evaluate<string>(
      `(() => { const i = document.querySelector('#file'); return i && i.files[0] ? i.files[0].name : ''; })()`,
    );
    rec(
      6,
      "upload (file input)",
      attached.length > 0 ? "PASS" : "GAP",
      "locator.setInputFiles",
      `attached="${attached}"`,
    );
  } catch (e) {
    rec(6, "upload (file input)", "ERROR", "setInputFiles", String(e));
  }

  // ── 7. click/type (결정형 동작) ───────────────────────────────────────────
  try {
    await page.locator("#q").fill("리뷰검색");
    const filled = await page.evaluate<string>(
      `(() => { const i = document.querySelector('#q'); return i ? i.value : ''; })()`,
    );
    await page.locator('[data-action="submit"]').click();
    rec(
      7,
      "click/type",
      filled === "리뷰검색" ? "PASS" : "GAP",
      "locator.fill + locator.click",
      `filled="${filled}"`,
    );
  } catch (e) {
    rec(7, "click/type", "ERROR", "fill/click", String(e));
  }

  // ── 8. auth 상태 감지(anonymous/authenticated/expired) ────────────────────
  try {
    const cases: Array<[string, string]> = [
      ["authed", "authenticated"],
      ["anon", "anonymous"],
      ["expired", "expired"],
    ];
    const observed: string[] = [];
    let allOk = true;
    for (const [q, want] of cases) {
      await page.goto(`${FIXTURE_ORIGIN}/?auth=${q}&data=reviews&next=1`);
      const ps = await resolvePageState(page);
      observed.push(`${q}->${ps.auth}`);
      if (ps.auth !== want) allOk = false;
    }
    rec(8, "auth 상태 감지", allOk ? "PASS(sendCDP)" : "GAP", "PageStateResolver.auth", observed.join(" "));
  } catch (e) {
    rec(8, "auth 상태 감지", "ERROR", "resolvePageState", String(e));
  }

  // ── 9. flags 산출(닫힌 레지스트리) ────────────────────────────────────────
  try {
    await page.goto(`${FIXTURE_ORIGIN}/?auth=authed&data=reviews&next=1`);
    const f1 = (await resolvePageState(page)).flags;
    await page.goto(`${FIXTURE_ORIGIN}/?auth=authed&data=empty&next=0&login=1&block=1`);
    const f2 = (await resolvePageState(page)).flags;
    const onlyRegistered = [...Object.keys(f1), ...Object.keys(f2)].every((k) =>
      (PAGESTATE_FLAG_KEYS as readonly string[]).includes(k),
    );
    const ok =
      onlyRegistered &&
      f1.reviews_visible === true &&
      f1.no_next_page === false &&
      f2.reviews_visible === false &&
      f2.no_review_message_visible === true &&
      f2.no_next_page === true &&
      f2.login_required === true &&
      f2.blocked === true;
    rec(
      9,
      "flags 산출(닫힌 레지스트리)",
      ok ? "PASS(sendCDP)" : "GAP",
      "PageStateResolver.flags",
      `reviews=${JSON.stringify(f1)} | empty=${JSON.stringify(f2)} closedRegistry=${onlyRegistered}`,
    );
  } catch (e) {
    rec(9, "flags 산출(닫힌 레지스트리)", "ERROR", "resolvePageState", String(e));
  }

  // ── 10. abort(AbortSignal → CDP 세션 close) ───────────────────────────────
  try {
    const ac = new AbortController();
    ac.signal.addEventListener("abort", () => void ctx.close());
    ac.abort();
    await sleep(300);
    // 발견: ctx.close() 후 in-flight sendCDP 는 reject 가 아니라 무응답으로 hang 될 수 있다.
    // 따라서 타임아웃 race 로 "응답 없음=세션 단절"을 판정한다(CDP_DISCONNECTED 계약 매핑).
    let disconnected = false;
    let how = "";
    try {
      const r = await Promise.race([
        page.sendCDP("Runtime.evaluate", { expression: "1+1" }).then(() => "responded" as const),
        sleep(1500).then(() => "timeout" as const),
      ]);
      disconnected = r === "timeout";
      how = r;
    } catch {
      disconnected = true; // 즉시 거부
      how = "threw";
    }
    rec(
      10,
      "abort → CDP close",
      disconnected ? "PASS(sendCDP)" : "GAP",
      "AbortSignal → ctx.close(); post-abort sendCDP unusable",
      `post-abort sendCDP=${how} (disconnected=${disconnected})`,
    );
  } catch (e) {
    rec(10, "abort → CDP close", "ERROR", "abort", String(e));
  }

  // ── report 우선(teardown 전) ──────────────────────────────────────────────
  // item 10 이 ctx 를 close 한 뒤 sh.close() 가 이미 닫힌 세션에서 블로킹될 수 있어,
  // 증거 기록을 teardown 보다 먼저 수행한다(가정 금지: 실측 결과 유실 방지).
  report();

  // ── best-effort teardown(타임아웃 race) ───────────────────────────────────
  server.close();
  await Promise.race([sh.close().catch(() => {}), sleep(3000)]);
  rmSync(downloadDir, { recursive: true, force: true });
  rmSync(cdpDownloadDir, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0); // chrome 잔여 subprocess 가 이벤트 루프를 잡아도 강제 종료
}

function report() {
  const pass = results.filter((r) => r.status.startsWith("PASS")).length;
  console.log("\n=== D3 PoC — Stagehand v3 결정형 CDP page API 커버리지 (architecture.md §9.2) ===\n");
  for (const r of results) {
    console.log(`[${r.status.padEnd(13)}] #${String(r.n).padStart(2)} ${r.name}`);
    console.log(`               via: ${r.via}`);
    console.log(`               ${r.detail}`);
  }
  console.log(`\n결과: ${pass}/${results.length} PASS\n`);

  const md = buildEvidenceMd(pass);
  writeFileSync(new URL("./D3-POC-EVIDENCE.md", import.meta.url), md);
  console.log("→ D3-POC-EVIDENCE.md written");
  if (pass < results.length) process.exitCode = 1;
}

function buildEvidenceMd(pass: number): string {
  const rows = results
    .map((r) => `| ${r.n} | ${r.name} | \`${r.status}\` | ${r.via} | ${r.detail.replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# D3 PoC 증거 — Stagehand v3 결정형 CDP page API 커버리지

> architecture.md §9.2 체크리스트 10항목을 **실제 Stagehand v3 (@browserbasehq/stagehand@3.5.0) + 로컬 Chrome CDP**
> 세션으로 실측한 결과. \`act\`/\`observe\`/\`extract\`(LLM) 미사용 — §9.1 결정형 utility + PageStateResolver 우선.
> 재현: \`npm install && npm run poc\` (app/poc/d3-stagehand).

**결과: ${pass}/${results.length} PASS**

| # | 필요 기능 | 상태 | 경로(via) | 증거 |
|---|---|---|---|---|
${rows}

## 분류 기준
- \`PASS\` — Stagehand v3 전용 고수준 메서드로 충족(goto/reload/locator/setInputFiles 등).
- \`PASS(sendCDP)\` — Stagehand 공개 \`page.sendCDP()\`로 **동일 CDP 세션** raw CDP 호출(§9.5의 "갭→raw CDP 동일 세션 보완"이 API 내부 경로로 충족됨). 별도 외부 드라이버 불요.
- \`GAP\` — 위 두 경로로도 미충족(진짜 블로커). \`ERROR\` — 실행 예외.

## D3 수용 기준(§9.4) 매핑
- UtilityExecutor + PageStateResolver가 Stagehand \`act\` 없이 flags·structuralHash 산출 → #2·#3·#8·#9 로 입증.
- raw CDP 보완 경로는 모두 \`page.sendCDP()\`(동일 세션)로 확정 — 외부 라이브러리 추가 없음.
`;
}

main().catch((e) => {
  console.error("PoC fatal:", e);
  process.exitCode = 1;
});
