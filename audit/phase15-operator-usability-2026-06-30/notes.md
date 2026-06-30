# Phase 15 Operator Usability Audit

Date: 2026-06-30
Surface: `web/` RPA 운영 콘솔
Role: `operator`
Viewport coverage: desktop 1280x720, mobile 390x844

## Audit Scope

RPA 솔루션 운영자가 다음 흐름을 5분 안에 이해하고 이동할 수 있는지 확인했다.

1. 운영 현황을 대시보드에서 확인한다.
2. 새 자동화를 만들거나 녹화 기반 생성으로 진입한다.
3. 만든 자동화를 테스트 실행한다.
4. 실행 예약, 큐, 알림 운영을 확인한다.
5. 작업 목록과 실행 기록으로 실패/대기/재처리 상태를 확인한다.
6. 모바일에서 메뉴가 본문 위에 과다 노출되지 않고 drawer로 탐색한다.
7. Command Palette가 기본 operator 정책에 맞게 숨김 화면을 노출하지 않는다.

## Evidence

- `01-desktop-operator-dashboard.png`: operator dashboard, standard nav
- `02-desktop-automation-create.png`: automation creation entry
- `03-desktop-test-run.png`: test run entry
- `04-desktop-schedule-queue.png`: schedule/queue operations
- `05-desktop-work-items.png`: work item queues
- `06-desktop-run-trace.png`: run trace
- `07-command-palette-product-open-hidden.png`: Product-open search hidden for standard operator
- `08-mobile-dashboard-closed.png`: mobile dashboard with drawer closed
- `09-mobile-drawer-open.png`: mobile drawer open

## Step Health

1. Desktop dashboard: Healthy.
   Operator sees 8 first-level items: RPA 운영 대시보드, 사람 확인, 작업 목록, 자동화 만들기, 테스트 실행, 실행 기록, 실행 예약·알림, 문서 자동화. Product-open, 중복 방지, 보안/개인정보, AI 모델 설정 are not visible.

2. Automation creation: Mostly healthy, with empty/error-state risk.
   The "자동화 만들기" path is discoverable and the screen uses operator-oriented copy. However, when site/scenario data is unavailable, large "불러오지 못했습니다" panels dominate the screen and can make the next useful action less obvious.

3. Test run: Healthy IA, limited by unavailable data.
   "테스트 실행" is easy to find and explains that test execution happens before real execution. With no automation list loaded, the primary recovery path is "자연어로 자동화 만들기", which is reasonable but should be paired with clearer empty-state guidance in a production environment.

4. Schedule/queue operations: IA improvement confirmed, language polish still needed.
   "오케스트레이션" is no longer exposed; the screen title is "실행 예약·알림" and the main section is "예약·큐 운영". Remaining English copy such as "Controlled-prod readiness" and "Production readiness evidence could not be loaded." is likely too internal for an operator-facing console.

5. Work items and run trace: Healthy route continuity, repeated error-state risk.
   The dashboard signals map to "작업 목록" and "실행 기록" without navigation friction. Without API data, each panel repeats similar HTTP_404 recovery cards; this makes it harder for an operator to distinguish "nothing to do" from "system cannot load".

6. Command Palette: Policy healthy.
   Searching "Product-open" as a standard operator returns no Product-open or 중복 방지 result. Searching "실행 예약" returns the allowed "실행 예약·알림" result. One UX risk remains: hidden-by-policy and API-search-failed states can both feel like "some results failed", so the palette should avoid implying a backend error when policy filtering is the real reason.

7. Mobile dashboard and drawer: Healthy.
   At 390x844, the sidebar is hidden and the first screen does not show 18 menu items above the content. The menu button opens a drawer with the same 8 operator items. The drawer has `role="dialog"`, `aria-modal="true"`, `aria-controls` linkage, and Escape returns focus to the menu button.

## Strengths

- Role-scoped IA is materially simpler for operators. The first-level menu now reads like a workbench rather than an admin inventory.
- The new labels align better with operator language, especially "실행 예약·알림" and "예약·큐 운영".
- Advanced/internal surfaces are not discoverable from standard operator nav or default Command Palette search.
- Direct navigation behavior does not interfere with the visible nav policy.
- Mobile drawer solves the main 390px failure mode: menu sprawl before content.

## UX Risks

1. Empty/error states are too similar across screens.
   `HTTP_404`, "불러오지 못했습니다", and generic retry cards repeat across creation, testing, work items, and run trace. For a real operator, this can look like the product is broken rather than "no data/API unavailable".

2. Some internal language remains.
   "Controlled-prod readiness" and English readiness error copy are still visible under an operator-accessible screen. This weakens the Phase 15 language simplification goal.

3. Mobile topbar is crowded.
   On 390px, account, role, freshness, search, and logout controls wrap tightly. The nav problem is solved, but the topbar now competes with the primary dashboard content.

4. Command Palette feedback can blur policy and failure.
   Product-open is correctly hidden, but "일부 결과를 불러오지 못했습니다" can make a policy-filtered search feel like an outage.

5. Advanced mode may need explanation outside the UI.
   The toggle is available, but users may not know why some items appear only in advanced mode. This is acceptable for a dense enterprise console, but support/training material should define "기본" versus "고급".

## Accessibility Notes

- Confirmed from the captured mobile state: drawer has dialog semantics, modal state, controlled button linkage, Escape close, and focus return.
- Screenshots alone cannot prove full keyboard traversal, screen-reader announcements, contrast compliance, or focus trap behavior across every interactive element.
- Backdrop-click close was not accepted as screenshot-audit evidence because the browser automation layer could not reliably click the overlay coordinate. This should remain covered by component tests.

## Recommendations

1. Add more specific empty states for operator workflows:
   - "자동화가 아직 없습니다. 자동화 만들기에서 첫 자동화를 생성하세요."
   - "작업 항목을 불러오지 못했습니다. API 연결 또는 권한을 확인하세요."
   - "현재 재처리 대기 작업이 없습니다." for true empty states.

2. Replace remaining operator-visible English/internal copy in `automationOps`:
   - "Controlled-prod readiness" -> "운영 전환 준비 상태"
   - "Production readiness evidence could not be loaded." -> "운영 전환 증빙을 불러오지 못했습니다."

3. Simplify mobile topbar controls:
   - Consider moving logout/account details behind an account menu.
   - Keep search as an icon button with an accessible label.

4. Refine Command Palette empty/error copy:
   - For policy-filtered no results: "현재 역할/메뉴 모드에서 검색 가능한 결과가 없습니다."
   - For backend failure: "일부 데이터 검색을 불러오지 못했습니다. 화면 이동 결과는 계속 사용할 수 있습니다."

5. Keep the current role-scoped nav policy.
   The operator IA now matches the expected RPA daily workflow: monitor -> create -> test -> schedule -> inspect work -> trace execution.
