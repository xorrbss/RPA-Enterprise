# RPA Console UI/UX Audit

Date: 2026-07-10
Scope: User-facing console flow review from saved screenshots, local Vite render, and existing fake client fixture plus audit-only richer data.

## Overall Score

**80 / 100**

The console has a credible enterprise operations shape: navigation is grouped by user jobs, the first screen exposes urgent work, the global create menu is useful, and run failure recovery is much clearer than a raw log table. The main UX debt is not polish; it is decision confidence. The same page often shows multiple readiness/status concepts at once, and some states visually disagree or compete for the next action.

## Score Breakdown

| Lane | Score | User impact |
| --- | ---: | --- |
| First action clarity | 84 | `내 할 일` and `새로 만들기` make the first move discoverable. |
| Journey continuity | 82 | Create, studio, test, run detail, and evidence routes connect well, but several loops still duplicate guidance. |
| Information architecture | 78 | Menu groups are understandable, yet advanced/admin surfaces are too prominent for daily operators. |
| Trust and status comprehension | 72 | Topbar says `차단` while lower cards say `준비됨` in places; users must reconcile too much state language. |
| Operational recovery UX | 84 | Failed run detail is strong: diagnosis, recent steps, rerun options, and editable params are visible. |
| Evidence/readiness UX | 76 | Metadata-only posture is good, but adoption evidence is too long and checklist-heavy. |
| Responsive/mobile | 75 | Main content reflows, but topbar context is truncated and long operational tables/cards become hard to scan. |
| Visual hierarchy and density | 78 | Quiet enterprise look fits the domain, but too many bordered panels, badges, and primary buttons flatten priority. |
| Accessibility confidence | 81 | Keyboard/focus affordances are present in key controls; screenshot audit cannot certify screen-reader quality. |

## What Works Well

- The landing screen answers "what do I need to do now?" better than a generic dashboard.
- The global `새로 만들기` menu is a strong hub: automation, template, test, schedule, site/session, evidence.
- Run failure detail is one of the best screens: the user sees failure status, diagnosis, recovery CTA, recent steps, and rerun params in one place.
- Mobile is not ignored. Tables collapse into card-like rows and the side nav becomes a drawer.
- The evidence page is honest about metadata-only constraints and negative proof, which is important for enterprise trust.

## P1 Findings

### 1. Status/readiness language still competes with itself

Evidence:
- Topbar context is red `차단` across screens.
- `자동화 스튜디오` readiness corridor has a mix of `준비됨`, `확인 필요`, and `차단`.
- `도입 증빙` says `5/9 준비`, while admin setup and evidence packet repeat similar readiness rows.

Why it hurts:
Users cannot quickly answer: "Can I launch this automation or not?" They see several correct-but-local statuses instead of one authoritative launch state.

Recommendation:
Create a single user-facing `LaunchReadinessSummary` model and component. Every surface should show the same headline answer, blocker count, and top next action. Keep local diagnostic cards underneath, but make them secondary.

### 2. Create and Studio feel like two overlapping products

Evidence:
- `만들기 콘솔` contains prompt creation, site onboarding, readiness corridor, test workbench, browser recording.
- `자동화 스튜디오` also contains readiness corridor, focused studio, test workbench, scenario list, release waiting, automation list.

Why it hurts:
A new creator can reasonably wonder whether to start in `만들기 콘솔`, `자동화 스튜디오`, `커넥터/템플릿`, or `새로 만들기`.

Recommendation:
Collapse into one primary "자동화 만들기" journey:
1. Choose start source: prompt, template, recording, manual.
2. Prepare target: site, session, params, security.
3. Preview plan.
4. Test run.
5. Save/promote/evidence.

Keep "Studio" as the edit/test workspace after a scenario exists, not as a competing start point.

### 3. Schedule table breaks scanability

Evidence:
- In `실행 예약·알림 > 예약`, the registered schedule table squeezes right-side columns into vertical wrapped text.

Why it hurts:
Operators need to inspect next fire time, catchup policy, and actions quickly. The current row becomes visually noisy and easy to misread.

Recommendation:
Replace the schedule table with compact schedule cards or a two-line row layout:
- Row 1: name, status, next fire, timezone.
- Row 2: trigger type, catchup, concurrency, actions.

### 4. Mobile topbar hides the most important safety signal

Evidence:
- Mobile `내 할 일` shows the context badge as truncated `tena... 통제 ... 차단`.
- The badge consumes space but does not explain what is blocked or what to do.

Why it hurts:
The status is important enough to be red, but too compressed to be actionable.

Recommendation:
On mobile, replace the multi-part context pill with a full-width status strip below the title:
`운영 전환 차단: blocker 2건` plus one CTA `해결하기`.

### 5. Evidence page is too long for decision making

Evidence:
- `도입 증빙` stacks readiness, admin setup, and packet sections in one long page.
- Many rows repeat status labels and CTA buttons.

Why it hurts:
Auditors need the packet, admins need setup gaps, and operators need blockers. Showing all at once makes each persona slower.

Recommendation:
Split the page into tabs or role modes:
- `출시 차단 항목`
- `감사 패킷`
- `관리자 설정`
- `성과/ROI`

Default to "출시 차단 항목" when status is not ready.

## P2 Findings

### 6. Too many primary blue CTAs compete

Examples:
- `내 할 일`: multiple `검토 열기`, `자동화 만들기`, run buttons.
- `만들기 콘솔`: `요청 확인`, `자동화 초안 만들기`, `다음: 세션 등록`, `세션 등록`, `증빙 확인`.

Recommendation:
Use one primary CTA per workflow block. Secondary actions should be outline buttons or links.

### 7. Focused Studio includes empty-plan states that look like broken data

Evidence:
- With a selected scenario, the test area still says `데이터 없음` / `실행 계획을 표시할 자동화 정의가 없습니다`.

Recommendation:
If the plan cannot be displayed until execution, say that directly and keep the selected scenario context in the empty state. If a plan exists but is not loaded, show the loading/error reason.

### 8. Connector/template focus is powerful but overwhelming

Evidence:
- `커넥터/템플릿` shows catalog metrics, connector table, detail panel, and the full template table together.
- Template deep-link focus works, but the first screen is still split across connector and template concerns.

Recommendation:
When opened from `템플릿에서 시작`, enter a template-first mode: template search/filter at top, selected template preview below, connector details collapsed.

### 9. The side navigation is complete, but too complete

Evidence:
- Advanced/admin destinations are all visible in the left nav for admin users.

Recommendation:
Keep the grouped nav, but add a "daily" default that shows only job-to-be-done routes. Move rare admin tools into `설정·점검` search/command palette unless pinned.

### 10. Context badge terms are system-oriented

Evidence:
- `tenant`, `env`, `통제 운영`, `차단` are accurate but require product knowledge.

Recommendation:
Use human outcome copy:
- Desktop: `출시 상태: 차단 · 운영 전환 증빙 2건 필요`
- Tooltip/details: tenant/env metadata.

## P3 Polish

- Replace some repeated bordered panels with unframed section bands to reduce visual box stacking.
- Normalize badge vocabulary: `확인 필요`, `재확인 필요`, `차단`, `준비됨`, `연결됨` need a short shared status taxonomy.
- On mobile drawer, add account/search/create actions at the bottom or make the topbar actions easier to discover after opening the menu.
- Add short per-route empty states that explain whether the user has no data, no permission, or a blocked prerequisite.

## Recommended Roadmap

1. **Authoritative launch state**
   - Single readiness model and one top status component.
   - Replace conflicting local summaries with references to that model.

2. **One create journey**
   - Merge prompt/template/recording/manual starts into one wizard.
   - Reframe Studio as post-create edit/test workspace.

3. **Role-based evidence IA**
   - Convert `도입 증빙` into role tabs.
   - Default to blockers until the system is ready.

4. **Operational table redesign**
   - Convert schedule and dense connector/template tables to card/list hybrids at constrained widths.
   - Keep data density, but prevent vertical text wrapping.

5. **Mobile safety/status pass**
   - Replace truncated topbar status with full-width actionable state strip.
   - Ensure primary actions remain reachable without horizontal scanning.

## Captured Evidence

Screenshots saved under `audit/ui-ux-2026-07-10/screenshots/`:

- `desktop-01-my-work.png`
- `desktop-02-global-create-menu-open.png`
- `desktop-03-create-ai.png`
- `desktop-04-scenario-focus.png`
- `desktop-05-connector-templates.png`
- `desktop-06-adoption-evidence.png`
- `desktop-07-run-detail-failed.png`
- `desktop-08-automation-ops-schedule.png`
- `desktop-09-security-sites.png`
- `mobile-01-my-work.png`
- `mobile-02-drawer-open.png`
- `mobile-03-scenario-focus.png`

Capture log: `audit/ui-ux-2026-07-10/capture-log.json`

Limitations:
- This was a screenshot and DOM audit, not a full screen-reader or real-user analytics study.
- Data came from the existing fake client plus audit-only realistic scenario/site/run fixtures.
- Browser console only showed a non-blocking 404 resource message during capture.
