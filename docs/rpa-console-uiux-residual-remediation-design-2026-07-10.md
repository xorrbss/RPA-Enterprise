# 콘솔 UI/UX 재감사 잔여 감점 해소 설계 (F1~F6) — 2026-07-10

재감사 83/100(B+) 이후 남은 감점 5건을 전량 해소하는 설계다. T계열(`rpa-console-uiux-audit-remediation-design-2026-07-10.md`)·원패스 상세 설계(`rpa-easy-authoring-detailed-design-2026-07-09.md`, 이하 "상세 설계")·진행 레지스터(`uiux-redesign-progress-2026-07.md`)의 확정 결정을 재논의 없이 계승하고, 상세 설계 §13이 P1로 예약해 둔 항목(revision 계약, 원패스 셸)을 이행한다. 모든 "현황"은 2026-07-10 실측(file:line)이며, 확인하지 못한 사실은 §8로 분리했다(날조 금지).

| 슬라이스 | 대상 감점 | 계약 변경 | 의존 |
|---|---|---|---|
| F1 | 말로 고치기 — 원본 요청 접근 계약 부재 (P1·계약) | **있음** (README v2.35) | — |
| F2 | 말로 고치기 UI + 변경 표시 (P1) | 없음 (F1 소비) | F1 |
| F3 | 만들기 홈 세로 밀도 ~3,300px (P1·구조) | 없음 | — (F2와 병행 가능) |
| F4 | 알림 detail 영문 잔재 + 벨 드롭다운 (P2+P1) | **있음** (enum 드리프트 보정, README v2.36) | — |
| F5 | run 소요 시간 열 (P1·계약) | **있음** (기존 DDL 컬럼의 API 노출, README v2.36) | — |
| F6 | step-sentences 기본 문장 부정확 (P2) | 없음 | — |

공통 불변식(전 슬라이스): 조용한 false/green 금지 · 날조 금지(관측 안 한 값 단정 금지) · SecretRef/원문 비밀 비노출 · RBAC은 백엔드 권위 · abort→cancelled→"취소됨" 어휘 체인 · copy-gate(`web/tools/copy-gate.mjs`) 통과 · 파일 500줄 CI 게이트 · **단계 칩(스텝퍼) 재도입 금지**(상세 설계 §4.2 `:133`) · 계약 변경은 README 패치 로그 필수(현재 최신 v2.34 → 이번 델타는 v2.35/v2.36).

---

## 1. F1 — 말로 고치기 계약: redaction 통과본 영속 + revise 엔드포인트

### 1.1 현황 (실측)

- **원본 프롬프트는 의도적으로 저장하지 않는다.** `db/migration_core_entities.sql:1121` 헤더 주석 "prompt 원문은 저장하지 않고 hash/ref만 둔다", `:1132-1133` `prompt_hash text NOT NULL` + `prompt_redacted_ref text -- optional redacted prompt artifact/ref. 원문 저장 금지.` `prompt_redacted_ref`는 어느 경로도 채우지 않는다(store INSERT `scenario-generation-store.ts:331-332` 컬럼 목록에 없음).
- 상세 설계 §3.3(`:109-113`)은 P0를 "합성 프롬프트 재생성(계약 무변경) — 클라이언트가 원문을 쥐고 `${원본}\n\n[수정 요청] ${입력}`"으로 확정했고, §13(`:312`)이 "전용 revision API는 P1 추가 계약 후보"로 예약했다. 레지스터 E5′(`:51`)가 "원본 프롬프트 접근 계약 부재"를 P1 잔여로 기록했다. **본 슬라이스가 그 P1의 이행이다.**
- 저장은 생성 POST의 `mode:"save"`가 원자 처리(`persistGeneration`이 `scenarios`+`scenario_versions` INSERT, `scenario-generation-store.ts:269-295`). 별도 저장 엔드포인트 없음. `scenario_versions`는 `UNIQUE(tenant_id, scenario_id, version)`(`migration_core_entities.sql:579`), `promotion_status DEFAULT 'draft'`(`:524`), prod는 scenario당 1건 유니크(`:584-585`) — **새 버전을 draft로 추가해도 운영 배포본 무영향**.
- 기존 시나리오에 버전을 얹는 선례: `PUT /v1/scenarios/{id}`(`app/src/api/scenarios.ts:293-295`) — "If-Match(현재 version) 필수, 컴파일 파이프라인 재실행, version은 직전+1로만 단조 증가".
- 생성 이력 목록 `GET /v1/scenario-generations`의 필터는 `status`/`run_id`뿐(`scenario-generations.ts:114,131`) — **scenario_id 필터 없음**.
- scengen 에러는 전용 enum 없이 범용 코드+`details.reason`(`prompt_too_long` 등, `scenario-generation-parse.ts:88-89` 상한 20,000자). 생성/재실행 POST는 Idempotency-Key 필수(`scenario-generations.ts:205-208`).

### 1.2 설계 결정

**D1. "원문 저장 금지" 계약 결정은 유지한다.** 저장 대상은 게이트웨이 결정형 redaction 경계(`DeterministicGatewayRedactionBoundary`, `app/src/main-scenario-planner.ts:55-75`에 이미 조립됨)를 통과한 **redaction 통과본**이다. `scenario_generations`에 `prompt_redacted text` 컬럼을 추가하고, 생성 POST가 플래너 종류와 무관하게 항상 채운다. 기존 `prompt_redacted_ref`(artifact ref)는 재정의하지 않고 대형 첨부 확장용으로 예약 유지 — 인라인 본문 채택 사유는 프롬프트 상한이 20,000자 text라 artifact lifecycle(RBAC 게이트·retention 잡) 결합이 과도(YAGNI)하기 때문. 비밀이 섞였던 프롬프트는 마스킹 토큰이 남는데 이는 정직한 동작이다(비밀 재주입 금지 — 정상 케이스는 자리표시/params 계약상 프롬프트에 비밀이 없어 무손실).

**D2. `POST /v1/scenario-generations/{generationId}/revise` 신설 — 서버측 합성 재생성.** 클라이언트 합성(§3.3 P0)은 "클라가 원문을 쥔 동안"만 성립하므로, 저장된 자동화 대상 재수정은 서버가 원장에서 `prompt_redacted`+`params_context`+`evidence_policy`+`planner`/`model`을 로드해 `${prompt_redacted}\n\n[수정 요청] ${instruction}`으로 기존 planAndCompile 파이프라인(`scenario-generations.ts:336-377`)을 재실행한다. UI 도입 후에는 초안 직후 재수정도 이 단일 경로를 쓴다(생성 1회차가 이미 `mode:"save"`로 저장돼 있으므로 두 표면의 전제가 동일).

**D3. revise는 기존 시나리오의 새 draft 버전으로 원자 저장한다.** `persistGeneration`에 "기존 `scenario_id`에 `version = head+1` INSERT" 분기를 추가한다(신규 시나리오 INSERT를 갈라치지 않고 같은 함수의 분기 — 단일 쓰기 경로 유지). 요청 body의 `base_version`이 현재 head와 다르면 `SCENARIO_VERSION_CONFLICT`(409) — PUT의 If-Match 규율과 동형. 매 수정마다 새 시나리오가 생겨 목록이 오염되는 것을 원천 차단하고, "말로 고치기 = 같은 자동화의 새 버전"이라는 사용자 기대와 일치시킨다. draft로 저장되므로 기존 승격 거버넌스(§1.1)가 그대로 적용된다.

### 1.3 계약 델타 (README v2.35 패치 로그로 기록)

| 파일 | 변경 |
|---|---|
| `db/migration_core_entities.sql` | `scenario_generations.prompt_redacted text` 컬럼 추가(NULL=구세대·미보존). 헤더 주석 `:1121`을 "원문은 저장하지 않는다(hash + redaction 통과본만)"로 갱신 |
| `api-surface.md` §2.5 | ① `POST /v1/scenario-generations/{generationId}/revise` 행 신설 — `Idempotency-Key` 필수, body `{ instruction(1..2000자), base_version }`, `scenario.create` 권한, 200 `{ generation 표준 응답(scenario_id=원본, scenario_version_id=새 draft 버전) }` ② 목록 행에 `scenario_id` 필터 추가 |
| `codegen/openapi.yaml` | 위 2건 반영 — 경로 신설은 parity 게이트(`codegen/contract-consistency.ts:342` `assertOpenApiSurfaceParity`, method+path 양방향 집합 동등) 때문에 api-surface.md와 반드시 동시 수정 |
| `ts/control-plane-contract.ts` + `codegen/contract-consistency.ts` | revise 경로를 `ControlPlanePath` 유니온에 추가하고, 대조 assert 행(`assertControlPlanePath("/v1/scenario-generations/{generation_id}/revise")`) 추가 — 게이트는 유니온 문자열 포함 검사(`contract-consistency.ts:410-414`) |
| `web/src/api/types-scenarios.ts`·`client.ts` | `ScenarioGenerationReviseRequest` 타입 + `reviseScenarioGeneration(generationId, body, idempotencyKey)` + 목록 `scenario_id` 필터 파라미터 |
| `README.md` | v2.35 패치 로그 — "원문 저장 금지 결정 유지, 저장 대상은 결정형 redaction 통과본" 사유 명기 |

### 1.4 서버 동작 규칙

- 합성 프롬프트 총길이가 20,000자 초과 시 기존 `prompt_too_long` 재사용. `instruction`은 1..2,000자(빈 값은 `instruction_required`).
- 대상 generation의 `prompt_redacted IS NULL`(구세대) → 422 `IR_SCHEMA_INVALID { reason: "prompt_not_retained" }` — scengen 관례(범용 코드+reason, 전용 enum 신설 안 함) 준수. UI는 이 사유를 그대로 표기한다(§2.4, 조용한 비활성 금지).
- 대상 generation의 `scenario_id IS NULL`(draft_only였거나 저장 실패) → `reason: "scenario_not_persisted"`.
- RBAC `scenario.create` + 테넌트 RLS(기존 경로 동일). 검증 파이프라인은 생성과 동일(AJV + IREL 컴파일 + 정적검증 V1~V13, `compile-pipeline.ts:29-52`) — 재수정 결과도 같은 경계를 통과해야 저장된다.
- 새 generation 행: `prompt_hash`=합성 프롬프트 해시, `prompt_redacted`=합성 프롬프트의 redaction 통과본(다음 재수정의 입력이 됨 — 수정 이력이 프롬프트에 누적되는 것은 의도된 동작), `scenario_id`=원본, `created_by`=요청자.

---

## 2. F2 — 말로 고치기 UI + 변경 표시

### 2.1 표면 2곳, 단일 경로

| 표면 | 위치 | 원문 출처 |
|---|---|---|
| 초안 직후 | `GenerationResult.tsx`(현 269줄, StepCards 렌더 `:66-70`) 하단 | 직전 generation_id로 revise 호출(서버가 원장에서 로드) |
| 저장된 자동화 | `FocusedScenarioStudio.tsx` 설계 탭 DesignStepCards 아래 | `listScenarioGenerations({ scenario_id })` 최신 1건 → revise |

입력 UI는 한 줄 textarea + "말로 고치기" 버튼(placeholder 예: "예: 로그인한 다음 화면을 저장하는 단계도 넣어줘"). 진행 중 버튼 잠금 + 진행 문구. 성공 시 StepCards를 새 draft_ir로 교체하고 §2.2 변경 표시를 겹친다. 클라이언트 합성 방식(§3.3 P0)은 도입하지 않는다 — F1의 revise가 P1 이행으로서 이를 대체한다(레지스터에 §13 결정 갱신 기록).

### 2.2 변경 표시 (상세 설계 §3.3 확정 방식)

이전/새 `draft_ir`를 node_id 기준 비교: 양쪽 존재+JSON 동일→무표시, 양쪽 존재+상이→`changed`, 새쪽에만→`added`, 이전에만→`removed`. `StepCards`에 `changeMarks?: ReadonlyMap<string, "added" | "changed">` 오버레이 슬롯을 추가(기존 `stepStates` 슬롯과 동형 — E2 구조 재사용). `removed`는 카드가 없으므로 카드 목록 위에 "이전 초안에서 빠진 단계 N개" 요약 행으로 정직하게 표기. 플래너가 node_id를 전부 바꿔 만들면 대부분 added+removed로 보이는데 그대로 보여준다 — "변경 없음"을 추정으로 표기하지 않는다(날조 금지).

### 2.3 실패·비활성 상태

- `prompt_not_retained` → 입력 대신 안내 행: "이 자동화는 원본 요청이 저장되기 전에 만들어져 말로 고치기를 쓸 수 없습니다. 요청을 새로 입력해 다시 만들어 주세요." (+ 만들기 홈 딥링크)
- generation이 아예 없는 시나리오(운영자 직접 설계·녹화 경로) → 설계 탭에서 입력 미노출 + 동일 취지 안내 1행. 조용한 미노출 금지 — 사유를 항상 문장으로.
- `SCENARIO_VERSION_CONFLICT` → "다른 곳에서 이 자동화가 먼저 수정되었습니다. 최신 내용을 불러온 뒤 다시 시도해 주세요." + 재조회 버튼.

### 2.4 테스트

step-diff 유닛(added/changed/removed/전면 교체), revise 훅 성공·409·422 각 사유 문구, FocusedScenarioStudio 비활성 사유 렌더, copy-gate 통과.

---

## 3. F3 — 만들기 홈 원패스 셸 완성 (세로 밀도 해소)

### 3.1 현황 (실측) — 밀도의 근본 원인은 "확정 설계 미이행"

`Create.tsx:96-168`은 조건 없이 대형 패널을 직렬 렌더한다: ReviewStrip(:99) → CreateJourneyHeader(:100, 장식용 4단계 ol) → AutomationStartChooser 6카드(:104) → **PromptScenarioGenerator(:128, 458줄)** → TemplateGallery(:138) → **ScenarioSetupCorridor(:139-157, 313줄)** → **ScenarioTestWorkbench embedded(:159-161, 256줄)** → **BrowserRecorderPanel(:163-167, 399줄)**. 생성기는 결과가 나와도 입력 폼을 접지 않고 GenerationResult를 아래에 덧붙인다(`PromptScenarioGenerator.tsx:431-450`) — 초안 후 페이지가 오히려 길어진다.

상세 설계 §3(`:82-95`)의 원패스 상태머신 `IDLE→PRECHECK→GENERATING→PREVIEW→TESTING`과 §4.2/§4.5의 위저드 셸(`useEasyGeneration`)은 **미구현**이다(레지스터 E2 `:47` "위저드 셸·useEasyGeneration은 E3/E4로", E6 `:52` "위저드 셸 부재로 보류(설계 개정 기록)"). **F3은 새 설계가 아니라 이 확정 설계의 이행이다** — 재논의 없음.

### 3.2 phase 파생 (`useEasyGeneration` — 상세 설계 §4.5 명명 준수)

기존 `useGenerationActions` 위에 파생 상태만 얹는 훅(로직 이동 없음): `generating→GENERATING`, `result===null→IDLE`, `result!==null && testRunId===null→PREVIEW`, `testRunId!==null→TESTING`. PRECHECK는 별도 phase가 아니라 IDLE 내 접힌 준비 요약이다(§3 `:100` "전부 green이면 접힌 한 줄 요약 — 단계 미추가 원칙"). 새로고침 시 IDLE 복귀는 수용(이력은 GenerationHistory가 제공, generation 딥링크 복원은 YAGNI — 결정 기록).

### 3.3 phase별 노출 매트릭스

| 섹션 | IDLE | GENERATING | PREVIEW | TESTING |
|---|---|---|---|---|
| ReviewStrip | ✓(큐 있을 때) | — | — | — |
| CreateJourneyHeader | ✓ | — | — | — |
| StartChooser / 딥링크 스트립 | ✓ | — | — | — |
| 생성기 입력 폼+고급 | ✓ | 잠금+진행 표시 | **접힌 요약**(요청문 1줄 + "요청 고치기" 펼침) | 접힌 요약 |
| GenerationResult(StepCards+말로 고치기+CTA) | — | — | ✓ (주인공) | ✓ (상단 유지) |
| TestProgress(E4 컴포넌트 재배선) | — | — | — | ✓ |
| TemplateGallery | ✓ | — | — | — |
| ScenarioSetupCorridor | **접힌 요약**, blocker 있으면 자동 펼침 | — | — | — |
| ScenarioTestWorkbench(embedded, 기존 자동화 테스트용) | 접힘(details) | — | — | — |
| BrowserRecorderPanel | 접힘 — chooser "녹화" 선택 시 펼침 | — | — | — |
| GenerationHistory | ✓(접힘) | — | 접힘 | 접힘 |

- PREVIEW의 CTA "테스트 실행"은 화면 이동 없이 홈 안에서 TESTING으로 전환(`RunScenarioButton onStarted` → 홈 내 `TestProgress`) — E4 배선 재사용.
- CreateJourneyHeader의 정적 4단계 ol은 원패스 전환이 생기면 단계 칩과 시각적으로 중복된다 → IDLE 한정 표시(첫 화면 안내 기능 유지), PREVIEW부터 숨김. 새 단계 칩·프로그레스 바는 추가하지 않는다(금지 불변식).
- 접힘은 기존 `<details>` 관례(AdvancedSettings와 동일)를 쓴다 — 새 아코디언 컴포넌트 금지.

### 3.4 밀도 목표와 e2e 가드

IDLE 초기 화면(1440×900, 데이터 시드 기준) 스크롤 높이 목표 **≤ 2 뷰포트(~1,800px)**. `app/test/console-browser.e2e.ts`의 topbar 치수 가드(`:528-547`, `getBoundingClientRect` 패턴)를 재사용해 만들기 홈 `scrollHeight` 상한 가드를 신설한다 — 임계값은 구현 후 실측으로 확정(§8-④), 가드 취지는 "패널 상시 직렬 렌더로의 회귀 차단".

---

## 4. F4 — 운영 알림 한국어 마감 + OpenAPI enum 보정 + 벨 드롭다운

### 4.1 현황 (실측)

- 알림 12소스 중 9종은 이미 서버가 한국어 title/detail을 뱉는다. 영문 잔재는 정확히 3곳: ① `compute-governance.ts:331-344` scim_secret_rotation(전부 영문) ② `:388-418` readiness_evidence(전부 영문) ③ bot_pool — detail은 한국어지만 lease/heartbeat/circuit/worker 원어 혼재(`bot-pool-read.ts:248-254`), recommended_action 한/영 혼재(`compute-governance.ts:309`).
- 계약상 `title`/`detail`/`recommended_action`은 자유형 string(`codegen/openapi.yaml:9628-9645`) — **서버에서 한국어로 바꿔도 스키마 위반이 아니다**.
- web `localizeStatusText`(`ops-alert-labels.ts:26-36`)는 enum 단어만 정규식 치환 → 영문 문장에 부분 치환이 걸려 한/영 혼합 문장을 만든다. `OpsSignalPanel.tsx:70`은 recommended_action에 현지화 자체를 안 건다.
- **계약 드리프트(검증된 내부 불일치)**: `openapi.yaml` `OpsAlertSource`(`:6339-6351`)가 10종만 열거 — `artifact_redaction`·`security_abort` 누락. `OpsAlertSubjectType`(`:6352-6363`)에 `artifact` 누락. TS 타입(app/web)과 api-surface.md `:211`은 12종 전부 보유.
- 벨(`TopbarAlertBell.tsx`)은 팝오버 없는 이동 버튼(`:52-67`), 주석 `:11`이 "드롭다운 미리보기는 열린 결정 P1"로 기록. 그룹 데이터(`groupOpsAlerts`)와 원본 `alertItems`가 이미 컴포넌트 안에 있다 — **드롭다운에 계약 변경 불필요(재분류)**. 팝오버 선례는 `GlobalCreateMenu`(`TopbarActions.tsx:234-304` — mousedown 바깥닫기+Escape+트리거 포커스 복원+aria) 1곳이 완성형이고, 공용 팝오버 유틸은 없다(`getFocusable`조차 Layout/ConfirmDialog에 중복).

### 4.2 설계 결정

**D4. detail 구조화(code+params) 재설계는 기각한다(YAGNI).** 12종 중 10종이 이미 "서버가 한국어 카피를 뱉는" 확립 패턴이고 계약도 자유형 string이다. 기존 구조 우선 — 잔재 3곳의 서버 문구를 직접 교정한다. web의 `localizeStatusText`는 구세대 데이터 폴백으로 유지.

**D5. 병기 원칙(T4 계승):** 기술 원어는 "한국어(원어)" 병기로 1회 노출. 교정 문구(구현 시 T4 용어사전과 역어 대조 — §8-⑤):

| 위치 | 현재 | 교정 |
|---|---|---|
| `bot-pool-read.ts:248` | `만료된 활성 브라우저 lease N건을 회수해야 합니다.` | `만료된 브라우저 점유(lease) N건을 회수해야 합니다.` |
| `bot-pool-read.ts:251` | `브라우저 worker N개가 2분 이상 heartbeat를 보내지 않았습니다.` | `브라우저 실행기(worker) N개가 2분 이상 상태 신호(heartbeat)를 보내지 않았습니다.` |
| `bot-pool-read.ts:252` | `브라우저 worker N개의 circuit 상태를 확인해야 합니다.` | `브라우저 실행기 N개의 회로 차단(circuit) 상태를 확인해야 합니다.` |
| `compute-governance.ts:335-339` | `SCIM signing SecretRef rotation overdue` 외 | title `SCIM 서명 비밀 교체 기한 경과`, detail `{이름}({provider_key})의 교체 정책({policy}) 기한이 지났습니다.`, action `새로 발급한 서명 비밀 참조로 제공자 설정을 갱신하세요.` — detail 내 ISO 시각은 제거하고 기존 `due_at` 필드로 일원화(web이 한국어 시각으로 렌더) |
| `compute-governance.ts:407-413` | `latest production-readiness evidence is recorded as failed ...` | detail `{이름}의 최신 운영 전환 증빙이 실패로 기록되어 있습니다.`, action `운영 준비 화면에서 유효한 증빙을 다시 기록한 뒤 전환을 진행하세요.` |
| `compute-governance.ts:309` | 한/영 혼재 action | `봇 풀 용량, 만료된 점유(lease), 실행기 상태 신호(heartbeat)와 회로 차단(circuit) 상태를 확인하세요.` |

**D6. 영문 잔재 회귀 가드(서버측):** ops-alerts compute 유닛테스트에 "전 소스의 title/detail/recommended_action은 대문자 스네이크 enum(`[A-Z]{2,}(_[A-Z0-9]+)+`)과 비병기 영단어 연속을 포함하지 않는다"를 추가 — web copy-gate 규칙을 미러링하되 병기 괄호(`(lease)` 등)와 약어 허용어 목록(SCIM 등)은 통과. 서버 카피는 web copy-gate 범위 밖이므로 이 테스트가 그 공백을 메운다.

**D7. OpenAPI enum 드리프트 보정(README v2.36):** `OpsAlertSource`에 `artifact_redaction`·`security_abort`, `OpsAlertSubjectType`에 `artifact` 추가. 검증된 내부 불일치 교정이므로 계약 규율에 정합.

### 4.3 벨 드롭다운

- 트리거: 기존 벨 버튼이 클릭 시 즉시 이동하던 것을 팝오버 열기로 변경. `aria-haspopup="menu"`/`aria-expanded`/`role="menu"·menuitem`, Escape 닫기+트리거 포커스 복원, mousedown 바깥 닫기 — GlobalCreateMenu와 동일 규약.
- 내용(위→아래): ① readiness 차단 1행(있을 때, 클릭→운영 준비 화면 route) ② 그룹 상위 5행 — severity 내림차순 정렬, 각 행 = `opsAlertSourceLabel` + title + `외 N건`, 클릭 시 `representative.route ?? navigate("automationOps",{section:"alerts"})` ③ 하단 "알림 센터에서 모두 보기 →"(기존 딥링크). 개별 알림 앵커/단건 GET 신설은 하지 않는다(그룹 대표 route로 충분 — YAGNI, 실측 §4.1).
- 로딩 중·0건 규칙은 기존 유지: 데이터 미도착+차단 0이면 벨 자체 미렌더(`:39`), 팝오버 열림 상태에서 0건이면 "새 알림이 없습니다" 1행(관측된 빈 목록만 표기 — 가짜 0 금지).
- **공용화(3번째 복제 방지):** mousedown 바깥닫기+Escape+포커스 복원을 `usePopoverDismiss` 소형 훅으로 추출해 GlobalCreateMenu와 벨이 공유한다. Layout의 계정 팝오버 개조(바깥 클릭 닫기 부재)는 비범위 — 후속 후보로 레지스터에 기록.

### 4.4 web측 마감

`OpsSignalPanel.tsx:70`의 recommended_action에 `localizeStatusText` 적용(OpsAlertCenter `:124-127`과 통일). 12소스 라벨(`opsAlertSourceLabel`)은 이미 완비 — 변경 없음.

---

## 5. F5 — run 소요 시간 표면화

### 5.1 현황 (실측)

`runs` DDL에 `started_at`(R2 run.started)·`ended_at`(terminal 진입) 컬럼이 **이미 존재**(`migration_core_entities.sql:982-983`) — DB 변경 불필요. 그러나 목록 SELECT(`app/src/api/reads-runs.ts:67-69`)와 상세 SELECT(`app/src/api/server.ts:228-229`) 모두 미조회, 직렬화에도 없음. `codegen/openapi.yaml`은 목록·상세가 `Run` 스키마 1개를 공유(`:9318-9359`, 시각은 as_of/updated_at뿐). web `RunItem`/`RunDetail`(`types-runs.ts:7-19,70-85`)도 동일. 목록 커서는 `(created_at,id)` keyset(`reads-runs.ts:78-79`)이라 **표시 전용 필드 추가는 커서 무영향**. step 레벨엔 `duration_ms` 선례 존재(`types-runs.ts:113-115`). 공용 run-소요 포매터는 없음(로컬 중복 3곳 실측).

### 5.2 계약 델타 (README v2.36 — F4의 enum 보정과 같은 로그로 묶음)

| 파일 | 변경 |
|---|---|
| `codegen/openapi.yaml` `Run` 스키마 | `started_at`/`ended_at` (nullable date-time) 2필드 추가 — 목록·상세 동시 반영 |
| `api-surface.md` §1 목록·상세 행 | 두 필드 명기(모름/미시작은 null) |
| `app/src/api/reads-runs.ts:67-69`+직렬화, `server.ts:228-229`+응답 | `r.started_at`, `r.ended_at` 투영 |
| `web/src/api/types-runs.ts` | `RunItem`/`RunDetail`에 `started_at?: string | null`, `ended_at?: string | null` |

parity 게이트는 method+path 단위라 필드 누락을 못 잡는다(실측) — 위 4곳 동기화는 슬라이스 체크리스트로 강제하고 커밋 메시지에 명기.

### 5.3 UI

- `RunTrace.tsx` columns(`:161-303`)의 "기준 시각" 열 뒤에 **"소요"** 열 추가: `ended_at−started_at`을 새 공용 포매터로 표기. **종결 run만 소요를 표기**하고, 진행 중·미시작은 "—"(상태는 이미 상태 열이 말한다) — 클라이언트 시계로 경과를 추정 표기하지 않는다(날조 금지, 결정 기록).
- `RunDetailPanel.tsx:132-160` dl에 "시작 시각 / 종료 시각 / 소요" 3항목 추가(null은 "—").
- 포매터: `web/src/util/time.ts`에 `formatRunDuration(startedAt, endedAt): string | null` export 신설(1초 미만 "1초 미만", 초/분/시 단위 한국어, `tabular-nums`는 열 CSS) — 새 파일 금지 원칙에 따라 기존 time.ts 확장. 기존 로컬 중복 3곳 통합은 비범위(후속 후보).

---

## 6. F6 — step-sentences 미처리 폴백 정밀화

### 6.1 현황 (실측) — "flow 없는 노드"는 존재하지 않는다

`ir.schema.json:110-117`이 flow 키 정확히 1개를 강제하므로, 기본 문장 "다음 단계로 진행합니다"(`step-sentences.ts:167-170`)에 도달하는 것은 `what`이 비고 `flowNote`(`:137-160`)가 라벨을 못 만드는 3형이다:

- (a) 평범한 `next`(비예약 문자열 target) — `:154-159`가 의도적으로 `undefined` 반환.
- (b) `fallback_chain`만 있는 노드 — flowNote가 이 키를 아예 검사하지 않음.
- (c) **객체형 예약 핸들러 target** — 스키마상 `@challenge`/`@human_task`는 `{handler,input,return_node}` 객체(`ir.schema.json:288-311`)인데 `:154`가 문자열만 취급 → 기본 문장. 더 나쁘게는 `on` 분기 target이 객체면 `String(...)`으로 **"[object Object]"가 렌더**(`:142`). 사람 확인 대기 노드가 "다음 단계로 진행합니다"로 읽히는 감사 지적의 실체가 (c)다. 테스트·seed 어디서도 3형 모두 미커버(전 저장소에서 기본 문장 출현은 소스 1곳뿐).

### 6.2 문장 규칙 수정

| 형 | 규칙 |
|---|---|
| (c) 객체형 예약 핸들러 | `reservedTargetLabel`(`:130-135`)이 문자열 외에 `{handler}` 객체도 매칭하도록 확장 — 기존 예약 핸들러 문장(사람 확인/추가 인증/데이터 없음 종료) 재사용. `on` 분기 detail(`:142`)도 동일 함수 경유로 "[object Object]" 제거 |
| (b) fallback_chain 전용 | flowNote에 추가: "잘 안 되면 대비 방법 N개를 차례로 시도합니다" — 기존 fallback 카드 그룹 문구와 정합 확인(§8-⑥) |
| (a) 평범한 next | 현행 문장 유지 — 실제로 다음 단계로 진행하므로 정확하다(결정 기록: 노드 id 노출 금지 원칙상 target 이름 병기는 하지 않음) |

### 6.3 테스트

`web/test/step-sentences.test.ts`에 5케이스 추가: 객체형 `@human_task` next / 객체형 `@challenge` on-분기 target(“[object Object]” 부재 단언 포함) / fallback_chain-only / what 없는 평범한 next(현행 문장 고정) / `@end_no_data` const 문자열 회귀.

---

## 7. 슬라이스 실행 계획

- **순서**: F6 → F5 → F4 → F1 → F2 → F3 (작고 독립적인 것부터; F1→F2는 순차 필수, F3은 F2의 GenerationResult 변경과 충돌 방지를 위해 마지막).
- 1 슬라이스 = 1 브랜치 = 1 PR, CI green → 머지 → main green 확인(`gh run list --branch main`). 레지스터(`uiux-redesign-progress-2026-07.md`)에 슬라이스별 append.
- 검증 명령: `npm --prefix web run typecheck && npm --prefix web test && npm --prefix web run build && npm --prefix web run lint:copy`; 서버 슬라이스(F1·F4·F5)는 `npm --prefix app run test:unit` + 로컬 게이트(`node scripts/run-local-gates.mjs`); F3은 추가로 `npm --prefix app run test:console-e2e`. 테스트 파일 수정 후 build/typecheck 재실행(E6 교훈).
- 계약 슬라이스(F1·F4·F5)는 api-surface.md ↔ openapi.yaml ↔ 서버 파서/직렬화 ↔ web 타입 4면 동기 + README 패치 로그(v2.35/v2.36)를 같은 PR에 포함.

## 8. 구현 시 검증 포인트 (설계가 확정하지 못한 사실 — 착수 전 확인, 날조 금지)

1. **params_context에 start_url·target이 실제로 남는지**: revise 재생성 컨텍스트 복원의 전제(`scenario-generation-store.ts:134-152`는 재실행 경로에서 start_url을 params_context에서 꺼낸다). 부족하면 revise 요청 body에 optional 컨텍스트를 추가하는 대신 **generation 원장에 컬럼을 늘리는 쪽**을 우선 검토.
2. **persistGeneration 버전 증가의 동시성**: `UNIQUE(tenant_id, scenario_id, version)` 충돌 시 `SCENARIO_VERSION_CONFLICT`로 환원되는지 — PUT 경로(`scenarios.ts:273` 주석)의 IFM 멱등 회수 패턴과 동일하게.
3. **deterministic_mvp 플래너의 node_id 안정성**: 재생성 시 id가 보존되는지에 따라 §2.2 diff의 체감 품질이 결정 — 보존 안 되면 "전면 교체로 보임"을 안내 문구로 표기(추정 diff 금지).
4. **F3 높이 임계 실측**: IDLE 목표 ≤ ~1,800px은 목표치 — e2e 가드 임계는 구현 후 실측값+여유로 확정(스크린샷 아닌 `scrollHeight` 계측).
5. **F4 역어 대조**: worker→"실행기" 등이 기존 T4 확정 라벨과 일치하는지 web 용어사전(`badges.tsx` KIND/STATUS 라벨군) 대조 후 확정.
6. **F6 fallback 문구 정합**: step-sentences의 기존 fallback 그룹 문구("기타 경로" 등)와 새 fallback_chain 문장의 어휘 통일.
7. **revise의 evidence_policy/planner 승계**: 원 generation 값 그대로 승계가 기본 — 예외(모델 교체 등)는 P2로 미룸(YAGNI).

## 9. 점수 영향 예측과 수용 기준

| 카테고리 | 재감사 | 목표 | 근거 |
|---|---|---|---|
| 온보딩·첫 사용 | 78 | ~88 | F3(초기 화면 ≤2뷰포트·원패스 전환) + F1/F2(말로 고치기 개통) |
| 상태 피드백·알림 | 86 | ~90 | F4(영문 잔재 0 + 벨 미리보기) |
| 시각 완성도 | 87 | ~89 | F3 밀도, F5 소요 열 |
| 용어·카피 | 88 | ~90 | F4 병기 원칙 + 서버 카피 가드 |

수용 기준(감사 방법 재사용 — shots/probe 패턴): ① 만들기 홈 IDLE `scrollHeight`가 가드 임계 이하 ② 초안 생성 직후 입력 폼이 접힌 요약으로 전환 ③ 저장된 자동화 설계 탭에서 말로 고치기 → 변경 카드 표시(또는 정직한 비활성 사유) ④ 실행 기록에 소요 열(종결 run 값·진행 중 "—") ⑤ 알림 센터·대시보드·벨 어디에도 비병기 영문 detail 없음 ⑥ 벨 클릭 시 드롭다운(키보드 Escape 복원) ⑦ `@human_task` 객체 target 노드가 "담당자 확인" 문장으로 렌더("[object Object]"·기본 문장 아님).
