# 쉬운 제작 재설계 — 상세 설계서 (구현 사양)

작성일: 2026-07-09
상태: 구현 착수용 상세 설계 (개념 설계: `docs/rpa-console-easy-authoring-redesign-2026-07-09.md`)
근거: 본 문서의 모든 file:line 인용은 2026-07-09 코드 기준 실측이다. 추측 항목은 §12 "구현 시 검증 포인트"에 분리했다.
개정 2026-07-09: 단순화 검토(`docs/rpa-console-simplification-review-2026-07-09.md`) 반영 — E5 집중 스튜디오 삭제(edit 모드는 위저드 재사용), myWork 은퇴(리다이렉트), 위저드 단계 칩 삭제, 은퇴 슬라이스 R1~R6 연계.

## 0. 개념 설계에서 달라진 점 (조사 결과 반영)

| 개념 설계의 가정 | 실측 결과 | 상세 설계 반영 |
|---|---|---|
| 역할 기반 내비 필터를 신설 | **이미 존재** — `web/src/navPolicy.ts`의 `VIEW_VISIBILITY`(:35-58) + `NAV_POLICY_GROUPS` 4그룹(:62-67) + Layout의 기본/고급 navMode 토글(`Layout.tsx:189-194`) | 만들기/관리 콘솔 분리 = **기존 navMode(기본↔고급) 재사용**. 신규 메커니즘 없음 (§2.3) |
| IR 노드 type으로 문장 렌더 | 노드에 type 없음 — **`what[]`의 `action` enum 10값**이 실제 레지스트리(`ir.schema.json:136-139`), 필드는 `instruction`/`url_ref`/`schema_ref` | 문장 규칙표를 action 기준으로 재작성 (§5) |
| easy 모드 식별자 신설 필요 | **계약에 이미 존재** — `meta.studio_mode` enum `["easy","form","visual","ir"]` (`ir.schema.json:18-22`) | 위저드 저장 IR은 `studio_mode:"easy"`, 편집 진입 라우팅에 사용 (§2.2, §12) |
| 위저드가 생성기 전체를 훅으로 추출 | `useGenerationActions`(34필드 input bag)는 구 폼 20개 상태에 결합 | 위저드는 **얇은 신규 훅 `useEasyGeneration`** + 순수 헬퍼 재사용. 구 훅은 전문가 스튜디오에 존치 (§4.5) |
| `siteReadiness` 재사용 | 비-export + `UseQueryResult` 결합(`ReadinessCard.tsx:132-160`) | 순수 함수로 추출·export하는 선행 리팩터 슬라이스 (§4.6, E0) |

## 1. 전체 파일 계획

```
web/src/views/Create.tsx                      (신규) 만들기 홈 + 위저드 호스트  [E1]
web/src/components/easy-create/
  Wizard.tsx                                  (신규) 위저드 셸·상태 머신        [E2]
  PrepChecklist.tsx                           (신규) 준비 확인(인라인 서브스텝) [E3]
  StepCards.tsx                               (신규) IR→단계 카드 렌더          [E2]
  step-sentences.ts                           (신규) IR→문장 순수 규칙(단위테스트) [E2]
  TestProgress.tsx                            (신규) 인라인 테스트 진행         [E4]
  useEasyGeneration.ts                        (신규) 생성·재생성·테스트 실행 훅  [E2]
  easy-labels.ts                              (신규) 쉬운 언어 사전(순수 상수)   [E6]
web/src/components/run-scenario/site-readiness.ts (신규·추출) siteReadiness 순수화 [E0]
--- 수정 ---
web/src/router.ts                              VIEW_KEYS + NAV_GROUPS("제작")   [E1]
web/src/navPolicy.ts                           VIEW_VISIBILITY + NAV_POLICY_GROUPS [E1]
web/src/views/meta.ts                          VIEW_META 항목                    [E1]
web/src/App.tsx                                lazy import + switch case         [E1]
web/src/components/run-scenario/ReadinessCard.tsx  siteReadiness를 추출본 사용    [E0]
web/src/views/ConnectorCatalog.tsx             템플릿 CTA → #create 프리필, creator 파라미터 제거 [E6]
web/src/views/Playground.tsx                   creator 파라미터 제거              [E6]
```

모든 신규 파일 500줄 이내(CI 게이트). 위저드 로직이 커지면 `easy-create/` 내 sibling 분해가 원칙.

## 2. 라우팅·정보구조 상세

### 2.1 뷰 등록 (E1)

- `router.ts` `VIEW_KEYS`에 `"create"` 추가. `NAV_GROUPS`의 `"제작"` 그룹 keys 맨 앞에 추가 — `web/test/ux-quickwins.test.tsx:388-391`(A6)이 VIEW_KEYS↔NAV_GROUPS 정확 분할을 강제하므로 **둘을 같은 커밋에서** 수정.
- `navPolicy.ts`:
  - `VIEW_VISIBILITY.create = { standardRoles: ALL_ROLES }` — 홈은 전 역할에 보이고, 쓰기 CTA는 `useCan`으로 게이팅(§9). viewer는 읽기 전용 홈(내 자동화 상태 + 확인할 일)을 본다.
  - `NAV_POLICY_GROUPS`의 `"내 업무"` 그룹 맨 앞에 `create` 배치.
- `views/meta.ts` `VIEW_META.create = { title: "만들기", subtitle: "말로 설명하면 자동화 초안을 만들어 드립니다", icon: <기존 lucide 세트에서 선택> }`.
- `App.tsx`: `const CreateView = lazy(...)` + `case "create"` (기존 패턴 `App.tsx:9-26, 29-70`).
- `DEFAULT_VIEW`(`router.ts:35`)를 `"myWork"` → `"create"`로 변경. 근거: 첫 화면이 "무엇을 시킬까"여야 한다는 재설계 원칙.
- `myWork`는 **은퇴**(단순화 검토 R4): 확인 큐는 HumanTasks의 부분집합(`MyWork.tsx:90`이 위임)이고 진입점 역할은 만들기 홈의 확인 스트립이 흡수. `LEGACY_HASH_REDIRECTS`에 `myWork: "create"` 추가(E1 머지 후 실행).

### 2.2 해시 파라미터 계약

`#create`의 파라미터 — 전부 기존 규약(`useHashParam`/`useHashIdParam`, id 계열은 path-traversal 가드 `router.ts:142-145`) 준수:

| 파라미터 | 의미 | 검증 |
|---|---|---|
| `prompt`, `name`, `params`, `site`, `start_url`, `browser_identity`, `network_policy`, `connector_id`, `template_id` | 프리필 — **기존 `usePrefill` 키 집합과 동일**(`usePrefill.ts:50-58`). 템플릿 갤러리/커넥터 카탈로그가 그대로 사용 | 문자열 |
| `generation` | 진행 중/완료된 생성 복원 → `getScenarioGeneration(id)` | `useHashIdParam` |
| `run` | 테스트 실행 복원 → TestProgress가 이어서 폴링 | `useHashIdParam` |
| `edit` | 수정 모드 — 위저드가 해당 scenario의 IR을 로드해 PREVIEW부터 시작 | `useHashIdParam` |

- 새로고침/뒤로가기 복원: 위저드 단계는 별도 상태 저장 없이 `generation`/`run` 파라미터에서 재유도한다(§3의 상태는 전부 서버 상태로부터 계산 가능).
- **`creator` 파라미터는 폐기**: 현재 어디서도 소비되지 않는 데드 파라미터(전달만: `ConnectorCatalog.tsx:150`, `Playground.tsx:127`). E6에서 전달부 제거. `intent` 파라미터는 도입하지 않음(선행 설계의 제안 철회 — Security 딥링크는 기존 `section`/`site` 규약 유지).

### 2.3 만들기 콘솔 ↔ 관리 콘솔 = 기존 navMode 재사용

- **기본(standard) 모드 = 만들기 콘솔** — 최종 목록(단순화 검토로 확정): 전 역할 `create`/`humanTasks`/`runTrace`/`dashboard`, operator+ `workitems`(전 역할→축소)/`automationOps`/`documentIdp`. 나머지 뷰는 `advancedRoles`로 이동.
- **고급(advanced) 모드 = 관리 콘솔**: 현행 전체 뷰(은퇴분 제외). 전환 토글은 기존 것(`Layout.tsx:189-190`, `hasAdvancedNav`).
- 은퇴 뷰(R1~R4): `playground`·`irValidation`·`idempotency`·`myWork` — 근거·방법은 단순화 검토 문서 §2.
- 영향 범위: `nav-policy.test.ts`/`layout-nav-policy.test.tsx`/`ux-quickwins.test.tsx`(A6) 기대값 갱신, 위 목록을 테스트에 고정.

## 3. 위저드 상태 머신

상태는 URL 파라미터 + 서버 상태에서 파생(로컬 전용 상태 최소화). 문자는 내부 식별자, 괄호는 화면 라벨.

```
IDLE(홈) --제출--> PRECHECK(준비 확인)
PRECHECK --모두 준비됨/사용자 확인--> GENERATING(초안 만드는 중)
PRECHECK --사이트/세션 부족--> PREP_FIX(인라인 등록) --완료--> GENERATING
GENERATING --status=saved--> PREVIEW(초안 미리보기)
GENERATING --status=blocked--> PREP_FIX(서버 blockers를 준비 행으로 매핑)
GENERATING --status=failed--> GEN_FAILED(원인+재시도)
PREVIEW --말로 고치기--> GENERATING(재생성, §3.3)
PREVIEW --한 번 실행해 보기--> TESTING(run_mode=test)
TESTING --completed--> SUCCEEDED | --failed_*--> TEST_FAILED
        --suspended--> WAITING_HUMAN(사람 확인) --resolve--> TESTING(자동 재개 관찰)
        --cancelled--> CANCELLED(취소됨)
TEST_FAILED --복구 CTA(§6)--> PREP_FIX 또는 TESTING(재실행)
SUCCEEDED --> 운영 예약 / 실행 증거 / 봇으로 굳히기 / 계속 고치기(PREVIEW)
```

### 3.1 PRECHECK (클라이언트 선점검 — 생성 요청 전)

- 프롬프트에서 `extractFirstHttpUrl`(기존 helpers)로 URL 감지 → `singleMatchingSiteForUrl`(기존 helpers)로 사이트 매칭 → 추출된 `site-readiness`(§4.6) 판정.
- 전부 green이면 PRECHECK는 **접힌 한 줄 요약**으로만 렌더하고 즉시 GENERATING 진행(단계 미추가 원칙).
- amber/red면 PREP_FIX 행 노출. URL 미감지 시 사이트 선택 드롭다운(기존 `listSites` 데이터) 1개만 노출 — 그 외 고급 입력(browser_identity 등)은 위저드에 내지 않는다(프리필로만 수용).

### 3.2 GENERATING

- `api.generateScenario(body, crypto.randomUUID())` — `mode: "save"` 고정(미리보기 후 실행이 원패스의 핵심이므로 `save_and_run`을 쓰지 않음). body: `prompt`, `name?`(미입력 시 생략 — 서버 기본), `start_url?`, `target?`(사이트 매칭 시), `params?`(프리필), `evidence`(capabilities 기본값), `planner`(capabilities 기본).
- 응답 `ScenarioGenerationResult`(`types-scenarios.ts:216-234`): `status`가 `saved`→PREVIEW(+ 해시에 `generation` 기록), `blocked`→blockers를 준비 행으로 매핑, `failed`→GEN_FAILED.
- blocked 생성의 보정 재실행은 기존 계약 그대로 `api.runScenarioGeneration(generation_id, {target/start_url/params/...}, key)` — 이 호출은 run을 만들므로(=보정+테스트를 한 번에) PREP_FIX에서 보정 완료 시 CTA를 "고치고 바로 실행"으로 라벨링해 의미를 정직하게 표시.

### 3.3 말로 고치기 (재생성)

- 전용 수정 API는 계약에 없음. P0: **합성 프롬프트 재생성** — `generateScenario({ prompt: `${원본 프롬프트}\n\n[수정 요청] ${사용자 입력}`, mode:"save", ...동일 target })`. 새 generation_id로 해시 갱신(이전 생성은 `listScenarioGenerations` 이력에 자연 보존).
- 변경 강조: 이전/새 `draft_ir`를 `step-sentences`로 렌더한 문장 배열을 node_id 기준 비교, 달라진 카드에 `hl` 강조. 문장 비교이므로 IR 내부 diff 불요.
- 수정 API(P1 추가 계약 후보)는 §13 열린 결정으로.

### 3.4 TESTING

- `api.createRun({ scenario_version_id: <generation의 scenario_version_id>, params, run_mode: "test" }, crypto.randomUUID())` — `run.create` 권한. 해시에 `run` 기록.
- `run_mode:"test"`는 계약 존재 확인됨(`api-surface.md:69`, `CreateRunBody` `types-runs.ts:144-153`).
- model_required 복구: `ApiError.code==="IR_SCHEMA_INVALID" && details.reason==="model_required"` 패턴(`RunScenarioButton.tsx:35-40, 127-141`과 동형)을 공용 헬퍼로 추출해 재사용, 모델 선택 후 재시도.

## 4. 컴포넌트 사양

### 4.1 `views/Create.tsx` — 만들기 홈

- 데이터: `listHumanTasks`(확인 스트립 — `MyWork.tsx:37-61`의 배정+미배정 병합·`isActiveHumanTask` 필터 로직을 그대로 이관/재사용), `listScenarios({limit:8})`(내 자동화), 템플릿 목록(ConnectorCatalog가 쓰는 기존 템플릿 API 재사용).
- 구성: 확인 스트립(활성 human task 있을 때만) → 히어로 입력(+예시 칩) → 템플릿 갤러리 → 내 자동화 카드.
- 제출 시 `Wizard`를 같은 화면에 마운트(뷰 전환 없음). `generation`/`run`/`edit` 해시 파라미터가 있으면 홈 대신 위저드/스튜디오를 곧장 렌더.
- 내 자동화 카드: `ScenarioItem`(`scenario_id, name, version, latest_version_id, promotion_status, certification`) + 상태 배지(기존 `badges.ts` 재사용). [실행]=`RunScenarioButton`(기존, `runMode:"test"` prop), [수정]=`#create?edit=<id>`.

### 4.2 `easy-create/Wizard.tsx` — 셸·상태 머신

- §3 상태 머신 보유. props: `{ prefill: PrefillValues }`(홈이 해시에서 읽어 전달).
- 렌더: `PrepChecklist` + `StepCards` + `TestProgress` + CTA 행 — 한 화면에서 섹션이 순차 등장(단계 칩 없음 — 단순화 검토로 삭제). 각 하위는 표시 전용, 전이는 Wizard가 소유.
- **edit 모드**(`?edit=<scenario_id>`): `getScenario(id)`로 `ScenarioDetail.ir` 로드 → PREVIEW 상태에서 시작(생성 단계 생략). 말로 고치기는 §3.3과 동일 재생성 경로 — 기존 시나리오의 재생성은 새 초안을 만들므로 "고치면 새 초안이 만들어집니다" 정직 고지(기존 자동화 유지). IR 직접 수정(PUT + If-Match)은 P1(§13).

### 4.3 `easy-create/PrepChecklist.tsx` — 준비 확인

- props: `{ rows: PrepRow[], collapsed: boolean, onFix(row), onExpand() }`. `PrepRow = { key: "site"|"session"|"secret"|서버blocker, tone, label, detail, cta? }`.
- 행 소스: (a) 선점검 — `site-readiness` 판정(§4.6), (b) 서버 blockers — `ScenarioGenerationResult.blockers` + `currentCorrectionGuide` 범주(시작주소/실행대상/주소일치/동영상/입력값, `GenerationResult.tsx:161-263`의 분류 재사용).
- 인라인 서브스텝: 사이트 등록 = 기존 `SiteCreateForm` 임베드(생성 성공 콜백으로 사이트 재조회 후 행 갱신 — `PromptScenarioGenerator`의 `handleInlineSiteCreated` 패턴). 로그인 연결 = 기존 `CaptureGuide` 임베드 + `POST /v1/sites/{id}/session/capture`(`api-surface.md:481-482`, `session.capture` 권한). 완료 판정은 낙관 갱신이 아니라 **사이트 재조회로 `session_ready===true` 확인**(조용한 green 금지).
- SecretRef 행: `SiteItem`에 시크릿 준비 필드가 없으므로 **표시하지 않는다**(확인 불가한 것을 행으로 만들지 않음 — 개념 설계 §6.2의 SecretRef 행은 계약 부재로 P0 제외, §13).

### 4.4 `easy-create/StepCards.tsx` + `step-sentences.ts`

- `step-sentences.ts`(순수): `renderIrSentences(ir: unknown): StepSentence[]`, `StepSentence = { nodeId, order, sentence, detail?, flow?: FlowNote, fallback: boolean }`.
- 순회: `start`부터 `next` 체인 우선. `on` 분기는 priority 최상 target을 주 경로로 잇고 카드에 분기 배지, `loop`는 `body_target` 1회 전개 + "반복(최대 N회)" 배지, `fallback_chain`은 "대체 경로 있음" 배지. 방문 노드 dedupe, 상한 200(= `interpreter.graph_max_steps`, `ops-defaults.md:114`). 주 경로에 안 잡힌 노드는 "기타 경로" 그룹으로 뒤에 나열(누락 은폐 금지).
- `StepCards.tsx`: 문장 배열을 카드로 렌더 + 테스트 중 상태 오버레이 슬롯(`stepStates?: Map<nodeId, StepUiState>`). [고급 보기] 토글 = 기존 `VisualFlowCanvas`(현재 `ScenarioForm.tsx:331`에서만 사용) + IR JSON `<details>`.

### 4.5 `easy-create/useEasyGeneration.ts`

- 노출: `{ generate(input), regenerate(fixText), runCorrections(corrections), startTest(params?), generation, generationPending, testRunId, modelGate }`.
- 내부: `generateScenario`/`runScenarioGeneration`/`createRun` 직접 호출(§3). `useGenerationActions`를 재사용하지 않는 이유: input bag 34필드가 구 폼 상태에 결합(`useGenerationActions.ts:32-66`) — 어댑터를 만들면 위저드가 구 폼의 형상을 상속. 대신 **순수 헬퍼만 공유**: `draft-params.ts`, `scenario-params.ts`(`extractScenarioParamFields`/`coerceParamValue`/`shouldIncludeParam`), `helpers.ts`(`extractFirstHttpUrl`/`singleMatchingSiteForUrl`), model_required 판별(신규 공용 추출).
- 성공 후 쿼리 무효화: `["runs"]`, `["scenario-generations","recent"]`, `["scenarios"]` (기존 관례 `useGenerationActions.ts:157-160`).

### 4.6 `run-scenario/site-readiness.ts` (선행 추출, E0)

- `ReadinessCard.tsx:132-160`의 `siteReadiness`를 순수 시그니처로 추출·export:
  `siteReadiness(targetUrls: readonly string[], sites: { isLoading: boolean; isError: boolean; items: readonly SiteItem[] }): { tone; detail; sessionSiteId? }`
- 판정 순서는 현행 유지(빈 URL→blue, origin 파싱 실패→red, 로딩→blue, 에러→amber, 미매칭→amber, red+미승인→red, circuit≠closed→amber, login_capable&&!session_ready→amber+sessionSiteId, 통과→green).
- `ReadinessCard`는 추출본을 호출하도록 변경(동작 불변 리팩터 — 기존 `run-scenario-*` 테스트가 회귀 가드).

### 4.7 `easy-create/TestProgress.tsx`

- props: `{ runId, stepSentences, onRecover(errorCode), onResolved() }`.
- 데이터: `getRun` 폴링 — 기존 `runDetailRefetchInterval`(터미널이면 중단, 아니면 5초; `runtrace/constants.ts:18-22`) 재사용. steps: `listRunSteps(runId, {limit:100})` 5초 + `api.watchRunSteps(runId, invalidate)` SSE 병행(기존 `StepTrace.tsx:84-99` 패턴, 쿼리키 `["run-steps", runId]` 공유).
- step 상태 매핑(9값, `migration_core_entities.sql:1168-1170`):

| step.status | 카드 표시 |
|---|---|
| `started` | 실행 중(스피너) — 현재 단계 판정은 `status==="started"` 마지막 행(`StepTrace.tsx:112-115` 관례) |
| `success` | 성공 |
| `failed_business` | 실패(업무) — 주황 |
| `failed_system` / `failed_security` | 실패 — 빨강 |
| `failed_challenge` | 추가 인증 필요 |
| `uncertain` | 확인 필요(성공으로 칠하지 않음) |
| `skipped` | 건너뜀 + 사유(exception 코드) |
| `suspended` | 사람 확인 대기 |

- run 상태 → 배너: `queued/claimed`=테스트 준비 중, `running/completing`=실행 중, `suspending/suspended`=사람 확인 대기, `resume_requested/resuming`=이어서 실행 중, `completed`=성공, `failed_business`=업무 확인 필요, `failed_system`=시스템 문제, `cancelled`=취소됨(어휘 계약 `error-catalog.ts:89-91`).
- 실패 시: `run.failure_reason.code`(`types-runs.ts:87-90`) 또는 마지막 실패 step의 `exception.code`로 §6 복구 매핑. 기술 상세(코드·class·step trace)는 접힌 `<details>`.
- suspended 시: `listHumanTasks({run_id, terminal:"false"})`로 해당 task 조회, kind별 기존 처리 컴포넌트(`HumanTaskReviewPanel` 계열) 인라인 재사용. resolve 성공 → run이 `resume_requested`로 자동 전이(계약: `reserved-handlers.md:110`, `api-surface.md:380`)하므로 **UI는 resolve 후 폴링 지속만** 하면 됨(별도 resume 호출 불필요·금지 — R13은 이벤트가 밀어올림).
- 성공 CTA: [운영 예약]→`navigate("automationOps",{scenario})`, [실행 증거 보기]→인라인 `RunArtifactsList`(기존, `focusOnMount`) 또는 `navigate("runTrace",{run,focus:"artifacts"})`, [봇으로 굳히기]→`can("scenario.promote")`시 `promoteScenarioFromRun(scenarioId, runId, \`promote-from-run:${scenarioId}:${runId}\`)`(기존 키 관례 `RunDetailPanel.tsx:55-59`).

### 4.8 수정 모드 (구 E5 집중 스튜디오 — 단순화 검토로 삭제)

별도 `EasyStudio.tsx`·풀스크린 레이아웃·우측 레일은 만들지 않는다. `#create?edit=<scenario_id>` 진입 시 **위저드 화면 그대로**가 §4.2의 edit 모드로 동작한다(사용자가 배울 화면 1개 감소). 이름 표시는 `ScenarioItem.name` + `promotion_status` 배지를 위저드 헤더에 표기. 최근 테스트 이력 표시는 P1(필요 시 `listRuns({scenario_id, run_mode:"test", limit:1})` — 계약 존재 `api-surface.md:73`).

## 5. IR → 문장 렌더 규칙표 (P0 확정)

`what[]`의 각 action(`ir.schema.json:136-224` 실측 필드):

| action | 문장 템플릿 | detail |
|---|---|---|
| `navigate` | "페이지로 이동합니다" | `url_ref` 표시(§12-①: 심볼릭 키 해석은 구현 시 확인, 해석 불가 시 키 원문) |
| `act` | `instruction` 원문 그대로 | — |
| `observe` | "화면을 확인합니다 — {instruction}" | — |
| `extract` | `instruction` 원문 | "결과 형식: {schema_ref}" |
| `download` | "파일을 내려받습니다" | args 요약 |
| `upload` | "파일을 올립니다" | args 요약 |
| `api_call` | "{args.method} 요청을 보냅니다" | `url_ref` |
| `file` | "파일을 처리합니다" | args 요약 |
| `human_task` | "사람의 확인을 요청합니다" | assignee_role |
| `shell` | "등록된 명령을 실행합니다" | `cmd_ref` (서명 레지스트리 키만 — 명령 본문 렌더 금지) |

flow/부속(카드 배지·주석):

| 계약 요소 | 표시 |
|---|---|
| `verify.criteria[]` | "확인: " + 종류별 요약 — `url_matches`→주소, `element_visible/absent`→화면 요소, `text_includes`→문구, `min_rows`→"최소 N행", `extract_schema_valid`→형식, `http_status`→응답, `value_match`→값, `receipt_captured`→접수증, `empty_result_allowed`→"비어 있어도 됨" (`verify.schema.json:27-50`) |
| `on` 분기 | "조건에 따라 나뉩니다" 배지, `when`(IREL 원문)은 detail 접힘 — 날조 요약 금지 |
| `loop` | "반복 (최대 {max_iterations}회)" 배지 |
| `terminal` | `success`→"완료합니다", `success_empty`→"데이터 없이 완료합니다", `fail_business`→"업무 실패로 종료", `fail_system`→"시스템 실패로 종료" |
| `fallback_chain` | "대체 경로 준비됨 (T0..)" 배지 |
| target `@human_task` | "→ 사람 확인으로" (input.kind 라벨) |
| target `@challenge` | "→ 추가 인증 처리로" |
| target `@end_no_data` | "→ 데이터 없으면 종료" |
| 그 외/해석 불가 | action 라벨 + 원문 `<details>` (`fallback:true`) — **문장 날조 금지** |

`step-sentences.test.ts`: action 10종 × 대표 케이스 + flow 4종 + 예약 핸들러 3종 + fallback 케이스를 규칙 단위로 테스트(스냅샷 아님).

## 6. 에러 → 복구 CTA 매핑표 (전부 `ERROR_CATALOG` 실측)

| code (class, retryable) | 배너 문구(쉬운 말) | 1차 CTA | 비고 |
|---|---|---|---|
| `SESSION_REGISTRATION_REQUIRED` (system, false) | 로그인 연결이 필요해요 | [로그인 연결하기] → PrepChecklist 세션 서브스텝 인라인 | `error-catalog.ts:103` |
| `NAVIGATION_TIMEOUT` (system, true) | 사이트 응답이 늦어요 | [다시 실행해 보기] | :110 |
| `SITE_PROFILE_BLOCKED` (security, false) | 관리자 승인이 필요한 사이트예요 | 승인 요청 안내(쓰기 CTA 없음 — `site.approve` 보유자에게만 승인 딥링크) | :99 |
| `SITE_CIRCUIT_OPEN` (system, true) | 이 사이트는 잠시 쉬는 중이에요 | 잠시 후 [다시 실행] | :100 |
| `DOMAIN_POLICY_VIOLATION` (security, false) | 허용되지 않은 주소로 이동하려 했어요 | 관리자 문의 안내 | :128 |
| `IR_SCHEMA_INVALID` + `details.reason==="model_required"` | AI 모델을 골라야 해요 | 모델 선택 폼(기존 패턴) | `RunScenarioButton.tsx:127-141` 동형 |
| `IR_SCHEMA_INVALID`(그 외) / `IR_EXPRESSION_COMPILE_ERROR` (business, false) | 초안에 문제가 있어요 | [말로 고치기] 포커스 | :94-95 |
| `LLM_BUDGET_EXCEEDED` (system, false) | 오늘 처리 한도를 넘었어요 | 관리자 문의 | :112 |
| `LLM_RATE_LIMITED` / `LLM_BACKEND_UNAVAILABLE` (system, true) | 잠시 혼잡해요 | [잠시 후 다시 시도] | :119-120 |
| `LLM_CONTENT_FILTERED` (business, false) | 이 내용은 처리할 수 없어요 | 설명 수정 유도 | :117 |
| `CHALLENGE_UNRESOLVED` (challenge, false) | 추가 인증이 필요해요 | 확인할 일로 연결 | :104 |
| `HUMAN_TASK_EXPIRED` (business, false) | 확인 기한이 지났어요 | [다시 실행해 보기] | :146 |
| `RUN_ABORTED` (none) | 취소됨 | — (어휘 계약 준수) | :89-91 |
| 미분류 코드 | `ERROR_CATALOG[code].userMessage` 그대로 | retryable이면 [다시 실행] | 카탈로그가 SSoT — 자체 문구 발명 금지 |

`easy-labels.ts`는 이 표의 "쉬운 말" 배너 문구만 소유하고, 근거 코드·`userMessage`는 접힌 기술 상세에 원문 표기(문제 은폐 금지).

## 7. 데이터·폴링 설계 요약

| 용도 | 소스 | 주기 |
|---|---|---|
| run 상태 | `getRun` | `runDetailRefetchInterval`(비터미널 5s, 터미널 중단) 재사용 |
| step 목록 | `listRunSteps` + `watchRunSteps` SSE | 5s + 변경신호 무효화 (기존 `StepTrace` 패턴, 쿼리키 `["run-steps",runId]` 공유 — 중복 폴링 없음) |
| 생성 복원 | `getScenarioGeneration(generation)` | 1회 (생성은 동기 mutation — 기존과 동일, 생성 자체 폴링 없음) |
| 사이트 | `listSites({limit:100})` | 캐시 재사용(쿼리키 기존 `["sites", ...]` 관례) |
| 확인 스트립 | `listHumanTasks` | 5s (`MyWork.tsx:13` POLL_MS 관례) |

## 8. 언어 사전 (`easy-labels.ts`) — 만들기 콘솔 한정

개념 설계 §6.4 표 그대로 + §6의 배너 문구. 원칙: (1) 상태 어휘(준비됨/확인 필요/보류/차단/취소됨)는 관리 콘솔과 동일 — 톤 매핑은 기존 `badges.ts`의 green/amber/red/blue/muted 재사용, (2) 사전은 **표시 문자열만** 소유하며 판정 로직·에러 코드에는 관여하지 않는다, (3) 관리 콘솔 라벨은 불변.

## 9. 권한 매핑 (전부 `ts/rbac-policy.ts` 실측 액션명)

| UI 요소 | 게이트 |
|---|---|
| 히어로 입력·자동화 만들기·말로 고치기 | `scenario.create` (operator+, rbac-policy.ts:52) |
| 사이트 등록 인라인 | `site.create` (:32) |
| 로그인 연결 서브스텝 | `session.capture` |
| 테스트 실행·다시 실행 | `run.create` (:32) |
| 실행 증거 보기 | `artifact.read` |
| 사람 확인 인라인 처리 | `human_task.resolve.<kind>` (kind별 — 기존 HumanTask 컴포넌트가 이미 게이팅) |
| 봇으로 굳히기 | `scenario.promote` |
| 운영 예약 링크 | `isViewVisible("automationOps", ctx)` 충족 시만 노출 |
| viewer | 홈=읽기 전용(내 자동화 상태·확인할 일 열람), 쓰기 CTA 전부 비노출 |

전부 표시 필터일 뿐 인가는 백엔드 RBAC(불변식). 테스트: 역할별 JWT(`jwt(roles)` 헬퍼, `prompt-generator-correction.test.tsx:30-36`)로 노출/비노출 검증.

## 10. 테스트 설계 (fake-client 패턴, `web/test/fake-client.ts:89`)

| 파일 | 핵심 케이스 |
|---|---|
| `create-home.test.tsx` (E1) | 기본 진입이 `#create`; navMode 기본/고급별 내비 항목; viewer 읽기 전용; 확인 스트립 조건 노출; A6 분할 테스트 통과 |
| `step-sentences.test.ts` (E2) | §5 규칙 전수(action 10·flow 4·핸들러 3·fallback·200 상한·기타 경로 그룹) |
| `easy-wizard.test.tsx` (E2/E3) | 제출→generateScenario(mode save) 인자 검증; saved→카드 렌더; blocked→준비 행 매핑; 준비 green이면 접힌 한 줄(행 미노출); 세션 서브스텝 완료→사이트 재조회로 session_ready 확인 후 진행; model_required 복구; 말로 고치기→합성 프롬프트 재생성+변경 카드 강조; `generation` 해시 복원 |
| `test-progress.test.tsx` (E4) | run 상태별 배너(§4.7 표); step 9상태 매핑(uncertain을 성공으로 칠하지 않음); 실패 코드→§6 CTA; suspended→task 인라인→resolve 후 폴링 지속(resume 직접 호출 없음 검증); 터미널 폴링 중단 |
| `easy-wizard.test.tsx` 추가 케이스 (E5′) | `?edit=` 진입 시 IR 로드→PREVIEW 시작·재생성 고지·테스트 인라인 |
| 기존 갱신 | `ux-quickwins.test.tsx`(A6), `nav-policy.test.ts`/`layout-nav-policy.test.tsx`(standard 목록), `connector-catalog.test.tsx`(CTA가 `#create` 프리필, creator 제거), `run-scenario-*`(siteReadiness 추출 회귀) |

검증 명령(전 슬라이스): `npm --prefix web run typecheck` / `npm --prefix web test` / `npm --prefix web run build` / `git diff --check`.

## 11. 슬라이스 순서 (개념 설계 E1~E7을 실측으로 조정)

| 슬라이스 | 내용 | 선행 |
|---|---|---|
| **E0** | `siteReadiness` 순수 추출 + model_required 판별 공용화 (동작 불변 리팩터) | — |
| **E1** | `create` 뷰 등록(라우터 5곳) + 홈 뼈대 + DEFAULT_VIEW 변경 + navMode 슬림화 | — |
| **E2** | `useEasyGeneration` + `step-sentences` + `StepCards` + 위저드 GENERATING/PREVIEW | E0, E1 |
| **E3** | PRECHECK/PREP_FIX (선점검 + 인라인 사이트/세션 + 서버 blockers 매핑) | E2 |
| **E4** | `TestProgress` (TESTING~SUCCEEDED/FAILED/WAITING_HUMAN) | E2 |
| **E5′** | 위저드 edit 모드 (`?edit=` — §4.8, 별도 뷰 없음) | E2, E4 |
| **E6** | 템플릿 갤러리 + `easy-labels` 일괄 적용 + creator 파라미터 제거 | E1 |
| **E7** | 관리 콘솔 정리(구 스튜디오 create-strip이 `#create` 우선 안내 등) | E1~E6 |
| **R1~R6** | 은퇴·분리 슬라이스(playground/irValidation/idempotency/myWork/dashboard adoption 탭/automationOps today) — 상세는 `rpa-console-simplification-review-2026-07-09.md` §6 | R4는 E1, R1은 E4 |

## 12. 구현 시 검증 포인트 (설계가 확정하지 않은 사실)

1. **`url_ref` 해석**: navigate의 `url_ref`가 심볼릭 키일 때 표시용 URL을 어디서 해석하는지(IR 내 URL 레지스트리 유무) — 구현 시 `draft_ir` 실물로 확인. 해석 불가면 키 원문 표기(날조 금지).
2. **planner가 `meta.studio_mode`를 방출하는지**: 생성 draft_ir에 `studio_mode`가 없으면 easy 스튜디오 재진입 판정은 "generation 이력에 연결된 시나리오" 기준으로 대체하고, `studio_mode:"easy"` 기록은 P1(IR PUT 도입 시).
3. **`session.capture`의 역할 배정**: operator 포함 여부를 `rbac-policy.ts`에서 확인 후 §9 게이트에 반영.
4. **`runScenarioGeneration`이 만드는 run의 run_mode**: 보정+실행 경로의 run이 test로 생성되는지 확인 — 아니라면 P0에서는 보정 후에도 `createRun(run_mode:"test")` 경로로 통일.
5. 템플릿 목록 API의 정확한 함수명/타입(ConnectorCatalog 사용분 재사용) — E6 착수 시 확정.

## 13. 열린 결정 (확정값 포함)

| 결정 | 확정/기본값 |
|---|---|
| `creator`/`intent` 파라미터 | **폐기 확정** — 전달부 제거(E6), 신규 도입 없음 |
| 말로 고치기 방식 | P0=합성 프롬프트 재생성(계약 무변경). 전용 revision API는 P1 추가 계약 후보(api-surface.md 갱신 필요) |
| SecretRef 준비 행 | P0 **제외** (SiteItem에 판정 필드 없음 — 확인 불가를 행으로 만들지 않음) |
| DEFAULT_VIEW | `create`로 변경 확정. `myWork`는 **은퇴**(R4, 단순화 검토로 존치 결정 번복) |
| 집중 스튜디오(E5) | **삭제 확정** — edit 모드는 위저드 재사용(§4.8). 전용 스튜디오는 사용 데이터가 필요성을 입증할 때 재논의 |
| 카드 직접 편집·이름 변경·IR PUT 저장 | P1 (말로 고치기 사용 데이터 확인 후) |
| standard 모드 잔존 뷰 최종 목록 | §2.3에서 확정(단순화 검토 반영) — E1 PR 테스트에 고정 |
