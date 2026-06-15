# 프로덕션 빌드 마스터 프롬프트 (RPA-Enterprise, D2–D7 일괄 개발)

> 이 문서는 **코딩 에이전트(예: Claude Code, ultracode/autonomous 모드)에게 그대로 붙여넣어** 본 계약 SSoT로부터 프로덕션 오픈 수준의 시스템을 끝까지 빌드하게 하는 마스터 프롬프트다. 한 번의 응답으로 끝나지 않으므로, **단계별 검증 게이트를 통과하며 연속 실행**하도록 설계됐다. (계약/codegen은 이미 완비·검증됨 — 이 프롬프트는 *런타임 구현*을 만든다.)

---

## 역할 & 목표

너는 **RPA-Enterprise 플랫폼의 리드 엔지니어**다. 이 저장소의 **계약 단일 진실원천(SSoT)**으로부터 **프로덕션 오픈 수준**(프로토타입 아님)의 동작 시스템을 구현한다. "프로덕션 오픈 수준" = 테스트·관측·보안·마이그레이션·CI가 갖춰져 실제 트래픽을 받을 수 있는 상태. architecture.md의 D2–D7을 **순서대로, 각 단계 검증 게이트를 통과**하며 빌드한다. 추측·편법·더미 금지. 막히면 멈추고 `TODO: [BLOCKED]`로 보고.

## 0. 먼저 읽어라 (진실원천 — 이 순서로)

1. `README.md` — 권위 changelog(v1.1~현행 패치로그)·"외부 의존 맵"·설계 결정. 모든 계약 변경의 "왜"가 여기 있다.
2. `CLAUDE.md` / `AGENTS.md` — 저장소 성격·불변 원칙·어휘 정합·파일 지도.
3. `architecture.md` — **구현 청사진**: 스택(§0)·실행기 3분할(§2)·컴포넌트↔계약↔codegen 매핑(§3)·데이터/이벤트(§4)·배포(§5)·빌드순서 D1–D7(§6)·결정점(§7)·D3 PoC(§9)·**IREL evaluator §10**.
4. 계약(권위 — **충돌 시 계약이 이긴다**): `ir-expression.md`·`ir-static-validation.md`·`state-machine.md`·`reserved-handlers.md`·`llm-gateway-adapter.md`·`impl-contracts-bundle.md`·`security-contracts.md`·`auth-rbac.md`·`api-surface.md`·`ops-defaults.md`·`schema/*.json`·`db/*.sql`·`ts/*.ts`.
5. **이미 검증된 codegen — 재사용/확장하고 손으로 다시 만들지 말 것**: `codegen/{types,validators,transitions,static-validation,irel-compile,error-middleware,event-payload-registry,transitions.fixtures,run-fixtures,validators.fixtures}.ts`·`codegen/{openapi,asyncapi}.yaml`. 검증: `npm --prefix codegen test`(tsc strict + 전이 84/84 + validators 42/42 + static validation 33/33 PASS — 수치는 `npm --prefix codegen run fixtures` 실측 출력 기준). 계약이 바뀌면 codegen을 **재생성**한다.

## 1. 불변 원칙 (위반 시 구현 중단)

- **계약이 진실원천.** 코드가 계약과 충돌하면 코드를 고친다. 계약 자체에 결함이 있으면 *README 패치로그 규율*(검증된 내부 모순만, 근거 기록)로 계약을 고친 뒤 진행.
- **"조용한 false/unknown 금지":** 미분류 예외→`system` 흡수, 미정의 (상태,이벤트)→`throw IllegalTransition`, `on[]` 무매칭→`IR_NO_BRANCH_MATCHED`(System), IREL scope missing→`IREL_RUNTIME_MISSING`(System). dead-end/false success를 절대 흘리지 않는다.
- **어휘 체인:** API `abort` → Run `aborting`→`cancelled` → event `run.cancelled` → UI "취소됨". 한 곳을 건드리면 체인 전체 확인.
- **결정론:** IREL은 `eval`/`now()`/random 금지(`params.as_of` 주입). 모든 상태 전이는 `UPDATE … WHERE id=? AND status=<cur>`(CAS), 0 rows면 재조회.
- **멱등:** `raw_items`(UNIQUE NULLS NOT DISTINCT)·`sink_deliveries`(외부 멱등키)·`run_steps`(UNIQUE run_id,step_id,attempt)·`events_outbox`(UNIQUE tenant_id,idempotency_key). 상태변경+이벤트 발행은 **동일 트랜잭션 outbox**.
- **보안 경계:** `SecretRef`/`PlainSecret` brand + `SecretStore.resolve()`만 평문, taint가 로그/이벤트/artifact 경로 진입 시 build/lint 차단. redaction은 adapter 진입 전(security-contracts §4). RLS(tenant) FORCE + strict `current_setting`. 인증 JWT(`tenant_id`/`roles` 클레임, body 불신). shell은 signed command registry. prompt-injection 차단.
- **가정 금지:** 불명확하면 구현하지 말고 `TODO: [BLOCKED]`(violated/reason/required_change). 외부 사실(Stagehand v3 결정형 page API 커버리지·Codex structured-output 스트리밍 실범위·모델 maxContextTokens)은 **PoC로 확정 후** 진행(architecture §9 체크리스트).

## 2. 스택 (architecture.md 확정 — 임의 변경 금지)

TypeScript/Node 단일 · PostgreSQL 15+ · **Graphile Worker**(상태변경+job 동일 트랜잭션) · **Fastify**(핸들러 얇게, ajv 경계검증, RBAC 미들웨어, RLS 세션 바인딩) · **Stagehand v3 (CDP-native)** — Playwright 미채택, 결정형 utility/PageState는 CDP page, 비브라우저(api_call/file/shell)는 순수 Node · **OpenTelemetry**(impl-bundle §E span/metric 이름 고정) · 시크릿 Vault/KMS · 프론트 **React+Vite+TanStack Query**. 배포: 모듈러 모놀리스 + 격리 브라우저 워커 풀.

## 3. 빌드 순서 & 단계별 완료 정의(DoD) + 검증 게이트

각 단계는 **DoD를 충족하고 검증을 실행해 통과한 뒤** 다음으로 넘어간다. 단계마다 커밋(무엇·왜·영향범위·검증결과).

- **D2 — Transition 런타임 + Worker 골격 + IREL evaluator·IR 정적검증.**
  - `codegen/transitions.ts`를 실 DB에 연결(CAS UPDATE, sideEffect 실행, outbox INSERT 동일 트랜잭션). Graphile Worker job = run/workitem/human_task 진행.
  - **IREL 런타임 연결(§10)**: 파서·타입체커·그래프 정적검증 V1–V11·순수 evaluator는 **D1 codegen(`codegen/irel-compile.ts`·`codegen/static-validation.ts`) 재사용** — 손으로 다시 만들지 말 것. D2는 이를 런타임에 연결: Interpreter가 캐시 AST(`scenario_versions.compiled_ast`)로 on[]/loop.until/fallback.advance_when을 평가(no eval). 저장/승격 시 compile 파이프라인(parse+typecheck+V1–V11) 호출은 D4.
  - OTel 부트스트랩(span 이름 고정 적용 시작).
  - **DoD/게이트**: transition 84/84 회귀 유지 + IREL 단위테스트(positive/negative, IR_NO_BRANCH_MATCHED/IREL_RUNTIME_MISSING 포함) + 최소 시나리오 상태기계 통합테스트(실 PG15 — temp/local DB 게이트 `scripts/db-temp-postgres-gate.mjs`) 그린.
- **D3 — Executor 골격(architecture §9).** UtilityExecutor(CDP)·PageStateResolver **먼저**(Stagehand `act` 없이 flags·structuralHash 산출) → Stagehand v3 dom(act/observe/extract) → VisionExecutor. **§9.2 PoC 10항목**을 실측, 갭은 raw CDP 보완.
  - **DoD/게이트**: PoC 체크리스트 통과/보완 문서화 + `observe→extract→next_page` dry-run(실 저장/전송 차단) 통과 + browser/credential lease·heartbeat·sweeper 동작.
- **D4 — Control-plane API.** `codegen/openapi.yaml`→Fastify 라우트, `validators`로 경계검증, RBAC 미들웨어(auth-rbac §2 매트릭스), RLS 세션 바인딩(§3·§4), `error-middleware`로 ErrorCode 47종 매핑, If-Match/Idempotency-Key/`params.as_of` 주입, 저장/승격 시 **§10 컴파일 파이프라인** 호출.
  - **DoD/게이트**: OpenAPI lint(spectral) + 엔드포인트 통합테스트(인증/인가/멱등/If-Match/404 경로) + RLS 격리 테스트(cross-tenant 차단) 그린.
- **D5 — LLM Gateway.** Codex SSE adapter(llm-gateway-adapter), capabilities 게이트, budget 강제(스트림 중 abort), redaction(§4) 경계, retry 분류→error-catalog(LLM_*), stagehand_calls 기록.
  - **DoD/게이트**: SSE/budget/abort/repair/fallback 통합테스트(모킹 백엔드) + redaction fixture(impl-contracts-bundle §C 케이스 + security-contracts §4 알고리즘) 그린.
- **D6 — Pipeline/Sink + outbox 소비.** raw→normalized→sink(멱등·DLQ), outbox 발행 워커(at-least-once + idempotency_key), sink 외부 멱등키, dead_letter replay(W10).
  - **DoD/게이트**: 멱등 재인입/재시도/replay 통합테스트 + outbox→bus 순서/중복 테스트 그린.
- **D7 — 운영 콘솔(프론트).** `rpa_enterprise_console.html` 디자인을 React+Vite로 구현, OpenAPI 클라이언트, 실시간 갱신(v1=outbox tail 폴링), 10뷰·운영자 워크플로우(abort/resolve/replay/promote/approve), 접근성(focus-visible·포커스트랩·aria) 유지.
  - **DoD/게이트**: e2e(시나리오 저장→승격→실행→사람확인→재개→완료→sink, 운영 콘솔 조작) + a11y 검사 그린.
- **이후**: P2 RLS 전면 활성화 → P3 Remote Agent(event bridge, D11).

## 4. 프로덕션 오픈 품질 바 (전 단계 공통)

- **테스트**: 단위(transition/IREL/validator/redaction) + 통합(API↔Postgres↔worker, 실 PostgreSQL — temp/local DB 게이트 `scripts/db-temp-postgres-gate.mjs`; Docker 미사용으로 testcontainers 불가) + e2e(전체 흐름). codegen fixtures(84 전이·42 validator·33 static validation) 회귀 유지.
- **CI(그린 게이트)**: eslint(+secret taint 룰) · `tsc --strict` · 전체 테스트 · 마이그레이션 적용/롤백 검사 · OpenAPI/AsyncAPI lint(spectral) · 컨테이너 빌드.
- **마이그레이션**: 적용 순서 `migration_concurrency_idempotency.sql` → `migration_core_entities.sql`, 멱등·롤백 가능, RLS 정책(auth-rbac §4) 포함.
- **관측**: impl-bundle §E의 span/metric **이름 그대로** OTel 계측, 필수 메트릭(run_success_rate·cache_hit_rate·llm_cost·queue_depth 등) 노출, correlation_id로 trace↔event↔log 연결.
- **보안**: secret taint lint가 빌드 차단, redaction 경계 강제, 인증/인가 전 엔드포인트, RLS 격리, shell signed registry, prompt-injection 차단, artifact redaction 게이트.
- **운영**: `ops-defaults.md` 기본값 적용(환경 오버라이드), sweeper(artifact/lease)·서킷브레이커(site/worker)·DLQ replay 동작.
- **에러**: `error-catalog.ts` 47코드 전부 `error-middleware`로 매핑, `ApiError` 일관, retryable/httpStatus 준수.

## 5. 작업 방식 (원칙)

- **계약→코드 변환을 우선**한다(codegen 재사용/확장). 한 번에 한 논리적 변경, 단계 완료 후 **검증 실행 결과를 보고**.
- 계약과 어긋나면 계약을 따른다. 계약 결함이면 README 패치로그(근거 기록) 후 codegen 재생성.
- 각 커밋: 무엇/왜/영향범위/검증결과. node_modules 등 산출물은 gitignore.
- 새 파일/추상화 전 기존 구조 확장 가능성 우선(KISS/YAGNI). 파일 500라인 초과 시 의미 단위 분리.

## 6. 최종 완료 정의 (프로덕트 오픈)

- `docker compose up`으로 **Postgres + API + Worker 풀 + 브라우저 워커 풀 + LLM Gateway + 운영 콘솔**이 기동.
- 시나리오를 **저장→정적검증(V1–V11)→prod 승격→실행→(차단 시)사람확인→재개→완료→sink 전달**까지 수행하고, 운영 콘솔에서 상태·트레이스·사람확인·DLQ·보안을 관측·조작.
- **CI 그린**(lint/tsc/test/migration/openapi-lint), 멱등·RLS·관측·보안 게이트 통과, ops-defaults 적용.
- 외부 사실 미확정 항목은 PoC로 닫혔거나 `TODO: [BLOCKED]`로 명시.

---

### 이 프롬프트 사용법
- 코딩 에이전트(autonomous/ultracode)에 본 문서를 컨텍스트로 주고 "D2부터 시작, 각 게이트 통과 후 다음 단계로, 막히면 BLOCKED 보고"로 지시한다.
- 규모가 크므로 **단계별로 끊어** 실행/검증/커밋하는 것이 안전하다(한 단계 = 한 PR 권장). "한 번에"는 *연속 실행*을 의미하며, 각 단계의 검증 게이트는 건너뛰지 않는다.
