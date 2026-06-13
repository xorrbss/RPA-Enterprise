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

> 미결정(PRD §19와 동일): Codex SSE structured-output 스트리밍 범위·abort 규격(#5), P1 vLLM SSE 지원 여부, credential 동시성 기본값. 이 3건은 adapter 구현 착수 전 확정 필요.

---

## 외부 의존 맵 (이 패키지 밖에서 확정되는 계약)

> 본 패키지는 PRD v3.1의 **보충판**이다(맨 위 참조). 핵심 데이터 모델·제어평면 API·인증/인가·일부 보안 계약은 이 패키지가 아니라 **PRD 본문 / 형제 스펙(LLM Gateway) / D1 codegen / 운영 정책**에서 확정된다. 아래 맵은 본 패키지가 *참조하지만 정의하지 않는* 모든 외부 의존을 한곳에 모은 것이다. 목적: 개발자가 컬럼/엔드포인트/역할/임계를 **임의 추정하지 않도록** 위치를 고정한다.
>
> **상태 범례** — `PRD 확정`(섹션 인용 있음) · `위치 미확정(TODO)`(PRD/형제 스펙에 있을 것으로 보이나 섹션 미인용 — PRD 소유자가 채울 것) · `형제 스펙` · `D1 codegen` · `운영 정책` · `미결정(§19)`.
> **원칙(가정 금지)**: 인용 없는 섹션 번호를 지어내지 않는다. TODO가 빈 채로 해당 코드 경로에 착수해야 하면 `TODO: [BLOCKED]`(violated/reason/required_change)로 중단·보고.
>
> **[v1.4 갱신] 별도 PRD 소유자 없음 → 본 패키지가 직접 정의한다.** §5(보안 계약) 전 항목·`SecretStore`·shell registry·redaction·network policy·kid·connector perms·artifact RBAC는 `security-contracts.md`/`ts/core-types.ts`로, IR 정적검증·flags 레지스트리는 `ir-static-validation.md`로, transition 타입은 `ts/state-machine-types.ts`로, LLM terminal 코드는 `error-catalog.ts`로 **해소 완료**(v1.4 로그). 데이터모델 DDL·RBAC 역할·제어평면 API·테넌시/RLS는 **Phase 2에서 정의 예정** — 아래 표의 "위치 미확정(TODO)"는 "Phase 2 정의 예정"으로 읽는다.

### 1. 데이터 모델 (DDL) — 상태머신·job·캐시가 의존하나 본 패키지엔 DDL 없음
| 엔티티 | 본 패키지 참조(근거) | 외부 위치 | 상태 |
|---|---|---|---|
| `runs` / `run_steps` | state-machine.md §1·§4 (CAS `UPDATE`, `worker_id`, `attempts`, `resume_token` 저장) | PRD v3.1 | 위치 미확정(TODO) |
| `workitems` | state-machine.md §2 (`checked_out_by/at`, `attempts`, `unique_reference`) | PRD v3.1 | 위치 미확정(TODO) |
| `human_tasks` | state-machine.md §3 (`state`, `assignee`, `timeout`, `on_timeout`) | PRD v3.1 | 위치 미확정(TODO) |
| `scenarios` / `scenario_versions` | error-catalog.ts (`SCENARIO_VERSION_CONFLICT`/If-Match 412), ir.schema `meta.version`, ir-expression §5 (AST 캐시·prod 승격) | PRD v3.1 | 위치 미확정(TODO) |
| `artifacts` | impl-bundle §B/§C (`redaction_status`, `retention_until`, `sha256`, `type`), state-machine R21(artifact flush) | PRD v3.1 | 위치 미확정(TODO) |
| `action_plan_cache` | impl-bundle §D, migration SQL `UNIQUE(...)` | **PRD §7**(본체), 상태전이 **§7.2** | PRD 확정 |
| events `outbox` / 이벤트 테이블 | event-envelope.schema.json("outbox 내장"), 본 README §결정2(상태변경+인큐 동일 트랜잭션) | PRD v3.1 또는 D1 마이그레이션 | 위치 미확정(TODO) |
| `dead_letter` / DLQ (workitem 차원) | state-machine W5/W7(dead_letter 생성)·W10(DLQ 복원), error-catalog `DEAD_LETTER` | PRD v3.1 | 위치 미확정(TODO) |
| `stagehand_calls` | llm-gateway-adapter.md(`stagehand_calls.stream_status`), core-types `StepResult.stagehandCallIds` | PRD v3.1 | 위치 미확정(TODO) |
| `site_profiles` / `browser_identities` / `network_policies` | core-types `RunContext`(siteProfileId 등), lease 테이블 uuid 참조, `site risk=red` | PRD v3.1 | 위치 미확정(TODO) |

> `migration_concurrency_idempotency.sql`은 스스로 범위를 "동시성 & idempotency 보강(#4 #6 #7 #11)"으로 한정한다. 위 핵심 엔티티 DDL은 그 범위 밖이며, 상태머신 계약(상태 enum·전이표)은 완비돼 있으나 **영속 컬럼/제약의 위치가 미인용**이다 — `transition*()` codegen과 시뮬레이션 클록 단위테스트 픽스처 착수 전 위치 확정 필요.

### 2. 파이프라인 / 수집 / Challenge
| 항목 | 본 패키지 참조 | 외부 위치 | 상태 |
|---|---|---|---|
| raw→normalized→sink 파이프라인, cursor commit 시점 | migration SQL("§9 파이프라인"), state-machine §2(sink decoupled) | **PRD §9** | PRD 확정 |
| ChallengeResolutionPolicy(@challenge action 순서 상태머신) | reserved-handlers.md(PRD §10.6 실행), migration `challenge_resolution_attempts` | **PRD §10.6** | PRD 확정 |

### 3. 제어평면 API
| 항목 | 본 패키지 참조 | 외부 위치 | 상태 |
|---|---|---|---|
| REST/OpenAPI 엔드포인트 인벤토리(run create/get/abort, scenario CRUD·validate·promote, human_task inbox·resolve, DLQ replay, artifact fetch) | error-catalog 전 코드의 `httpStatus`, `ApiError` | D1 codegen | 산출은 D1 — 단 **입력(엔드포인트 목록) 위치 미확정(TODO)** |
| If-Match(ETag) optimistic concurrency — ETag 출처·대상 엔드포인트 | error-catalog `SCENARIO_VERSION_CONFLICT`(412) | PRD v3.1 | 위치 미확정(TODO) |
| 인입 명령 멱등(`Idempotency-Key` 헤더) | sink 외부 멱등만 정의(migration `sink_idempotency_key`) | PRD v3.1 | 위치 미확정(TODO) |
| `params.as_of` 주입 주체(Run 생성 시 1회 고정) | ir-expression §5 | PRD v3.1 | 위치 미확정(TODO) |

### 4. 인증 · 인가 · 테넌시
| 항목 | 본 패키지 참조 | 외부 위치 | 상태 |
|---|---|---|---|
| RBAC 역할 레지스트리/권한 매트릭스(`assignee_role`, `requires_approval`, operator, secret/connector 권한) | reserved-handlers, ir.schema `nodePolicy`, error-catalog security 코드군 | PRD v3.1 | 위치 미확정(TODO) |
| `tenant_id` 인증 출처(주체) + RLS 정책 본문 | migration SQL(모든 테이블 tenant_id, RLS는 P2 전제) | PRD v3.1 (RLS는 P2) | 위치 미확정(TODO) |

### 5. 보안 계약
| 항목 | 본 패키지 참조 | 외부 위치 | 상태 |
|---|---|---|---|
| Gateway redaction 알고리즘·대상 필드 | llm-gateway-adapter.md("redaction은 Gateway §5.1 step2") | **형제 스펙: LLM Gateway 스펙 §5.1**(본 패키지엔 *adapter* 계약만; §5.1 부재=댕글링) | 형제 스펙 — 문서 식별 TODO |
| `SecretStore` 인터페이스 시그니처 | core-types(SecretStore 경유), impl-bundle §C(`SecretStore.resolve()`) | PRD v3.1 또는 형제 스펙 | 위치 미확정(TODO) |
| signed command registry(shell `cmd_ref` 키·서명·허용인자·검증시점) | ir.schema `cmd_ref`("미등록 시 거부") | PRD v3.1 | 위치 미확정(TODO) |
| prompt injection 탐지 계약(언제/어디서/임계) | error-catalog `PROMPT_INJECTION_DETECTED`, redaction fixture(hidden-instruction) | PRD v3.1 | 위치 미확정(TODO) |
| resume_token HMAC `kid` 키 레지스트리·회전 정책 | reserved-handlers.md ResumeToken(`kid`/`hmac`) | KMS/SecretStore 경계로 추정(DB 아님) | 위치 미확정(TODO) |
| `networkPolicyId` 정책 구조·도메인 allowlist·enforce 지점 | core-types `RunContext`, error-catalog `DOMAIN_POLICY_VIOLATION` | PRD v3.1 | 위치 미확정(TODO) |
| connector manifest permissions 스키마·검사 지점 | error-catalog `CONNECTOR_PERMISSION_DENIED`, impl-bundle §A | PRD v3.1 (D7+ 3rd-party 격리는 의도적 연기) | 위치 미확정(TODO) |

### 6. 정책 · 수치 임계 (운영 정책 — 단 개발/테스트 기본값 필요)
| 항목 | 본 패키지 참조 | 상태 |
|---|---|---|
| 전이 임계: init-fail 연속 임계(R3), workitem `attempts max`(W4–W7), `abort_timeout`(R24), 백오프 곡선 | state-machine guards | 운영 정책 — 개발/테스트 기본값 위치 미확정(TODO) |
| lease 수치: browser lease TTL·heartbeat 주기, credential `locked_until` TTL, checkout timeout | migration leases, impl-bundle §B(sweeper "수초"/"일배치") | 운영 정책(TODO) |
| 서킷 임계: `SITE_CIRCUIT_OPEN` 차단율·윈도우, challenge 차단율, worker 서킷 | error-catalog, reserved-handlers | 운영 정책(TODO) |
| LLM: retry 최대 N, idle/wall-clock timeout, `budget`(maxCost/maxOutputTokens) 기본값 | llm-gateway §2·§4 | 운영 정책(TODO) |
| artifact: `retention_until` 기본 보존기간, redaction 실패 N회 임계, sweeper 주기 | impl-bundle §B | 운영 정책(TODO) |
| `max_self_heal`(기본 2)·`max_iterations`·verify `timeout_ms` 상한 | ir.schema `nodePolicy`/`loop`, verify.schema | 일부 기본값 존재, 상한·verify 기본값 TODO |

### 7. D1 codegen / 의도적 연기 (갭 아님 — 위치 확정됨)
| 항목 | 위치 | 상태 |
|---|---|---|
| event `payload_schema_ref` ↔ event_type 매핑 레지스트리 | event-envelope.schema.json(설명), 본 README §"D1에서 함께 산출할 것" | D1 codegen |
| ajv validator + TS 타입(ir/verify/event), `transition*()` 함수, error 매핑 미들웨어, OpenAPI/AsyncAPI | 본 README §"D1에서 함께 산출할 것" | D1 codegen |
| 미결정 3건(Codex SSE 스트리밍 범위·abort, P1 vLLM SSE, credential 동시성 기본값) | **PRD §19** | 미결정(adapter 착수 전 확정) |
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
- **`ordering_key` required**: run 없는 이벤트(worker.heartbeat 등)는 run_id 기본값이 없어 required 부적합. 의도적 optional 유지.

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
| 9 | verify fail surfacing·DEAD_LETTER 200·worker 서킷 비대칭 | core-types · error-catalog · event-envelope | status surfacing 주석, DEAD_LETTER 통지전용 주석, `worker.circuit_closed` 추가 |

### §19 미결정 결정 (owner=본 패키지)
- **credential 동시성 기본값 = 1** (DDL DEFAULT와 일치, 사이트별 `credential_concurrency_policies`로 상향).
- **P1 vLLM SSE**: OpenAI 호환 adapter 재사용, `sse=false` 모델만 sync 폴백(adapter §7) — 별도 구현 불요.
- **Codex structured-output 스트리밍·abort**: `capabilities.jsonMode` 게이트 + 미지원 시 prompt-schema+strict(§7), abort=HTTP close(§3). 실제 지원범위는 **구현 시 라이브 API로 capabilities 확정**(안전 폴백 정의됨).

> 다음(Phase 2): 핵심 DDL(runs/run_steps/workitems/human_tasks/scenarios/scenario_versions/artifacts/events_outbox/dead_letter/stagehand_calls/site_profiles/browser_identities/network_policies) + RBAC 역할 + tenant/RLS + 제어평면 API 인벤토리 → §"외부 의존 맵" 잔여 TODO 해소.
