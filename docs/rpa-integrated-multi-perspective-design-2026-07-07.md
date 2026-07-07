# RPA 통합 제품 설계: 다중 관점 개선안

Date: 2026-07-07
Status: design v1 for implementation planning

## 1. 목적

이 문서는 현재 RPA 플랫폼을 사용자, 관리자, 아키텍트, 보안 전문가, UI/UX 전문가 관점에서 평가한 결과를 하나의 제품 설계로 통합한다.

목표는 두 가지를 분리해서 달성하는 것이다.

1. 통제된 파일럿을 빠르게 시작할 수 있는 콘솔 경험을 만든다.
2. controlled production 전환은 실제 owner evidence가 모두 채워질 때만 가능하게 한다.

이 문서는 `state-machine.md`, `api-surface.md`, `auth-rbac.md`, `security-contracts.md`, `ops-defaults.md`, `docs/current-readiness-report.md`, `docs/rpa-console-adoption-onboarding-design-2026-07-01.md`, `audit/rpa-console-fullscreen-ux-2026-07-01/notes.md`를 기준으로 한다. 계약이 이 문서보다 우선한다.

## 2. 현재 평가와 목표 점수

| 관점 | 현재 점수 | 목표 점수 | 설계 방향 |
| --- | ---: | ---: | --- |
| 사용자/운영자 | 82 | 89 | 첫 자동화 생성, 사이트/세션 준비, 실패 복구를 한 여정으로 묶는다. |
| 관리자 | 88 | 92 | SSO, RBAC, SecretRef, SCIM, readiness, 증빙 패킷을 하나의 관리자 setup path로 제공한다. |
| 아키텍트 | 89 | 92 | contract-first 구조를 유지하면서 구현 slice와 gate를 명확히 나눈다. |
| 보안 전문가 | 91 | 94 | SecretRef-only, fail-closed, audit hash-chain, RLS/RBAC evidence를 더 쉽게 검토하게 한다. |
| UI/UX 전문가 | 83 | 90 | 화면 밀도, 빈/오류 상태, 전문 용어, 첫 action affordance를 정리한다. |

제품 포지션:

- 파일럿 준비도: 89-90 목표.
- controlled production 준비도: owner evidence가 없는 한 78-82로 유지한다.
- UI가 readiness를 올려 보이게 하면 안 된다. 빠진 증거는 `확인 필요`, `보류`, `차단`으로 보여야 한다.

V1 범위 결정:

- 신규 top-level route는 만들지 않는다. `관리자 도입 설정`은 `dashboard` 안의 admin-only panel로, `증빙 패킷`은 `dashboard` 안의 강화된 제품 표면으로 구현한다.
- 운영 준비 증빙 입력과 검증은 기존 `automationOps?section=readiness`를 기준으로 한다.
- `security`는 내비게이션에서 계속 admin-only다. 운영자/검토자가 deep link로 들어온 경우 write surface를 열지 않고 read-only summary와 권한 안내만 제공한다.
- 신규 route가 필요한 v2 전환은 별도 product decision으로 남기며, 그 전에는 `VIEW_KEYS`, `NAV_GROUPS`, `VIEW_META`, `App.renderView`를 변경하지 않는다.

## 3. 설계 원칙

1. No silent green: 알 수 없는 상태를 성공으로 표시하지 않는다.
2. Evidence first: 운영 전환, 외부 알림, PITR, SLO, 교육, 보안 승인은 실제 metadata-only evidence로만 통과한다.
3. SecretRef-only: URL, token, password, webhook secret, resolved SecretRef material은 UI, audit, export, release packet에 노출하지 않는다.
4. Progressive disclosure: 운영자 첫 화면은 오늘 할 일과 다음 action만 보여주고, 관리자/보안/아키텍트 상세는 섹션 뒤로 둔다.
5. Role-aware by default: 내비게이션은 안내일 뿐 권한 우회가 아니다. 최종 허용은 backend RBAC가 결정한다.
6. PC console first: 현재 단계의 품질 기준은 데스크톱 콘솔이다. 모바일은 회귀 방지 수준으로 유지한다.

## 4. 대상 사용자와 핵심 질문

| 관점 | 핵심 질문 | 설계 응답 |
| --- | --- | --- |
| 사용자/운영자 | 지금 무엇을 만들고, 무엇을 처리하고, 어디서 실패를 복구하는가? | `오늘 할 일`, `자동화 초안 만들기`, `실행 기록`, `사람 확인`을 첫 레벨에 둔다. |
| 관리자 | 첫 도입에 필요한 SSO, 권한, 사이트, 세션, SecretRef, SCIM이 닫혔는가? | `관리자 도입 설정` 체크리스트와 evidence packet을 제공한다. |
| 아키텍트 | 이 구조가 contract-first, 확장 가능, drift 방지 가능한가? | slice별 API/DB/codegen/test gate를 명시하고 계약 변경 없이는 성공 경로를 만들지 않는다. |
| 보안 전문가 | 비밀, tenant, redaction, audit, 외부 egress가 안전한가? | SecretRef 경계, RLS/RBAC, audit hash-chain, allowed host, fail-closed evidence를 화면에서 검토한다. |
| UI/UX 전문가 | 첫 화면에서 다음 행동이 명확하고 오류 상태가 제품 고장처럼 보이지 않는가? | 빈 상태, API 미연결, 권한 부족, 설정 필요를 page-level state로 구분한다. |

## 5. 목표 정보 구조

### 5.1 운영자 기본 내비게이션

| 그룹 | 화면 | 목적 |
| --- | --- | --- |
| 내 업무 | 오늘 할 일, 사람 확인, 작업 목록 | 처리해야 할 task와 실패 복구를 먼저 보여준다. |
| 자동화 | 자동화 만들기, 테스트 실행, 실행 기록, 실행 예약/알림 | 만들기, 검증, 운영을 순서대로 연결한다. |
| 현황 | 대시보드 | 파일럿 준비, 최근 상태, ROI/비용 추세를 요약한다. |
| 감사/증빙 | 감사 이력, 대시보드 증빙 패킷 | viewer도 안전한 metadata-only 증빙을 볼 수 있다. 단, v1에서는 별도 top-level `evidence` route를 만들지 않는다. |

### 5.2 관리자 기본 내비게이션

관리자는 운영자 메뉴에 더해 다음을 본다.

| 화면 | 목적 |
| --- | --- |
| 관리자 도입 설정 | `dashboard` admin panel에서 SSO, RBAC, SCIM, 첫 관리자 bootstrap runbook, SecretRef, 사이트/세션 준비를 점검 |
| 보안/개인정보 | sites, access, secrets, ai, infra 섹션 허브 |
| 운영 준비 증빙 | `automationOps?section=readiness`에서 controlled-prod readiness owner evidence 입력과 검증 |
| 내부 점검 | Product-open, idempotency, gateway, IR validation 등 내부/고급 점검 |

라우팅 원칙:

- v1 구현은 기존 route만 사용한다: `dashboard`, `automationOps`, `security`, `auditExplorer`, `runTrace`, `humanTasks`, `workitems`.
- 신규 화면명이 필요한 경우에도 component/panel 이름으로만 둔다. route key 추가는 별도 PR에서 router, nav policy, meta, layout icon, command palette, 테스트를 함께 갱신할 때만 허용한다.

## 6. 핵심 화면 설계

### 6.1 파일럿 준비 대시보드

대시보드 상단에 `파일럿 준비 상태` 패널을 고정한다.

Gate:

| Gate | 통과 조건 | 실패/보류 표시 | CTA |
| --- | --- | --- | --- |
| SSO/Auth | `/v1/auth/readiness.enterprise_sso_ready=true` | `확인 필요` 또는 `차단` | 접속 설정 확인 |
| RBAC | role mapping configured, mapped values > 0 | `권한 매핑 필요` | 역할 매핑 확인 |
| 사이트 | site_profiles 1개 이상 | `사이트 등록 필요` | 사이트 등록 |
| 브라우저 세션 | login_capable site의 session_ready=true | `세션 등록 필요` | 세션 등록 |
| 첫 자동화 | scenario 1개 이상 | `초안 없음` | 자동화 초안 만들기 |
| 테스트 실행 | run summary total > 0 | `첫 실행 전` | 테스트 실행 |
| 실행 증빙 | recent run 또는 artifact metadata 존재 | `증빙 없음` | 실행 증빙 보기 |
| 운영 지원 | `productionReadiness.summary.controlled_prod_ready === true` | `차단 N, 경고 N, 보류 N` | 운영 증빙 확인 |
| ROI | roi_actuals evidence_count > 0 | `실적 증빙 없음` | 성과 리포트 보기 |

규칙:

- API 미연결이면 각 패널이 중복 오류를 내지 않고 page-level `API 연결 필요`를 보여준다.
- 값이 없으면 dash 대신 `첫 실행 전`, `연결 필요`, `권한 필요`, `보류`를 쓴다.
- CTA는 `requiredAction`을 가진다. 권한이 없으면 버튼 대신 `권한 있는 담당자에게 요청`을 보여준다.
- `ProductionReadiness.status="warning"`은 운영 투입 가능 상태가 아니다. dashboard adoption gate에서는 amber로 보이더라도 최종 문구는 `운영 전 경고 해소 필요`로 표시한다.
- 운영 준비 최종 판정은 blocker/deferred 개수만 보지 않고 `summary.controlled_prod_ready`를 단일 source of truth로 삼는다.

### 6.2 자동화 만들기 첫 화면

첫 viewport의 primary action은 자연어 입력이다.

구성:

- 업무 설명 입력: “어떤 반복 업무를 자동화할까요?”
- site/session precheck chip: 사이트 없음, 세션 필요, 준비됨.
- primary CTA: `자동화 초안 만들기`.
- secondary CTA: `브라우저에서 녹화`.
- tertiary link: `기존 템플릿/커넥터에서 시작`.

동작:

- 사이트가 없으면 run을 만들지 않고 `site_required` blocker와 사이트 등록 CTA를 보여준다.
- login session이 필요하면 `session_required` blocker와 세션 등록 CTA를 보여준다.
- start_url만 있고 target이 0건/다건이면 추측하지 않고 `target_required_for_auto_run`으로 차단한다.
- blocked generation은 수정 후 같은 ledger에서 재시도한다. 새 generation을 중복 생성하지 않는다.

### 6.3 관리자 도입 설정

v1에서는 신규 `AdminAdoptionSetup` route를 만들지 않고, `dashboard`의 admin-only panel로 제공한다. 목표는 “첫 도입 담당자가 문서를 읽지 않고도 안전한 파일럿 순서를 이해”하게 하는 것이다.

섹션:

1. 접속과 역할: SSO readiness, JWT claim mapping, RBAC matrix, 첫 관리자 bootstrap runbook. UI에서 token을 발급하거나 표시하지 않는다.
2. 사람과 조직: Principal directory, SCIM provider, group-role mapping.
3. 비밀과 연결: SecretRef audit, credential registration, connector profile.
4. 사이트와 세션: site registration, risk approval, browser session capture.
5. 첫 자동화: scenario draft, validation, test run.
6. 증빙 패킷: audit, readiness, ROI, support evidence metadata export.

각 섹션은 `ready`, `needs`, `blocked`, `deferred` 상태를 가진다. production readiness 원천 상태의 `warning`은 `needs`로 접어 표시할 수 있지만 copy에는 반드시 `경고`를 남긴다. 임의 owner note만으로 pass 처리하지 않는다.

### 6.4 보안/개인정보 허브

현재 `SecurityView`의 `sites/access/secrets/ai/infra` 섹션 구조를 제품 표준으로 삼는다.

개선:

- `sites`: 사이트 등록, red-risk approval, session capture, encryption status, site circuit.
- `access`: SSO, RBAC, principal directory, SCIM.
- `secrets`: SecretRef audit, security connections, credential concurrency.
- `ai`: runtime policy, AI governance evidence, policy decision/audit correlation.
- `infra`: worker pools, pool status, stale/circuit evidence.

규칙:

- 운영자가 deep link로 접근해도 admin wall이나 write form을 바로 보여주지 않는다. nav는 admin-only로 유지하고, 직접 URL 접근 시 허용된 read-only summary와 권한 안내만 먼저 보여준다.
- raw prompt/output, session body, secret material, audit payload body는 렌더링하지 않는다.
- 보안 판단은 UI copy가 아니라 backend RBAC와 audit boundary가 최종 결정한다.

### 6.5 운영/알림 화면

`실행 예약·알림`의 첫 화면은 `오늘 필요한 조치`로 시작한다.

첫 화면 카드:

- SLA/실패/세션 만료/worker stale/queue backlog 중 action 필요한 항목.
- 각 항목은 affected scenario/run/site와 next action을 가진다.
- alert ack는 외부 전달 성공으로 표시하지 않는다.

로컬 섹션:

1. 오늘 필요한 조치.
2. 예약과 트리거.
3. 큐와 worker health.
4. 알림 센터.
5. 외부 전달/receipt.
6. controlled-prod readiness.

외부 알림 규칙:

- `sent`와 `delivered`를 분리한다.
- delivered는 provider receipt/callback metadata가 있어야 한다.
- endpoint URL, webhook URL, Authorization header, token은 UI와 export에서 금지한다.

### 6.6 증빙 패킷

`AdoptionEvidencePacket`을 v1에서는 dashboard 내 제품 표면으로 강화한다. 별도 top-level route/export center는 v2 결정 전까지 만들지 않는다.

포함:

- tenant, environment, generated_at.
- SSO/RBAC summary.
- site/session readiness.
- scenario certification/release status.
- first run and artifact metadata.
- audit verifier freshness.
- SecretRef audit summary.
- AI governance evidence summary.
- production readiness gate summary.
- ROI estimate vs actual evidence.
- route/link targets는 기존 화면만 사용한다: `auditExplorer`, `automationOps?section=readiness`, `security?section=...`, `runTrace`, `dashboard?focus=automation-report`.

금지:

- raw audit payload.
- raw prompt/model output.
- raw URLs, endpoint URLs, webhook URLs.
- tokens, passwords, resolved SecretRef material.
- raw rosters/user lists/training documents.

Export:

- CSV/XLSX/Markdown는 BOM과 local time formatting을 일관 적용한다.
- export는 evidence reference와 metadata만 포함한다.
- controlled-prod packet validator가 요구하는 negative proof를 포함한다.

## 7. 역할별 핵심 여정

### 7.1 사용자/운영자: 첫 자동화 파일럿

1. 대시보드에서 파일럿 준비 상태 확인.
2. 사이트가 없으면 사이트 등록.
3. 로그인이 필요한 site면 운영자 PC 세션 등록.
4. 자연어로 업무 설명 입력.
5. 자동화 초안 생성.
6. validation blocker 확인.
7. 테스트 실행.
8. 실패 시 RunTrace에서 원인 확인, rerun 또는 human task 처리.
9. 성공 run evidence와 ROI actual을 연결.

성공 기준:

- 사용자는 첫 화면에서 다음 action을 하나 이상 이해한다.
- 세션/사이트/권한 부족이 raw error가 아니라 actionable state로 표시된다.
- run failure에서 다시 실행하거나 사람 확인으로 이동할 수 있다.

### 7.2 관리자: 파일럿 setup

1. 관리자 도입 설정 진입.
2. SSO/JWT claim readiness 확인.
3. RBAC role mapping 및 principal directory 준비.
4. SCIM provider와 group mapping 연결.
5. SecretRef, credential scope, connector profile 등록.
6. 사이트와 세션 준비.
7. controlled-prod readiness의 blocked/deferred gate 확인.
8. evidence packet 생성.

성공 기준:

- 관리자는 “파일럿 가능”과 “production 불가” 이유를 분리해서 설명할 수 있다.
- owner evidence가 없는 gate는 pass가 되지 않는다.

### 7.3 아키텍트: 구조 검토

1. 계약 문서와 codegen consistency 확인.
2. API surface와 DB migration, RLS, outbox, worker flow 확인.
3. 배포 topology: API, worker, lifecycle worker, browser worker, object store, SecretStore, metrics 확인.
4. run-local-gates와 temp DB gate 결과 확인.
5. production-open 미충족 증거를 owner decision으로 분리.

성공 기준:

- 계약 변경 없이 구현만 성공 경로를 만들지 않는다.
- 새 surface는 OpenAPI/codegen/test를 동반한다.
- drift는 CI나 fixture에서 잡힌다.

### 7.4 보안 전문가: 운영 전 보안 검토

1. SecretRef-only 경계 확인.
2. artifact redaction gate와 RBAC gate 확인.
3. prompt injection/redaction boundary 확인.
4. network allowlist와 egress receipt 확인.
5. audit hash-chain verifier freshness 확인.
6. BYPASSRLS usage audit 확인.
7. AI governance runtime policy와 block/warn/observe mode 확인.

성공 기준:

- 비밀 평문은 UI/API/export/audit에 없다.
- 보안 audit append 실패 시 보호 자원 반환이 차단된다.
- unknown은 healthy로 표시되지 않는다.

### 7.5 UI/UX 전문가: 화면 품질 검토

1. 첫 viewport에서 primary action이 보이는지 확인.
2. 빈 상태, API 미연결, 권한 부족, 설정 필요가 구분되는지 확인.
3. 화면별 정보 밀도가 과도하지 않은지 확인.
4. 버튼과 링크 copy가 목적어를 가지는지 확인.
5. status badge 색상만으로 의미를 전달하지 않는지 확인.
6. keyboard/focus/aria/contrast를 테스트한다.

성공 기준:

- raw enum, raw ISO timestamp, HTTP error code가 주 copy로 노출되지 않는다.
- repeated failure banner가 page-level summary로 정리된다.
- 대시보드와 주요 작업 화면에 axe 위반이 없다.

## 8. API와 데이터 매핑

| 제품 표면 | 주요 데이터/API | 비고 |
| --- | --- | --- |
| 파일럿 준비 상태 | `GET /v1/auth/readiness`, `/v1/sites`, `/v1/runs/summary`, `/v1/runs`, `GET /v1/ops/production-readiness`, `GET /v1/reports/automation-performance?month=YYYY-MM&run_mode=prod` | readiness는 `summary.controlled_prod_ready`를 최종 기준으로 삼고 `blocked`, `warning`, `deferred`를 모두 실패/미해소 상태로 표시한다. |
| 자동화 초안 만들기 | scenario generation, `/v1/scenario-generations/{id}/run`, `/v1/sites`, connector catalog | target 추측 금지. |
| 사이트/세션 | `/v1/sites`, `/v1/sites/{id}/session/capture`, `/v1/capabilities` | server capture off면 운영자 PC 등록 안내. |
| 관리자 설정 | auth readiness, principals, role assignments, SCIM providers, SecretRef audit | admin-only write. |
| 운영 알림 | `/v1/ops-alerts`, `/ack`, `/deliveries`, `/deliveries/send-webhook`, `/webhooks/ops-alerts/...` | ack와 delivered 분리. |
| 증빙 패킷 | audit verifier, production readiness, AI governance summary, ROI actuals, SecretRef audit summary | dashboard 내 metadata-only packet. `/v1/audit-log/summary?action=secret.resolve`, `/v1/ai-governance/evidence/summary`처럼 목록 페이지 절단 없는 summary를 우선 사용한다. raw payload, raw URL, token/password/resolved SecretRef 금지. |
| 실행 기록 | `/v1/runs`, `/v1/runs/{id}/steps`, `/v1/runs/{id}/artifacts`, `/v1/artifacts/{id}` | artifact body는 audit boundary 후 조회. |

## 9. 구현 Slice

### Slice A: 파일럿 준비 대시보드

목표: 사용자/관리자/도입 담당자가 파일럿 준비 상태와 다음 action을 첫 화면에서 본다.

작업:

- `AdoptionReadinessPanel` gate copy 정리.
- API error를 page-level state로 통합.
- dashboard metrics의 dash placeholder 제거.
- readiness CTA에 `requiredAction` 적용.

테스트:

- `web/test/dashboard.test.tsx`
- `web/test/adoption-readiness.test.tsx`
- `web/test/a11y.test.tsx`

### Slice B: 자동화 만들기 첫 action

목표: 자연어 입력과 site/session precheck를 첫 viewport로 승격한다.

작업:

- `ScenarioStudio` 또는 creation surface의 첫 패널 재구성.
- site/session blocker CTA 연결.
- blocked generation 재시도 UX 정리.
- run 생성 전 target inference 실패를 사용자 copy로 변환.

테스트:

- `web/test/scenario-studio-first-action.test.tsx`
- `web/test/session-registration-cta.test.tsx`
- `app/test/api-scenario-generations.int.ts`

### Slice C: 관리자 도입 설정

목표: 관리자 setup을 `dashboard` admin-only panel 안의 checklist로 묶는다.

작업:

- 신규 `AdminAdoptionSetup` view는 만들지 않는다.
- `DashboardView` 안에 admin-only setup panel을 추가하거나 기존 readiness panel을 확장한다.
- SSO/RBAC/SCIM/SecretRef/site/session/readiness 항목 통합.
- first admin bootstrap은 runbook 링크와 상태만 제공한다. token 발급/표시/복사는 UI에 만들지 않는다.
- route 추가가 필요하다는 판단이 생기면 이 Slice를 중단하고 `VIEW_KEYS`, `NAV_GROUPS`, `VIEW_META`, `App.renderView`, `navPolicy`, route 테스트를 포함한 별도 설계 변경으로 승격한다.

테스트:

- `web/test/dashboard.test.tsx`
- `web/test/adoption-readiness.test.tsx`
- `web/test/security-auth-readiness.test.tsx`
- `web/test/scim-provider-panel.test.tsx`
- `web/test/security-secret-audit.test.tsx`
- `app/test/api-scim.int.ts`

### Slice D: 운영/알림 화면 하드닝

목표: 이미 있는 `AutomationOps` 로컬 섹션 구조를 재구현하지 않고, action-oriented summary와 상태 copy를 보강한다.

작업:

- 기존 `AutomationOps` 로컬 섹션(`today`, `schedule`, `queue`, `alerts`, `readiness`, `external`)을 유지한다.
- alert grouping과 dedupe copy.
- `sent`/`delivered`/`acknowledged` 구분 강화.
- readiness owner evidence form은 `automationOps?section=readiness`에 남긴다.

테스트:

- `web/test/automation-ops.test.tsx`
- `app/test/ops-notification-delivery.int.ts`
- `app/test/api-ops-alerts.int.ts`

### Slice E: 증빙 패킷과 보안 리뷰 표면

목표: dashboard 안에서 파일럿/보안/구매 검토에 필요한 metadata-only packet을 만든다.

작업:

- `AdoptionEvidencePacket`은 v1에서 dashboard embedded panel로 유지한다.
- audit verifier freshness, SecretRef summary, readiness evidence, ROI actual 연결.
- export negative proof copy.
- security deep link CTA는 admin nav 노출을 늘리지 않고 read-only summary와 권한 안내를 통과한다.

테스트:

- `web/test/dashboard.test.tsx`
- `web/test/security-section-nav.test.tsx`
- `web/test/ai-governance-evidence.test.tsx`
- `web/test/audit-explorer.test.tsx`
- `npm --prefix codegen run prod-readiness-packet:fixtures`
- `npm --prefix codegen run secret:scan-fixtures`

### Slice F: UX 품질 하드닝

목표: 한국어 copy, 시간 표기, 오류 상태, 접근성 품질을 정리한다.

작업:

- raw ISO timestamp 금지. `web/src/util/time.ts`로 통일.
- raw enum/error code는 badge label로 변환.
- page-level empty/error policy 적용.
- visible text overflow, keyboard focus, aria labels 검증.

테스트:

- `web/test/time-util.test.ts`
- `web/test/error-label.test.ts`
- `web/test/badge-contrast.test.ts`
- `web/test/a11y.test.tsx`

## 10. Controlled Production Gate

다음 항목은 UI 개선만으로 pass 처리할 수 없다.

| Gate | 필요한 owner evidence |
| --- | --- |
| External alert delivery | delivered provider receipt metadata. `sent` 또는 `ack`는 부족하다. |
| Managed backup/PITR | restore drill, RTO <= 120m, RPO <= 15m metadata. |
| SLO/on-call | dashboard, severity model, rota, RACI, support hours. |
| Support/training | support model, training completion, trained counts, coverage percent. |
| Observability telemetry | prometheus/otlp exporter, collector, dashboard, alert route evidence. |
| External deployment approval | namespace, ingress, platform approval, rollback evidence. |

UI 규칙:

- gate가 missing이면 `deferred`.
- gate가 `warning`이면 controlled-prod 통과가 아니다.
- 최신 evidence가 failed이면 `blocked`.
- arbitrary notes만 있으면 pass 불가.
- 최종 운영 가능 표시는 `GET /v1/ops/production-readiness`의 `summary.controlled_prod_ready=true`일 때만 허용한다.
- raw URL, dashboard URL, roster, token, resolved SecretRef material은 evidence field에 넣을 수 없다.

## 11. 수락 기준

### 사용자/운영자

- 첫 화면에서 다음 action이 하나 이상 명확하다.
- 사이트/세션/권한/첫 실행 전 상태가 raw error 없이 표시된다.
- 실패 run에서 rerun, resume, human task, evidence lookup으로 이동할 수 있다.

### 관리자

- SSO, RBAC, SCIM, SecretRef, site/session, readiness gate를 한 화면에서 추적한다.
- admin-only write action은 권한 없는 사용자에게 버튼으로 보이지 않는다.
- 설정이 부족한 항목은 성공으로 표시하지 않는다.
- UI는 first admin token을 발급/표시/복사하지 않고 bootstrap runbook 상태와 링크만 제공한다.

### 아키텍트

- 새 API/응답 필드는 additive unless contract change.
- codegen, OpenAPI, fixtures, DB migration smoke가 동반된다.
- local gate와 temp DB gate 실행 방법이 PR에 남는다.

### 보안 전문가

- SecretRef material은 UI/API/export/log/audit payload에 없다.
- artifact body 조회는 redaction/RBAC/audit boundary를 통과한다.
- prompt injection과 network egress는 fail-closed evidence를 남긴다.
- `security` nav는 admin-only로 유지되며, 비관리자 deep link는 read-only summary와 권한 안내만 렌더링한다.
- production readiness의 `warning`, `blocked`, `deferred`는 모두 controlled-prod 미통과로 표시된다.

### UI/UX 전문가

- dashboard, create automation, security hub, automation ops, evidence packet이 데스크톱에서 첫 viewport 기준으로 의미가 선명하다.
- repeated panel-level failure blocks가 page-level summary로 정리된다.
- axe, keyboard focus, contrast, text overflow 검증을 통과한다.
- desktop 1280px/1440px 스크린샷에서 주요 panel heading, CTA, status badge가 겹치지 않는다.

## 12. PR 체크리스트

PR은 다음을 포함해야 한다.

- 변경된 계약 파일 또는 계약 변경 없음 명시.
- UI 변경 screenshots 또는 audit folder evidence.
- `npm --prefix web run typecheck`
- `npm --prefix web test`
- UI 구조/import 변경 시 `npm --prefix web run build`
- app boundary 변경 시 `npm --prefix app run typecheck` 및 focused unit/int tests.
- contract/codegen 변경 시 `npm --prefix codegen run typecheck` 및 `npm --prefix codegen run fixtures`.
- readiness/export/security 변경 시 secret scan 및 packet fixture.
- route/nav 변경 시 `web/src/router.ts`, `web/src/navPolicy.ts`, `web/src/views/meta.ts`, `web/src/App.tsx`, layout icon mapping, command palette 영향과 `router.test.ts`, `nav-policy.test.ts`, `layout-nav-policy.test.ts` 갱신.
- `security` deep link 동작 변경 시 비관리자 token 테스트를 추가한다.

## 13. 남은 결정

| 결정 | Owner | 차단되는 범위 |
| --- | --- | --- |
| OTP/MFA readiness wording | Security/RPA owner | 세션 갱신, human-first suspend copy |
| production external notification providers | Platform/Security owner | Slack/Teams/email/PagerDuty profile pass 처리 |
| PITR/SLO/support evidence source | Operations owner | controlled-prod readiness pass |
| mobile scope | Product owner | 모바일을 acceptance target으로 올릴지 여부 |
| v2 dedicated adoption/evidence route | Product owner | v1은 dashboard panel 고정. 별도 route 전환 여부만 후속 결정 |

결정 전에는 추측하지 않는다. 구현이 필요하면 repo의 blocked-decision 규칙에 맞는 차단 주석과 required decision을 남긴다.

## 14. 최종 설계 입장

이 솔루션은 이미 보안과 운영 계약이 강한 엔터프라이즈 RPA 플랫폼이다. 다음 설계 단계의 핵심은 기능을 더 추가하는 것이 아니라, 사용자가 안전한 순서로 파일럿을 시작하고 관리자가 production 전환 증거를 빠짐없이 닫도록 만드는 것이다.

제품은 다음을 말해야 한다.

> 지금 파일럿을 위해 준비된 것, 아직 필요한 것, production을 막는 증거 부족 항목이 무엇인지 명확히 보여준다.

그리고 절대 다음을 말하면 안 된다.

> 증거가 없지만 준비된 것으로 간주한다.
