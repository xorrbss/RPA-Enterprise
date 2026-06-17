/**
 * 삼성디스플레이 게스트 포털 공지(bbs) 엔드포인트 캡처 — getBbsList.json 요청/응답 실측.
 * 실행: npx tsx capture-bbs.ts ["<공지 iframe URL>"]  (기본 bbsHPNO.do)
 */
import { writeFileSync } from "node:fs";

import puppeteer, { type HTTPResponse } from "puppeteer-core";

const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const TARGET = process.argv[2] ?? "https://guest.samsungdisplay.com/bbs/bbsHPNO.do";

type Rec = {
  url: string;
  method: string;
  status: number;
  contentType: string;
  reqBody: string | null;
  resBody: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    defaultViewport: null,
    args: ["--no-first-run", "--start-maximized"],
  });
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  const recs: Rec[] = [];

  page.on("response", async (res: HTTPResponse) => {
    const req = res.request();
    const rtype = req.resourceType();
    if (rtype !== "xhr" && rtype !== "fetch" && rtype !== "document") return;
    const url = res.url();
    // 공지 데이터·코드 관련 .json/.do 만 본문 저장(앞 6KB).
    const interesting = /getBbsList\.json|\/bbs\/|codelocaleViewSelect|\.json/i.test(url);
    let resBody = "";
    if (interesting) {
      try {
        resBody = (await res.text()).slice(0, 6000);
      } catch {
        resBody = "<본문 읽기 실패>";
      }
    }
    recs.push({
      url,
      method: req.method(),
      status: res.status(),
      contentType: res.headers()["content-type"] ?? "",
      reqBody: req.postData() ?? null,
      resBody,
    });
  });

  console.log(`→ 공지 페이지 로드: ${TARGET}\n`);
  await page.goto(TARGET, { waitUntil: "networkidle2", timeout: 60_000 }).catch((e) => console.error("goto 경고:", String(e)));
  await sleep(5000); // 그리드 fn_search() AJAX 정착 대기

  const bbs = recs.filter((r) => /getBbsList\.json/i.test(r.url));
  console.log(`=== getBbsList.json (${bbs.length}건) ===`);
  for (const b of bbs) {
    console.log(`\n[${b.status}] ${b.method} ${b.url}`);
    console.log(`  content-type: ${b.contentType}`);
    console.log(`  요청 본문: ${b.reqBody ?? "(없음)"}`);
    console.log(`  응답 본문(앞 1.2KB): ${(b.resBody || "").slice(0, 1200)}`);
  }

  console.log(`\n=== 전체 요청 ${recs.length}건 ===`);
  for (const r of recs) console.log(`  [${r.status}] ${r.method} ${r.url}`);

  writeFileSync(new URL("./capture-bbs-output.json", import.meta.url), JSON.stringify(recs, null, 2));
  console.log(`\n→ capture-bbs-output.json 저장 완료`);

  await browser.close();
}

main().catch((e) => {
  console.error("capture fatal:", e);
  process.exit(1);
});
