# D4 빌드 프롬프트 — Control-plane API (RPA-Enterprise)

> 새 세션의 코딩 에이전트에 **이 문서를 그대로 붙여넣어** D4(제어평면 REST API)를 끝까지 빌드하게 하는 프롬프트다.
> 계약/codegen·D2 런타임은 이미 완비·검증됐다. 이 프롬프트는 그 위에 **Fastify 제어평면 API**를 올린다.
> 상위 마스터 프롬프트는 `build-prompt.md`(D2–D7 전체), 청사진은 `architecture.md`. 충돌 시 **계약이 이긴다.**

---

## 역할 & 목표
너는 RPA-Enterprise 플랫폼의 리드 엔지니어다. **계약 SSoT**와 **이미 검증된 codegen·D2 런타임** 위에 **프로덕션 오픈 수준의 제어평면 API(D4)**를 구현한다. 추측·편법·더미 금지. 막히면 멈추고 blocked-decision marker(violated/reason/required_change + Required decision)로 보고.

## 0. 먼저 읽어라 (이 순서로)
1. `CLAUDE.md` / `AGENTS.md` — 저장소 성격·불변 원칙·어휘 정합·파일 지도.
2. `build-prompt.md` §1(불변 원칙)·§4(품질 바)·§5(작업 방식), `architecture.md` §0(스택)·§3(컴포넌트↔계약 매핑)·§7(결정점)·**§10(IREL 컴파일 파이프라인)**.
3. **D4가 소비하는 계약(권위)**: `api-surface.md`(엔드포인트 인벤토리)·`auth-rbac.md`(RBAC 매트릭스 §2, tenant_id JWT 클레임, RLS §3·§4)·`security-contracts.md`·`schema/ir.schema.json`·`schema/verify.schema.json`·`error-catalog.ts`·`release-decisions.md`(#7 에러매핑·#8 human_task.escalate·#10 LLM 멱등).
4. **재사용할 codegen(손으로 다시 만들지 말 것)**: `codegen/openapi.yaml`·`codegen/validators.ts`(ajv 경계검증)·`codegen/error-middleware.ts`(ErrorCode→HTTP)·`codegen/types.ts`·`codegen/irel-compile.ts`(`compileIrelExpression`)·`codegen/static-validation.ts`(V1–V11)·`codegen/event-payload-registry.ts`.
5. **이미 빌드된 D2 런타임(재사용·확장)**: 아래 §2.

## 1. 현재 상태 (브랜치 `feat/d2-runtime`, D2 완료·검증)
프로덕션 런타임은 신규 **`app/`** 패키지(자체 `package.json`/`tsconfig.json`, dep: `pg`·`graphile-worker`·`@opentelemetry/*`). 계약 root·`codegen/`는 **불변(재사용만)**. 이미 빌드·검증된 것:
- `app/src/db/pool.ts` — `createPool()`, `withTenantTx(pool, tenantId, fn)`: BEGIN → `set_config('app.tenant_id', …, local)` → fn → COMMIT/ROLLBACK. **RLS 세션 바인딩은 이걸 재사용한다.**
- `app/src/runtime/{run,workitem,human-task}-transition.ts` — 3개 엔티티 CAS 전이 + 동일-tx outbox(`outbox.ts`). `flow-control.ts` — `on[]` 분기 평가.
- `app/src/worker/{runtime-worker,graphile-runner}.ts` — `RuntimeWorker.handle` + Graphile Worker 큐.
- `app/src/observability/{telemetry,bootstrap}.ts` — 고정 span/metric 이름(§E) + `withSpan`.
- 검증: `npm --prefix app run typecheck`(tsc strict) · `run test:unit` · `run test:int`(아래 §4 게이트).

> D2 패턴을 그대로 따른다: 한 증분 = 한 커밋(무엇/왜/영향범위/검증결과), KISS/YAGNI, "조용한 false/unknown 금지"(미정의→throw, 미매칭→System), 가정 금지, 계약을 코드로 변환(신설 금지).

## 2. 환경 (D2에서 실측·확정)
- Windows 11 · PowerShell(주) + Bash 사용 가능 · **Node 24** · **PostgreSQL 15.18 로컬 설치**(`C:\Program Files\PostgreSQL\15\bin`). **Docker 없음 → testcontainers 불가.**
- **DB 통합검증은 repo의 일회용 PG15 게이트로 한다**:
  `node scripts/db-temp-postgres-gate.mjs -- <command>`
  게이트가 일회용 클러스터 + **비-BYPASSRLS `rpa_smoke`** 역할 + `rpa_contract_gate` DB를 만들고 `PGHOST/PGPORT/PGUSER/PGDATABASE`를 주입한 뒤 `--` 뒤 명령을 실행, 끝나면 정리한다.
- **PG15 주의**: `rpa_smoke`는 DB 소유자지만 `public` 스키마 CREATE 권한이 없다. 통합테스트는 **전용 소유 스키마 생성 후 search_path 바인딩**(`createPool({ options: '-c search_path=<schema>,public' })` + `CREATE SCHEMA` + 두 마이그레이션 적용). `db/migration_smoke.sql`·`app/test/run-transition.int.ts`가 검증된 패턴이다.
- 마이그레이션 적용 순서: `db/migration_concurrency_idempotency.sql` → `db/migration_core_entities.sql`. 둘 다 순수 SQL(psql 메타명령·확장 없음) → `pg`의 `client.query(fileText)`로 직접 적용 가능.
- `app/` 의존은 `.gitignore`됨(`app/node_modules/`). 새 dep 추가 시 `npm install --prefix app` 후 `package-lock.json` 커밋.

## 3. D4 범위 & 완료 정의(DoD)
**목표**: `api-surface.md` + `codegen/openapi.yaml`의 제어평면 엔드포인트(runs/scenarios/human-tasks/workitems·DLQ/artifacts/gateway/sites)를 **Fastify 얇은 핸들러**로 구현.

구현 요소(계약 지정):
1. **Fastify 라우트** — `codegen/openapi.yaml`/`api-surface.md`를 진실원천으로. 핸들러는 얇게(오케스트레이션은 D2 런타임·서비스 계층에 위임).
2. **경계검증** — `codegen/validators.ts`(ajv) 재사용. 본문/파라미터 검증 실패 → `IR_SCHEMA_INVALID` 등 계약 코드.
3. **인증** — JWT(`auth-rbac.md`): `tenant_id`/`roles`는 **JWT 클레임에서만**(본문 불신).
4. **인가(RBAC)** — `auth-rbac.md §2` 권한 매트릭스 미들웨어. 일반 거부 → `AUTHZ_FORBIDDEN`. `human_task.escalate`는 reviewer/approver/admin(release-decisions #8).
5. **RLS 세션 바인딩** — 모든 핸들러 DB 작업은 `app/src/db/pool.ts`의 `withTenantTx(pool, jwt.tenant_id, …)` 경유(strict `current_setting`, FORCE RLS). cross-tenant 차단.
6. **에러 매핑** — `codegen/error-middleware.ts`로 `error-catalog.ts` 44코드 → HTTP. `ApiError` 일관, retryable/httpStatus 준수.
7. **동시성/멱등 헤더** — `If-Match`(scenario.version, 불일치 → `SCENARIO_VERSION_CONFLICT`/412) · `Idempotency-Key`(`control_plane_idempotency_keys` 테이블, **release-decisions #7** 매핑: unmatched route→`RESOURCE_NOT_FOUND`/404, missing key→`IR_SCHEMA_INVALID`/422, request_hash mismatch→`SCENARIO_VERSION_CONFLICT`/412, in-flight 중복→`WORKITEM_CHECKOUT_CONFLICT`/409 retryable) · `params.as_of` 주입(ir-expression §5 결정론).
8. **컴파일 파이프라인(§10)** — 시나리오 **저장/승격** 시: ① ajv(`codegen/validators`) → ② IREL parse+typecheck(`compileIrelExpression`, 전 expression) → ③ IR 그래프 정적검증 **V1–V11**(`codegen/static-validation.ts`, `ValidationReport`). 하나라도 실패 → 저장 거부(`IR_SCHEMA_INVALID`/`IR_EXPRESSION_COMPILE_ERROR`). **prod 승격은 warnings도 차단**(ir-static-validation §3). 통과분 AST를 `scenario_versions.compiled_ast`에 캐시(런타임 파싱 없음).
9. **어휘 체인** — API `abort` → Run `aborting`→`cancelled` → event `run.cancelled` → UI "취소됨". run 명령은 D2 전이 런타임(`applyRunTransition`)으로 위임.
10. **OTel** — `app/src/observability`의 `withSpan`/고정 이름 사용(요청 경계 span). correlation_id 전파.

**스택**: Fastify(architecture §0 권고) + ajv(codegen) + 기존 `pg` 풀. 새 dep는 `fastify`(+필요 시 jwt 검증 라이브러리). 단일 ESM `app/` 패키지에 `src/api/` 추가.

**DoD/게이트(build-prompt D4)**:
- OpenAPI lint(spectral; 미설치면 `codegen/openapi.yaml` YAML parse + 일관성 검사로 대체하고 그 사실 기록).
- **엔드포인트 통합테스트**(temp PG15 게이트): 인증(401)·인가(403 AUTHZ_FORBIDDEN)·멱등(Idempotency-Key 재요청 동일 응답/충돌 409)·If-Match(412)·404(RESOURCE_NOT_FOUND)·컴파일 파이프라인 거부(저장/승격 시 422) 경로 그린.
- **RLS 격리 테스트**: tenant A 토큰으로 tenant B 리소스 조회 시 0건/404(cross-tenant 차단) 그린.
- `tsc --strict` + 기존 D2 `test:unit`/`test:int` 회귀 유지.

> 실행기(executor)는 **D3에서 BLOCKED**(Stagehand v3 라이브 PoC). 따라서 **실 run 실행 e2e는 D4 범위가 아니다**. D4는 API 계층(인증/인가/멱등/검증/상태명령/컴파일)을 executor 없이 검증한다. run 생성은 `runs` 행 생성 + 큐 enqueue(Graphile)까지, 실제 step 실행은 D3 의존으로 명시.

## 4. 검증 방법 (D2에서 검증된 절차)
```
npm install --prefix app                                   # 새 dep 설치
npm --prefix app run typecheck                             # tsc strict
npm --prefix app run test:unit                             # 순수 단위(외부 의존 없음)
node scripts/db-temp-postgres-gate.mjs -- npm --prefix app run test:int   # 실 PG15 통합
```
- 통합테스트는 전용 스키마에 두 마이그레이션을 적용하고 `app/src/db/pool.ts`로 접속(§2 패턴). API 테스트는 Fastify 앱을 `app.inject()`(in-process)로 호출하면 네트워크 없이 빠르게 검증 가능.
- 새 통합 파일은 `app/package.json`의 `test:int` 체인에 추가(`&& tsx test/<name>.int.ts`).

## 5. 권장 증분(각각 검증·커밋)
1. **D4.1** Fastify 부트스트랩 + 인증(JWT 클레임 추출, 미인증 401) + RLS 바인딩 미들웨어(withTenantTx 연결) + error-middleware 통합. 게이트: `GET` 1개 엔드포인트 인증/RLS inject 테스트.
2. **D4.2** RBAC 미들웨어(auth-rbac §2 매트릭스) + AUTHZ_FORBIDDEN. 게이트: 역할별 허용/거부 테스트.
3. **D4.3** 멱등/동시성: `Idempotency-Key`(control_plane_idempotency_keys, #7 매핑) + `If-Match`(scenario.version 412) + `params.as_of`. 게이트: 재요청/충돌/412 테스트.
4. **D4.4** 시나리오 저장/승격 + **§10 컴파일 파이프라인**(ajv→IREL→V1–V11, compiled_ast 캐시, 승격 warnings 차단). 게이트: 유효 IR 저장/승격 OK + 무효 IR 거부(422) 테스트.
5. **D4.5** runs/human-tasks/workitems·DLQ 명령 라우트 → D2 전이 런타임 위임(abort→cancelled 어휘 체인, resolve, manual_replay). 게이트: 상태명령 통합테스트.
6. **D4.6** OpenAPI lint/일관성 + 전체 회귀(D2 포함) 그린 + PR 준비.

## 6. 불변 원칙(위반 시 중단)
계약이 진실원천(코드↔계약 충돌 시 코드 수정; 계약 결함이면 README 패치로그 규율로 근거 기록 후 수정) · "조용한 false/unknown 금지" · 어휘 체인 유지 · 결정론(`params.as_of`, no eval/now/random) · 멱등(control_plane_idempotency_keys, 동일 tx outbox) · 보안 경계(SecretRef/redaction, JWT 신뢰, RLS FORCE) · 가정 금지(불명확 → blocked-decision marker) · 원자적 변경 + 단계별 검증 보고.

### 시작 지시
"위 0번 순서로 계약·D2 코드를 읽고, D4.1부터 시작. 각 증분마다 검증(typecheck + 해당 통합테스트) 통과 후 커밋하고 다음으로. 막히면 BLOCKED 보고. 새 브랜치는 `feat/d2-runtime`에서 이어가거나 `feat/d4-control-plane`을 파서 진행."
