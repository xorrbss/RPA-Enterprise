# Browser RPA V2 보강 설계 초안

상태: Product Open v1 구현 정렬본  
목표: 브라우저 기반 RPA를 기업 도입 평가에 올릴 수 있도록 V2 보강 범위, 구현 상태, 보류 범위를 정리한다.  
주의: 계약 파일(`api-surface.md`, `auth-rbac.md`, schema/DB/TS 계약)이 최종 SSoT이며, 이 문서는 Browser RPA V2 구현·검토 로드맵이다.

## 1. 현재 기능 매핑표

기준 자료:

- `browser-rpa-gap-review-v2.html`
- `api-surface.md`
- `state-machine.md`
- `auth-rbac.md`
- `security-contracts.md`
- `ops-defaults.md`
- `db/migration_core_entities.sql`
- `web/src/components/PromptScenarioGenerator.tsx`
- `web/src/views/RunTrace.tsx`
- `web/src/views/HumanTasks.tsx`

| V2 후보 | 현재 상태 | 근거 | 설계 판단 |
| --- | --- | --- | --- |
| 상태머신/전이 안정성 | 있음 | Run/Workitem/HumanTask 전이, CAS, IllegalTransition 계약 | V2에서도 유지. 신규 엔티티도 명시 전이/감사 이벤트를 가진다. |
| 멀티테넌시/RLS | 있음 | `site_profiles`, `runs`, `human_tasks`, `audit_log` 등 tenant-scoped 테이블 | 신규 테이블은 tenant_id, RLS, tenant composite FK 원칙을 따른다. |
| 사이트/세션/정책 기반 실행 대상 | 구현됨 | `site_profiles`, `browser_identities`, `network_policies`, `gateway_policies`, 사이트 생성 default identity/policy | 생성·자연어 저작 UI에서 사이트/세션/정책 선택형 UX로 다룬다. |
| 자연어 자동화 생성 | 있음 | `scenario-generations` API와 web generator | 비개발자 UX의 기반으로 사용하되 JSON/ID 노출을 줄인다. |
| PbD 승격 UI | 구현됨 | `POST /v1/scenarios/{scenario_id}/promote-from-run`, RunTrace 승격 패널 | 성공 실행을 draft 봇 버전으로 굳히고 promoted/skipped 결과를 표시한다. |
| 브라우저 레코더 | 구현됨 | Browser recording API/UI, DOM event draft IR 생성 | 데스크톱/vision recorder가 아니라 브라우저 DOM 기반 authoring surface다. |
| 스케줄/이벤트 트리거 | 구현됨(P1) | `run_triggers`, cron scheduler, signed webhook ingestion | cron + HMAC signed webhook만 성공 경로. calendar/file/queue/manual fire-now는 보류. |
| 봇 풀 운영 UI | 구현됨(read model) | `/v1/bot-pools`, Orchestration 용량 패널 | synthetic browser pool로 worker/lease/queue 점유를 보여준다. 저장형 pool 정책/SLA 라우팅은 후속. |
| 실시간 운영 | 구현됨(P1) | `GET /runs/{id}/steps/stream` SSE + `/v1/ops-alerts` alert center | 외부 Teams/Slack/메일 fanout·ack/snooze/DLQ는 별도 알림 계약까지 보류. |
| HITL 입력 데이터 | 구현됨(저장/검증) | `resolve.result`, `business_form_v1`, 검증 워크벤치 | 판정·교정값은 저장된다. runtime resume context 자동 소비는 별도 versioned 계약까지 보류. |
| HITL timeout/escalation | 구현됨(P1) | `human_task_timeout_sweeper`가 H4a/H4b/H8 및 Run R14/R15를 처리 | durable routing policy와 외부 알림 포트는 후속. |
| 감사로그 | 구현됨 | append-only hash-chained `audit_log`, `/v1/audit-log`, CSV export, Audit Explorer | payload 본문 없이 검색·필터·내보내기를 제공한다. |
| SSO/IdP | 구현됨(readiness) | JWKS/RS256 검증, 배포형 claim/role mapping, readiness UI, OIDC redirect token 수집 UX | SCIM·관리형 IdP 설정 API는 보류. |
| HTTP api_call | 구현됨(P1 HTTP) | IR `api_call`, HTTP(S), `secret_ref_bearer`, raw auth header 거부 | file/shell 및 OAuth/mTLS/connector profile은 보류. |
| 커넥터 카탈로그 | 구현됨(read-only v1) | connector/template catalog API/UI | enable/install/profile/target/3rd-party packaging은 보류. |
| IDP/OCR | 구현됨(텍스트/CSV/JSON) | document job/extraction/validation task | 외부 OCR·binary PDF/image/vision 추출은 보류. |
| CoE/ROI/업무 발굴 | 구현됨 | automation idea/ROI pipeline API/UI | process/task mining 엔진은 보류. 승인·반려는 `automation_idea.approve` SoD 권한으로 분리. |
| ALM/CI/CD/환경 분리 | 없음 | 버전 diff/export/import/test suite 표면 부재 | P2/P3. 상용화 단계. |
| 데스크톱/Attended RPA | 범위 제외 | 현재 제품은 브라우저 중심 | 이번 V2 구현 범위 제외. 별도 전략 문서로 관리. |

## 2. V2 Scope Decision

### 포함

1. 비개발자 UX
   - 기술 ID/JSON 노출 제거.
   - 사이트, 로그인 세션, 보안 정책, AI 모델, 실행 params를 선택형/업무형 입력으로 제공.
   - 실행 전 selector probe/step test로 실패 가능성을 보여준다.

2. 스케줄/트리거
   - cron/calendar 기반 정기 실행.
   - queue threshold 기반 실행.
   - webhook/event 기반 실행.
   - 알림/SLA와 연결되는 trigger run provenance.

3. PbD 승격 UI
   - RunTrace에서 성공 실행을 draft scenario version으로 승격.
   - promoted nodes, skipped nodes, selector bake 결과 표시.

4. CoE/ROI
   - 자동화 후보 intake.
   - scoring/ROI 산정.
   - 업무 오너/보안/CoE 승인 파이프라인.
   - 구현/운영 상태 추적.

5. SLA/알림/운영 가시성
   - worker health, queue depth, lease occupancy, stuck run, human task aging.
   - console alert center. Teams/Slack/email outbound delivery is P2/future scope.
   - SLA warning before breach.

6. HITL v2
   - kind별 result schema.
   - validation/correction/approval payload 저장.
   - run resume context에서 `human_task.result` 참조.
   - timeout sweeper 구현 완료, escalation routing policy는 후속.

7. SSO/audit governance
   - OIDC login UX.
   - role claim mapping.
   - audit explorer/search/export.
   - SecretRef/session health/rotation UI.

8. HTTP api_call 실행기
   - file/shell과 분리된 server-side HTTP action.
   - SecretRef 기반 auth.
   - network policy와 audit boundary 적용.

9. IDP/OCR 최소 제품
   - document job.
   - extraction result.
   - validation task queue.
   - HITL result와 후속 browser/API run 연결.

10. 커넥터/템플릿 카탈로그
   - 1st-party connector catalog.
   - browser template pack.
   - HTTP connector profile.
   - target_id/workitem 연계.

### 제외

1. 데스크톱 앱 자동화
   - Windows selector, Win32/Java/SAP GUI automation은 이번 범위 제외.

2. 데스크톱 Attended RPA
   - 사용자 PC 보조봇, desktop runner, attended assistant는 별도 제품 전략.

3. 범용 shell/file executor
   - strict browser RPA V2에는 포함하지 않는다.
   - 단, 기존 UI/스키마에서 실행 가능한 것처럼 보이는 착시는 제거한다.

### 보류/재분류

1. 외부 PAM 연동
   - CyberArk/Key Vault 직접 연동은 P3.
   - 먼저 SecretRef/session 운영 가시성을 만든다.

2. 3rd-party marketplace
   - V2에서는 1st-party catalog 우선.
   - packaging/signature/isolation은 후속.

3. HA/DR, license, i18n
   - 상용화 준비도 항목으로 P3에 둔다.

### 결정 필요

Resolved decision:

- Browser RPA V2 IDP/OCR P1 engine path is `built_in_deterministic_text_v1` over redaction-visible browser artifacts (`text/plain`, CSV-like text, and JSON result artifacts) plus `business_form_v1` validation tasks. P1 does not include external OCR API calls, binary PDF/image OCR, or LLM vision because those paths need separate SecretRef/connector, PII egress, model-gateway, retention, and audit contracts. Low-confidence or missing fields must route to `human_task(validation)` with `artifact_refs`; automatic use of corrected fields by a later run remains future until a versioned resume/context contract is opened. Product evidence is exposed as `document-idp` and `document-idp-validation` catalog metadata. Evidence: `app/src/api/connector-catalog.ts`, `app/test/api-connector-catalog.int.ts`, `web/test/fake-client.ts`, and `web/test/connector-catalog.test.tsx`.
- HTTP `api_call` v2 P1 includes HTTP(S) server-side actions only. Allowed auth modes are `none` and `secret_ref_bearer`; bearer material resolves only through `SecretStoreBoundary.resolveAuthorized({ purpose: "connector" })`. Raw `Authorization`/`x-api-key`/cookie headers, basic auth, mTLS, and OAuth client credentials remain P2/future until a connector profile security contract is opened. Non-GET or `side_effect != read_only` HTTP calls require `idempotency_key`; `file` and `shell` remain outside browser product mode. Evidence: `app/src/executor/utility-executor.ts`, `app/src/runtime/ir-translate.ts`, `app/src/runtime/dom-executor-factory.ts`, `schema/ir.schema.json`, `app/test/utility-executor.unit.ts`, `app/test/ir-translate.unit.ts`, `app/test/dom-executor-factory.unit.ts`, `codegen/validators.fixtures.ts`.
- CoE/ROI는 Product Open v1 운영자 제품 표면이다. `automation_ideas`와 `roi_estimates`는 운영자가 후보 등록, 승인 파이프라인, 시나리오/트리거 연결, ROI 산정을 수행하는 control-plane이며 viewer는 조회만 한다. 프로세스/태스크 마이닝 엔진 자체는 이 결정 범위가 아니다.
- Browser RPA V2 P1 notification channel은 external Teams/Slack/email이 아니라 console alert center(`/v1/ops-alerts`, Orchestration alert center)다. Teams/Slack/email/webhook outbound delivery, recipient routing, ack/snooze, delivery retry/DLQ는 SecretRef/connector/notification_deliveries 계약이 생길 때까지 P2/future로 둔다.
- Webhook run trigger v1은 public JWT-skip endpoint와 HMAC boundary로 계약한다. `X-RPA-Webhook-Event-Id`가 `fire_key=webhook:{event_id}` 멱등성 키이며, `X-RPA-Webhook-Timestamp`는 5분 skew 안에 있어야 한다. `X-RPA-Webhook-Signature=sha256=<hex>`는 `{timestamp}.{event_id}.{canonical_json(body)}`를 `webhook_secret_ref`가 가리키는 SecretStore 값으로 서명한 값이다. 동일 event id replay는 기존 fire/run receipt를 반환하고 새 run을 만들지 않는다.
- Run trigger event scope v1 is closed to `cron` and signed `webhook` only. `file_arrival`, `queue`, and `queue_threshold` trigger types are rejected with `IR_SCHEMA_INVALID(reason=invalid_trigger_type)` before idempotency reservation and must not create `run_triggers` or `run_trigger_fires`. File watcher contracts, queue payload schemas, external queue credentials, replay windows, and event fire-key semantics are P2/future contracts. Evidence: `api-surface.md`, `codegen/openapi.yaml`, `app/src/api/run-triggers.ts`, `app/test/api-run-triggers.int.ts`, `web/src/views/Orchestration.tsx`, and `web/test/automation-ops.test.tsx`.

## 3. 릴리스 단계별 개발 계획

### P0: 도입 차단 해소

목표: 현업 담당자가 “만들고, 예약하고, 성공 실행을 고정”할 수 있게 한다.

1. 비개발자 UX 1차
   - `PromptScenarioGenerator`의 고급 설정에서 target ID/params JSON을 기본 화면에서 숨김.
   - 사이트 선택 시 `site_profile_id`, `default_browser_identity_id`, `default_network_policy_id` 자동 주입.
   - AI 모델은 기본 정책 선택으로 표현하고, 다정책/기본 없음일 때만 선택 UI 표시.

2. PbD 승격 버튼
   - `RunTrace` 성공 run 상세에 “이 실행을 봇으로 굳히기” 버튼 추가.
   - `POST /v1/scenarios/{scenario_id}/promote-from-run` 호출.
   - 생성된 draft version과 promoted/skipped 결과 표시.

3. 실행 예약/트리거 MVP
   - `run_triggers` 계약/DB/API 추가.
   - Product Open v1은 cron 트리거와 서명 웹훅 발화를 1차 지원.
   - trigger firing은 Graphile Worker 또는 existing worker enqueue와 연결.
   - calendar, queue/file arrival, fire-now는 V2 P1 성공 경로가 아니며 API가 명시 거절한다.

4. Selector probe/step test
   - 브라우저 레코더 전체보다 먼저 step별 selector test 버튼.
   - 저장 전 불안정 selector를 사용자에게 보여준다.
   - Product Open v1은 `/v1/sites/{siteId}/elements/{elementId}/probe`와 optional live provider를 둔다. `SELECTOR_PROBE_CHROME_EXECUTABLE_PATH` 또는 `CHROME_EXECUTABLE_PATH`가 설정되면 API가 headless Chrome으로 sample URL을 열고 `querySelectorAll` match count를 검증한다. 미설정 환경은 성공을 추측하지 않고 `probe_status=not_run`을 반환한다.

### P1: 기업 운영 보강

1. CoE/ROI pipeline
   - automation idea intake, scoring, ROI estimate, approval stage.

2. SLA/알림
   - notification rules, alert events, outbound adapter.
   - worker health, queue depth, human task aging.

3. HITL v2
   - result schema + typed validation forms.
   - escalation routing owner.

4. SSO/audit UX
   - OIDC redirect login.
   - audit explorer/export.

5. HTTP api_call
   - HTTP action executor.
   - SecretRef/network policy/audit integration.

6. IDP validation queue MVP
   - document job + extraction result + validation task.

### P2/P3: 전사 표준화

1. Connector catalog.
2. ALM/CI/CD and environment promotion.
3. Reusable subflow.
4. Browser recorder full flow.
5. HA/DR, license, i18n.
6. Third-party connector marketplace.

## 4. 도메인 모델 초안

### automation_ideas

업무 발굴/CoE 파이프라인의 중심 엔티티.

주요 필드:

- `id`
- `tenant_id`
- `title`
- `description`
- `business_owner`
- `department`
- `source`
- `stage`: `intake | assess | approved | build | operate | rejected | archived`
- `priority`
- `created_by`
- `created_at`
- `updated_at`

관계:

- optional `scenario_id`
- optional `run_trigger_id`
- optional `roi_estimate_id`

상태 전이:

- intake -> assess
- assess -> approved/rejected
- approved -> build
- build -> operate
- any terminal-ish -> archived

### roi_estimates

자동화 후보의 ROI 계산 결과.

주요 필드:

- `id`
- `tenant_id`
- `automation_idea_id`
- `frequency_per_month`
- `minutes_per_case`
- `monthly_cases`
- `exception_rate`
- `hourly_cost`
- `implementation_effort`
- `monthly_hours_saved`
- `estimated_monthly_value`
- `confidence`
- `created_at`

### run_triggers

무인 실행 조건.

주요 필드:

- `id`
- `tenant_id`
- `name`
- `scenario_version_id`
- `status`: `enabled | paused | archived`
- `cron_expression`
- `timezone`
- `params`
- `catchup_policy`: `skip_missed | fire_once`
- `max_concurrent_runs`
- `next_fire_at`
- `created_by`
- `created_at`
- `updated_at`

관계:

- creates `runs`
- writes `run_trigger_fires`
- uses `control_plane_idempotency_keys`

Cron contract:

- Product Open v1 supports 5-field numeric cron only: minute, hour, day-of-month, month, day-of-week.
- Allowed syntax: `*`, comma list, numeric range, and step expressions such as `*/15` or `1-5/2`.
- Unsupported syntax is fail-closed at create/update: named months/days, seconds/year fields, `L/W/#/?`, and simultaneous day-of-month plus day-of-week restrictions.
- If `next_fire_at` is omitted at create, the API calculates the first future fire from `cron_expression` and `timezone`; if cron/timezone changes at update and `next_fire_at` is omitted, it recalculates.
- On every due fire outcome (queued run, skipped concurrency, failed run creation, or duplicate ledger), the scheduler advances `next_fire_at`.
- `skip_missed`: advance to the first cron occurrence after the scheduler tick time, skipping additional missed backlog.
- `fire_once`: advance to the first cron occurrence after the processed `scheduled_for`, catching up at most one missed occurrence per scheduler poll.
- `max_concurrent_runs` uses active nonterminal runs from the same trigger. When reached, the fire ledger is marked `skipped` with `failure_reason.code=MAX_CONCURRENCY_REACHED`, then the same catchup advancement rule applies.

Future/blocked:

- calendar, queue_threshold, file-arrival triggers.
- manual fire-now endpoint and trigger-scoped run list.
- file/queue trigger auth, idempotency, and payload contracts.

### bot_pools

운영 용량과 실행 그룹.

주요 필드:

- `id`
- `tenant_id`
- `name`
- `kind`: `browser | idp | utility`
- `capacity`
- `concurrency_limit`
- `policy`
- `state`: `healthy | degraded | disabled`

관계:

- optional mapping to `workers`
- run trigger can request pool.

### notification_rules

SLA와 운영 이벤트의 알림 정책. This is P2/future unless an outbound notification delivery contract is opened. Product Open v1 P1 uses computed console alerts only.

주요 필드:

- `id`
- `tenant_id`
- `name`
- `event_type`: `sla_warning | run_failed | queue_depth | human_task_aging | trigger_failed`
- `channel`: `email | teams | slack | webhook`
- `recipients`
- `threshold`
- `enabled`
- `created_by`

### connector_profiles

1st-party connector catalog item 또는 HTTP connector profile.

주요 필드:

- `id`
- `tenant_id`
- `connector_key`
- `display_name`
- `kind`: `http | office | erp_web | database | notification`
- `version`
- `auth_ref`
- `config`
- `enabled`
- `created_by`

### connector_targets

workitem target_id를 실제로 지탱할 대상.

주요 필드:

- `id`
- `tenant_id`
- `connector_profile_id`
- `target_key`
- `display_name`
- `config`

관계:

- `workitems.target_id`가 nullable fixed value에서 실제 FK로 확장 가능.

### document_jobs

IDP/OCR 처리 단위.

주요 필드:

- `id`
- `tenant_id`
- `source_artifact_id`
- `document_type`
- `state`: `uploaded | classified | extracted | needs_validation | validated | failed`
- `confidence`
- `created_by`
- `created_at`

### document_extractions

문서 필드 추출 결과.

주요 필드:

- `id`
- `tenant_id`
- `document_job_id`
- `schema_ref`
- `fields`
- `confidence_by_field`
- `redaction_status`

### validation_tasks

문서 검증용 HITL task의 제품 레벨 wrapper.

주요 필드:

- `id`
- `tenant_id`
- `document_job_id`
- `human_task_id`
- `schema_ref`
- `result`
- `state`

### subflows

재사용 가능한 업무 로직.

주요 필드:

- `id`
- `tenant_id`
- `name`
- `version`
- `input_schema`
- `output_schema`
- `scenario_version_id`
- `state`

## 5. API Surface 초안

모든 mutation은 기본적으로 `Idempotency-Key`를 요구한다. 모든 read/write는 tenant RLS, RBAC, audit boundary를 따른다.

### CoE/ROI

| Method | Path | 설명 |
| --- | --- | --- |
| GET | `/v1/automation-ideas` | 후보 목록, stage/owner/department 필터 |
| POST | `/v1/automation-ideas` | 후보 접수 |
| GET | `/v1/automation-ideas/{idea_id}` | 상세 |
| PATCH | `/v1/automation-ideas/{idea_id}` | 설명/오너/우선순위 수정 |
| POST | `/v1/automation-ideas/{idea_id}/transition` | stage 전이 |
| POST | `/v1/automation-ideas/{idea_id}/roi-estimate` | ROI 산정 저장 |
| GET | `/v1/automation-ideas/{idea_id}/roi-estimate` | ROI 조회 |

RBAC:

- `viewer`: read
- `operator`: create/update own idea
- `approver`: approve/reject
- `admin`: all

### Schedule/Trigger

| Method | Path | 설명 |
| --- | --- | --- |
| GET | `/v1/run-triggers` | cron/webhook 트리거 목록 |
| POST | `/v1/run-triggers` | cron/webhook 트리거 생성 |
| GET | `/v1/run-triggers/{trigger_id}` | 상세 |
| PATCH | `/v1/run-triggers/{trigger_id}` | cron/params/timezone 또는 webhook SecretRef 수정 |
| POST | `/v1/run-triggers/{trigger_id}/pause` | 일시정지 |
| POST | `/v1/run-triggers/{trigger_id}/resume` | 재개 |
| GET | `/v1/run-triggers/{trigger_id}/fires` | 해당 트리거 발화 이력 |
| POST | `/v1/webhooks/run-triggers/{tenant_id}/{trigger_id}` | HMAC 서명 웹훅 발화 수신 |

Error:

- `IR_SCHEMA_INVALID`
- `RESOURCE_NOT_FOUND`
- `IDEMPOTENCY_REPLAY`
- `IDEMPOTENCY_CONFLICT`
- `SCHEDULE_TARGET_UNRESOLVED`

### Bot pool/Ops

| Method | Path | 설명 |
| --- | --- | --- |
| GET | `/v1/bot-pools` | pool 상태 |
| GET | `/v1/ops/health` | worker health, queue depth, lease occupancy |
| GET | `/v1/ops/sla-risks` | SLA 위험 목록 |
| POST | `/v1/notification-rules` | 알림 규칙 생성 |
| GET | `/v1/notification-rules` | 알림 규칙 목록 |
| POST | `/v1/notification-rules/{rule_id}/test` | 테스트 알림 |

### HITL v2

| Method | Path | 설명 |
| --- | --- | --- |
| GET | `/v1/human-tasks/{id}/form` | kind별 입력 스키마 |
| POST | `/v1/human-tasks/{id}/resolve` | 기존 endpoint 확장: `result` validate + persist |
| POST | `/v1/human-tasks/{id}/escalate` | routing owner/policy 필수 |
| GET | `/v1/human-tasks/aging` | 지연/timeout 위험 |

변경 영향:

- reserved handler result model 변경.
- resume context scope 변경.
- audit payload schema 추가.

### Audit/SSO

| Method | Path | 설명 |
| --- | --- | --- |
| GET | `/v1/audit-log` | 감사 이벤트 검색 |
| GET | `/v1/audit-log/export` | CSV/JSON export |
| GET | `/v1/audit-log/{audit_id}` | 상세 |
| GET | `/v1/auth/readiness` | 배포 인증 설정, claim mapping, role mapping 준비도 |
| env | `VITE_OIDC_AUTH_URL` | 콘솔 SSO 로그인 링크 |
| env | `JWT_TENANT_CLAIM`/`JWT_ROLES_CLAIM`/`JWT_ROLE_MAP` | IdP 클레임·그룹명 매핑 |

### HTTP api_call/Connector

| Method | Path | 설명 |
| --- | --- | --- |
| GET | `/v1/connectors` | 카탈로그 |
| POST | `/v1/connectors/{connector_key}/profiles` | profile 생성 |
| GET | `/v1/connector-profiles` | profile 목록 |
| POST | `/v1/connector-profiles/{profile_id}/test` | 연결 테스트 |
| GET | `/v1/connector-targets` | target 목록 |

HTTP action executor:

- P1 implemented contract: IR `api_call` uses `url_ref` resolved from run params plus `args.method`, `args.headers`, `args.body`, `args.auth`, and optional `args.idempotency_key`. `args.auth.type` is `none` or `secret_ref_bearer`; raw authorization headers/basic auth/mTLS/OAuth client credentials are invalid until the future connector profile security contract below is opened.

- IR `api_call`은 `connector_profile_id` 또는 inline `http_request_ref` 중 하나를 참조한다.
- auth는 SecretRef를 통해서만 해소한다.
- response body 저장은 artifact 또는 redacted output ref로 제한한다.

### IDP/OCR

| Method | Path | 설명 |
| --- | --- | --- |
| POST | `/v1/document-jobs` | 문서 처리 job 생성 |
| GET | `/v1/document-jobs` | 목록 |
| GET | `/v1/document-jobs/{job_id}` | 상세 |
| POST | `/v1/document-jobs/{job_id}/extract` | 추출 실행 |
| GET | `/v1/document-jobs/{job_id}/extraction` | 추출 결과 |
| POST | `/v1/document-jobs/{job_id}/validation-task` | 검증 태스크 생성 |

## 6. DB/schema 변경안

새 DB 파일 후보:

- `db/migration_v2_enterprise_surfaces.sql`

단, 기존 migration 순서와 release gate를 고려하면 실제 적용 전에는 `db/README.md`의 마이그레이션 순서를 갱신해야 한다.

### 공통 규칙

- 모든 tenant payload table은 `tenant_id uuid NOT NULL`.
- RLS enable + force.
- FK는 가능한 `(tenant_id, id)` composite.
- mutation table은 `created_at`, `updated_at`, `created_by`.
- payload-bearing table은 retention 정책 검토.
- audit event는 append-only `audit_log` 또는 `events_outbox`와 연결.

### 새 테이블 후보

1. `automation_ideas`
2. `roi_estimates`
3. `run_triggers`
4. `run_trigger_fires`
5. `bot_pools`
6. `notification_rules`
7. `notification_deliveries`
8. `connector_profiles`
9. `connector_targets`
10. `document_jobs`
11. `document_extractions`
12. `validation_tasks`
13. `subflows`

### 기존 테이블 확장 후보

1. `workitems`
   - `target_id`를 실제 connector target FK로 확장.
   - 기존 v1의 unsupported filter 계약과 migration compatibility 필요.

2. `runs`
   - optional `trigger_id`
   - optional `automation_idea_id`
   - optional `bot_pool_id`
   - source enum: `manual | schedule | webhook | queue | coe`

3. `human_tasks`
   - `result_schema_ref`
   - `result`
   - `routing_policy_ref`

4. `scenario_versions`
   - subflow reference를 도입한다면 IR schema 변경 필요.

5. `events_outbox`
   - notification delivery를 위한 event type 추가.

### JSON Schema 변경 후보

1. `schema/ir.schema.json`
   - `api_call` action을 HTTP-only shape로 분리.
   - file/shell은 browser product mode에서 저장 거부 또는 feature flag.
   - subflow call node가 필요하면 action/flow 확장.

2. human task result schema
   - kind별 result schema registry.
   - validation/approval/exception/captcha/mfa 각각 closed shape.

3. document extraction schema
   - document type별 field schema.

## 7. Web UX 설계안

실제 구현 대상은 `web/` React 콘솔이다. `rpa_enterprise_console.html`은 레거시 목업으로만 본다.

### 새 메뉴 구조

기존:

- 제작: 자동화 만들기, 테스트 실행, 시나리오 검증
- 운영: 대시보드, 실행 기록, 작업 목록, 사람 확인, 결재
- 고급 설정: AI 모델, 보안/개인정보, 중복 방지, Product-open

V2 제안:

- 제작
  - 자동화 만들기
  - 브라우저 레코더
  - 시나리오 검증
  - 재사용 구성요소

- 운영
  - 대시보드
  - 실행 기록
  - 스케줄/트리거
  - 봇 풀/큐
  - 사람 확인
  - SLA/알림

- 전략
  - 업무 발굴
  - ROI/CoE
  - Roadmap

- 확장
  - 커넥터 카탈로그
  - 문서 자동화/IDP

- 보안/통제
  - SSO/RBAC
  - 감사로그
  - SecretRef/세션
  - Product-open

### 비개발자 UX 변경

`PromptScenarioGenerator`의 고급 설정은 다음처럼 바꾼다.

Before:

- `site_profile_id`
- `browser_identity_id`
- `network_policy_id`
- `gateway_policies.model`
- `params JSON`

After:

- 사이트 선택
- 로그인 세션 선택
- 보안 정책 선택
- AI 모델 정책 선택
- 업무별 입력 폼

규칙:

- 사용자가 ID를 직접 입력하는 fallback은 admin/dev mode에만 둔다.
- 기본 사용자는 이름/상태/위험도/만료일을 보고 선택한다.
- params는 `params_schema` 기반 form renderer를 우선한다.
- HumanTask 교정/입력 화면은 `result_schema.version="business_form_v1"`을 공식 최소 계약으로 사용한다. `fields[]` 기반 renderer가 `text`/`textarea`/`number`/`boolean`/`date`/`select`를 그리고, 서버 resolve 검증이 required/type/options/unknown-key를 fail-closed로 막는다.
- schema가 없거나 version 없는 legacy object이면 자유 key/value 교정 입력으로 fallback하되, configurable 업무 폼으로 홍보하지 않는다.

### RunTrace/PbD

성공 run 상세:

- “이 실행을 봇으로 굳히기” 버튼.
- 승격 전 확인 dialog.
- 승격 결과 panel:
  - new scenario draft version
  - promoted node IDs
  - skipped reasons
  - selector bake summary

### Schedule/Trigger 화면

필수 상태:

- empty: “아직 예약 실행이 없습니다.”
- list: trigger name, type, next fire, status, owner, last result.
- detail: run history, params template, target, model, bot pool.
- actions: enable, pause, fire now, edit.

### CoE/ROI 화면

필수 상태:

- intake form.
- kanban pipeline.
- ROI calculator.
- approval history.
- link to scenario/run.

### IDP 화면

필수 상태:

- document job list.
- extraction result preview.
- validation queue.
- field correction form.
- redaction warning.

### Ops/SLA 화면

필수 상태:

- worker health.
- queue depth.
- lease occupancy.
- SLA risks.
- notification rules.
- test alert.

## 8. 첫 구현 PR 추천안

### PR 1: 비개발자 UX 개선

목표:

- 현업 화면에서 기술 ID/JSON 노출을 줄인다.

변경 예상:

- `web/src/components/PromptScenarioGenerator.tsx`
- `web/src/components/RunScenarioButton.tsx`
- `web/src/api/types.ts`
- 필요 시 작은 helper component 추가.

내용:

- 사이트 선택 UI를 기본으로.
- default browser identity/network policy 자동 주입.
- params JSON을 기본 접힘 또는 schema form으로 대체.
- model selection은 기본 정책 표시 중심.

테스트:

- `web test`
- `web run typecheck`
- 기존 generator tests 보강.

위험:

- 기존 dev/admin 직접 입력 경로가 사라지면 디버깅이 어려울 수 있음.
- dev mode escape hatch 필요.

### PR 2: PbD 승격 버튼

목표:

- backend에 있는 promote-from-run을 UI에 연결.

변경 예상:

- `web/src/views/RunTrace.tsx`
- `web/src/api/context.tsx`
- `web/src/api/types.ts`
- app route는 이미 존재하지만 응답 타입 확인 필요.

내용:

- completed run 상세에서만 버튼 노출.
- scenario/run 관계 검증 실패는 `IR_SCHEMA_INVALID` reason 그대로 표시.
- 성공 시 새 scenario draft로 딥링크.

테스트:

- RunTrace component test.
- API client test.
- `web run typecheck`.

### PR 3: Schedule/Trigger MVP 계약

목표:

- 스케줄/트리거를 contract-first로 추가.

변경 예상:

- `api-surface.md`
- `state-machine.md` 또는 새 `run-trigger-state-machine.md`
- `db/migration_v2_enterprise_surfaces.sql`
- `schema/`
- `ts/`
- codegen fixtures.

내용:

- cron trigger.
- signed webhook trigger.
- trigger firing creates run.
- idempotent fire.
- next_fire_at calculation contract.
- calendar/queue/file trigger types remain P2/future and are rejected instead of being stored or fired in V2 P1.

테스트:

- codegen typecheck.
- fixtures.
- DB migration smoke after DDL.

### PR 4: Run Trigger UI + API implementation

목표:

- PR 3 계약을 app/web에 연결.

변경 예상:

- `app/src/api/run-triggers.ts`
- `app/src/worker/*`
- `web/src/views/Orchestration.tsx`
- router/meta 추가.

테스트:

- app typecheck/unit.
- web typecheck/test/build.

### PR 5: CoE/ROI MVP

목표:

- 자동화 후보 파이프라인과 ROI 계산 표면 제공.

변경 예상:

- contract/API/DB 신규.
- web strategy menu.

### PR 6: SLA/Notification MVP

목표:

- 운영자가 대시보드를 계속 보지 않아도 되게 한다.

변경 예상:

- notification rules.
- event outbox consumer.
- ops dashboard.

### PR 7: HITL result schema

목표:

- 사람 확인을 continue 신호에서 업무 데이터 입력으로 확장.

주의:

- reserved handler result model, resume context, DB, audit, UI가 함께 움직이는 큰 변경이다.
- 별도 설계 리뷰 후 시작한다.

## 9. 설계 승인 체크리스트

- [ ] 데스크톱/Attended 제외에 동의.
- [ ] HTTP api_call은 P1 포함, file/shell은 제외에 동의.
- [ ] P0 순서: 비개발자 UX -> PbD UI -> schedule contract에 동의.
- [x] CoE/ROI를 실제 제품 범위로 본다. v1 범위는 운영자용 후보 파이프라인과 ROI 산정이며, 프로세스/태스크 마이닝 엔진은 별도 범위다.
- [x] IDP/OCR engine 방향 결정.
- [ ] 알림 채널 P1 최소 범위 결정.
- [ ] 신규 DB migration 파일 전략 결정.

## 10. 결론

V2는 “경쟁사 기능 전부 복제”가 아니라, 브라우저 RPA 제품으로서 도입 평가에서 바로 막히는 표면을 닫는 작업이다.

권장 첫 단계는 다음 순서다.

1. 비개발자 UX 개선.
2. PbD 승격 버튼.
3. Schedule/Trigger 계약 설계.
4. Schedule/Trigger 최소 구현.
5. CoE/ROI와 SLA/Notification 설계.

이 순서가 가장 작게 시작하면서도 도입 담당자가 바로 체감하는 제품 완성도를 올린다.
