# D3 PoC 증거 — Stagehand v3 결정형 CDP page API 커버리지

> architecture.md §9.2 체크리스트 10항목을 **실제 Stagehand v3 (@browserbasehq/stagehand@3.5.0) + 로컬 Chrome CDP**
> 세션으로 실측한 결과. `act`/`observe`/`extract`(LLM) 미사용 — §9.1 결정형 utility + PageStateResolver 우선.
> 재현: `npm install && npm run poc` (app/poc/d3-stagehand).

**결과: 10/10 PASS**

| # | 필요 기능 | 상태 | 경로(via) | 증거 |
|---|---|---|---|---|
| 1 | navigate(goto)/reload | `PASS` | page.goto/reload | title="D3 PoC fixture" reload-title="D3 PoC fixture" |
| 2 | DOM structuralHash | `PASS(sendCDP)` | Accessibility.getFullAXTree via page.sendCDP | hash=53c329e45996f268 stable-on-reload=true landmarks=5 |
| 3 | visibleTextHash·landmarks·frames | `PASS(sendCDP)` | page.evaluate + AXTree + page.frames() | roles=[banner,navigation,main,contentinfo,form] frames=1 textHash=8ff03a60793db9a7 |
| 4 | element by selector / role+name | `PASS(sendCDP)` | page.locator(css) + AXTree role/name match | selector#dl=1 role=button,name=로그아웃 matched=true |
| 5 | download (+dir 격리) | `PASS(sendCDP)` | Browser.setDownloadBehavior(downloadPath) via sendCDP | dir=<temp>/d3poc-cdpdl-* files=[report.csv] |
| 6 | upload (file input) | `PASS` | locator.setInputFiles | attached="d3poc-upload.txt" |
| 7 | click/type | `PASS` | locator.fill + locator.click | filled="리뷰검색" |
| 8 | auth 상태 감지 | `PASS(sendCDP)` | PageStateResolver.auth | authed->authenticated anon->anonymous expired->expired |
| 9 | flags 산출(닫힌 레지스트리) | `PASS(sendCDP)` | PageStateResolver.flags | reviews={"no_next_page":false,"login_required":false,"blocked":false,"not_found":false,"no_review_message_visible":false,"reviews_visible":true} \| empty={"no_next_page":true,"login_required":true,"blocked":true,"not_found":false,"no_review_message_visible":true,"reviews_visible":false} closedRegistry=true |
| 10 | abort → CDP close | `PASS(sendCDP)` | AbortSignal → ctx.close(); post-abort sendCDP unusable | post-abort sendCDP=timeout (disconnected=true) |

## 분류 기준
- `PASS` — Stagehand v3 전용 고수준 메서드로 충족(goto/reload/locator/setInputFiles 등).
- `PASS(sendCDP)` — Stagehand 공개 `page.sendCDP()`로 **동일 CDP 세션** raw CDP 호출(§9.5의 "갭→raw CDP 동일 세션 보완"이 API 내부 경로로 충족됨). 별도 외부 드라이버 불요.
- `GAP` — 위 두 경로로도 미충족(진짜 블로커). `ERROR` — 실행 예외.

## D3 수용 기준(§9.4) 매핑
- UtilityExecutor + PageStateResolver가 Stagehand `act` 없이 flags·structuralHash 산출 → #2·#3·#8·#9 로 입증.
- raw CDP 보완 경로는 모두 `page.sendCDP()`(동일 세션)로 확정 — 외부 라이브러리 추가 없음.
