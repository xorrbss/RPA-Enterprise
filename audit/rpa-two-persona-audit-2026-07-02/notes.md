# RPA 두-페르소나 제품 감사 — 도입 담당자 · 실사용자 (2026-07-02)

Date: 2026-07-02
Method: (1) 멀티에이전트 정적 감사 — 2페르소나×4차원 8 finder → 발견 건별 적대 검증(반박 0·심각도 조정 6) → 완결성 비평(횡단 5건 file:line 실증). (2) 라이브 브라우저 재감사 — `dev:serve`(temp PG·시드) + 실 Chrome 전 화면 순회(전 역할/운영자/뷰어), 데스크톱 1440×900.
Baseline: main @ 82b8017f (Phase 6 + 통합 업무 UX PR1~PR4 머지 후)
Consumer: `docs/rpa-console-usability-hardening-design-2026-07-02.md` (이 감사를 해소하는 구현 설계)

## 점수

| 관점 | 정적 감사 | 라이브 반영 최종 |
| --- | ---: | ---: |
| 도입 담당자 (여정 완주 잣대) | 74 | **73** |
| 실사용자 (여정 완주 잣대) | 73 | **72** |

주의: 과거 "도입담당자 90"·설계 문서의 "buyer confidence 84→88"은 **콘솔-가시 신뢰도** 잣대이고, 본 감사는 배포·부트스트랩까지 포함한 **여정 완주** 잣대다. 잣대가 다르므로 수치 비교 금지.

### 차원 점수 (정적 감사, finder 판정)

| 관점 | 차원 | 점수 |
| --- | --- | ---: |
| 도입 | 온보딩·초기 설정 여정 | 68 |
| 도입 | 보안·컴플라이언스 증빙 | 73 |
| 도입 | 운영 부담·TCO·ROI 가시성 | 78 |
| 도입 | 설계 대비 구현 갭 (Slice A0~A4) | 84 |
| 사용자 | 자동화 만들기 흐름 | 75 |
| 사용자 | 일상 운영 (내 할 일·사람 확인·실패 대응) | 68 |
| 사용자 | 관찰성·실행 추적·신뢰 | 78 |
| 사용자 | 언어·일관성·접근성 | 76 |

라이브 반영 조정: 도입 온보딩 68→67(비보안 컨텍스트 크래시 × 콘솔 배포 갭 결합), 사용자 관찰성 75→73(실행 익명성 실측 가중·사이드바 비고정), 사용자 언어 76→74(AI 거버넌스 전면 영어·문장 내 raw enum·날짜 3종 실측). 설계이행 84는 "A0~A4 설계 대비 이행률" 잣대(여정 완주 아님)임을 병기.

## 정적 감사 발견 레지스터 (51건 전건 적대 검증 생존)

심각도는 검증 조정 후 값. 상세 근거·재현 시나리오·권고 전문은 세션 워크플로우 산출물(wf_78cdc6e0-36d)에 있으며, 실행 항목은 설계 문서의 슬라이스로 매핑된다.

| ID | P | 차원 | 제목 | 대표 근거 |
| --- | --- | --- | --- | --- |
| `console-deploy-packaging-missing` | P2 | 도입 · 온보딩·초기 설정 여정 | 웹 콘솔 자체의 배포 수단·문서가 전무 — 런타임(compose/k8s/helm)은 패키징돼 있으나 콘솔 정적 자산은 어디에도 없음 | Dockerfile:29-38 (app/src·codegen·db 등만 COPY, web/ 부재) |
| `first-admin-token-bootstrap` | P1 | 도입 · 온보딩·초기 설정 여정 | 첫 관리자 '접속 코드'(JWT) 발급 절차가 제품 어디에도 없음 — 접속 화면은 '담당자가 발급'이라 하지만 발급 도구·문서가 부재한 부트스트랩 공백 | web/src/components/TokenGate.tsx:83-87 ('접속 코드는 관리자 또는 IT 담당자가 발급합니다'  |
| `session-capture-prod-dead-path` | P2 | 도입 · 온보딩·초기 설정 여정 | 운영/스테이징 배포에서 콘솔 '세션 등록' 주 버튼이 dead-path — '로그인 창을 엽니다'라고 약속하지만 행만 만들고 아무 것도 안 일어남 | app/src/api/sessions.ts:5-6,214-249 (applyCaptureStart는 capture_sessio |
| `capture-guide-windows-and-repo-burden` | P2 | 도입 · 온보딩·초기 설정 여정 | '운영자 PC 등록' 안내 명령이 Windows에서 실행 불가(POSIX env 접두 구문)이고, 운영자 PC에 소스 저장소+Node+의존성 설치를 전제 | web/src/components/CaptureGuide.tsx:21 (`RPA_OPERATOR_TOKEN=<본인 접속 코드> |
| `landing-no-adoption-entry` | P2 | 도입 · 온보딩·초기 설정 여정 | 첫 접속 랜딩('내 할 일')이 파일럿 준비 여정으로 전혀 안내하지 않고, 빈 테넌트에서 '자동화가 알아서 처리하고 있습니다'라는 거짓 안심 문구를 보여줌 | web/src/router.ts:35 (DEFAULT_VIEW="myWork") |
| `site-form-selector-placeholder-mislead` | P2 | 도입 · 온보딩·초기 설정 여정 | 사이트 등록 간이 필드가 CSS 선택자를 요구하면서 placeholder는 자연어 예시('예: 사용자 메뉴')를 보여줘, 그대로 넣으면 세션 캡처가 로그인 감지를 못 하고 만료됨 | web/src/components/SiteCreateForm.tsx:332-349 ('로그인 완료 확인 조건' placehol |
| `access-section-admin-jargon` | P3 | 도입 · 온보딩·초기 설정 여정 | '접속·권한' 섹션의 SCIM 패널이 영문 개발 jargon(provider_key/SecretRef/rotation policy/decommission/update/import) 그대로라 콘솔의 운영자 언어 원칙과 어긋남 | web/src/views/security/ScimProviderPanel.tsx:125-134 (provider_key·서명  |
| `evidence-packet-missing` | P2 | 도입 · 보안·컴플라이언스 증빙 | 보안 심사용 '증빙 패킷'이 설계만 있고 미구현 — 심사자는 5개 섹션+감사 화면을 돌며 화면 캡처로 증빙을 수작업 조립해야 함 | docs/rpa-console-adoption-onboarding-design-2026-07-01.md:56 (Security |
| `session-encryption-evidence-gap` | P3 | 도입 · 보안·컴플라이언스 증빙 | 캡처된 로그인 세션(쿠키)의 암호화 방식·상태를 콘솔에서 증빙할 수 없음 — dev 평문과 prod KMS 봉투암호화가 화면상 구분 불가 | app/src/runtime/browser-session-store.ts:6,64-71 (enc_kid 영속, 'dev-pla |
| `ai-data-egress-evidence-gap` | P2 | 도입 · 보안·컴플라이언스 증빙 | 'AI에 우리 데이터가 뭘 나가나' 질문에 콘솔이 답하지 못함 — 게이트웨이 화면은 모델·한도·비용뿐, 프롬프트 redaction 적용 사실·증거 표면 부재 | web/src/components/GatewayPolicyForms.tsx:35-95 (PolicyReadout=모델/컨텍스트 |
| `audit-export-period-limit` | P2 | 도입 · 보안·컴플라이언스 증빙 | 감사 로그에 기간(날짜 범위) 필터가 없고 CSV 추출이 상위 200건 스냅샷뿐 — '지난 분기 전체 감사 기록 제출' 불가 | app/src/api/audit-log.ts:125-132 (필터=action/outcome/actor/correlation_ |
| `reviewer-least-privilege-nav` | P2 | 도입 · 보안·컴플라이언스 증빙 | 심사자용 최소권한 계정이 성립 안 함 — 백엔드는 viewer에 audit.read·ai_governance.read를 허용하는데 콘솔 nav/팔레트는 감사·보안 화면을 admin(감사는 approver+) 전용으로 숨김 | web/src/navPolicy.ts:47 (auditExplorer standardRoles=[approver,admin], |
| `ai-governance-english-only` | P2 | 도입 · 보안·컴플라이언스 증빙 | AI 거버넌스 두 패널(런타임 정책·증거 장부)만 전면 영어 — 한국어 심사 문서에 그대로 캡처하면 언어 혼합·의미 전달 실패 | web/src/views/security/AiGovernanceEvidencePanel.tsx:191-194 ('Evidenc |
| `alerts-console-pull-only` | P1 | 도입 · 운영 부담·TCO·ROI 가시성 | 운영 알림이 콘솔 조회 시점에만 계산되고 외부 발송은 알림 건별 수동 폼뿐 — 무인 시간대 장애는 어디에도 통지되지 않음 | app/src/api/ops-alerts.ts:374-376 (알림은 GET /v1/ops-alerts 요청 시 on-read |
| `session-expiry-not-in-ops-alerts` | P2 | 도입 · 운영 부담·TCO·ROI 가시성 | 가장 흔한 반복 운영 작업인 로그인 세션 갱신의 '만료 임박' 경고가 admin 전용 Security 화면에만 있고 운영자 동선(automationOps·알림 센터)에는 없음 | web/src/views/security/SessionRenewalQueue.tsx:61-82 (만료/24h 임박 감지 로직은 |
| `roi-actuals-manual-monthly` | P2 | 도입 · 운영 부담·TCO·ROI 가시성 | ROI 실적 증거(실제 처리 건수·실패율·개입 시간)를 자동화 아이디어별로 매월 수기 입력해야 성과 리포트의 실적 비교·Expand 판단이 갱신됨 | web/src/views/CoePipeline.tsx:743-753 (period_start/end·actual_transac |
| `trigger-weekday-cadence-gap` | P3 | 도입 · 운영 부담·TCO·ROI 가시성 | 예약 신규 생성은 매일/매주 월요일/매월 1일 3종 고정 — 다른 요일·평일 예약은 저장 후 '수정'에서 원시 cron 식을 직접 써야 함 | web/src/views/orchestration/TriggerScheduler.tsx:261-265 (주기 선택지 daily |
| `ops-queue-count-truncation` | P3 | 도입 · 운영 부담·TCO·ROI 가시성 | automationOps 큐 패널의 '사람 확인 대기'·'작업 항목 재처리 대기' 카운트가 최근 50건 페이지 길이를 총계처럼 표시(51건째부터 조용히 과소 표시) | web/src/views/Orchestration.tsx:402-403 (String(human.data.items.lengt |
| `automationops-deeplink-section-inference-missing` | P2 | 도입 · 설계 대비 구현 갭 (Slice A0~A4) | automationOps scenario/trigger 딥링크가 섹션 추론 없이 'today'로 낙하 — A3 수용 기준(기존 딥링크 보존) 위반 | web/src/views/Orchestration.tsx:83 (activeSection은 section 파라미터만 해석, s |
| `slice-b-evidence-packet-unbuilt` | P2 | 도입 · 설계 대비 구현 갭 (Slice A0~A4) | Slice B 증빙 패킷 UI(AdoptionEvidencePacket) 설계됨-미구현 — 설계의 buyer confidence 목표(88-90)는 A+B 완료 기준 | docs/rpa-console-adoption-onboarding-design-2026-07-01.md:117-142(§5.3 |
| `corridor-session-next-step-missing` | P3 | 도입 · 설계 대비 구현 갭 (Slice A0~A4) | 5.2 코리도 마이크로카피 미구현: 사이트 생성 후 '다음: 로그인 세션 등록' 안내와 CaptureGuide 결과 기대 문구 없음 | web/src/components/SiteCreateForm.tsx:224-246 (onSuccess가 loginUrl 유무와 |
| `generator-prereq-link-missing` | P3 | 도입 · 설계 대비 구현 갭 (Slice A0~A4) | A2 수용 기준 부분 미달: 자연어 생성기의 사이트/세션 미비 안내가 #security?section=sites 링크 없이 문자열 오류로만 끝남 | web/src/components/PromptScenarioGenerator.tsx:438,462 (throw new Erro |
| `page-level-error-summary-dashboard-only` | P3 | 도입 · 설계 대비 구현 갭 (Slice A0~A4) | 5.7 부분 이행: 페이지-레벨 오류 요약이 대시보드에만 있고 Workitems/HumanTasks/RunTrace는 패널별 반복 오류 그대로, 대시보드 개별 패널도 '조용해지지' 않음 | web/src/views/Dashboard.tsx:299-331,1497-1509 (DashboardEnvironmentSta |
| `readiness-panel-placement-always-on` | P3 | 도입 · 설계 대비 구현 갭 (Slice A0~A4) | A4 구현이 설계 배치와 다름: 준비도 패널이 역할 작업대 '위'에 무조건 렌더(설정 완료 후에도 상시 노출) | web/src/views/Dashboard.tsx:1510-1520 (AdoptionReadinessPanel이 RoleWor |
| `security-section-nav-test-coverage-gap` | P3 | 도입 · 설계 대비 구현 갭 (Slice A0~A4) | A0 테스트가 설계 §9 스펙의 절반만 잠금: 기본 섹션의 '전체 패널 미렌더' 부정 단언, 섹션 클릭→해시 갱신, 키보드 접근성 미검증 | web/test/security-section-nav.test.tsx:30-44 (딥링크→활성 탭/헤딩 매핑만 단언) |
| `session-capture-cli-cliff` | P2 | 사용자 · 자동화 만들기 흐름 | 로그인 사이트 첫 자동화의 필수 관문(세션 등록)이 운영 환경에선 비개발자가 완주할 수 없는 CLI 절벽 | web/src/components/CaptureGuide.tsx:6-21 ("운영 환경에선 서버가 로그인 창을 띄울 수 없어" |
| `generator-no-session-precheck` | P2 | 사용자 · 자동화 만들기 흐름 | '말로 설명해 만들기' 경로에는 세션 준비 사전 점검이 없어 로그인 사이트는 반드시 한 번 실패한 뒤에야 배운다 | web/src/components/prompt-generator/helpers.ts:240-245 (siteSessionLab |
| `recorder-promise-gap` | P2 | 사용자 · 자동화 만들기 흐름 | '브라우저 녹화'가 약속과 달리 콘솔 안에서는 자동 캡처가 아니라 CLI 도우미 실행 또는 동작 수동 타이핑 | web/src/components/BrowserRecorderPanel.tsx:192-196 ('웹 화면을 따라 하며 클릭·입 |
| `three-create-entries` | P2 | 사용자 · 자동화 만들기 흐름 | 자동화 만들기 화면에 유사 라벨의 진입점 3개('자동화 초안 만들기' / '브라우저 녹화로 만들기' / '+ 새 자동화 만들기')가 공존해 첫 선택이 혼란 | web/src/views/Scenarios.tsx:58-71 (Phase 6 첫 액션 스트립 2개), Scenarios.tsx |
| `wizard-deadend-warning` | P3 | 사용자 · 자동화 만들기 흐름 | 쉬운 만들기 마무리 경고가 dead-end — '실행기 연결과 사이트별 추출 설정이 필요하다'고만 하고 다음 행동 링크가 없음 | web/src/components/OperatorWizard.tsx:534-537 (⚠ 경고 문단, 링크·버튼 없음), Ope |
| `list-row-governance-density` | P3 | 사용자 · 자동화 만들기 흐름 | 자동화 목록 행 액션 과밀(최대 8버튼) + 버전 이력의 영어 거버넌스 용어가 첫 사용자를 위압 | web/src/views/Scenarios.tsx:117-172 (행당 실행/미리보기/편집/이력/릴리스/운영 지정·해제/승격  |
| `sitecreate-selector-jargon` | P3 | 사용자 · 자동화 만들기 흐름 | 생성기 인라인 '새 사이트 온보딩' 폼에 selector/JSON 개발자 필드와 특정 업무 잔재('리뷰 목록 확인 조건')가 그대로 노출 | web/src/components/SiteCreateForm.tsx:354-365 ('page_state_selectors J |
| `mywork-unassigned-task-blindspot` | P2 | 사용자 · 일상 운영 (내 할 일·사람 확인·실패 대응) | 랜딩 '내 할 일' 큐와 '사람 확인' 기본 필터가 미배정(assignee NULL) 신규 업무를 구조적으로 제외하고, 랜딩은 '확인할 일 없음'으로 낙관 표시 | web/src/views/MyWork.tsx:50 (listHumanTasks({assignee: subject}) 필터),  |
| `run-list-no-scenario-identity` | P2 | 사용자 · 일상 운영 (내 할 일·사람 확인·실패 대응) | 실행 기록 목록에서 어느 자동화의 실행인지 식별 불가 — 시나리오 이름 컬럼·필터 부재, MyWork의 행별 '실행 기록 보기'도 무필터 이동 | web/src/views/RunTrace.tsx:108-114 (첫 컬럼이 정적 텍스트 '추적 번호 확인 가능', run_id |
| `dashboard-humantask-population-mismatch` | P2 | 사용자 · 일상 운영 (내 할 일·사람 확인·실패 대응) | 대시보드 '사람 확인 대기' 카운트와 Top5가 이미 종결된 업무까지 포함하고, 클릭 시 도착 화면은 '내 업무만' 필터라 숫자와 목록이 3중 불일치 | web/src/views/Dashboard.tsx:1430 (human = listHumanTasks({limit:50}) — |
| `session-expiry-proactive-gap` | P2 | 사용자 · 일상 운영 (내 할 일·사람 확인·실패 대응) | 세션 만료 '임박' 경보(SessionRenewalQueue)가 admin 전용 nav의 보안 화면에만 있어, 운영자는 실행이 실패한 뒤에야 세션 만료를 알게 됨 | web/src/views/security/SessionRenewalQueue.tsx:61-81 (만료+24h 임박 감지 로직) |
| `rerun-not-in-detail-panel` | P3 | 사용자 · 일상 운영 (내 할 일·사람 확인·실패 대응) | 실패 원인을 확인하는 실행 상세 패널에 재실행 버튼이 없어, 원인 파악 후 패널을 닫고 익명의 목록 행으로 되돌아가야 재실행 가능 | web/src/views/RunTrace.tsx:161-190 ('같은 입력 재실행'/'수정 입력 재실행'이 목록 행에만 렌더 |
| `edited-rerun-raw-json` | P3 | 사용자 · 일상 운영 (내 할 일·사람 확인·실패 대응) | '수정 입력 재실행'이 운영자에게 raw JSON object 원문 입력을 요구 — 신규 실행용 구조화 파라미터 폼이 이미 있는데 재실행 경로만 개발자 UX | web/src/views/RunTrace.tsx:171-189 (inputLabel '수정 입력(JSON object)'),  |
| `run-list-no-scenario-identity` | P1 | 사용자 · 관찰성·실행 추적·신뢰 | 실행 기록 목록·상세 어디에도 '어떤 자동화의 실행인지'가 표시되지 않고 자동화별 필터도 없음 | web/src/views/RunTrace.tsx:106-137 (컬럼: 정적 문구 '추적 번호 확인 가능'·상태·기준 시각·우 |
| `runtime-error-codes-untranslated` | P2 | 사용자 · 관찰성·실행 추적·신뢰 | 실행 실패의 최빈 원인인 런타임 코드(~26종)가 한국어 라벨 미매핑이라 raw 영문 enum으로 노출되고, 계약의 operatorAction(조치 안내)도 미배선 | web/src/components/badges.tsx:111-135 (ERROR_LABELS 25종 매핑 — NAVIGATIO |
| `ai-judgment-content-not-exposed` | P2 | 사용자 · 관찰성·실행 추적·신뢰 | 트레이스의 'AI 판단'이 호출 횟수·모델·토큰·비용 메타뿐 — AI가 실제로 무엇을 클릭/입력하기로 했는지(계획 내용)는 콘솔에서 볼 수 없음 (설계됨-미구현: parsed_json은 이미 영속) | app/src/api/reads-runs.ts:298-302 (stagehand_calls 투영이 model/transport |
| `runtrace-artifact-lookup-first` | P3 | 사용자 · 관찰성·실행 추적·신뢰 | 실행 기록 화면의 첫 시야가 UUID 직접 입력식 '증빙 조회' 패널 — 실행 목록보다 기술적 도구가 먼저 옴 (이전 감사 항목10, Phase 6 미해소 확인) | web/src/views/RunTrace.tsx:72 (ArtifactLookup이 목록 QueryPanel(91행)보다 먼저 |
| `raw-utc-timestamps` | P3 | 사용자 · 관찰성·실행 추적·신뢰 | 실행 목록·상세의 시각이 raw UTC ISO 문자열로 노출되고 단계별 발생 시각은 아예 미표시 — 이미 있는 formatDateTime이 핵심 화면에만 미적용 | web/src/views/RunTrace.tsx:136 ('기준 시각' = r.as_of 원문 ISO, 서버는 toISOStr |
| `dashboard-report-english` | P2 | 사용자 · 언어·일관성·접근성 | 전 역할이 보는 대시보드 '월간 자동화 성과' 패널의 지표·판정·차트 라벨 절반이 영어 원문 | web/src/views/Dashboard.tsx:843-848 (ROI_SOURCE_LABELS: manual/process |
| `raw-iso-timestamp-exposure` | P2 | 사용자 · 언어·일관성·접근성 | 사람 확인 인박스의 '마감' 등 7곳이 원시 ISO(UTC) 타임스탬프를 그대로 노출 | web/src/views/HumanTasks.tsx:398 (목록 '마감' 열 r.timeout ?? '—'), HumanTa |
| `operator-visible-english-forms` | P2 | 사용자 · 언어·일관성·접근성 | 운영자(standard 모드) 가시 화면에 영어 라벨·raw 상태 옵션·JSON 직접입력 잔존 | web/src/views/orchestration/IntegrationHandoffPanel.tsx:126 ('Existing |
| `datetime-formatter-fragmentation` | P3 | 사용자 · 언어·일관성·접근성 | 날짜/시간 포맷이 4가지 방식으로 갈라져 있고, WorkerPool 패널은 UTC를 로컬처럼 표시 | web/src/views/security/WorkerPoolPanel.tsx:388-392 (toISOString().slic |
| `palette-raw-enum-hints` | P3 | 사용자 · 언어·일관성·접근성 | 커맨드 팔레트 검색 결과 힌트에 raw enum(failed_system 등)과 영어 빠른작업 라벨 노출 | web/src/components/CommandPalette.tsx:284 (실행 힌트 `${r.status}` — statu |
| `kind-label-divergence` | P3 | 사용자 · 언어·일관성·접근성 | 같은 사람확인 kind enum에 두 개의 한국어 라벨 사전 — 홈과 인박스에서 표기가 달라짐 | web/src/views/MyWork.tsx:27-36 (approval→'승인 요청', validation→'문서 검증',  |
| `errorstate-english-details-summary` | P3 | 사용자 · 언어·일관성·접근성 | 모든 오류 상태의 기술 상세 토글 라벨이 영어 'admin/support details' | web/src/components/states.tsx:122 (<summary>admin/support details</sum |
| `admin-governance-panels-english` | P3 | 사용자 · 언어·일관성·접근성 | 관리자 설정 화면(SCIM/AI 거버넌스/CoE/커넥터)이 한 폼 안에서 한국어·영어 혼재 | web/src/views/CoePipeline.tsx:861-895 (같은 폼에서 '업무명'/'부서' 다음 'Source im |

## 라이브 브라우저 재감사 — 신규 발견

| ID | P | 제목 | 근거 |
| --- | --- | --- | --- |
| `L1-insecure-context-crash` | P1 | 비보안 컨텍스트(사내망 HTTP IP 접속)에서 사람 확인 '상세' 오픈 즉시 화면 전체 크래시 — crypto.randomUUID 미존재. 전 명령 멱등키 생성 포함 web 전역 ~50곳 사용 → HTTP 배포에서 모든 쓰기 동작 불능 | HumanTaskReviewPanel.tsx:111 (렌더 초기값), grep crypto.randomUUID ≈50개소; 실 Chrome ErrorBoundary 재현 |
| `L2-sidebar-not-sticky` | P2 | 좌측 메뉴가 스크롤 시 화면 밖으로 사라짐(상단바만 sticky) — 긴 화면에서 화면 전환마다 최상단 복귀 필요 | styles.css:40 (.sidebar position 없음) vs :48 (.topbar sticky) |
| `L3-runtrace-identity-placeholder` | P1(기존 run-list-no-scenario-identity 가중) | 실행 목록 식별 셀이 전 행 고정 문구 "추적 번호 확인 가능" 렌더, 실번호는 호버 툴팁 전용. 대시보드 '최근 실행'도 셀 전부 '상세 보기' 링크뿐 | RunTrace.tsx:110-112 |
| `L4-alert-center-noise` | P2 | 알림 센터가 동일 원인 알림 12건을 그룹핑 없이 나열 + 운영자 문장 안 raw enum("queued 상태가 23998분 동안 지속") | automationOps 알림 센터 실측 |
| `L5-schedule-table-vertical-header` | P3 | '등록된 예약' 빈 테이블 헤더(다음 실행/동시성/누락 정책)가 한 글자씩 세로로 꺾여 렌더 | automationOps?section=schedule 실측 |
| `L6-studio-governance-first` | P3 | '자동화 만들기' 첫 화면 최상단이 빈 '승격 승인 대기' 거버넌스 패널 — 제작 시작 스트립이 아래로 밀림 | scenarioStudio 실측 |

### 화면 실증으로 확정된 기존 지적 (대표)

- 대시보드 "사람 확인 대기 3" ↔ 인박스 기본 목록 1건(미배정 2건은 '전체 업무 보기' 후에만 노출) — `mywork-unassigned-task-blindspot`·`dashboard-humantask-population-mismatch`
- 원시 UTC ISO 노출: 사람 확인 마감·Top5 마감·실행 목록 기준 시각·운영 헬스 타임스탬프. 마감이 지났는데 긴급 표시 없음. 동시에 타 화면은 '2026. 6. 15. 오후 7:01:00' / '26. 7. 2. 오전 11:06' — 표기 3종+ISO 공존
- AI 거버넌스 섹션 전면 영어(AI runtime policy · Not configured · owner evidence pending …) — 인접 '접속·권한' 섹션의 모범 한국어와 대비
- 예약 주기 옵션 정확히 [매일 · 매주 월요일 · 매월 1일] (JS로 select options 실측)
- 감사 CSV 버튼 라벨 자체가 "CSV 내보내기(최대 200건)" + 기간 필터 부재
- 알림 외부 발송 = 알림 건별 '웹훅 발송' 수동 버튼 (자동 발화 없음)
- "DEAD LETTER" 영어 배지(작업 목록) · 자동화 목록 행당 버튼 7개 + 원시 UUID '식별값' 컬럼 · "+ 새 자동화 만들기" 제3 진입점
- viewer nav에 감사 이력 없음(백엔드는 audit.read 허용) · 뷰어 준비 스트립은 "권한 있는 담당자에게 요청"으로 정직 처리 ✓

### 정정 (반증)

- '승빙' 오탈자로 보였던 표기는 grep 0건 — JPEG 압축 오독. **스크린샷 글자 판독은 grep으로 재확인 필수.**

### 강점 실측 확인 (점수 방어 근거)

파일럿 준비 스트립 4/9 정직 표기(미확인≠준비됨, 뷰어 CTA 제거) · 보안 허브 5섹션+준비 순서 헤더+세션 갱신 큐 · 문서 자동화 소스-우선 잠금("소스 필요"→추출 비활성) · 실행 예약·알림 로컬 6섹션+큐 미연결 정직 경고 · 역할별 nav 축소(운영자 9·뷰어 5) · 데이터 날조 금지 규율(분모0='—', 'N+' 하한) 전면 일관.

## Evidence Limits

- 라이브 감사는 dev:serve 시드 데이터 기준(run 단계 트레이스 무데이터 — run-loop 비활성). 스텝 트레이스·아티팩트 뷰어의 실데이터 검증은 실행 e2e 별도.
- Chrome이 시스템 프록시로 루프백을 거부(ERR_CONNECTION_REFUSED)해 LAN IP 릴레이로 우회 — 이 우회가 L1(비보안 컨텍스트) 크래시를 발굴했다. 릴레이는 감사 종료 시 중지함.
- 접근성(스크린리더·색 대비)은 이번 범위에서 목측 수준 — 별도 검증 필요.

---

## 재감사 (2026-07-03, 하드닝 전 슬라이스 + D 5건 머지 후 — 최종 게이트)

Date: 2026-07-03
Baseline: main @ 2c6a7db2 (S0~S12 전 슬라이스 + D: run_mode·offboarding metadata export·S4b 알림 발화 하드닝·helper 단일 실행파일(PR #391)·ROI prefill(PR #392) 머지 후)
Method: dev:serve(temp PG 시드, 포트 8180) + LAN IP HTTP 릴레이(0.0.0.0:8280 → 비보안 컨텍스트 유지, 원 감사와 동일 조건) + 실 Chrome(puppeteer-core, 1440×900) 전 화면 순회 + 핵심 인터랙션 실측. 스크린샷 글자는 innerText 덤프로 재확인.
환경 주의: claude-in-chrome 확장이 이 세션에서 미연결(시스템 프록시로 루프백 거부) → puppeteer-core 로 실 Chrome 직접 구동해 동일 여정 재현. 릴레이는 감사 종료 시 kill.

### 점수 (여정 완주 잣대 — 정적 74/73 → 라이브 73/72 대비)

| 관점 | 이전(라이브) | 재감사 실측 | §8 예상(전 슬라이스 후) |
| --- | ---: | ---: | ---: |
| 도입 담당자 | 73 | **88** | 87~89 |
| 실사용자 | 72 | **87** | 86~88 |

§8 예상 범위에 부합. 도입 쪽 여정 '양끝' 절벽(첫 토큰·콘솔 배포·세션 등록 CLI)이 S2/S7/helper 단일 실행파일로 닫히고, 사용자 쪽 실패 규명 입구(실행 식별·재실행·시간표기·미배정 가시성)가 S1/S3/S5/S11로 닫힌 것을 실화면에서 확인.

### 실측 확인 (해소 검증)

- **L1 회귀 없음 (P1 크래시)**: 비보안 컨텍스트(`isSecureContext=false`)에서 `crypto.randomUUID().length===36`(폴리필 동작), 사람 확인 '검토 업무 상세' 패널 오픈 시 크래시 없이 정상 렌더(ErrorBoundary 미발동). 원 감사 최대 크리티컬 해소 실증.
- **helper 단일 실행파일 (작업1, 신규 D)**: 보안 허브 사이트 섹션 '운영자 PC 등록' → CaptureGuide 모달이 **3단계(전달받기→PowerShell 실행→로그인)**로 렌더. `.\rpa-session-capture.exe --api … --site …` 명령·"별도 프로그램 설치는 필요 없습니다"·"열린 로그인 창에서 직접 로그인하세요"·"등록 후 이 사이트는 '세션 등록됨'으로 표시됩니다" 전부 노출. 저장소/Node 경로는 접힌 상세로 강등, 접속 코드(JWT) 미임베드(플레이스홀더만). exe 단독 실증은 PR #391에서 별도 완료(exit 0, session_ready=true).
- **ROI 제안값 프리필 (작업2, 신규 D)**: CoE 실적 폼에 '운영 실행 실적 제안값 불러오기' 버튼. ① 미연결 아이디어=버튼 비활성+연결 안내 ② 연결·종결 0건 기간=제안 없음 안내(값 0 미합성) ③ 연결·실행 보유 기간(6월, scenario d101)=**건수 1 프리필 + '제안값' 배지 + "운영 실행 완료 1건·실패 0건 기준 제안 … 저장 시 본인이 확정한 수치로 기록됩니다" 근거·확정 문구** 실측. 개입/재처리 시간은 미제안(직접 입력) — 날조 금지 준수.
- **S1 실행 식별성**: 실행 기록 목록 셀에 자동화 이름("메일 답장 수집(픽스처 데모)"·"삼성디스플레이 공지 수집" 등) 노출, 고정 문구 셀 없음. 상세 패널에 '같은 입력 재실행'·'수정 입력으로 재실행'(실패값 프리필 안내) 존재.
- **S3 시간 표기**: 사람 확인 마감이 "07.01. 09:00 · 2일 지남"(상대표기 red), 운영 헬스 "26. 7. 3. 오전 1:22" 로컬 표기 — raw ISO 없음.
- **S4b/S4c 알림**: 알림 센터 유형 필터에 '로그인 세션 만료'(session_expiry) 포함, (subject_type,source) 그룹핑("위험 · 실행 SLA · 외 3건"), 문장 내 상태가 "실행 중 상태가 24858분 동안 지속"으로 한국어 라벨화(원 감사 "queued 상태가 23998분" raw enum 해소).
- **S5/S8/S12 대시보드**: 파일럿 준비 4/9 정직 표기, 도입 증빙 패킷 카드('4개 확인 필요'), ROI "실적 증거가 없어 확장 판단은 보류"(정직), 지원 체계 "차단 5건, 보류 6건".
- **강점 유지**: 사이드바 sticky(긴 페이지 유지), 역할별 nav 축소, 데이터 날조 금지('—'/'N+'), 보안 허브 5섹션.

### 신규 발견 (재감사, minor)

| ID | P | 제목 | 근거 |
| --- | --- | --- | --- |
| `alert-humantask-kind-english` | P3 | ✅ **해소(PR #394)** — 사람 작업 SLA 알림 문구에 human task kind 가 영문 raw("exception/열림 미배정. 2423분 초과.")였음(status(열림)만 한국어화·kind(exception) 미매핑). `OpsAlertCenter.localizeStatusText` 에 kind enum 치환 추가(badges.tsx `kindLabel` 재사용) → "예외 확인/열림 미배정. 2423분 초과." | automationOps 알림 센터 실측(17-automationOps-알림.txt:110) |

### 결론

전 슬라이스 + D 5건 머지가 정적/라이브 감사 51+6건의 구조적 해소를 실화면에서 달성. 도입 88 / 사용자 87 로 §8 예상 상단에 안착. 재감사에서 발견한 P3 위생 1건(알림 kind 영문)은 PR #394 로 해소. 잔여는 D 레지스터 보류 1건(오프보딩 원문 반출/삭제 — 2026-07-03 오너가 이번 범위 제외 유지 결정)뿐. 90+ 는 설계 §8 명시대로 실사용 피드백 루프 전제.
