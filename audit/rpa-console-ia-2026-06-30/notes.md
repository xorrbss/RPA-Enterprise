# RPA Console IA Screenshot Audit - 2026-06-30

Scope: RPA web console first-run complexity for an enterprise adoption/operator user.

Capture setup:
- URL: http://127.0.0.1:5173/
- Viewport: desktop default 1280x720 and mobile 390x844
- Token: local audit JWT with `roles: ["operator"]`
- API state: Vite frontend only; backend API was not connected, so data panels show loading failures/HTTP_404. Navigation, labels, layout, role chip, and screen structure remain valid evidence.

Screenshots:
- `01-dashboard-viewport.png`: initial access-code gate
- `02-dashboard-operator-viewport.png`: operator dashboard desktop viewport
- `02-dashboard-operator-full.png`: operator dashboard full page
- `03-scenario-studio-viewport.png` / `03-scenario-studio-full.png`: automation creation
- `04-orchestration-viewport.png` / `04-orchestration-full.png`: orchestration
- `05-security-viewport.png` / `05-security-full.png`: security/privacy
- `06-open-gate-viewport.png` / `06-open-gate-full.png`: Product-open check
- `07-idempotency-viewport.png` / `07-idempotency-full.png`: idempotency
- `08-ir-validation-viewport.png` / `08-ir-validation-full.png`: automation validation
- `09-mobile-dashboard-operator.png`: mobile-width dashboard

Findings:
1. Operator users see all 18 navigation entries. The role chip says `운영자`, but the global nav still exposes 제작 6, 운영 8, 고급 설정 4 items.
2. Desktop dashboard is not visually broken, and the role-specific workbench is helpful. The complexity problem is mostly the persistent left navigation, not the dashboard body itself.
3. Mobile is worse: the navigation does not collapse into a menu; it becomes a two-column menu wall before the dashboard content.
4. `Product-open 점검` appears as a normal customer navigation item even for `operator`. The content is a release-readiness checklist, not a day-to-day RPA operator task.
5. `중복 방지` appears as a standalone first-level page. The content is explanatory/diagnostic and should be contextual inside run/workitem/retry flows.
6. `자동화 검사` appears as a standalone first-level creation menu. It looks like a developer/CoE validation tool and should be folded into `자동화 만들기` or release review.
7. `오케스트레이션` mixes Korean operational copy with an English technical label. The actual first-screen task is scheduling, queue state, alerts, and recovery.
8. `보안/개인정보` is dense but useful for admin/security. It should not be globally visible to non-admin personas; when visible, tabs would reduce scanning load.

Recommendations:
1. Implement role-scoped navigation first. For operator/adoption users, show a smaller default set: `RPA 운영 대시보드`, `자동화 만들기`, `테스트 실행`, `실행 기록`, `작업 목록`, `사람 확인`, and possibly `문서 자동화`.
2. Hide `Product-open 점검` from regular customer nav; keep it dev/admin only or move it under an internal readiness surface.
3. Demote `중복 방지` from first-level nav to contextual diagnostics under run/workitem/retry screens.
4. Fold `자동화 검사` into `자동화 만들기` as a validation tab/action.
5. Rename `오케스트레이션` to `실행 예약·알림` or `예약·큐 운영`.
6. Add a mobile collapsed navigation pattern before shipping mobile/tablet review.
