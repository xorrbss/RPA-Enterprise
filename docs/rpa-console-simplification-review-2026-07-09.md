# 콘솔 단순화 검토 — 제거/개선 결정 기록

작성일: 2026-07-09
상태: 결정 확정 (제품 오너 승인)
배경: 파일럿 사용자 "어렵다" 피드백. 최소 수정 원칙을 해제하고 기존 18개 뷰 전수 + 쉬운 제작 설계안을 사용자 관점에서 재검토. 모든 판단 근거는 실측(file:line).
관련: `docs/rpa-easy-authoring-detailed-design-2026-07-09.md` (본 검토로 개정), `docs/rpa-console-easy-authoring-redesign-2026-07-09.md` (개념 — §6.3 집중 스튜디오·myWork 존치는 본 문서가 개정)

## 1. 결정 요약

| 구분 | 대상 | 결정 |
|---|---|---|
| 은퇴 | `playground` | 삭제, `#create` 리다이렉트 (R1) |
| 은퇴 | `irValidation` | 삭제, `#scenarioStudio` 리다이렉트 (R2) |
| 은퇴 | `idempotency` | 삭제 (R3) |
| 은퇴 | `myWork` | 삭제, `#create` 리다이렉트 (R4, E1 선행) |
| 분리 | Dashboard 도입 패널 3종 | `#dashboard?section=adoption` 보조 탭으로 이동 (R5) |
| 축소 | `automationOps` today 섹션·정적 안내 컬럼 | 삭제, 기본 탭=schedule (R6) |
| 정리 | `creator` 데드 파라미터 | 제거 (기존 E6) |
| 설계 개정 | E5 집중 스튜디오(EasyStudio.tsx) | 삭제 — edit 모드는 위저드 화면 재사용 |
| 설계 개정 | 위저드 단계 칩(준비/초안/테스트) | 삭제 — 한 화면 순차 등장 구조에서 중복 장식 |
| 설계 유지 | 만들기 홈 템플릿 갤러리 | **유지 확정** — connectorCatalog가 standard 모드 admin 전용이라 업무 사용자의 유일한 템플릿 경로 |
| 존치 | openGate | internal 플래그로 이미 고객 비노출 — 변경 없음 |

## 2. 은퇴 근거

### R1. `playground`
- 실행 흐름은 Scenarios와 동일 컴포넌트(`RunScenarioButton`, runMode만 test/prod — `Playground.tsx:172` vs `Scenarios.tsx:108`). 고유 자산은 정적 IR 나열(`Plan`, `Playground.tsx:69-94`) 하나.
- 대체: 위저드의 StepCards(사람 말 단계 카드) + 인라인 테스트(E4). "테스트 실행"이 별도 화면으로 존재하는 것 자체가 "어디서 실행하지?" 혼란의 원인.
- 방법: `LEGACY_HASH_REDIRECTS`에 `playground: "create"` 추가(관례: `router.ts:64` approvalInbox). VIEW_KEYS/NAV_GROUPS/navPolicy/VIEW_META/App.tsx에서 제거, `playground.test.tsx` 은퇴. **E4 머지 후 실행.**

### R2. `irValidation`
- 같은 `validateScenario` + 같은 `StudioValidationStages`를 IR 수동 붙여넣기 형태로 반복(`IrValidation.tsx:155,244` vs `RunScenarioButton.tsx:82-87`). 검증은 저장·실행 시 자동 수행 — 수동 붙여넣기는 개발자 디버깅 용도로 콘솔 화면일 이유 없음.
- 방법: `irValidation: "scenarioStudio"` 리다이렉트. 라벨 매핑(issueSummary 등)은 공유 소스라 손실 없음.

### R3. `idempotency`
- fetch 0, 하드코딩 표만(정적 계약 설명 — `Idempotency.tsx:1-6` 주석 자인). 라이브 상태·조치 없음. 원본은 계약 문서.
- 방법: 뷰 삭제. 리다이렉트 목적지 불요(개념 문서 성격) — 해시 폴백은 기본 뷰.

### R4. `myWork`
- 확인 큐가 HumanTasks의 필터·일괄처리 없는 부분집합이고 클릭 시 HumanTasks로 위임(`MyWork.tsx:90`). 만들기 홈의 "확인 필요 스트립"(E1)이 진입점을 흡수 — 홈이 두 개가 되는 것을 방지.
- 방법: `myWork: "create"` 리다이렉트. 확인 스트립 로직은 E1에서 Create.tsx로 이관(`MyWork.tsx:37-61`). **E1 머지 후 실행.**

## 3. 분리·축소 근거

### R5. Dashboard 도입 패널 분리
- `AdoptionReadinessPanel`(285줄)·`AdminAdoptionSetup`(274줄)·`AdoptionEvidencePacket`(317줄)은 파일럿 도입 단계 전용인데 일상 대시보드에 상시 적재.
- 기본 화면 = 일상 운영 4종(ActionQueue Top5·OpsSignalPanel·메트릭·RunTrendsPanel) + AutomationPerformancePanel(일상 리포팅 겸용). 도입 3종은 `?section=adoption` 탭으로 이동(삭제 아님 — PoC/도입 증빙 용도 유지).

### R6. automationOps 축소
- today 섹션은 Dashboard와 동일 신호 재노출(`Orchestration.tsx:199-235` vs `Dashboard.tsx:249-265`) — 삭제, 기본 탭 schedule.
- alerts 섹션의 정적 "저장 가능/준비 중" 안내 컬럼(`Orchestration.tsx:345-354`) 삭제(실시간 아님 — 조용한 안내 위장 제거).
- 존치: schedule/queue(WebAttended·BotPool)/alerts(라우팅)/readiness/external.

## 4. 존치 + 개선

| 뷰 | 결정 |
|---|---|
| `scenarioStudio` | 존치·재편(E7) — 생성기·레코더를 `#create`로 이관, 자동화 관리(목록·버전·승격 인박스) 전담 |
| `humanTasks` | 존치 — 사람확인 단일 홈(결재 탭 포함, 가장 두꺼운 운영 뷰) |
| `workitems` | 존치 — DLQ 재처리 단일 소유. standard 노출을 전 역할 → operator+로 축소 |
| `runTrace` | 존치 — 상세 증빙·트레이스 권위 |
| `auditExplorer` | 존치. navPolicy의 standard=advanced 중복 지정만 정리 |
| `documentIdp`/`coePipeline`/`objectRepository(SiteElements)`/`llmGateway`/`security`/`connectorCatalog`/`automationOps` | 존치 — 실질 구현·고유 기능, 관리 콘솔 소속 |

참고: `objectRepository`와 `SiteElements`는 동일 뷰의 두 이름(`App.tsx:37-38`) — 중복 아님, 변경 없음.

## 5. 순효과

- 뷰 18 → **14** (은퇴 4, 북마크 전부 리다이렉트 보존)
- 업무 사용자 기본 내비: 만들기 · 확인할 일 · 실행 기록 (+현황) — 3~4항목
- 대시보드 첫 뷰포트: 패널 ~10종 → 일상 운영 5종
- "실행이 어디 있지?"의 답: 3곳(스튜디오/플레이그라운드/실행기록) → 1곳(만들기)

## 6. 구현 슬라이스 (R계열 — E계열과 독립 머지)

| 슬라이스 | 내용 | 선행 |
|---|---|---|
| R2 | irValidation 은퇴 + 리다이렉트 | — |
| R3 | idempotency 은퇴 | — |
| R5 | Dashboard adoption 탭 분리 | — |
| R6 | automationOps today 삭제·정적 컬럼 제거 | — |
| R4 | myWork 은퇴 + 확인 스트립 이관 | E1 |
| R1 | playground 은퇴 | E4 |

각 R 슬라이스 공통 체크리스트: VIEW_KEYS·NAV_GROUPS(A6 분할 테스트)·navPolicy(VIEW_VISIBILITY/NAV_POLICY_GROUPS)·VIEW_META·App.tsx switch·LEGACY_HASH_REDIRECTS·관련 테스트 은퇴/갱신·`ux-quickwins`/`nav-policy` 기대값. 검증: typecheck/test/build + 딥링크 리다이렉트 수동 확인.
