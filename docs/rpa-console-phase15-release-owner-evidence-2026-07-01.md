# RPA Console Phase 15 Release / Owner Evidence

Date: 2026-07-01
Scope: web console navigation, Command Palette, mobile drawer, operator-facing labels, release evidence
Out of scope: API, DB, contract/schema changes

Authority note: menu hiding is not a security boundary. Backend RBAC remains the authority for actual access control, and direct URL routing is intentionally preserved where the backend allows it.

## 1. Owner Input Required

| Area | Decision Needed | Default for Release | Owner | Status |
| --- | --- | --- | --- | --- |
| Product-open 점검 노출 | internal flag 없이 메뉴/검색에서 숨김 유지 여부 | 숨김 | Product/Open owner | Pending |
| Internal flag | `VITE_SHOW_INTERNAL_OPEN_GATE` 운영 환경 활성화 기준 | 비활성 | Release owner | Pending |
| Role menu policy | viewer/operator/reviewer/approver/admin 표준/고급 메뉴 승인 | Phase 15 설계 기준 | Product owner | Pending |
| Advanced mode | operator에게 허용할 고급 제작 도구 범위 | 제한 노출 | Product owner | Pending |
| Direct URL access | nav 숨김 화면 직접 접근 허용 정책 확인 | 허용, RBAC 별도 | Security owner | Pending |
| Security/Privacy 화면 | viewer/operator 기본 메뉴에서 숨김 유지 여부 | 숨김 | Security owner | Pending |
| AI model settings | viewer/operator 기본 메뉴에서 숨김 유지 여부 | 숨김 | AI/Platform owner | Pending |
| Site page state selectors | `page_state_selectors` 운영 입력 가이드 승인 | UI 입력 허용 | RPA runtime owner | Pending |
| OTP/MFA | 자동화 실행 중 OTP/MFA 처리 정책 | 별도 결정 필요 | Security/RPA owner | Pending |

## 2. Release Evidence

### Commands

| Command | Required | Result | Notes |
| --- | --- | --- | --- |
| `npm --prefix web run typecheck` | Yes | Pass | web TypeScript 검증 |
| `npm --prefix web test` | Yes | Pass, 70 files / 739 tests | React `act(...)` warnings remain in existing async UI tests |
| `npm --prefix web run build` | Yes | Pass | route/vendor chunks split; no Vite chunk-size warning |
| `git diff --check` | Yes | Pass | whitespace check |
| `npm --prefix web run dev` | Optional | Pass | `http://127.0.0.1:5174/`에서 visual QA용 실행 |

### Screenshots

Required captures:

| View | Role/Mode | Viewport | Suggested Path |
| --- | --- | --- | --- |
| Operator dashboard | operator / standard | 1280x720 | `audit/phase15-release-2026-07-01/operator-dashboard-desktop.png` |
| Operator dashboard closed nav | operator / standard | 390x844 | `audit/phase15-release-2026-07-01/operator-dashboard-mobile.png` |
| Mobile drawer open | operator / standard | 390x844 | `audit/phase15-release-2026-07-01/operator-mobile-drawer-open.png` |
| Command Palette hidden search | operator / standard | desktop | `audit/phase15-release-2026-07-01/operator-command-palette-hidden.png` |
| Admin/internal advanced access | admin / advanced / internal | desktop | `audit/phase15-release-2026-07-01/admin-internal-advanced.png` |

Captured evidence:

| View | Result | Notes |
| --- | --- | --- |
| `audit/phase15-release-2026-07-01/operator-dashboard-desktop.png` | Captured | operator / standard, 1280x720, nav item count 8 |
| `audit/phase15-release-2026-07-01/operator-dashboard-mobile.png` | Captured | operator / standard, 390x844, no nav items in main content |
| `audit/phase15-release-2026-07-01/operator-mobile-drawer-open.png` | Captured | operator / standard, 390x844, drawer nav item count 8 |

Screenshot note: captures used the Vite dev server with `/v1` API responses stubbed as non-auth failures so the evidence can focus on IA, navigation, and mobile layout without requiring a live backend. This does not validate backend data rendering.

## 3. Acceptance Checklist

- [x] operator standard 메뉴가 7-8개 수준이다.
- [x] viewer/operator standard 메뉴에서 Product-open 점검, 중복 방지, 보안/개인정보, AI 모델 설정이 보이지 않는다.
- [x] Product-open 점검은 internal flag 없이는 nav와 Command Palette에서 숨겨진다.
- [x] idempotency는 standard operator/viewer에서 숨겨진다.
- [x] irValidation/자동화 검사는 standard operator 기본 1차 메뉴에서 강등된다.
- [x] admin/internal은 진단/검증 화면 접근성을 잃지 않는다.
- [x] 직접 URL 접근은 막지 않는다.
- [x] 모바일 390x844에서 메뉴가 본문 위에 펼쳐지지 않고 drawer로 열린다.
- [x] Escape, backdrop click, 메뉴 선택 시 drawer가 닫힌다.
- [x] Command Palette 검색 결과가 nav policy와 일치한다.
- [x] Dashboard operator quick action에서 Product-open 점검이 제거되고 admin/internal 조건에서는 유지된다.
- [x] API/DB/계약 변경이 없다.

## 4. Residual Risks

| Risk | Impact | Mitigation / Owner |
| --- | --- | --- |
| React `act(...)` test warning 잔존 | 테스트 로그 신뢰도 저하 | test owner가 후속 정리 |
| 메뉴 숨김을 권한으로 오해할 가능성 | 보안 오해 | 릴리스 노트와 운영 가이드에 RBAC 권위 명시 |
| Product-open internal flag 운영 기준 미확정 | release 환경별 노출 차이 | Product/Open owner 승인 필요 |
| OTP/MFA 자동화 정책 미확정 | 실제 RPA 실행 실패 가능 | Security/RPA owner 결정 필요 |
| 수동 스크린샷 QA 누락 | 모바일/접근성 회귀 미탐지 | release packet 필수 증빙화 |

## 5. Release Notes Draft

Phase 15 narrows the web console primary navigation by role and mode, moves internal and advanced diagnostics out of the default operator path, aligns Command Palette search with the same visibility policy, and adds mobile drawer navigation for small viewports.

Product-open and internal checks remain routable by direct URL where allowed by backend RBAC, but are hidden from standard operator/viewer discovery unless internal release flags and role policy permit them.

No API, DB, or contract changes are included.
