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

// 응답 본문 디코드: content-type charset 기준(EUC-KR/CP949 등 비-UTF-8 한국 레거시 포털 대응). puppeteer 의 res.text()
// 는 fatal-UTF-8 이라 비-UTF-8 본문에서 throw → 캡처가 무음 실패하므로, 바이트(res.buffer())를 직접 best-effort 디코드한다.
// 미선언/미지원 charset 라벨은 utf-8 비-fatal 폴백(불량 바이트는 U+FFFD; throw 없음).
function decodeBody(buf: Buffer, contentType: string): string {
  const m = /charset=["']?([\w-]+)/i.exec(contentType);
  let label = (m?.[1] ?? "utf-8").toLowerCase();
  if (label === "cp949" || label === "ms949" || label === "uhc") label = "euc-kr"; // WHATWG 라벨 정규화(EUC-KR/UHC 동의어)
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    defaultViewport: null,
    args: ["--no-first-run", "--start-maximized"],
  });
  try {
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    const recs: Rec[] = [];

    // 응답 핸들러는 res.buffer() 를 await 한 뒤 recs 에 push 하므로, 본문이 늦게 resolve 되는 응답은 push 가 지연된다.
    // 핸들러 promise 를 pending 에 모아 스냅샷 전에 모두 기다린다(늦게 도착한 getBbsList.json 누락 → 0건 오보고 방지).
    const pending: Promise<void>[] = [];
    const record = async (res: HTTPResponse): Promise<void> => {
      const req = res.request();
      const rtype = req.resourceType();
      if (rtype !== "xhr" && rtype !== "fetch" && rtype !== "document") return;
      const url = res.url();
      // 공지 데이터·코드 관련 .json/.do 만 본문 저장(앞 6KB).
      const interesting = /getBbsList\.json|\/bbs\/|codelocaleViewSelect|\.json/i.test(url);
      let resBody = "";
      if (interesting) {
        try {
          resBody = decodeBody(await res.buffer(), res.headers()["content-type"] ?? "").slice(0, 6000);
        } catch {
          // res.buffer() 자체 실패(리다이렉트/캐시/evicted body 등) — 디코드 실패가 아닌 본문 부재.
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
    };
    page.on("response", (res: HTTPResponse) => void pending.push(record(res)));

    console.log(`→ 공지 페이지 로드: ${TARGET}\n`);
    await page.goto(TARGET, { waitUntil: "networkidle2", timeout: 60_000 }).catch((e) => console.error("goto 경고:", String(e)));
    await sleep(5000); // 그리드 fn_search() AJAX 정착 대기
    await Promise.allSettled(pending); // 진행 중인 본문 읽기 완료 대기

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
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("capture fatal:", e);
  process.exit(1);
});
