# Phase 15: RPA 콘솔 단순 IA 설계

작성일: 2026-06-30

## 1. 설계 목표

도입 기업의 현업 담당자와 운영자가 처음 콘솔에 들어왔을 때 “내가 지금 무엇을 하면 되는지”를 바로 알 수 있게 한다. 기능을 삭제하지 않고, 역할과 업무 맥락에 맞게 기본 노출을 줄인다.

이번 설계는 `web/` 전용 변경이다. 계약, API, DB, RBAC 권한 매트릭스는 바꾸지 않는다. 메뉴 숨김은 보안 경계가 아니며, 실제 허용/거부는 기존 백엔드 RBAC가 계속 권위자다.

근거:

- 스크린샷 감사: `audit/rpa-console-ia-2026-06-30/`
- 감사 메모: `audit/rpa-console-ia-2026-06-30/notes.md`
- 현재 코드: `web/src/router.ts`, `web/src/components/Layout.tsx`, `web/src/views/meta.ts`

## 2. 확인된 문제

현재 운영자 역할으로 접속해도 사이드바에 18개 화면이 모두 노출된다.

| 영역 | 현재 노출 | 문제 |
|---|---:|---|
| 제작 | 6개 | 현업이 바로 쓰지 않는 CoE/검사/저장소 도구가 첫 화면에 보임 |
| 운영 | 8개 | 운영과 결재, 감사, 문서 자동화가 같은 무게로 보임 |
| 고급 설정 | 4개 | `Product-open 점검`, `중복 방지`, `보안/개인정보`가 운영자 1차 메뉴에 보임 |

좁은 화면에서는 사이드바가 접히지 않고 18개 메뉴가 본문 위 2열로 펼쳐진다. 이 상태에서는 대시보드보다 메뉴가 먼저 보이며, 도입 담당자에게 “복잡한 제품”이라는 첫 인상을 준다.

## 3. 설계 원칙

1. 역할 기반 노출을 먼저 적용한다.
2. 전문가 모드는 두 번째 단계다. 역할 필터 없이 모드 토글만 추가하지 않는다.
3. 내부 출시 점검, 중복 방지 설명, 구조 검사는 고객 기본 내비에서 내린다.
4. 화면 자체는 유지한다. 단, 진입 위치를 역할/맥락에 맞게 바꾼다.
5. Command Palette는 기본적으로 현재 역할의 보이는 화면을 우선 검색한다.
6. 직접 URL 접근은 막지 않는다. 메뉴 숨김은 UX 필터이며 보안 차단이 아니다.
7. 모바일에서는 메뉴가 본문보다 먼저 길게 펼쳐지면 안 된다.

## 4. 역할별 기본 메뉴

기존 RBAC 역할을 그대로 사용한다.

| 역할 | 기본 메뉴 | 숨김/강등 |
|---|---|---|
| viewer | RPA 운영 대시보드, 실행 기록, 작업 목록, 사람 확인 | 제작 도구, 고급 설정, Product-open, 중복 방지 |
| operator | RPA 운영 대시보드, 자동화 만들기, 테스트 실행, 실행 기록, 작업 목록, 사람 확인, 실행 예약·알림, 문서 자동화 | 업무 발굴/ROI, 커넥터/템플릿, 화면 요소 저장소, 자동화 검사, 고급 설정 |
| reviewer | RPA 운영 대시보드, 실행 기록, 작업 목록, 사람 확인, 결재 인박스, 자동화 만들기, 테스트 실행 | 고급 설정 대부분 |
| approver | RPA 운영 대시보드, 결재 인박스, 사람 확인, 실행 기록, 감사 이력, 자동화 만들기 | 제작 보조 도구, 내부 점검 |
| admin | 전체 메뉴 접근 가능. 단 기본 화면은 `관리` 그룹으로 정돈하고 내부/고급 도구를 접어서 노출 | 없음 |

운영자 기본 메뉴 수는 7~8개로 제한한다. 이는 기능 수를 줄이는 것이 아니라 첫 업무 진입면을 줄이는 것이다.

## 5. 화면별 처리 정책

| 현재 화면 | 새 기본 노출 | 처리 |
|---|---|---|
| `dashboard` / RPA 운영 대시보드 | 모든 역할 | 시작 화면 유지 |
| `scenarioStudio` / 자동화 만들기 | operator 이상 | 기본 제작 진입점 |
| `playground` / 테스트 실행 | operator 이상 | 자동화 만들기 다음 단계로 유지 |
| `runTrace` / 실행 기록 | 모든 역할 | 운영 핵심 |
| `workitems` / 작업 목록 | 모든 역할 | 운영 핵심 |
| `humanTasks` / 사람 확인 | 모든 역할 | 운영 핵심 |
| `approvalInbox` / 결재 인박스 | reviewer, approver, admin | 결재 역할 중심 |
| `automationOps` / 오케스트레이션 | operator 이상 | 라벨을 `실행 예약·알림` 또는 `예약·큐 운영`으로 변경 |
| `documentIdp` / 문서 자동화 | operator 이상, 또는 feature flag | 고객 도입 범위에 따라 노출 |
| `coePipeline` / 업무 발굴/ROI | admin, CoE 성격 역할 | 기본 운영자 내비에서 숨김 |
| `connectorCatalog` / 커넥터/템플릿 | admin, CoE 성격 역할 | `고급 제작 도구`로 강등 |
| `objectRepository` / 화면 요소 저장소 | admin, CoE 성격 역할 | `고급 제작 도구`로 강등 |
| `irValidation` / 자동화 검사 | admin 또는 전문가 모드 | `자동화 만들기` 안의 검사 탭/액션으로 흡수 |
| `auditExplorer` / 감사 이력 | approver, admin | 운영자 기본 메뉴에서는 숨김 |
| `llmGateway` / AI 모델 설정 | admin | 관리 메뉴 |
| `security` / 보안/개인정보 | admin | 관리 메뉴, 내부 탭 구조 필요 |
| `idempotency` / 중복 방지 | admin 또는 전문가 모드 | 독립 1차 메뉴에서 제거. 실행/작업 재처리 맥락에 상태/도움말로 표시 |
| `openGate` / Product-open 점검 | dev/admin internal only | 일반 고객 내비에서 제거. `VITE_SHOW_INTERNAL_OPEN_GATE` 같은 빌드/환경 플래그 뒤로 이동 |

## 6. 새 내비 구조

### 운영자 기본

| 그룹 | 메뉴 |
|---|---|
| 내 작업 | RPA 운영 대시보드, 사람 확인, 작업 목록 |
| 만들기 | 자동화 만들기, 테스트 실행 |
| 운영 | 실행 기록, 실행 예약·알림, 문서 자동화 |

### 승인/검토자 기본

| 그룹 | 메뉴 |
|---|---|
| 내 작업 | RPA 운영 대시보드, 결재 인박스, 사람 확인 |
| 확인 | 실행 기록, 작업 목록, 감사 이력 |
| 만들기 | 자동화 만들기, 테스트 실행 |

### 관리자 기본

| 그룹 | 메뉴 |
|---|---|
| 운영 | RPA 운영 대시보드, 실행 기록, 작업 목록, 사람 확인, 결재 인박스, 실행 예약·알림 |
| 제작 관리 | 업무 발굴/ROI, 자동화 만들기, 테스트 실행, 커넥터/템플릿, 화면 요소 저장소, 자동화 검사 |
| 관리 | 보안/개인정보, AI 모델 설정, 감사 이력 |
| 내부 점검 | 중복 방지, Product-open 점검 |

`내부 점검` 그룹은 기본 고객 빌드에서는 숨긴다. 내부/개발 빌드 또는 admin + internal flag가 있을 때만 보인다.

## 7. 전문가 모드

역할 필터 이후에만 전문가 모드를 제공한다.

- 저장 위치: `localStorage.rpa.nav.mode = "standard" | "advanced"`
- 기본값: `standard`
- 토글 위치: 사이드바 하단 또는 Command Palette 설정 항목
- 효과: 현재 역할이 접근 가능한 고급 제작/운영 도구를 추가 노출
- 금지: 역할이 허용하지 않는 화면을 전문가 모드로 노출하지 않는다

운영자 advanced 예시:

- 커넥터/템플릿
- 화면 요소 저장소
- 자동화 검사
- 감사 이력

`Product-open 점검`은 전문가 모드가 아니라 내부 빌드 플래그로만 노출한다.

## 8. 모바일 내비

모바일/좁은 폭 기준은 `max-width: 900px`로 잡는다.

변경:

- 사이드바를 본문 위 2열 메뉴로 펼치지 않는다.
- 상단에 `메뉴` 아이콘 버튼을 둔다.
- 버튼을 누르면 full-height drawer가 열린다.
- drawer 안에는 현재 역할 기준으로 필터된 메뉴만 보인다.
- drawer는 `Escape`, backdrop click, 메뉴 선택으로 닫힌다.
- focus trap과 `aria-expanded`, `aria-controls`, `aria-modal`을 적용한다.

수락 기준:

- 390x844 캡처에서 첫 화면에 메뉴 18개가 펼쳐지지 않는다.
- 대시보드 제목과 역할 칩, 주요 작업대가 첫 화면 안에 들어온다.
- 키보드만으로 메뉴 열기, 이동, 닫기가 가능하다.

## 9. 화면 내부 정리

### 실행 예약·알림

`automationOps`는 기능을 유지하되 라벨과 섹션을 정리한다.

- 라벨: `오케스트레이션` -> `실행 예약·알림`
- 1차 탭: `운영 헬스`, `예약`, `큐`, `알림`, `연동`, `봇 풀`
- 첫 화면: 예약 작성과 큐 상태까지만 우선 노출
- `Controlled-prod readiness`는 admin/internal 영역으로 이동

### 보안/개인정보

admin 전용으로 유지하고 탭을 적용한다.

- `인증/SSO`
- `RBAC`
- `SCIM/IdP`
- `AI 거버넌스`
- `SecretRef/감사`
- `Worker/동시성`

운영자가 직접 접근했을 때는 메뉴에서 보이지 않는다. 직접 URL 접근 시에는 기존 권한 안내/백엔드 403 흐름을 따른다.

### 중복 방지

독립 메뉴를 제거하고 다음 위치에 흡수한다.

- 작업 목록: 이미 있는 `중복 방지 적용됨` 표시 유지
- 실행 기록: 재실행/복구 명령 옆에 중복 방지 설명 tooltip 추가
- 내부 문서형 화면: admin advanced 또는 docs 링크로 유지

### 자동화 검사

독립 메뉴를 줄이고 `자동화 만들기` 안으로 흡수한다.

- 자동화 상세/편집 화면의 `검사` 탭
- 운영 반영 전 CTA: `검사 실행`
- Command Palette에서는 admin/advanced일 때만 직접 검색 가능

## 10. 구현 설계

### 파일 구조

새 파일:

- `web/src/navPolicy.ts`

역할:

- 화면별 visibility policy 선언
- role/mode/feature flag 기준으로 visible groups 생성
- Command Palette와 Layout이 같은 정책을 사용

예상 타입:

```ts
type NavMode = "standard" | "advanced";

type NavVisibility = {
  readonly standardRoles?: readonly string[];
  readonly advancedRoles?: readonly string[];
  readonly requiredAction?: string;
  readonly internalOnly?: boolean;
};
```

`router.ts`의 `VIEW_KEYS`는 그대로 유지한다. 라우팅 가능한 화면 목록과 메뉴 노출 정책을 분리해야 직접 URL, 테스트, 기존 링크가 깨지지 않는다.

### Layout

- `decodeRoles(localStorage.getItem("rpa.token"))` 결과를 사용한다.
- `useVisibleNavGroups({ roles, mode, flags })`로 렌더한다.
- 현재 `view`가 숨김 화면일 경우:
  - 직접 URL 진입은 허용
  - 사이드바에는 표시하지 않음
  - 상단에 필요하면 `고급 도구` breadcrumb 또는 badge 표시

### Command Palette

- 기본 검색: 현재 역할 + 현재 모드에서 보이는 화면
- admin advanced: 전체 관리 화면 검색 가능
- 내부 화면: internal flag 없으면 검색 결과 제외

### Dashboard

- 운영자 quick action에서 `Product-open 점검` 제거
- admin quick action에는 `보안/개인정보`, `AI 모델 설정`, `Product-open 점검` 유지 가능

## 11. 테스트 계획

필수:

- `web/test/nav-policy.test.ts`
  - viewer/operator/reviewer/approver/admin별 visible view 목록 검증
  - `openGate`는 internal flag 없으면 숨김
  - `idempotency`는 standard operator에서 숨김
- `web/test/layout-nav-policy.test.tsx`
  - operator는 고급 설정 메뉴가 보이지 않음
  - admin은 관리 메뉴가 보임
  - 현재 숨김 URL 직접 진입 시 화면은 렌더되지만 nav item은 없음
- `web/test/command-palette.test.tsx`
  - standard operator 검색 결과에 `Product-open 점검`, `중복 방지` 없음
  - admin/internal에서만 `Product-open 점검` 검색 가능
- `web/test/mobile-nav.test.tsx`
  - 좁은 폭에서 메뉴 drawer 버튼 렌더
  - 메뉴가 본문 위에 18개 펼쳐지지 않음
  - drawer 열기/닫기와 focus 회귀 검증

수동/시각 확인:

```powershell
npm --prefix web run typecheck
npm --prefix web test
npm --prefix web run build
npm --prefix web run dev
```

브라우저 캡처:

- desktop 1280x720: operator dashboard, admin dashboard
- mobile 390x844: operator dashboard, menu drawer open/closed

## 12. 수락 기준

Phase 15 완료 조건:

1. operator 기본 메뉴가 7~8개로 줄어든다.
2. viewer/operator 기본 메뉴에서 `Product-open 점검`, `중복 방지`, `보안/개인정보`, `AI 모델 설정`이 보이지 않는다.
3. `오케스트레이션` 라벨이 운영자 언어로 바뀐다.
4. `자동화 검사`는 기본 1차 메뉴에서 내려가고 `자동화 만들기` 흐름 안에서 접근 가능하다.
5. 모바일 390x844 첫 화면에서 18개 메뉴가 본문 위에 펼쳐지지 않는다.
6. admin/internal에서는 기존 진단·검증 화면 접근성을 잃지 않는다.
7. API/DB/계약 변경 없이 `web/` 변경과 테스트로 닫힌다.

## 13. 후속 구현 순서

1. `navPolicy.ts` 추가와 역할별 메뉴 필터링
2. `Layout` 모바일 drawer 전환
3. `CommandPalette` visibility 정책 공유
4. `VIEW_META` 라벨 변경
5. Dashboard quick action 정리
6. `automationOps`, `security` 탭화
7. 스크린샷 회귀 감사
