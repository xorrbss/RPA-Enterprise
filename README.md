# /contracts — 개발 착수용 계약 패키지 v1

> PRD v3.1을 보완해 **개발팀이 바로 구현 가능한 단일 진실원천**을 코드/스키마로 고정한 묶음.
> 리뷰(91점)가 지목한 P0 체크리스트 10개 + 잔여 P1을 반영. 인프라·테스트 수행은 범위 외(타팀).

---

## 파일 구성

| 파일 | 다루는 리뷰 항목 | 핵심 |
|---|---|---|
| `ir-expression.md` | #1 | IREL 문법(EBNF)·타입체커·변수 스코프·결정론 evaluator·에러코드 |
| `schema/ir.schema.json` | #2 | IR 노드 구조 + 흐름 제어(next/on/loop/fallback/terminal) + 예약 핸들러 target |
| `reserved-handlers.md` | #2 | @challenge/@human_task/@end_no_data 입출력·복귀·resume token |
| `state-machine.md` | #3 | Run/Workitem/HumanTask **완전** 전이표 + finalization + race 규칙 |
| `llm-gateway-adapter.md` | #5 | adapter 인터페이스·request/SSE event·retry 분류·structured output·image redaction |
| `db/migration_concurrency_idempotency.sql` | #4 #6 #7 #11 | credential_leases, browser_leases, raw_items unique, cache insert-race |
| `ts/error-catalog.ts` | #13 | ErrorCode enum + retryable/http/exceptionClass 메타 |
| `impl-contracts-bundle.md` | #4 #9 #12 #14 #15 | connector hook 실행모델·artifact lifecycle job·cache classifier·런타임 redaction boundary·trace span |
| `schema/verify.schema.json` | (verify DSL) | criteria 타입 레지스트리, min_rows:0 금지 |
| `schema/event-envelope.schema.json` | (이벤트) | envelope + event_type 레지스트리 |
| `ts/core-types.ts` | (타입 계약) | PageState/StepResult/VerifyResult/RunContext/brand 타입 + `SecretStore` |
| `ir-static-validation.md` | (IR 검증) | 그래프 정적검증(target 무결성·도달성·사이클·flags 레지스트리·value_match·fallback) — v1.4 |
| `security-contracts.md` | (보안) | SecretStore·shell registry·prompt-injection·redaction 알고리즘·network policy·kid·connector perms·artifact RBAC — v1.4 |
| `ts/state-machine-types.ts` | (전이 타입) | RunState/Event/Guard/SideEffectCmd + transition*() 시그니처(codegen 대상) — v1.4 |
| `db/migration_core_entities.sql` | (핵심 DDL) | runs/run_steps/workitems/human_tasks/scenarios/scenario_versions/artifacts/events_outbox/dead_letter/stagehand_calls/action_plan_cache/site_profiles/site_profile_approvals/browser_identities/network_policies/gateway_policies/control_plane_idempotency_keys/workers — v2.4 |
| `auth-rbac.md` | (인증·인가·테넌시) | RBAC 역할(viewer/operator/reviewer/approver/admin)·권한 매트릭스·tenant_id 출처·RLS 정책 — v1.5 |
| `api-surface.md` | (제어평면 API) | REST 엔드포인트 인벤토리·If-Match·Idempotency-Key·as_of(D1 OpenAPI 입력) — v1.5 |
| `ops-defaults.md` | (운영 기본값) | 전이 임계·lease TTL·서킷·LLM retry/budget·artifact retention·sweeper 주기 + 테스트 픽스처값 — v1.6 |
| `codegen/` | (D1 생성물) | 계약→실행코드: types.ts·validators.ts(ajv)·static-validation.ts·event-payload-registry.ts·transitions.ts·error-middleware.ts·openapi.yaml·asyncapi.yaml·fixtures. tsc strict 통과·전이 fixtures 84/84 PASS·validators 44/44 PASS·static validation 36/36 PASS — v2.4 |
| `architecture.md` | (구현 설계, 계약 아님) | 스택·실행기(**Stagehand v3 CDP, Playwright 제거**)·컴포넌트↔계약 매핑·배포·빌드순서·§10 IREL — v2.0 |
| `build-prompt.md` | (개발 착수 프롬프트) | 코딩 에이전트용 프로덕션 빌드 마스터 프롬프트(D2–D7 단계별 DoD·검증 게이트·품질 바) — v2.4 |

---

## 리뷰 15개 대응 추적

| # | 리뷰 지적 | 처리 | 위치 |
|---|---|---|---|
| 1 | IR expression 정식 스펙 | ✅ 채택 | ir-expression.md |
| 2 | 예약 핸들러 계약 | ✅ 채택 | reserved-handlers.md + ir.schema.json |
| 3 | Run 전체 전이표 + §6.3 cross-ref 오류 | ✅ 채택 / 오류 교정 | state-machine.md / PRD 본문 수정(§9로) |
| 4 | cache classifier + insert race | ✅ 채택 | impl-bundle §D + migration SQL |
| 5 | LLM Gateway adapter 계약 | ✅ 채택 | llm-gateway-adapter.md |
| 6 | credential lease (count race 제거) | ✅ 채택 | migration SQL (조건부 insert) |
| 7 | BrowserLease DDL + sweeper | ✅ 채택 | migration SQL + impl-bundle §B |
| 8 | Phase A lease 충돌 | ✅ **결정**: Phase A=snapshot/replay, lease 반납. live view는 Phase B(D12) | state-machine.md H7 주석 / PRD 반영 권고 |
| 9 | artifact lifecycle job | ✅ 채택 | impl-bundle §B |
| 10 | 동일트랜잭션 vs QueueBackend | ✅ **결정**: v1 Graphile 전용, QueueBackend는 장기확장, P3는 별도 bridge(D11) | 아래 §결정사항 |
| 11 | raw idempotency key | ✅ 채택 | migration SQL (raw_items UNIQUE) |
| 12 | connector hook 실행모델 | ✅ 채택 (WASM은 3rd-party 단계로 연기) | impl-bundle §A |
| 13 | error catalog | ✅ 채택 | error-catalog.ts |
| 14 | 런타임 redaction boundary | ✅ 채택 | impl-bundle §C + core-types brand |
| 15 | trace span 계약 | ✅ 채택 | impl-bundle §E |

전 항목 반영. WASM 샌드박스(#12)만 v1 범위에서 "경계 확보 후 3rd-party 단계 연기"로 한정.

---

## 본 패키지에서 내린 설계 결정 (PRD 반영 권고)

1. **#8 — Human Task Phase A는 snapshot/replay 기반.** suspend 시 browser lease 반납. 실시간 live view(lease 유지·TTL 연장·operator timeout)는 Phase B(D12)로 분리. 이유: Phase A에서 lease를 휴먼 응답 내내 유지하면 브라우저 풀 고갈 + D8 비대화.

2. **#10 — 큐는 v1에서 Graphile Worker 전용으로 고정.** 상태 변경과 job 인큐를 동일 DB 트랜잭션에 두는 단순성을 취한다. `QueueBackend`는 코드 경계로만 남기고 v1에서 다른 구현을 시도하지 않는다. P3 Remote Agent의 이벤트 전달은 D11에서 **별도 event bridge 프로토콜**(outbound wss + at-least-once + idempotency_key 재사용)로 정의. → PRD §원칙/§16에 "QueueBackend는 장기 확장 포인트, v1=Graphile 전용" 명문화 권고.

3. **IREL은 컴파일 타임 검증.** 시나리오 저장/승격 시 전 expression 파싱+타입체크, 실패 시 저장 거부. 런타임 파싱 없음(AST 캐시). false success 방지를 위해 "조용한 false" 금지 — scope missing은 System 예외.

4. **cache는 "먼저 검증된 active가 이긴다".** 동시 miss 시 늦은 해석 폐기. loop 재생도 verify는 매 iteration 수행.

---

## D1에서 함께 산출할 것 (이 패키지의 다음 단계)

본 묶음은 계약의 핵심을 고정했다. D1 완료 정의에 다음 codegen/산출을 포함:

- `ir.schema.json` / `verify.schema.json` / `event-envelope.schema.json` → ajv validator + TS 타입 생성
- `state-machine.md` 전이표 → `transition*()` 함수 + 단위 테스트 픽스처(시뮬레이션 클록)
- `error-catalog.ts` → API 응답 매핑 미들웨어
- `migration_*.sql` → 실제 마이그레이션 + 조건부 쿼리 헬퍼
- OpenAPI(control-plane) / AsyncAPI(run-events) 생성 — 본 envelope·error 기반
- redaction fixture 데이터(케이스 목록은 impl-bundle §C)

> 구현 시 라이브 확인: Codex SSE structured-output 스트리밍의 실제 지원 범위와 abort 동작은 `capabilities.jsonMode`/HTTP close fallback 계약을 유지한 채 adapter 구현 시 실측 확정한다. P1 vLLM SSE와 credential 동시성 기본값은 v1.4에서 본 패키지가 결정했다.

---

## 외부 의존 맵 (이 패키지 밖에서 확정되는 계약)

> 본 패키지는 PRD v3.1의 **보충판**이다(맨 위 참조). 핵심 데이터 모델·제어평면 API·인증/인가·일부 보안 계약은 이 패키지가 아니라 **PRD 본문 / 형제 스펙(LLM Gateway) / D1 codegen / 운영 정책**에서 확정된다. 아래 맵은 본 패키지가 *참조하지만 정의하지 않는* 모든 외부 의존을 한곳에 모은 것이다. 목적: 개발자가 컬럼/엔드포인트/역할/임계를 **임의 추정하지 않도록** 위치를 고정한다.
>
> **상태 범례** — `PRD 확정`(섹션 인용 있음) · `위치 미확정(TODO)`(PRD/형제 스펙에 있을 것으로 보이나 섹션 미인용 — PRD 소유자가 채울 것) · `형제 스펙` · `D1 codegen` · `운영 정책` · `미결정(§19)`.
> **원칙(가정 금지)**: 인용 없는 섹션 번호를 지어내지 않는다. TODO가 빈 채로 해당 코드 경로에 착수해야 하면 `TODO: [BLOCKED]`(violated/reason/required_change)로 중단·보고.
>
> **[v1.4 갱신] 별도 PRD 소유자 없음 → 본 패키지가 직접 정의한다.** §5(보안 계약) 전 항목·`SecretStore`·shell registry·redaction·network policy·kid·connector perms·artifact RBAC는 `security-contracts.md`/`ts/core-types.ts`로, IR 정적검증·flags 레지스트리는 `ir-static-validation.md`로, transition 타입은 `ts/state-machine-types.ts`로, LLM terminal 코드는 `error-catalog.ts`로 **해소 완료**(v1.4 로그). 데이터모델 DDL·RBAC 역할·제어평면 API·테넌시/RLS는 **Phase 2(v1.5)에서 본 패키지에 정의 완료**: DDL→`db/migration_core_entities.sql`, RBAC·테넌시/RLS→`auth-rbac.md`, 제어평면 API→`api-surface.md`, 보안→`security-contracts.md`/`ts/core-types.ts`(v1.4), 수치 임계→`ops-defaults.md`(v1.6).
>
> **✅ [v2.3 전면 갱신] 아래 §1~§6 표의 모든 'TODO'·'운영 정책(TODO)' 상태 셀은 위 파일들로 해소 완료** — 표는 *원래 외부 의존이었던 항목의 이력(historical)*이며 미해소 항목은 없다. (`PRD 확정` 셀은 action_plan_cache/파이프라인/Challenge처럼 PRD §7/§9/§10.6에 본체가 있는 항목 표기 유지.)

### 1. 데이터 모델 (DDL) — 상태머신·job·캐시가 의존하나 본 패키지엔 DDL 없음
| 엔티티 | 본 패키지 참조(근거) | 외부 위치 | 상태 |
|---|---|---|---|
| `runs` / `run_steps` | state-machine.md §1·§4 (CAS `UPDATE`, `worker_id`, `attempts`, `resume_token` 저장) | PRD v3.1 | ✅ 본 패키지 정의(v1.5/v2.2) |
| `workitems` | state-machine.md §2 (`checked_out_by/at`, `attempts`, `unique_reference`) | PRD v3.1 | ✅ 본 패키지 정의(v1.5/v2.2) |
| `human_tasks` | state-machine.md §3 (`state`, `assignee`, `timeout`, `on_timeout`) | PRD v3.1 | ✅ 본 패키지 정의(v1.5/v2.2) |
| `scenarios` / `scenario_versions` | error-catalog.ts (`SCENARIO_VERSION_CONFLICT`/If-Match 412), ir.schema `meta.version`, ir-expression §5 (AST 캐시·prod 승격) | PRD v3.1 | ✅ 본 패키지 정의(v1.5/v2.2) |
| `artifacts` | impl-bundle §B/§C (`redaction_status`, `retention_until`, `sha256`, `type`), state-machine R21(artifact flush) | PRD v3.1 | ✅ 본 패키지 정의(v1.5/v2.2) |
| `action_plan_cache` | impl-bundle §D, migration SQL `UNIQUE(...)` | **PRD §7**(본체), 상태전이 **§7.2** | PRD 확정 |
| events `outbox` / 이벤트 테이블 | event-envelope.schema.json("outbox 내장"), 본 README §결정2(상태변경+인큐 동일 트랜잭션) | PRD v3.1 또는 D1 마이그레이션 | ✅ 본 패키지 정의(v1.5/v2.2) |
| `dead_letter` / DLQ (workitem 차원) | state-machine W5/W7(dead_letter 생성)·W10(DLQ 복원), error-catalog `DEAD_LETTER` | PRD v3.1 | ✅ 본 패키지 정의(v1.5/v2.2) |
| `stagehand_calls` | llm-gateway-adapter.md(`stagehand_calls.stream_status`), core-types `StepResult.stagehandCallIds` | PRD v3.1 | ✅ 본 패키지 정의(v1.5/v2.2) |
| `site_profiles` / `browser_identities` / `network_policies` | core-types `RunContext`(siteProfileId 등), lease 테이블 uuid 참조, `site risk=red` | PRD v3.1 | ✅ 본 패키지 정의(v1.5/v2.2) |

> `migration_concurrency_idempotency.sql`은 동시성 & idempotency 보강(#4 #6 #7 #11)에 한정되고, 위 핵심 엔티티 DDL은 **v1.5에서 `db/migration_core_entities.sql`로 정의 완료**(상태 CHECK enum = `state-machine-types.ts`, run_steps 멱등 `UNIQUE(run_id,step_id,attempt)`, events_outbox `UNIQUE(tenant_id,idempotency_key)` 포함 — v2.3). `transition*()` codegen·시뮬레이션 클록 픽스처는 이미 검증(npm test).

### 2. 파이프라인 / 수집 / Challenge
| 항목 | 본 패키지 참조 | 외부 위치 | 상태 |
|---|---|---|---|
| raw→normalized→sink 파이프라인, cursor commit 시점 | migration SQL("§9 파이프라인"), state-machine §2(sink decoupled) | **PRD §9** | PRD 확정 |
| ChallengeResolutionPolicy(@challenge action 순서 상태머신) | reserved-handlers.md(PRD §10.6 실행), migration `challenge_resolution_attempts` | **PRD §10.6** | PRD 확정 |

### 3. 제어평면 API
| 항목 | 본 패키지 참조 | 외부 위치 | 상태 |
|---|---|---|---|
| REST/OpenAPI 엔드포인트 인벤토리(run create/get/abort, scenario CRUD·validate·promote, human_task inbox·start·resolve, DLQ replay, artifact fetch) | error-catalog 전 코드의 `httpStatus`, `ApiError` | `api-surface.md` → `codegen/openapi.yaml` | ✅ 본 패키지 정의(v1.5/v2.4) |
| If-Match(ETag) optimistic concurrency — ETag 출처·대상 엔드포인트 | error-catalog `SCENARIO_VERSION_CONFLICT`(412) | PRD v3.1 | ✅ 본 패키지 정의(v1.5/v2.2) |
| 인입 명령 멱등(`Idempotency-Key` 헤더) | sink 외부 멱등만 정의(migration `sink_idempotency_key`) | PRD v3.1 | ✅ 본 패키지 정의(v1.5/v2.2) |
| `params.as_of` 주입 주체(Run 생성 시 1회 고정) | ir-expression §5 | PRD v3.1 | ✅ 본 패키지 정의(v1.5/v2.2) |

### 4. 인증 · 인가 · 테넌시
| 항목 | 본 패키지 참조 | 외부 위치 | 상태 |
|---|---|---|---|
| RBAC 역할 레지스트리/권한 매트릭스(`assignee_role`, `requires_approval`, operator, secret/connector 권한) | reserved-handlers, ir.schema `nodePolicy`, error-catalog security 코드군 | PRD v3.1 | ✅ 본 패키지 정의(v1.5/v2.2) |
| `tenant_id` 인증 출처(주체) + RLS 정책 본문 | migration SQL(모든 테이블 tenant_id, RLS는 P2 전제) | PRD v3.1 (RLS는 P2) | ✅ 본 패키지 정의(v1.5/v2.2) |

### 5. 보안 계약
| 항목 | 본 패키지 참조 | 외부 위치 | 상태 |
|---|---|---|---|
| Gateway redaction 알고리즘·대상 필드 | llm-gateway-adapter.md("redaction은 Gateway §5.1 step2") | `security-contracts.md` §4 | ✅ 본 패키지 정의(v1.4/v2.4) |
| `SecretStore` 인터페이스 시그니처 | core-types(SecretStore 경유), impl-bundle §C(`SecretStore.resolve()`) | PRD v3.1 또는 형제 스펙 | ✅ 본 패키지 정의(v1.5/v2.2) |
| signed command registry(shell `cmd_ref` 키·서명·허용인자·검증시점) | ir.schema `cmd_ref`("미등록 시 거부") | PRD v3.1 | ✅ 본 패키지 정의(v1.5/v2.2) |
| prompt injection 탐지 계약(언제/어디서/임계) | error-catalog `PROMPT_INJECTION_DETECTED`, redaction fixture(hidden-instruction) | PRD v3.1 | ✅ 본 패키지 정의(v1.5/v2.2) |
| resume_token HMAC `kid` 키 레지스트리·회전 정책 | reserved-handlers.md ResumeToken(`kid`/`hmac`) | KMS/SecretStore 경계로 추정(DB 아님) | ✅ 본 패키지 정의(v1.5/v2.2) |
| `networkPolicyId` 정책 구조·도메인 allowlist·enforce 지점 | core-types `RunContext`, error-catalog `DOMAIN_POLICY_VIOLATION` | PRD v3.1 | ✅ 본 패키지 정의(v1.5/v2.2) |
| connector manifest permissions 스키마·검사 지점 | error-catalog `CONNECTOR_PERMISSION_DENIED`, impl-bundle §A | PRD v3.1 (D7+ 3rd-party 격리는 의도적 연기) | ✅ 본 패키지 정의(v1.5/v2.2) |

### 6. 정책 · 수치 임계 (운영 정책 — 단 개발/테스트 기본값 필요)
| 항목 | 본 패키지 참조 | 상태 |
|---|---|---|
| 전이 임계: init-fail 연속 임계(R3), workitem `attempts max`(W4–W7), `abort_timeout`(R24), 백오프 곡선 | state-machine guards | ✅ ops-defaults.md(v1.6) |
| lease 수치: browser lease TTL·heartbeat 주기, credential `locked_until` TTL, checkout timeout | migration leases, impl-bundle §B(sweeper "수초"/"일배치") | ✅ ops-defaults.md(v1.6) |
| 서킷 임계: `SITE_CIRCUIT_OPEN` 차단율·윈도우, challenge 차단율, worker 서킷 | error-catalog, reserved-handlers | ✅ ops-defaults.md(v1.6) |
| LLM: retry 최대 N, idle/wall-clock timeout, `budget`(maxCost/maxOutputTokens) 기본값 | llm-gateway §2·§4 | ✅ ops-defaults.md(v1.6) |
| artifact: `retention_until` 기본 보존기간, redaction 실패 N회 임계, sweeper 주기 | impl-bundle §B | ✅ ops-defaults.md(v1.6) |
| `max_self_heal`(기본 2)·`max_iterations`·verify `timeout_ms` 상한 | ir.schema `nodePolicy`/`loop`, verify.schema | ✅ ops-defaults.md + schema 상한(v1.6/v2.4) |

### 7. D1 codegen / 의도적 연기 (갭 아님 — 위치 확정됨)
| 항목 | 위치 | 상태 |
|---|---|---|
| event `payload_schema_ref` ↔ event_type 매핑 레지스트리 | event-envelope.schema.json(설명), 본 README §"D1에서 함께 산출할 것" | ✅ `codegen/event-payload-registry.ts`(ref 매핑) + v1 closed-empty payload body enforcement |
| ajv validator + TS 타입(ir/verify/event), `transition*()` 함수, error 매핑 미들웨어, OpenAPI/AsyncAPI | 본 README §"D1에서 함께 산출할 것" | D1 codegen |
| Codex SSE 스트리밍 범위·abort 실지원 | llm-gateway-adapter.md §3/§7, README v1.4 결정 | 구현 시 라이브 capability 확인(안전 fallback 계약 고정) |
| Human Task 실시간 live view, 3rd-party 커넥터 WASM 격리, P3 event bridge, QueueBackend 대체 | 본 README §결정·#8·#10·#12 | 의도적 연기(D7/D11/D12) |

> **사용법**: 새 코드 경로 착수 전 이 맵에서 의존 항목의 상태를 확인한다. `PRD 확정`은 인용 섹션을 열어 컬럼/규약을 따른다. `위치 미확정(TODO)`은 PRD 소유자가 섹션을 채울 때까지 **추정 금지** — 채워지기 전 착수가 불가피하면 해당 위치에 `TODO: [BLOCKED]`를 남긴다. 이 맵 자체가 PRD 정합 점검의 체크리스트다.

---

## v1.1 패치 로그 (잔여 정합성 점검 반영)

> 구현 정확성 축의 2차 점검에서 발견된 P0/P1/P2를 반영. 설계 방향은 불변, 결함만 교정.

| # | 등급 | 항목 | 위치 | 조치 |
|---|---|---|---|---|
| 1 | P0 | raw_items UNIQUE의 NULL-distinct 멱등 누수 | migration SQL | `UNIQUE NULLS NOT DISTINCT`(+PG14 COALESCE fallback)로 교체. page_attempt 정책도 동일 적용 |
| 2 | P0 | R3 "재큐↔terminal" 모순 | state-machine.md | R3a(`claimed→queued` 재큐) / R3b(`claimed→failed_system` 서킷)로 분리 |
| 3 | P0 | phantom 상태 `succeeded_collection` | state-machine.md §2 | enum 미존재 상태 제거. `completed`=raw+artifact flush, sink는 decoupled(DLQ 보장)로 명문화. R21 단서 추가 |
| 4 | P1 | LLM 스트림 중 비용 abort 부재 | llm-gateway-adapter.md | usage 누적 > budget 초과 시 즉시 close + `BUDGET_EXCEEDED`. retry표 행 추가 |
| 5 | P1 | credential_leases PK가 동시성=1 고정 | migration SQL | `slot_no` + `max_concurrency`로 N 동시성 지원(N=1이면 기존 동작). README §19 미결정과의 충돌 해소 |
| 6 | P1 | completing/suspending/resuming 중 abort 미정의 | state-machine.md | R25(finalize 우선)·R26·R27 추가, race 규칙 보강 |
| 7 | P1 | 이벤트 payload 무타입 | event-envelope.schema.json | `payload_schema_ref`(required) 도입. step.completed·run.resume_requested 보강 |
| 8 | P1 | challenge_resolution_attempts DDL 부재 | migration SQL | 멱등 보장 테이블 추가(UNIQUE challenge_event×action) |
| 9 | P2 | IREL `!`/혼합 &&,\|\| 모호성 footgun | ir-expression.md | 괄호 강제 규칙(`IREL_PARSE_ERROR`) + 예시 정정 |
| 10 | P2 | MALFORMED retryable 표기 불일치 | llm-gateway-adapter.md | "true(repair 1회 한정)"으로 catalog와 정합 |
| 11 | P2 | IR 흐름키 "정확히 하나" 미강제 | ir.schema.json | `oneOf`로 0개·2개+ 모두 거부(코드 검증 의존 제거) |
| 12 | P2 | now() 부재로 상대 날짜 불가 | ir-expression.md | `params.as_of` 주입 표준 패턴 명시 |
| 13 | P2 | dead `base` $def / ResumeToken kid 부재 | verify.schema.json / reserved-handlers.md | dead def 제거, HMAC `kid`(키 회전) 추가 |

> 잔여 미결정(변경 없음): Codex SSE structured-output 스트리밍 범위·abort 규격(#5). credential 동시성 **기본값**은 이제 `max_concurrency`로 설정 가능하나 사이트별 기본치는 운영 정책으로 별도 확정 필요.

---

## v1.2 패치 로그 (외부 개발 리뷰 정합성 반영 — 검증된 내부 결함만)

> 외부 리뷰(94/100)의 지적 중 **검증 가능한 내부 불일치/누락만** 반영. PRD 본문 의존 항목은 보류(아래).

| # | 등급 | 항목 | 위치 | 조치 |
|---|---|---|---|---|
| 1 | P0 | event enum이 state-machine emit과 불일치 | event-envelope | `run.aborted` → `run.cancelled`(state가 실제 emit하는 값). error-catalog에 어휘 관계 주석 |
| 2 | P0 | `on` 분기 우선순위가 키 순서 의존(IREL §6 ↔ schema 모순) | ir.schema / ir-expression | `on`을 `{when,target,priority}` 배열로 변경. 동률 priority 컴파일 거부 → 결정론 보장 |
| 3 | P0 | PageState 생산자 계약 부재 | core-types | `PageStateResolver` 인터페이스 추가 + `ExecutorPlugin.capabilities`에 `utility` |
| 4 | P1 | verify `elementTarget` 빈 객체 통과 | verify.schema | `oneOf(selector | role+name)` + `additionalProperties:false` |
| 5 | P1 | `raw_hash` canonicalization 규칙 부재 | migration SQL | canonical JSON·volatile 제외·collect_tier 미포함 규칙 명시 |
| 6 | P1 | sink 외부 멱등키 부재 | migration SQL | `sink_idempotency_key` 컬럼 + 값 규약 추가 |
| 7 | P1 | credential `max_concurrency` 비정규화 | migration SQL | `credential_concurrency_policies` 테이블로 분리, lease엔 `slot_no`만 |
| 8 | P1 | event `correlation_id` 미필수 | event-envelope | `correlation_id`·`payload` required 승격(`ordering_key`는 run-less 이벤트 위해 optional 유지) |
| 9 | P1 | packaging 경로 불일치 | (구조) | `schema/ db/ ts/` + 루트 `.md`로 README와 일치하게 재배치 |

### 반영하지 않은 리뷰 항목 (사유 명시)
- **ExceptionClass에 `unknown` 추가**: 본 설계의 명시 원칙이 "미분류→system 흡수"라, unknown을 타입에 넣으면 미분류 상태가 전 경로로 전파되어 오히려 후퇴. 대신 core-types(4개, 예외 분류)와 error-catalog(`none` 포함, 에러코드 메타)의 **용도 차이를 주석으로 고정**.
- **IR `graph` 래퍼 통일(P0-1)** / **Human Task Phase A 정의(P0-4)**: 둘 다 **PRD 본문 vs contracts** 불일치 주장이라 contracts만으로 단정 불가. contracts는 내부 일관적이며, contracts가 단일 진실원천이면 **PRD 본문을 contracts에 맞추는 방향**으로 결정 권고. (Phase A는 contracts가 이미 리뷰가 "더 안전"이라 인정한 snapshot/replay로 확정한 상태)
- **`ordering_key` required**: run 없는 이벤트(site.circuit_* 등)는 run_id 기본값이 없어 required 부적합. 의도적 optional 유지.

---

## v1.3 패치 로그 (개발 착수 전 갭 분석 — 상태머신 내부 결함 교정)

> 8관점 갭 분석 + 발견별 적대적 검증에서 confirmed된 **상태머신 P1 내부 모순만** 반영. 설계 방향 불변, 결함만 교정.

| # | 등급 | 항목 | 위치 | 조치 |
|---|---|---|---|---|
| 1 | P1 | `resume_requested`에서 abort_requested 미정의 → 정상 운영 abort가 `IllegalTransition` throw | state-machine.md | **R28 추가**(resume_requested→aborting, R23으로 cancelled). "abort 보편성" 규칙 명문화(비종결 실행 상태 전체에서 abort 정의, completing만 예외) |
| 2 | P1 | `escalated` HumanTask에 timeout 부재 → 재배정 안 된 태스크 **영구 미해소** | state-machine.md | **H8 추가**(escalated→timeout→expired→R14). 재에스컬레이션 없음(무한 대기 방지) |
| 3 | P1 | HumanTask timeout 정책 split-brain(H4 "항상 expired" vs R14 guard `on_timeout=fail` vs handler "또는 escalate") + `transitionHumanTask`에 guard 인자 부재로 분기 불가 | state-machine.md / reserved-handlers.md | **H4→H4a(on_timeout=fail→expired)/H4b(on_timeout=escalate→escalated) 분기**. `transitionHumanTask`에 `HumanTaskGuard` 추가. R14 guard 제거(정책은 HumanTask 단계로 **일원화**, Run은 expired를 무조건 수용). @human_task 입력에 `on_timeout(fail\|escalate, 기본 fail)` 추가 |
| 4 | P1 | W9 checkout timer **pause만 있고 resume(un-pause) 부재** → run 재개 후 타이머 영구 정지/오발 | state-machine.md | **W11 추가**(run_resumed→timer 재개, pause 잔여 TTL부터). checkout_expired 판정은 pause 구간 제외 계산 |

> 잔여(이번 범위 외, 별도 결정 필요): queued/claimed 단계 abort의 Run 전이화 여부(현재 dispatcher 처리 전제), H7 와일드카드 `*`가 종결 상태 포함하는 P2 정밀화. 갭 분석 P1/P2 중 **외부에서 확정되는 항목(데이터모델 DDL·API·RBAC·보안 인터페이스·수치 임계)은 위 §"외부 의존 맵"으로 정리**했고, 본 패키지 내부에서 정의해야 할 항목(IR 정적검증 계약 등)은 v1.4에서 착수.

---

## v1.4 패치 로그 (단일 SSoT 전환 — Phase 1: 계약 내부 P1)

> **[결정] 별도 PRD 소유자가 없어 본 패키지가 완전한 단일 진실원천이 된다.** §"외부 의존 맵"의 "위치 미확정(TODO)"은 외부로 미루지 않고 본 패키지에서 직접 정의한다. 아래는 1차분(계약 내부 P1).

| # | 항목 | 위치 | 조치 |
|---|---|---|---|
| 1 | IR 그래프 정적검증 부재(target 무결성·도달성·사이클·terminal·priority 동률) | `ir-static-validation.md`(신규) | V1..V11 규칙 + ValidationReport. `IR_SCHEMA_INVALID`(reason)/`IR_EXPRESSION_COMPILE_ERROR` 매핑 |
| 2 | flags closed/open 모순 | `ir-static-validation.md` §2 · `ir-expression.md` §2 | **닫힌 레지스트리로 확정**(7개, `reviews_visible` 포함). ir-expression은 포인터로 정합 |
| 3 | transition codegen 타입 부재 | `ts/state-machine-types.ts`(신규) | RunState/Event/Guard/SideEffectCmd + transition*() 시그니처 + `IllegalTransition` |
| 4 | SecretStore 시그니처 부재 | `ts/core-types.ts` | `SecretStore.resolve(SecretRef)→PlainSecret` |
| 5 | 보안 계약 공백(shell registry·injection·redaction §5.1 댕글링·network policy·kid·connector perms·artifact RBAC·sensitive/recording) | `security-contracts.md`(신규) | 9개 절로 고정. **redaction §5.1 댕글링 → 본 문서 §4로 해소** |
| 6 | LLM `RATE_LIMIT`/`BACKEND_ERROR`/`CONNECTION_FAILED` terminal 코드 부재 | `error-catalog.ts` · `llm-gateway-adapter.md` §4 | `LLM_RATE_LIMITED`/`LLM_BACKEND_UNAVAILABLE`/`LLM_CONNECTION_FAILED` + 표 매핑 |
| 7 | shell 미등록 명령 코드 부재 | `error-catalog.ts` | `SHELL_COMMAND_NOT_ALLOWED`(security) |
| 8 | verify criterion 오타 통과 | `verify.schema.json` | 각 criterion `additionalProperties:false` + `value_match.path` 문법 명시 |
| 9 | verify fail surfacing·DEAD_LETTER 200·worker 서킷 비대칭 | core-types · error-catalog · event-envelope | status surfacing 주석, DEAD_LETTER 통지전용 주석, worker telemetry tenant outbox 분리 |

### §19 미결정 결정 (owner=본 패키지)
- **credential 동시성 기본값 = 1** (DDL DEFAULT와 일치, 사이트별 `credential_concurrency_policies`로 상향).
- **P1 vLLM SSE**: OpenAI 호환 adapter 재사용, `sse=false` 모델만 sync 폴백(adapter §7) — 별도 구현 불요.
- **Codex structured-output 스트리밍·abort**: `capabilities.jsonMode` 게이트 + 미지원 시 prompt-schema+strict(§7), abort=HTTP close(§3). 실제 지원범위는 **구현 시 라이브 API로 capabilities 확정**(안전 폴백 정의됨).

> 다음(Phase 2): 핵심 DDL + RBAC 역할 + tenant/RLS + 제어평면 API 인벤토리 → §"외부 의존 맵" 잔여 TODO 해소. **→ v1.5에서 완료.**

---

## v1.5 패치 로그 (Phase 2 — 핵심 DDL · RBAC/테넌시 · 제어평면 API)

> §"외부 의존 맵"의 §1(데이터 모델)·§3(제어평면 API)·§4(인증·인가·테넌시) "위치 미확정(TODO)"를 본 패키지에 직접 정의해 해소.

| # | 항목 | 위치 | 조치 |
|---|---|---|---|
| 1 | 핵심 엔티티 DDL 부재(runs/run_steps/workitems/human_tasks/scenarios/scenario_versions/artifacts/events_outbox/dead_letter/stagehand_calls/site_profiles/browser_identities/network_policies) | `db/migration_core_entities.sql`(신규) | 18개 테이블로 확장. 상태 CHECK enum = `state-machine-types.ts`(Run 13/Workitem 7/HumanTask 7/Kind 5)·`core-types` StepStatus 8·cache_mode 6·event_type 31과 **정확히 일치**. 기존 migration 테이블 재정의 없이 ALTER로 FK/RLS 보강(적용 순서: concurrency→core) |
| 2 | `action_plan_cache` 본체(PRD §7) | `db/migration_core_entities.sql` | UNIQUE 7키 = migration_concurrency §4 ON CONFLICT 규약과 일치. status active/suspect/stale/quarantined(§7.2) |
| 3 | RBAC 역할·권한 매트릭스·tenant_id 출처·RLS 부재 | `auth-rbac.md`(신규) | 역할 enum(viewer/operator/reviewer/approver/admin) + 권한 매트릭스 + JWT 클레임 tenant_id 출처 + RLS(SET LOCAL + current_setting strict, FORCE RLS) |
| 4 | 제어평면 API 표면 부재 | `api-surface.md`(신규) | runs/scenarios/human-tasks/workitems·DLQ/artifacts/gateway/sites 엔드포인트 인벤토리(D1 OpenAPI 입력). If-Match(scenario.version)·Idempotency-Key·params.as_of 주입 규약. 어휘체인 abort→cancelled 정합 |
| 5 | 엔티티 404 코드 오용·일반 RBAC 거부 코드 부재 | `error-catalog.ts` | `RESOURCE_NOT_FOUND`(404, run 외 엔티티)·`AUTHZ_FORBIDDEN`(403, 일반 RBAC 거부) 추가. 자원특정 거부(secret/connector/site)는 기존 코드 유지 |

> 다음(Phase 3): 운영 기본값·수치 임계 문서. **→ v1.6 `ops-defaults.md`로 완료.**

---

## v1.6 패치 로그 (Phase 3 — 운영 기본값·수치 임계)

> §"외부 의존 맵" §6(정책·수치 임계)의 "운영 정책(TODO)"를 `ops-defaults.md`(신규)로 해소. 모든 임계에 코드 기본값 + 시뮬레이션-클록 테스트 픽스처값을 부여(오버라이드 계층: 시스템<테넌트<사이트<노드). Run/Workitem 전이 임계, lease TTL·sweeper 주기, 서킷 차단율·윈도우, LLM retry/timeout/budget, 캐시·verify·self-heal 상한, artifact retention·redaction 실패 임계, challenge/resume_token TTL. 외부 사실(모델 maxContextTokens·Codex 스트리밍 범위)만 "구현 시 라이브 확정"으로 잔존.

> 다음: Phase 4(D1 codegen). **→ v1.7로 완료.**

---

## v1.7 패치 로그 (Phase 4 — D1 codegen 산출, 빌드 검증 포함)

> README §"D1에서 함께 산출할 것"을 `codegen/`에 실제 생성하고 **빌드로 검증**. 계약→코드 변환만 수행(새 계약 없음). 7개 산출물을 워크플로우 병렬 생성 후 메인이 통합·전체 검증.

| 산출물 | 내용 | 검증 |
|---|---|---|
| `codegen/types.ts` | ir/verify/event 스키마 → TS 인터페이스(흐름키 union·shell/side_effect 식별 union). core-types 재사용 | tsc strict |
| `codegen/validators.ts` | ajv(2020) + uuid/date-time format 수동 등록으로 3스키마 컴파일, validateIR/Verify/Event. ir→verify $ref 해소 | tsc + agent 14 스모크 |
| `codegen/transitions.ts` | transitionRun/Workitem/HumanTask 완전 구현(R1–R28/W1–W11/H1–H8), 미정의 조합 IllegalTransition, guard 누락 시 silent false 금지 | **전이 fixtures 84/84 PASS**(run-fixtures) |
| `codegen/error-middleware.ts` | ErrorCode→ApiError/HTTP 매핑(47코드), DEAD_LETTER 통지 분리 | tsc strict |
| `codegen/openapi.yaml` | api-surface 22 path → OpenAPI 3.1, ErrorCode 47, $ref 정합 | YAML parse |
| `codegen/asyncapi.yaml` | event-envelope → AsyncAPI 2.6, event_type 31 채널 | YAML parse |
| `codegen/transitions.fixtures.ts` | 전이표 84 케이스(+race/IllegalTransition/side-effect assertion), ops-defaults 픽스처값 | 실행 PASS |
| `codegen/validators.fixtures.ts` | IR/Verify/Event validator 42케이스 + static validation 33케이스 | 실행 PASS |
| `codegen/event-payload-registry.ts` | event_type ↔ payload_schema_ref 매핑 고정. v1 body schema는 closed empty object 결정에 맞춰 검증 | 실행 PASS |

> 검증 하니스: `codegen/{package.json,tsconfig.json}`(typescript/ajv/tsx/@types/node). `npm --prefix codegen run typecheck`(tsc strict EXIT=0, codegen+계약ts 전체) / `run fixtures`(validators 42/42 + static validation 33/33 + transition fixtures 84/84) / `run validators`(42/42 + 33/33). `node_modules/` gitignore. event_type 실측 31종(스키마와 일치, events_outbox CHECK도 31).
> Product Open release gates: authoritative gate list is `release-open-checklist.md`. Local full repeatability with a disposable PostgreSQL 15 cluster is `npm --prefix codegen run ci:local:temp-db`; direct DB smoke is `npm --prefix codegen run db:smoke` with `PSQL_BIN`/PG env, or `npm --prefix codegen run db:temp-smoke` when only local PostgreSQL 15 binaries are installed. DB runbook and CI service-DB details live in `db/README.md`.
> 다음: Phase 5(HTML 목업). **→ v1.8로 완료.**

---

## v1.8 패치 로그 (Phase 5 — HTML 목업 보강, 갭분석 화면·설계 잔여)

> 화면·설계 분석에서 "미적용(설계 결정 필요)"로 남겼던 항목을 `rpa_enterprise_console.html`에 구현. jsdom 런타임 스모크 12/12 PASS.

| 항목 | 구현 |
|---|---|
| 라우팅/딥링크·뒤로가기 | 해시 라우터(`viewFromHash`/`navigate`/`hashchange`). `#viewKey` 딥링크 진입, 브라우저 back/forward, nav는 history 추가 |
| 실시간·마지막 갱신 | topbar `live-dot`(pulse) + `방금 갱신 HH:MM:SS`(`touchUpdated`, 렌더/새로고침 시 갱신) |
| 로딩 표시 | 라우트 전환 시 상단 `route-progress` 바 + `skeleton` 클래스 |
| 빈 상태 | `emptyState()` 컴포넌트 + 실행보드 필터 0건 시 빈 상태 행(`setFilter`) |
| 오류 상태 | `errorState()` 컴포넌트(재시도 버튼 포함, 실 UI용 재사용 패턴) |
| 접근성(누적) | 전역 `:focus-visible`·`prefers-reduced-motion`·modal/drawer 포커스 트랩·아이콘 `aria-hidden`(분석 시 반영) |

> **전체 프로그램 완료**: Phase 1(계약 내부)·2(DDL/RBAC/API)·3(운영 기본값)·4(D1 codegen)·5(HTML 목업). 갭분석 P0~P2 + 외부 의존 맵 + 화면·설계 항목이 본 패키지에 정의·검증·반영됨. Product-open release decision의 권위 목록은 `release-open-checklist.md`의 `Resolved Release Decisions` 섹션이며, 모든 항목은 `release-decisions.md`에 결정값을 둔다.

---

## v1.9 패치 로그 (마감 교차정합 검토 — 적대검증 후 교정)

> 확장 패키지(Phase 1-5)에 4관점 적대검증(17발견·15확정·2기각). Phase 1-5에서 새로 도입된 교차 드리프트를 교정. **재검증: tsc strict EXIT=0, 전이 63/63 PASS(H5 emit 회귀가드 포함).**

| 등급 | 항목 | 조치 |
|---|---|---|
| P1 | `site_profiles.risk` DDL=`yellow` ↔ api-surface/openapi=`amber`(닫힌 enum 분기 — `?risk=amber`가 저장행 매칭 불가) | DDL CHECK를 `('green','amber','red')`로 통일(`amber` 권위) |
| P1 | site 승인 권한거부 코드: auth-rbac=`SITE_PROFILE_BLOCKED` ↔ api-surface=`AUTHZ_FORBIDDEN` | auth-rbac §2/거부규칙을 `AUTHZ_FORBIDDEN`으로 정정(`SITE_PROFILE_BLOCKED`는 런타임 실행차단 전용) |
| P1 | codegen `tsc` 실제 FAIL(`run-fixtures.ts`의 `process` — `@types/node` 누락; v1.7 EXIT=0 주장이 추가 후 거짓이 됨) | `@types/node` + tsconfig `types:["node"]` → tsc EXIT=0 회복 |
| P1 | H5 수동 에스컬레이션이 `human_task.escalated` 미emit → Run R15 미발화(H4b와 비대칭) | transitions.ts H5 3분기 `emitEvent` 추가 + fixture `expectEmits` 회귀가드 |
| P3 | README v1.5/fixtures "event_type 32" 오기재(실측 31) | 31로 정정 |
| P3 | `ajv-formats` dead dependency(validators는 format 수동 등록) | package.json 제거 + README 정정 |

> **기각(2)**: gateway policy If-Match(동일 문서가 optional로 이미 분리), @human_task 입력 kind 3종 vs enum 5종(핸들러 입력 목록 vs 전체 enum — 값 충돌 아님).
> **잔여 P3(추후 폴리시)**: ① codegen/types.ts에 `ValidationReport`/`ValidationIssue` 미생성(ir-static-validation §3) ② transitions.ts R4 `humanTaskKind:"captcha"` 하드코딩(mfa 손실) — state-machine R4에 kind 결정규칙 고정 후 guard 파라미터화 필요 ③ 목업 IR 예시 @end_no_data witness(V7) 부재.

---

## v2.0 패치 로그 (구현 아키텍처 확정 — Stagehand v3, Playwright 제거)

> 구현 청사진을 `architecture.md`(신규)로 고정. **브라우저 드라이버 결정: Stagehand v3 (CDP-native) 채택, Playwright 제거.** 근거(web-verified 2026): Stagehand v3가 Playwright 하드의존을 제거하고 CDP-native 모듈러 드라이버로 전환(복잡 DOM ~44% 개선), Playwright는 `connectOverCDP` 선택 연결만 가능(architecture.md §8 출처).
> 계약 영향: `ts/core-types.ts` 주석 `PlaywrightUtility` → `Utility(CDP)`로 일반화 — `ExecutorPlugin {dom/vision/utility}` 타입·의미는 **불변**(capability 분리는 "LLM vs 결정형"이지 도구 무관). 스택 요약: TS/Node · PostgreSQL 15+ · Graphile Worker · Fastify · ajv · OTel · React+Vite. 빌드순서 D1–D7은 architecture.md §6.

---

## v2.1 패치 로그 (잔여 P3 해소 + D3 PoC 상세)

> v1.9에서 미룬 잔여 P3 3건 해소 + architecture.md §9에 D3 Stagehand v3 PoC 절 추가. **재검증: tsc strict EXIT=0, 전이 63/63 PASS, jsdom 12/12.**

| 항목 | 조치 |
|---|---|
| codegen/types.ts `ValidationReport`/`ValidationIssue` 미생성 | ir-static-validation §3 그대로 추가(`IRValidationRule` V1–V11 + errors/warnings split) |
| transitions.ts R4 `humanTaskKind:"captcha"` 하드코딩(mfa 손실) | `RunEvent.step.challenge_detected`에 `challengeKind?` 추가 → R4가 `ev.challengeKind ?? "captcha"`. state-machine.md R4에 **kind=ChallengeSummary.type(mfa→mfa, else captcha)** 규칙 고정 |
| 목업 IR `@end_no_data` witness(V7) 부재 | observe_reviews에 `empty_result_allowed`(when=`flags.no_review_message_visible`) witness 추가 → V7 정합 |

> architecture.md §9(D3 상세): UtilityExecutor/PageStateResolver 우선 골격 + Stagehand v3 결정형 CDP API **PoC 체크리스트 10항목** + PageState 산출 알고리즘(structuralHash) + 수용기준/폴백(raw CDP). → 갭분석 잔여 P3 0건.

---

## v2.2 패치 로그 (착수 전 Top 5 리스크 종료 — 설계 스코어카드 후속)

> 설계 완성도 스코어카드(8차원 독립채점→캘리브레이션, **84/B+**)의 Top 5 리스크를 사용자 결정대로 전부 종료. **재검증: `npm test`(tsc strict EXIT=0 + 전이 63/63 + validators 10/10), error-catalog union=ERROR_CATALOG=44, openapi/asyncapi YAML 파싱 OK.**

| # | 리스크 | 결정·조치 |
|---|---|---|
| 1 | `on[]` 런타임 무매칭 미정의(조용한 dead-end) | **`IR_NO_BRANCH_MATCHED`(System 예외→재시도)** 신설 — error-catalog + ir-expression §5/§7 + ir-static-validation V3 정적한계 명시. IREL_RUNTIME_MISSING과 동일 원칙 |
| 2 | boundary validators in-repo 미검증 | `codegen/validators.fixtures.ts`(positive/negative 10케이스) + `npm run validators`/`npm test`. **10/10 PASS** |
| 3 | 생성 OpenAPI 인증 스킴 부재 | `securitySchemes.bearerAuth`(JWT) + 전역 `security` 추가(auth-rbac §3) |
| 4 | worker 생존·circuit 영속처 부재 | **`workers` 테이블**(heartbeat·worker circuit, 인프라 비-RLS) + **`site_profiles.circuit_state/until` 컬럼** 신설. auth-rbac §4에 workers RLS 제외 명시 |
| 5 | CLAUDE.md 죽은 경로(line 19) | `_analysis_files_v1_2_patched/README.md` → `README.md`(루트) 교정 |

> 예상 재점수: **84(B+) → ~90(A-)**(스코어카드 가점 합 기준). 정식 재채점은 요청 시 워크플로우 재실행.

---

## v2.3 패치 로그 (정식 재채점 86/B+ 후속 — 검증된 새 5건 종료)

> 정식 재채점(독립 8차원 + 적대 캘리브레이션) **검증 점수 86/B+**(84→86)가 잡은 새 5건 종료. **재검증: openapi ErrorCode enum=error-catalog=44, `npm test`(tsc strict + 전이 63/63 + validators 10/10) PASS, README 잔여 TODO 셀 0.**

| # | 리스크(재채점 검증) | 조치 |
|---|---|---|
| 1 | OpenAPI enum이 `IR_NO_BRANCH_MATCHED` 누락(43 ↔ 카탈로그 44) — v2.2 #1 미전파 | `openapi.yaml` ErrorCode enum +1, 설명 43→44개. **카탈로그=OpenAPI enum=44 불변식 복원** |
| 2 | run_steps DB층 멱등 무제약 | `attempt` 컬럼 + **`UNIQUE(run_id, step_id, attempt)`**(부작용 멱등 `side_effect.idempotency_key`와 계층 분리) |
| 3 | events_outbox 키 테넌트 미스코프 | `UNIQUE(idempotency_key)` → **`UNIQUE(tenant_id, idempotency_key)`**(cross-tenant 충돌 방지) |
| 4 | README 의존맵 산문-표 모순(배너 '해소' vs 셀 'TODO') | §1~§6 배너 전면 해소 명시 + 상태셀 일괄 ✅ 갱신(잔여 TODO 셀 **0**) + §1 주석 갱신 |
| 5 | IREL evaluator 설계 박약(architecture 한 줄) | **architecture.md §10 신설**(수기 재귀하강 파서·컴파일 파이프라인·AST 캐시 위치·런타임 evaluator·모듈 경계) + §3/§6 배치, OTel D2/프론트 outbox-tail 결정 |

> 예상 재점수: **86(B+) → ~90(A-)**. (정식 재채점은 요청 시.)

---

## v2.4 패치 로그 (product-open 정합성 보강 — 계약·스키마·DB·codegen·목업)

> product-open 검토를 막는 교차 드리프트를 재감사해 계약→스키마→DB→TS/codegen→fixture→HTML 목업을 동시 보강. **재검증: `npm --prefix codegen run typecheck`, `run fixtures`(validators 42/42 + static validation 33/33 + transition fixtures 84/84), `run validators`, `npm --prefix codegen test`, HTML 브라우저 콘솔 스모크 PASS.**

| 항목 | 조치 |
|---|---|
| Run/HumanTask 전이 drift | `run.resumed`, R10 drain side effects, R25 terminal abort reject, H7 terminal cancel 차단, R8/R9/R10 exceptionClass guard를 계약·타입·transition fixture에 반영 |
| silent false/unknown 위험 | guard 누락 시 `IllegalTransition`을 강제하고 omitted/wrong-guard fixture 및 exact emit 검증 추가 |
| JSON Schema edge case | IR action closed shape, verify regex/timeout/minLength, idempotency_key 빈 값 차단, params_schema 검증 강화 |
| DB tenant/idempotency/audit | control-plane idempotency, gateway policy version/conflict, site approval audit, artifact soft-delete/RLS redaction gate, tenant composite FK, credential slot trigger 보강 |
| event payload registry | event_type ↔ payload_schema_ref 매핑을 codegen에 고정하고 undocumented payload field 차단. v1 per-event body schema는 closed empty object로 고정 |
| Static validation | V1–V11 deterministic smoke implementation, success_empty witness, signed shell cmd registry, loop-flow BLOCKED 검증 추가 |
| HTML product-open review | tenant/RBAC/redaction/idempotency/audit/gateway policy version/sink key가 목업 화면에 드러나도록 보강 |

> Product-open release decisions의 권위 목록은 `release-open-checklist.md`의 `Resolved Release Decisions` 섹션이다. 새로운 미결정이 생기면 추측하지 않고 `TODO: [BLOCKED]`와 `Required decision:`으로 남긴다.

---

## v2.5 패치 로그 (D4 착수 — authn/authz 분리: `UNAUTHENTICATED`(401) 신설)

> D4(제어평면 API) 빌드 중 발견한 계약 공백을 교정. 기존 error-catalog는 **인증 미성립**(Bearer 토큰 누락/서명 무효)과 **인가 거부**(역할/tenant 권한 부족)를 모두 `AUTHZ_FORBIDDEN`(403) 하나로만 모델링했다 — HTTP 의미상 전자는 401이 정확하며, `security-middleware-contract.ts`의 `AuthFailureCode`도 403만 표현해 인증 경계가 401을 반환할 수 없었다. `api-surface.md §0.2`("모든 4xx/5xx 본문=ApiError", "httpStatus는 카탈로그 그대로")가 401을 강제하지 못하게 막던 구조이므로, 카탈로그에 코드를 신설해 정합을 회복했다. **재검증: `npm --prefix codegen run test`(typecheck + fixtures 84 + validators + consistency: OpenAPI ErrorCode enum=ERROR_CATALOG=46) PASS.**

| 항목 | 조치 |
|---|---|
| 인증/인가 코드 분리 | `ts/error-catalog.ts`에 **`UNAUTHENTICATED`(retryable=false, httpStatus=401, security)** 신설. 인증 미성립=401, 인증됐으나 권한/테넌트 부족=403(`AUTHZ_FORBIDDEN`) |
| 미들웨어 경계 타입 | `ts/security-middleware-contract.ts` `AuthFailureCode`를 `UNAUTHENTICATED \| AUTHZ_FORBIDDEN`로 확장 — `AuthenticationBoundary`가 401/403을 모두 표현 |
| codegen 정합 | `codegen/openapi.yaml` ErrorCode enum에 `UNAUTHENTICATED`(401) 추가, `bearerAuth` 설명에 401/403 분기 명시. `contract-consistency.ts`의 enum=ERROR_CATALOG 불변식 유지(절대 개수는 이후 Product Open 커밋에서 계속 변동하므로 본 행은 고정 수치를 단언하지 않는다) |
| 산문 SSoT | `api-surface.md §0.1`·`auth-rbac.md §3/§5`에 authn(401)/authz(403) 분기 명시 |
| 참조 스캐폴드 정합 | `control-plane/fake-request-runner.ts`의 토큰 누락 분기를 `UNAUTHENTICATED`로 정렬, `codegen/control-plane.fixtures.ts`에 401 경로 단언 추가 |

## v2.6 패치 로그 (D4.1 제어평면 미분류 예외 카탈로그화)

> 제어평면 Fastify 경계에서 임의 throwable을 raw 500으로 흘리지 않고 `CONTROL_PLANE_INTERNAL_ERROR`(500, system)로 매핑한다. 원본 error/details는 로그에만 남기고, 응답은 `ApiError` + `correlation_id`로 고정한다. **재검증 대상: OpenAPI ErrorCode enum=ERROR_CATALOG=47.**

| 항목 | 조치 |
|---|---|
| 미분류 예외 응답 | `app/src/api/errors.ts`가 unknown throwable을 catalog-backed `CONTROL_PLANE_INTERNAL_ERROR`로 변환 |
| ErrorCode 정합 | `ts/error-catalog.ts`와 `codegen/openapi.yaml`에 `CONTROL_PLANE_INTERNAL_ERROR` 추가 |
| 산문 SSoT | `api-surface.md §0.2`에 미분류 제어평면 예외의 로그/응답 경계 명시 |

## v2.7 패치 로그 (D4.2 RBAC 경계 + Node 24 CI)

> D4.2 제어평면 RBAC 미들웨어를 `auth-rbac.md §2` 매트릭스에 맞춰 배선하고, Product Open contract gates를 Node 24 Actions 런타임으로 전환했다. **재검증 대상: RBAC unit/integration, `ci:local:temp-db`, GitHub Actions Contract Gates.**

| 항목 | 조치 |
|---|---|
| RBAC 매트릭스 | `app/src/api/rbac.ts`에 `RoleMatrixRbacMiddleware` 추가. 역할별 허용 액션은 `auth-rbac.md §2`를 미러링하고 미허용/tenant mismatch는 `AUTHZ_FORBIDDEN`으로 fail-closed |
| 제어평면 배선 | `app/src/api/server.ts`가 auth 이후 `rbacAction`을 평가. `GET /v1/runs/{run_id}`는 `run.read`; 매칭 라우트의 `rbacAction` 누락은 403, 미매칭/미지원 메서드는 404 `RESOURCE_NOT_FOUND` |
| 회귀 테스트 | `app/test/rbac.unit.ts`와 `app/test/api-runs.int.ts`로 역할 합집합, 빈 역할 거부, tenant mismatch, fail-closed, 404/403 경계를 검증 |
| Node 24 CI | `.github/workflows/contract-gates.yml`의 `NODE_VERSION=24`, `actions/checkout@v5`, `actions/setup-node@v5` 적용. CRLF에서도 AsyncAPI 문자열 fixture/consistency가 동일하게 동작하도록 줄끝 정규화 |

## v2.8 패치 로그 (D6 — Pipeline/Sink + outbox 소비, 데이터평면 멱등/DLQ)

> architecture.md §6 D6를 빌드했다. raw→normalized→sink 데이터 파이프라인의 **DB측 멱등/dedup/DLQ 메커니즘**과
> outbox 발행 순서/중복 보증을 구현·검증한다(전부 결정형, `app/` 내). 실 외부 sink 네트워크 전송은 외부 사실
> 경계라 주입형 포트(real_sink|test_fake)로 분리하고 기존 외부 object-store/SecretStore 블로커에 귀속한다. 계약은
> 새 결함 교정이 아니라 D6 런타임이 요구하는 표면(런타임 포트·sink 임계)을 in-pattern으로 확장한 것이다.
> **재검증: `npm --prefix app run typecheck`·`test:unit`(+raw-hash) + temp-PG `test:int`(pipeline/sink-delivery/outbox-relay/api-reads), `npm --prefix codegen run typecheck`.**

| 항목 | 조치 |
|---|---|
| raw 멱등 인입 | `app/src/runtime/pipeline/raw-hash.ts`(FIX#6 canonicalization: 키정렬·NFC·volatile 제외) + `raw-ingest.ts`(`ON CONFLICT DO NOTHING`, NULLS NOT DISTINCT dedup, `pipeline.raw_persist` span). RAW_PERSIST_FAILED는 호출측 매핑 |
| 정규화 | `normalize.ts`(자연키 UNIQUE dedup + `dedup_action` insert/keep_existing/update_latest/merge, 재처리 멱등) + `pipeline.stage.completed` 발행(닫힌 빈 payload) |
| sink 전달 | `sink-delivery.ts`(claim→port→finalize: `sink_idempotency_key=tenant:sink_config:schema_ref:natural_key`(attempt_no 제외)·attempt 원장·status CAS pending→delivered/failed/dead_letter·`sink.delivered`/`sink.dead_lettered`). 주입형 `SinkDeliveryPort`(real_sink|test_fake) + `SinkDeliveryPolicy`를 `ts/runtime-contract.ts`에 추가 |
| sink 임계 | `ops-defaults.md#sink.delivery`(max_attempts/retry_backoff/sweeper) 신설 — workitem retry family 정렬(release-decisions D6-1). 코드 상수 금지, 정책 주입 |
| sink DLQ 목록 | `app/src/api/reads.ts` `GET /v1/dlq?kind=sink` → `sink_deliveries.status='dead_letter'` 실 조회(이전 빈-페이지 placeholder 대체). DEAD_LETTER 상태 통지(ApiError 아님), 커서/RLS |
| outbox 소비 | 기존 `relayOutbox`(published_at CAS, created_at 순)에 순서/중복 회귀테스트 추가(at-least-once + 재발행 0) |
| worker 잡 | `RuntimeWorkerJob.kind`에 `sink_deliver` 추가 + `PgRuntimeWorker.handleSinkDeliver`(포트/상한 fail-closed, test_fake opt-in). `runtime/fake-store.ts` 닫힌 union 정합 |
| 연기(release-decisions D6-2~4) | 실 sink egress(외부, 기존 블로커 귀속) · sink-DLQ replay 라우팅(api-surface 모호) · checkout-expiry W6/W7 + W9/W11 pause-TTL(미고정 공식) — D6 코어 비의존, 추측 빌드 금지 |

## v2.9 패치 로그 (D3 가동 2단계 — site-profile PageState 영속화)

> D3 실행기 가동 2단계: PageStateResolver의 dry-run 마커(`d3-dryrun-v1`) 제약을 **사이트별 셀렉터 설정**으로 대체해
> 마커 없는 실 사이트에서도 닫힌 레지스트리 6 flags를 산출한다(위저드가 만든 실 URL 시나리오 가동의 토대). 실행 모델은
> run당 site_profile 1개(`BrowserLeasePlan.siteProfileId`)이므로, 그 site_profile이 해당 사이트의 PageState 산출 규칙의
> 진실원천이다. 계약은 새 결함 교정이 아니라 D3 런타임이 요구하는 **표면(site_profile에 PageState 설정 영속)** 을
> in-pattern(기존 `gateway_policies.capabilities` jsonb 설정 컬럼과 동형)으로 확장한 것이다.
> **재검증: `npm --prefix app run typecheck`·`test:unit`(+site-page-state-config) + temp-PG `test:pipeline-site`(DB 라운드트립)·`test:site-resolver`(실 Chrome), `node scripts/db-static-smoke.mjs`·`contract-lint.mjs`.**

| 항목 | 조치 |
|---|---|
| 계약 컬럼 | `db/migration_core_entities.sql` `site_profiles.page_state_selectors jsonb`(nullable) 신설 — `SitePageStateConfig`(authenticatedWhen?·flags{닫힌 6키: present/absent/min_count}) 영속. null=미설정 → 비-마커 실행 시 `PAGE_STATE_UNRESOLVED`(조용한 all-false 금지) |
| resolver | `app/src/executor/site-page-state-resolver.ts` `SitePageStateResolver` — 마커 대신 셀렉터→flag 규칙으로 닫힌 6키 산출(미지정=false 명시 결정). config 무매칭은 인터프리터 `IR_NO_BRANCH_MATCHED`로 표면화 |
| 로더 | `app/src/executor/site-page-state-config.ts` `parseSitePageStateConfig`(jsonb 엄격 검증·무효→`PAGE_STATE_UNRESOLVED`) + `loadSitePageStateConfig`(run의 site_profile에서 로드, RLS tx) |
| dev 배선 | `app/dev/run-loop.ts`가 DB site_profile의 page_state_selectors 로드해 resolver 구성, `serve.ts`가 데모 site_profile + 마커 없는 실 URL풍 FIXTURE 시드 — 콘솔 '실행'이 마커 없는 페이지에서 completed |
| 연기 | run별 site_profile 해소 실구현(`BrowserLeasePlanResolver` 포트, 현 dev는 단일 사이트) · url_ref/schema_ref 해석 · NetworkPolicy 도메인 허용목록 강제 · 예약핸들러(@end_no_data/@challenge) — D3 가동 코어 비의존 *(run→site dev 해소는 v2.10, url_ref params 해소는 v2.11에서 구현; 아래 참조)* |

## v2.10 패치 로그 (D3 가동 2단계 — run→site_profile 해소: 멀티사이트)

> v2.9의 단일-사이트 dev 가정을 풀어, **서로 다른 사이트를 가리키는 시나리오가 각자 맞는 site_profile로 해소**되게 한다.
> 계약은 runs/scenario_versions에 site 링크를 두지 않고(런타임 해소가 설계 의도) `site_profiles.url_pattern`("사이트
> 식별 패턴")만 가지므로, run의 시나리오 **entry navigate URL의 origin**을 url_pattern에 매칭해 단일 site_profile을 고른다.
> **확정한 매칭 규칙(이전엔 미명시)**: `url_pattern` 매칭은 `URL.origin`(scheme://host:port) 동일성 — 경로/glob 접미사는
> run→site 선택에서 무시(URL.origin이 정규화하므로 저장형식 origin/full-URL/`/*` 모두 동작). 같은 origin 다중 매칭 =
> config 오류로 loud(SQL LIMIT 임의선택 금지). 이는 BrowserLeasePlanResolver **프로덕션 포트**의 본체가 될 재사용 함수의
> dev 절반이다(브라우저 풀 페어링 절반은 계속 연기 — 풀 미구축).
> **재검증: `test:unit`(+site-resolution) + temp-PG `test:multisite`(2 origin/2 셀렉터셋/2 시나리오→각자 completed + 0-match/ambiguity loud, 실 Chrome).**

| 항목 | 조치 |
|---|---|
| 해소 함수 | `app/src/runtime/site-resolution.ts` — `extractEntryNavigateUrlRef`(ir.start BFS: next+on[].target, 첫 navigate; 부재→IR_SCHEMA_INVALID) + `resolveSiteProfileId`(origin 매칭, 후보 전부 앱측 비교; 0-match→SITE_PROFILE_UNRESOLVED, 다중→SITE_PROFILE_AMBIGUOUS) |
| 조용한 false 금지 | (v2.10 시점) symbolic url_ref는 `URL_REF_SYMBOLIC_UNRESOLVED`로 loud. **→ v2.11에서 url_ref=params 키로 해소하도록 대체**(resolveUrlRef); 이 가드는 방어적 불변식으로만 잔존 |
| dev 배선 | `run-loop.ts`가 run별로 `extractEntryNavigateUrlRef→resolveSiteProfileId→loadSitePageStateConfig→SitePageStateResolver` 구성(시작 시 단일 resolver 제거), `serve.ts` `startRunLoop`에서 고정 site 인자 제거·데모 url_pattern을 canonical origin으로 |
| 연기(좁힘) | v2.9의 "run별 site_profile 해소 실구현" → **프로덕션 `BrowserLeasePlanResolver`(브라우저 풀 페어링) 실구현**으로 축소(dev 해소는 구현됨). 시나리오 내 멀티-오리진은 entry만 바인딩(연기). 카탈로그 ErrorCode化(SITE_PROFILE_UNRESOLVED 등)는 프로덕션 포트와 함께(현재 dev 로컬 `SiteResolutionError`) |

## v2.11 패치 로그 (D3 가동 2단계 — url_ref → URL 해소: params 바인딩)

> v2.10까지 url_ref는 리터럴 절대 URL을 가정했다(symbolic은 `URL_REF_SYMBOLIC_UNRESOLVED`로 연기). 이 증분은 그 연기를
> 풀어, **위저드/템플릿이 만든 파라미터 시나리오**(예: 주문 URL을 실행 시 입력)를 실제로 구동되게 한다.
> **확정한 해석 규칙(이전 미명시)**: `navigate.url_ref`는 **run params의 키**다(`runs.params` jsonb, params_schema 검증
> 대상이자 IREL `params.*` 입력 스코프와 동일 출처). `resolveUrlRef(url_ref, params)` = `params[url_ref]`이고 그 값은
> 절대 URL이어야 한다. **params-key-only**(fallback 없음 — 키 자체를 URL로 취급하는 조용한 coercion 금지). 같은 함수의
> 결과가 site-match(origin)와 실행기(navigate)에 동일하게 쓰여 드리프트가 없다. 리터럴 URL은 "이미 URL인 params 값"일 뿐.
> **재검증: `test:unit`(+site-resolution resolveUrlRef·ir-translate 경계) + temp-PG `test:multisite`(같은 IR 키 `entry_url`이 run별 params로 다른 origin→다른 site→completed)·`test:pipeline-site`·`test:pipeline-run`·`test:run-step-driver`.**

| 항목 | 조치 |
|---|---|
| 해석 함수 | `app/src/runtime/site-resolution.ts` `resolveUrlRef(rawRef, params)` — `params[rawRef]` 가 절대 URL. 키 부재→`URL_REF_PARAM_MISSING`·비문자열→`URL_REF_PARAM_NOT_STRING`·빈값→`URL_REF_PARAM_EMPTY`·비-절대URL→`URL_REF_VALUE_NOT_ABSOLUTE_URL`(전부 loud) |
| 스레딩 | `run-loop`가 `runs.params` 로드 → `resolveUrlRef(extractEntryNavigateUrlRef(ir), params)`로 entry URL 산출 후 origin-match(해소가 origin 추출보다 선행); `run-step-driver.ClaimedRun.params` → `compiledScenarioFrom(ir, ast, params)`가 navigate.url을 동일 함수로 해소 |
| 에러 경계 | `compiledScenarioFrom` 내 `SiteResolutionError(URL_REF_*)`는 `InterpreterError`로 환원(타입 경계 — untyped 누출 금지). `resolveSiteProfileId`의 비-절대URL 가드는 방어적 불변식으로 잔존(해소 누락 호출측 버그 표면화) |
| migration | url_ref 리터럴을 쓰던 시드/테스트(serve 데모·run-pipeline·pipeline-site·multisite·run-step-driver)를 `url_ref:"entry_url"` + 각 run의 `params.entry_url`로 이전. serve는 **queued 데모 run을 params와 함께 시드**(부팅 시 run-loop가 구동) |
| 콘솔 params 입력 | `web` 콘솔의 '실행'은 시나리오 IR에서 navigate `url_ref` 키를 도출(`getScenario`→`extractUrlRefKeys`)해 **키별 입력 폼**(`RunScenarioButton`)을 띄우고 그 값으로 `createRun(params)`. 키 없으면 추가 입력 없이 실행. (params_schema 기반 타입 폼·기본값은 후속 — 현재 url_ref 키 = 운영자 입력 URL) |
| 연기 | **`params.*` in `on[].when`/`loop.until`**: 인터프리터가 평가 스코프에 `{flags}`만 주입 → params 분기 조건은 여전히 `IREL_RUNTIME_MISSING`(이번 url_ref 해소가 이를 배선하지 않음 — 별도 증분). IREL-expression url_ref(예: `concat(params.host,'/p')`)·`schema_ref` 해석·`URL_REF_*` 카탈로그 ErrorCode化도 연기 |

## v2.12 패치 로그 (검토 후속 — IREL §3↔§5 내부 모순 교정: null 수치 비교는 fail-loud)

> 검토(review-qa-admin 미션, OPEN ISSUES RQ-009)가 잡은 **검증된 내부 모순** 1건 교정. `ir-expression.md §3`은
> "산술/비교 피연산자가 null이면 `false`로 단락"이라 했으나, `§5`("평가 실패 처리")와 "조용한 false 금지" 불변,
> 그리고 실 evaluator(`codegen/irel-compile.ts` `expectRuntimeNumber`)는 모두 **null/부재 수치 피연산자를
> `IREL_RUNTIME_MISSING`(System 예외 → 재시도)으로 표면화**한다. §3을 코드/§5에 맞춰 교정(코드 변경 없음 — 문서만
> 정합). null 동등성은 여전히 `== null`/`!= null`로만 명시. 정상 경로는 타입체커가 null 수치 피연산자를 차단하므로
> 이 경로는 런타임 데이터 불일치 시에만 도달. 기존 fixture(runtime evaluator throws on missing scope)가 fail-loud
> 불변을 이미 검증한다. **재검증: contract-lint(66) + codegen consistency green.**

## v2.13 패치 로그 (D3 가동 3단계 증분1 — LLM dom act/extract 인터프리터 배선)

> 이미 빌드·단위검증된 `StagehandDomExecutor`(act→CDP mutation, extract→parsedJson)를 **인터프리터 실행 경로에 연결**한다.
> 두 가지: (1) `ir-translate`가 act/extract 를 ACTION_UNSUPPORTED로 막던 것을 풀어 `StagehandDomExecutor`가 받는
> DomAction 형태로 매핑; (2) 얇은 `CompositeExecutor`가 단일 ExecutorPlugin 제약 하에서 action.type 으로
> navigate→Utility, act/extract→Dom 라우팅. 라이브 LLM(Codex)은 사용자 자격증명 의존이라 이 환경 미실행 — fake
> `LlmGatewayCaller`로 **인터프리터→composite→dom→CDP 배선**을 offline 검증(act 가 실 Chrome 페이지를 실제 fill).
> 설계는 워크플로(조사4+종합+적대검증)로 확정. **재검증: `test:unit`(ir-translate act/extract 매핑) + 실 Chrome
> `test:interpreter-llm`(navigate→act(실 CDP)→extract→on[]→completed + node.* loud) + `test:executor` 회귀.**

| 항목 | 조치 |
|---|---|
| translate | `ir-translate.ts` mapAction에 act/extract 분기. act.instruction 필수, sideEffect는 **node 레벨 side_effect.kind에서 소싱**(IR에 action-level 없음 — 미지정 시 생략→실행기 기본 'update'). extract: schema_ref→schemaRef, schemaVersion/strict는 **args(typo-safe 슬롯)에서 명시 소싱**(기본 v1/strict=true — 미스매치 시 loud EXTRACT_SCHEMA_INVALID). 가정 금지: 버전드 schema_ref 메타 레지스트리 미발명(후속) |
| composite | `composite-executor.ts` `CompositeExecutor` — action.type 라우팅(dom: act/observe/extract; utility: navigate/download/upload; 미지원/garbage→utility의 타입화 throw). 디스패처는 에러처리 없음(각 실행기 typed throw/StepStatus 그대로 전파). capabilities=union |
| 검증 | `test:interpreter-llm`(offline, fake gateway, 실 Chrome) — act가 #q를 실제 fill(composite→dom→CDP 증명), extract success, completed; **on[] node.* 참조→IREL_RUNTIME_MISSING**(flags-only 스코프 loud 단언) + `ir-translate.unit` act/extract 매핑 6케이스 |
| 연기(명시) | **node.* on[]/loop 스코프(OPEN ISSUES RQ-002, P1 correctness)**: 인터프리터가 {flags}만 주입 → extract 데이터로 분기 불가(StepResult→{row_count,status,extracted_ref,tier} 투영이 계약 미명시 — 가정 금지). extract는 1단계서 **실행·StepResult.extracted 부착만**(분기 불가). **라이브 gateway 조립**(LlmGatewayDeps=gate+idempotency+sink+validator+adapter+transport — 무거움, 자격증명 필요): dev 루프는 utility-only 유지(act/extract는 EXECUTOR_CAPABILITY_MISMATCH로 loud), composite+라이브 gateway 배선은 별도 증분. **redaction §4**(RQ-003) · dom-observe · sensitive/vars · loop/fallback · download/upload translate · fail_* terminal 전이도 연기 |

## v2.14 패치 로그 (RQ-002 부분 — on[] 스코프에 params + node.status 배선)

> RQ-002(인터프리터가 on[] 스코프에 `{flags}`만 주입 → 계약상 허용된 params/node 참조가 실행 불가)의 **충실히 도출 가능한
> 부분**을 배선한다. 설계는 워크플로(조사3+종합+적대검증)로 확정 — 4개 node 출력 필드 중 **status만 StepResult.status로
> 단일출처 투영 가능**, 나머지(extracted_ref/row_count/tier)는 StepResult→필드 투영이 계약 미명시라 **연기**(가정 금지).
> **재검증: `test:unit`(interpreter-scope 5케이스: params 분기·node.status·부재노드·미투영필드 loud) + `test:executor`·`test:pipeline-site` 회귀.**

| 항목 | 조치 |
|---|---|
| 배선 | `ir-interpreter.ts` selectOnBranch 스코프 `{flags}` → `{flags, params: deps.params, node: nodeScope}`. `InterpreterDeps.params` 추가, `run-step-driver`가 run.params 주입(navigate url_ref 해소와 동일 출처). nodeScope는 what 루프 직후 무조건 `{status: lastStatus}` 기록(빈 what[] 노드는 미기록) |
| 필드 투영 | **status만 INCLUDE**(StepResult.status 단일출처). extracted_ref(outputRef/artifacts[0]/extracted 셋 다 가능·권위 없음)·row_count(StepResult에 필드 부재)·tier(fallback 미구현)는 **DEFER** — 미투영 필드 참조는 IREL_RUNTIME_MISSING(loud) |
| 정직한 공개 | (1) **compile-then-throw**: `node.X.row_count` 등은 V9가 허용해 컴파일되나 런타임에 IREL_RUNTIME_MISSING — 의도된 조용한-false-금지 동작(결함 아님). (2) **graph-ancestor ≠ executed**: diamond DAG에서 분기로 건너뛴 ancestor의 node.X.status 참조는 컴파일되나 런타임 loud. (3) **status는 현재 항상 'success'**(실패/suspend는 flow 전 short-circuit) — failure-continuation 전까지 status 분기는 저효용 |
| 연기(잔존) | node.{extracted_ref,row_count,tier}(투영 계약 미명시) · cursor.*·loop.until(loop 미구현) · 실패-연속 status. RQ-002는 **부분**(status+params) — 잔존 필드/네임스페이스는 계약 투영 결정 후 |

## v2.15 패치 로그 (RQ-017 — 인터프리터 graph-step 상한의 ops-defaults 출처화)

> RQ-017(인터프리터 `maxSteps` 기본 200이 하드코딩·ops-defaults 미연동)을 해소한다. **값 변경 없음**(200 동일) —
> 계약 충실도 정정: ops-defaults.md가 "계약 본문이 비워둔 수치의 기본값 SSoT"(§intro)이므로 graph-step 상한을 그곳에
> 정의하고, 코드는 다른 모든 ops-defaults 소비자(codex-sse-adapter·llm-gateway·outbox·sink-delivery)와 동일한
> **inline-value + `// ops-defaults §5` 인용** 규약으로 연결한다. 결정 근거는 release-decisions.md **D8-A7**.
> **재검증: `contract-lint`(66) + `app run typecheck` green + ops-defaults 값(200) ↔ `DEFAULT_MAX_STEPS`(200) 일치(무회귀).**

| 항목 | 조치 |
|---|---|
| 계약(SSoT) | `ops-defaults.md §5`에 `interpreter.graph_max_steps`(기본 200) 행 추가. **`loop.max_iterations`(10000, loop body 전용)와 명시 구분** — 이건 시작→terminal 총 노드 순회 상한. 초과 시 `InterpreterError("IR_LOOP_LIMIT")`(조용한 무한루프 금지) |
| 코드 인용 | `ir-interpreter.ts`: `InterpreterDeps.maxSteps` 주석 + `DEFAULT_MAX_STEPS` 위 `// ops-defaults §5` 인용(값 200 불변, 환경 오버라이드=`deps.maxSteps`). "ops-defaults 연동은 후속" 주석 제거 |
| 결정 기록 | `release-decisions.md D8-A7`(zero-behavior-change alignment, 값 비발명 — 기존 가드를 추적가능화) |
| 범위 한정(YAGNI) | 값 불변이라 동작 회귀 없음 → 기존 인터프리터 int 테스트가 기본 상한(200) 경로를 이미 암묵 검증. 중앙 config 모듈 신설 안 함(repo 규약=inline+인용) |

## v2.16 패치 로그 (RQ-002 후속 — extract row_count/extracted_ref 투영: `{rows}` 봉투 규약 확정)

> v2.14의 잔존(node.<id> 표준출력 중 status만 투영)을 풀어 **extract 데이터로 분기**(`node.<id>.row_count`)되게 한다.
> v2.14에서 미정이던 **StepResult→node 표준출력 투영 규약을 확정**(운영자 결정): extract 출력은 LLM 구조화 출력(루트
> object — strict json_schema는 루트 배열 불가)이므로 행 컬렉션을 표준 필드 **`rows`**로 담는다(`{rows:[...]}` 봉투).
> `row_count = output.rows.length`, 같은 `rows`를 verify `min_rows`도 카운트(단일 규약). `extracted_ref = extract
> StepResult 출력 아티팩트(artifacts[0])`. 계약 기록: `ir-expression.md §2`에 투영 규약 명시.
> **재검증: `test:unit`(interpreter-scope 8: row_count 값-분기·extracted_ref·비-extract 미투영 loud; dom-executor rowCount) + 실 Chrome `test:interpreter-llm`(extract {rows:[1,2,3]}→row_count=3→분기→done) + `test:pipeline-site` 회귀.**

| 항목 | 조치 |
|---|---|
| 계약 결정 | `ir-expression.md §2`: extract 출력 봉투 `{rows:[...]}` 표준화(루트 object 제약). `row_count`←`output.rows.length`, `extracted_ref`←extract 출력 아티팩트, `status`←StepResult.status. verify `min_rows`도 동일 `rows` 카운트(단일 규약) |
| 실행기 | `stagehand-dom-executor.ts` extract가 `output.rowCount = parsedJson.rows.length`(rows 배열 있을 때) 산출. rows 부재 → 미산출(미투영) |
| 투영 | `ir-interpreter.ts` `projectNodeOutput(StepResult)` — extract 액션만 row_count(`output.rowCount`)·extracted_ref(`artifacts[0]`) 추가. 비-extract/rows 부재 → 미투영 → 참조 시 IREL_RUNTIME_MISSING(loud, ir-expression §2) |
| 잔존(축소) | `tier`(fallback 미구현)·`cursor.*`/`loop.until`(loop 미구현) — **계약 미정이 아니라 feature 의존**(fallback/loop 구현 시). 실패-연속 status도 후속 |

## v2.17 패치 로그 (RQ-010 — GET /v1/artifacts/{id} 라우트 빌드: D8-A1 RLS redaction-gate)

> RQ-010(GET /v1/artifacts/{id} 미구현 → 전 역할 artifact 조회 capability 도달 불가)의 **라우트를 in-repo 빌드**한다.
> 계약 결정은 이미 D8-A1(pending⇒404, existence non-disclosure; 409 미노출). 빌드 시 **api-surface §5를 v1 404 동작으로
> amend**(D8-A1 "when built" 약속 이행). 본문은 injected `ArtifactObjectReader`(ObjectStore.get)로 read — in-repo/CI는
> `FsObjectStore`, 실 **분산 object-store(S3) 바인딩은 deploy-time(B3)**. RQ-011(sink egress)·outbox real-bus와 동일 posture.
> **운영자 artifact-read capability 도달 = 원 finding 해소.** 실 분산 바인딩만 BLOCK 잔존.
> **재검증: `app/test/api-artifacts.int.ts` 12(redacted/not_required 200+본문·viewer artifact.read 200·pending/failed/quarantined/deleted/cross-tenant/absent/invalid 404) + app typecheck·contract-lint·full test:int(temp PG) green.**

| 항목 | 조치 |
|---|---|
| 라우트 | `app/src/api/reads.ts` GET `/v1/artifacts/:id`(rbacAction `artifact.read`). RLS(`artifacts_visible_isolation`)가 redaction 게이트 — redacted/not_required·미삭제·비격리만 가시 → pending/failed/quarantined/deleted/cross-tenant ⇒ `RESOURCE_NOT_FOUND`(404, BYPASSRLS 미사용). 200 본문 = object store read |
| read 경계 | `ObjectStore`에 `get(objectRef)` 추가(FsObjectStore=readFileSync, 경로 이탈 가드). api는 narrow `ArtifactObjectReader`(server.ts)에만 의존(단방향 의존) — `ApiServerDeps.artifactStore?` 주입; 미주입 시 라우트 미등록 |
| 계약 정합 | api-surface §5에 v1 404 노트 추가(409는 SECURITY DEFINER 메타-read 필요 → 연기). release-decisions D8-A1에 Built 노트 |
| 잔존 BLOCK | 실 **분산 object-store 바인딩(S3, 프로세스 간 공유, B3)** = deploy-time/external. in-repo/CI는 FsObjectStore로 완결 |

## v2.18 패치 로그 (RQ-016 — challenge suspension 포트 구현 + `runs.bookmark` 컬럼 신설)

> RQ-016(`ExecutorChallengeSuspensionPort` 미구현 → `human_task.created` producer 부재, 레지스터 BLOCK)의 **포트 구현체를
> in-repo 빌드**한다. coordinator가 R4(running→suspending) 적용 후 호출하는 포트가 공급된 tenant tx 안에서 `human_tasks` row
> 생성(kind = `createHumanTask.humanTaskKind`, 하드코딩 아님) + `human_task.created` 발행(닫힌 빈 payload) + suspend bookmark 영속.
> **계약 변경**: `startBookmark` side-effect의 저장 대상이 없던 것을 **전용 `runs.bookmark` jsonb 컬럼** 신설로 닫는다 —
> `resume_token`과 **분리**(bookmark = 재개지점 마커 `{stepId,attempt,reason}`, resume_token = 서명 봉투 kid/hmac). resume-token
> 발행(R11, HMAC 서명키 = SecretStore/KMS deploy-time)은 보류(운영자 지시).
> **도달성(은폐 금지)**: 포트가 호출되는 `PgExecutorCompletionCoordinator` 경로는 현재 production 미배선(테스트만 인스턴스화) —
> 본 패치는 RQ-016 **포트 구현 gap**을 닫되, production run의 human_task 생성은 ①coordinator 경로 재배선 + ②resume-token이
> 별도 후속(없으면 run 'suspending' 잔류). **두 run-완료 경로**(production `driveClaimedRun`(run-step-driver.ts) vs 휴면
> `PgExecutorCompletionCoordinator`) reconciliation은 미결 설계 결정으로 잔존.
> **재검증: `app/test/challenge-suspension-port.int.ts` 11(captcha/mfa kind 전파·human_task.created·runs.bookmark·음성 pending 부재 throw·tx 롤백) + `executor-invocation-recorder.int` 무회귀 + tsc·Contract Gates green(main `bec0018b`).**

| 항목 | 조치 |
|---|---|
| 포트 | `app/src/runtime/challenge-suspension-port.ts` `PgChallengeSuspensionPort` — additive(신규 클래스, `executor-completion-coordinator.ts` 미편집·인터페이스만 import). 공급 tx에서 human_tasks INSERT + human_task.created emit + runs.bookmark UPDATE. run 재전이 안 함(R4는 호출 전 적용, coordinator 소유) |
| 계약(DDL) | `db/migration_core_entities.sql` runs에 `bookmark jsonb` 컬럼 신설(nullable). `startBookmark`(R4/R5 side-effect) 영속 대상. resume_token과 분리 |
| 가드 | createHumanTask/startBookmark pending 부재 → loud throw(조용한 false 금지). bookmark UPDATE `rowCount≠1`(run 부재/테넌트 불일치) → throw |
| 잔존 | resume-token(R11, KMS) · coordinator 경로 production 재배선 · `@human_task`(R5) IR 노드 경로 = 후속 증분. 레지스터 RQ-016 재분류(BLOCK→부분)는 별도 |

## v2.19 패치 로그 (Gap2 — 자동 run의 model 출처 명시: `runs.model` + `gateway_policies.is_default`)

> **검증된 내부 모순 해소**(신기능 아님). `StagehandDomExecutorConfig.model`은 DOM/LLM step 실행에 필수이고
> (`app/src/executor/stagehand-dom-executor.ts`) `action_plan_cache` UNIQUE 캐시 키의 결정 요소이며
> (`pg-action-plan-cache.ts`) Gateway capability 검사 입력이다(llm-gateway-adapter §1). 그러나 `gateway_policies`는
> `UNIQUE(tenant_id, model)`로 테넌트당 다수 model 행을 허용하면서 primary/default 표지가 없고, `runs`·`scenario_versions`·
> `ir.meta` 어디에도 model 출처가 없어 — 테넌트가 다정책을 보유할 때 자동 run이 어느 model로 시작하는지 계약에 부재했다.
> "조용한 임의선택 금지" 규율상 silent 임의선택만이 유일한 비-차단 경로인 모순 상태였다.
> **해소(오너 결정 2026-06-17, B+C)**: model을 run-create 시 `runs.model`로 1회 해소·동결(`as_of` 동형 결정성).
> `POST /v1/runs`에 optional `model`, 무인 run은 테넌트 `gateway_policies.is_default`(부분 UNIQUE로 ≤1)로 해소.
> 다정책+미지정+default 부재는 `model_required` loud 거부(GET /v1/gateway/policy 다건 규약 동형). **IR/scenario_version 무변경**
> (model은 실행 엔진 선택이지 시나리오 명세가 아님 — 런타임 해소 결정과 정합). model↔capability 정합은 call-time
> `SafeCapabilityGate`(불변)가 fail-closed로 최종 차단(create-time 정적 사전대조는 후속 증분, `server.ts` TODO로 표면화).
> **신규 ErrorCode 미도입**(error-catalog closed registry) — 기존 `IR_SCHEMA_INVALID`(`model_required`)·`RESOURCE_NOT_FOUND` 재사용.
> 설계 기록: `mfa-dom-drive-design.md` Part 5. **검증: tsc(app)·db-static-smoke green + 적대 리뷰(wf, 19 findings → confirmed: is_default ETag 버그 1·테스트갭).
> int 테스트 작성(`api-runs-model.int.ts` 7케이스 해소매트릭스·동결 + `api-gateway.int.ts` is_default 토글/version-bump) — temp PG 실행은 CI/owner.**

| 항목 | 조치 |
|---|---|
| 계약(DDL) | `db/migration_core_entities.sql`: `runs.model text`(nullable; FK 금지 — 자연키 복합 `(tenant,model)` + 정책 삭제 시 재현성 파괴, 느슨한 text 스냅샷). `gateway_policies.is_default boolean NOT NULL DEFAULT false` + 부분 UNIQUE `uq_gateway_policies_default`(테넌트당 ≤1, `uq_scenario_versions_prod` 동형) |
| API(create) | `POST /v1/runs`(`server.ts`): optional `model` 화이트리스트 + tenant tx 해소(명시→존재확인/`RESOURCE_NOT_FOUND`, 미지정→is_default→단일정책→0정책 NULL, 다정책→`model_required`). runs INSERT에 model |
| API(policy) | `PUT /v1/gateway/policy`(`gateway.ts`): `is_default` 토글 — true 지정 시 같은 tx에서 기존 default 선해제(CAS 0행 throw 시 rollback으로 선해제 취소 = 실패 시 부작용 없음). **선해제도 demote 정책의 `version`을 bump**(적대 리뷰 — 표현 변경이 ETag에 반영돼야 stale If-Match가 412; 안 그러면 missed-412 낙관적 동시성 위반). `COALESCE`로 미지정 시 현재값 유지. GET 응답(`reads.ts`)에 `is_default` 노출. RBAC `gateway_policy.edit`(admin) 그대로 — 신규 권한 없음 |
| 가드 | 명시 model 정책 부재 → `RESOURCE_NOT_FOUND`. 다정책+미지정+default없음 → `IR_SCHEMA_INVALID`(`model_required`). 정책 0건 → `runs.model=NULL`(utility-only 허용, LLM 노드 소비는 PR-B0; 현 라이브 드라이브는 `UtilityExecutor` 단독이라 dom 노드 자체가 `EXECUTOR_CAPABILITY_MISMATCH` loud). 조용한 false 없음 |
| 잔존 | create-time capability 정적대조(`server.ts` TODO) · `runs.model`→`StagehandDomExecutorConfig.model` 소비는 PR-B0(dom executor drive 합류) · int 테스트(`api-runs-model.int.ts`) temp PG 실행은 CI/owner |

## v2.20 패치 로그 (UX 감사 후속 — `human-tasks/resolve` payload 모순 교정: v1 resolve = 순수 continue 신호)

> **검증된 내부 모순 해소**(신기능 아님). `api-surface.md` §4가 resolve body를 "해소 결과(kind별 payload)"라 약속했으나,
> 나머지 계약·런타임·DB·백엔드 어디에도 그 payload를 모델링·소비하는 곳이 없었다: `reserved-handlers.md` @human_task는
> resolve를 `{status:"resolved", next}` **순수 continue 신호**로 정의(운영자 판정 데이터 자리 없음), resume token 스키마에도
> 결과 필드 없음, IREL `node.<id>.*`는 표준출력만(타입 문서 고정), state-machine H3/R13은 순수 전이, 백엔드
> `requireResolveBody`는 optional `result`를 수용하되 **전이/이벤트만 확정하고 result는 미소비**(human-tasks.ts 주석으로 이미 명시).
> 즉 api-surface 문구 하나만 실제 v1 모델과 어긋난 단일 모순이었다.
> **해소(오너 결정 2026-06-17, A)**: api-surface §4 resolve 행을 `body: optional \`result\`(object) — v1 미소비`로 정정하고,
> resolve가 "승인하고 계속" continue 신호임을 reserved-handlers 권위 인용과 함께 note로 고정. 운영자 판정(승인/반려·통과/실패)
> 데이터 + IR 분기는 reserved-handler 결과 모델·resume token·IREL `node.<handler>.result` 신규 스코프·DB·런타임을 일괄
> 바꾸는 **versioned v2 scope-out**으로 명시 분리. **신규 ErrorCode·DDL·payload 필드 미도입**(가정 금지·closed registry).
> UX 감사가 지적한 "human-task 판정 입력 부재"는 UI 갭이 아니라 **계약 미정의**였음이 확정 — 콘솔 resolve의 bare confirm은 v1 계약상 정확.
> **검증: contract:lint·codegen consistency·web typecheck/test/build green.**

| 항목 | 조치 |
|---|---|
| 계약 | `api-surface.md` §4: resolve body "kind별 payload" → "optional `result`(object), v1 미소비" + reserved-handlers 인용 note(continue 신호·v2 scope-out 명시) |
| 코드 | 백엔드 `requireResolveBody`·web client `resolveHumanTask(result?)`는 이미 v1 정합(무변경). 콘솔 resolve 확인 문구만 "승인/처리 완료로 표시하고 실행을 재개할까요?"로 명확화(continue 신호 의미 노출) |
| 비도입 | resolve result 스키마·IREL `node.<handler>.result` 스코프·resume token 결과 필드·DB 컬럼·신규 ErrorCode — 전부 v2 versioned 결정(이번 PR 범위 밖) |

## v2.21 패치 로그 (UX 감사 후속 — RunTrace run_steps 라이브 관찰 read 표면 추가: `GET /v1/runs/{id}/steps`)

> **read-surface 공백 보강**(데이터는 이미 완비, 조회 표면만 부재였음). UX 감사가 지적한 "RunTrace가 status/worker/attempts/as_of
> 4필드로 축소돼 무슨 일이 일어났는지 관찰 불가"의 원인은 단계 트레이스를 조회하는 read 엔드포인트가 계약(api-surface §1)·구현
> (reads.ts) 둘 다 부재한 것이었다(계약 조사 wf로 확정). `run_steps`(node/action/status/attempt/cache/timings/artifacts/
> stagehand_call_ids/exception)·`stagehand_calls`·step.* 이벤트는 executor가 완전 적재하고 RLS·인덱스·`run.read` RBAC도 갖춰져
> 있었다 — 즉 신규 데이터 모델이 아니라 read 한 행 + 라우트로 닫히는 갭.
> **결정(오너 2026-06-17, 둘 다 A)**: ① **민감 본문 노출 = 요약+참조만**(redaction-by-omission) — `output`/`output_ref`/
> `input_redacted_ref`/`exception.message`(RedactedString)/`evidenceRefs`/`page_state` 본문은 미노출, 증빙은 `artifact_ids`→
> `GET /v1/artifacts/{id}` 기존 redaction→RBAC→audit 게이트(§5)로만. 따라서 step 본문용 신규 게이트·DDL·`redaction_status`
> 컬럼 불요, 트레이스 요약은 `run.read`(viewer+)로 충분. ② **라이브 = 폴링**(architecture §6 outbox tail, 콘솔 동형 refetchInterval);
> SSE/WS 스트림은 v2 미결정으로 분리. step별 판단-결과를 이벤트 payload로 운반하는 것은 금지(closed-empty) — 관찰 권위는 `run_steps` read.
> **신규 추상화 0**: 기존 run 하위 컬렉션 + reads.ts `withTenantTx+paginate` 패턴 복제. **검증: 통합테스트 18 checks green
> (민감 마커 8종 미노출·시간순·커서·RLS·404) + contract:lint·codegen consistency·web typecheck/test/build green.**

| 항목 | 조치 |
|---|---|
| 계약 | `api-surface.md` §1: `GET /v1/runs/{run_id}/steps` 행 + 각주⁶(StepSummary 비민감 shape·redaction-by-omission·폴링·payload 발명 금지). `auth-rbac.md` §2: 조회 행에 run step 트레이스 명시(`run.read`) |
| 백엔드 | `reads.ts`: `GET /v1/runs/{id}/steps` 라우트(run.read·RLS·시간 오름차순 커서). SELECT 화이트리스트 + `stagehand_calls` LATERAL json_agg 요약. exception은 `{class,code}`만(message/evidenceRefs 미노출). `app/test/api-run-steps.int.ts`(18 checks, temp PG) |
| web | `client.listRunSteps` + `StepSummary`/`StagehandCallSummary` 타입 + RunTrace 상세에 `RunStepsTrace` 패널(폴링, 노드/동작/상태/캐시/소요/LLM/artifact ID). artifact ID는 기존 '산출물 조회'(#129) 입력용 |
| 비도입 | step 민감 본문 인라인 노출·redaction 게이트·DDL `redaction_status` · SSE/WS 실시간 전송 계약 · run_steps 필터(status 등) — 후속/v2 |

## v2.22 패치 로그 (UX 감사 후속 — artifact 목록 read 표면 추가: `GET /v1/runs/{id}/artifacts`)

> **read-surface 비대칭 해소**(데이터·RLS·RBAC 완비, 조회 표면만 부재였음). 계약 조사 wf로 확정: 다른 모든 컬렉션
> (runs/scenarios/human-tasks/workitems/dlq/sites)은 list 행이 있는데 **artifacts만 단건 `GET /v1/artifacts/{id}`만
> 노출**(목록 침묵 부재). 데이터 모델은 이미 준비됨 — `artifacts.run_id`(runs FK)+`idx_artifacts_run`, RLS
> `artifacts_visible_isolation`(redacted/not_required·미삭제·비격리·동tenant FOR SELECT), `artifact.read` RBAC.
> **결정(오너 2026-06-17, 둘 다 권고 채택)**: ① URL = run 하위 컬렉션 `GET /v1/runs/{id}/artifacts`(#133 steps 동형).
> ② **metadata-only** — `artifact_id`/`type`/`redaction_status`/`retention_until`/`legal_hold`/`created_at`만; `content`·
> `object_ref`·**`sha256`(원본 fingerprint, security-contracts §11)** 미노출. 본문 열람은 단건 by-id(§10 audit 게이트)로만.
> **핵심**: 목록은 object content를 read하지 않아 disclosure 경로가 아니므로 **§10 audit boundary를 트리거하지 않음**
> (audit는 본문 disclosure 전용; reads.ts recordDecision은 artifactStore.get 성공 후에만). RLS가 가시성 강제 →
> 별도 redaction/audit 게이트 불요, `artifact.read`만으로 충분. **신규 추상화·DDL·payload 발명 0**(listRuns/steps 골격 복제).
> **검증: 통합테스트 18 checks green(temp PG15 non-bypass; RLS 가시성 2가시/3비가시·민감 마커 9종 미노출·커서·cross-tenant·404)
> + contract:lint·codegen consistency·web typecheck/test/build green.**

| 항목 | 조치 |
|---|---|
| 계약 | `api-surface.md` §5: `GET /v1/runs/{run_id}/artifacts` 행 + 각주⁵(metadata-only shape·audit 미트리거·RLS·`artifact.read`). README v2.22 |
| 백엔드 | `reads.ts`: `GET /v1/runs/{id}/artifacts`(artifact.read·RLS·최신순 커서, listRuns 골격 복제). SELECT 화이트리스트(content/object_ref/sha256 미선택). content read·artifactStore.get 호출 없음 → §10 audit append 불요. `app/test/api-run-artifacts.int.ts`(18 checks) |
| web | `client.listRunArtifacts` + `RunArtifactItem` 타입 + RunTrace 상세에 artifact 목록 패널(type·상태·보존·artifact ID). ID는 기존 '산출물 조회'(#129) 입력용 |
| 비도입 | sha256/object_ref/content 목록 노출 · `?run_id=` 쿼리형 URL · orphan(run 없는) artifact 목록 · status 필터 — 후속/오너결정 |

## v2.23 패치 로그 (시나리오 스튜디오 PRD P0 — extract.instruction 계약 정합)

> **검증된 내부 모순 해소**. `schema/ir.schema.json`은 extract action에서 `schema_ref`만 required로 보았지만,
> 런타임 `ir-translate.ts`와 dom executor 경계는 `extract.instruction`을 필수 작업 지시로 요구했다. 그 결과 저장/검증은
> 통과하고 실행만 `IR_SCHEMA_INVALID(extract.instruction 필요)`로 실패하는 "저장됨 ≠ 실행 가능" 상태가 생겼다.
> PRD `prd-scenario-studio-2026-06-18.md` FR-4의 권고 옵션①을 채택해 계약을 런타임에 맞춘다.

| 항목 | 조치 |
|---|---|
| 계약 | `schema/ir.schema.json`: `action=="extract"`이면 `instruction` + `schema_ref`를 required로 고정. 조용한 통과 후 런타임 실패 금지 |
| codegen | `validators.fixtures.ts`: instruction 없는 extract 거부 fixture 추가. `types.ts`: `IRExtractAction` 식별 유니언으로 `instruction`/`schema_ref` 필수화 |
| web | 쉬운 만들기/단계 편집이 extract instruction 입력을 받고 IR에 직렬화. 빈 instruction은 스키마 검증에서 거부됨을 UI에 노출 |
| dev seed | raw 주문수집 seed extract에도 instruction을 부여해 새 계약과 정합 |
| 후속 | 검증 결과 보장범위 문구(C-FR5)와 run-loop failed_* 전이(C-FR3)는 별도 PRD 태스크로 남김 |

## v2.24 패치 로그 (하이웍스 결재 인박스 Model A — 수집→요약→건별 approver-게이트 결재 run)

> **첫 end-to-end 업무 시나리오**(수집 run→아티팩트→콘솔 '결재 인박스'→건별 결재 run). 신규 실행기 기능 0(기존
> navigate/observe/act/extract·세션재사용 재사용). 계약 추가는 최소·근거 기록 원칙. 2라운드 적대 break-it(각 18에이전트)로
> 16 confirmed findings 수정 후 확정.
> **계약**: ErrorCode `APPROVAL_ALREADY_DECIDED`(409, none — 이중결재 거부) · RbacAction `approval.decide`(approver/admin,
> **4곳 미러**: compliance-scaffold 권위 매트릭스 + security-middleware-contract + app rbac + web permissions) · OperationId
> `decideApproval` · `approval_decisions` 테이블(UNIQUE(tenant,source_run_id,doc_ref) 이중결재 차단·RLS·복합 tenant FK(runs)
> 동형 강화) · `api-surface.md` 결재 엔드포인트 행 · `auth-rbac.md` 매트릭스 행. **이벤트 payload 신설 0**(미결정 불가침).
> **백엔드**: `server.ts` createRun 핵심을 `createRunInTx`로 추출(POST /v1/runs ↔ approval.decide 공유) · `approvals.ts`
> `POST /v1/approvals/decide`(approver-게이트·runIdempotentCommand·source_run RLS 확인·DECIDE 시나리오 name 해소·결정
> INSERT[23505→ALREADY_DECIDED]·createRunInTx 스폰·spawned_run_id, 동일 tx) · **reject⇒reason 엔드포인트 강제**.
> `decided_by text`(PrincipalId 자유형 — OIDC sub 비-UUID 허용; ::uuid 캐스트 22P02→미분류 500 회피, break-it HIGH).
> **시나리오**: '하이웍스 결재 수집'(navigate→observe[login/reviews_visible(td.docu-num)]→extract doc_ref 결정형)·'하이웍스
> 결재 처리'(params.decision 분기·승인 클릭/반려 사유 fill+클릭·observe 판정; flags 닫힌 레지스트리만). ir-translate
> `act.args.value_ref`→비-secret 결정형 fill value 스레드(valueRef intent — 미해소 시 LLM/캐시 무음 fill 거부 loud).
> **dev**: 인박스가 읽는 수집 아티팩트 가시화는 origin v2.23 병렬 작업의 `DevVisibleGatewayArtifactSink`(run-level artifact·
> `redaction_status='not_required'`·step_id NULL — **dev 전용**, 운영 entrypoint 미사용)를 재사용(중복 redaction-loop/
> bypass-role/run-step-recorder 폐기). cdp-session goto 타임아웃 env(45s)+domcontentloaded.
> **web**: 인박스 건별 [결재]/[반려(사유)] 버튼(approver만·백엔드 최종강제)·결정후 처리 run 폴링·`#runTrace?run=` 딥링크.
> **검증**: app/codegen typecheck 0 · codegen fixtures green(approval_decisions 등록) · db-static-smoke green · 백엔드 통합
> 22/22(temp-PG: approver/403·멱등 replay→동일 run·ALREADY_DECIDED·정확히 1 스폰·reject⇒reason·비-UUID sub·RLS·UNIQUE) ·
> web typecheck/build 0. **⚠ 비가역 경계(휴먼게이트, 자동 미실행)**: 실 하이웍스 세션 캡처(MFA)·실 결재 클릭 검증·머지.

| 항목 | 조치 |
|---|---|
| 계약 | `error-catalog.ts`(APPROVAL_ALREADY_DECIDED) · `security-middleware-contract.ts`(approval.decide) · `control-plane-contract.ts`(decideApproval) · `compliance-scaffold.ts` RBAC 매트릭스 · `migration_core_entities.sql`(approval_decisions+RLS+복합 FK) · `api-surface.md`·`auth-rbac.md` |
| 백엔드 | `server.ts` createRunInTx 추출 · `approvals.ts` decide 엔드포인트 · `app/src/api/rbac.ts`(approver/admin) · `app/test/api-approvals-decide.int.ts`(22 checks) |
| 실행기/dev | `ir-translate.ts`·`stagehand-dom-executor.ts`(valueRef intent) · `cdp-session.ts`(goto 타임아웃) · `app/dev/seed-hiworks-approval.ts`(수집/처리 시나리오 시드; 아티팩트 가시화는 origin `DevVisibleGatewayArtifactSink` 재사용) |
| web | `client.ts`/`types.ts`(decideApproval) · `views/ApprovalInbox.tsx`(건별 버튼·폴링·딥링크) · `api/permissions.ts` |
| 비도입(휴먼게이트) | 실 세션 캡처(MFA)·실 결재 클릭(비가역)·PR 머지 — 사용자 입회. doc_ref 경로-변형 정규화·일괄(bulk) 결재 — 후속 |

## v2.25 패치 로그 (운영 세션 캡처 — 운영자-로컬 캡처 + 중앙 API 봉투암호화: `browser_session` purpose 신설)

> dev 세션 캡처는 서버 headful(dev 폴러)이라 prod(헤드리스)에서 미동작. **운영자-로컬 캡처**(Option B): 최소권한
> 에이전트가 운영자 PC 에서 캡처(자격증명 미경유), **중앙 API 가 신뢰경계에서 봉투암호화** 저장. 세션 쿠키는 인증
> 자료라 at-rest 평문 금지 — KMS 봉투암호화 land 로 prod 세션 재사용의 구조적 fail-closed 블로커를 해소한다.
> **계약**: `security-middleware-contract.ts` `SecretAccessRequest.purpose` 닫힌 union 에 **`browser_session` 추가**
> (at-rest 세션 KEK; `executor` 자격증명-fill 과 분리해 세션키 유출을 라이브 자격증명 트래픽과 격리) +
> `VaultSecretStoreBoundary` RESOLVE_MATRIX 매핑(`api`=capture/complete 암호화, `runtime-worker`/`browser-worker`=세션
> 복원 복호화). OperationId `captureSessionComplete`. **이벤트 payload·스키마 신설 0**.
> **암호화기**: `KmsEnvelopeSessionEncryptor`(per-message DEK 봉투암호화 — 메시지별 임의 DEK 로 AES-256-GCM, DEK 는 KEK
> 로 재래핑; ciphertext=자기완결 버퍼 version|wrappedDEK|encMsg, enc_kid=KEK kid 회전 추적). KEK 는 SecretStore 에서
> `{kid,key}` 1회 해소(resume-token kid 회전 패턴 미러, 동기 인터페이스 대응). GCM authTag 가 위변조·cross-message
> 스플라이싱·dev↔prod 혼동(unknown kid)을 throw 로 탐지(조용한 잘못된 세션 금지).
> **백엔드**: `POST /v1/sites/{id}/session/capture/complete`(operator+·멱등·RLS; 재사용키는 capture_sessions 행에서
> 도출=바디 불신; 쿠키 평문은 store.save[암호화기]로만·멱등 저장소는 SHA-256 requestHash 단방향만 영속) · capture-start
> 응답에 login_url+auth_selector(비밀 아님) 추가 · 운영자-로컬 CLI `src/agent/capture-agent.ts`(DB/키 무접근·토큰 env·
> https 강제·쿠키 단명) · 캡처 코어 `src/executor/login-capture.ts` 추출(dev 폴러·에이전트 공유). prod `startApi` 는
> KEK(`rpa/<env>/api/browser_session/active`) 프로비저닝 시에만 등록(`VAULT_API_ROLE_ID` 게이트, 미설정=미등록 fail-closed).
> **검증**: app/codegen typecheck 0 · codegen consistency green · KMS 단위 18/18(roundtrip·위변조·kid 회전·빌더 검증·
> fail-closed) · boundary 매트릭스 단위(browser_session ALLOW api/worker·DENY gateway/lifecycle) · capture-complete 통합
> 11/11 · capture-agent 통합 9/9(실 listen+temp-PG). **⚠ 배포 항목(오너)**: api AppRole + KEK 프로비저닝(미설정 시 안전한 성능저하).

| 항목 | 조치 |
|---|---|
| 계약 | `security-middleware-contract.ts`(`browser_session` purpose) · `control-plane-contract.ts`(captureSessionComplete) |
| 암호화기/보안 | `browser-session-store.ts`(KmsEnvelopeSessionEncryptor+buildKmsSessionEncryptor) · `vault-secret-store-boundary.ts`(RESOLVE_MATRIX browser_session) |
| 백엔드 | `api/sessions.ts`(capture/complete+start login_url/auth_selector) · `agent/capture-agent.ts` · `executor/login-capture.ts` · `config/env.ts`(loadApiSessionEncryption) · `main.ts`(buildApiSessionStore 게이트 배선) · `dev/serve.ts`(DevPlaintext 등록) |
| 테스트 | `test/session-encryptor-kms.unit.ts`(18) · `test/api-sessions-capture-complete.int.ts`(11) · `test/capture-agent.int.ts`(9) · `test/vault-secret-store-boundary.unit.ts`(browser_session 쌍) |
| 비도입(오너/후속) | api AppRole+KEK 프로비저닝(배포) · 회전 grace 다중-kid 자동로드 · 워커 세션복원 prod 배선 |
