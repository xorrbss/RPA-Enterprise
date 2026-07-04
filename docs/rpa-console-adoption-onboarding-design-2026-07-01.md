# RPA Console Adoption Onboarding Design

Date: 2026-07-01
Status: design draft for implementation
Scope: PC web console information architecture, onboarding journey, buyer/security evidence packaging
Out of scope: API/DB/contract changes for the first implementation slice; mobile-first or phone-optimized console UX

## 1. Why This Exists

Phase 15 fixed the most visible console IA issue: operator users no longer see every advanced/internal surface in the first-level navigation.

The next adoption gap is different. Site registration, browser session capture, SSO readiness, RBAC, SecretRef audit, production readiness, automation performance, and run evidence already exist across the console. The issue is that an enterprise adoption owner still has to discover those pieces in separate screens.

This design packages the existing pieces into a clear adoption journey:

1. Prepare identity, roles, sites, and sessions.
2. Create and test the first automation.
3. Prove that failed runs, human review, and evidence are observable.
4. Produce a pilot/security evidence packet without implying false production readiness.

This is not a claim that site registration or browser session registration is missing. They exist today in `SiteCreateForm`, `SecurityView`, `CaptureGuide`, and run failure CTAs. The improvement is making them visible as a guided adoption path.

This product surface is a PC operations console. Mobile rendering may remain as a best-effort fallback, but mobile is not a primary adoption or acceptance target. Design decisions should optimize for repeated desktop use by operators, admins, CoE owners, and security reviewers.

## 2. References

- `docs/rpa-adoption-90plus-design-2026-06-29.md`
- `docs/commercial-rpa-product-redesign-2026-06-30.md`
- `docs/rpa-console-simplified-ia-phase15-design-2026-06-30.md`
- `docs/rpa-console-phase15-release-owner-evidence-2026-07-01.md`
- `web/src/components/SiteCreateForm.tsx`
- `web/src/views/Security.tsx`
- `web/src/components/CaptureGuide.tsx`
- `web/test/session-registration-cta.test.tsx`
- `audit/rpa-console-fullscreen-ux-2026-07-01/notes.md`

## 3. Score Model Clarification

Use separate scores for separate claims.

| Claim | Target score | Meaning |
| --- | ---: | --- |
| 90+ design readiness | 90-92 | Design, contracts, scope honesty, and adoption gates are strong enough for design approval. |
| Pilot implementation readiness | 87-89 | Current console/runtime surfaces can support a controlled pilot, with owner decisions and environment evidence still required. |
| First-screen buyer confidence | 81-84 before this work, 88+ after this work | A buyer/adoption owner can understand setup, risk, and next actions from the console without reading source documents. |

The goal of this design is to lift first-screen buyer confidence without overstating production readiness.

## 4. Personas And Questions

| Persona | Question in evaluation | Console answer after this design |
| --- | --- | --- |
| Adoption owner | "What must be done before pilot?" | A readiness checklist shows identity, role, site, session, first run, evidence, support, and ROI gates. |
| Business owner | "Can my team create or request an automation?" | Dashboard and Studio expose a guided first automation path with site/session prerequisites. |
| Operator | "What should I fix now?" | Existing operator workbench stays focused on failed runs, workitems, and automation creation. |
| Security reviewer | "Are secrets, sessions, PII, and audit safe?" | Evidence packet summarizes SecretRef, RBAC, RLS, redaction, audit chain, and session capture boundaries. |
| IT operations | "Who owns incidents and readiness?" | Production readiness and support/RACI gates are visible as deferred/blocked/valid, not hidden in docs. |
| Buyer/finance | "Will this prove ROI?" | Pilot evidence links estimated ROI, actual outcomes, and missing evidence separately. |

## 5. Proposed Product Surface

### 5.1 Adoption Readiness Strip On Dashboard

Add a compact panel near the top of the dashboard, below the role workbench or replacing empty-state onboarding when applicable.

Title:

> 파일럿 도입 준비

Rows:

| Gate | Source | CTA | State rules |
| --- | --- | --- | --- |
| 접속/SSO | `AuthReadinessPanel` data | `보안 설정 보기` | pass only when configured; otherwise needs action/deferred |
| 역할/RBAC | current token roles + RBAC matrix | `권한 확인` | pass when current principal has expected role |
| 사이트 등록 | `listSites` | `사이트 등록` | pass when at least one approved/usable site exists |
| 로그인 세션 | `login_capable`, `session_ready`, capture sessions | `세션 등록` | pass only when required sessions are ready |
| 첫 자동화 | scenarios + generated/run history | `자동화 만들기` | pass when at least one scenario draft/run exists |
| 테스트 실행 | run summary/latest run | `테스트 실행` | pass when a run completed or failed with evidence |
| 운영 증빙 | run trace/artifacts/audit | `실행 기록` | pass when evidence exists; deferred if no run yet |
| 지원/운영 승인 | production readiness evidence | `운영 준비 확인` | valid/failed/deferred from readiness gates |
| ROI/파일럿 증거 | automation performance/adoption evidence | `성과 리포트` | never synthesize payback when evidence is missing |

Rules:

- Do not add a new primary nav item for standard operator in the first slice.
- Use status chips: `준비됨`, `확인 필요`, `보류`, `차단`.
- Missing data must read as `확인 필요` or `보류`, not success.
- Each row must have exactly one next action.

### 5.2 Guided Site And Session Corridor

Keep the existing Security surface as the authoritative management screen, but add a business-facing corridor that makes the order obvious.

Flow:

1. Register site.
2. Add login URL and page-state conditions when needed.
3. Approve high-risk site if required.
4. Register browser login session.
5. Return to automation creation with site, browser identity, and network policy prefilled.

Current implementation already supports most of this:

- `SiteCreateForm` registers site and page-state selectors.
- `SecurityView` shows session registration banner and queue.
- `CaptureGuide` explains operator PC session capture without embedding secrets.
- `RunScenarioButton` and run detail panels link to session registration when a session is missing.

Improvement:

- Add a short "setup order" header above `SiteCreateForm` or the session queue.
- After site creation, keep the current prefill behavior but also show "next: register login session" when `loginUrl` is present.
- In the session capture guide, keep the security warning but add a one-line result expectation: "등록 후 이 사이트는 세션 등록됨으로 표시됩니다."
- Make the "운영자 PC 등록" path feel intentional, not like an advanced fallback.

### 5.3 Evidence Packet Panel

Add an evidence panel that can be used in buyer/security review.

Placement options:

| Option | Pros | Cons |
| --- | --- | --- |
| Dashboard section | Strong first impression; no nav expansion | Can make dashboard dense |
| Security panel | Natural for security review | Adoption owner may miss it |
| Automation Ops readiness panel | Reuses production readiness context | Operator may read it as internal ops only |

Recommendation for first slice: dashboard summary card that links to existing Security and Automation Ops details.

Packet contents:

- Product position: web automation + governance, not universal desktop RPA replacement.
- Current role and tenant context.
- Site/session readiness summary.
- SecretRef and session-capture safety summary.
- RBAC/RLS/audit/redaction contract references.
- First automation/run evidence summary.
- Production readiness gates with `valid`, `failed`, `deferred`, `blocked`.
- Known owner decisions: Product-open/internal flag, OTP/MFA, SLO/on-call, PITR/restore, collector/dashboard approval.

Do not export raw secrets, URLs with credentials, raw rosters, raw audit payloads, or resolved SecretRef values.

### 5.4 Empty And Partial Data States

Current dashboard cards often show `-` when backend data is unavailable or no runs exist. That is honest but not adoption-friendly.

Replace bare missing values in onboarding context with guided messages:

| Current | Better |
| --- | --- |
| `-` under success rate | `첫 실행 전` |
| `긴급 운영 알림이 없습니다.` | `알림 없음 · 첫 자동화 실행 후 운영 알림을 확인할 수 있습니다.` |
| no site/session data | `사이트를 등록하고 로그인 세션을 연결하세요.` |
| no runs | `첫 자동화를 테스트 실행해 증빙을 만드세요.` |

Keep metric cards honest. Do not display fake zeros or fake success percentages.

### 5.5 Security And Privacy Workspace Simplification

The current `SecurityView` is functionally valuable but reads like a single long administrative backlog. It mixes identity readiness, RBAC, principal management, SCIM, site access policy, browser session capture, SecretRef audit, security connections, AI governance, worker pools, and credential/concurrency policy on one page.

For an RPA adoption owner or enterprise security reviewer, this creates two problems:

1. The first screen does not answer "what should I do now?"
2. High-risk administrative controls look equal to routine site/session setup.

Design position:

- Do not add more panels to the first screen.
- Do not add a new first-level nav item for each security concern.
- Keep `#security` as the canonical route in the first implementation slice.
- Split the page into a second-level security menu, backed by hash params such as `#security?section=sites`.
- Render only the active section's panels, plus a compact section selector and optional section summary.
- Treat the section menu as IA only. RBAC and backend permissions remain authoritative.
- Do not block direct URL access. A hidden nav item or non-default section can still render when a user deep-links and has the required backend permission.

Recommended sections:

| Section | Label | Existing panels or functions | Primary user question |
| --- | --- | --- | --- |
| `sites` | 사이트·브라우저 세션 | `SiteCircuitNotice`, session renewal queue, `SiteCreateForm`, site access policy table, `CaptureGuide`, `SessionCaptureStatus` | "파일럿 대상 사이트와 로그인 세션이 준비됐나?" |
| `access` | 접속·권한 | `AuthReadinessPanel`, `RbacMatrixPanel`, `PrincipalDirectory`, `RoleAssignmentPanel`, `ScimProviderPanel` | "누가 접속하고 어떤 권한으로 운영하나?" |
| `secrets` | 비밀·연결·감사 | `SecurityConnectionsPanel`, `SecretRefAuditPanel`, credential-related deep links, future privacy/redaction evidence summary | "비밀값, 연결, 감사 증거가 안전한가?" |
| `ai` | AI 거버넌스 | `AiGovernanceRuntimePolicyPanel`, `AiGovernanceEvidencePanel` | "AI 사용 정책과 증거가 통제되는가?" |
| `infra` | 운영 인프라 | `ConcurrencyPolicyPanel`, `WorkerPoolPanel` | "동시 실행, 잠금, 워커 운영 정책이 준비됐나?" |

Default section policy:

| Entry URL | Selected section | Reason |
| --- | --- | --- |
| `#security` | `sites` | Most adoption journeys start with site registration and browser session readiness. |
| `#security?site=<id>` | `sites` | Existing session registration CTA must remain obvious. |
| `#security?principal=<id>` | `access` | Principal search results should land near identity and role controls. |
| `#security?focus=credentials` | `secrets` | Credential and SecretRef work belongs with privacy/security evidence. |
| `#security?credential_site=<id>&credential=<id>` | `secrets` | Credential detail deep links should not open the whole security page. |
| `#security?focus=worker-pools` | `infra` | Worker pool management is operational infrastructure. |
| `#security?section=ai` | `ai` | Explicit section selection wins when permission allows the content. |

Section behavior:

- The top of the page becomes a compact "보안 운영 허브" with section buttons.
- Each section button uses the business label and a one-line purpose, not implementation jargon.
- The active section should use `aria-current` or `aria-pressed`, expose a clear heading, and preserve keyboard focus after selection.
- The PC layout should use a stable second-level tab row or left in-page section rail so the active security area is always obvious.
- Switching sections should update the hash so links, refresh, and Command Palette actions remain stable.
- A section can show a short "what this proves" summary, but the existing detailed panels remain the source of truth.

Role and visibility policy:

| Role/context | Expected result |
| --- | --- |
| viewer | Can read safe readiness/evidence panels if the route is directly opened, but should not see setup actions without permission. |
| operator | Does not get `보안/개인정보` as a default first-level nav item, but dashboard/session CTAs may deep-link to `sites` when setup action is permitted. |
| reviewer/approver | Can reach evidence and approval-relevant information through existing allowed paths. |
| admin | Keeps access to all security, AI, SCIM, SecretRef, worker, and infrastructure sections. |
| internal flag off | Product-open/internal-only checks remain hidden from nav and palette; this section split must not re-expose them. |

Copy and terminology:

- Use "보안 운영 허브" for the page-level framing.
- Keep "보안/개인정보" as the nav/meta label unless the product owner chooses a stronger buyer-facing label later.
- Use "사이트·브라우저 세션" instead of treating session capture as an advanced fallback.
- Use "비밀·연결·감사" instead of exposing SecretRef as the only mental model.
- Avoid implying that privacy masking is complete unless the evidence exists. Missing privacy/redaction evidence must read as `확인 필요` or `보류`.

Implementation slice:

This can be implemented without API, DB, or contract changes.

Likely touched files:

- `web/src/views/Security.tsx`
- `web/src/styles.css`
- `web/src/components/CommandPalette.tsx` only if quick actions need explicit `section` params
- tests under `web/test/`

Acceptance criteria:

- `#security` no longer renders every security/admin panel at once.
- The first visible section focuses on site registration and browser session readiness.
- SSO/RBAC/SCIM, SecretRef/audit, AI governance, and worker/infrastructure controls are separated behind clear second-level section choices.
- Existing deep links for `site`, `principal`, `credential_site`, `credential`, and `focus` continue to land on the right work area.
- Admin/internal access is not weakened.
- Viewer/operator default first-level nav remains simplified from Phase 15.
- No API/DB/contract change is required.

### 5.6 PC Console Scope And Layout Target

The implementation target is a PC browser console, not a mobile workflow product.

Target viewport:

| Target | Design implication |
| --- | --- |
| Primary | Desktop 1280px wide and above |
| Secondary | Wide laptop layouts where the sidebar remains visible |
| Out of scope | Phone-optimized task completion, mobile-first dashboard, mobile security review |

Rules:

- Keep the persistent left sidebar for PC workflows.
- Use dense but readable operational layouts: tables, toolbars, filters, and compact evidence panels are appropriate.
- Do not spend implementation scope on phone-specific navigation, mobile drawer enhancements, or mobile-only acceptance criteria.
- Existing mobile behavior should not be deliberately broken, but it is not the product quality bar for this phase.
- Tests for this phase should focus on desktop viewport behavior and role-scoped IA.

### 5.7 Desktop Empty And Error State Policy

The full-screen audit showed that the dashboard and several operator screens look broken when the backend is unavailable or local data is empty. This is a PC-console adoption risk because the buyer or operator cannot distinguish:

- API not connected
- no data yet
- permission missing
- setup incomplete
- actual operational failure

Design:

- Add a page-level connection/status summary when multiple panels fail for the same reason.
- Keep individual panels honest but quieter when the page-level status already explains the issue.
- Replace repeated `HTTP_404` blocks with actionable labels:
  - `API 연결 필요`
  - `데이터 없음`
  - `권한 확인 필요`
  - `설정 필요`
  - `운영 실패`
- Preserve raw error details in expandable technical details for admins/developers.
- Never translate an unknown or failed state into success.

Recommended desktop pattern:

| Surface | Current audit issue | Proposed behavior |
| --- | --- | --- |
| Dashboard | metric cards show dashes and sync/failure states dominate | top readiness/status strip explains environment state; metrics show `첫 실행 전` or `연결 필요` |
| Workitems/Human tasks/Run trace | repeated panel-level load failures | one page summary plus panel-local retry buttons |
| Automation Ops | readiness, queue, alert, trigger failures compete | page summary groups failures by `운영 헬스`, `예약`, `알림`, `외부 전달` |
| Document automation | extraction form appears before artifact exists | show source selection/setup first; advanced template editing is a separate mode |

### 5.8 Automation Creation First Action

The audit showed that `자동화 만들기` has a strong promise but the first action is still visually weak. The heading says users can describe work in natural language, but the visible primary action is not an input-driven creation flow.

Design:

- Make "AI로 설명해서 만들기" a real first-action panel:
  - one text area for the work description
  - one primary CTA: `자동화 초안 만들기`
  - secondary CTA: `브라우저 녹화로 만들기`
  - setup hints for missing site/session prerequisites
- Keep browser recording as the second creation path, not a separate hidden capability.
- When no automation exists or list loading fails, show the next creation action before the failure detail.
- Link missing site/session setup to `#security?section=sites`, not to a generic security page.

Acceptance criteria:

- A business user can identify the first action within the first PC viewport.
- The creation screen distinguishes "no automations yet" from "API failed".
- The recorder path remains available but does not compete with the natural-language first action.

### 5.9 Dense Operations Screen Decomposition

The audit found two PC screens that are feature-rich but too dense for first use: `실행 예약·알림` and `문서 자동화`.

`실행 예약·알림` design:

- Keep the route and first-level nav label.
- Add local desktop tabs or segmented sections:
  - `오늘 필요한 조치`
  - `예약`
  - `큐`
  - `알림`
  - `운영 전환 증빙`
  - `외부 전달`
- Default to `오늘 필요한 조치` or a compact operating summary, not the full scheduling/readiness/handoff surface.
- Keep advanced integration handoff details out of the first PC viewport unless the selected section needs them.

`문서 자동화` design:

- Split the first screen into source-first workflow:
  - `실행 산출물 선택`
  - `문서 종류 선택`
  - `추출 필드 확인`
  - `검증 큐`
- Hide or collapse editable field rows until a source artifact exists or the user explicitly chooses `템플릿 편집`.
- Make template editing clearly separate from running extraction against evidence.

Acceptance criteria:

- The first PC viewport answers "what should I do now?"
- Advanced setup remains reachable but is not the first visual object.
- Empty data does not expose rows of inactive form controls as if they are the main task.

### 5.10 User-View Top Five Improvements

The RPA solution user review produced five required improvements. These are now the product design priorities for the next PC-console implementation slice.

| Priority | Improvement | Primary user | Design response | Success signal |
| ---: | --- | --- | --- | --- |
| 1 | 보안/개인정보 화면 분해 | Security reviewer, admin, adoption owner | `#security`를 보안 운영 허브와 5개 섹션으로 분리 | 첫 PC 화면에서 사이트/세션 준비가 보이고 RBAC/AI/SecretRef는 목적별 섹션으로 이동 |
| 2 | 빈 상태/오류 상태 정리 | Operator, adoption owner | 반복 `HTTP_404` 대신 `첫 실행 전`, `API 연결 필요`, `권한 확인 필요`, `설정 필요`를 구분 | 첫 PC 화면이 제품 고장처럼 보이지 않고 다음 조치가 보임 |
| 3 | 대시보드 파일럿 준비 상태 | Adoption owner, buyer, operator | 대시보드 상단에 파일럿 준비 strip 추가 | SSO, 권한, 사이트, 세션, 첫 실행, 증빙, ROI의 남은 일이 한눈에 보임 |
| 4 | 자동화 만들기 첫 액션 강화 | Business user, operator, CoE | 자연어 입력 + `자동화 초안 만들기`를 첫 액션으로 승격 | 사용자가 첫 PC viewport에서 무엇을 입력/클릭할지 즉시 이해 |
| 5 | 운영/문서 화면 밀도 축소 | Operator, IT ops, document operator | `실행 예약·알림`, `문서 자동화`를 로컬 섹션/모드로 나눔 | 첫 화면은 오늘 필요한 조치와 소스 선택을 보여주고 고급 설정은 선택 후 노출 |

Design constraints:

- Do not add new first-level nav items for these improvements unless a later product decision explicitly approves it.
- Keep existing routes and deep links working.
- Keep API, DB, schema, RBAC, and contract behavior unchanged for this design slice.
- Use existing panels as authoritative detail surfaces; the improvement is sequencing, hierarchy, and state explanation.
- Mobile is reference-only for this phase. Acceptance is based on PC console use.

Expected user-score impact after all five:

| Score lane | Current | After five improvements |
| --- | ---: | ---: |
| RPA solution user experience | 84 | 88-90 |
| First automation creation confidence | 78-80 | 86-88 |
| Security/adoption owner confidence | 82-85 | 89-91 |
| Operator daily usability | 84 | 88-90 |

## 6. Information Architecture

Phase 15 operator nav remains the default.

| Role | IA change |
| --- | --- |
| viewer | See read-only readiness summary, no setup actions. |
| operator | See adoption readiness strip and next actions for site/session/first automation if permitted. |
| reviewer/approver | See approval/human-review related readiness gaps. |
| admin | See all readiness gates plus Security/AI/Product-open/internal controls where policy permits. |

Do not expose hidden/internal screens through the readiness strip unless the role and internal flag already permit them. The strip is a guide, not a permission bypass.

## 7. Data Sources For First Implementation Slice

Use existing client calls and UI state.

| Need | Existing source |
| --- | --- |
| Current role | decoded token roles |
| SSO/auth readiness | `GET /v1/auth/readiness` through existing Security panel/client |
| Sites | `GET /v1/sites` |
| Session readiness | `SiteItem.login_capable`, `SiteItem.session_ready`, `GET /v1/sites/{id}/session/capture` |
| Run evidence | run summary, run list, run detail/artifacts |
| Ops readiness | production readiness panel/client |
| ROI/performance | dashboard performance report |
| RBAC explanation | existing RBAC matrix panel |

If a durable "evidence packet export" is required later, design a separate contract. The first slice can be a composed console summary that links to authoritative panels.

## 8. Implementation Slices

Recommended order:

1. `A0` Security/Privacy Screen Decomposition
2. `A1` Desktop Empty/Error State Cleanup
3. `A2` Automation Creation First Action
4. `A3` Dense PC Workspace Decomposition
5. `A4` Pilot Readiness Dashboard Packaging
6. `B` Evidence Packet UI

### Slice A0: Security/Privacy Screen Decomposition

Goal: reduce the existing `보안/개인정보` screen complexity before adding more adoption packaging.

Files likely touched:

- `web/src/views/Security.tsx`
- `web/src/styles.css`
- `web/src/components/CommandPalette.tsx` only if explicit section params are needed
- security-focused tests under `web/test/`

Acceptance criteria:

- The default `#security` screen shows the security hub and the `sites` section, not every admin panel.
- Site registration and browser session readiness remain the fastest path for adoption owners.
- Identity/RBAC, SecretRef/audit, AI governance, and infrastructure controls move behind second-level section choices.
- Existing query-param deep links keep working and select the closest section automatically.
- Admin users do not lose access to advanced security and infrastructure controls.
- Viewer/operator first-level nav remains governed by Phase 15 nav policy.
- No API, DB, schema, or contract files change.

### Slice A1: Desktop Empty/Error State Cleanup

Goal: make local/empty/API-failed PC screens feel diagnosable instead of broken.

Files likely touched:

- `web/src/views/Dashboard.tsx`
- shared empty/error presentation components if available
- `web/src/views/Workitems.tsx`
- `web/src/views/HumanTasks.tsx`
- `web/src/views/RunTrace.tsx`
- `web/src/views/AutomationOps.tsx` or orchestration subcomponents
- tests under `web/test/`

Acceptance criteria:

- Dashboard distinguishes `첫 실행 전`, `연결 필요`, `권한 확인 필요`, and real operational failure.
- Repeated `HTTP_404` panels do not dominate the first PC viewport.
- Raw technical errors remain available in details for support/admin use.
- No fake success metrics are introduced.

### Slice A2: Automation Creation First Action

Goal: make `자동화 만들기` answer "what do I type or click first?" in the first desktop viewport.

Files likely touched:

- `web/src/views/ScenarioStudio.tsx` or creation subcomponents
- browser recorder entry components
- tests under `web/test/`

Acceptance criteria:

- Natural-language creation has a visible input and primary CTA.
- Browser recording remains a clear secondary path.
- Missing site/session setup links to `#security?section=sites`.
- "No automations yet" is different from "automation list failed to load".

### Slice A3: Dense PC Workspace Decomposition

Goal: reduce first-viewport density in `실행 예약·알림` and `문서 자동화` without adding new first-level nav items.

Files likely touched:

- `web/src/views/AutomationOps.tsx` and orchestration subcomponents
- `web/src/views/DocumentIdp.tsx`
- tests under `web/test/`

Acceptance criteria:

- `실행 예약·알림` defaults to an action-oriented desktop summary, with local sections for schedule, queue, alerts, readiness, and external handoff.
- `문서 자동화` starts with source artifact selection or template mode, not editable extraction rows by default.
- Existing deep links still land on the relevant local section.
- Operator first-level nav remains unchanged.

### Slice A4: Pilot Readiness Dashboard Packaging

Goal: raise first-screen buyer and adoption-owner confidence without changing contracts.

Files likely touched:

- `web/src/views/Dashboard.tsx`
- new `web/src/components/AdoptionReadinessPanel.tsx`
- `web/src/views/Security.tsx`
- `web/src/components/CaptureGuide.tsx`
- tests under `web/test/`

Acceptance criteria:

- Operator/admin dashboard shows a pilot readiness panel when setup is incomplete.
- Existing operator nav count remains 7-8.
- Site registration and session registration are surfaced as a sequence, not separate discoveries.
- Missing readiness is shown as `확인 필요` or `보류`, not as success.
- First automation and first run evidence are represented as explicit readiness gates.
- ROI evidence is separated from estimates and never shown as proven when evidence is missing.
- Viewer sees no unauthorized setup action.
- Admin sees security/production readiness links without losing existing advanced/internal access.

### Slice B: Evidence Packet UI

Goal: give adoption/security owners a review-ready summary.

Files likely touched:

- new `web/src/components/AdoptionEvidencePacket.tsx`
- `web/src/views/Dashboard.tsx` or `web/src/views/orchestration/ProductionReadinessPanel.tsx`
- tests under `web/test/`

Acceptance criteria:

- Packet lists security, audit, readiness, site/session, first-run, and ROI evidence status.
- Raw secret/session/audit payloads are never rendered.
- `deferred` and `blocked` remain visibly different from `valid`.
- Packet references existing authoritative screens rather than duplicating all details.

### Slice C: Optional Dedicated Adoption View

Only add a new route if dashboard packaging becomes too dense.

If added:

- Keep `VIEW_KEYS` routing and nav exposure policy separated.
- Do not expose as operator first-level nav unless product owner approves.
- Prefer Command Palette/admin link or dashboard CTA.

## 9. Tests

Add or extend:

Traceability for the five user-view improvements:

| Improvement | Primary test coverage |
| --- | --- |
| 보안/개인정보 화면 분해 | `web/test/security-section-nav.test.tsx` |
| 빈 상태/오류 상태 정리 | `web/test/desktop-empty-states.test.tsx`, existing dashboard/workitem/run trace tests |
| 대시보드 파일럿 준비 상태 | `web/test/adoption-readiness.test.tsx`, `web/test/dashboard.test.tsx` |
| 자동화 만들기 첫 액션 강화 | `web/test/scenario-studio-first-action.test.tsx` |
| 운영/문서 화면 밀도 축소 | `web/test/automation-ops-desktop-sections.test.tsx`, `web/test/document-idp-desktop-workflow.test.tsx` |

- `web/test/security-section-nav.test.tsx`
  - `#security` shows the hub and `사이트·브라우저 세션`
  - default section does not render SSO/RBAC, SecretRef/audit, AI governance, and worker pool panels all at once
  - selecting `접속·권한`, `비밀·연결·감사`, `AI 거버넌스`, and `운영 인프라` changes the visible panel set
  - deep links with `site`, `principal`, `credential_site`, `credential`, and `focus` select the expected section
  - section selection updates the hash and preserves keyboard accessibility
- `web/test/desktop-empty-states.test.tsx`
  - dashboard shows `첫 실행 전` for genuine empty execution history
  - dashboard shows `연결 필요` or `API 연결 필요` for backend/API failures
  - repeated panel errors are collapsed or summarized in the first PC viewport
- `web/test/scenario-studio-first-action.test.tsx`
  - creation screen exposes a natural-language input and primary CTA
  - recorder remains available as a secondary action
  - missing site/session setup links to `#security?section=sites`
- `web/test/automation-ops-desktop-sections.test.tsx`
  - default PC section is action-oriented and does not render every advanced ops panel first
  - schedule, queue, alerts, readiness, and external handoff sections remain reachable
- `web/test/document-idp-desktop-workflow.test.tsx`
  - document automation starts from source artifact selection or explicit template-edit mode
  - editable extraction rows are not the default empty state
- `web/test/adoption-readiness.test.tsx`
  - operator sees readiness panel with site/session/first-run next actions
  - viewer sees read-only status and no setup buttons
  - missing session links to `#security?site=<id>`
  - missing data is not treated as pass
- `web/test/security-session-corridor.test.tsx`
  - site registration with login URL suggests session registration next
  - operator PC registration guidance remains secret-safe
- `web/test/dashboard.test.tsx`
  - empty run state uses adoption-friendly copy without fake success
- `web/test/a11y.test.tsx`
  - readiness panel has no axe violations

Existing important regression tests:

- `web/test/session-registration-cta.test.tsx`
- `web/test/site-create-form.test.tsx`
- `web/test/security-auth-readiness.test.tsx`
- `web/test/security-rbac-matrix.test.tsx`
- `web/test/security-secret-audit.test.tsx`
- `web/test/security-connections.test.tsx`
- `web/test/security-ai-governance-runtime-policy.test.tsx`
- `web/test/ai-governance-evidence.test.tsx`
- `web/test/concurrency-policy.test.tsx`
- `web/test/worker-pool.test.tsx`
- `web/test/principals-admin.test.tsx`
- `web/test/scim-provider-panel.test.tsx`
- `web/test/layout-nav-policy.test.tsx`
- `web/test/command-palette.test.tsx`

Mobile-specific tests are not acceptance criteria for this PC-console phase. Existing mobile tests may remain as regression coverage, but new work should not optimize for phone workflows unless product scope changes.

Validation commands:

```powershell
npm --prefix web run typecheck
npm --prefix web test
npm --prefix web run build
git diff --check
```

## 10. Scoring Impact

Expected score movement after Slice A+B:

| Score lane | Before | After |
| --- | ---: | ---: |
| 90+ design readiness | 90-92 | unchanged or clearer |
| Pilot implementation readiness | 87-89 | 89-90 |
| First-screen buyer confidence | 81-84 | 88-90 |

This work does not by itself prove controlled production readiness. It improves the console's ability to show what is ready, what is deferred, and what owner evidence is still missing.

## 11. Open Decisions

| Decision | Owner | Default |
| --- | --- | --- |
| Whether to add a dedicated Adoption view route | Product owner | no; start on dashboard |
| Evidence packet export format | Product/Security owner | console summary first |
| OTP/MFA policy wording in readiness panel | Security/RPA owner | human-first suspend/session renewal |
| Product-open/internal flag visibility | Release/Product owner | hidden unless internal flag permits |
| Support/RACI evidence source | Operations owner | metadata-only evidence or deferred |

## 12. Final Design Position

The console already contains many of the adoption ingredients. The next improvement is to make them read as one enterprise adoption journey.

The product should not say "everything is ready." It should say:

> Here is what is ready, here is what needs an owner decision, and here is the shortest safe path to a pilot.
