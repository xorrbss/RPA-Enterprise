# RPA Console Usability Hardening Design

Date: 2026-07-02
Status: design draft for implementation
Scope: 두-페르소나 감사(정적 51건 + 라이브 6건, 전건 검증 생존)의 구조적 해소 — 콘솔 UX, read 투영, 온보딩 부트스트랩, 알림 발화, 배포 패키징
Out of scope: 시나리오 실행 엔진·상태머신·보안 경계 변경(감사에서 견고 판정), 모바일

## 1. Why This Exists

두-페르소나 감사(`audit/rpa-two-persona-audit-2026-07-02/notes.md`)의 결론:

- **도입 담당자 73 / 실사용자 72** — "핵심 흐름은 완주 가능하나 안내자가 필요한 순간이 남음".
- 콘솔 '안'은 성숙하다. Phase 6(A0~A4)·Phase 15·통합 업무 UX가 실화면에서 작동함을 실측 확인.
- 끊긴 곳은 여정의 **양끝**이다.
  - 도입 쪽: 콘솔 배포 수단·첫 관리자 토큰·세션 등록 경로 — 제품 바깥 절벽.
  - 사용자 쪽: 실패한 실행을 "찾고, 읽고, 다시 돌리는" 입구 — 실행 익명성·원시 표기·수동 알림.
- 라이브 감사가 추가로 발굴한 크리티컬: **비보안 컨텍스트(사내망 HTTP) 크래시(L1)** — 검토 패널과 모든 쓰기 명령이 `crypto.randomUUID`에 의존.

이 설계는 위 감사의 실행 가능 항목 전부를 12개 슬라이스(S0~S12)와 보류 레지스터(D)로 조직한다. 감사 ID ↔ 슬라이스 매핑은 §4의 커버리지 표가 단일 원천이다.

## 2. References

- `audit/rpa-two-persona-audit-2026-07-02/notes.md` — 본 설계의 근거(발견 레지스터 전문)
- `docs/rpa-console-adoption-onboarding-design-2026-07-01.md` — 선행 설계(A0~A4, Slice B 정의)
- `docs/staging-deploy-runbook.md` — S3·S7이 보강할 배포 runbook
- `ts/error-catalog.ts`, `ts/rbac-policy` — S9·S8이 미러할 계약 원천
- `web/src/navPolicy.ts`, `web/src/components/badges.tsx`, `web/src/views/orchestration/format.ts` — 확장 대상 기존 구조

## 3. 설계 원칙

1. **기존 구조 확장 우선** — 새 화면·새 레이어 금지. 기존 컴포넌트/투영/워커 틱을 확장한다.
2. **날조 금지 유지** — 없는 값은 그리지 않는다. 미확인은 `확인 필요`/`보류`, 성공으로 승격 금지.
3. **계약 정합** — read 투영 필드·쿼리 파라미터 추가는 additive로 허용하되 api-surface/openapi 재생성 대상으로 명시. **S0~S12 전 슬라이스가 DDL·상태머신·스키마 계약 무변경**이다(S4a 를 env 라우팅으로 설계한 이유). DDL 이 필요한 항목(라우팅 테이블·시험/운영 구분)은 전부 D 레지스터의 오너 결정 뒤로 보냈다.
4. **원자적 슬라이스** — 슬라이스 = 1~2 PR. 각 슬라이스는 독립 머지 가능해야 하고 수용 기준·테스트를 갖는다.
5. **한국어 운영자 레지스터** — 신규/수정 문구는 비기술 한국어. 계약 식별자(enum 원문 등)는 값 유지 + 표시 라벨만 매핑.

## 4. 슬라이스 개요와 커버리지

### Tier 순서 (구현 권고 순)

| Tier | 슬라이스 | 한 줄 목표 | 규모 |
| --- | --- | --- | --- |
| 0 즉시 | S0 안정성·표기 위생 | 크래시 제거 + 화면 위생 5건 | S |
| 1 P1 해소 | S1 실행 식별성 | "어떤 자동화의 실행인가"를 모든 실행 표면에 | M |
| 1 P1 해소 | S2 관리자 토큰 부트스트랩 | 소스코드 없이 첫 접속 가능 | S |
| 1 P1 해소 | S4a 무인 알림 발화(백엔드) + S4c 알림·예약 웹 위생 | 콘솔을 안 열어도 장애가 통지됨 | M |
| 2 일상 신뢰 | S3 시간 표기 통일 | 원시 ISO 제거·마감 상대표기 | S |
| 2 일상 신뢰 | S5 미배정 업무 가시성 | 신규 업무가 랜딩에서 보임 | S |
| 3 도입 여정 | S6 세션 등록 정직화 | dead-path 제거·Windows 명령·순서 안내 | S~M |
| 3 도입 여정 | S7 콘솔 배포 패키징 | web 서빙이 배포 산출물에 포함 | M |
| 3 도입 여정 | S8 증빙·감사·최소권한 | 심사자가 콘솔만으로 증빙을 뽑음 | M |
| 4 품질 마감 | S9 언어 일괄 | 운영자·심사자 가시 영어 잔존 소거 | M |
| 4 품질 마감 | S10 만들기 흐름 정리 | 첫 자동화 이탈 지점 제거 | M |
| 4 품질 마감 | S11 트레이스 심화 | 긴 실행·AI 판단·세션 만료 경고 | M |
| 4 품질 마감 | S12 설계갭 마감 | A-슬라이스 잔여 수용 기준 충족 | S |
| — | D 보류 | 계약 변경·대형·오너 결정 | — |

### 감사 ID → 슬라이스 커버리지 (전건)

| 슬라이스 | 해소하는 감사 ID |
| --- | --- |
| S0 | `L1-insecure-context-crash`, `L2-sidebar-not-sticky`, `L5-schedule-table-vertical-header`, `errorstate-english-details-summary`, CSV BOM(비평관) |
| S1 | `run-list-no-scenario-identity`(양 차원), `L3-runtrace-identity-placeholder`, `rerun-not-in-detail-panel`, `edited-rerun-raw-json` |
| S2 | `first-admin-token-bootstrap` |
| S3 | `raw-iso-timestamp-exposure`, `raw-utc-timestamps`, `datetime-formatter-fragmentation` |
| S4a | `alerts-console-pull-only`, `session-expiry-not-in-ops-alerts`, `session-expiry-proactive-gap` |
| S4c | `L4-alert-center-noise`, `trigger-weekday-cadence-gap`, `ops-queue-count-truncation`, `automationops-deeplink-section-inference-missing` |
| S5 | `mywork-unassigned-task-blindspot`, `dashboard-humantask-population-mismatch`, `landing-no-adoption-entry` |
| S6 | `session-capture-prod-dead-path`, `capture-guide-windows-and-repo-burden`, `session-capture-cli-cliff`(단기분), `corridor-session-next-step-missing`, `site-form-selector-placeholder-mislead` |
| S7 | `console-deploy-packaging-missing` (+ L1의 배포 측 완화: HTTPS 명시) |
| S8 | `evidence-packet-missing`, `audit-export-period-limit`, `reviewer-least-privilege-nav`, `session-encryption-evidence-gap`, `ai-data-egress-evidence-gap` |
| S9 | `runtime-error-codes-untranslated`, `dashboard-report-english`, `operator-visible-english-forms`, `palette-raw-enum-hints`, `kind-label-divergence`, `admin-governance-panels-english`, `ai-governance-english-only`, `access-section-admin-jargon` |
| S10 | `three-create-entries`, `L6-studio-governance-first`, `list-row-governance-density`, `generator-no-session-precheck`, `generator-prereq-link-missing`, `wizard-deadend-warning`, `sitecreate-selector-jargon`, `recorder-promise-gap`(문구분), '봇으로 굳히기' 라벨(라이브) |
| S11 | 트레이스 100단계 절단(비평관), `ai-judgment-content-not-exposed`, `runtrace-artifact-lookup-first`, JWT exp 경고·입력 소실(비평관) |
| S12 | `page-level-error-summary-dashboard-only`, `readiness-panel-placement-always-on`, `security-section-nav-test-coverage-gap` |
| D | 시험/운영 run 구분(비평관), 오프보딩 반출(비평관), helper 단일 실행파일(`session-capture-cli-cliff` 근본), `roi-actuals-manual-monthly` |

## 5. 슬라이스 상세

### S0. 안정성·표기 위생 (Tier 0)

목표: 배포 형태와 무관하게 콘솔이 죽지 않고, 첫눈에 깨져 보이는 표기를 제거한다.

설계:

1. **crypto.randomUUID 진입 폴리필** — `web/src/crypto-polyfill.ts`(신규 leaf, `main.tsx` 최상단 side-effect import): `crypto.randomUUID` 미존재 시 `crypto.getRandomValues` 기반 UUIDv4 를 설치(비보안 컨텍스트에서도 동작). 호출부 ~50개소 무변경으로 현재·미래 호출을 모두 커버한다(치환+lint 가드 방식 대비 KISS — 표준 폴리필 패턴). 제약: 다른 모듈 평가 전에 import 되어야 한다 — 폴백 동작은 단위 테스트로 잠그고, import 순서는 main.tsx 주석 + 실환경(비보안 컨텍스트) 라이브 스모크로 확인(모듈 최상위에서 randomUUID 를 호출하는 코드는 현재 없음을 grep 으로 확인).
2. **사이드바 고정** — `.sidebar`에 `position: sticky; top: 0; max-height: 100vh; overflow-y: auto;` (`web/src/styles.css:40`). 상단바 sticky(:48)와 동작 일치.
3. **예약 테이블 헤더** — 등록된 예약 표 `th`에 `white-space: nowrap`(전역 th 규칙 검토 후 최소 범위 적용). 세로 꺾임 제거.
4. **CSV BOM** — 서버(`app/src/api/audit-log.ts`, `automation-performance-report.ts`)와 클라이언트 Blob 저장(`Dashboard.tsx`, `AuditExplorer.tsx`) 모두 `﻿` prefix. Windows Excel 한글 보존.
5. **오류 상세 토글 라벨** — 'admin/support details' → '담당자 전달용 기술 정보' (`web/src/components/states.tsx`).

수용 기준:

- `crypto.randomUUID` 부재 환경에서 폴리필이 UUIDv4 를 설치하고, 네이티브 존재 시 교체하지 않는다(테스트로 잠금).
- 내보낸 CSV가 BOM으로 시작한다(서버·클라이언트 각 1건 테스트).
- 긴 페이지 스크롤 시 좌측 메뉴가 시야에 유지된다(수동 확인 + CSS 단언).

테스트: `web/test/idempotency-key.test.ts`(신규, insecure-context 시뮬레이션), 기존 human-task 테스트에 panel-open 회귀, export BOM 단언.
계약 영향: 없음.

### S1. 실행 식별성 (Tier 1, P1)

목표: 모든 실행 표면(목록·상세·대시보드·내 할 일)에서 "어떤 자동화의 실행인지"가 즉시 읽히고, 원인 확인 자리에서 재실행까지 이어진다.

설계:

1. **read 투영 확장** — `app/src/api/reads-runs.ts` run 목록·상세 투영에 `scenario_versions → scenarios` JOIN으로 `scenario_name`(표시용)·`scenario_id` 추가(additive). 목록 서버 필터는 **`scenario_id`(JOIN 기반, 전 버전 관통) 필수 추가** — MyWork 딥링크는 자동화 단위라 기존 `scenario_version_id` 필터(reads-runs.ts:125-133)만으로는 버전 승격 때마다 기록이 단절된다. 기존 필터는 유지.
2. **실행 목록** — `RunTrace.tsx`의 고정 문구 셀("추적 번호 확인 가능")을 **자동화 이름**으로 교체. 원시 추적 번호는 기존 미노출 정책(운영자 표면에 기술 식별자 금지 — dashboard.test 의 jargon 가드가 잠금)대로 툴팁 전용을 유지하고, 같은 자동화의 실행끼리는 기준 시각 열(S3)로 구분한다. 상단에 자동화 FilterSelect 추가.
3. **딥링크 시드** — MyWork '실행 기록 보기'가 해당 자동화 필터 파라미터를 실어 이동(대시보드 status 시드와 동일 패턴). 대시보드 '최근 실행' 표에 이름 표기. Top5는 행 유형별 식별을 병기(run 행=자동화 이름, 사람 확인 행=접수번호·종류 — human_tasks 는 run JOIN 경유로만 자동화 이름에 닿으므로 무리하게 합성하지 않는다).
4. **상세 패널** — `RunDetailPanel`에 자동화 이름 표시 + 터미널 실패 상태에 재실행 2종(같은 입력/수정 입력, 기존 `rerunRun`·ActionButton 재사용). '수정 입력 재실행'은 **실행 원본 params(run 상세에 additive 투영) 기반 필드 폼**으로 프리필한다 — params_schema 폼 재사용안은 run이 옛 버전일 때 최신 스키마와 어긋날 수 있어(버전 불일치) 원본값-기반이 진실원천에 정합. 스칼라 값만 필드로, 구조형 값은 원문 참고(details)로 두고 구조형 편집은 목록 행의 JSON 경로(전문가용)에 남긴다.

수용 기준:

- 실행 목록·상세·대시보드 최근 실행에서 자동화 이름이 보인다. 고정 문구 셀이 없다.
- MyWork에서 특정 자동화의 '실행 기록 보기' → 그 자동화만 필터된 목록에 착지.
- 실패 실행 상세 패널 안에서 재실행이 완료된다(목록 복귀 불필요). 수정 입력은 필드 폼이 기본이다.

테스트: web(목록 컬럼·필터·딥링크 시드·패널 재실행), app int(투영 JOIN·필터).
계약 영향: read 응답 필드 additive — api-surface/openapi 재생성 명시.

### S2. 관리자 토큰 부트스트랩 (Tier 1, P1)

목표: IdP 연동 전 파일럿에서 소스코드를 읽지 않고 첫 관리자 접속 코드를 발급한다.

설계:

1. `scripts/mint-operator-token.mjs`(신규, 의존성 없는 node:crypto HS256 — jose 불필요): `--tenant <uuid> --roles admin[,operator…] --sub <id> [--expires 12h]`. `JWT_HS256_SECRET` env 필수, 없으면 fail-closed 종료. 클레임은 `app/src/api/auth.ts` 요구사항(sub/tenant_id UUID/roles/exp)과 정합.
2. `docs/staging-deploy-runbook.md`에 "최초 접속" 절: 발급 명령, 클레임 표, 만료·재발급, RS256/JWKS 전환 시점 안내.
3. `TokenGate.tsx` 안내문에 1줄 추가: "파일럿 초기 설정은 배포 runbook의 토큰 발급 절차를 참고하세요."

수용 기준: secret 미설정 시 즉시 실패(비밀 미출력) · 발급 토큰이 인증 경계를 통과(int 테스트가 스크립트 산출 토큰으로 /v1 read 200 확인) · runbook에 절차 존재.
테스트: `app/test/mint-token-boundary.int.ts`(신규, 스크립트 spawn → 토큰 검증).
계약 영향: 없음(운영 도구).

### S3. 시간 표기 통일 (Tier 2)

목표: 원시 UTC ISO 노출 0건, 제품 전체 단일 포맷, 마감은 임박성이 읽히게.

설계: `web/src/views/orchestration/format.ts`의 `formatDateTime`을 `web/src/util/time.ts`로 승격(단일 출처, ko-KR 로컬 시각). 적용: 사람 확인 마감(목록·검토 패널)·Top5 마감·실행 목록 기준 시각·운영 헬스 타임스탬프·`WorkerPoolPanel` dateShort(UTC 오표시 제거)·StepTrace 원문 details에 시작/종료 시각. 마감 칸은 상대표기 병기('오늘 18:00 · 3시간 남음', 지남은 red '2일 지남') — HumanTasks가 이미 계산하는 dueTime 재사용.

수용 기준: `web/src`에서 사용자-가시 표면의 raw `toISOString`/ISO 원문 렌더 0건(도구성 원문 details 제외) · 지난 마감이 강조된다.
테스트: 포매터 단위 + 화면별 표기 단언(기존 테스트 확장).
계약 영향: 없음.

### S4. 무인 알림 발화 + 예약 운영 개선 (Tier 1, P1) — S4a 백엔드 / S4c 웹으로 분리

목표: 콘솔을 열지 않아도 critical 운영 신호가 외부로 나가고, 예약 운영의 일상 마찰을 제거한다.

#### S4a. 발화 파이프라인 (백엔드, **계약 무변경**) — ✅ 구현됨

1. **라우팅 = env 우선(YAGNI)** — 신규 DDL 대신 `OPS_ALERT_ROUTES` env(JSON 배열: `{source?, min_severity, provider_alias, endpoint_secret_ref, allowed_hosts, route_policy_ref, recipient_group_ref?, callback_signature_secret_ref?}`)로 구현. 파서=`app/src/api/ops-alert-routes.ts`(leaf, fail-closed 검증). 미설정=발화 없음. 테넌트별 저장형 규칙(테이블+관리 UI)은 D 레지스터(S4b).
2. **알림 계산 공유화** — `readComputedOpsAlerts`(+`ComputedOpsAlert`·`OpsAlertSource`·`OpsAlertSeverity`·`insertOpsNotificationAttempt`·`OpsNotificationWebhookSendInput`)를 `ops-alerts.ts`에서 export. 워커 producer(`app/src/worker/ops-notification-fire.ts`)가 재사용 — 중복 구현 0. (ops-alerts.ts 가 이미 1400줄이라 함수 추출 대신 export 최소화 채택.)
3. **발화 틱과 테넌트 게이트** — maintenance poll(`runMaintenancePoll`)에서 **resolveMaintenanceTenantIds 로 해소된 테넌트**(스위퍼와 동일 집합)로 `runOpsNotificationFire` 호출. 라우트 설정+대상 테넌트 없음 → **poll 마다 반복 않고 1회만 loud 경고**(`warnedOpsFireDormant` 플래그). 휴면 함정 방어.
4. **중복 발화 방지 = 세대 멱등(계약 무변경 채택)** — verify-before-build 로 확인: `ops_notification_attempts` 에 멱등 유니크 인덱스 **없음**(deliveries 에만 있음). 기존 ack 시스템이 `(alert_id, detected_at)` 세대 키를 쓰는 것(ops-alerts.ts:1188)과 정합하게, **SELECT-guard**(tenant+alert_id+detected_at+provider, non-deleted)로 같은 세대 재발화를 차단. detected_at 이 행 타임스탬프라 반복 틱에 안정 → 폭주 방지. 유니크 인덱스+ON CONFLICT 로 airtight 하게 만드는 것은 **DDL 이라 D 레지스터(S4b)**; 기본 GRAPHILE_CONCURRENCY=1 직렬 poll 에서 SELECT-guard 로 충분(int 테스트가 2틱 멱등 증명). 자동 발화 대상은 detected_at 안정 소스(run_sla/human_task_sla/trigger_fire/failure_spike)로 제한(`OPS_ALERT_AUTO_FIRE_SOURCES`).
5. **session_expiry 알림 소스** — 신규 `source='session_expiry'` 는 `ops_notification_attempts/deliveries` 의 CHECK 제약을 바꿔야 해(DDL) S4a(계약 무변경)에서 제외 → **D 레지스터**. 세션 만료 임박의 **콘솔 서피싱**(오늘 필요한 조치·대시보드)은 읽기 경로라 S4c/S5 계열에서 별도 처리(알림-attempt 테이블 불경유).

#### S4c. 알림·예약 웹 위생 (web-only, S4a 와 병렬 가능)

6. **알림 센터 위생** — 동일 (type,source) 그룹핑("장시간 실행 위험 외 11건") + 문장 내 raw enum을 statusLabel로 교정("'대기' 상태가 23,998분…") + 알림 행에 대상 실행 식별 표기(자동화 이름은 S1 투영 머지 후 — S1 선행 의존, 그 전에는 추적번호 축약).
7. **예약 폼** — 주기에 요일 select(+'평일') 추가, `cronFrom` 요일 인자 확장(표시 계층 humanCronSummary는 이미 지원). 큐 패널 카운트는 Dashboard의 pageCount('N+') 헬퍼 재사용. `#automationOps?scenario=…`/`?trigger=…` 딥링크는 `resolveSecuritySection` 패턴으로 schedule 섹션 추론.

수용 기준(S4a ✅): 라우트 설정 + 정체 run → 콘솔 미접속 상태에서 pending attempt 생성 + 발송 잡 인큐(delivery consumer 가 재시도·dead_letter 승계) · 동일 세대 재발화 없음(멱등, 반복 틱) · min_severity 게이트 · 라우트 있는데 테넌트 없음 → loud 경고(휴면 방지). 남은 S4c(web): 그룹핑·요일 폼·딥링크.
테스트: `ops-notification-fire.int.ts`(정체 run→발화·멱등·severity·no-op·휴면 14체크, 실 PG), `ops-alert-routes.unit.ts`(파서 fail-closed 13체크). 둘 다 CI 배선(test:int/test:unit).
계약 영향: **없음**(env `OPS_ALERT_ROUTES` + read/insert export). 유니크 인덱스·session_expiry source·테이블/관리 UI 는 DDL → D 레지스터(S4b).

### S5. 미배정 업무 가시성 (Tier 2)

목표: @human_task가 만드는 신규 업무(항상 미배정 시작)가 운영자 랜딩에서 보이고, 숫자와 목록이 일치한다.

설계:

1. **MyWork 큐 합집합** — '내게 배정 + 미배정(open/escalated)'. 서버 read(`reads-people.ts:117`)는 `assignee = $4` 단일 매칭만 지원해 합집합을 표현할 수 없고, 클라이언트 필터(무필터 조회 후 거르기)는 **페이지(50건) 너머의 내 업무/미배정을 조용히 누락**하므로 기각한다. `unassigned=true` 필터 파라미터를 additive 로 추가하고, MyWork 는 `assignee=me` + `unassigned=true` 2쿼리 합집합으로 구성(페이지네이션 정확성 유지). 미배정 행은 '내 담당으로 지정' 인라인 제공(기존 버튼 재사용).
2. **거짓 안심 문구 교정** — "자동화가 알아서 처리하고 있습니다"는 미배정 존재 여부를 관찰한 뒤에만. 자동화 0개 테넌트는 '아직 만든 자동화가 없습니다' + 준비 상태 배너(dashboard CTA, OnboardingBanner 패턴).
3. **사람 확인 기본 목록** — 미배정 포함(또는 최소 '미배정 N건' 상시 배지 + 원클릭 필터).
4. **대시보드 정합** — human 카운트·Top5에 HumanTasks와 동일 TERMINAL 필터(공유 상수로 추출), 카드 드릴다운은 카운트 모집단과 같은 필터를 해시 파라미터로 시드(기존 '실행 중' 카드 status 시드 패턴).

수용 기준: 미배정 신규 업무 생성 → 랜딩 큐에 즉시 보임(51번째 업무여도 누락 없음) · 대시보드 카운트 = 클릭 후 목록 건수 · 종결 업무가 Top5에 없음.
테스트: web(합집합·문구 조건·카운트/목록 정합), app int(unassigned 필터), 기존 my-work/human-tasks 테스트 확장.
계약 영향: read 쿼리 파라미터 additive(api-surface 반영).

### S6. 세션 등록 경로 정직화 (Tier 3)

목표: 운영 배포에서 '세션 등록' 버튼이 거짓 약속을 하지 않고, Windows 운영자가 안내대로 완주할 수 있다.

설계:

1. **capabilities 노출** — 서버가 캡처 소비자 유무를 안다: env `SESSION_CAPTURE_SERVER_MODE`(dev=capture-loop 있음 / off=없음, prod 기본 off·fail-closed)를 read 투영(capabilities readout)에 포함. off면 web은 서버측 '세션 등록' 버튼을 숨기고 '운영자 PC 등록'을 주 버튼으로 승격, confirmText의 "로그인 창을 엽니다" 약속 제거.
2. **launching 행 만료** — 조회 시 lazy expiry: launching이 10분 이상 미소비면 '만료 — 이 환경에서는 운영자 PC 등록을 사용하세요'로 표시(상태 문구 계층; DB 전이는 기존 expired 재사용 검토).
3. **CaptureGuide 보강** — PowerShell 명령 병기(`$env:RPA_OPERATOR_TOKEN="…"; npm --prefix app run session:capture-helper -- …`) + 사전 준비 1줄(저장소 체크아웃·Node 설치) + "IT 담당자에게 이 명령을 전달하세요" + 완료 기대 문구("등록 후 이 사이트는 '세션 등록됨'으로 표시됩니다").
4. **코리도 마이크로카피** — SiteCreateForm 성공 시 loginUrl 있으면 '다음: 로그인 세션 등록' 안내 + `#security?section=sites&site=<id>` 딥링크.
5. **사이트 폼 선택자 필드** — 라벨/도움말에 형식 명시('화면 요소 선택자, 예: `.user-menu` — 개발자도구에서 복사'), placeholder를 실제 CSS 예시로, 한글·공백만인 값은 경고(차단 아님).

수용 기준: capture 소비자 없는 배포에서 dead-path 버튼이 노출되지 않는다 · Windows PowerShell에 안내 명령을 그대로 붙여 실행 가능 · 사이트 생성 직후 다음 단계(세션 등록)가 보인다.
테스트: web(모드별 버튼 노출·문구), app int(capabilities 투영·lazy expiry).
계약 영향: capabilities read 필드 additive.

### S7. 콘솔 배포 패키징 (Tier 3)

목표: 직원이 접속할 콘솔이 배포 산출물에 포함되고, runbook만으로 세워진다.

설계:

1. Dockerfile에 web 빌드 스테이지(`npm --prefix web ci && run build`) 추가. 서빙은 **nginx 스테이지**(dist 정적 + 리버스프록시, same-origin — `app/src/api/security.ts` 주석의 권장안 채택. Fastify 정적 서빙 대안은 기각: API 프로세스에 UI 수명 결합·CSP/캐시 헤더 소관 분리). 프록시 규칙은 dev serve 와 **동일 규칙을 미러**한다: 클라이언트 baseUrl 기본 `/api` + `/api/*` 요청의 프리픽스 스트립 → upstream `/v1/*`(`app/dev/serve.ts:281-282` — "`/v1` 프록시"가 아니라 `/api` 스트립임에 주의).
2. compose.yaml에 `web` 서비스(nginx, api 의존) · k8s base/overlay·helm에 콘솔 Deployment/Service 추가.
3. runbook '콘솔 배포' 절: VITE_* 빌드 인자 표(`VITE_API_BASE_URL`, `VITE_OIDC_AUTH_URL`), 프록시 구성, **HTTPS(secure context) 강권 명시** — S0 폴백으로 HTTP에서도 동작하나 세션 보안상 HTTPS 기준.

수용 기준: `docker compose up`만으로 브라우저 접속·로그인 화면 도달 · runbook 절차에 콘솔 항목 존재 · k8s/helm 매니페스트 lint 통과.
테스트: compose 스모크(CI 게이트 검토), 매니페스트 정적 검증.
계약 영향: 없음(배포층).

### S8. 증빙 패킷·감사 export·최소권한 (Tier 3)

목표: 보안 심사자가 콘솔만으로 증빙을 조립·제출한다.

설계:

1. **증빙 패킷 카드**(선행 설계 Slice B) — `web/src/components/AdoptionEvidencePacket.tsx`(신규): Dashboard가 이미 보유한 authReadiness/productionReadiness/sites/runs 쿼리를 합성해 상태 요약 + 권위 화면 딥링크. RLS·redaction은 계약 근거 문구 + artifact redaction_status 집계로 `확인 필요`/`보류` 정직 표기. 원문 시크릿·감사 payload 미렌더.
2. **감사 기간 export** — `app/src/api/audit-log.ts` keyset 쿼리에 `occurred_at` from/to 파라미터(additive), UI 기간 2필드 + '기간 전체 내보내기'(기존 cursor 체이닝으로 200건 한도 해소).
3. **최소권한 nav** — `navPolicy.ts`: auditExplorer standardRoles에 viewer 추가(백엔드 `audit.read`와 정합). 관리 액션은 기존 can() 게이트가 이미 차단.
4. **세션 암호화 증빙** — sites read 투영에 `enc_kid` 추가 → 보안 허브 사이트 섹션에 '세션 저장 암호화: KMS 봉투암호화(kid…) / 평문(dev)' 배지(평문 red).
5. **AI 유출 답변** — 게이트웨이 정책 readout에 계약 고정 사실 명시("전송 전 마스킹(§4)·비밀값은 LLM 미경유(CDP 주입)") — 실행 단위 redaction 표기는 S11의 AI 판단 노출과 함께.

수용 기준: viewer 계정이 감사 이력을 메뉴로 발견·열람(쓰기 불가) · 기간 지정 전체 CSV가 200건 이상을 이어받는다 · 패킷 카드가 원문 민감값 없이 상태만 요약 · dev 평문 세션이 red로 구분된다.
테스트: web(패킷·기간 UI·viewer nav), app int(기간 필터·enc_kid 투영).
계약 영향: audit-log 쿼리 파라미터·sites read 필드 additive.

### S9. 언어 일괄 (Tier 4)

목표: 운영자·심사자 가시 표면의 영어 잔존(전수 113건/17파일 스캔 기준)을 기존 라벨-사전 패턴으로 소거한다.

설계(전부 `badges.tsx` 선례 — 닫힌 enum → 한국어 사전 + raw 폴백):

1. **런타임 에러코드** — ERROR_LABELS에 executor/LLM 계열 ~26종의 계약 `userMessage` 미러 + 실패 배너/단계 예외에 `operatorAction`을 '조치 안내' 서브텍스트로 배선. error-label 드리프트 가드 테스트의 SURFACE 목록 확장.
2. **월간 성과 패널** — Expand/Hold/Watch→확대/유지/관망, 'No actuals'→'실적 없음', ROI source/stage mix·차트 제목·표 헤더(Cost/run·Delta) 번역.
3. **AI 거버넌스 2패널** — 배지·표 헤더·검증 오류 안내 전면 번역(데이터 값 원문은 details 유지).
4. **운영자 가시 폼** — 작업 목록 'DEAD LETTER' 배지, 외부 연계·문서 제공자 폼, 릴리스 단계(GovernanceStageButton) 라벨.
5. **SCIM·CoE·커넥터** — 관리자 폼 라벨 사전 번역(provider_key 등 계약 식별자는 코드 표기 유지 + 1줄 설명).
6. **팔레트·kind 단일화** — 팔레트 힌트를 statusLabel/kindLabel로 감싸기, MyWork 로컬 kindLabel 제거 → badges 단일 출처.

수용 기준: 운영자 standard nav에서 도달 가능한 화면의 영어 UI 문자열 0건(계약 식별자 코드 표기 제외) · 같은 enum의 표기가 전 진입 경로에서 동일.
테스트: 기존 라벨 드리프트 가드 확장 + 화면별 단언.
계약 영향: 없음(표시 계층).

### S10. 만들기 흐름 정리 (Tier 4)

목표: 비개발자의 첫 자동화 여정에서 확인된 이탈 지점을 제거한다.

설계:

1. **진입점 단일화** — '+ 새 자동화 만들기'를 제작 시작 스트립의 3번째 보조 액션('양식으로 직접 만들기')으로 흡수 또는 details 강등. `scenario-studio-first-action.test.tsx`에 단언 추가.
2. **거버넌스 패널 강등** — '승격 승인 대기'가 비어 있으면 렌더 생략(대기 건 있을 때만 상단 노출), 제작 시작 스트립을 첫 요소로.
3. **행 액션 계층화** — 목록 행을 '실행·미리보기·편집' 1군 + 나머지(이력·릴리스·승격·보관) ⋯ 메뉴/details 2군으로. '식별값' UUID 컬럼은 이름 셀 툴팁/details로 강등.
4. **생성기 세션 사전 점검** — RunScenarioButton의 siteReadiness 판정 재사용: target-summary '세션 등록 필요'를 배지+딥링크 버튼으로 승격, save_and_run 제출 시 세션 미등록이면 경고 선표시. 사이트/세션 미비 오류에 `#security?section=sites` 이동 버튼(문자열 dead-end 제거).
5. **마법사·폼 문구** — 마무리 경고에 '사이트 설정으로 이동' 링크 + "저장 후 [실행]의 실행 전 준비 점검에서 확인" 문구. 인라인 사이트 폼은 이름·주소·위험도만 기본 노출(선택자/JSON은 details), '리뷰 목록 확인 조건'→범용 라벨. 녹화 패널 소개 문구를 실제 동작(도우미 실행/수동 기록)에 정합 + JWT placeholder 한국어화·토큰 위치 링크.
6. **라벨** — '이 실행을 봇으로 굳히기' → '검증된 동작으로 초안 만들기'(또는 동급의 서술적 한국어).

수용 기준: 첫 화면 첫 요소가 제작 시작 스트립 · 유사 진입점이 시각적으로 1주 2보조로 구분 · 로그인 사이트 선택 시 실행 전에 세션 안내가 보인다 · 행 기본 노출 버튼 ≤3.
테스트: scenario-studio-first-action·goal-ux 확장, 생성기 사전 점검 단언.
계약 영향: 없음.

### S11. 트레이스 심화 (Tier 4)

목표: 긴 실행·AI 판단·세션 만료의 관찰 사각을 닫는다.

설계:

1. **단계 트레이스 커서** — `StepTrace.tsx`의 `listRunSteps({limit:100})` 고정을 '더 보기'(커서 체이닝)로 확장 — 100단계 초과 루프 실행의 실패 지점 도달 보장. RunDetailPanel의 세션 만료 힌트도 최신 페이지 기준으로 재계산.
2. **AI 판단 내용 노출** — stagehand_calls의 `parsed_json`에서 method/selector/instruction 요약을 **서버에서 추출·마스킹 후** StagehandCallSummary에 additive 투영 → StepTrace 'AI 판단 상세'에 "결정한 동작: click `#approve-btn`" 1줄. fill 값 등 민감값은 SecretRef 규율대로 미노출.
3. **증빙 조회 강등** — ArtifactLookup을 접힌 details로 내리고 목록을 첫 시야로; 해시에 artifact 파라미터가 오면 자동 펼침(기존 consumeHashParam 재사용).
4. **접속 만료 보호** — 토큰 exp 디코드(`permissions.ts` 확장) → 만료 N분 전 상단 경고 배지; 401 게이트 전환 시 작성 중 폼(반려 사유·IR 편집·재실행 입력)의 임시 보존(세션 스코프) 또는 최소한 전환 전 확인 1회.

수용 기준: 150단계 실행의 120번째 실패 단계에 도달 가능 · AI가 결정한 동작이 메타가 아닌 내용으로 보인다(민감값 제외) · 실행 기록 첫 시야가 목록이다 · 만료 직전 경고가 뜬다.
테스트: web(커서 페이징·details 기본 접힘·exp 경고), app int(판단 요약 투영 redaction).
계약 영향: StagehandCallSummary read 필드 additive.

### S12. 설계갭 마감 (Tier 4)

목표: 선행 설계(A0~A4) 수용 기준의 잔여 미충족을 닫는다.

설계: ① `DashboardEnvironmentState`를 얇은 공용 컴포넌트로 추출해 Workitems/HumanTasks/RunTrace 상단 재사용, 페이지 요약과 동일 원인(kind)의 패널 오류는 1줄 축약+재시도로 강등. ② 준비도 패널 9/9 ready 시 1줄 요약 배지로 접기(`readyCount === gates.length` 분기). ③ `security-section-nav.test.tsx`에 기본 섹션의 전체 패널 미렌더 부정 단언·섹션 클릭→hash 갱신·키보드 접근 단언 추가.

수용 기준: 백엔드 다운 시 화면당 오류 설명 1회 · 셋업 완료 테넌트의 대시보드 최상단이 작업대 · A0 수용 기준이 CI로 잠김.
계약 영향: 없음.

## 6. D. 보류 레지스터 (오너 결정·계약 변경·대형)

| 항목 | 성격 | 보류 사유 / 필요 결정 |
| --- | --- | --- |
| 시험/운영 실행 구분 | **✅ 해소**(runs DDL additive 컬럼) | 환경 컬럼 `runs.run_mode`(`prod` 기본, `test` 명시)을 채택. run 생성/list/detail/rerun/성과 리포트/export/OpenAPI/control-plane/web 타입·필터를 관통 적용하고, Playground/자연어 저장 실행은 test, 운영 실행은 prod로 분리. 성과·ROI 기본 집계는 `run_mode=prod`, `test`/`all`은 명시 선택 시만 노출하며 운영 성과로 해석하지 않는 경고를 둔다. |
| 알림 발화 하드닝 (S4b) | **계약 변경**(DDL) | ① `ops_notification_attempts` 자동발화 초기 세대 유니크 인덱스+ON CONFLICT는 2026-07-02 D-register 후속에서 해소(수동 발송·retry 의미 보존). 남은 범위: ② `source='session_expiry'` CHECK 확장(세션 만료를 attempt 파이프라인으로 발화) ③ 테넌트별 저장형 라우팅 테이블+관리 UI(멀티테넌트 셀프서비스). 둘 다 규모 확대/오너 결정 후 승격 |
| 오프보딩 데이터 반출 | feature — ✅ 계약 신설 | `GET /v1/offboarding/export` metadata-only CSV(`tenant_data.export`)로 해소. `runs.params`, human task payload/result, artifact `object_ref`/`sha256`/본문은 미노출하고 redacted/not_required·미삭제·비격리 artifact만 포함. 원문 데이터 패키지/셀프서비스 삭제 플로우는 별도 오너 결정 |
| 세션 캡처 helper 단일 실행파일 | 대형(L) | S6은 정직화·명령 호환까지. 근본 해소(다운로드→실행→로그인 3단계)는 패키징/서명 파이프라인 결정 필요 |
| ROI 실적 시스템 프리필 | M, 정책 판단 | 플랫폼 보유 run 통계로 실적 폼 제안값 프리필. '사람 확정 증거' 경계(자동값=제안일 뿐) 문구 정책 확정 후 |

## 7. 검증

각 슬라이스 공통:

```powershell
npm --prefix web run typecheck; npm --prefix web test; npm --prefix web run build
npm --prefix app run typecheck; npm --prefix app run test:unit
node scripts/db-temp-postgres-gate.mjs -- npm --prefix app run test:int   # 백엔드 터치 슬라이스
git diff --check
```

- web typecheck는 fresh 캐시로(tsbuildinfo stale 통과 이력).
- CI-only 게이트(console-browser/console-live e2e, db-static, codegen consistency)는 로컬 vitest 밖 — 백엔드·라우트 터치 시 별도 확인.
- **신규 app 테스트는 `app/package.json`의 `test:unit`/`test:int` 명시 체인에 반드시 배선** — 이 레포는 테스트를 glob 이 아니라 체인으로 실행하므로, 배선 누락 = CI-orphan(과거 감사에서 잠복결함 은닉 사례 반복).
- S1·S5·S6·S8·S11의 read 필드/파라미터 additive는 api-surface.md 갱신 + openapi/asyncapi 재생성 포함.
- 시각 슬라이스(S0·S10·S12)는 `dev:serve` 라이브 스모크(감사와 동일 방법)로 최종 확인.
- **재감사 게이트**: Tier 1 완료·Tier 3 완료 시점에 두-페르소나 라이브 스모크를 재실행해 §8 예상 점수 이동을 실측으로 검증한다(예상과 어긋나면 다음 tier 착수 전에 원인 분석).

## 8. 점수 임팩트 예상 (여정 완주 잣대)

| 관점 | 현재 | Tier 0~1 후 | Tier 0~3 후 | 전 슬라이스 후 |
| --- | ---: | ---: | ---: | ---: |
| 도입 담당자 | 73 | 78~80 | 84~86 | 87~89 |
| 실사용자 | 72 | 78~80 | 82~84 | 86~88 |

90+는 D 레지스터(시험/운영 구분·오프보딩·helper 패키징) 해소와 실사용 피드백 루프가 전제 — 본 설계는 90+를 주장하지 않는다.

## 9. Open Decisions

| 결정 | 오너 | 기본값(설계 가정) |
| --- | --- | --- |
| S4 라우팅 저장소 | 계약/제품 오너 | **env 우선 채택(S4a, 계약 무변경)** — 테넌트별 테이블+관리 UI(S4b)는 multi-tenant 필요 실재 시 D 에서 승격 |
| S7 콘솔 서빙: nginx vs Fastify 정적 | 배포 오너 | nginx(관심사 분리, security.ts 주석 권장안) |
| S8 증빙 패킷 배치 | 제품 오너 | 대시보드 요약 카드(선행 설계 §5.3 권고 유지) |
| S10 '봇으로 굳히기' 대체 문구 | 제품 오너 | '검증된 동작으로 초안 만들기' |
| S11 작성 중 입력 보존 수준 | 제품 오너 | 세션 스코프 임시 보존(영속 저장 안 함) |
