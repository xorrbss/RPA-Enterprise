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
- `GET /v1/auth/readiness` — `principal.read` 권한. 현재 인증된 JWT와 배포 인증 설정에서 도출한 **SSO/IdP 준비도**를 반환한다. 응답은 `enterprise_sso_ready`, provider 요약(`mode=hs256|jwks`, `algorithm=HS256|RS256`, `jwks_url_configured`, `jwks_host`, `issuer_configured`, `audience_configured`), 실제 claim mapping(기본 `sub`·`tenant_id`·`roles`·`exp`·`name`·`email`, 배포 시 `JWT_*_CLAIM`으로 tenant/roles/name/email 경로 변경 가능), role mapping 요약(`JWT_ROLE_MAP` 적용 여부와 항목 수), 현재 principal 요약, `operational_gaps`만 포함한다. HMAC secret, 토큰 원문, JWKS 전체 URL path/query, 평문 자격증명, 역할 매핑 원문은 반환하지 않는다.

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
- **부작용이 있는 제어평면 명령**(run create/abort/rerun/prioritize, scenario promote/rollback/archive, human-task assign/start/resolve/escalate, workitem replay, sites approve, gateway policy create/update/delete, principal create/update/delete)에 `Idempotency-Key` 헤더 규약 적용.
- 서버는 `(tenant_id, endpoint, Idempotency-Key)`로 최초 처리 결과를 보관하고, 동일 키 재제출 시 **부작용 재실행 없이** 최초 응답을 반환(at-least-once 클라이언트 재시도 보호).
- 이 헤더는 **`sink_idempotency_key`(migration SQL: 외부 sink 다운스트림 중복 방지, 값=`tenant_id:sink_config_id:schema_ref:natural_key`)와 구분된다.** Idempotency-Key는 *제어평면 인입 명령*의 중복 제출 보호이고, sink_idempotency_key는 *데이터평면 외부 전달*의 멱등키다 — 서로 다른 계층·다른 값.

### 0.5 페이지네이션
- 목록(list) 엔드포인트는 커서 기반 페이지네이션: 쿼리 `?limit=<int>&cursor=<opaque>`, 응답 `{ items: [...], next_cursor: string | null }`.
- `next_cursor=null`이면 마지막 페이지. `limit` 상한 기본값은 운영 정책(README §6, Phase 3 기본값 문서) — 본 문서는 파라미터 형태만 고정.
- 공통 필터: `?status=<state>` 등 엔티티별 상태(state-machine enum 값)로 필터. 상태값은 `ts/state-machine-types.ts`의 enum과 정확히 일치해야 한다.

### 0.6 params.as_of 주입 (결정론)
- run create 시 `params.as_of`(ISO-8601 string)를 **서버가 1회 고정**한다: 요청에 명시되면 그 값을, 미지정이면 서버가 생성 시각으로 채워 `runs.as_of`에 영속화한다(`db/migration_core_entities.sql` `runs.as_of`).
- 이후 재시도·replay·resume에도 동일 `as_of`를 재사용 → IREL `date_*` 결정론 보장(ir-expression §5: 런타임 `now()` 금지). 클라이언트가 매 재시도마다 다른 값을 보내지 않도록 **생성 시 1회 고정**이 규약.

### 0.7 model 해소 (Gap2 — run의 LLM model 출처)
- `gateway_policies`는 `UNIQUE(tenant_id, model)`로 테넌트당 다수 model 행을 허용한다. run의 model은 `as_of`와 동형으로 **run create 시 1회 해소·동결**되어 `runs.model`에 영속화된다(`db/migration_core_entities.sql` `runs.model`; `action_plan_cache` 캐시 키의 결정 요소).
- 해소 규칙(RLS tenant 스코프): ① body에 `model` 명시 → `(tenant_id, model)` 정책 존재 확인(부재 시 `RESOURCE_NOT_FOUND` 404). ② 미지정 → 테넌트 기본 정책(`gateway_policies.is_default`, 부분 UNIQUE로 ≤1) → 없으면 단일 정책 1행 자동 해소 → 정책 0건이면 `runs.model=NULL`(utility-only run 허용; LLM 노드 도달 시 run-time fail-closed). ③ 다정책 + 미지정 + 기본 없음 → `IR_SCHEMA_INVALID`(422, `reason=model_required`) — 임의 선택 금지(GET /v1/gateway/policy 다건 규약 동형).
- model↔capability 정합은 call-time `SafeCapabilityGate`(llm-gateway-adapter §1)가 fail-closed로 최종 차단한다(create-time 정적 사전대조는 후속 증분).

---

## 1. Runs (실행 제어)

| Method | Path | 요청 요지 | 응답 요지 | 주요 ErrorCode |
|---|---|---|---|---|
| POST | `/v1/runs` | `Idempotency-Key` 헤더. body: `scenario_version_id`, `params`(params_schema 준수), optional `params.as_of`, optional `workitem_id`, optional `model`(§0.7), optional `priority=low|medium|high|critical`(기본 medium). operator+ 권한 필요 | 201 + run 리소스(`run_id`, `status=queued`, `priority`). `run.created` 이벤트 emit. `runs.model` 1회 해소·동결 | `IR_SCHEMA_INVALID`(422; 미해소 `model_required`/무효 priority 포함), `IR_EXPRESSION_COMPILE_ERROR`(422), `RESOURCE_NOT_FOUND`(404; 명시 `model` 정책 부재), `AUTHZ_FORBIDDEN`(403), `SITE_PROFILE_BLOCKED`(403) |
| GET | `/v1/runs/{run_id}` | — | 200 + run 상세(`run_id`, `scenario_id`, `scenario_version_id`, `status` ∈ RunState, `priority`, `worker_id`, `attempts`, `as_of`, `current_node`, `failure_reason`, `updated_at`). 실제 진행 노드를 모르면 `current_node=null`, 실패 사유가 없으면 `failure_reason=null` | `RUN_NOT_FOUND`(404) |
| GET | `/v1/runs/{run_id}/steps` | 쿼리: `?limit=&cursor=`. `run.read` 권한 | 200 + `{ items, next_cursor }` (run_steps 단계 트레이스, 실행 시간 오름차순)⁶ | `RESOURCE_NOT_FOUND`(404; 형식 무효 run_id) |
| GET | `/v1/runs/{run_id}/steps/stream` | `Accept: text/event-stream`. `run.read` 권한 | 200 SSE. 이벤트는 `run_steps_changed`/`run_steps_closed`이며 `run_id`, `status`, `step_count`, `last_step_at`, `run_updated_at` 같은 변경 신호만 포함한다. 클라이언트는 이벤트 수신 시 `/steps`를 재조회한다 | `RESOURCE_NOT_FOUND`(404; 형식 무효 run_id) |
| GET | `/v1/runs` | 쿼리: `?status=<RunState>&scenario_version_id=&limit=&cursor=` | 200 + `{ items, next_cursor }`, 각 item은 run 상세 요지(`priority`, `current_node`, `failure_reason` 포함; 모름/없음은 null) | — |
| GET | `/v1/runs/summary` | `run.read` 권한 | 200 + `{ by_status, success_rate, total, cache }` — 테넌트 run outcome+캐시 집계(관찰성). `by_status`=runs.status별 정확 카운트(부재 status 키 생략), `success_rate`=completed/(completed+failed_business+failed_system)(분모 0이면 `null`; cancelled 제외), `total`=전체 run 수, `cache`={ by_mode(run_steps.cache_mode별 카운트), hit_rate=hit/(조회=non-bypass), 조회 0이면 `null` }. RLS 스코프, 서버 GROUP BY(목록 `50+` 근사 아님) | — |
| GET | `/v1/runs/trends` | 쿼리: `?days=<1..90>`(기본 30). `run.read` 권한 | 200 + `{ window_days, timezone, points }` — 일별 run outcome 추세(분석; summary 의 시계열 확장). 각 point=`{ day, completed, failed_business, failed_system, total, success_rate }`. 윈도우 내 모든 날 포함(0건 날도 — 스파크라인 x축 연속). `success_rate`=completed/(completed+failed_business+failed_system), 그 날 분모 0이면 `null`(0/0 단정 금지). Asia/Seoul 일 경계, RLS 스코프, 서버 GROUP BY | — |
| POST | `/v1/runs/{run_id}/abort` | `Idempotency-Key` 헤더. body: optional `reason` | 202 (abort 수락 → `aborting` 경유 `cancelled`). `run.cancelled` 이벤트 | `RUN_NOT_FOUND`(404), `RUN_ALREADY_TERMINAL`(409), `RUN_ABORTED`(409), `WORKITEM_CHECKOUT_CONFLICT`(409, `suspending` bookmark in-flight) |
| POST | `/v1/runs/{run_id}/rerun` | `Idempotency-Key` 헤더. body: `mode=same_input|edited_input`(기본 `same_input`), `edited_input`은 `params` object 필수, optional `reason`. `run.rerun` 권한(operator+) 필요 | 201 + `{ rerun_id, source_run_id, run_id, status=queued, mode, as_of }`. 실패 run의 자식 run 생성·enqueue, `run_reruns` lineage와 `run.rerun` 감사 기록 | `RUN_NOT_FOUND`(404), `WORKITEM_CHECKOUT_CONFLICT`(409; source status가 `failed_business|failed_system` 아님 또는 idempotency in-flight), `IR_SCHEMA_INVALID`(422), `RESOURCE_NOT_FOUND`(404), `SCENARIO_VERSION_CONFLICT`(412), `AUTHZ_FORBIDDEN`(403), `SITE_PROFILE_BLOCKED`(403) |
| POST | `/v1/runs/{run_id}/resume` | `Idempotency-Key` 헤더. body는 생략 또는 `{ reason?: string }`. `run.resume` 권한(operator+) 필요 | 202 + `{ run_id, status=resume_requested, previous_status }`. `suspended` run은 unresolved human task가 없을 때만 R13(`resume_requested`) 적용 + `run_resume` enqueue + `run.resume` 감사. 이미 `resume_requested`면 상태 변경 없이 `run_resume` 재인큐 | `RUN_NOT_FOUND`(404), `WORKITEM_CHECKOUT_CONFLICT`(409; `human_task_unresolved`, `run_resume_requires_suspended_or_resume_requested`, idempotency in-flight), `SCENARIO_VERSION_CONFLICT`(412), `IR_SCHEMA_INVALID`(422), `AUTHZ_FORBIDDEN`(403) |
| POST | `/v1/runs/{run_id}/priority` | `Idempotency-Key` 헤더. body: `{ priority, reason? }`, `priority=low|medium|high|critical`. `run.prioritize` 권한(operator+) 필요 | 200 + `{ run_id, status=queued, previous_priority, priority }`. queued run 원장 priority 갱신, 새 `run_claim`을 Graphile priority로 재인큐, `run.prioritize` 감사 기록 | `RUN_NOT_FOUND`(404), `WORKITEM_CHECKOUT_CONFLICT`(409; source status가 `queued` 아님 또는 idempotency in-flight), `IR_SCHEMA_INVALID`(422), `SCENARIO_VERSION_CONFLICT`(412), `AUTHZ_FORBIDDEN`(403) |

**어휘 정합(필수)**: API 명령은 `abort` → Run 상태는 `aborting`→`cancelled`(state-machine R6/R10/R16/R23/R24/R26/R27/R28) → 이벤트는 `run.cancelled`(event-envelope) → UI 문구는 "취소됨". 엔드포인트명은 `abort`를 유지한다.

**재실행 계약**: `rerun`은 `failed_business`/`failed_system` source run에만 허용한다. `same_input`은 source의 `params`·`as_of`·`model`을 보존하고, `edited_input`은 제출된 `params`를 새 child run에 저장하되 `params.as_of`가 없으면 서버 시각으로 1회 고정한다. source/child 관계는 `run_reruns`에 남기며, 감사 로그 payload는 `params_sha256` 같은 비민감 요약만 저장한다.

**우선순위 계약**: run priority는 `low|medium|high|critical`로 닫힌다. 변경은 아직 worker가 잡지 않은 `queued` run에만 허용하며, 이미 `claimed` 이상인 실행은 순서를 바꾼 척하지 않고 `WORKITEM_CHECKOUT_CONFLICT(details.reason="run_priority_requires_queued_status")`로 거부한다. 변경 시 새 `run_claim` 잡을 더 높은/낮은 Graphile priority로 추가 인큐하고, 이전 stale `run_claim`은 worker claim 단계에서 no-op 처리된다.

⁶ `GET /v1/runs/{run_id}/steps` — `run_steps` 단계 트레이스 read(운영 관찰). **비민감 요약 + 참조만** 노출(redaction-by-omission): `step_id`·`node_id`·`action`(IRActionType)·`status`(StepResult status 9값)·`attempt`·`cache_mode`·`started_at`/`ended_at`/`duration_ms`·`artifact_ids`(ArtifactRef[])·`stagehand_calls`(model/transport/stream_status/ttfb_ms/input·output_tokens/cost)·`exception`(`{class, code}`만). **민감 본문은 미노출**: `output`/`output_ref`/`input_redacted_ref` 내용·`exception.message`(RedactedString)·`evidenceRefs`·`page_state_before/after` 본문 — 평문/증빙 노출 금지(security-contracts §4/§9). 증빙(artifact)은 `artifact_ids`를 통해 **`GET /v1/artifacts/{id}` redaction→RBAC→audit 게이트**(§5)로만 조회한다. 따라서 step 본문 disclosure용 별도 RBAC/redaction 게이트는 불요하며 트레이스 요약은 `run.read`(viewer+, auth-rbac §2 "트레이스 조회")로 충분하다. 실시간성은 v2=`/steps/stream` SSE 변경 신호 + `/steps` 재조회이며, 브라우저는 Bearer 헤더가 필요한 구조라 `EventSource`가 아니라 fetch stream을 사용한다. 폴링은 fallback으로 유지한다. step별 판단-결과 데이터(승인/반려 등)를 이벤트 payload로 운반하는 것은 금지(event-envelope: per-event payload body는 closed-empty) — 관찰 데이터는 본 `run_steps` read가 권위다.
- `abort` 대상 상태: 비종결 실행 상태 전체(running·suspending·suspended·resume_requested·resuming). **예외: `completing`** — finalize 우선(R25), abort는 거부되고 `RUN_ALREADY_TERMINAL`(409)로 응답(상태 유지).
- `suspending`은 R26 guard(`bookmarkCancelable`)가 런타임 소유 bookmark 저장/취소 상태를 증명할 때만 성공 응답을 낼 수 있다. Product Open v1 제어평면에는 bookmark-cancel port나 durable abort intent가 없으므로, 영속 상태가 `suspending`인 abort 요청은 멱등 예약 전에 `WORKITEM_CHECKOUT_CONFLICT`(409, `details.reason="run_bookmark_in_progress"`)로 실패시킨다. 클라이언트는 R11로 `suspended`에 도달한 뒤 같은 `Idempotency-Key`로 재시도할 수 있고, 그때 R16을 적용한다. bookmark 저장 중 202 성공을 반환해 side effect를 추정하는 동작은 금지한다.
- 이미 종결(`completed`/`cancelled`/`failed_*`)된 run에 abort → `RUN_ALREADY_TERMINAL`(409). 이미 취소된 run에 대한 후속 작업 거부 → `RUN_ABORTED`(409).
- `queued`/`claimed` 단계 abort는 run.started 이전이라 Run 전이가 아니라 dispatcher의 큐/claim 회수로 처리(state-machine §1 "abort 보편성" 주석). dispatcher는 `(id,status)` CAS로 큐/claim을 취소하고 같은 트랜잭션 outbox에 `run.cancelled`를 기록한다. 0 rows면 재조회해 `RUN_ALREADY_TERMINAL` 또는 최신 상태 기준으로 재판정한다. API는 동일하게 202를 수락하되 결과는 `cancelled`로 수렴.
- 운영자 `resume`은 HITL 우회가 아니라 복구 명령이다. `suspended` run에 `open|assigned|in_progress|escalated` human task가 남아 있으면 `human_task_unresolved`로 거부한다. `resume_requested` run에 대한 호출은 유실된 `run_resume` job 복구를 위해 재인큐만 수행한다.
- 운영자 `pause`는 v1에서 API로 노출하지 않는다. running run을 안전하게 `suspending`으로 보내려면 런타임 소유 bookmark-cancel/intent port가 필요하므로, 해당 owner가 연결되기 전까지 `pause`는 `TODO: [BLOCKED] runtime-owned operator pause intent/bookmark port`로 둔다.
  Required decision: define the runtime-owned operator pause intent/bookmark-cancel port, ownership boundary, state transition evidence, and targeted tests before exposing active run pause.

---

## 1.4 Automation Ideas / CoE ROI (업무 발굴·승인 파이프라인 v1)

Product Open v1에서 CoE/ROI는 **운영자 제품 표면**이다. 운영자/승인자/관리자는 자동화 후보를 등록·평가·연결하고 ROI 입력값과 계산 결과를 저장한다. Viewer는 tenant-scoped 후보와 ROI 산정 결과를 조회할 수 있으나 생성·수정·ROI 저장과 비승인 전이는 `automation_idea.manage` 권한이 필요하다. `assess -> approved/rejected` 승인·반려 전이는 SoD 경계로 분리해 `automation_idea.approve` 권한(approver/admin)을 멱등키 예약 전에 추가 검사한다. 이 표면은 프로세스/태스크 마이닝 엔진 자체가 아니라, 수동·imported·process_mining·task_mining source에서 들어온 후보를 평가/승인/연결하는 CoE control-plane이다.

| Method | Path | 요청 요지 | 응답 요지 | 주요 ErrorCode |
|---|---|---|---|---|
| GET | `/v1/automation-ideas` | query: optional `stage`, optional `department`, `limit`, `cursor`. `automation_idea.read` 권한 | 200 + `{ items, next_cursor }`, 각 item은 `AutomationIdea` | `AUTHZ_FORBIDDEN`(403), `IR_SCHEMA_INVALID`(422) |
| POST | `/v1/automation-ideas` | `Idempotency-Key`. body: `title`, `description`, `business_owner`, `department`, optional `source`, `priority`, `score`. `automation_idea.manage` 권한 | 201 + `AutomationIdea(stage=intake)` | `IR_SCHEMA_INVALID`(422), `AUTHZ_FORBIDDEN`(403) |
| GET | `/v1/automation-ideas/{idea_id}` | `automation_idea.read` 권한 | 200 + `AutomationIdea` | `RESOURCE_NOT_FOUND`(404) |
| PATCH | `/v1/automation-ideas/{idea_id}` | `Idempotency-Key`. 후보 메타데이터, optional `scenario_id`, optional `run_trigger_id` 연결. `automation_idea.manage` 권한 | 200 + 수정된 `AutomationIdea` | `IR_SCHEMA_INVALID`(422), `RESOURCE_NOT_FOUND`(404), `AUTHZ_FORBIDDEN`(403) |
| POST | `/v1/automation-ideas/{idea_id}/transition` | `Idempotency-Key`. body: `{ stage }`. 허용된 전이만 수행. 기본 `automation_idea.manage`; 목표 stage가 `approved`/`rejected`이면 추가로 `automation_idea.approve` 권한 필요 | 200 + 전이된 `AutomationIdea` | `IR_SCHEMA_INVALID`(422), `RESOURCE_NOT_FOUND`(404), `AUTHZ_FORBIDDEN`(403) |
| GET | `/v1/automation-ideas/{idea_id}/roi-estimate` | `automation_idea.read` 권한 | 200 + `RoiEstimate` 또는 미저장 시 404 | `RESOURCE_NOT_FOUND`(404), `AUTHZ_FORBIDDEN`(403) |
| POST | `/v1/automation-ideas/{idea_id}/roi-estimate` | `Idempotency-Key`. body: `frequency_per_month`, `minutes_per_case`, `exception_rate`, `hourly_cost`, `implementation_effort`, `confidence`. `automation_idea.manage` 권한 | 200 + 저장된 `RoiEstimate`(`monthly_hours_saved`, `estimated_monthly_value`, `payback_months` 계산 포함) | `IR_SCHEMA_INVALID`(422), `RESOURCE_NOT_FOUND`(404), `AUTHZ_FORBIDDEN`(403) |

ROI v1 계산 규칙: `monthly_hours_saved = frequency_per_month * minutes_per_case * (1 - exception_rate) / 60`, `estimated_monthly_value = monthly_hours_saved * hourly_cost`, `payback_months = implementation_effort / estimated_monthly_value`(분모 0이면 `null`). ROI 입력은 운영자 판단을 돕는 추정치이며 billing/회계 원장으로 쓰지 않는다.

## 1.5 Automation Performance Report (월간 성과/ROI 리포트 v1)

월간 자동화 성과 리포트는 `runs`, `run_reruns`, `automation_ideas`, `roi_estimates`를 조합하는 조회 표면이다. 별도 회계 원장이 아니라 PoC/월간 운영 보고의 근거 자료이며, 비용은 `runs.usage_cost`, ROI는 시나리오에 연결된 `approved/build/operate` automation idea의 최신 ROI estimate 합계로 계산한다.

| Method | Path | 요청 | 응답 | 오류 |
|---|---|---|---|---|
| GET | `/v1/reports/automation-performance` | 쿼리: `?month=YYYY-MM`(기본 Asia/Seoul 현재 월). `run.read` 권한 | 200 + `{ month, timezone, period_start, period_end, summary, failure_top, by_workflow }`. `summary`는 `total_runs`, `completed`, `failed_business`, `failed_system`, `success_rate`, `rerun_count`, `reprocessing_rate`, `estimated_hours_saved`, `estimated_value`, `gateway_cost`. `failure_top`은 실패 code Top 5. `by_workflow`는 scenario별 run/성공률/재처리율/ROI/비용 | `IR_SCHEMA_INVALID`(422), `AUTHZ_FORBIDDEN`(403) |
| GET | `/v1/reports/automation-performance/export` | 쿼리: `?month=YYYY-MM&format=csv\|xlsx\|poc_markdown`. `format` 생략 시 csv. `run.read` 권한 | csv는 `text/csv; charset=utf-8` + summary/failure/workflow 섹션. xlsx는 `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` + Summary/Failure Top N/Workflow ROI 시트. `poc_markdown`은 `text/markdown; charset=utf-8` + month, summary metrics, failure Top N, workflow ROI/cost, decision guide를 포함하는 PoC 보고서 템플릿. CSV/XLSX 문자열 셀은 spreadsheet formula injection 방어를 적용하고, Markdown 문자열 셀은 formula 선두 문자, Markdown 링크, HTML 태그 해석을 방어적으로 escape한다. Secret/token/password/resolved secret material은 포함하지 않는다 | `IR_SCHEMA_INVALID`(422), `AUTHZ_FORBIDDEN`(403) |

계산 규칙: `success_rate = completed/(completed+failed_business+failed_system)`, `reprocessing_rate = rerun_count/total_runs`. 각 분모가 0이면 `null`로 반환해 0%/100%를 추측하지 않는다. 월 경계는 Asia/Seoul 월초 00:00 이상, 다음 월초 00:00 미만이다. PoC 보고서 템플릿은 동일한 월간 집계만 사용하며, 확대/보류 판단은 `success_rate`, `reprocessing_rate`, run evidence, `estimated_value > gateway_cost`의 설명 가능한 guide로만 제시한다.

---

## 1.4a Document Automation / IDP v1 (텍스트·CSV·JSON 문서 검증 큐)

Product Open v1의 문서 자동화는 **redacted artifact에 저장된 텍스트/CSV/JSON 본문**을 deterministic extractor로 읽고, 필수 필드 누락 또는 low-confidence 필드를 기존 `human_tasks(kind=validation)`의 `business_form_v1` 검증 큐로 넘기는 MVP다. OCR/이미지/PDF vision 추출은 이 버전 범위가 아니며, `image/*`·바이너리·미디어 타입 미상 artifact는 `IR_SCHEMA_INVALID(reason=unsupported_document_artifact_media_type)`로 거부한다. 원본 문서 bytes는 `GET /v1/artifacts/{id}`와 동일한 redaction→audit 경계를 통과해 읽으며, 응답에는 추출 필드와 검증 태스크 참조만 노출한다.

| Method | Path | 요청 요지 | 응답 요지 | 주요 ErrorCode |
|---|---|---|---|---|
| GET | `/v1/document-jobs` | query: optional `status`, `limit`, `cursor`. `document_job.read` 권한 | 200 + `{ items, next_cursor }`, 각 item은 `DocumentJob` | `AUTHZ_FORBIDDEN`(403), `IR_SCHEMA_INVALID`(422) |
| POST | `/v1/document-jobs` | `Idempotency-Key`. body: `source_artifact_id`, `document_type`, `field_schema[]`(`key`, optional `label`, `type`, `required`, `aliases`, `patterns`, `min_confidence`). `document_job.manage` 권한 | 201 + `DocumentJob(status=created)` | `RESOURCE_NOT_FOUND`(404; 보이지 않는 artifact), `IR_SCHEMA_INVALID`(422; 미지원 media type/field schema), `AUTHZ_FORBIDDEN`(403) |
| GET | `/v1/document-jobs/{job_id}` | `document_job.read` 권한 | 200 + `DocumentJob` | `RESOURCE_NOT_FOUND`(404), `AUTHZ_FORBIDDEN`(403) |
| POST | `/v1/document-jobs/{job_id}/extract` | `Idempotency-Key`. 빈 body 또는 생략. redacted source artifact를 감사 기록과 함께 읽고 deterministic extraction 수행 | 200 + `DocumentExtraction(status=completed\|validation_required)`. `missing_fields`는 필수 누락 또는 low-confidence 필드만 포함 | `RESOURCE_NOT_FOUND`(404), `IR_SCHEMA_INVALID`(422), `AUTHZ_FORBIDDEN`(403) |
| GET | `/v1/document-jobs/{job_id}/extraction` | `document_job.read` 권한 | 200 + 저장된 `DocumentExtraction` | `RESOURCE_NOT_FOUND`(404), `AUTHZ_FORBIDDEN`(403) |
| POST | `/v1/document-jobs/{job_id}/validation-task` | `Idempotency-Key`. extraction이 `validation_required`일 때 reviewer용 validation human task 생성 | 201 + `{ human_task_id, state, result_schema, artifact_refs }`. 기존 task가 있으면 같은 task 참조 반환 | `RESOURCE_NOT_FOUND`(404), `IR_SCHEMA_INVALID`(422; 검증 불필요), `AUTHZ_FORBIDDEN`(403) |

필드 추출 신뢰도 v1: JSON exact key/alias match는 high confidence, CSV header match는 high confidence, `patterns` match는 medium-high, label line(`Label: value`) match는 low confidence로 기록한다. 선택 필드(`required=false`)가 없다는 이유만으로 검증 큐를 열지 않는다. 잘못된 regex pattern은 저장/실행 전에 `IR_SCHEMA_INVALID(reason=invalid_field_schema)`로 fail-closed 처리한다.

---

## 1.5 Run Triggers (예약 실행 / Orchestration v1)

Product Open v1의 trigger는 **cron 기반 예약 실행**과 **서명 웹훅 발화**만 성공 경로로 계약한다. 파일 도착과 queue 적재 trigger는 V2 P1에서 저장·발화 성공으로 응답하지 않으며, `POST /v1/run-triggers`는 `trigger_type=file_arrival|queue|queue_threshold` 같은 값을 `IR_SCHEMA_INVALID(reason=invalid_trigger_type)`로 거절한다. 파일 watcher, queue payload schema, SecretRef/connector auth, idempotent event key, replay window, and fire ledger semantics are P2/future contracts.

`RunTrigger.webhook_secret_ref`는 `trigger.manage` 권한이 있는 응답에서만 원문 SecretRef를 포함한다. `trigger.read`만 가진 사용자에게는 `webhook_secret_ref=null`로 응답하고, 웹훅 키 연결 여부는 `webhook_secret_configured=true|false`로만 표시한다.

| Method | Path | 요청 요지 | 응답 요지 | 주요 ErrorCode |
|---|---|---|---|---|
| GET | `/v1/run-triggers` | query: optional `status`, optional `scenario_version_id`, `limit`, `cursor`. `trigger.read` 권한 | 200 + `{ items, next_cursor }`, 각 item은 `RunTrigger` | `AUTHZ_FORBIDDEN`(403) |
| POST | `/v1/run-triggers` | `Idempotency-Key`. cron body: `trigger_type=cron`, `scenario_version_id`, 5-field `cron_expression`, `timezone`, optional `params`, `catchup_policy`, `max_concurrent_runs`, `next_fire_at`. `next_fire_at` 생략 시 API가 cron/timezone 기준 다음 발생 시각을 계산. webhook body: `trigger_type=webhook`, `scenario_version_id`, `webhook_secret_ref`, optional `params`, `max_concurrent_runs`. `trigger.manage` 권한 | 201 + `RunTrigger(status=enabled)` | `IR_SCHEMA_INVALID`(422), `RESOURCE_NOT_FOUND`(404), `AUTHZ_FORBIDDEN`(403) |
| GET | `/v1/run-triggers/{trigger_id}` | `trigger.read` 권한 | 200 + `RunTrigger` | `RESOURCE_NOT_FOUND`(404) |
| PATCH | `/v1/run-triggers/{trigger_id}` | `Idempotency-Key`. cron/timezone/params/catchup/max concurrency/next fire 부분 수정. cron/timezone 변경 시 `next_fire_at`을 생략하면 다음 발생 시각 재계산. `trigger.manage` 권한 | 200 + 수정된 `RunTrigger` | `IR_SCHEMA_INVALID`(422), `RESOURCE_NOT_FOUND`(404) |
| POST | `/v1/run-triggers/{trigger_id}/pause` | `Idempotency-Key`. optional `{ reason }`. `trigger.manage` 권한 | 200 + `RunTrigger(status=paused)` | `RESOURCE_NOT_FOUND`(404), `AUTHZ_FORBIDDEN`(403) |
| POST | `/v1/run-triggers/{trigger_id}/resume` | `Idempotency-Key`. optional `{ reason }`. `trigger.manage` 권한 | 200 + `RunTrigger(status=enabled)` | `RESOURCE_NOT_FOUND`(404), `AUTHZ_FORBIDDEN`(403) |
| GET | `/v1/run-triggers/{trigger_id}/fires` | query: `limit`, `cursor`. `trigger.read` 권한 | 200 + `{ items, next_cursor }`, 각 item은 `RunTriggerFire`(`scheduled_for`, `run_id`, `failure_reason`) | `RESOURCE_NOT_FOUND`(404) |
| POST | `/v1/webhooks/run-triggers/{tenant_id}/{trigger_id}` | Public JWT-skip route. Headers: `X-RPA-Webhook-Event-Id`, `X-RPA-Webhook-Timestamp`, `X-RPA-Webhook-Signature=sha256=<hex>` where signature payload is `{timestamp}.{event_id}.{canonical_json(body)}` and key is resolved from `webhook_secret_ref`. Body must be a JSON object. | 202 + `RunTriggerWebhookReceipt`(`fire_id`, `status`, `run_id`, `duplicate`) | `UNAUTHENTICATED`(401), `IR_SCHEMA_INVALID`(422), `RESOURCE_NOT_FOUND`(404) |

Run trigger cron v1은 5-field numeric cron만 지원한다. 허용 문법은 `*`, comma list, numeric range, step(`*/15`, `1-5/2`)이며 named month/day, seconds/year, `L/W/#/?`, day-of-month와 day-of-week 동시 제한은 `IR_SCHEMA_INVALID`로 거절한다. 스케줄러는 발화 성공/실패/동시성 skip/중복 ledger 모두에서 다음 `next_fire_at`을 갱신한다. `skip_missed`는 현재 scheduler tick 이후의 다음 발생 시각으로 이동해 추가 missed backlog를 건너뛰고, `fire_once`는 방금 처리한 `scheduled_for` 이후의 다음 발생 시각으로 이동해 poll당 한 회차씩 따라잡는다. `max_concurrent_runs` 초과는 `run_trigger_fires.status=skipped`, `failure_reason.code=MAX_CONCURRENCY_REACHED`로 기록하고 같은 규칙으로 다음 시각을 갱신한다.

스케줄러 worker는 due trigger를 claim할 때 `(tenant_id, trigger_id, fire_key)` 멱등성을 먼저 확보하고, 같은 트랜잭션에서 `runs(queued)` 생성 + `run.created` outbox + `run_claim` enqueue를 수행해야 한다. `fire_key`는 trigger와 예정 시각을 포함하는 tenant-local idempotency key이며, 중복 fire는 새 run을 만들지 않는다.

Webhook trigger v1은 bearer/JWT가 아니라 HMAC replay boundary를 사용한다. `X-RPA-Webhook-Timestamp`는 5분 skew 안에 있어야 하고, `X-RPA-Webhook-Event-Id`는 `(tenant_id, trigger_id, fire_key=webhook:{event_id})` 멱등성 키가 된다. 동일 event id의 재전송은 기존 fire/run receipt를 반환하고 새 run을 만들지 않는다. 서명 검증 후 trigger가 `enabled`가 아니면 발화 원장을 만들지 않고 `IR_SCHEMA_INVALID(reason=webhook_trigger_not_enabled)`를 반환한다. `max_concurrent_runs` 초과는 cron과 동일하게 `run_trigger_fires.status=skipped`, `failure_reason.code=MAX_CONCURRENCY_REACHED`로 기록한다.

---

## 1.6 Ops Alerts (SLA/운영 알림 센터 v1)

Product Open v1의 P1 notification channel은 **콘솔용 계산형 알림 센터**다. Teams/Slack/메일/webhook 같은 외부 발송 채널, 수신자 라우팅, ack/snooze 원장, 재시도/전송 DLQ는 V2 P1 범위가 아니며 API가 성공으로 응답하지 않는다. 외부 발송을 추가하려면 SecretRef/connector/notification_deliveries 계약을 별도 버전으로 연다.

| Method | Path | 요청 요지 | 응답 요지 | 주요 ErrorCode |
|---|---|---|---|---|
| GET | `/v1/ops-alerts` | query: optional `severity`(`critical`/`warning`/`info`), optional `source`(`run_sla`/`human_task_sla`/`trigger_fire`/`failure_spike`/`dlq`), `limit`. `ops_alert.read` 권한 | 200 + `{ items, next_cursor:null }`, 각 item은 `OpsAlert`(`alert_id`, `severity`, `source`, `title`, `detail`, `subject_type`, `subject_id`, `recommended_action`, `route`, `detected_at`, optional `due_at`) | `AUTHZ_FORBIDDEN`(403), `IR_SCHEMA_INVALID`(422) |
| GET | `/v1/ops/health` | `ops_alert.read` 권한. 현재 테넌트의 graphile queue depth(가능한 경우), browser lease 점유/만료, 15분 이상 stale nonterminal run 수를 계산 | 200 + `OpsHealth`(`status`, `detected_at`, `queue`, `browser_leases`, `stale_runs`) | `AUTHZ_FORBIDDEN`(403) |
| GET | `/v1/bot-pools` | `ops_alert.read` 권한. Product Open v1은 신규 `bot_pools` 테이블 없이 기존 `workers`(infra)와 tenant-scoped `browser_leases`/`runs`/`run_triggers`를 합산한 synthetic browser pool을 조회한다 | 200 + `{ items:[BotPool], next_cursor:null }`. `BotPool`은 `capacity_slots`, `workers`, `leases`, `queue`, `health`, `health_reason`을 포함 | `AUTHZ_FORBIDDEN`(403) |
| GET | `/v1/credentials/concurrency` | `ops_alert.read` 권한 | 200 + `{ items:[ConcurrencyPolicy], next_cursor:null }`. `ConcurrencyPolicy`=`credential_ref`·`site_profile_id`·`site_name`·`max_concurrency`·`active_leases`(status='active' 또한 미만료 lease 수)·`label`·`registered_by`·`registered_at`(DG-4 메타: 표시명·마지막 등록자·시각, 값 아님). 정책 미설정 시 `[]`(기본 동시성 1). RLS 테넌트 스코프 | `AUTHZ_FORBIDDEN`(403) |
| POST | `/v1/credentials` | `Idempotency-Key`. body: `{ credential_ref, site_profile_id, max_concurrency, label? }`. `credential.manage`(admin, DG-4). ⛔ **시크릿 값 미수신** — SecretRef 경로 식별자만 등록(값은 out-of-band Vault/KMS); `value`/`secret`/`password`/`token` 등 값 필드 존재 시 거부. `credential_ref`는 `rpa/<env>/<runtime>/<purpose>/<name>` 규약 + purpose=자격증명(`executor`). `label`=운영자 표시명(선택, 값 아님), `registered_by`=처리자 자동 기록. 동일 `(ref, site)` 재등록은 `max_concurrency`·`label` upsert | 200 + `{ credential_ref, site_profile_id, max_concurrency, label }` | `IR_SCHEMA_INVALID`(422: 값필드/ref문법/site/max), `RESOURCE_NOT_FOUND`(404: site 부재), `AUTHZ_FORBIDDEN`(403) |
| DELETE | `/v1/credentials` | `Idempotency-Key`. query: `credential_ref`, `site_profile_id`. `credential.manage`(admin, DG-4). 활성·미만료 lease 가 있으면 거부(in-flight run 보호) | 200 + `{ credential_ref, site_profile_id, deleted:true }` | `WORKITEM_CHECKOUT_CONFLICT`(409: 활성 lease), `RESOURCE_NOT_FOUND`(404), `IR_SCHEMA_INVALID`(422), `AUTHZ_FORBIDDEN`(403) |
| GET | `/v1/worker-pools` | `worker_pool.manage`(admin, DG-3). 전용 워커 풀 레지스트리 + 호출 테넌트 배정 + 대기 실행 지연 신호 | 200 + `{ items:[{pool_key,description,created_at}], assigned_pool_key, pending:{queued_runs, oldest_queued_at} }`. 풀=인프라(전역), 배정=RLS. `pending`=호출 테넌트의 `queued` run 수·가장 오래된 시각(배정 풀에 워커 없으면 디스패치 안 돼 적체 → stuck 가시화) | `AUTHZ_FORBIDDEN`(403) |
| POST | `/v1/worker-pools` | `Idempotency-Key`. body: `{ pool_key, description? }`. `worker_pool.manage`(admin). `pool_key`=소문자 영숫자+`_-`(`default` 예약). 풀 생성/설명 갱신(upsert) | 200 + `{ pool_key, description }` | `IR_SCHEMA_INVALID`(422: pool_key 형식), `AUTHZ_FORBIDDEN`(403) |
| DELETE | `/v1/worker-pools/{pool_key}` | `Idempotency-Key`. `worker_pool.manage`(admin). 배정이 참조 중이면 거부(먼저 해제) | 200 + `{ pool_key, deleted:true }` | `WORKITEM_CHECKOUT_CONFLICT`(409: `pool_in_use`), `RESOURCE_NOT_FOUND`(404), `AUTHZ_FORBIDDEN`(403) |
| PUT | `/v1/worker-pool` | `Idempotency-Key`. body: `{ pool_key }`. `worker_pool.manage`(admin). 호출 테넌트를 풀에 배정(테넌트당 1풀, upsert). 미배정 테넌트의 run 은 `default` 풀 | 200 + `{ assigned_pool_key }` | `IR_SCHEMA_INVALID`(422), `RESOURCE_NOT_FOUND`(404: 미존재 풀), `AUTHZ_FORBIDDEN`(403) |
| DELETE | `/v1/worker-pool` | `Idempotency-Key`. `worker_pool.manage`(admin). 호출 테넌트 배정 해제(→ `default` 풀). 멱등 | 200 + `{ assigned_pool_key:null }` | `AUTHZ_FORBIDDEN`(403) |

계산 규칙(v1): 비종결 run이 60분 이상 지속되면 `run_sla`, 활성 human_task가 만료됐거나 15분 이내 만료되면 `human_task_sla`, run trigger fire가 `failed`/`skipped`이면 `trigger_fire`, 최근 15분 실패 run이 3건 이상이면 `failure_spike`, 미재처리 workitem/sink DLQ가 있으면 `dlq` 알림으로 투영한다. 알림은 저장 원장이 아니라 현재 DB 상태에서 계산되며, payload 본문·artifact 본문·secret 값은 노출하지 않는다.
Ops health(v1)는 저장 원장이 아니라 현재 DB 상태 계산값이다. `queue.available=false`는 Graphile queue view가 아직 설치되지 않은 배포/테스트 환경을 뜻하며, 이 경우 `pending_jobs=null`로 내려 보낸다. `browser_leases.expired_open>0`이면 `critical`, 15분 이상 stale nonterminal run이 있거나 tenant queue pending job이 100개 이상이면 `warning`, 그 외는 `ok`이다.
Bot pool(v1)은 운영 용량 표면용 read model이다. `capacity_slots`는 최근 heartbeat가 있고 circuit이 닫힌 active browser worker 수로 계산한다. 2분 이상 heartbeat가 없는 worker는 `workers.stale`로 집계하고 용량 슬롯에서는 제외한다. `leases`와 `queue`는 요청 테넌트 범위로만 계산하며, 만료된 reserved/active browser lease가 있으면 `health=critical`이다. 저장/수정 가능한 풀 정책, SLA 라우팅, 외부 알림 발송은 별도 계약이 열릴 때까지 v1 범위가 아니다.

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
| POST | `/v1/scenarios/{scenario_id}/promote-from-run` | `Idempotency-Key`. body: `{ run_id }` | 201 + 새 draft version(성공 run의 결정형 ActionPlan(click/fill/select/cache-hit)을 IR act args로 베이킹, PbD) + `{ scenario_version_id, promoted_node_ids, skipped }` | `RESOURCE_NOT_FOUND`(404), `IR_SCHEMA_INVALID`(422: run 미완료/타시나리오/promote할 deterministic plan 0), `IR_EXPRESSION_COMPILE_ERROR`(422) |
| POST | `/v1/scenarios/{scenario_id}/promotion-requests` | `Idempotency-Key`. body: `{ version, reason }`(사유 필수). operator+(`scenario.update`) | 201 + `{ request_id, version, status: pending, reason, requested_by }`. maker-checker prod 승격 요청(직접 `/promote`(admin)와 별개의 인간 승격 경로) | `IR_SCHEMA_INVALID`(422: 사유/버전/already_prod), `SCENARIO_VERSION_CONFLICT`(412: 동일 버전 pending 존재), `RESOURCE_NOT_FOUND`(404), `AUTHZ_FORBIDDEN`(403) |
| POST | `/v1/scenarios/{scenario_id}/promotion-requests/{request_id}/decide` | `Idempotency-Key`. body: `{ decision: approve\|reject, reason? }`. approver+(`scenario.promote.approve`) | 200 + `{ status: approved\|rejected }`. **요청자≠승인자(SoD) 강제**. approve 시 해당 버전 prod 승격(직접 promote 와 동일 compile+CAS) | `AUTHZ_FORBIDDEN`(403: 권한·`self_approval_forbidden`), `RESOURCE_NOT_FOUND`(404: pending 아님), `IR_SCHEMA_INVALID`/`IR_EXPRESSION_COMPILE_ERROR`(422) |
| GET | `/v1/scenarios/promotion-requests` | `scenario.promote.approve` 권한 | 200 + `{ items: [pending 요청 + scenario_name], next_cursor: null }` — approver 인박스. 정적 라우트(파라메트릭 `:scenario_id` 비가려짐), RLS 스코프 | — |
| GET | `/v1/scenarios/{scenario_id}/versions` | - | 200 + `{ items, next_cursor }` 최신 version 우선 | `RESOURCE_NOT_FOUND`(404) |
| GET | `/v1/scenarios/{scenario_id}/versions/{version}` | - | 200 + 지정 version의 IR + `ETag: <version>` | `RESOURCE_NOT_FOUND`(404) |
| POST | `/v1/scenarios/{scenario_id}/versions/{version}/rollback` | `If-Match: <latest_version>` + `Idempotency-Key`. body `{}` optional | 200 + 과거 IR을 최신+1 draft로 복제. 같은 키 재시도는 중복 version 없이 최초 응답 재생 | `SCENARIO_VERSION_CONFLICT`(412), `IR_SCHEMA_INVALID`(422), `IR_EXPRESSION_COMPILE_ERROR`(422), `RESOURCE_NOT_FOUND`(404) |
| POST | `/v1/scenarios/{scenario_id}/archive` | `If-Match: <latest_version>` + `Idempotency-Key`. body `{}` optional | 200 + scenario 보관, prod promotion 해제. 같은 키 재시도는 최초 응답 재생 | `SCENARIO_VERSION_CONFLICT`(412), `RESOURCE_NOT_FOUND`(404) |

¹ run 외 엔티티(scenario/human-task/workitem/site) 미존재 → `RESOURCE_NOT_FOUND`(404, v1.5 신설). run은 `RUN_NOT_FOUND` 유지.

**검증/승격 규약**(ir-expression §5 / ir-static-validation.md):
- save(POST/PUT)·promote 시 전 expression 파싱+타입체크(IREL) + IR 그래프 정적검증(V1..V11) 수행. 하나라도 실패 시 저장/승격 **거부**(런타임 파싱 없음, AST 캐시).
- 컴파일 에러(IREL_PARSE_ERROR 등)는 `IR_EXPRESSION_COMPILE_ERROR`(422), 그래프 검증 실패는 `IR_SCHEMA_INVALID`(422, `details`에 reason — 예: `shell_cmd_unregistered`)로 매핑.
- `validate`는 부작용 없는 dry-run(저장하지 않음) → ValidationReport 반환. `promote`만 prod 승격 + 캐시 빌드.
- Enterprise ALM 모드(`ALM_ENFORCE_MAKER_CHECKER=true`)에서는 legacy `promote`가 maker-checker 우회 경로가 될 수 없으므로 `IR_SCHEMA_INVALID(reason=legacy_promote_disabled_by_enterprise_alm)`로 거부한다. 새 경로는 §2.1 release workflow다.

### 2.1 Scenario Releases / Environment Bindings (Enterprise ALM v1)

환경은 tenant-scoped logical binding이며 값은 `dev|staging|prod`로 닫힌다. `prod` binding은 v1 동안 기존 `scenario_versions.promotion_status='prod'`와 mirror되어야 한다. 릴리스 상태는 `draft -> submitted -> approved -> deployed`, `submitted -> rejected`, `deployed -> rolled_back`만 허용한다. `approve`는 maker-checker로 `requested_by != approved_by`를 강제한다. 모든 명령은 `Idempotency-Key`를 요구하고, 배포/rollback은 `If-Match`로 최신 version 충돌을 방지한다.

| Method | Path | 요청 요지 | 응답 요지 | 주요 ErrorCode |
|---|---|---|---|---|
| GET | `/v1/scenarios/{scenario_id}/environment-bindings` | `scenario_release.read` 권한 | 200 + `{ items }`, current binding(`environment`, `scenario_version_id`, `version`, `release_id`, `activated_by`, `activated_at`) | `RESOURCE_NOT_FOUND`, `AUTHZ_FORBIDDEN` |
| GET | `/v1/scenarios/{scenario_id}/releases` | `scenario_release.read` 권한. query optional `status`, `target_environment`, `limit`, `cursor` | 200 + `{ items, next_cursor }` | `RESOURCE_NOT_FOUND`, `AUTHZ_FORBIDDEN`, `IR_SCHEMA_INVALID` |
| POST | `/v1/scenarios/{scenario_id}/releases` | `Idempotency-Key`. body `{ source_version, target_environment, reason? }`. `scenario_release.submit` 권한 | 201 + draft release + validation report + `package_hash` | `RESOURCE_NOT_FOUND`, `IR_SCHEMA_INVALID`, `IR_EXPRESSION_COMPILE_ERROR`, `AUTHZ_FORBIDDEN` |
| GET | `/v1/scenario-releases/{release_id}` | `scenario_release.read` 권한 | 200 + release detail + events | `RESOURCE_NOT_FOUND`, `AUTHZ_FORBIDDEN` |
| POST | `/v1/scenario-releases/{release_id}/submit` | `Idempotency-Key`. draft→submitted | 200 + release | `RESOURCE_NOT_FOUND`, `IR_SCHEMA_INVALID`, `AUTHZ_FORBIDDEN` |
| POST | `/v1/scenario-releases/{release_id}/approve` | `Idempotency-Key`. optional `{ reason }`. submitted→approved, `requested_by != actor` | 200 + release | `RESOURCE_NOT_FOUND`, `IR_SCHEMA_INVALID`, `AUTHZ_FORBIDDEN` |
| POST | `/v1/scenario-releases/{release_id}/reject` | `Idempotency-Key`. body `{ reason }`. submitted→rejected | 200 + release | `RESOURCE_NOT_FOUND`, `IR_SCHEMA_INVALID`, `AUTHZ_FORBIDDEN` |
| POST | `/v1/scenario-releases/{release_id}/deploy` | `Idempotency-Key` + `If-Match`. approved→deployed, compile/promote 재검증, environment binding 갱신 | 200 + release + current binding | `SCENARIO_VERSION_CONFLICT`, `RESOURCE_NOT_FOUND`, `IR_SCHEMA_INVALID`, `IR_EXPRESSION_COMPILE_ERROR`, `AUTHZ_FORBIDDEN` |
| POST | `/v1/scenario-releases/{release_id}/rollback` | `Idempotency-Key` + `If-Match`. deployed release 기준 rollback release 생성 후 approved/deployed로 기록 | 201 + rollback release + current binding | `SCENARIO_VERSION_CONFLICT`, `RESOURCE_NOT_FOUND`, `IR_SCHEMA_INVALID`, `IR_EXPRESSION_COMPILE_ERROR`, `AUTHZ_FORBIDDEN` |

Release audit:
- 제품 이력은 `scenario_release_events`가 권위다.
- 보안/거버넌스 감사는 `audit_log`에 `scenario_release.*` action으로 append한다. payload에는 actor, scenario_id, release_id, version, target_environment, package_hash, outcome/reason만 포함하고 IR 전문, SecretRef resolved value, artifact body, token 원문은 넣지 않는다.

---

## 2.5 Scenario Generations (자연어 → IR 저장 · 선택 실행)

| Method | Path | 요청 요지 | 응답 요지 | 주요 ErrorCode |
|---|---|---|---|---|
| GET | `/v1/scenario-generations/capabilities` | `scenario.read` 권한. planner/runtime visual evidence capability 조회 | 200 + `{ planner: { default_planner, available }, visual_evidence: { screenshot: { enabled, policies, default_policy }, video: { enabled, policies, default_policy, artifact_type, media_type } } }`. `planner.available`은 항상 `deterministic_mvp`를 포함하고, `llm_v1`은 서버 구현체가 주입된 경우에만 포함한다. `video.enabled=false`이면 `video.policies=["never"]`, `default_policy="never"`; true이면 `policies=["never","failure","always"]`, `default_policy="always"`. `video.enabled=true`는 recorder capability와 API artifact body/blob reader가 모두 준비된 상태를 뜻한다 | `AUTHZ_FORBIDDEN`(403) |
| GET | `/v1/scenario-generations` | query: optional `status`(`drafted`/`saved`/`run_queued`/`blocked`/`failed`), optional `run_id`(연결 run 역조회), optional `limit`(1..100, default 20), optional `cursor` | 200 + `{ items, next_cursor }`. 각 item은 generation 원장(`mode`, `prompt_hash`, optional `prompt_redacted_ref`, `planner`, optional `model`, `status`, `params_context`, `evidence_policy`, `created_by`, `created_at`, 연결 scenario/run, redacted `draft_ir`, `validation_report`, `blockers`)이며 prompt 원문은 노출하지 않는다. `run_id` 필터는 `scenario_generations(tenant_id, run_id)` 인덱스를 쓰는 RunTrace 딥링크 복원용 역조회이며 매칭 원장이 없으면 빈 목록을 반환한다 | `IR_SCHEMA_INVALID`(422; invalid limit/cursor/status/run_id) |
| POST | `/v1/scenario-generations` | `Idempotency-Key`. body: `prompt`(자연어), optional `name`, `mode`(`draft_only`/`save`/`save_and_run`, 기본 `save_and_run`), optional `planner`(`deterministic_mvp`/`llm_v1`, 기본 `deterministic_mvp`; `llm_v1`은 서버 구현체 주입 시에만), optional `start_url`, optional `target`(`site_profile_id`/`browser_identity_id`/`network_policy_id`), optional `params`, optional `model`, optional `evidence`(`screenshot`, `video`; 생략 시 `screenshot=each_step`, video capability가 켜져 있으면 `video=always`, 아니면 `video=never`). `scenario.create` 권한 필요, `save_and_run`은 추가로 `run.create` 권한 필요 | 200(`draft_only`) 또는 201. `{ generation_id, mode, status, prompt_hash, scenario_id?, scenario_version_id?, run_id?, prompt_redacted_ref?, planner, model?, params_context, evidence_policy, created_by, created_at, draft_ir, validation_report, blockers }`. 조건 충족 시 scenario 저장 후 run queued까지 원자 처리 | `IR_SCHEMA_INVALID`(422), `IR_EXPRESSION_COMPILE_ERROR`(422), `AUTHZ_FORBIDDEN`(403), `RESOURCE_NOT_FOUND`(404; 명시 model 정책/요청 planner 구현체 부재), `SCENARIO_VERSION_CONFLICT`(412; idempotency hash mismatch) |
| POST | `/v1/scenario-generations/{generation_id}/run` | `Idempotency-Key`. `run.create` 권한 필요. blocked/saved generation 원장에 보정값을 붙여 실행을 재시도한다. body: optional `target`(`site_profile_id`/`browser_identity_id`/`network_policy_id`), optional `start_url`(string uri), optional `params`(object), optional `model`(string\|null), optional `evidence`(`screenshot`, `video`). `target`이 없고 `start_url`만 보정된 경우 서버는 최초 생성과 동일하게 site/browser/network 단일 매칭을 추론하며, 0건/다건이면 추측하지 않고 `target_required_for_auto_run`과 함께 구체 추론 사유(`*_for_start_url`) blocker를 남긴다 | 201 + generation 원장(`status=run_queued`, `run_id` 포함). 아직 실행 blockers가 남으면 200 + generation 원장(`status=blocked`, `run_id=null`). 새 generation을 만들지 않고 같은 generation 원장에 run을 연결한다 | `IR_SCHEMA_INVALID`(422), `SCENARIO_VERSION_CONFLICT`(412; idempotency hash mismatch 또는 already_run), `WORKITEM_CHECKOUT_CONFLICT`(409; idempotency in-flight), `RESOURCE_NOT_FOUND`(404), `AUTHZ_FORBIDDEN`(403) |
| GET | `/v1/scenario-generations/{generation_id}` | — | 200 + generation 원장(`mode`, `prompt_hash`, optional `prompt_redacted_ref`, `planner`, optional `model`, `status`, `params_context`, `evidence_policy`, `created_by`, `created_at`, 연결 scenario/run, redacted `draft_ir`, `validation_report`, `blockers`) | `RESOURCE_NOT_FOUND`(404) |
| GET | `/v1/scenario-generations/{generation_id}/artifacts` | 쿼리: `?limit=&cursor=`. `artifact.read` 권한 | 200 + `{ items, next_cursor }` (generation-scoped planner/output artifact **목록**, metadata-only, 최신순). 본문은 `GET /v1/scenario-generations/{generation_id}/artifacts/{artifact_id}` 또는 `GET /v1/artifacts/{artifact_id}` 감사 게이트로만 조회 | `RESOURCE_NOT_FOUND`(404; 형식 무효 generation_id), `SECRET_ACCESS_DENIED`(403) |
| GET | `/v1/scenario-generations/{generation_id}/result-artifacts` | 쿼리: `?limit=&cursor=`. `artifact.read` 권한 | 200 + `{ items, next_cursor }` (generation에 연결된 run의 실행 결과 artifact **목록**, metadata-only, 최신순). `run_id=null`인 saved/blocked generation은 빈 목록을 반환한다. 본문/blob는 `GET /v1/artifacts/{artifact_id}` 감사 게이트로만 조회 | `RESOURCE_NOT_FOUND`(404; 형식 무효 또는 보이지 않는 generation_id), `SECRET_ACCESS_DENIED`(403) |
| GET | `/v1/scenario-generations/{generation_id}/artifacts/{artifact_id}` | `artifact.read` 권한 | 200 + artifact JSON body + `generation_id`. scoped generation 확인 후 전역 artifact body read와 동일한 RLS redaction gate 및 append-only audit boundary를 통과해야 반환 | `RESOURCE_NOT_FOUND`(404), `SECRET_ACCESS_DENIED`(403) |

**MVP planner 규약**
- `llm_v1` planner 호출은 `scenario_generation_llm_calls` 원장에 `(tenant_id, idempotency_key)`로 멱등 저장한다. planner output은 generation-scoped artifact로 flush된 뒤에만 재사용 가능하며, 저장/검증 실패 시 해당 generation의 buffered artifact와 LLM call 원장을 함께 폐기한다.
- v1 MVP는 `planner="deterministic_mvp"`로 시작한다. 외부 LLM 없이 prompt+힌트로 `observe`/`extract` 중심의 read-only IR을 생성한다. 이후 LLM planner는 동일 저장/검증/실행 경계 뒤에서 교체 가능해야 한다.
- `planner="llm_v1"`은 같은 `ScenarioPlanner` 포트의 선택 구현체다. 서버에 구현체가 주입되지 않으면 `RESOURCE_NOT_FOUND`로 닫히며, 구현체가 생성한 IR도 동일하게 `compileScenario`와 blocker/run enqueue 경계를 통과해야 한다.
- generation `status`는 `drafted`/`saved`/`run_queued`/`blocked`/`failed` 원장 enum이다. run/human-task/workitem state-machine enum과 섞지 않으며, 목록의 `?status=`는 이 generation status만 허용하고 그 외 값은 `IR_SCHEMA_INVALID`(`reason=invalid_generation_status`)로 닫는다.
- capability 조회는 콘솔의 기본 evidence 선택을 돕는 read-only 힌트이며, 서버도 `POST /v1/scenario-generations`에서 evidence 생략 시 같은 기본값을 적용한다. 서버는 여전히 `save_and_run`마다 video recorder와 artifact reader의 결합 capability를 최종 권위로 재검증하며, `video!=never`와 capability mismatch는 `video_recording_port_not_configured` blocker로 닫는다.
- "모든/다음/더보기 페이지", "all/every/next page", "load more" 수집 의도는 bounded pagination loop IR(`paginate_pages` → `extract_current_page` → `advance_page`)로 생성한다. 기본 `max_pages=3`, 자동 실행 상한은 10이며 초과 시 `pagination_page_limit_exceeded` blocker로 저장만 하고 run은 만들지 않는다.
- prompt 원문은 `scenario_generations`에 저장하지 않는다. 원장에는 `prompt_hash`와 선택적 `prompt_redacted_ref`만 둔다. `scenario_generations.draft_ir`는 instruction 텍스트를 redacted form으로 저장하고, 저장/실행용 원본 IR은 `scenario_versions.ir` 계약 경계에서만 유지한다.
- 생성/보정 실행에서 서버가 확정한 실행 params 맥락은 히스토리 재실행 보정을 위해 `params_context`에 저장한다. 비밀스러운 key(`password`/`secret`/`token`/`api_key`/`authorization`/`cookie`/`credential` 등)는 redacted marker로 저장하며, prompt 원문은 복제하지 않는다. redacted marker가 남아 있는 params 맥락은 실행 params로 승격하지 않고 `/run` 응답을 `params_context_redacted_value_required` blocker로 닫아 운영자 재입력을 요구한다. `start_url`, 자동 페이지네이션 `max_pages` 같은 비밀 아님 기본값은 `draft_ir.params_schema.properties.*.default`에도 남길 수 있다.
- 생성된 IR은 기존 scenario save와 동일하게 `compileScenario`(AJV → IREL → V1..V11)를 통과해야만 저장/실행된다. 실패하면 저장/실행하지 않는다.
- `save_and_run` 요청에서 `target`/`start_url`이 없거나 target row 미존재, red site 미승인, side-effect성 문구 감지 등으로 안전 실행 조건이 부족하면 scenario는 저장하되 run은 만들지 않고 `status=blocked`, `blockers[]`에 사유를 남긴다. 조용히 queued로 넘기지 않는다.
- 명시 `target`을 제공한 `save_and_run` 요청은 `start_url` origin이 `site_profiles.url_pattern` origin과 일치해야 한다. 불일치하면 `target_start_url_site_mismatch` blocker로 차단한다.
- evidence 요청은 현재 IR의 `node.policy.recording`으로 투영한다: `screenshot=each_step` 또는 `video=always` → `recording=always`, 둘 다 `never` → `never`, 그 외 → `masked_on_failure`.
- planner 산출 IR이 `meta.evidence` 또는 node recording 정책을 누락/약화해도 서버가 요청 `evidence`를 최종 권위로 정규화한 뒤 compile/save/run을 진행한다.
- `video!=never`는 runtime video recorder capability가 꺼져 있으면 `video_recording_port_not_configured` blocker로 자동 실행을 막는다. capability가 켜진 워커는 마스킹된 PNG 프레임을 WebM(`video_masked`)으로 인코딩해 pending artifact로 저장하고 redaction/retention lifecycle에 넘긴다.
- `target`이 없고 `start_url` 또는 프롬프트 내 첫 http(s) URL이 있으면 서버가 `site_profiles.url_pattern` origin과 매칭해 최신 `browser_identity`와 단일 매칭 `network_policy`를 자동 제안한다. 매칭 실패/애매함/후보 부재는 추측하지 않고 보정 진입점 `target_required_for_auto_run`과 **함께** 구체 사유 blocker를 남긴다: site 0건 `site_profile_unresolved_for_start_url`, site 다건(같은 origin url_pattern 중복) `site_profile_ambiguous_for_start_url`, browser identity 후보 부재 `browser_identity_unresolved_for_start_url`, network policy 0건 `network_policy_unresolved_for_start_url`, network policy 다건 `network_policy_ambiguous_for_start_url`. 이 추론 단계 사유는 명시 `target` 검증 경로의 `*_not_found`/`*_mismatch` 와는 별개다(추측 vs 명시).

---

## 3. Human Tasks (휴먼 태스크 인박스)

| Method | Path | 요청 요지 | 응답 요지 | 주요 ErrorCode |
|---|---|---|---|---|
| GET | `/v1/human-tasks` | 쿼리: `?status=<HumanTaskState>&kind=<HumanTaskKind>&assignee=&run_id=&limit=&cursor=` | 200 + `{ items, next_cursor }` (인박스 목록; `run_id`는 suspended run→정확한 task 딥링크용) | — |
| GET | `/v1/principals` | 쿼리: `?limit=&cursor=` | 200 + `{ items, next_cursor }` (담당자 디렉터리; 각 item `principal_id`/`sub`/`display_name`/`email`/`source`/`external_id`/`idp_provider`/`lifecycle_source` — name-picker용) | — |
| POST | `/v1/principals` | `Idempotency-Key`. body: `sub`·`display_name`(필수)·optional `email`. admin 권한 | 201 + principal(`principal_id`/`sub`/`display_name`/`email`/`source=manual`/`external_id=null`/`idp_provider=null`/`lifecycle_source=local`) | `AUTHZ_FORBIDDEN`(403), `IR_SCHEMA_INVALID`(422; 중복 `sub`) |
| PATCH | `/v1/principals/{principal_id}` | `Idempotency-Key`. body: optional `display_name`·`email`(`null`=제거) 최소 1개. admin 권한. sub 불변 | 200 + principal 갱신 | `RESOURCE_NOT_FOUND`(404), `AUTHZ_FORBIDDEN`(403), `IR_SCHEMA_INVALID`(422) |
| DELETE | `/v1/principals/{principal_id}` | `Idempotency-Key`. admin 권한 | 200 + `{ principal_id, deleted: true }`(human_tasks.assignee FK 없어 기존 배정 불변) | `RESOURCE_NOT_FOUND`(404), `AUTHZ_FORBIDDEN`(403) |
| GET | `/v1/principals/{principal_id}/role-assignments` | `principal.read` 권한. 해당 principal의 role assignment 이력 | 200 + `{ items, next_cursor }` | `RESOURCE_NOT_FOUND`, `AUTHZ_FORBIDDEN` |
| POST | `/v1/principals/{principal_id}/role-assignments` | `Idempotency-Key`. body `{ role, reason?, expires_at? }`. `rbac.grant` 권한 | 201 + role assignment(`status=active`) | `RESOURCE_NOT_FOUND`, `AUTHZ_FORBIDDEN`, `IR_SCHEMA_INVALID` |
| GET | `/v1/role-assignments` | `principal.read` 권한. query optional `principal_sub`, `role`, `status`, `limit`, `cursor` | 200 + `{ items, next_cursor }` | `AUTHZ_FORBIDDEN`, `IR_SCHEMA_INVALID` |
| POST | `/v1/role-assignments/{assignment_id}/revoke` | `Idempotency-Key`. body `{ reason }`. `rbac.grant` 권한. `source=scim` 같은 외부 관리 assignment는 회수 불가 | 200 + revoked assignment | `RESOURCE_NOT_FOUND`, `AUTHZ_FORBIDDEN`(`externally_managed_role_assignment`), `IR_SCHEMA_INVALID` |
| GET | `/v1/human-tasks/{human_task_id}` | — | 200 + 태스크 상세(`state`, `kind`, `assignee`, `timeout`, `on_timeout`, run 연계, `payload`, `result_schema`, `artifact_refs`, `result`) | `RESOURCE_NOT_FOUND`(404) |
| POST | `/v1/human-tasks/{human_task_id}/start` | `Idempotency-Key`. 배정된 담당자/역할 스코프 필요 | 200 + `in_progress`(H2) | `HUMAN_TASK_EXPIRED`(410), `AUTHZ_FORBIDDEN`(403) |
| POST | `/v1/human-tasks/{human_task_id}/resolve` | `Idempotency-Key`. body: optional `result` object(`decision`, `corrections`, `reason`, `confidence`, `notes`) | 200 + `resolved` 태스크 상세(`result` 저장). `human_task.resolved` 이벤트 → Run `resume_requested`(R13/H3) | `AUTHZ_FORBIDDEN`(403), `HUMAN_TASK_EXPIRED`(410), `IR_SCHEMA_INVALID`(422; result shape 오류) |
| POST | `/v1/human-tasks/{human_task_id}/assign` | `Idempotency-Key`. body: `assignee` | 200 + `assigned`(H1/H6) | `AUTHZ_FORBIDDEN`(403), `HUMAN_TASK_EXPIRED`(410) |
| POST | `/v1/human-tasks/{human_task_id}/escalate` | `Idempotency-Key`. body: optional `reason` | 200 + `escalated`(H5, 담당자 해제 모델): `assignee=NULL`로 비워 escalated 큐 개방(H6 assign 재배정) + optional `reason`을 `escalation_reason`(+`escalated_by`/`escalated_at`)으로 영속(추정 routing 아님). Run R15(suspended 유지). | `AUTHZ_FORBIDDEN`(403), `HUMAN_TASK_EXPIRED`(410), `CONTROL_PLANE_INTERNAL_ERROR`(500, run coupling 등 미지원 pending side effect) |

- 상태값은 `HumanTaskState`(`open`/`assigned`/`in_progress`/`resolved`/`expired`/`cancelled`/`escalated`)·`HumanTaskKind`(`approval`/`validation`/`exception`/`captcha`/`mfa`)와 정확히 일치(state-machine-types.ts).
- HumanTask V2 응답은 검증/교정 워크벤치를 위해 `payload`(작업 지시/필드), `result_schema`(입력 힌트), `artifact_refs`(참고 산출물 id 배열), `result`(해소 시 저장된 판정/교정 결과)를 포함한다. artifact 본문은 기존 Artifacts API의 redaction/RBAC 경계를 그대로 사용하며, HumanTask API가 artifact 본문을 인라인 조합하지 않는다.
- `result_schema.version="business_form_v1"`은 configurable HITL/data-entry의 최소 폼 계약이다. schema는 `fields[]`를 가지며 각 field는 `key`(`/^[A-Za-z_][A-Za-z0-9_]{0,63}$/`), `label`, `type`(`text`/`textarea`/`number`/`boolean`/`date`/`select`), optional `required`, `options`, `help_text`로 닫힌다. `select`는 비어 있지 않은 `options`가 필수이고, 다른 type은 options를 무시한다. `POST /resolve` 시 `decision="correct"`이면 `result.corrections`가 이 schema의 required/type/options를 만족해야 하며, 알 수 없는 correction key는 `IR_SCHEMA_INVALID`(422)로 거부된다. version 없는 legacy object는 조회 힌트로만 취급한다.
- 만료/종결 태스크에 resolve/assign/escalate 시도 → `HUMAN_TASK_EXPIRED`(410, business). timeout 정책 분기(fail→expired H4a / escalate→escalated H4b)는 태스크 생성 시 `on_timeout`(reserved-handlers @human_task 입력, 기본 `fail`)로 일원화되며 API가 재판정하지 않는다.
- `human_task_timeout_sweeper`는 `expires_at <= now()`인 `open`/`assigned`/`in_progress`/`escalated` 태스크를 tenant-scoped `FOR UPDATE SKIP LOCKED`로 처리한다. H4a/H8은 `human_task.expired` 후 연결 Run이 `suspended`이면 R14(`failed_business`)를 적용하고, H4b는 `human_task.escalated` 후 R15를 적용하되 태스크 상태 자체를 관리자 큐 표면으로 사용한다. H4b 진입 시 재만료를 위해 `expires_at`을 `human_task.default_timeout`만큼 연장한다.
- V2 resolve `result`는 **영속**된다. 공통 shape는 `decision`(닫힌 enum `approve`/`reject`/`correct`/`retry` — 본 API의 **`RESOLUTION_DECISIONS` 레지스트리가 권위 SSoT**)과 optional `corrections` object, `reason` string, `confidence` number(0..1), `notes` string이다. 이 결과는 인박스/상세/감사 검토의 제품 표면으로 제공되며, **재개 시 런타임이 자동 소비한다**(v2.30): 해소 후 run resume 시 런타임이 `human_tasks.result`를 re-SELECT 해 IREL `node.<owningNodeId>.decision`·`node.<owningNodeId>.correction.<key>` 스코프로 주입하고(`reserved-handlers.md` 복귀 토큰 §·`ir-expression.md` §2), 후행 노드의 `on[].when`이 사람 판정으로 분기한다(정적검증 `ir-static-validation.md` V9 게이트·V13 미해소-분기 승격차단). 신뢰 경계: resume 토큰에 판정을 적재하지 않고 서버 권위 `human_tasks.result`(RBAC+RLS 뒤·resolve 후 불변·idempotent)를 다시 읽으므로 변조/재사용으로 위조 불가. (이전 "`node.<handler>.result` 주입 비활성" 단언 및 그 폐기 네임스페이스는 v2.30 C1 계약으로 대체됨.)
- 재에스컬레이션 후에도 미해소 → H8(escalated→timeout→expired, 무한 대기 방지). escalate API는 H5(수동) 진입만 담당하고 timeout 기반 H4b/H8은 타이머 주도(API 비주도).
- assignment/routing 계약: `assignee`는 명시 담당자 PrincipalId(JWT sub, 자유형 string — UUID 보장 없음; `human_tasks.assignee`는 `approval_decisions.decided_by`와 동형 text), `assignee_role`은 @human_task 입력에서 온 역할 스코프이며 API가 임의로 "admin queue"로 재해석하지 않는다. `reassignAssignee` side effect는 반드시 호출측이 명시적으로 소비해야 한다. 현재 성공 가능한 소비자는 H6 `assign`과 timeout sweeper의 H4b/R15 소비(태스크 `state='escalated'`를 관리자 큐로 노출)뿐이다. H5 수동 escalate에서 발생하는 `reassignAssignee`는 durable routing port/assignee policy가 없으면 미지원 pending side effect로 보고 동일 트랜잭션을 rollback한 뒤 `CONTROL_PLANE_INTERNAL_ERROR`로 fail-closed해야 한다(`human_task.escalated` 이벤트 emit 금지, run 상태 유지).
- 담당자 picker 소스(`GET /v1/principals`): **테넌트 주체 디렉터리**(`principals` 테이블). item = `principal_id`(surrogate uuid)·`sub`(PrincipalId=JWT sub, 자유형)·`display_name`·`email`·`source`(`jwt`|`manual`|`scim`)·`external_id`·`idp_provider`·`lifecycle_source`(`local`|`jwt`|`scim`). 표시명은 JWT optional `name` 클레임 자동 upsert(source=`jwt`, lifecycle_source=`jwt`), admin 수동 등록(source=`manual`, lifecycle_source=`local`), 또는 향후 SCIM 동기화 예약 행(source/lifecycle_source=`scim`)으로 채운다 — 표시명 소스가 없으면 디렉터리에 동기화하지 않는다(이름 없는 항목 금지). `human_tasks.assignee` → `principals` FK는 두지 않아 디렉터리 미등록 sub도 직접 배정 가능(자유 입력 폴백 유지). RBAC=`principal.read`(viewer+ 후보 조회; 실 배정은 `human_task.assign`이 강제). 커서는 공유 `(created_at, id)` keyset.
- Role assignment v1: `principal_role_assignments`는 tenant-wide assignment ledger다. 콘솔/API grant는 `source='manual'`만 생성하고, 저장 계약은 향후 SCIM 동기화를 위해 `source='scim'`, `external_id`, `idp_provider`, `lifecycle_source`를 예약한다. effective roles는 token role과 active manual/SCIM assignment의 합집합이다. 자기 자신에게 `admin` 부여, 자기 자신의 마지막 `rbac.grant` 근거 회수, 만료된 `expires_at`, 중복 active `(tenant_id, principal_sub, role)`은 모두 거부한다. manual revoke API는 `source='manual'`만 회수하며, IdP/JWT claim role과 SCIM-managed assignment는 본 API로 회수할 수 없다. SCIM provider/schema/conflict rule은 `docs/enterprise-alm-rbac-implementation-design.md`의 blocked decision으로 추적한다.
- `cancel`(H7)은 별도 엔드포인트를 두지 않는다 — Run abort(§1) 연동으로만 발생(R16). 직접 API 노출은 Phase 2 결정.

---

## 4. Workitems / DLQ (작업항목 · 데드레터)

| Method | Path | 요청 요지 | 응답 요지 | 주요 ErrorCode |
|---|---|---|---|---|
| GET | `/v1/workitems` | 쿼리: `?status=<WorkitemState>&limit=&cursor=`. `target_id` 필터는 v1 미지원(제공 시 422) | 200 + `{ items, next_cursor }` | `IR_SCHEMA_INVALID`(422, `target_id_filter_unsupported`) |
| GET | `/v1/workitems/{workitem_id}` | — | 200 + 상세(`status` ∈ WorkitemState, `attempts`, `unique_reference`, `checked_out_by/at`, 연계 run) | `RESOURCE_NOT_FOUND`(404) |
| GET | `/v1/dlq` | 쿼리: `?kind=workitem|sink&limit=&cursor=` | 200 + `{ items, next_cursor }`. 항목은 `DEAD_LETTER` 상태 통지(ApiError 아님). `DeadLetter`는 `reason_code`(error-catalog `ErrorCode` — **workitem 한정**, `dead_letter.reason_code`)·`created_at`을 포함한다 | — |
| POST | `/v1/dlq/{dead_letter_id}/replay` | 쿼리: `?kind=workitem\|sink`(기본 workitem). `Idempotency-Key`. 운영자 재처리 권한 필요 | `kind=workitem`: 202 + workitem `new`로 복원(W10: attempts 리셋, DLQ에서 복원), `workitem.dead_lettered` 역방향 복원. `kind=sink`: 202 + 새 `sink_deliver` attempt **인큐**(상태전이 아님; 실 재전달은 worker egress 의존) | `WORKITEM_CHECKOUT_CONFLICT`(409), `AUTHZ_FORBIDDEN`(403)², `IR_SCHEMA_INVALID`(422, kind 무효) |
| POST | `/v1/dlq/replay-all` | 쿼리: `?kind=workitem\|sink`(기본 workitem). 운영자 재처리 권한 필요. **`Idempotency-Key` 불요** — 행 CAS(`replayed_at`/`requeued_at`)+적격 SELECT 가 자연 멱등(재호출은 신규 적격만) | 202 + `{ kind, attempted, replayed, conflicts, truncated }` — 적격 DLQ 전체(현재 페이지 한도 없이, 캡 500)를 per-item replay 로 처리한 집계. 예상 충돌(이미 처리/진행 중)은 `conflicts`로 집계(전체 실패 아님), `truncated`=캡 초과 잔여. RLS 스코프 | `AUTHZ_FORBIDDEN`(403), `IR_SCHEMA_INVALID`(422, kind 무효) |

- workitem DLQ: W5/W7에서 `dead_letter` 생성, W10 `manual_replay`로 복원(state-machine §2). 운영자 재처리 권한(`operatorAuthorized` guard, W10) 미보유 → 인가 실패. 목록 항목은 `reason_code`(실패 사유 = error-catalog `ErrorCode`)·`created_at`(발생 시각)을 함께 노출한다 — 운영자가 "왜/언제 죽었나"를 판별. **sink DLQ에는 `reason_code` 컬럼이 없어(`sink_deliveries`) 의도적으로 미제공(undefined)이다 — 조용한 누락이 아니라 데이터 부재; 없는 동형 필드를 발명하지 않는다.**
- workitems 응답의 `target_id`는 connector target 테이블이 도입되지 않은 v1에서 `null`로 고정된다. 필터는 조용히 무시하지 않고 `IR_SCHEMA_INVALID(target_id_filter_unsupported)`로 거부한다.
- sink DLQ는 데이터평면(`sink_deliveries.status='dead_letter'`)으로, 본 엔드포인트의 `kind=sink` 목록/replay는 sink 재전달을 트리거한다(release-decisions D8-A3 — 새 attempt_no·동일 `sink_idempotency_key`를 enqueue). replay는 원본 `dead_letter` 행을 `requeued_at`으로 소거 마킹(상태전이 아님; status enum 불변)하여 목록(`requeued_at IS NULL`)에서 제외하고 2차 replay를 404로 막는다 — workitem `replayed_at`와 동형. `kind=sink` RBAC은 `sink_dlq.replay`(in-handler, 역할집합은 `dlq.replay`와 동일). 실 재전달은 worker `SinkDeliveryPort`(외부 egress, D6-2)에 의존하며 egress 미바인딩 시 worker가 `SINK_DELIVERY_FAILED`로 표면화한다(라우트는 전달 성공을 가장하지 않는다). raw/normalized 멱등은 migration SQL이 보장(재정의 안 함).
- `DEAD_LETTER`(httpStatus 200)는 오류가 아닌 상태 통지이므로 목록/상세 본문의 상태 필드로만 나타나며 `ApiError`로 반환하지 않는다(§0.2).

² replay는 운영자 재처리 권한 게이트 → 권한 부족 시 `AUTHZ_FORBIDDEN`(403, security). 필요 역할은 auth-rbac.md §2(operator+).

---

## 5. Artifacts (산출물 조회 — redaction + RBAC 게이트)

| Method | Path | 요청 요지 | 응답 요지 | 주요 ErrorCode |
|---|---|---|---|---|
| GET | `/v1/artifacts/{artifact_id}` | — | 200 + artifact JSON body. v1 RLS redaction visibility gate, `artifact.read` RBAC, audit boundary 통과 시에만 | `RESOURCE_NOT_FOUND`(404), `SECRET_ACCESS_DENIED`(403) |
| GET | `/v1/artifacts/{artifact_id}/blob` | — | 200 + raw bytes with `Content-Type` and `Content-Disposition`. JSON body와 같은 RLS/RBAC/audit boundary를 통과하며 `object_ref`, `sha256`, JSON `content`는 노출하지 않음 | `RESOURCE_NOT_FOUND`(404), `SECRET_ACCESS_DENIED`(403) |
| GET | `/v1/runs/{run_id}/artifacts` | 쿼리: `?limit=&cursor=`. `artifact.read` 권한 | 200 + `{ items, next_cursor }` (run 하위 artifact **목록**, metadata-only, 최신순)⁵ | `RESOURCE_NOT_FOUND`(404; 형식 무효 run_id), `SECRET_ACCESS_DENIED`(403) |
| GET | `/v1/scenario-generations/{generation_id}/artifacts` | 쿼리: `?limit=&cursor=`. `artifact.read` 권한 | 200 + `{ items, next_cursor }` (generation 하위 planner/output artifact **목록**, metadata-only, 최신순)⁵ | `RESOURCE_NOT_FOUND`(404; 형식 무효 generation_id), `SECRET_ACCESS_DENIED`(403) |
| GET | `/v1/scenario-generations/{generation_id}/result-artifacts` | 쿼리: `?limit=&cursor=`. `artifact.read` 권한 | 200 + `{ items, next_cursor }` (generation에 연결된 run 하위 실행 결과 artifact **목록**, metadata-only, 최신순)⁵ | `RESOURCE_NOT_FOUND`(404; 형식 무효 또는 보이지 않는 generation_id), `SECRET_ACCESS_DENIED`(403) |

- 조회 허용 조건(security-contracts §8, impl-bundle §C access middleware): `redaction_status ∈ {redacted, not_required}` **AND** 호출자 역할이 해당 tenant/run의 artifact 조회 권한 보유.
- v1 본문/Blob 조회는 RLS redaction visibility gate로 pending/failed/quarantined/deleted/cross-tenant를 `RESOURCE_NOT_FOUND`(404, 존재 비노출)로 닫고, `artifact.read` 권한 부족은 `SECRET_ACCESS_DENIED`(403)로 닫는다. 409 `ARTIFACT_NOT_REDACTED`는 error catalog에 남아 있지만 v1 API 표면에서는 노출하지 않는다.
- **v1 구현 노트(release-decisions D8-A1 — RQ-010 라우트 빌드됨)**: 위 ① redaction 게이트는 v1에서 `artifacts_visible_isolation` RLS로 강제한다 — 앱 역할은 `redaction_status ∈ {redacted, not_required}`·미삭제(`deleted_at IS NULL`)·비격리(`quarantine=false`) 행만 SELECT 가능. 따라서 pending/failed/quarantined/deleted/cross-tenant는 모두 `RESOURCE_NOT_FOUND`(404, 존재 비노출)로 떨어지며 **`ARTIFACT_NOT_REDACTED`(409)는 v1에서 노출하지 않는다**(409를 honor하려면 BYPASSRLS 없는 SECURITY DEFINER 메타-read 필요 — D8-A1 대안, 연기). 200 본문은 redacted object를 object store에서 read해 반환한다. 실 **분산 object-store 바인딩(S3 등, 프로세스 간 공유)은 deploy-time(B3)** 이며 in-repo/단일 프로세스는 `FsObjectStore`로 동작한다(`ApiServerDeps.artifactStore` 미주입 시 라우트 미등록).
- `sensitive=true` 입력·redaction 대상은 평문 노출 금지(security-contracts §4/§9). artifact 본문은 항상 마스킹된 `RedactedString`/redacted object만.
- 보존/정리(retention_until·sweeper)는 데이터평면 job(impl-bundle §B `artifact_retention_sweeper`/`artifact_redaction_job`)이며 본 API는 조회만 노출(생성/삭제 API는 v1 미노출).

⁵ `GET /v1/runs/{run_id}/artifacts`, `GET /v1/scenario-generations/{generation_id}/artifacts`, `GET /v1/scenario-generations/{generation_id}/result-artifacts` — run 또는 자연어 generation 하위 artifact **목록**(발견/브라우즈; 단건 by-id의 비대칭 해소). `/artifacts`는 generation-scoped planner/output artifact를, `/result-artifacts`는 generation 원장에 연결된 `run_id`의 screenshot/video 등 실행 결과 artifact를 반환한다(`run_id=null`이면 빈 목록). **metadata-only**: `artifact_id`·`step_id`·`attempt`·`type`·`media_type`·`filename`·`byte_size`·`duration_ms`·`redaction_status`·`retention_until`·`legal_hold`·`created_at`만 노출하고 **본문(`content`)·`object_ref`(내부 ObjectRef, evidence 비노출)·`sha256`(원본 무결성 해시=fingerprint, security-contracts §11)은 미노출**. `step_id`/`attempt`는 step-scoped artifact provenance이며 run-level video나 자연어 generation artifact처럼 step에 속하지 않는 산출물은 `null`이다. `media_type`/`filename`/`byte_size`/`duration_ms`는 이미지·동영상 결과의 미리보기/다운로드 UI 힌트이며 disclosure 본문이 아니다. 본문 열람은 단건 `GET /v1/artifacts/{id}` 또는 generation-scoped `GET /v1/scenario-generations/{generation_id}/artifacts/{artifact_id}`(§10 audit 게이트)로만. 목록은 object content를 read하지 않아 **disclosure 경로가 아니므로 §10 audit boundary를 트리거하지 않으며**(audit는 본문 disclosure 경로 전용), 가시성은 `artifacts_visible_isolation` RLS(redacted/not_required·미삭제·비격리·동tenant)가 강제 — 별도 redaction/audit 게이트 불요. RBAC는 `artifact.read`(auth-rbac §2, deny→`SECRET_ACCESS_DENIED`), 최신순(`created_at` DESC) §0.5 커서 페이지. 해당 scope(run_id/generation_id)가 없는 orphan artifact는 본 목록에 미포함(retention sweeper 소관).

Raw media download/preview는 `GET /v1/artifacts/{id}/blob`을 사용한다. 이 경로는 JSON body read와 동일하게 `artifact.read` RBAC, RLS redaction gate, append-only audit를 통과한 뒤 object store raw bytes를 반환하며, 내부 `object_ref`는 응답 어느 위치에도 포함하지 않는다.

---

## 6. Gateway Policy (LLM 게이트웨이 정책)

| Method | Path | 요청 요지 | 응답 요지 | 주요 ErrorCode |
|---|---|---|---|---|
| GET | `/v1/gateway/policies` | — | 200 + `{ items: [정책 + version], next_cursor: null }` | — |
| GET | `/v1/gateway/call-summary` | 쿼리: `?days=<1..90>`(기본 30). `gateway_policy.read` 권한 | 200 + `{ window_days, total, by_model }` — LLM 호출 사용량/비용 집계(stagehand_calls GROUP BY model, 기간 윈도우). 각 항목=`{ model, calls, input_tokens, output_tokens, cost }`. 토큰/비용이 전부 NULL이면 합도 `null`(0 단정 금지). 비용 DESC(NULL 마지막), RLS 스코프 | — |
| GET | `/v1/gateway/policy` | 쿼리: optional `?model=` | 200 + 모델 정책(`model`, `capabilities`{jsonMode/vision/...}, `budget`{maxInputTokens/maxOutputTokens/maxCost}, fallback 설정, `is_default`) | — |
| POST | `/v1/gateway/policy` | `Idempotency-Key`. body: 신규 정책(`model`, `capabilities`, `budget`, optional fallback/`is_default`) | 201 + 생성 정책, `ETag`=정책 버전 | `AUTHZ_FORBIDDEN`(403), `IR_SCHEMA_INVALID`(422; `policy_model_in_use`), `LLM_CAPABILITY_MISMATCH`(422)³ |
| PUT | `/v1/gateway/policy` | `If-Match`(정책 버전) + `Idempotency-Key`. body: 정책 갱신(optional `is_default` 토글) | 200 + 갱신 정책(`is_default` 포함) | `AUTHZ_FORBIDDEN`(403), `POLICY_VERSION_CONFLICT`(412), `LLM_CAPABILITY_MISMATCH`(422)³ |
| DELETE | `/v1/gateway/policy` | 쿼리: required `?model=`. `If-Match`(정책 버전) + `Idempotency-Key` | 200 + `{ model, deleted: true }` | `AUTHZ_FORBIDDEN`(403), `POLICY_VERSION_CONFLICT`(412), `RESOURCE_NOT_FOUND`(404) |

- `capabilities`는 llm-gateway-adapter.md `ModelCapabilities`(jsonMode 등). Gateway는 호출 전 capabilities로 primitive 적합성 검사(extract+jsonMode=false → `LLM_CAPABILITY_MISMATCH`).
- §19 결정 반영(README v1.4): Codex/vLLM는 capabilities 게이트로 처리 — jsonMode 미지원 시 prompt-schema+strict 폴백(adapter §7), vLLM는 OpenAI 호환 adapter 재사용·`sse=false` 모델만 sync 폴백. 실제 지원범위는 구현 시 라이브 capabilities로 확정(안전 폴백 정의됨).
- 정책의 ETag 대상은 `db/migration_core_entities.sql` `gateway_policies.version`이다. 정책 변경은 `(tenant_id, model, version)` CAS로 반영하고, 충돌 시 `POLICY_VERSION_CONFLICT`(412)로 최신 정책 재조회 후 재시도한다.
- `is_default`(Gap2 — §0.7): 테넌트 기본 정책 토글. 부분 UNIQUE(`uq_gateway_policies_default`, 테넌트당 ≤1)로 보장하며, PUT에서 `is_default=true` 지정 시 같은 CAS tx에서 기존 기본 정책을 선해제한다(원자). 선해제도 demote된 정책의 `version`을 bump하므로(표현 변경이 ETag에 반영) 그 정책의 stale `If-Match` PUT은 412로 최신 재조회를 강제받는다. 미지정 시 현재값 유지. 무인(스케줄·워크아이템) run의 model 해소원(§0.7 ②).

³ 정책 변경이 capabilities와 모순되게 모델/jsonMode를 설정하면 거부(`LLM_CAPABILITY_MISMATCH`, 422).

---

## 7. Sites (사이트 risk 승인)

| Method | Path | 요청 요지 | 응답 요지 | 주요 ErrorCode |
|---|---|---|---|---|
| GET | `/v1/sites` | 쿼리: `?risk=red|amber|green&limit=&cursor=` | 200 + `{ items, next_cursor }` (site_profiles 요약: `url_pattern`, risk, 승인/circuit 상태, `session_ready`/`session_expires_at`, `default_browser_identity_id`, `default_network_policy_id`) | — |
| GET | `/v1/sites/{site_profile_id}` | — | 200 + 사이트 상세(`url_pattern`, risk, 승인 상태, circuit 상태, 세션 준비 메타) | `RESOURCE_NOT_FOUND`(404) |
| POST | `/v1/sites` | `Idempotency-Key`. 생성 권한(`site.create`) 필요. body: `name`(필수)·`url_pattern`(필수, http(s) origin)·optional `risk`(green default/amber/red)·optional `page_state_selectors` | 201 + 생성된 site 요약(`site_profile_id`/`name`/`url_pattern`/`risk`/`approved`/`default_browser_identity_id`/`default_network_policy_id`). 서버는 생성 tx 안에서 기본 `browser_identity`(site scoped)와 origin-host `network_policy`를 같이 만들어 자연어 생성 target 자동 채움에 사용한다. | `AUTHZ_FORBIDDEN`(403)⁴, `IR_SCHEMA_INVALID`(422)⁵ |
| PATCH | `/v1/sites/{site_profile_id}` | `Idempotency-Key`. 수정 권한(`site.update`) 필요. body: `name`(필수) | 200 + 갱신된 site 요약(`site_profile_id`/`name`) | `AUTHZ_FORBIDDEN`(403)⁴, `RESOURCE_NOT_FOUND`(404), `IR_SCHEMA_INVALID`(422; 중복 name reason=`site_name_already_exists`) |
| PATCH | `/v1/sites/{site_profile_id}/page-state` | `Idempotency-Key`. 수정 권한(`site.update`) 필요. body: `{ page_state_selectors }` where value is `SitePageStateConfig` 또는 `null`(해제) | 200 + `{ site_profile_id, page_state_selectors, page_state_summary }` | `AUTHZ_FORBIDDEN`(403), `RESOURCE_NOT_FOUND`(404), `IR_SCHEMA_INVALID`(422; invalid_page_state_selectors) |
| GET | `/v1/sites/{site_profile_id}/elements` | query: `?stability=stable\|review_needed\|broken&search=&limit=&cursor=`. 조회 권한(`site.read`) 필요 | 200 + `{ items, next_cursor }`. items are site-scoped browser Object Repository entries: `element_id`, `element_key`, `label`, `selector`, `element_type`, `stability`, `source`, `sample_url`, `usage_count`, `last_verified_at`, `updated_at` | `AUTHZ_FORBIDDEN`(403), `RESOURCE_NOT_FOUND`(404), `IR_SCHEMA_INVALID`(422) |
| POST | `/v1/sites/{site_profile_id}/elements` | `Idempotency-Key`. 수정 권한(`site.update`) 필요. body: `element_key`, `label`, `selector`, optional `element_type`, `stability`, `source`, `sample_url`, `notes` | 201 + created `SiteElement`. `element_key` is unique per site. | `AUTHZ_FORBIDDEN`(403), `RESOURCE_NOT_FOUND`(404), `IR_SCHEMA_INVALID`(422; duplicate reason=`element_key_already_exists`) |
| PATCH | `/v1/sites/{site_profile_id}/elements/{element_id}` | `Idempotency-Key`. 수정 권한(`site.update`) 필요. body may update `label`, `selector`, `element_type`, `stability`, `sample_url`, `notes`. `last_verified_at`은 probe 결과 전용 필드라 일반 PATCH에서 `IR_SCHEMA_INVALID(reason=probe_managed_field)`로 거절한다. | 200 + updated `SiteElement` | `AUTHZ_FORBIDDEN`(403), `RESOURCE_NOT_FOUND`(404), `IR_SCHEMA_INVALID`(422) |
| POST | `/v1/sites/{site_profile_id}/elements/{element_id}/probe` | `Idempotency-Key`. 수정 권한(`site.update`) 필요. optional body: `sample_url`. Browser DOM selector probe only. | 200 + `{ probe_status, match_count, reason_code, checked_at, element }`. `probe_status=matched` updates `stability=stable`; `not_found` updates `review_needed`; `invalid_selector` updates `broken`; missing runtime/sample URL returns `not_run` and never pretends success. | `AUTHZ_FORBIDDEN`(403), `RESOURCE_NOT_FOUND`(404), `IR_SCHEMA_INVALID`(422) |
| DELETE | `/v1/sites/{site_profile_id}/elements/{element_id}` | `Idempotency-Key`. 수정 권한(`site.update`) 필요 | 200 + `{ element_id, deleted: true }` | `AUTHZ_FORBIDDEN`(403), `RESOURCE_NOT_FOUND`(404) |
| GET | `/v1/sites/{site_profile_id}/recordings` | query: `?status=recording\|completed\|discarded\|failed&limit=&cursor=`. 조회 권한(`site.read`) 필요 | 200 + `{ items, next_cursor }`. items are Browser Recorder sessions with `recording_session_id`, `name`, `start_url`, `status`, `event_count`, `draft_ir`, `validation_report`, timestamps. | `AUTHZ_FORBIDDEN`(403), `RESOURCE_NOT_FOUND`(404), `IR_SCHEMA_INVALID`(422) |
| POST | `/v1/sites/{site_profile_id}/recordings` | `Idempotency-Key`. 수정 권한(`site.update`) 필요. body: `name`, optional `start_url`(미지정 시 site `url_pattern`) | 201 + recording session `status=recording`. 쿠키/입력 원문은 저장하지 않음 | `AUTHZ_FORBIDDEN`(403), `RESOURCE_NOT_FOUND`(404), `SITE_PROFILE_BLOCKED`(403), `IR_SCHEMA_INVALID`(422) |
| GET | `/v1/sites/{site_profile_id}/recordings/{recording_session_id}/events` | query: `?limit=&cursor=`. 조회 권한(`site.read`) 필요 | 200 + `{ items, next_cursor }` ordered by `seq`. 이벤트는 `navigate/click/input/select/submit/wait` 메타와 selector/url/label/value_preview만 포함 | `AUTHZ_FORBIDDEN`(403), `RESOURCE_NOT_FOUND`(404), `IR_SCHEMA_INVALID`(422) |
| POST | `/v1/sites/{site_profile_id}/recordings/{recording_session_id}/events` | `Idempotency-Key`. 수정 권한(`site.update`) 필요. body: `{ events: [...] }`, 각 event는 `event_type`, optional `selector`, `element_key`, `label`, `url`, `value_preview` | 200 + `{ recording_session_id, appended, event_count }`. raw `value`/password/token/cookie 필드는 거부 | `AUTHZ_FORBIDDEN`(403), `RESOURCE_NOT_FOUND`(404), `IR_SCHEMA_INVALID`(422) |
| POST | `/v1/sites/{site_profile_id}/recordings/{recording_session_id}/complete` | `Idempotency-Key`. 수정 권한(`site.update`) 필요 | 200 + recording session `status=completed`, `draft_ir`, `validation_report` 포함. draft_ir는 `navigate` + deterministic `act.args.*_selector` 중심의 실행 가능한 초안이며, 서버는 같은 compile pipeline으로 정적 검증 리포트를 저장한다 | `AUTHZ_FORBIDDEN`(403), `RESOURCE_NOT_FOUND`(404), `IR_SCHEMA_INVALID`(422; event 0건 등) |
| POST | `/v1/sites/{site_profile_id}/approve` | `Idempotency-Key`. 승인 권한 필요. body: optional `reason`/`expires_at` | 200 + 승인 반영(risk=red 사이트 실행 허용) | `AUTHZ_FORBIDDEN`(403)⁴ |
| POST | `/v1/sites/{site_profile_id}/session/capture` | `Idempotency-Key`. 세션 등록 권한(`session.capture`) 필요. body: optional `login_url`(미지정 시 사이트 `page_state_selectors.loginUrl`) | 201/200 + `{ capture_session_id, site_profile_id, status, login_url, auth_selector? }`. 동일 사이트 active 캡처가 있으면 새로 띄우지 않고 기존 행 반환 | `AUTHZ_FORBIDDEN`(403), `RESOURCE_NOT_FOUND`(404), `SITE_PROFILE_BLOCKED`(403), `IR_SCHEMA_INVALID`(422) |
| GET | `/v1/sites/{site_profile_id}/session/capture` | 세션 등록 권한(`session.capture`) 필요. 최근 10개 캡처 상태 조회 | 200 + `{ items: [{ capture_session_id, status, detail, updated_at }], next_cursor: null }`. 쿠키/자격증명/토큰/로그인 입력값은 절대 반환하지 않음 | `AUTHZ_FORBIDDEN`(403), `RESOURCE_NOT_FOUND`(404) |

- `site risk=red`는 미승인 시 실행 차단(`SITE_PROFILE_BLOCKED`, 403, error-catalog operatorAction="site risk=red 승인 워크플로우"). 본 엔드포인트가 그 승인 워크플로우의 제어평면 진입점.
- 세션 캡처 상태 목록은 운영자 피드백용 메타데이터다. 상태 예: `launching`(창 열기), `awaiting_login`(운영자 로그인 대기), `capturing`(저장 중), `captured`(등록 완료), `failed`, `expired`.
- `page_state_selectors`는 브라우저 페이지 상태 산출용 DOM selector 계약이다. `loginUrl`/`authenticatedWhen.selector`/`flags.*` 같은 비밀이 아닌 메타만 허용하며, 쿠키·토큰·비밀번호·OTP 등 Secret 값은 절대 저장하지 않는다. 수정 시 서버가 `parseSitePageStateConfig`로 닫힌 flag 레지스트리를 검증해 잘못된 selector 계약을 저장 전에 거부한다.
- `site_element_repository`는 Browser RPA V2의 Object Repository v1이다. 범위는 DOM-backed browser selectors로 한정하며, desktop UIA/Win32/Citrix/vision 객체 저장소가 아니다. `selector`와 `sample_url`은 비밀이 아닌 메타데이터만 허용하고 cookie/token/password/OTP 값은 저장하지 않는다. 시나리오 실행 중 동적 IR selector 치환은 v1 성공 경로가 아니며, 콘솔 작성/유지보수 표면에서 같은 `element_key`의 selector를 한 곳에서 관리하는 것이 P1 범위다. 단, Browser Recorder 완료 시에는 녹화 이벤트의 `element_key`가 저장소에 존재하면 해당 저장소 selector를 draft IR에 정적 스냅샷으로 반영하고, 없으면 녹화 이벤트 selector로 fallback한다. selector probe는 실제 브라우저 probe 포트가 연결된 경우에만 DOM 매칭을 수행하며, 포트가 없거나 `sample_url`이 없으면 `not_run`으로 명시한다.
- `browser_recording_sessions`/`browser_recording_events`는 Browser Recorder v1이다. 범위는 DOM 이벤트 메타 녹화이며 desktop/vision/attended 녹화가 아니다. 입력 이벤트는 원문 값을 저장하지 않고 `value_preview`만 허용한다. 서버는 `value`, `password`, `token`, `cookie`, `secret`, `otp`, `mfa` 같은 민감 필드명을 요청 본문에서 거부한다. 완료 시 생성되는 `draft_ir`은 운영자가 검토·수정할 초안이며, 자동 prod 승격이나 런타임 브라우저 확장 배포까지 포함하지 않는다. 완료 응답의 `validation_report`는 저장 전 시나리오와 같은 schema/static compile pipeline 결과이며, `errors`가 있으면 UI는 초안 저장/실행 전 수정 필요로 표시해야 한다. v1의 실브라우저 기록은 운영자 PC의 로컬 에이전트(`app record:browser`)가 대상 페이지 DOM 이벤트를 수집해 위 append API로 전송하는 방식이다. Bearer 토큰은 에이전트 프로세스의 Node fetch에만 사용하며 대상 페이지 스크립트에는 주입하지 않는다.

### 결재(approval) 명령 — 하이웍스 결재 인박스(Model A)

| 메서드 | 경로 | 입력 | 출력 | 에러 |
|---|---|---|---|---|
| POST | `/v1/approvals/decide` | `Idempotency-Key`. 결재 권한(`approval.decide`, approver+) 필요. body: `source_run_id`(수집 run)·`doc_ref`(approval origin 절대 URL)·`decision`(`approve`\|`reject`)·`reason`(reject 필수) | 201 + `{ decision_id, source_run_id, doc_ref, decision, spawned_run_id }` | `AUTHZ_FORBIDDEN`(403), `APPROVAL_ALREADY_DECIDED`(409), `RESOURCE_NOT_FOUND`(404), `IR_SCHEMA_INVALID`(422) |

- 건별 approver-게이트 결재. `approval_decisions` `UNIQUE(tenant_id, source_run_id, doc_ref)`로 이중결재 차단: 동일 `Idempotency-Key` replay→최초 응답(같은 `spawned_run_id`) 재생, 다른 키·동일 `(source_run, doc_ref)`→`APPROVAL_ALREADY_DECIDED`(409). 결정 INSERT + 내부 DECIDE 시나리오("하이웍스 결재 처리" 최신 prod) run 스폰이 **동일 tx**(부분실패 원자). `source_run_id` 부재/cross-tenant→`RESOURCE_NOT_FOUND`(RLS), `reason` 누락(reject)·`doc_ref` 비-URL→`IR_SCHEMA_INVALID`. 실 승인/반려 클릭은 스폰된 처리 run이 수행(비가역).
- circuit 상태(`site.circuit_opened`/`site.circuit_closed` 이벤트, `SITE_CIRCUIT_OPEN` 503)는 조회로만 노출 — circuit 임계/재개는 `ops-defaults.md` 운영 정책이며, v1 API는 강제 재개를 노출하지 않는다.
- `risk` 등급값(red/amber/green)·site_profiles 승인/서킷 컬럼은 `db/migration_core_entities.sql`가 고정한다. 본 문서는 승인 흐름과 에러코드를 함께 고정한다.

⁴ 승인 권한 미보유 → `AUTHZ_FORBIDDEN`(403, security). 필요 역할은 auth-rbac.md §2(approver). (`SITE_PROFILE_BLOCKED`는 런타임 실행 차단용으로 별개.)

⁵ `POST /v1/sites` 생성: `name`은 테넌트 내 유일(`site_profiles UNIQUE(tenant_id, name)`; 중복 → `IR_SCHEMA_INVALID` 422 reason=`site_name_already_exists`). `url_pattern`은 http(s) origin이어야 한다 — 런타임 `resolveSiteProfileId`가 entry navigate URL의 `URL.origin` 동일성으로 사이트를 해소하므로, 비-origin/opaque-scheme(`file:`/`data:` 등)은 매칭 불가 사이트라 생성 거부(422 `invalid_url_pattern`). `page_state_selectors`는 생성 시점에 `SitePageStateConfig`(닫힌 flag 레지스트리)로 엄격 검증되어 무효 config(런타임 `PAGE_STATE_UNRESOLVED`)를 선차단한다(422 `invalid_page_state_selectors`). `risk=green`(기본)은 즉시 실행 가능하고 `red`는 생성 후 approve 워크플로우가 필요하다(`approved=false`). 생성 tx는 기본 `browser_identities` 행과 `url_pattern` origin host만 허용하는 기본 `network_policies` 행도 함께 만든다. 따라서 `GET /v1/sites`의 `default_browser_identity_id`/`default_network_policy_id`가 즉시 채워지고, 자연어 생성 UI와 target inference가 새 사이트를 곧바로 실행 대상으로 사용할 수 있다.

---

## 8. Connector & Template Catalog (커넥터/템플릿 카탈로그)

| Method | Path | 요청 요약 | 응답 요약 | 주요 ErrorCode |
|---|---|---|---|---|
| GET | `/v1/connectors` | 쿼리: `?kind=browser\|api\|file\|notification\|data&status=available\|candidate\|requires_admin\|blocked&limit=&cursor=`. 조회 권한(`connector.read`) 필요 | 200 + `{ items, next_cursor }`. 항목은 `connector_id`, `name`, `kind`, `category`, `status`, `priority`, `summary`, `best_for`, `supported_actions`, `template_ids`, `required_rbac_actions`, `required_secret_refs`, `allowed_domains`, `manifest_permissions`, `implementation_state`, `security_notes`, `created_at`, `updated_at` 포함 | `AUTHZ_FORBIDDEN`(403), `IR_SCHEMA_INVALID`(422) |
| GET | `/v1/templates` | 쿼리: `?connector_id=&kind=browser_workflow\|api_workflow\|file_workflow\|notification_workflow&status=...&limit=&cursor=`. 조회 권한(`connector.read`) 필요 | 200 + `{ items, next_cursor }`. 항목은 `template_id`, `connector_id`, `name`, `kind`, `status`, `priority`, `summary`, `best_for`, `required_params`, `required_secret_refs`, `produced_ir_pattern`, `success_criteria`, `created_at`, `updated_at` 포함 | `AUTHZ_FORBIDDEN`(403), `IR_SCHEMA_INVALID`(422) |

- 본 카탈로그는 브라우저 기반 RPA 도입 검토와 템플릿 선택을 위한 read-only surface다. 실제 enable/install, profile/target 생성, 외부 API 실행은 별도 보안 경계와 후속 계약이 필요하다.
- `required_secret_refs`와 `manifest_permissions.secret_refs`는 SecretRef namespace 또는 pattern만 노출한다. 평문 token/password/cookie/header 값은 API 응답, audit payload, template payload에 들어가면 안 된다.
- `status=requires_admin` 항목은 `connector.enable` 또는 runtime capability가 필요함을 뜻한다. 조회는 viewer+가 가능하지만 enable/install은 기존 admin-only `connector.enable` 및 `CONNECTOR_PERMISSION_DENIED` 경계를 유지한다.
- desktop/attended client 자동화는 본 범위가 아니다. `blocked` 항목은 브라우저 전용 scope에서 실행 surface가 없음을 명시하기 위한 제품/로드맵 신호다.

---

## 9. Audit Log Explorer (감사로그 조회)

| Method | Path | 요청 요지 | 응답 요지 | 주요 ErrorCode |
|---|---|---|---|---|
| GET | `/v1/audit-log` | 쿼리: `?action=&outcome=allow\|deny\|blocked\|error&actor=&correlation_id=&limit=&cursor=`. 조회 권한(`audit.read`) 필요 | 200 + `{ items, next_cursor }`. 항목은 `audit_id`, `sequence_no`, `actor(subject_id, roles)`, `action`, `outcome`, `reason`, `correlation_id`, `idempotency_key`, `occurred_at`, `payload_schema_ref`, `retention_until`, `legal_hold`, `previous_hash`, `hash`, `created_at`만 포함. `payload` 본문은 의도적으로 미노출 | `AUTHZ_FORBIDDEN`(403), `IR_SCHEMA_INVALID`(422) |
| GET | `/v1/audit-log/export` | 쿼리: list와 동일 + optional `format=csv`(기본 csv). 조회 권한(`audit.read`) 필요 | 200 `text/csv`. CSV 컬럼은 list 항목과 동일한 비민감 요약 필드만 포함하며 `payload` 본문은 미노출 | `AUTHZ_FORBIDDEN`(403), `IR_SCHEMA_INVALID`(422; `invalid_export_format`) |

- `audit_log`는 PostgreSQL append-only/hash-chain 권위 저장소이며 조회 API는 변이 동작을 제공하지 않는다.
- 조회는 `withTenantTx`/RLS로 tenant scope를 강제한다. 타 tenant 행은 목록에 나타나지 않는다.
- `payload` 본문은 보안 경계 판단의 내부 근거일 수 있어 콘솔/API에서 직접 노출하지 않는다. 운영자 검토 표면은 actor/action/outcome/reason/correlation/hash-chain 요약만 사용한다.

---

## 10. 엔드포인트 ↔ 상태/이벤트 정합 요약

| 명령 엔드포인트 | 상태 전이(state-machine) | emit 이벤트(event-envelope) | UI 문구 |
|---|---|---|---|
| `POST /runs` | (dispatch) → `queued` | `run.created` | "대기" |
| `POST /runs/{id}/abort` | `*` → `aborting` → `cancelled` (R6/R10/R16/R23/R24/R26/R27/R28), `completing`은 거부(R25) | `run.cancelled` | "취소됨" |
| `POST /runs/{id}/rerun` | `failed_business|failed_system` source → 새 child run `queued` | `run.created`(child), 감사 `run.rerun` | "재실행 대기" |
| `POST /runs/{id}/resume` | `suspended` → `resume_requested`(R13) 또는 `resume_requested` 재인큐 | `run.resume_requested`, 감사 `run.resume` | "재개 요청" |
| `POST /runs/{id}/priority` | `queued` 유지, Graphile run_claim 재인큐 | 감사 `run.prioritize` | "우선순위 변경" |
| `POST /human-tasks/{id}/resolve` | HumanTask `in_progress`→`resolved`(H3), Run `suspended`→`resume_requested`(R13) | `human_task.resolved` | "처리완료" |
| `POST /human-tasks/{id}/escalate` | H5/R15 `reassignAssignee` 처리 owner가 있을 때만 HumanTask `*`→`escalated`, Run R15(suspended 유지). 미지원이면 fail-closed rollback | `human_task.escalated`(성공 시) | "관리자 이관" |
| `POST /dlq/{id}/replay` | Workitem `abandoned`→`new`(W10) | (workitem 재인입) | "재처리" |
| `POST /scenarios/{id}/promote` | (version 승격 + AST 캐시 빌드) | — | "승격됨" |
| `POST /scenarios/{id}/versions/{version}/rollback` | (과거 version을 최신+1 draft로 복제) | — | "롤백됨" |
| `POST /scenarios/{id}/archive` | (active scenario 보관 + promotion 해제) | — | "보관됨" |

---

## 11. D1 위임 (본 문서가 고정하지 않는 것)
- 전체 OpenAPI 본문: 요청/응답 **스키마 본문**(필드 타입·required·examples), 파라미터 상세, `details` 페이로드 구조 — D1 codegen이 본 envelope/error-catalog/schema 기반으로 생성.
- [해소 v1.5] run 외 엔티티 미존재 → `RESOURCE_NOT_FOUND`(404) 신설. 일반 RBAC 거부 → `AUTHZ_FORBIDDEN`(403) 신설(auth-rbac.md). 자원특정 거부(시크릿/artifact→`SECRET_ACCESS_DENIED`, 커넥터→`CONNECTOR_PERMISSION_DENIED`, 사이트 런타임 차단→`SITE_PROFILE_BLOCKED`)는 유지.
- RBAC 역할·권한 매트릭스: `auth-rbac.md`. gateway policy 버전 컬럼: `db/migration_core_entities.sql` `gateway_policies.version`. 전체 OpenAPI 본문(스키마/파라미터/details)은 D1 codegen 위임.

> Repo-controlled fail-closed v1: `suspending` abort success requires a runtime-owned bookmark-cancel port or durable abort intent; absent that owner, API rejects before idempotency reservation and allows retry after `suspended`.

> Repo-controlled fail-closed v1: H5/R15 `reassignAssignee` success requires an explicit routing/assignment owner; absent that owner, API rolls back and returns `CONTROL_PLANE_INTERNAL_ERROR` instead of reporting `escalated`.
