# RPA Console Full-Screen UX Audit

Date: 2026-07-01
Capture target: `http://127.0.0.1:5173`
Mode: local Vite render, default operator-like session, no backend API server attached
Destination: local folder `audit/rpa-console-fullscreen-ux-2026-07-01`

## Scope

This audit captures the current web console as an RPA adoption owner/operator would see it in a local browser session. It focuses on PC first-screen usability, navigation, security/privacy complexity, empty/error states, and accessibility risks visible from screenshots.

The capture includes viewport screenshots and full-page screenshots. Mobile screenshots were captured before scope was clarified, but phone-optimized UX is not an acceptance target for the next design/implementation phase.

## Captured Steps

| Step | Screen | Viewport screenshot | Health |
| ---: | --- | --- | --- |
| 1 | Desktop dashboard | `01-desktop-dashboard-viewport.png` | usable, but empty/error states dominate |
| 2 | Desktop automation creation | `02-desktop-automation-studio-viewport.png` | clear entry, but loading/error recovery is weak |
| 3 | Desktop security/privacy | `03-desktop-security-viewport.png` | too dense for a first screen |
| 4 | Mobile dashboard | `04-mobile-dashboard-viewport.png` | reference only; mobile is out of scope |
| 5 | Mobile drawer open | `05-mobile-drawer-open-viewport.png` | reference only; mobile is out of scope |
| 6 | Mobile security/privacy | `06-mobile-security-viewport.png` | reference only; mobile is out of scope |
| 7 | Desktop human tasks | `07-desktop-human-tasks-viewport.png` | task framing is good, but API failure copy competes with workflow |
| 8 | Desktop workitems | `08-desktop-workitems-viewport.png` | predictable layout, but repeated failure panels add noise |
| 9 | Desktop test run | `09-desktop-test-run-viewport.png` | good safety explanation, but missing automation state needs stronger next step |
| 10 | Desktop run trace | `10-desktop-run-trace-viewport.png` | useful concept, but filters and evidence lookup need hierarchy |
| 11 | Desktop automation ops | `11-desktop-automation-ops-viewport.png` | powerful, but very dense and mixed-readiness messaging |
| 12 | Desktop document automation | `12-desktop-document-idp-viewport.png` | feature-rich, but forms expose too much before data is available |

## Strengths

- The Phase 15 navigation is much better for operators: the default menu is short, grouped, and no longer exposes all advanced/internal surfaces.
- The console uses consistent panels, badges, buttons, and table styles. The product feels like one system rather than separate prototypes.
- Operator dashboard CTAs are practical: failed runs, work list, and automation creation are visible immediately.
- The security page already has valuable evidence surfaces: SSO readiness, RBAC matrix, AI governance, SecretRef audit, site policy, and role history.

## UX Risks

1. Dashboard first impression is dominated by missing data and sync states.
   - Evidence: `01-desktop-dashboard-viewport.png`, `04-mobile-dashboard-viewport.png`.
   - The operator sees dashes, "갱신 중", and API-failure-derived empty cards before understanding setup status.
   - Recommendation: add a compact readiness/empty-state layer that explains whether this is "no data yet", "API unavailable", or "action needed".

2. Security/privacy is still one administrative wall.
   - Evidence: `03-desktop-security-viewport.png`, `06-mobile-security-viewport.png`.
   - The first visible security content is SSO plus a large RBAC matrix. Site/session setup, SecretRef, AI, and worker controls are hidden by scroll, not by meaningful hierarchy.
   - Recommendation: implement the planned second-level sections: `sites`, `access`, `secrets`, `ai`, `infra`.

3. Operator can directly open security, but the page does not explain the context.
   - Evidence: `03-desktop-security-viewport.png`.
   - Phase 15 hides security from the default operator menu, but deep-linking renders a large mixed admin page.
   - Recommendation: keep direct URL access, but show an operator-safe security hub with "what you can do here" and permission-aware section cards.

4. Loading and error states repeat too much.
   - Evidence: `02`, `07`, `08`, `09`, `10`, `11`, `12`.
   - Several screens show separate "불러오지 못했습니다 / HTTP_404 / 다시 시도" blocks. This is honest, but creates a product-broken feeling.
   - Recommendation: add a page-level connection/error summary with affected modules and keep individual panels quieter.

5. Automation creation has a strong promise but weak immediate affordance.
   - Evidence: `02-desktop-automation-studio-viewport.png`.
   - "AI로 설명해서 만들기" reads like a heading/card, while the first actionable button is lower and secondary.
   - Recommendation: make the natural-language entry an actual first action area with input, primary CTA, and site/session prerequisite hints.

6. Automation Ops mixes scheduling, readiness, queue, trigger, handoff, and alert routing on one first screen.
   - Evidence: `11-desktop-automation-ops-viewport.png`.
   - This is useful for power users but heavy for an operator trying to answer "what needs action now?"
   - Recommendation: split the top into "Today needs action", "Schedule", "Readiness evidence", and "Advanced integrations", or use local tabs.

7. Document automation exposes editable extraction fields before source data is available.
   - Evidence: `12-desktop-document-idp-viewport.png`.
   - The user sees form rows and delete controls even though there is no selectable document artifact.
   - Recommendation: gate advanced extraction field editing behind selecting a run/artifact or provide a clearly labeled template-edit mode.

## Accessibility Risks Visible From Screenshots

- Repeated dash placeholders are visually ambiguous; they may be read as zero, loading, or unavailable depending on context.
- Red/pink error banners are visible, but status text should also include explicit labels for assistive technology.

## Priority Recommendations

1. Implement Security/Privacy Screen Decomposition first.
   - Highest buyer/security impact.
   - No API/DB change required.
   - Aligns with the new Slice A0 design.

2. Add adoption-aware empty and API failure states.
   - Convert repeated `HTTP_404` blocks into actionable states: "API not connected", "no data yet", "permission missing", or "setup required".

3. Improve the dashboard first screen for pilot readiness.
   - Add a small readiness strip above metrics or replace dashes with setup-aware copy.

4. Make automation creation's first action explicit.
   - Provide one clear natural-language input/CTA and one recorder path.
   - Link missing site/session setup directly to `#security?section=sites`.

5. Reduce dense operational screens with local tabs or progressive disclosure.
   - Start with `automationOps` and `documentIdp`.

## Design Follow-Up Status

All five priority recommendations are reflected in `docs/rpa-console-adoption-onboarding-design-2026-07-01.md` as PC-console design requirements:

| Recommendation | Design slice |
| --- | --- |
| Security/privacy decomposition | `Slice A0` |
| Adoption-aware empty/API failure states | `Slice A1` |
| Dashboard pilot readiness | `Slice A4` |
| Automation creation first action | `Slice A2` |
| Dense operations/document workspace decomposition | `Slice A3` |

## Evidence Limits

- Screenshots were captured without a backend API server, so several panels show API failure or loading states.
- This audit does not prove full accessibility compliance. Keyboard, focus trap, screen reader names, and color contrast should be verified separately.
- Local storage role switching was not modified through the browser control API, so screenshots reflect the default local operator-like session.
- Mobile screenshots are retained only as reference. The follow-up product scope is PC console support.
