# UI/UX 재설계 전량 구현 — 진행 레지스터 (append-only)

미션: E0~E7 · R1~R6 · T1~T8 전량 구현. 설계 SSoT·규칙은 아래 3문서(재논의 금지).

- `docs/rpa-easy-authoring-detailed-design-2026-07-09.md` (E계열)
- `docs/rpa-console-simplification-review-2026-07-09.md` (R계열)
- `docs/rpa-console-uiux-audit-remediation-design-2026-07-10.md` (T계열 + E/R 수용 기준 보강 §7)

규칙 요약: 1 슬라이스 = 1 브랜치 = 1 PR(origin/main에서 분기, 스택 금지) → typecheck/test/build green →
PR → CI green → 머지 → main green 확인 후 다음. 문서 file:line은 착수 직전 재추적. 계약 루트 무변경.

## 착수 전 검증 포인트 결과 (2026-07-10 확인)

| # | 항목 | 결과 |
|---|---|---|
| T§8-① | DEAD_LETTER 라벨 폴백 | **확정** — `badges.tsx` STATUS_LABELS는 소문자 `dead_letter`만 보유, `statusLabel()`이 대문자 키에서 raw 폴백(`badges.tsx:26-55`). tone은 정상(RED set에 대문자 포함). 해결: 조회 시 소문자 정규화 폴백(T4) |
| T§8-② | run 소요 시간 필드 | **부재** — `RunItem`(`types-runs.ts:7-19`)은 run_id·as_of·updated_at?뿐, duration은 StepSummary에만. → T6 소요 열 **보류**, 실행 번호(run_id 축약) 열 + updated_at 상대 표기로 대체(날조 금지) |
| T§8-③ | Gateway 비용 한도 단위 | **USD 확정** — `ops-defaults.md:103` `llm.budget.max_cost_per_run` $0.85(run 누계 상한) → T3에서 "$" 병기 |
| T§8-④ | readiness 벨 문구 | **가능** — `summary.blocker_count` 존재(`TopbarActions.tsx:151`) → "운영 전환 준비 차단 N건" |
| T§8-⑤ | automationOps section 딥링크 | **소비 확정** — `Orchestration.tsx:96` `useHashParam("section")` |
| E§12-① | url_ref 해석 | **심볼릭 키 확정** — seed IR `"entry_url"`/`"orders_url"`(`app/dev/seed-scenarios.ts:124,154`). StepCards는 사이트 데이터로 해석 시도, 불가 시 키 원문 |
| E§12-② | planner studio_mode 방출 | **확정** — `app/src/api/scenario-generation-planner.ts:204` `studio_mode:"easy"` |
| E§12-③ | session.capture 역할 | rbac-policy.ts 내 5곳 존재 — 역할 포함 범위는 E3 착수 시 라인 문맥 확인 |
| E§12-④ | runScenarioGeneration run_mode | **미확정** — 설계 기본 채택: 보정 후에도 `createRun(run_mode:"test")` 경로 통일, E4 착수 시 재확인 |
| E§12-⑤ | 템플릿 목록 API | **확정** — `api.listConnectors`/`api.listTemplates`(`ConnectorCatalog.tsx:77,112`) |

## 슬라이스 진행

| 슬라이스 | 상태 | PR | 검증 | 특이사항 |
|---|---|---|---|---|
| T1 상단바 재설계 | ✅머지 | #422 | web 988·e2e 10/10·CI 11/11 | 계정 팝오버 통합·컨텍스트 배지 중립화·알림 벨 신설·create 메뉴 생성 전용·e2e 1280/1440 가드 |
| T2 알림 그룹핑 일원화 | ✅머지 | #423 | web 990·CI 11/11 | OpsSignalPanel groupOpsAlerts 소비(limit 50)·모두 보기 링크·값-상태 분리(대시보드+automationOps 스케줄러) |
| T3 표기 규칙 | ✅머지 | #424 | web 990·CI 11/11 | Workitems raw ISO→formatDateTime·N건 통일·Gateway 폼 단위(토큰·USD/실행)·저장/편집 구분 캡션. PolicyReadout 단위는 기구현 확인 |
| T4 용어 교정+copy-gate | ✅머지 | #425 | web 991·lint:copy·CI 11/11+게이트 | statusLabel 소문자 정규화·문구 교정 12곳·tools/copy-gate.mjs+allowlist(OpenGate·ENV키 2종)+CI 스텝 |
| T5 사람 확인 결정 우선 | ✅머지 | #426 | web 996·CI 12/12 | [승인][반려] 단축(approval·비구조화·체인 단건 재사용)·0-타일 조건 렌더·필터/일괄 2줄 분리·principalLabel 식별자+이름 미등록 |
| T6 실행 기록 식별성 | ✅머지 | #427 | web 997·CI 12/12 | 실행 번호 #8자 병기(미노출 정책 감사 근거로 개정, 전체 번호는 툴팁 유지)·updated_at 툴팁·우선순위 셀 고정폭. 소요 열 보류(§8-②) |
| T8 표면 하드닝 | ✅머지 | #431 | web 994·e2e 10/10·CI 12/12 | .btn nowrap·section-tabs 한줄 스크롤(automationOps+Security 공용)·사이드바 스크롤 그림자·도입증빙 라벨 분리+문장부호·coe 프리필→placeholder+타일 출처 명시·Workitems 처리현황 열 |
| R2 irValidation 은퇴 | ✅머지 | #428 | web 995·CI 12/12 | 뷰 삭제·5곳 등록 해제·#irValidation→#scenarioStudio·ReadinessCard 검사 화면 링크 제거·은퇴 테스트 3건 삭제 |
| R3 idempotency 은퇴 | ✅머지 | #429 | web 994·CI 12/12 | 뷰 삭제·5곳 등록 해제(리다이렉트 불요=기본 뷰 폴백)·hidden-view 테스트 표본을 coePipeline로 교체 |
| R5 Dashboard adoption 탭 | ✅STALE(선반영) | — | 실측 확인 | 도입 패널 3종은 이미 별도 뷰(adoptionEvidence)로 분리·Dashboard 미렌더(Phase 7에서 이동됨). 목표 동등 달성 — 작업 불요 |
| R6 automationOps today 삭제 | ✅머지 | #430 | web 994·CI 12/12 | today 탭·렌더 삭제, 기본=schedule, 정적 저장가능/준비중 컬럼 삭제, 운영 헬스 상세는 큐 섹션으로 이동 |
| E0 준비판정·모델판별 공용화 | ✅머지 | #432 | web 994·CI 12/12 | siteReadiness는 STALE(components/readiness.ts에 기추출) — model_required 판별만 공용 추출(run-scenario/model-required.ts) |
| E1 랜딩·내비 전환+확인 스트립 | ✅머지 | #433 | web 994·e2e 10/10·CI 12/12 | DEFAULT_VIEW=create·navMode §2.3 슬림(viewer std 5·operator std 8)·확인 스트립 이관(review-queue 공용 훅)·팔레트 자동화 딥링크 create 소유·생성기 mode 딥링크 동기화 결함 수정. 홈 전면 재구성은 E2와 병행 |
| R4 myWork 은퇴 | 진행 | — | — | 뷰 삭제·5곳 해제·#myWork→#create·확인 큐는 E1 스트립이 흡수 |
| E2 위저드+StepCards | 대기 | — | — | — |
| E3 PRECHECK 인라인 | 대기 | — | — | — |
| E4 TestProgress | 대기 | — | — | — |
| R1 playground 은퇴 | 대기 | — | — | E4 후 |
| E5′ edit 모드 | 대기 | — | — | — |
| E6 템플릿 갤러리+easy-labels | 대기 | — | — | — |
| E7+T7 관리 콘솔 정리+스튜디오 액션 | 대기 | — | — | E2 후 |
