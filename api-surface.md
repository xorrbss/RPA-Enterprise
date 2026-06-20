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
- **부작용이 있는 제어평면 명령**(run create/abort, scenario promote/rollback/archive, human-task assign/start/resolve/escalate, workitem replay, sites approve, gateway policy create/update/delete)에 `Idempotency-Key` 헤더 규약 적용.
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
| POST | `/v1/runs` | `Idempotency-Key` 헤더. body: `scenario_version_id`, `params`(params_schema 준수), optional `params.as_of`, optional `workitem_id`, optional `model`(§0.7). operator+ 권한 필요 | 201 + run 리소스(`run_id`, `status=queued`). `run.created` 이벤트 emit. `runs.model` 1회 해소·동결 | `IR_SCHEMA_INVALID`(422; 미해소 `model_required` 포함), `IR_EXPRESSION_COMPILE_ERROR`(422), `RESOURCE_NOT_FOUND`(404; 명시 `model` 정책 부재), `AUTHZ_FORBIDDEN`(403), `SITE_PROFILE_BLOCKED`(403) |
| GET | `/v1/runs/{run_id}` | — | 200 + run 상세(`run_id`, `status` ∈ RunState, `worker_id`, `attempts`, `as_of`, `current_node`, `failure_reason`, `updated_at`). 실제 진행 노드를 모르면 `current_node=null`, 실패 사유가 없으면 `failure_reason=null` | `RUN_NOT_FOUND`(404) |
| GET | `/v1/runs/{run_id}/steps` | 쿼리: `?limit=&cursor=`. `run.read` 권한 | 200 + `{ items, next_cursor }` (run_steps 단계 트레이스, 실행 시간 오름차순)⁶ | `RESOURCE_NOT_FOUND`(404; 형식 무효 run_id) |
| GET | `/v1/runs` | 쿼리: `?status=<RunState>&scenario_version_id=&limit=&cursor=` | 200 + `{ items, next_cursor }`, 각 item은 run 상세 요지(`current_node`, `failure_reason` 포함; 모름/없음은 null) | — |
| POST | `/v1/runs/{run_id}/abort` | `Idempotency-Key` 헤더. body: optional `reason` | 202 (abort 수락 → `aborting` 경유 `cancelled`). `run.cancelled` 이벤트 | `RUN_NOT_FOUND`(404), `RUN_ALREADY_TERMINAL`(409), `RUN_ABORTED`(409), `WORKITEM_CHECKOUT_CONFLICT`(409, `suspending` bookmark in-flight) |

**어휘 정합(필수)**: API 명령은 `abort` → Run 상태는 `aborting`→`cancelled`(state-machine R6/R10/R16/R23/R24/R26/R27/R28) → 이벤트는 `run.cancelled`(event-envelope) → UI 문구는 "취소됨". 엔드포인트명은 `abort`를 유지한다.

⁶ `GET /v1/runs/{run_id}/steps` — `run_steps` 단계 트레이스 read(운영 관찰). **비민감 요약 + 참조만** 노출(redaction-by-omission): `step_id`·`node_id`·`action`(IRActionType)·`status`(StepResult status 9값)·`attempt`·`cache_mode`·`started_at`/`ended_at`/`duration_ms`·`artifact_ids`(ArtifactRef[])·`stagehand_calls`(model/transport/stream_status/ttfb_ms/input·output_tokens/cost)·`exception`(`{class, code}`만). **민감 본문은 미노출**: `output`/`output_ref`/`input_redacted_ref` 내용·`exception.message`(RedactedString)·`evidenceRefs`·`page_state_before/after` 본문 — 평문/증빙 노출 금지(security-contracts §4/§9). 증빙(artifact)은 `artifact_ids`를 통해 **`GET /v1/artifacts/{id}` redaction→RBAC→audit 게이트**(§5)로만 조회한다. 따라서 step 본문 disclosure용 별도 RBAC/redaction 게이트는 불요하며 트레이스 요약은 `run.read`(viewer+, auth-rbac §2 "트레이스 조회")로 충분하다. 실시간성은 v1=폴링(architecture §6 outbox tail); SSE/WS 스트림은 미결정(후속). step별 판단-결과 데이터(승인/반려 등)를 이벤트 payload로 운반하는 것은 금지(event-envelope: per-event payload body는 closed-empty) — 관찰 데이터는 본 `run_steps` read가 권위다.
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
| GET | `/v1/scenarios/{scenario_id}/versions` | - | 200 + `{ items, next_cursor }` 최신 version 우선 | `RESOURCE_NOT_FOUND`(404) |
| GET | `/v1/scenarios/{scenario_id}/versions/{version}` | - | 200 + 지정 version의 IR + `ETag: <version>` | `RESOURCE_NOT_FOUND`(404) |
| POST | `/v1/scenarios/{scenario_id}/versions/{version}/rollback` | `If-Match: <latest_version>` + `Idempotency-Key`. body `{}` optional | 200 + 과거 IR을 최신+1 draft로 복제. 같은 키 재시도는 중복 version 없이 최초 응답 재생 | `SCENARIO_VERSION_CONFLICT`(412), `IR_SCHEMA_INVALID`(422), `IR_EXPRESSION_COMPILE_ERROR`(422), `RESOURCE_NOT_FOUND`(404) |
| POST | `/v1/scenarios/{scenario_id}/archive` | `If-Match: <latest_version>` + `Idempotency-Key`. body `{}` optional | 200 + scenario 보관, prod promotion 해제. 같은 키 재시도는 최초 응답 재생 | `SCENARIO_VERSION_CONFLICT`(412), `RESOURCE_NOT_FOUND`(404) |

¹ run 외 엔티티(scenario/human-task/workitem/site) 미존재 → `RESOURCE_NOT_FOUND`(404, v1.5 신설). run은 `RUN_NOT_FOUND` 유지.

**검증/승격 규약**(ir-expression §5 / ir-static-validation.md):
- save(POST/PUT)·promote 시 전 expression 파싱+타입체크(IREL) + IR 그래프 정적검증(V1..V11) 수행. 하나라도 실패 시 저장/승격 **거부**(런타임 파싱 없음, AST 캐시).
- 컴파일 에러(IREL_PARSE_ERROR 등)는 `IR_EXPRESSION_COMPILE_ERROR`(422), 그래프 검증 실패는 `IR_SCHEMA_INVALID`(422, `details`에 reason — 예: `shell_cmd_unregistered`)로 매핑.
- `validate`는 부작용 없는 dry-run(저장하지 않음) → ValidationReport 반환. `promote`만 prod 승격 + 캐시 빌드.

---

## 2.5 Scenario Generations (자연어 → IR 저장 · 선택 실행)

| Method | Path | 요청 요지 | 응답 요지 | 주요 ErrorCode |
|---|---|---|---|---|
| GET | `/v1/scenario-generations/capabilities` | `scenario.read` 권한. planner/runtime visual evidence capability 조회 | 200 + `{ planner: { default_planner, available }, visual_evidence: { screenshot: { enabled, policies, default_policy }, video: { enabled, policies, default_policy, artifact_type, media_type } } }`. `planner.available`은 항상 `deterministic_mvp`를 포함하고, `llm_v1`은 서버 구현체가 주입된 경우에만 포함한다. `video.enabled=false`이면 `video.policies=["never"]`, `default_policy="never"`; true이면 `policies=["never","failure","always"]`, `default_policy="always"`. `video.enabled=true`는 recorder capability와 API artifact body/blob reader가 모두 준비된 상태를 뜻한다 | `AUTHZ_FORBIDDEN`(403) |
| GET | `/v1/scenario-generations` | query: optional `status`(`drafted`/`saved`/`run_queued`/`blocked`/`failed`), optional `run_id`(연결 run 역조회), optional `limit`(1..100, default 20), optional `cursor` | 200 + `{ items, next_cursor }`. 각 item은 generation 원장(`mode`, `prompt_hash`, optional `prompt_redacted_ref`, `planner`, optional `model`, `status`, `params_context`, `evidence_policy`, `created_by`, `created_at`, 연결 scenario/run, redacted `draft_ir`, `validation_report`, `blockers`)이며 prompt 원문은 노출하지 않는다. `run_id` 필터는 `scenario_generations(tenant_id, run_id)` 인덱스를 쓰는 RunTrace 딥링크 복원용 역조회이며 매칭 원장이 없으면 빈 목록을 반환한다 | `IR_SCHEMA_INVALID`(422; invalid limit/cursor/status/run_id) |
| POST | `/v1/scenario-generations` | `Idempotency-Key`. body: `prompt`(자연어), optional `name`, `mode`(`draft_only`/`save`/`save_and_run`, 기본 `save_and_run`), optional `planner`(`deterministic_mvp`/`llm_v1`, 기본 `deterministic_mvp`; `llm_v1`은 서버 구현체 주입 시에만), optional `start_url`, optional `target`(`site_profile_id`/`browser_identity_id`/`network_policy_id`), optional `params`, optional `model`, optional `evidence`(`screenshot`, `video`; 생략 시 `screenshot=each_step`, video capability가 켜져 있으면 `video=always`, 아니면 `video=never`). `scenario.create` 권한 필요, `save_and_run`은 추가로 `run.create` 권한 필요 | 200(`draft_only`) 또는 201. `{ generation_id, mode, status, prompt_hash, scenario_id?, scenario_version_id?, run_id?, prompt_redacted_ref?, planner, model?, params_context, evidence_policy, created_by, created_at, draft_ir, validation_report, blockers }`. 조건 충족 시 scenario 저장 후 run queued까지 원자 처리 | `IR_SCHEMA_INVALID`(422), `IR_EXPRESSION_COMPILE_ERROR`(422), `AUTHZ_FORBIDDEN`(403), `RESOURCE_NOT_FOUND`(404; 명시 model 정책/요청 planner 구현체 부재), `SCENARIO_VERSION_CONFLICT`(412; idempotency hash mismatch) |
| POST | `/v1/scenario-generations/{generation_id}/run` | `Idempotency-Key`. `run.create` 권한 필요. blocked/saved generation 원장에 보정값을 붙여 실행을 재시도한다. body: optional `target`(`site_profile_id`/`browser_identity_id`/`network_policy_id`), optional `start_url`(string uri), optional `params`(object), optional `model`(string\|null), optional `evidence`(`screenshot`, `video`). `target`이 없고 `start_url`만 보정된 경우 서버는 최초 생성과 동일하게 site/browser/network 단일 매칭을 추론하며, 0건/다건이면 추측하지 않고 blocker를 유지한다 | 201 + generation 원장(`status=run_queued`, `run_id` 포함). 아직 실행 blockers가 남으면 200 + generation 원장(`status=blocked`, `run_id=null`). 새 generation을 만들지 않고 같은 generation 원장에 run을 연결한다 | `IR_SCHEMA_INVALID`(422), `SCENARIO_VERSION_CONFLICT`(412; idempotency hash mismatch 또는 already_run), `WORKITEM_CHECKOUT_CONFLICT`(409; idempotency in-flight), `RESOURCE_NOT_FOUND`(404), `AUTHZ_FORBIDDEN`(403) |
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
- `target`이 없고 `start_url` 또는 프롬프트 내 첫 http(s) URL이 있으면 서버가 `site_profiles.url_pattern` origin과 매칭해 최신 `browser_identity`와 기본 `network_policy`를 자동 제안한다. 매칭 실패/애매함/후보 부재는 추측하지 않고 `target_required_for_auto_run` blocker로 남긴다.

---

## 3. Human Tasks (휴먼 태스크 인박스)

| Method | Path | 요청 요지 | 응답 요지 | 주요 ErrorCode |
|---|---|---|---|---|
| GET | `/v1/human-tasks` | 쿼리: `?status=<HumanTaskState>&kind=<HumanTaskKind>&assignee=&run_id=&limit=&cursor=` | 200 + `{ items, next_cursor }` (인박스 목록; `run_id`는 suspended run→정확한 task 딥링크용) | — |
| GET | `/v1/human-tasks/{human_task_id}` | — | 200 + 태스크 상세(`state`, `kind`, `assignee`, `timeout`, `on_timeout`, run 연계; payload 본문 미노출) | `RESOURCE_NOT_FOUND`(404) |
| POST | `/v1/human-tasks/{human_task_id}/start` | `Idempotency-Key`. 배정된 담당자/역할 스코프 필요 | 200 + `in_progress`(H2) | `HUMAN_TASK_EXPIRED`(410), `AUTHZ_FORBIDDEN`(403) |
| POST | `/v1/human-tasks/{human_task_id}/resolve` | `Idempotency-Key`. body: optional `result`(object) — v1 미소비(아래 note) | 200 + `resolved`. `human_task.resolved` 이벤트 → Run `resume_requested`(R13/H3) | `AUTHZ_FORBIDDEN`(403), `HUMAN_TASK_EXPIRED`(410) |
| POST | `/v1/human-tasks/{human_task_id}/assign` | `Idempotency-Key`. body: `assignee` | 200 + `assigned`(H1/H6) | `AUTHZ_FORBIDDEN`(403), `HUMAN_TASK_EXPIRED`(410) |
| POST | `/v1/human-tasks/{human_task_id}/escalate` | `Idempotency-Key`. body: optional `reason` | 200 + `escalated`(H5)는 명시 routing/assignment owner가 `reassignAssignee`를 처리할 때만 가능. 현재 Fastify 경로는 미정의 routing이면 fail-closed. | `AUTHZ_FORBIDDEN`(403), `HUMAN_TASK_EXPIRED`(410), `CONTROL_PLANE_INTERNAL_ERROR`(500, unsupported `reassignAssignee`) |

- 상태값은 `HumanTaskState`(`open`/`assigned`/`in_progress`/`resolved`/`expired`/`cancelled`/`escalated`)·`HumanTaskKind`(`approval`/`validation`/`exception`/`captcha`/`mfa`)와 정확히 일치(state-machine-types.ts).
- HumanTask 응답은 v1에서 kind별 `payload` 본문을 노출하지 않는다. 현재 영속 모델은 inline payload가 아니라 payload_ref 계열 확장 여지만 두므로, API가 본문을 조합하거나 추측해 반환하지 않는다.
- 만료/종결 태스크에 resolve/assign/escalate 시도 → `HUMAN_TASK_EXPIRED`(410, business). timeout 정책 분기(fail→expired H4a / escalate→escalated H4b)는 태스크 생성 시 `on_timeout`(reserved-handlers @human_task 입력, 기본 `fail`)로 일원화되며 API가 재판정하지 않는다.
- **resolve `result` payload는 v1에서 미정의·미소비다(이전 "kind별 payload" 문구를 실제 v1 모델로 정정).** `reserved-handlers.md` @human_task는 resolve를 `{status:"resolved", next}` **순수 continue 신호**로 모델링한다 — 운영자 판정(승인/반려·통과/실패)을 담을 자리가 reserved-handler 결과·resume token·IREL `node.<id>.*`(타입 고정) 어디에도 없다. 백엔드 `requireResolveBody`는 optional `result`(object)를 **수용하되 전이/이벤트만 확정하고 result는 검증·영속·소비하지 않는다**(forward seam). 따라서 콘솔의 resolve는 판정-데이터 입력이 아니라 "승인하고 계속(continue)" 신호다. kind별 result 스키마 정의 + run 재개 컨텍스트(IREL `node.<handler>.result` 신규 스코프)로의 분기는 **versioned 스키마 변경이 필요한 v2 scope-out**이다(reserved-handlers 결과 모델·resume token·state-machine·DB·런타임 일괄 — verify.schema/reserved-handlers 기반 result 저장 결정 선행).
- 재에스컬레이션 후에도 미해소 → H8(escalated→timeout→expired, 무한 대기 방지). escalate API는 H5(수동) 진입만 담당하고 timeout 기반 H4b/H8은 타이머 주도(API 비주도).
- assignment/routing 계약: `assignee`는 명시 담당자 uuid, `assignee_role`은 @human_task 입력에서 온 역할 스코프이며 API가 임의로 "admin queue"로 재해석하지 않는다. `reassignAssignee` side effect는 반드시 호출측이 명시적으로 소비해야 한다. 현재 성공 가능한 소비자는 H6 `assign`뿐이며, 요청 body의 `assignee`로 `human_tasks.assignee`를 설정한다. H5 수동 escalate와 R15 coupling에서 발생하는 `reassignAssignee`는 durable routing port/assignee policy가 없으면 미지원 pending side effect로 보고 동일 트랜잭션을 rollback한 뒤 `CONTROL_PLANE_INTERNAL_ERROR`로 fail-closed해야 한다(`human_task.escalated` 이벤트 emit 금지, run 상태 유지).
- `cancel`(H7)은 별도 엔드포인트를 두지 않는다 — Run abort(§1) 연동으로만 발생(R16). 직접 API 노출은 Phase 2 결정.

---

## 4. Workitems / DLQ (작업항목 · 데드레터)

| Method | Path | 요청 요지 | 응답 요지 | 주요 ErrorCode |
|---|---|---|---|---|
| GET | `/v1/workitems` | 쿼리: `?status=<WorkitemState>&limit=&cursor=`. `target_id` 필터는 v1 미지원(제공 시 422) | 200 + `{ items, next_cursor }` | `IR_SCHEMA_INVALID`(422, `target_id_filter_unsupported`) |
| GET | `/v1/workitems/{workitem_id}` | — | 200 + 상세(`status` ∈ WorkitemState, `attempts`, `unique_reference`, `checked_out_by/at`, 연계 run) | `RESOURCE_NOT_FOUND`(404) |
| GET | `/v1/dlq` | 쿼리: `?kind=workitem|sink&limit=&cursor=` | 200 + `{ items, next_cursor }`. 항목은 `DEAD_LETTER` 상태 통지(ApiError 아님). `DeadLetter`는 `reason_code`(error-catalog `ErrorCode` — **workitem 한정**, `dead_letter.reason_code`)·`created_at`을 포함한다 | — |
| POST | `/v1/dlq/{dead_letter_id}/replay` | 쿼리: `?kind=workitem\|sink`(기본 workitem). `Idempotency-Key`. 운영자 재처리 권한 필요 | `kind=workitem`: 202 + workitem `new`로 복원(W10: attempts 리셋, DLQ에서 복원), `workitem.dead_lettered` 역방향 복원. `kind=sink`: 202 + 새 `sink_deliver` attempt **인큐**(상태전이 아님; 실 재전달은 worker egress 의존) | `WORKITEM_CHECKOUT_CONFLICT`(409), `AUTHZ_FORBIDDEN`(403)², `IR_SCHEMA_INVALID`(422, kind 무효) |

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
| POST | `/v1/sites/{site_profile_id}/approve` | `Idempotency-Key`. 승인 권한 필요. body: optional `reason`/`expires_at` | 200 + 승인 반영(risk=red 사이트 실행 허용) | `AUTHZ_FORBIDDEN`(403)⁴ |

- `site risk=red`는 미승인 시 실행 차단(`SITE_PROFILE_BLOCKED`, 403, error-catalog operatorAction="site risk=red 승인 워크플로우"). 본 엔드포인트가 그 승인 워크플로우의 제어평면 진입점.

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

## 8. 엔드포인트 ↔ 상태/이벤트 정합 요약

| 명령 엔드포인트 | 상태 전이(state-machine) | emit 이벤트(event-envelope) | UI 문구 |
|---|---|---|---|
| `POST /runs` | (dispatch) → `queued` | `run.created` | "대기" |
| `POST /runs/{id}/abort` | `*` → `aborting` → `cancelled` (R6/R10/R16/R23/R24/R26/R27/R28), `completing`은 거부(R25) | `run.cancelled` | "취소됨" |
| `POST /human-tasks/{id}/resolve` | HumanTask `in_progress`→`resolved`(H3), Run `suspended`→`resume_requested`(R13) | `human_task.resolved` | "처리완료" |
| `POST /human-tasks/{id}/escalate` | H5/R15 `reassignAssignee` 처리 owner가 있을 때만 HumanTask `*`→`escalated`, Run R15(suspended 유지). 미지원이면 fail-closed rollback | `human_task.escalated`(성공 시) | "관리자 이관" |
| `POST /dlq/{id}/replay` | Workitem `abandoned`→`new`(W10) | (workitem 재인입) | "재처리" |
| `POST /scenarios/{id}/promote` | (version 승격 + AST 캐시 빌드) | — | "승격됨" |
| `POST /scenarios/{id}/versions/{version}/rollback` | (과거 version을 최신+1 draft로 복제) | — | "롤백됨" |
| `POST /scenarios/{id}/archive` | (active scenario 보관 + promotion 해제) | — | "보관됨" |

---

## 9. D1 위임 (본 문서가 고정하지 않는 것)
- 전체 OpenAPI 본문: 요청/응답 **스키마 본문**(필드 타입·required·examples), 파라미터 상세, `details` 페이로드 구조 — D1 codegen이 본 envelope/error-catalog/schema 기반으로 생성.
- [해소 v1.5] run 외 엔티티 미존재 → `RESOURCE_NOT_FOUND`(404) 신설. 일반 RBAC 거부 → `AUTHZ_FORBIDDEN`(403) 신설(auth-rbac.md). 자원특정 거부(시크릿/artifact→`SECRET_ACCESS_DENIED`, 커넥터→`CONNECTOR_PERMISSION_DENIED`, 사이트 런타임 차단→`SITE_PROFILE_BLOCKED`)는 유지.
- RBAC 역할·권한 매트릭스: `auth-rbac.md`. gateway policy 버전 컬럼: `db/migration_core_entities.sql` `gateway_policies.version`. 전체 OpenAPI 본문(스키마/파라미터/details)은 D1 codegen 위임.

> Repo-controlled fail-closed v1: `suspending` abort success requires a runtime-owned bookmark-cancel port or durable abort intent; absent that owner, API rejects before idempotency reservation and allows retry after `suspended`.

> Repo-controlled fail-closed v1: H5/R15 `reassignAssignee` success requires an explicit routing/assignment owner; absent that owner, API rolls back and returns `CONTROL_PLANE_INTERNAL_ERROR` instead of reporting `escalated`.
