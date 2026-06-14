/**
 * D3 PoC fixture — 결정형 테스트 페이지 + 최소 HTTP 서버.
 *
 * architecture.md §9.2 10항목을 실측하기 위한 랜드마크/iframe/파일입력/role+name 버튼/
 * 로그인 상태/다운로드/페이지네이션을 포함한 단일 페이지. file:// 의 다운로드·iframe 제약을
 * 피하려 로컬 http로 제공한다. 외부 네트워크 의존 없음(가정 금지: 라이브 사이트 미사용).
 *
 * 쿼리로 상태 토글: ?auth=anon|authed|expired & data=reviews|empty & next=1|0 & login=1|0 & block=1|0
 */
import { createServer, type Server } from "node:http";

export const FIXTURE_PORT = 39271;
export const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;

const FRAME_DOC = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>frame</title></head>
<body><main role="main"><h1>임베디드 프레임</h1><p data-frame-marker>iframe content</p></main></body></html>`;

function mainDoc(q: URLSearchParams): string {
  const auth = q.get("auth") ?? "authed"; // anon | authed | expired
  const data = q.get("data") ?? "reviews"; // reviews | empty
  const hasNext = (q.get("next") ?? "1") === "1";
  const login = q.get("login") === "1";
  const block = q.get("block") === "1";

  const authAttr =
    auth === "anon" ? "anonymous" : auth === "expired" ? "expired" : "authenticated";

  const reviews =
    data === "reviews"
      ? `<ul data-landmark="reviews">
           <li class="review-item">리뷰 A</li>
           <li class="review-item">리뷰 B</li>
           <li class="review-item">리뷰 C</li>
         </ul>`
      : `<p data-empty-msg>표시할 리뷰가 없습니다</p>`;

  const next = hasNext
    ? `<a rel="next" href="?page=2" role="link">다음 페이지</a>`
    : `<a rel="next" href="#" role="link" aria-disabled="true">다음 페이지</a>`;

  const loginBlock = login
    ? `<section data-login-required role="region" aria-label="로그인"><h2>로그인이 필요합니다</h2></section>`
    : "";
  const blockBlock = block
    ? `<section data-block-page role="region" aria-label="차단"><h2>비정상 트래픽이 감지되었습니다</h2></section>`
    : "";

  const logoutBtn =
    authAttr === "authenticated"
      ? `<button type="button" data-action="logout">로그아웃</button>`
      : "";

  return `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><title>D3 PoC fixture</title></head>
<body data-auth="${authAttr}">
  <header role="banner"><h1>상점 콘솔</h1></header>
  <nav role="navigation" aria-label="주 메뉴"><a href="#a">홈</a><a href="#b">리뷰</a></nav>
  <main role="main">
    <h2>리뷰 목록</h2>
    ${reviews}
    ${next}
    ${loginBlock}
    ${blockBlock}
    <form id="uploadForm" data-landmark="upload" onsubmit="return false">
      <label for="q">검색</label>
      <input id="q" name="q" type="text" aria-label="검색">
      <label for="file">첨부</label>
      <input id="file" name="file" type="file">
      <button type="button" data-action="submit">제출</button>
    </form>
    <p><a id="dl" href="/download/report.csv" download>리포트 받기</a></p>
    <iframe src="/frame" title="embedded" width="320" height="120"></iframe>
    ${logoutBtn}
  </main>
  <footer role="contentinfo"><small>© PoC</small></footer>
</body>
</html>`;
}

export function startFixtureServer(): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", FIXTURE_ORIGIN);
    if (url.pathname === "/frame") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(FRAME_DOC);
      return;
    }
    if (url.pathname === "/download/report.csv") {
      const body = "id,score\n1,5\n2,4\n";
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="report.csv"',
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    if (url.pathname === "/upload" && req.method === "POST") {
      let bytes = 0;
      req.on("data", (c) => (bytes += c.length));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, received: bytes }));
      });
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(mainDoc(url.searchParams));
      return;
    }
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end("<body data-not-found><h1>404</h1></body>");
  });
  return new Promise((resolve) => server.listen(FIXTURE_PORT, "127.0.0.1", () => resolve(server)));
}
