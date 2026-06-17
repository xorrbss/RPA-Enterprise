/**
 * 삼성 공지 그리드 렌더 DOM 덤프 — page_state 마커/extract용 셀렉터 도출.
 */
import { writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const TARGET = process.argv[2] ?? "https://guest.samsungdisplay.com/bbs/bbsHPNO.do";

async function main() {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: false, defaultViewport: null, args: ["--no-first-run"] });
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.goto(TARGET, { waitUntil: "networkidle2", timeout: 60_000 }).catch((e) => console.error("goto:", String(e)));
  await new Promise((r) => setTimeout(r, 6000)); // 그리드 렌더 대기

  const dom = await page.evaluate(() => {
    const grid = document.querySelector("#bbsGridDiv");
    // 그리드 안 클래스 빈도(행/셀 셀렉터 후보 도출)
    const classCount: Record<string, number> = {};
    grid?.querySelectorAll("[class]").forEach((el) => {
      (el.className || "").toString().split(/\s+/).forEach((c) => { if (c) classCount[c] = (classCount[c] || 0) + 1; });
    });
    const topClasses = Object.entries(classCount).sort((a, b) => b[1] - a[1]).slice(0, 25);
    // 제목 텍스트가 보이는지(추출 가능성 확인)
    const firstTitles = Array.from(grid?.querySelectorAll(".grid-type-cell-label, td, [role='gridcell']") ?? [])
      .map((e) => (e.textContent || "").trim()).filter((t) => t.length > 0).slice(0, 8);
    return {
      gridExists: !!grid,
      gridOuterHead: grid ? grid.outerHTML.slice(0, 1500) : "(#bbsGridDiv 없음)",
      topClassesInGrid: topClasses,
      firstCellTexts: firstTitles,
    };
  }).catch((e) => ({ error: String(e) }));

  console.log(JSON.stringify(dom, null, 2));
  writeFileSync(new URL("./capture-grid-dom-output.json", import.meta.url), JSON.stringify(dom, null, 2));
  await browser.close();
}
main().catch((e) => { console.error("fatal:", e); process.exit(1); });
