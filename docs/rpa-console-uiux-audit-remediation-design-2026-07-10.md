# 콘솔 UI/UX 감사 해소 설계 — 상단바·알림·운영 동선·용어 시스템 (T계열)

작성일: 2026-07-10
상태: 설계 확정 대기 (구현 계획 입력용). 최소 수정 원칙 해제 상태(제품 오너 지시)에서의 재설계.
범위: 2026-07-10 라이브 콘솔 UI/UX 감사(종합 63/100)에서 확인된 P0 4건·P1 5건·P2 군의 구조적 해소.
비범위: 계약(contract) 변경, 보안 불변식 완화, 쉬운 제작 재설계(E0~E7·R1~R6 — 별도 확정 설계)의 재논의.

관련 문서:

- `docs/rpa-easy-authoring-detailed-design-2026-07-09.md` (확정 — 본 문서는 이를 **전제**로 하며 재논의하지 않는다)
- `docs/rpa-console-simplification-review-2026-07-09.md` (은퇴 R1~R6 확정 — 본 문서의 정합표가 참조)
- 감사 리포트: 아티팩트 `RPA 콘솔 UI/UX 감사 리포트 (2026-07)` — 실서버(dev:serve)+실 Chrome, 20개 뷰 전수 + 8개 동선 프로브, 1440×900/1920×950 실측

근거: 본 문서의 모든 file:line 인용은 2026-07-10 코드 기준 실측이다. 확인하지 못한 사실은 §8 "구현 시 검증 포인트"에 분리했다.

## 1. 배경 — 감사가 확인한 것

기능·안전장치(RBAC 게이팅·empty state·딥링크·에러 0)는 견고하나, 다음이 체감 품질을 깎는다:

1. **표면 결함(P0)** — 기본 해상도(1440×900)에서 깨지는 상단바, 오독을 만드는 빨간 "차단" 배지, 동일 경고 3중 반복, 라벨-본문 붙는 도입 증빙.
2. **운영 동선 마찰(P1)** — 만들기 4-in-1 스크롤, 스튜디오 행당 액션 6개, 원시 IR 노출, 승인 없는 승인 드로어, 구분 불가한 실행 목록.
3. **용어 누출(P2)** — `DEAD_LETTER`·"redacted"·"handoff"·"S11" 등 내부 코드가 사용자 문자열에 잔류.

이 중 제작 경험(P1의 만들기·IR 노출)은 확정 설계 E/R 계열이 이미 해소한다. 본 문서는 **E/R이 다루지 않는 나머지**를 T계열 슬라이스로 설계하고, 겹치는 항목은 E/R의 수용 기준을 보강한다.

## 2. 감사 지적 ↔ 처분 정합표

| 감사 지적 | 처분 | 근거 |
|---|---|---|
| P0-1 상단바 1440px 붕괴 | **T1** | 신규 |
| P0-2 "차단" 배지 오독 | **T1** | 신규. 실측 정정: 소스는 사이트 서킷이 아니라 **production-readiness**(`TopbarActions.tsx:149-160` — `status==="blocked" \|\| blocker_count>0`→red→"차단") |
| P0-3 대시보드 동일 경고 3중 + "알림 센터 열기" 어포던스 + raw ISO | **T2**(+T3) | 신규. dedupe 로직은 이미 존재(`ops-alert-labels.ts:28-40` `groupOpsAlerts`) — 대시보드만 미사용 |
| P0-4 도입 증빙 라벨-본문 붙음·이중 문장부호 | **T8** | 신규 (`AdoptionReadinessPanel.tsx:276-294`) |
| P1-5 만들기 4-in-1 스크롤 | **E1~E7 + R1** (기확정) | 감사 제안(스텝퍼 위저드)과 확정 설계(한 화면 순차 등장·단계 칩 삭제)가 다르나 **확정 설계 유지** — 근본 지적(도구 4개 나열·스크롤 점프)은 E1 홈 + R1 은퇴로 해소됨. 본 설계는 수용 기준만 추가(§7) |
| P1-6 스튜디오 행당 액션 6개·테스트 용어 3종 | **T7** (E7 확장) | 신규 (`Scenarios.tsx:233-301`) |
| P1-7 원시 IR 덤프 | **E2 + T7** | 렌더러는 E2 `step-sentences`가 신설(기확정). T7이 관리 콘솔 잔존 표면(`Playground.tsx:69-94` `Plan` — workbench로 embed됨)을 교체 |
| P1-8 사람 확인: 결정 2단계·0-타일·일괄 승인 스타일·단위 | **T5** | 신규 (`HumanTasks.tsx`, `HumanTaskDetailPanel.tsx`, `HumanTaskActions.tsx`) |
| P1-9 실행 기록 식별 불가·우선순위 컨트롤 불일치 | **T6** | 신규 (`RunTrace.tsx:161-341`) |
| P2 내부 용어 누출 6곳+ | **T4** | 신규 — 라벨 SSoT는 이미 `badges.tsx`. 개별 문구 교정 + CI 게이트 신설 |
| P2 raw ISO 2곳·수량 단위 혼재·비용 단위 없음 | **T3** | 신규 — `formatDateTime`(`util/time.ts:41`)은 이미 존재, 미사용 지점만 잔존 |
| P2 버튼 세로랩·사이드바 잘림·가짜 탭·coePipeline 모순·Workitems 무의미 열·llmGateway 타일 불일치 | **T8** | 신규 |
| P2 viewer에 "+ 새로 만들기" 노출 | **T1** | 실측 정정: navPolicy 문제가 아니라 메뉴 항목 "증빙 확인"이 `run.read && artifact.read` 게이트(`TopbarActions.tsx:242-250`)라 viewer(둘 다 보유, `ts/rbac-policy.ts:12-17`)에서 메뉴가 비지 않음 |
| P2 myWork 행 제목/부제 중복 | **R4 은퇴로 소멸** | 확인 스트립의 E1 이관 시 수용 기준 추가(§7) |
| playground 유사-위저드 / irValidation JSON 붙여넣기 / idempotency 문서 뷰 | **R1/R2/R3 은퇴로 소멸** | 단순화 검토 §2 |

## 3. T1 — 상단바 재설계: 정보 표시대에서 행동 도구로

### 3.1 문제 (실측)

- 데스크톱 topbar는 `TopbarContextBadge → SubjectChip → RolesChip → Freshness → GlobalCreateMenu → SearchButton → LogoutButton` 7조각을 한 줄에 렌더(`Layout.tsx:313-321`). 1440px에서 검색 버튼 "검/색" 세로 랩, 로그아웃 잘림, 역할 칩 5개 2줄 랩(감사 스크린샷 실측).
- `TopbarContextBadge`가 production-readiness 미충족 시 상시 빨간 "차단" 칩을 env 옆에 렌더(`TopbarActions.tsx:80-111, 149-160`) — "환경이 차단됨"으로 읽힌다. 실제 사이트 서킷 배너는 별도(`SiteCircuitNotice.tsx`, Security 뷰).
- `GlobalCreateMenu`는 항목 0개일 때만 숨김인데 "증빙 확인" 항목이 viewer 권한으로도 통과(`TopbarActions.tsx:242-250`) → viewer에게 "+ 새로 만들기" 노출.

### 3.2 설계

데스크톱 topbar 최종 구성(좌→우):

```
[뷰 타이틀·부제(기존)]  ······  [환경 칩(중립)] [🔔 알림] [검색] [+ 새로 만들기] [계정]
```

1. **계정 팝오버 신설(데스크톱)** — 기존 **모바일 계정 메뉴 팝오버(`Layout.tsx:286-310`)를 데스크톱에도 재사용**. 내용: 계정(SubjectChip), tenant 전체값, 역할 칩(RolesChip), 로그아웃. 이 4조각은 topbar 직접 렌더에서 제거. dev 역할 전환 위젯(`app/dev/serve.ts:270-272` 주입)은 우하단 고정으로 이동(topbar 겹침 제거, dev 전용).
2. **환경 칩 중립화** — `TopbarContextBadge`는 env 라벨만 중립 톤으로 표시. production-readiness red 판정은 "차단" 칩 대신 **알림 벨의 항목**("운영 전환 준비 차단 N건 → 도입 증빙 딥링크")으로 이동. 상시 빨강 제거 — 정보는 사라지지 않고 위치만 옮긴다(조용한 은폐 아님: 벨 배지 카운트에 반영).
3. **알림 벨 신설** — `components/layout/TopbarAlertBell.tsx`. 데이터는 기존 `listOpsAlerts` + `groupOpsAlerts`(T2와 동일 소스) + production-readiness red 1행. 배지 = 그룹 수(위험 tone 우선). 클릭 = `navigate("automationOps", {section:"alerts"})` (기존 "알림 센터 열기"와 동일 목적지 — 드롭다운 목록은 P1, §9).
4. **GlobalCreateMenu 정리** — 메뉴를 **생성 액션 전용**으로: "증빙 확인"(조회 액션)은 CommandPalette 빠른 액션으로 이동(이미 `command-palette/quickActions.ts` 존재). 생성 항목 0개면 버튼 자체 숨김 → viewer 비노출이 자동 성립.
5. **줄바꿈 금지 보증** — topbar 버튼·칩에 `white-space: nowrap` + 컨테이너 `flex-wrap: nowrap` + 최소 지원 폭 1280px. 넘치면 우선순위 낮은 조각(검색 라벨→아이콘화)부터 축약.

### 3.3 파일 계획·수용 기준

```
수정  web/src/components/Layout.tsx            데스크톱 topbar 조립 변경, 계정 팝오버 재사용
수정  web/src/components/layout/TopbarActions.tsx  ContextBadge 중립화·createMenuItems 생성 전용
신규  web/src/components/layout/TopbarAlertBell.tsx
수정  web/src/styles.css                        nowrap·최소폭 규칙
수정  app/dev/serve.ts                          dev 위젯 우하단 이동
```

- 테스트: `layout-nav-policy.test.tsx`·`layout-subject.test.tsx` 갱신(계정·역할이 팝오버 내부), 신규 `topbar-alert-bell.test.tsx`(red readiness→벨 항목·배지, "차단" 칩 부재), viewer에서 create 버튼 부재.
- e2e(`app/test/console-browser.e2e.ts`): 뷰포트 **1280×800·1440×900**에서 topbar DOM 검증 추가 — topbar `scrollHeight ≤ 단일행 임계(예 64px)`, 각 버튼 `offsetHeight ≤ 40px`(세로 랩 감지), viewer nav 기대값(L516-517) 갱신.

## 4. T2 — 알림 단일 파이프라인 · T3 — 표기 규칙

### 4.1 T2 설계

- **그룹핑 일원화**: 대시보드 `OpsSignalPanel`이 `listOpsAlerts({limit:3})` 원시 나열(`Dashboard.tsx:94`, `OpsSignalPanel.tsx`) 대신 **`groupOpsAlerts` 결과**를 렌더 — 알림 센터(`OpsAlertCenter.tsx:74,122`)와 동일 규칙("외 N건"). limit는 그룹 후 3개.
- **어포던스**: "알림 센터 열기"(`OpsSignalPanel.tsx:66`)는 이미 `.btn`이나 패널 흐름상 전폭으로 늘어나 입력창처럼 보임 — 그룹 목록 하단 우측 정렬 "알림 센터에서 모두 보기 →" 링크로 교체(전폭 블록 제거).
- **값-상태 분리**: 큐 대기 타일의 값 자리 "미연결" 제거 — 값은 "—", 아래 muted 배지 "수집 미연결"(사유 툴팁). automationOps `OpsHealthSummary`도 동형 적용(예약 스케줄러 "확인 필요"도 동일 패턴).
- 벨(T1)·대시보드·알림 센터가 **같은 그룹 결과를 소비** — dedupe 규칙이 화면마다 달라지는 것을 구조적으로 차단.

### 4.2 T3 설계 (표기 규칙)

| 항목 | 규칙 | 교정 지점 (실측) |
|---|---|---|
| 시각 | 항상 `formatDateTime`/`formatDeadline`(`util/time.ts:41,55`). raw ISO 렌더 금지 | `OpsSignalPanel.tsx:25`(`detected_at`), `Workitems.tsx:262`(`checked_out_at`) |
| 수량 | "N건" 통일 | `HumanTasks.tsx:212-324` queue-controls 칩("마감 임박 1"→"1건") |
| 비용/한도 | 단위 병기 | Gateway 정책 "비용 한도 1" → 단위 표기(§8-③ 계약 확인 후) |
| 저장값 vs 편집값 | 요약 타일은 저장된 정책, 편집 폼은 입력 중 값 — 두 표면이 다르면 "저장되지 않음" 배지 | `Gateway.tsx`/`PolicyReadout.tsx` 타일 "미지정" ↔ 폼 값 불일치 |

- 수용: `dashboard.test.tsx` — 동일 alert 3건 입력 시 1행+"외 2건"·ISO 원문 부재. raw ISO 금지는 T4 게이트가 상시 감시(§5).

## 5. T4 — 용어 시스템: 교정 + CI 게이트

### 5.1 개별 교정 (실측 지점)

| 지점 | 현재 | 교정 |
|---|---|---|
| `views/Workitems.tsx` DLQ 상태 칩 | 화면에 `DEAD_LETTER` 원문(감사 스크린샷) — `STATUS_LABELS`에는 소문자 `dead_letter`만 존재(`badges.tsx:42`), 대문자 키는 tone set(`badges.tsx:6`)에만 있어 라벨 폴백 실패 추정(§8-①) | `statusLabel` 키 정규화(소문자화) — 지도 미비가 아니라 조회 정규화로 해결 |
| `views/DocumentIdp.tsx:173`, `document-idp/helpers.ts:208,210` | "redacted 처리된 …" | "마스킹 처리된 …" |
| `views/Orchestration.tsx:45` | "외부 RPA/IDP handoff" | "외부 시스템 이관" |
| `components/gateway/PolicyReadout.tsx:90` | "redaction proof는 S11에서 다룹니다" | 내부 스트림 참조 제거, "마스킹 증빙은 실행 증거에서 확인합니다"류로 재작성 |
| `components/AdoptionEvidencePacket.tsx:238` | "Gateway와 S11 redaction proof …" | 동일 재작성 |
| Gateway 대체 모델 값 "fallback" | 리터럴 노출 | 미설정이면 "미지정(기본 정책 사용)" 표시 |

### 5.2 CI 용어 게이트 (신규)

기존 게이트 문화(파일 길이·OpenAPI 전수)와 같은 방식의 정적 검사를 추가한다:

- `web/tools/copy-gate.mjs` — `web/src/**` 문자열 리터럴·JSX 텍스트 스캔:
  1. **원시 enum 패턴** `/\b[A-Z]{2,}(_[A-Z0-9]+)+\b/` (사용자 노출 문자열 내) → 실패
  2. **금지어**: `redacted`, `handoff`, `metadata-only`, 표시 문구의 `fallback`, 내부 스트림 참조 `/\bS\d{1,2}\b/` → 실패
- 허용목록 파일(`copy-gate.allow.json`)로 정당 예외 관리 — 기술 상세 `<details>` 내부의 코드 원문 표기(문제 은폐 금지 원칙에 따른 정직 노출)는 허용 대상.
- 실행: `npm --prefix web run lint:copy`, CI의 web 파이프라인에 추가.
- 관계: E6 `easy-labels.ts`(만들기 콘솔의 적극 순화)와 층이 다름 — T4는 **콘솔 전역의 최소선**(내부 코드 차단). 충돌 없음.

## 6. T5 — 사람 확인 · T6 — 실행 기록 · T7 — 스튜디오 · T8 — 표면 하드닝

### 6.1 T5 사람 확인: 결정이 첫 번째인 인박스

- **드로어 1차 액션 승격**: `HumanTaskDetailPanel`에 [승인] [반려] 노출 — 대상은 승인 계열 kind이면서 구조화 검토 입력이 불필요한 업무(`human-tasks/labels.tsx`의 `requiresStructuredReviewInput` 판정 재사용). 클릭 시 기존 **일괄 승인의 assign→start→resolve 상태머신 체인(`HumanTasks.tsx:302-310`)을 단건 재사용** — 새 전이 발명 없음(state-machine 계약 준수). 구조화 검토 필요 kind는 현행 `HumanTaskReviewPanel` 흐름 유지.
- **0-타일 조건 렌더**: `human-task-metrics` 3타일(`HumanTasks.tsx:166-182`)은 문서 검증 계열 업무가 1건 이상일 때만 렌더. 전부 0이면 섹션 자체 미렌더(빈 지표가 첫 화면 선점 금지).
- **필터와 액션의 시각 분리**: queue-controls(`HumanTasks.tsx:212-324`)를 두 줄로 — 1줄: 조회·필터 칩(전체/미배정/마감 임박/문서 검증), 2줄: 벌크 액션 버튼(담당자 지정·이관·일괄 승인, 위험 tone). 기존 확인 다이얼로그·`human-tasks-bulk-safety` 가드(구조화 검토 제외) 불변. 체크박스 선택 기반 전환은 P1(§9).
- **표기**: 수량 "N건" 통일(T3), "담당자 정보 확인 필요"는 담당자 값 자리가 아니라 subtle 보조 행으로(`human-tasks/labels.tsx` `principalLabel` 폴백 위치 조정).
- 수용: `human-tasks-bulk-safety.test.tsx` 유지 + 신규 케이스 — 드로어 단건 승인/반려가 체인 호출·성공 후 목록 무효화, 구조화 검토 kind에는 단축 버튼 부재, 0-타일 미렌더.

### 6.2 T6 실행 기록: 행 식별성·컨트롤 통일

- **식별 열 추가**(`RunTrace.tsx:161-294`): ① 실행 번호 — run_id 축약 8자(`title`=전체값, 클릭=상세), ② 소요/경과 — 터미널 run은 소요 시간, 진행 중은 "N분 경과"(필드 존재는 §8-② 확인 후, 없으면 기준 시각만 유지하고 열 보류 — 날조 금지).
- **우선순위 컨트롤 통일**(`RunTrace.tsx:300-341` `RunPriorityControl`): queued/비-queued 모두 동일 폭 컨트롤 — 비-queued는 같은 자리에 동일 크기 칩(현행 유지), queued의 select+변경 버튼은 열 고정폭으로 정렬 흔들림 제거. 팝오버 통일은 P1(§9).
- 수용: `run-trace.test.tsx`·`run-identity.test.tsx` 갱신 — 동일 이름 run 2건이 실행 번호로 구분 렌더.

### 6.3 T7 스튜디오: 액션 2+⋯ · 계획 표시 교체 (E7 확장, E2 의존)

- **행 액션 축소**(`Scenarios.tsx:233-301`): 기본 [열기](현 "집중 작업" 개명) [실행] 2개 + ⋯ 드롭다운(테스트·편집·이력/배포/운영 기준/보관 — 현 `<details>` 관리 작업 흡수). 용어 단일화: "집중 작업/계획·테스트/테스트 작업대" → **"테스트" 1종**(라벨 재정의는 E7과 같은 PR 권장).
- **계획 표시 교체**: `ScenarioTestWorkbench`가 embed하는 `Plan`(원시 노드 나열, `Playground.tsx:48-94`)을 E2의 `StepCards`(사람 말 문장)로 교체, 원시 IR·노드 id는 [고급 보기] `<details>`로. R1(playground 뷰 은퇴)과 별개로 **컴포넌트 자체를 대체**해 관리 콘솔 잔존 표면(Scenarios/FocusedStudio embed)까지 해소.
- "테스트 가능 · v1" 배지 → "마지막 테스트: 성공 (v1)"류 결과 중심 문장(실 데이터 없으면 "테스트 전" — green 추정 금지).
- 수용: `scenario-studio-first-action.test.tsx`·`studio-product-surfaces.test.tsx` 갱신, `step-sentences` 교체 후 원시 노드 id가 기본 뷰에 부재(고급 토글 내에만).

### 6.4 T8 표면 하드닝 (독립 소품 모음)

| 항목 | 설계 | 지점 |
|---|---|---|
| 버튼 세로 랩 | `.btn { white-space: nowrap; }` + 좁은 컬럼은 아이콘/축약 라벨 | `styles.css`; 커넥터 "템플릿 보기", openGate "검증 근거 보기" |
| 사이드바 잘림 | nav 영역 `overflow-y:auto` + 하단 스크롤 그림자(fade) — 900px 높이에서 잘림 어포던스 제공. 그룹 접기는 P1 | `Layout.tsx` nav 컨테이너, `styles.css` |
| 가짜 탭 카드 | 섹션 전환 카드(2줄 랩) → 공용 `SectionTabs`(role=tablist, 한 줄 가로 스크롤) 신설 후 automationOps·Security 적용 (**R6 머지 후** — 같은 파일 접점) | `Orchestration.tsx:45` OPS_SECTIONS, `Security.tsx` 섹션 카드 |
| 도입 증빙 라벨 | label과 detail 사이 구분(" — " 또는 block 여백), `operational_gaps.join` 전 항목 끝 마침표 strip 후 " · " join(이중 문장부호 제거) | `AdoptionReadinessPanel.tsx:103-113, 276-294` |
| coePipeline 모순 | 후보 0건이면 절감액 타일 "—"+"후보 등록 후 산정" 문구. 접수 폼 프리필 값 → placeholder 전환(예시/실데이터 구분) | `CoePipeline.tsx` 요약 타일·접수 폼 |
| Workitems 무의미 열 | "작업 항목" 열은 원본 작업 요약(참조+상태 tooltip)으로 대체 또는 열 제거. raw `reason_code`는 title 툴팁 유지(정직 노출) 본문은 `dlqReasonLabel` | `Workitems.tsx:164` 주변 |
| 내 할 일 스트립 중복 표기 | E1 이관 시 행 제목=업무 요약, 부제=종류·상태로 역할 분리(제목≠부제 동일 문자열 금지) | E1 `Create.tsx` 확인 스트립 수용 기준 |

## 7. E/R 계열에 추가하는 수용 기준 (설계 재논의 아님)

| 슬라이스 | 추가 수용 기준 |
|---|---|
| E1 (만들기 홈) | 확인 스트립 행의 제목/부제 동일 문자열 금지(§6.4). 홈 첫 뷰포트(1440×900)에 "다른 도구"(녹화·테스트 도구 본체)가 나타나지 않음 — 입력·템플릿·내 자동화만 |
| E2 (StepCards) | 원시 노드 id·IREL 식이 기본 뷰에 부재(고급 토글 내에만) — T7 교체의 전제 |
| E6 (easy-labels) | "기본 AI 모델 사용 (gpt-4o-mini)" 모델명은 만들기 경로 기본 뷰에서 숨김(고급 접힘) — 감사 P1-5 부속 |
| R4 (myWork 은퇴) | 레거시 해시 `#myWork` 리다이렉트가 topbar 재설계(T1) 후에도 랜딩 h1 검증(e2e L504) 갱신과 함께 통과 |
| R6 (automationOps 축소) | T8 SectionTabs는 R6 머지 후 적용(파일 충돌 방지) |

## 8. 구현 시 검증 포인트 (설계가 확정하지 않은 사실)

1. **DEAD_LETTER 라벨 폴백 경로**: `statusLabel`(`badges.tsx:52-55`)이 대문자 키에서 raw를 반환하는지 실물 확인 후 정규화 위치 결정(조회 정규화 vs 지도 키 추가). 감사 스크린샷은 raw 노출을 실증하나 코드 경로는 미추적.
2. **run 소요 시간 필드**: `types-runs.ts`에 started/completed 시각이 있는지 — 없으면 T6 소요 열은 보류(계약 추가는 비범위, 날조 금지).
3. **Gateway 비용 한도 단위**: `ops-defaults.md`/`gateway_policies` DDL에서 단위 확정 후 T3 표기.
4. **production-readiness red의 벨 항목 문구**: `getProductionReadiness` 응답의 blocker 요약 필드로 "N건" 산출 가능한지 확인(불가면 "운영 전환 준비 확인 필요" 고정 문구).
5. **`navigate("automationOps",{section:"alerts"})` 딥링크**: automationOps가 section 해시 파라미터를 소비하는지 확인(R6 이후 기본 탭 schedule) — 미소비면 R6에서 함께 배선.

## 9. 슬라이스 순서·의존

| 슬라이스 | 내용 | 선행 | E/R과의 관계 |
|---|---|---|---|
| **T1** | 상단바 재설계(+viewer create 버튼, dev 위젯) | — | 독립 |
| **T2** | 알림 그룹핑 일원화·어포던스·값-상태 분리 | — | R5(adoption 분리)와 파일 다름 — 독립 |
| **T3** | 표기 규칙(시각·수량·단위·저장/편집 구분) | — | 독립 |
| **T4** | 용어 교정 6곳 + copy-gate CI | — | 독립 (E6 easy-labels와 층 분리) |
| **T5** | 사람 확인 결정 우선·0-타일·필터/액션 분리 | — | 독립 |
| **T6** | 실행 기록 식별 열·컨트롤 통일 | §8-② | 독립 |
| **T7** | 스튜디오 액션 2+⋯·Plan→StepCards 교체 | **E2** | E7과 같은 PR 권장 |
| **T8** | 표면 하드닝 모음 | SectionTabs만 R6 후 | 나머지 독립 |

권장 착수: **T1→T2→T3·T4(병행)→T5·T6(병행)→T8→(E2 머지 후)T7**. T1~T4가 감사 P0 전부와 P2 다수를 해소한다.

## 10. 열린 결정

| 결정 | 기본값 |
|---|---|
| 알림 벨 클릭 동작 | P0=알림 센터 딥링크. 드롭다운 미리보기 목록은 P1 |
| 일괄 승인 체크박스 선택 전환 | P1 — P0는 시각 분리(두 줄)+기존 확인 다이얼로그 유지 |
| 우선순위 팝오버 통일 | P1 — P0는 폭 고정 정렬만 |
| 사이드바 그룹 접기 | P1 — P0는 스크롤 어포던스만 |
| Freshness 초 단위(HH:MM:SS) 유지 | 유지(운영 신선도 신호) — 변경 없음 |
| 감사 스텝퍼 제안 vs 확정 원패스(단계 칩 삭제) | **확정 설계 유지** — 스텝퍼 재도입 없음 |

## 11. 검증 (전 슬라이스 공통)

```powershell
npm --prefix web run typecheck
npm --prefix web test
npm --prefix web run build
npm --prefix web run lint:copy   # T4 이후
```

- e2e: `app/test/console-browser.e2e.ts`에 1280×800 뷰포트 topbar 검증 추가(T1). 기존 viewer nav 기대값·랜딩 h1 검증은 T1/R4에서 갱신.
- 수동 QA: 1280×800 / 1440×900 / 1920×950에서 topbar·사이드바·버튼 랩 확인(감사와 동일 방법 — dev:serve + 스크린샷 드라이버 재사용 가능).
- 파일 길이 CI 게이트(500줄) 준수 — Layout/TopbarActions가 커지면 `layout/` sibling 분해.

## 12. 최종 설계 입장

감사의 결론은 "구조는 견고한데 표면과 동선이 신뢰를 깎는다"였다. 제작 경험은 이미 확정된 E/R 재설계가 맡는다. T계열의 축은 두 가지다: **(1) 상시 노출 표면(상단바·알림)을 행동 중심으로 재편**해 매 화면의 첫인상을 고치고, **(2) 라벨·표기를 시스템(단일 그룹핑 파이프라인·용어 게이트)으로 강제**해 같은 결함이 재발하지 않게 한다. 개별 문구 수정은 게이트 없이는 반드시 되돌아온다 — 이 레포가 파일 길이 게이트로 구조 재발을 막았듯, 용어 게이트로 언어 재발을 막는다.
