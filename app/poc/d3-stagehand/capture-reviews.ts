/**
 * 쿠팡 리뷰 엔드포인트/DOM 캡처기 — 본인 판매 상품의 공개 리뷰 수집 설계용 기초 데이터 수집.
 *
 * 목적: 상품 페이지를 "실제 Chrome"으로 띄워, 리뷰 위젯이 호출하는 XHR/fetch 요청(URL·파라미터·
 *       응답 샘플)과 리뷰 DOM 구조를 실측 덤프한다. (가정 금지: 엔드포인트를 추측하지 않고 라이브로 캡처)
 *
 * 왜 puppeteer-core 직접 사용:
 *   - d3-stagehand 의존성에 이미 puppeteer-core(^24)가 있어 추가 설치 불요(기존 구조 재사용).
 *   - 네트워크 응답 본문 캡처는 page.on('response')가 가장 단순·확실(KISS).
 *
 * 실행:
 *   cd app/poc/d3-stagehand
 *   npx tsx capture-reviews.ts "<상품페이지 URL>"
 *   # 또는: PRODUCT_URL="https://www.coupang.com/vp/products/..." npx tsx capture-reviews.ts
 *
 * 봇 차단 통과 팁(권장):
 *   - 본인 셀러 계정으로 로그인된 실제 Chrome 프로필을 재사용하면 통과율↑.
 *     Chrome 완전 종료 후:  CHROME_USER_DATA_DIR="C:\\Users\\<you>\\AppData\\Local\\Google\\Chrome\\User Data" 지정.
 *   - headless=false(기본)로 띄워 사람이 직접 캡차/로그인 처리 가능.
 *
 * 산출물:
 *   - 콘솔: 캡처된 리뷰 후보 요청 목록 + 전체 XHR 목록 + 리뷰 DOM 스니펫.
 *   - capture-reviews-output.json: 위 전체를 기계가독 형태로 저장(셀렉터/파라미터 도출용).
 */
import { writeFileSync } from "node:fs";

import puppeteer, { type HTTPResponse } from "puppeteer-core";

const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR; // 지정 시 로그인된 실제 프로필 재사용
const PRODUCT_URL = process.argv[2] ?? process.env.PRODUCT_URL;

// 리뷰 관련으로 의심되는 요청 식별(URL/리소스타입 기준). 누락 방지 위해 넓게 잡고, 전체 목록도 따로 보존.
const REVIEW_HINT = /review|sdp.?review|ratingsummary|productreview/i;

type Captured = {
  url: string;
  method: string;
  resourceType: string;
  status: number;
  contentType: string;
  reqHeaders: Record<string, string>;
  bodySample: string; // 앞부분만(2KB)
  isReviewCandidate: boolean;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!PRODUCT_URL) {
    console.error('사용법: npx tsx capture-reviews.ts "<쿠팡 상품페이지 URL>"');
    process.exit(2);
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false, // 사람이 캡차/로그인 처리 + 봇 탐지 회피
    defaultViewport: null,
    userDataDir: USER_DATA_DIR, // undefined면 임시 프로필
    args: ["--no-first-run", "--start-maximized"],
  });

  const captured: Captured[] = [];
  const seen = new Set<string>();

  const page = (await browser.pages())[0] ?? (await browser.newPage());

  // ── 모든 XHR/fetch 응답 캡처 ───────────────────────────────────────────────
  page.on("response", async (res: HTTPResponse) => {
    const req = res.request();
    const rtype = req.resourceType();
    if (rtype !== "xhr" && rtype !== "fetch" && rtype !== "document") return;
    const url = res.url();
    const key = `${req.method()} ${url}`;
    if (seen.has(key)) return;
    seen.add(key);

    const isReviewCandidate = REVIEW_HINT.test(url);
    let bodySample = "";
    // 리뷰 후보만 본문 일부 저장(불필요 트래픽 본문 보존 금지).
    if (isReviewCandidate) {
      try {
        const text = await res.text();
        bodySample = text.slice(0, 2048);
      } catch {
        bodySample = "<본문 읽기 실패(리다이렉트/바이너리)>";
      }
    }
    captured.push({
      url,
      method: req.method(),
      resourceType: rtype,
      status: res.status(),
      contentType: res.headers()["content-type"] ?? "",
      reqHeaders: req.headers(),
      bodySample,
      isReviewCandidate,
    });
  });

  console.log(`\n→ 상품 페이지 로드: ${PRODUCT_URL}\n`);
  await page.goto(PRODUCT_URL, { waitUntil: "networkidle2", timeout: 60_000 }).catch((e) => {
    console.error("goto 경고:", String(e));
  });

  // ── 리뷰 위젯 트리거: 리뷰 탭 클릭 시도 + 점진 스크롤(lazy AJAX 유발) ───────
  await clickReviewTab(page);
  await autoScroll(page);
  await sleep(2500); // 마지막 AJAX 정착 대기

  // ── 리뷰 DOM 스니펫 추출(셀렉터 도출용) ──────────────────────────────────
  const domSnippet = await page
    .evaluate(() => {
      // 별점/리뷰 텍스트가 들어있을 법한 컨테이너를 휴리스틱으로 탐색.
      const cand = Array.from(document.querySelectorAll("article, li, div")).filter((el) => {
        const cls = (el.className || "").toString().toLowerCase();
        return /review|rating|sdp.?review/.test(cls);
      });
      const sample = cand.slice(0, 3).map((el) => ({
        tag: el.tagName.toLowerCase(),
        className: (el.className || "").toString(),
        outerHTMLHead: el.outerHTML.slice(0, 800),
      }));
      // 페이지네이션 후보
      const pager = Array.from(document.querySelectorAll("[class*='pagination'], [class*='paging'], button, a"))
        .filter((el) => /\d/.test(el.textContent || "") && /pag/i.test((el.className || "").toString()))
        .slice(0, 5)
        .map((el) => ({ tag: el.tagName.toLowerCase(), className: (el.className || "").toString(), text: (el.textContent || "").trim().slice(0, 30) }));
      return { reviewContainers: sample, paginationCandidates: pager, title: document.title };
    })
    .catch((e) => ({ error: String(e) }));

  // ── 리포트 ────────────────────────────────────────────────────────────────
  const reviewReqs = captured.filter((c) => c.isReviewCandidate);
  console.log(`\n=== 리뷰 후보 요청 ${reviewReqs.length}건 ===`);
  for (const c of reviewReqs) {
    console.log(`\n[${c.status}] ${c.method} ${c.url}`);
    console.log(`  content-type: ${c.contentType}`);
    console.log(`  본문 샘플(앞 200자): ${c.bodySample.slice(0, 200).replace(/\s+/g, " ")}`);
  }
  console.log(`\n=== 전체 XHR/fetch ${captured.length}건(URL만) ===`);
  for (const c of captured) console.log(`  ${c.isReviewCandidate ? "★" : " "} [${c.status}] ${c.method} ${c.url}`);

  console.log(`\n=== 리뷰 DOM 스니펫 ===`);
  console.log(JSON.stringify(domSnippet, null, 2));

  const out = { productUrl: PRODUCT_URL, capturedAt: new Date().toISOString(), reviewRequests: reviewReqs, allRequests: captured, domSnippet };
  writeFileSync(new URL("./capture-reviews-output.json", import.meta.url), JSON.stringify(out, null, 2));
  console.log(`\n→ capture-reviews-output.json 저장 완료`);
  console.log(`\n(브라우저는 열린 채로 둡니다 — 캡차/로그인이 필요했다면 처리 후 다시 실행하세요. 종료: 창 닫기)`);

  // 브라우저는 유지(사람이 확인 가능). 종료하려면 주석 해제:
  // await browser.close();
}

/** "상품평/리뷰" 텍스트를 가진 탭/버튼을 찾아 클릭(있으면). */
async function clickReviewTab(page: import("puppeteer-core").Page): Promise<void> {
  try {
    const clicked = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll("a, button, li, span, div"));
      const target = els.find((el) => /상품평|리뷰|review/i.test((el.textContent || "").trim()) && (el.textContent || "").trim().length < 12);
      if (target) {
        (target as HTMLElement).click();
        return (target.textContent || "").trim();
      }
      return null;
    });
    if (clicked) console.log(`  리뷰 탭 클릭: "${clicked}"`);
  } catch {
    /* 무시 — 탭이 없거나 SPA 구조 차이 */
  }
}

/** 페이지 하단까지 점진 스크롤 — lazy 로드 AJAX 유발. */
async function autoScroll(page: import("puppeteer-core").Page): Promise<void> {
  await page
    .evaluate(async () => {
      await new Promise<void>((resolve) => {
        let total = 0;
        const step = 600;
        const timer = setInterval(() => {
          window.scrollBy(0, step);
          total += step;
          if (total >= document.body.scrollHeight - window.innerHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 300);
      });
    })
    .catch(() => {});
}

main().catch((e) => {
  console.error("capture fatal:", e);
  process.exit(1);
});
