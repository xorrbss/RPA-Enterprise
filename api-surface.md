# 제어평면 API 표면 계약 (Control-Plane API Surface v1)

> 운영 콘솔/외부 클라이언트가 호출하는 **제어평면 REST API**의 엔드포인트·메서드·요청/응답 요지·주요 에러코드를 고정하는 단일 진실원천.
> **범위 한정**: 본 문서는 D1 OpenAPI codegen의 **입력**이다. 전체 OpenAPI 문서(스키마 본문·파라미터 타입·examples)는 D1이 생성하며, 본 문서는 그 경로·메서드·계약 요지만 못박는다(README §"D1에서 함께 산출할 것").
> 원칙: 어휘 체인(`abort → cancelled → run.cancelled`)·"조용한 false/unknown 금지"·error-catalog 메타(`httpStatus`/`exceptionClass`)를 그대로 따른다. 새 컬럼/테이블을 정의하지 않고 기존 계약(state-machine·migration·schema)을 참조만 한다.
> 구현 scaffold: Fastify route/validator/RBAC/tenant/idempotency/If-Match 연결 타입은 `ts/control-plane-contract.ts`가 고정한다(실행 코드 아님).

---

## 0. 공통 규약

### 0.1 인증 · 테넌시
- 모든 엔드포인트는 인증 필수. `tenant_id`는 **요청 본문/쿼리에서 받지 않고** 인증 주체(토큰)에서 도출한다 — 모든 테이블이 `tenant_id`를 보유하고 RLS(P2)가 전제되므로(migration SQL 전제), API 계층은 인증된 `tenant_id`로만 행을 조회/변경한다.
- **인증(authn) vs 인가(authz) 분리**: 인증 미성립(`Authorization: Bearer` 누락·서명 무효·만료) → `UNAUTHENTICATED`(401). 인증은 성립했으나 tenant_id 클레임 누락/모호(auth-rbac §3) 또는 역할 권한 부족 → `AUTHZ_FORBIDDEN`(403). 둘 다 본문은 ApiError(§0.2).
- RBAC 역할 레지스트리·권한 매트릭스의 **본문 정의는 `auth-rbac.md` §1–§2**다. 본 문서는 각 엔드포인트의 권한 게이트 지점을 표기하고, 실제 허용/거부 판정은 해당 매트릭스를 따른다.
- 인가 실패는 `exceptionClass=security` 코드로 응답: 일반 역할 권한 부족(replay/promote/approve 등) → `AUTHZ_FORBIDDEN`(403), 시크릿/artifact 접근 권한 → `SECRET_ACCESS_DENIED`(403), 커넥터 권한 → `CONNECTOR_PERMISSION_DENIED`(403), 사이트 **실행** 미승인(런타임) → `SITE_PROFILE_BLOCKED`(403). 역할 매트릭스는 auth-rbac.md §2.

### 0.2 에러 응답 형식 (`ApiError`)
- 모든 4xx/5xx 응답 본문은 `ts/error-catalog.ts`의 `ApiError`:
  ```ts
  interface ApiError { code: ErrorCode; message: string; details?: unknown; correlation_id: string; }
  ```
- HTTP 상태코드는 `ERROR_CATALOG[code].httpStatus`를 **그대로** 사용한다(중복 정의 금지). `userMessage`는 외부 노출용(민감정보 없음), `operatorAction`은 내부 운영용으로 응답에 싣지 않는다.
- 분류되지 않은 제어평면 예외는 `CONTROL_PLANE_INTERNAL_ERROR`(500, system)로 매핑한다. 원본 throwable/details는 로그에만 남기며, 응답에는 catalog-backed `ApiError`와 `correlation_id`만 노출한다.
- `correlation_id`는 event-envelope `correlation_id` 및 trace `correlation_id`(impl-bundle §E)와 **동일 값**으로 트레이스↔이벤트↔로그를 상호 연결한다.
- `DEAD_LETTER`(httpStatus 200)는 **API 오류 응답이 아니다** — 상태 통지/운영 알림 전용 코드이므로 `ApiError`로 반환하지 않는다(error-catalog 주석). DLQ 목록/replay 결과 본문에서 상태값으로만 노출.

### 0.3 동시성 — If-Match / ETag (낙관적 동시성)
- **scenario mutation 전반**(update/promote 등 상태 변경)에 `If-Match` 헤더 필수.
- ETag 값 = `scenario_versions.version`(ir.schema `meta.version`, integer). 서버는 응답에 `ETag`를 싣고, 변경 요청은 클라이언트가 받은 ETag를 `If-Match`로 되돌려야 한다.
- 불일치(다른 클라이언트가 선반영) → `SCENARIO_VERSION_CONFLICT`(412). 클라이언트는 최신본 재조회 후 재시도(operatorAction="If-Match 재시도").
- 적용 대상이 아닌 read(GET)·생성(POST create)에는 `If-Match`를 요구하지 않는다.

### 0.4 멱등 — Idempotency-Key (명령 중복 제출 보호)
- **부작용이 있는 명령형 POST**(run create/abort, scenario promote, human-task assign/start/resolve/escalate, workitem replay, sites approve, gateway policy update)에 `Idempotency-Key` 헤더 규약 적용.
- 서버는 `(tenant_id, endpoint, Idempotency-Key)`로 최초 처리 결과를 보관하고, 동일 키 재제출 시 **부작용 재실행 없이** 최초 응답을 반환(at-least-once 클라이언트 재시도 보호).
- 이 헤더는 **`sink_idempotency_key`(migration SQL: 외부 sink 다운스트림 중복 방지, 값=`tenant_id:sink_config_id:schema_ref:natural_key`)와 구분된다.** Idempotency-Key는 *제어평면 인입 명령*의 중복 제출 보호이고, sink_idempotency_key는 *데이터평면 외부 전달*의 멱등키다 — 서로 다른 계층·다른 값.

### 0.5 페이지네이션
- 목록(list) 엔드포인트는 커서 기반 페이지네이션: 쿼리 `?limit=<int>&cursor=<opaque>`, 응답 `{ items: [...], next_cursor: string | null }`.
- `next_cursor=null`이면 마지막 페이지. `limit` 상한 기본값은 운영 정책(README §6, Phase 3 기본값 문서) — 본 문서는 파라미터 형태만 고정.
- 공통 필터: `?status=<state>` 등 엔티티별 상태(state-machine enum 값)로 필터. 상태값은 `ts/state-machine-types.ts`의 enum과 정확히 일치해야 한다.

### 0.6 params.as_of 주입 (결정론)
- run create 시 `params.as_of`(ISO-8601 string)를 **서버가 1회 고정**한다: 요청에 명시되면 그 값을, 미지정이면 서버가 생성 시각으로 채워 `runs.as_of`에 영속화한다(`db/migration_core_entities.sql` `runs.as_of`).
- 이후 재시도·replay·resume에도 동일 `as_of`를 재사용 → IREL `date_*` 결정론 보장(ir-expression §5: 런타임 `now()` 금지). 클라이언트가 매 재시도마다 다른 값을 보내지 않도록 **생성 시 1회 고정**이 규약.

---

## 1. Runs (실행 제어)

| Method | Path | 요청 요지 | 응답 요지 | 주요 ErrorCode |
|---|---|---|---|---|
| POST | `/v1/runs` | `Idempotency-Key` 헤더. body: `scenario_version_id`, `params`(params_schema 준수), optional `params.as_of`, optional `workitem_id`. operator+ 권한 필요 | 201 + run 리소스(`run_id`, `status=queued`). `run.created` 이벤트 emit | `IR_SCHEMA_INVALID`(422), `IR_EXPRESSION_COMPILE_ERROR`(422), `AUTHZ_FORBIDDEN`(403), `SITE_PROFILE_BLOCKED`(403) |
| GET | `/v1/runs/{run_id}` | — | 200 + run 상세(`status` ∈ RunState, `worker_id`, `attempts`, `as_of`, 진행 노드) | `RUN_NOT_FOUND`(404) |
| GET | `/v1/runs` | 쿼리: `?status=<RunState>&scenario_version_id=&limit=&cursor=` | 200 + `{ items, next_cursor }` | — |
| POST | `/v1/runs/{run_id}/abort` | `Idempotency-Key` 헤더. body: optional `reason` | 202 (abort 수락 → `aborting` 경유 `cancelled`). `run.cancelled` 이벤트 | `RUN_NOT_FOUND`(404), `RUN_ALREADY_TERMINAL`(409), `RUN_ABORTED`(409), `WORKITEM_CHECKOUT_CONFLICT`(409, `suspending` bookmark in-flight) |

**어휘 정합(필수)**: API 명령은 `abort` → Run 상태는 `aborting`→`cancelled`(state-machine R6/R10/R16/R23/R24/R26/R27/R28) → 이벤트는 `run.cancelled`(event-envelope) → UI 문구는 "취소됨". 엔드포인트명은 `abort`를 유지한다.
- `abort` 대상 상태: 비종결 실행 상태 전체(running·suspending·suspended·resume_requested·resuming). **예외: `completing`** — finalize 우선(R25), abort는 거부되고 `RUN_ALREADY_TERMINAL`(409)로 응답(상태 유지).
- `suspending`은 R26 guard(`bookmarkCancelable`)가 런타임 소유 bookmark 저장/취소 상태를 증명할 때만 성공 응답을 낼 수 있다. Product Open v1 제어평면에는 bookmark-cancel port나 durable abort intent가 없으므로, 영속 상태가 `suspending`인 abort 요청은 멱등 예약 전에 `WORKITEM_CHECKOUT_CONFLICT`(409, `details.reason="run_bookmark_in_progress"`)로 실패시킨다. 클라이언트는 R11로 `suspended`에 도달한 뒤 같은 `Idempotency-Key`로 재시도할 수 있고, 그때 R16을 적용한다. bookmark 저장 중 202 성공을 반환해 side effect를 추정하는 동작은 금지한다.
- 이미 종결(`completed`/`cancelled`/`failed_*`)된 run에 abort → `RUN_ALREADY_TERMINAL`(409). 이미 취소된 run에 대한 후속 작업 거부 → `RUN_ABORTED`(409).
- `queued`/`claimed` 단계 abort는 run.started 이전이라 Run 전이가 아니라 dispatcher의 큐/claim 회수로 처리(state-machine §1 "abort 보편성" 주석). dispatcher는 `(id,status)` CAS로 큐/claim을 취소하고 같은 트랜잭션 outbox에 `run.cancelled`를 기록한다. 0 rows면 재조회해 `RUN_ALREADY_TERMINAL` 또는 최신 상태 기준으로 재판정한다. API는 동일하게 202를 수락하되 결과는 `cancelled`로 수렴.

---

## 2. Scenarios (시나리오 CRUD · 검증 · 승격)

| Method | Path | 요청 요지 | 응답 요지 | 주요 ErrorCode |
|---|---|---|---|---|
| POST | `/v1/scenarios` | body: IR 문서(ir.schema.json) | 201 + scenario(+초기 version) | `IR_SCHEMA_INVALID`(422), `IR_EXPRESSION_COMPILE_ERROR`(422) |
| GET | `/v1/scenarios/{scenario_id}` | — | 200 + 시나리오 메타 + 최신 version. `ETag: <version>` | `RESOURCE_NOT_FOUND`(404) |
| GET | `/v1/scenarios` | 쿼리: `?limit=&cursor=` | 200 + `{ items, next_cursor }` | — |
| PUT | `/v1/scenarios/{scenario_id}` | `If-Match: <version>` 필수. body: 갱신 IR | 200 + 새 version. `ETag` 갱신 | `SCENARIO_VERSION_CONFLICT`(412), `IR_SCHEMA_INVALID`(422), `IR_EXPRESSION_COMPILE_ERROR`(422) |
| POST | `/v1/scenarios/{scenario_id}/validate` | body: 검증할 IR(저장 안 함) 또는 기존 version 참조 | 200 + ValidationReport(ir-static-validation.md V1..V11) | `IR_SCHEMA_INVALID`(422, reason), `IR_EXPRESSION_COMPILE_ERROR`(422) |
| POST | `/v1/scenarios/{scenario_id}/promote` | `If-Match: <version>` + `Idempotency-Key`. body: `target`(예: prod) | 200 + 승격된 version(AST 캐시 빌드) | `SCENARIO_VERSION_CONFLICT`(412), `IR_SCHEMA_INVALID`(422), `IR_EXPRESSION_COMPILE_ERROR`(422) |

¹ run 외 엔티티(scenario/human-task/workitem/site) 미존재 → `RESOURCE_NOT_FOUND`(404, v1.5 신설). run은 `RUN_NOT_FOUND` 유지.

**검증/승격 규약**(ir-expression §5 / ir-static-validation.md):
- save(POST/PUT)·promote 시 전 expression 파싱+타입체크(IREL) + IR 그래프 정적검증(V1..V11) 수행. 하나라도 실패 시 저장/승격 **거부**(런타임 파싱 없음, AST 캐시).
- 컴파일 에러(IREL_PARSE_ERROR 등)는 `IR_EXPRESSION_COMPILE_ERROR`(422), 그래프 검증 실패는 `IR_SCHEMA_INVALID`(422, `details`에 reason — 예: `shell_cmd_unregistered`)로 매핑.
- `validate`는 부작용 없는 dry-run(저장하지 않음) → ValidationReport 반환. `promote`만 prod 승격 + 캐시 빌드.

---

## 3. Human Tasks (휴먼 태스크 인박스)

| Method | Path | 요청 요지 | 응답 요지 | 주요 ErrorCode |
|---|---|---|---|---|
| GET | `/v1/human-tasks` | 쿼리: `?status=<HumanTaskState>&kind=<HumanTaskKind>&assignee=&limit=&cursor=` | 200 + `{ items, next_cursor }` (인박스 목록) | — |
| GET | `/v1/human-tasks/{human_task_id}` | — | 200 + 태스크 상세(`state`, `kind`, `assignee`, `timeout`, `on_timeout`, payload, run 연계) | `RESOURCE_NOT_FOUND`(404) |
| POST | `/v1/human-tasks/{human_task_id}/start` | `Idempotency-Key`. 배정된 담당자/역할 스코프 필요 | 200 + `in_progress`(H2) | `HUMAN_TASK_EXPIRED`(410), `AUTHZ_FORBIDDEN`(403) |
| POST | `/v1/human-tasks/{human_task_id}/resolve` | `Idempotency-Key`. body: 해소 결과(kind별 payload) | 200 + `resolved`. `human_task.resolved` 이벤트 → Run `resume_requested`(R13/H3) | `AUTHZ_FORBIDDEN`(403), `HUMAN_TASK_EXPIRED`(410) |
| POST | `/v1/human-tasks/{human_task_id}/assign` | `Idempotency-Key`. body: `assignee` | 200 + `assigned`(H1/H6) | `AUTHZ_FORBIDDEN`(403), `HUMAN_TASK_EXPIRED`(410) |
| POST | `/v1/human-tasks/{human_task_id}/escalate` | `Idempotency-Key`. body: optional `reason` | 200 + `escalated`(H5)는 명시 routing/assignment owner가 `reassignAssignee`를 처리할 때만 가능. 현재 Fastify 경로는 미정의 routing이면 fail-closed. | `AUTHZ_FORBIDDEN`(403), `HUMAN_TASK_EXPIRED`(410), `CONTROL_PLANE_INTERNAL_ERROR`(500, unsupported `reassignAssignee`) |

- 상태값은 `HumanTaskState`(`open`/`assigned`/`in_progress`/`resolved`/`expired`/`cancelled`/`escalated`)·`HumanTaskKind`(`approval`/`validation`/`exception`/`captcha`/`mfa`)와 정확히 일치(state-machine-types.ts).
- 만료/종결 태스크에 resolve/assign/escalate 시도 → `HUMAN_TASK_EXPIRED`(410, business). timeout 정책 분기(fail→expired H4a / escalate→escalated H4b)는 태스크 생성 시 `on_timeout`(reserved-handlers @human_task 입력, 기본 `fail`)로 일원화되며 API가 재판정하지 않는다.
- 재에스컬레이션 후에도 미해소 → H8(escalated→timeout→expired, 무한 대기 방지). escalate API는 H5(수동) 진입만 담당하고 timeout 기반 H4b/H8은 타이머 주도(API 비주도).
- assignment/routing 계약: `assignee`는 명시 담당자 uuid, `assignee_role`은 @human_task 입력에서 온 역할 스코프이며 API가 임의로 "admin queue"로 재해석하지 않는다. `reassignAssignee` side effect는 반드시 호출측이 명시적으로 소비해야 한다. 현재 성공 가능한 소비자는 H6 `assign`뿐이며, 요청 body의 `assignee`로 `human_tasks.assignee`를 설정한다. H5 수동 escalate와 R15 coupling에서 발생하는 `reassignAssignee`는 durable routing port/assignee policy가 없으면 미지원 pending side effect로 보고 동일 트랜잭션을 rollback한 뒤 `CONTROL_PLANE_INTERNAL_ERROR`로 fail-closed해야 한다(`human_task.escalated` 이벤트 emit 금지, run 상태 유지).
- `cancel`(H7)은 별도 엔드포인트를 두지 않는다 — Run abort(§1) 연동으로만 발생(R16). 직접 API 노출은 Phase 2 결정.

---

## 4. Workitems / DLQ (작업항목 · 데드레터)

| Method | Path | 요청 요지 | 응답 요지 | 주요 ErrorCode |
|---|---|---|---|---|
| GET | `/v1/workitems` | 쿼리: `?status=<WorkitemState>&target_id=&limit=&cursor=` | 200 + `{ items, next_cursor }` | — |
| GET | `/v1/workitems/{workitem_id}` | — | 200 + 상세(`status` ∈ WorkitemState, `attempts`, `unique_reference`, `checked_out_by/at`, 연계 run) | `RESOURCE_NOT_FOUND`(404) |
| GET | `/v1/dlq` | 쿼리: `?kind=workitem|sink&limit=&cursor=` | 200 + `{ items, next_cursor }`. 항목은 `DEAD_LETTER` 상태 통지(ApiError 아님) | — |
| POST | `/v1/dlq/{dead_letter_id}/replay` | `Idempotency-Key`. 운영자 재처리 권한 필요 | 202 + workitem `new`로 복원(W10: attempts 리셋, DLQ에서 복원). `workitem.dead_lettered` 역방향 복원 | `WORKITEM_CHECKOUT_CONFLICT`(409), `AUTHZ_FORBIDDEN`(403)² |

- workitem DLQ: W5/W7에서 `dead_letter` 생성, W10 `manual_replay`로 복원(state-machine §2). 운영자 재처리 권한(`operatorAuthorized` guard, W10) 미보유 → 인가 실패.
- sink DLQ는 데이터평면(`sink_deliveries.status='dead_letter'`)으로, 본 엔드포인트의 `kind=sink` 목록/replay는 sink 재전달을 트리거한다(SINK_DELIVERY_FAILED 재시도 경로). raw/normalized 멱등은 migration SQL이 보장(재정의 안 함).
- `DEAD_LETTER`(httpStatus 200)는 오류가 아닌 상태 통지이므로 목록/상세 본문의 상태 필드로만 나타나며 `ApiError`로 반환하지 않는다(§0.2).

² replay는 운영자 재처리 권한 게이트 → 권한 부족 시 `AUTHZ_FORBIDDEN`(403, security). 필요 역할은 auth-rbac.md §2(operator+).

---

## 5. Artifacts (산출물 조회 — redaction + RBAC 게이트)

| Method | Path | 요청 요지 | 응답 요지 | 주요 ErrorCode |
|---|---|---|---|---|
| GET | `/v1/artifacts/{artifact_id}` | — | 200 + artifact(또는 서명 URL). `redaction → RBAC` 2단 게이트 통과 시에만 | `ARTIFACT_NOT_REDACTED`(409), `SECRET_ACCESS_DENIED`(403) |

- 조회 허용 조건(security-contracts §8, impl-bundle §C access middleware): `redaction_status ∈ {redacted, not_required}` **AND** 호출자 역할이 해당 tenant/run의 artifact 조회 권한 보유.
- 미들웨어 1지점에서 **순서대로**: ① redaction 게이트 — pending/failed면 `ARTIFACT_NOT_REDACTED`(409, "준비 중입니다"). ② RBAC 게이트 — 권한 부족이면 `SECRET_ACCESS_DENIED`(403).
- `sensitive=true` 입력·redaction 대상은 평문 노출 금지(security-contracts §4/§9). artifact 본문은 항상 마스킹된 `RedactedString`/redacted object만.
- 보존/정리(retention_until·sweeper)는 데이터평면 job(impl-bundle §B `artifact_retention_sweeper`/`artifact_redaction_job`)이며 본 API는 조회만 노출(생성/삭제 API는 v1 미노출).

---

## 6. Gateway Policy (LLM 게이트웨이 정책)

| Method | Path | 요청 요지 | 응답 요지 | 주요 ErrorCode |
|---|---|---|---|---|
| GET | `/v1/gateway/policy` | 쿼리: optional `?model=` | 200 + 모델 정책(`model`, `capabilities`{jsonMode/vision/...}, `budget`{maxInputTokens/maxOutputTokens/maxCost}, fallback 설정) | — |
| PUT | `/v1/gateway/policy` | `If-Match`(정책 버전) + `Idempotency-Key`. body: 정책 갱신 | 200 + 갱신 정책 | `AUTHZ_FORBIDDEN`(403), `POLICY_VERSION_CONFLICT`(412), `LLM_CAPABILITY_MISMATCH`(422)³ |

- `capabilities`는 llm-gateway-adapter.md `ModelCapabilities`(jsonMode 등). Gateway는 호출 전 capabilities로 primitive 적합성 검사(extract+jsonMode=false → `LLM_CAPABILITY_MISMATCH`).
- §19 결정 반영(README v1.4): Codex/vLLM는 capabilities 게이트로 처리 — jsonMode 미지원 시 prompt-schema+strict 폴백(adapter §7), vLLM는 OpenAI 호환 adapter 재사용·`sse=false` 모델만 sync 폴백. 실제 지원범위는 구현 시 라이브 capabilities로 확정(안전 폴백 정의됨).
- 정책의 ETag 대상은 `db/migration_core_entities.sql` `gateway_policies.version`이다. 정책 변경은 `(tenant_id, model, version)` CAS로 반영하고, 충돌 시 `POLICY_VERSION_CONFLICT`(412)로 최신 정책 재조회 후 재시도한다.

³ 정책 변경이 capabilities와 모순되게 모델/jsonMode를 설정하면 거부(`LLM_CAPABILITY_MISMATCH`, 422).

---

## 7. Sites (사이트 risk 승인)

| Method | Path | 요청 요지 | 응답 요지 | 주요 ErrorCode |
|---|---|---|---|---|
| GET | `/v1/sites` | 쿼리: `?risk=red|amber|green&limit=&cursor=` | 200 + `{ items, next_cursor }` (site_profiles 요약) | — |
| GET | `/v1/sites/{site_profile_id}` | — | 200 + 사이트 상세(risk, 승인 상태, circuit 상태) | `RESOURCE_NOT_FOUND`(404) |
| POST | `/v1/sites/{site_profile_id}/approve` | `Idempotency-Key`. 승인 권한 필요. body: optional `reason`/`expires_at` | 200 + 승인 반영(risk=red 사이트 실행 허용) | `AUTHZ_FORBIDDEN`(403)⁴ |

- `site risk=red`는 미승인 시 실행 차단(`SITE_PROFILE_BLOCKED`, 403, error-catalog operatorAction="site risk=red 승인 워크플로우"). 본 엔드포인트가 그 승인 워크플로우의 제어평면 진입점.
- circuit 상태(`site.circuit_opened`/`site.circuit_closed` 이벤트, `SITE_CIRCUIT_OPEN` 503)는 조회로만 노출 — circuit 임계/재개는 `ops-defaults.md` 운영 정책이며, v1 API는 강제 재개를 노출하지 않는다.
- `risk` 등급값(red/amber/green)·site_profiles 승인/서킷 컬럼은 `db/migration_core_entities.sql`가 고정한다. 본 문서는 승인 흐름과 에러코드를 함께 고정한다.

⁴ 승인 권한 미보유 → `AUTHZ_FORBIDDEN`(403, security). 필요 역할은 auth-rbac.md §2(approver). (`SITE_PROFILE_BLOCKED`는 런타임 실행 차단용으로 별개.)

---

## 8. 엔드포인트 ↔ 상태/이벤트 정합 요약

| 명령 엔드포인트 | 상태 전이(state-machine) | emit 이벤트(event-envelope) | UI 문구 |
|---|---|---|---|
| `POST /runs` | (dispatch) → `queued` | `run.created` | "대기" |
| `POST /runs/{id}/abort` | `*` → `aborting` → `cancelled` (R6/R10/R16/R23/R24/R26/R27/R28), `completing`은 거부(R25) | `run.cancelled` | "취소됨" |
| `POST /human-tasks/{id}/resolve` | HumanTask `in_progress`→`resolved`(H3), Run `suspended`→`resume_requested`(R13) | `human_task.resolved` | "처리완료" |
| `POST /human-tasks/{id}/escalate` | H5/R15 `reassignAssignee` 처리 owner가 있을 때만 HumanTask `*`→`escalated`, Run R15(suspended 유지). 미지원이면 fail-closed rollback | `human_task.escalated`(성공 시) | "관리자 이관" |
| `POST /dlq/{id}/replay` | Workitem `abandoned`→`new`(W10) | (workitem 재인입) | "재처리" |
| `POST /scenarios/{id}/promote` | (version 승격 + AST 캐시 빌드) | — | "승격됨" |

---

## 9. D1 위임 (본 문서가 고정하지 않는 것)
- 전체 OpenAPI 본문: 요청/응답 **스키마 본문**(필드 타입·required·examples), 파라미터 상세, `details` 페이로드 구조 — D1 codegen이 본 envelope/error-catalog/schema 기반으로 생성.
- [해소 v1.5] run 외 엔티티 미존재 → `RESOURCE_NOT_FOUND`(404) 신설. 일반 RBAC 거부 → `AUTHZ_FORBIDDEN`(403) 신설(auth-rbac.md). 자원특정 거부(시크릿/artifact→`SECRET_ACCESS_DENIED`, 커넥터→`CONNECTOR_PERMISSION_DENIED`, 사이트 런타임 차단→`SITE_PROFILE_BLOCKED`)는 유지.
- RBAC 역할·권한 매트릭스: `auth-rbac.md`. gateway policy 버전 컬럼: `db/migration_core_entities.sql` `gateway_policies.version`. 전체 OpenAPI 본문(스키마/파라미터/details)은 D1 codegen 위임.

> Repo-controlled fail-closed v1: `suspending` abort success requires a runtime-owned bookmark-cancel port or durable abort intent; absent that owner, API rejects before idempotency reservation and allows retry after `suspended`.

> Repo-controlled fail-closed v1: H5/R15 `reassignAssignee` success requires an explicit routing/assignment owner; absent that owner, API rolls back and returns `CONTROL_PLANE_INTERNAL_ERROR` instead of reporting `escalated`.
