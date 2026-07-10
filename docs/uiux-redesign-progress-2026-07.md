# UI/UX 재설계 전량 구현 — 진행 레지스터 (append-only)

**✅ 미션 완료 (2026-07-10)** — 전 슬라이스 머지: T1~T8(8), R1~R4·R6(5, R5=STALE), E0~E7(8, 일부 STALE 축소 — 근거는 각 행). PR #422~#441(20개), main green 연속. 감사 P0 4건·P1 5건·P2군 전부 해소 슬라이스와 매핑됨.

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
| R4 myWork 은퇴 | ✅머지 | #434 | web 988·e2e 10/10·CI 12/12 | 뷰 삭제·5곳 해제·#myWork→#create·확인 큐는 E1 스트립이 흡수 |
| E2 번역기+StepCards | ✅머지 | #435 | web 1010·CI 12/12 | step-sentences(§5 전수 22케이스)+StepCards. 소비면 2곳 배선: 초안 미리보기(GenerationResult)·계획 미리보기(workbench Plan 대체=T7 절반). url_ref는 기존 urlRefLabel 공유. 위저드 셸·useEasyGeneration은 E3/E4로 |
| E3 준비 확인 인라인 | ✅머지 | #438 | web 1015·CI 12/12 | 대부분 STALE(사이트 인라인 등록·blocked 보정 가이드는 Phase 7 선반영) — 잔여=세션 등록 인라인화(corridor CTA→CaptureGuide 다이얼로그, 화면 이동 제거) |
| E4 인라인 테스트 진행 | ✅머지 | #436 | web 1014·CI 12/12 | TestProgress(getRun/steps 폴링+SSE, 배너 §4.7, 9상태 오버레이)·RunScenarioButton onStarted·워크벤치 인라인(run 해시 보존, 화면 튕김 제거) |
| R1 playground 은퇴 | ✅머지 | #437 | web 1014·CI 12/12 | 뷰키 5곳 해제(리다이렉트·워크벤치·테스트는 기존 유지) |
| E5′ 설계 탭 실초안 | ✅머지 | #441 | web 1015·CI 12/12 | 집중 스튜디오 설계 탭에 StepCards(scenario-detail 공유). 말로 고치기=P1 확정(원본 프롬프트 접근 계약 부재 — 설계 §13 revision API 후보 유지) |
| E6 템플릿 갤러리 | ✅머지 | #440 | web 1015·CI 12/12(픽스처 타입 1회 수정) | 홈 갤러리(listTemplates+카탈로그 프리필 계약 재사용). creator 파라미터=STALE(Phase 7이 소비 로직 신설). easy-labels 사전=T4 게이트로 최소선 충족, 위저드 셸 부재로 보류(설계 개정 기록) |
| E7+T7 스튜디오 액션 재편 | ✅머지 | #439 | web 1015·CI 12/12 | 행 [열기][실행]+더 보기(테스트 계획·편집·이력·배포·운영 기준·보관), 용어 단일화(테스트), 실행 기준 단정 배지 열 삭제 |
| F6 step-sentences 폴백 정밀화 | ✅머지 | #443 | web 1020(step-sentences 22→27)·lint:copy·CI 11/11 | 객체형 예약 핸들러({handler}) 문장 재사용+"[object Object]" 제거·fallback_chain 전용 노드 문장 신설·평범한 next 기본 문장 유지. §8-⑥: 설계 초안 "대비 방법"은 기존 어휘와 통일해 "대체 경로"로 확정 |
