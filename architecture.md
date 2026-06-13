# 구현 아키텍처 (Implementation Architecture v1)

> 계약 SSoT(이 저장소)를 실제 시스템으로 구현하기 위한 청사진. 모든 선택은 계약이 지정한 신호에 근거하며, 계약이 강제하지 않는 부분은 "권고(대안 있음)"로 표시한다.
> **위상**: 본 문서는 *구현 가이드*이지 계약(SSoT)이 아니다 — 계약(`.md`/`schema/`/`ts/`/`db/`)과 충돌하면 계약이 우선.

---

## 0. 한눈에 (스택 결정)

| 영역 | 선택 | 근거 |
|---|---|---|
| 언어 | **TypeScript / Node.js** 단일 | 계약·codegen·executor·SecretStore가 전부 TS; 계약↔코드 갭 0 |
| 브라우저 드라이버 | **Stagehand v3 (CDP-native)** — Playwright **제거** | Stagehand v3가 Playwright 하드의존 제거·CDP-native 전환(2026, web-verified §8) |
| 큐/오케스트레이션 | **Graphile Worker** | README §결정2: v1 큐=Graphile 전용, 상태변경+인큐 동일 트랜잭션 |
| 저장소 | **PostgreSQL 15+** | DDL·RLS·CAS UPDATE·outbox·`NULLS NOT DISTINCT` |
| 제어평면 API | **Fastify** (권고; 대안 NestJS) | api-surface 얇은 핸들러 + ajv 경계검증에 KISS |
| 검증 | **ajv (2020)** | impl-bundle §C 경계검증, codegen/validators.ts |
| 관측 | **OpenTelemetry** | impl-bundle §E span/metric 이름 고정 |
| 시크릿 | **Vault 또는 KMS** (권고) | security-contracts §1·§5(kid 회전), SecretStore.resolve 경계 |
| 프론트 | **React + Vite + TanStack Query** (권고; 대안 SvelteKit) | 운영 콘솔(현재 vanilla 목업) 실 구현 |

---

## 1. 언어: TypeScript / Node 단일

계약이 사실상 지정한다: `ts/` 계약 타입·`codegen/` 산출·`ExecutorPlugin`/`PageStateResolver`/`SecretStore`가 전부 TS이고, Stagehand v3·Graphile Worker·ajv·SSE가 Node 생태계다. v1은 단일 언어가 KISS·구조무결성에 최적이며 VLM은 LLM Gateway 경유라 별도 ML 런타임이 불필요하다(Python 불요).

---

## 2. 브라우저 실행기 — Stagehand v3 (CDP-native), **Playwright 제거**

**[결정]** Stagehand v3는 Playwright 하드 의존을 제거하고 **CDP-native 모듈러 드라이버**로 전환했다(2026 stable, web-verified §8). 따라서 v1 구현은 **Playwright를 기본 스택에서 채택하지 않는다.** Stagehand v3 단일 드라이버가 LLM 프리미티브와 결정형 브라우저 동작을 모두 담당한다.

`ExecutorPlugin.capabilities() {dom, vision, utility}`(core-types) 매핑:

| capability | 액션 | 구현 | LLM |
|---|---|---|---|
| **dom** | `act` / `observe` / `extract` | Stagehand v3 LLM 프리미티브 | ✅ Gateway |
| **utility (브라우저)** | `navigate` / `download` / `upload` + **PageState 산출**(structural_hash·landmarks·frames) + **ActionPlanCache 재생** | Stagehand v3 **결정형 CDP page**(LLM 미사용) | ❌ 결정형 |
| **utility (비브라우저)** | `api_call` / `file` / `shell` | **순수 Node**(fetch / fs / signed command registry) — 브라우저 무관 | ❌ |
| **vision** | VLM verify / vision | LLM Gateway(VLM) | ✅ Gateway |

핵심:
- `PageStateResolver`(core-types)는 **결정형 CDP 유틸리티 기반**이다. dom 실행기(Stagehand `act`) 없이도 D3 골격에서 동작 — capability 분리의 본질은 **"LLM vs 결정형"**이지 도구(Playwright vs Stagehand)가 아니다. 계약의 옛 "PlaywrightUtility" 명칭은 **"Utility(CDP)"**로 일반화(core-types 주석 갱신).
- Playwright는 필요 시 `chromium.connectOverCDP({ wsEndpoint })`로 **선택 연결**만 가능하며 v1 기본 스택이 아니다.
- CDP-native는 계약의 `CDP_DISCONNECTED`(error-catalog)·`browser_leases`(migration)·CDP 엔드포인트 개념과 오히려 더 잘 맞는다.

**주의(D3 PoC 확인 필요 — 외부 사실)**: Stagehand v3 결정형 page API가 우리 `utility` 액션(특히 download/upload·DOM structural_hash 산출)을 충분히 커버하는지는 라이브러리 API 표면이라 D3 PoC로 검증하고, 부족분만 **raw CDP**로 보완한다(가정 금지).

---

## 3. 컴포넌트 ↔ 계약/codegen 매핑

```
control-plane API ─(상태변경+job 인큐, 동일 트랜잭션/outbox)→ Orchestrator/Worker
   │                                                              │
   ↓ ajv·RBAC·RLS                                    Scenario Interpreter(IR walk + IREL)
                                                     transition*() CAS · @challenge/@human_task
Executors(Stagehand v3 CDP · Vision · Utility) · LLM Gateway · Pipeline(raw→norm→sink)
   └────── Postgres 15+ (RLS·CAS·outbox) · 격리 브라우저 워커 풀 ──────┘
```

| 컴포넌트 | 소비 계약 | codegen 재사용 | 기술 |
|---|---|---|---|
| Control-plane API | api-surface·error-catalog·auth-rbac | openapi.yaml·error-middleware.ts·validators.ts·types.ts | Fastify |
| Orchestrator/Worker | state-machine·ir-static-validation·reserved-handlers | **transitions.ts**·transitions.fixtures | Graphile Worker |
| IREL evaluator + IR 정적검증 | ir-expression · ir-static-validation(V1–V11) | ValidationReport(types.ts) + D2 산출(파서/타입체커/그래프검증) | 수기 재귀하강 파서(no eval) — §10 |
| Executors | core-types(ExecutorPlugin/PageState) | types.ts | **Stagehand v3 (CDP)** · Vision · Utility(CDP/Node) |
| LLM Gateway | llm-gateway-adapter | adapter 인터페이스 | OpenAI 호환 SSE |
| Pipeline/Sink | migration·impl-bundle | — | Postgres + sink 멱등키 |
| Event bus | event-envelope·events_outbox | asyncapi.yaml | Postgres outbox → (P3 wss bridge) |
| Secrets/Redaction | security-contracts·core-types brand | — | Vault/KMS + taint lint |
| Observability | impl-bundle §E | (span/metric 이름) | OpenTelemetry |
| Frontend | (운영 콘솔 목업) | — | React + Vite + TanStack Query |

---

## 4. 데이터 · 이벤트

- **단일 Postgres 스택**: 상태 전이는 `UPDATE ... WHERE id=? AND status=<cur>`(CAS, state-machine §4). 상태 변경과 이벤트 발행은 **동일 트랜잭션 outbox**(`events_outbox`)로 원자화(README §결정2). Graphile Worker가 같은 DB에서 job 소비.
- **outbox → event bus**: outbox 행을 발행 워커가 읽어 버스로 중계(at-least-once + `idempotency_key`). P3 Remote Agent는 outbound wss event bridge(D11)로만 분리.
- **멀티테넌시**: 모든 테이블 `tenant_id` + RLS(auth-rbac §4, `SET LOCAL app.tenant_id` + strict `current_setting` + FORCE RLS). P1은 미들웨어 필터, P2 RLS 심층방어.
- **멱등/DLQ**: `raw_items`(NULLS NOT DISTINCT)·`sink_deliveries`(외부 멱등키)·`dead_letter`(W10 replay)·`challenge_resolution_attempts`.

---

## 5. 배포 토폴로지

- **모듈러 모놀리스 + 격리 브라우저 워커 풀**(마이크로서비스 아님 — v1 단일 트랜잭션 단순성과 충돌). 프로세스: ① API 서비스(Fastify) ② Worker 풀(Graphile) ③ LLM Gateway 서비스 ④ **브라우저 워커 풀**(별 프로세스/컨테이너, browser/credential lease, CDP-native Stagehand v3) ⑤ 발행/sweeper 워커.
- 단일 Postgres(+오브젝트 스토리지: artifacts). 시크릿은 Vault/KMS.
- 확장: 워커 수평 확장, 브라우저 풀 격리 스케일. P3 Remote Agent만 event bridge로 원격 분리.

---

## 6. 권장 빌드 순서 (D-시리즈)

**D1**(거의 완료: `codegen/` 산출) → **D2** transition 런타임 + Worker 골격(transitions.ts 연결) **+ IREL evaluator·IR 정적검증 V1–V11 산출(§10)** → **D3** Executor 골격(**Stagehand v3 CDP 기반 Utility/PageStateResolver 먼저**, Stagehand act/observe/extract 후행) → **D4** Control-plane API(openapi→Fastify, RBAC/RLS, **저장/승격 시 §10 컴파일 파이프라인 호출**) → **D5** LLM Gateway(Codex SSE) → **D6** Pipeline/Sink + outbox 소비 → **D7** Frontend(콘솔). 이후 P2 RLS 활성화 → P3 Remote Agent(event bridge).

> 관측(OTel) 부트스트랩은 **D2부터** 적용(impl-bundle §E span/metric 이름 고정). 프론트 실시간 갱신은 v1에서 **outbox tail 폴링**(이벤트 브리지 P3 전까지 잠정) — D7 결정.

---

## 7. 결정점 (계약 지정 vs 권고)

- **계약이 지정**: TS/Node · PostgreSQL 15+ · Graphile Worker(§결정2) · SSE · outbox · RLS · ajv · `ExecutorPlugin {dom/vision/utility}` 분할.
- **내 권고(대안·비준 필요)**: 브라우저 드라이버 **Stagehand v3(CDP), Playwright 제거**(§2·§8) · API **Fastify**(vs NestJS) · 프론트 **React+Vite**(vs SvelteKit) · **모놀리식+격리 브라우저 풀**(vs 마이크로서비스) · 시크릿 **Vault/KMS**.
- **외부 사실(구현 시 라이브 확정)**: 모델 `maxContextTokens` · Codex structured-output 스트리밍 실범위(README §19) · Stagehand v3 결정형 page API 커버리지(§2 PoC).

---

## 8. 출처 (Stagehand v3 / Playwright 제거 근거)

웹 검증(2026-06):
- Launching Stagehand v3 — Browserbase: https://www.browserbase.com/blog/stagehand-v3
- Why we're graduating from Playwright — Browserbase: https://www.browserbase.com/blog/stagehand-playwright-evolution-browser-automation
- Playwright integration (optional, connectOverCDP) — Stagehand v3 Docs: https://docs.stagehand.dev/v3/integrations/playwright
- browserbase/stagehand — GitHub: https://github.com/browserbase/stagehand

요지: v3는 Playwright 하드 의존을 제거하고 CDP-native 모듈러 드라이버로 전환(복잡 DOM ~44% 개선). Playwright는 `connectOverCDP`로 선택 연결만 가능.

---

## 9. D3 상세 — Stagehand v3 실행기 골격 & PoC

> 목표: `ExecutorPlugin {dom, vision, utility}`(core-types)의 구현 골격을 세우되, **결정형 utility + PageStateResolver를 먼저**(dom=Stagehand `act` 없이) 동작시켜 IREL `on` 분기·`transitions.ts` 연결까지 dry-run 한다. Stagehand v3 결정형 CDP API 커버리지를 PoC로 실측하고 갭만 raw CDP로 보완.

### 9.1 구현 순서
1. **UtilityExecutor(CDP)** + **PageStateResolver** — Stagehand v3 CDP page 기반(LLM 미사용). 비브라우저(`api_call`/`file`/`shell`)는 별 모듈(Node).
2. **StagehandExecutor(dom)** — `act`/`observe`/`extract`(Gateway 경유).
3. **VisionExecutor** — VLM verify(Gateway). (후행)

### 9.2 PoC 체크리스트 — Stagehand v3 결정형 page API 커버리지 (각 항목 PASS / raw CDP 보완)
| # | 필요 기능 | 계약 근거 | 확인 |
|---|---|---|---|
| 1 | navigate(goto)/reload | IRActionType `navigate` | ☐ |
| 2 | DOM **structuralHash**(landmark role/name path 정규화) | core-types PageState.dom·action_plan_cache `dom_structural_hash` | ☐ |
| 3 | visibleTextHash·landmarks[]·frames[](iframe/shadow) | PageState.dom | ☐ |
| 4 | element by **selector** / **role+name** | verify.schema `elementTarget` | ☐ |
| 5 | download(파일 캡처 + `download_dir_ref` 격리) | IRActionType `download`, browser_leases.download_dir_ref | ☐ |
| 6 | upload(file input) | IRActionType `upload` | ☐ |
| 7 | click/type(캐시 재생 결정형 동작) | impl-bundle §D ActionPlanCache 재생 | ☐ |
| 8 | auth 상태 감지(anonymous/authenticated/expired) | PageState.auth | ☐ |
| 9 | **flags 산출**(닫힌 레지스트리 7종 set) | ir-static-validation §2, PageState.flags | ☐ |
| 10 | abort(AbortSignal → CDP 세션 close) | RunContext.abortSignal, error `CDP_DISCONNECTED` | ☐ |

- 각 항목이 Stagehand v3 page API로 충족되면 PASS, 부족하면 **raw CDP**(CDP 도메인 직접 호출)로 보완하고 그 경로를 기록(가정 금지).
- browser/credential lease·heartbeat·TTL은 ops-defaults §2 값으로 바인딩(별 프로세스 브라우저 워커 풀, §5).

### 9.3 PageState 산출 알고리즘(결정형, 비-LLM)
`structuralHash` = (가시 landmark의 `{role, name, pathHash}` 시퀀스를 url_pattern 정규화와 함께 정렬·해시). visible_text 제외(loop 가변 — impl-bundle §D family 키와 정합). `flags`는 §2 닫힌 레지스트리 키만 set(observe 신호/DOM 단서 → boolean). 이 산출물이 `page_state.resolve` span·IREL `flags.*`·`action_plan_cache` family 키의 원천.

### 9.4 D3 수용 기준(exit criteria)
- UtilityExecutor + PageStateResolver가 **Stagehand `act` 없이** flags·structuralHash 산출 → IREL `on` 분기 평가 가능.
- `codegen/transitions.ts`(D2) 연결로 최소 시나리오(`observe_reviews → extract_reviews → next_page`) **dry-run**(실 저장/전송 차단) 통과.
- PoC 체크리스트 10항목 PASS 또는 raw CDP 보완 경로 확정·문서화.

### 9.5 리스크 & 폴백
- Stagehand v3 결정형 API 갭 → raw CDP 보완(동일 CDP 세션). Playwright는 채택 안 함(필요 시 `connectOverCDP` 임시 검증만).
- CDP 세션 단절 → `CDP_DISCONNECTED`(error-catalog, retryable) → lease sweeper 회수(ops-defaults §2).

---

## 10. IREL evaluator & IR 정적검증 (구현 메모 — 가장 신규/위험 컴포넌트, D2 산출)

> ir-expression.md(EBNF·타입체커·결정론 evaluator)와 ir-static-validation.md(V1–V11)를 구현. 핵심 모듈 경계·캐시·파이프라인 배치를 고정한다.

- **파서**: 수기 **재귀하강 파서**(파서 제너레이터 비채택 — EBNF가 작고 결정성·에러 위치 제어가 우선). **JS eval 금지**(ir-expression §0·§5). 화이트리스트 함수(§4)만, 인덱싱/람다/삼항/할당 미지원.
- **컴파일 파이프라인**(시나리오 저장/승격, D4 API `validate`/`promote`): ① ajv 스키마(`codegen/validators`) → ② IREL parse + typecheck(전 expression, `IREL_*` 에러) → ③ IR 그래프 정적검증 **V1–V11**(`ValidationReport`/`ValidationIssue`, `codegen/types.ts`). 하나라도 실패 → 저장 거부(prod 승격 차단). **런타임 파싱 없음.**
- **AST 캐시 위치**: `scenario_versions.compiled_ast`(migration_core_entities) — 승격 통과분만 영속. 런타임은 캐시된 AST를 평가.
- **런타임 evaluator**: 순수 함수 `eval(ast, scope)`(부작용/`now()`/random 없음, 결정론 — `params.as_of` 주입). scope 4+1종(params/node/cursor/flags/loop). 무매칭/scope-missing은 조용한 false가 아니라 `IR_NO_BRANCH_MATCHED`/`IREL_RUNTIME_MISSING`(System)으로 표면화(ir-expression §5).
- **모듈 경계**: parser·typechecker·graph-validator는 *컴파일 타임*(API 계층, D4)에서, runtime evaluator는 *Interpreter*(Worker, D2)에서 호출. 둘은 같은 AST 타입을 공유하되 의존 방향은 Interpreter → evaluator(단방향).
- **빌드 배치**: D2(파서·타입체커·V1–V11·런타임 evaluator) → Worker/Interpreter(D2)가 `on`/`loop.until`/`fallback.advance_when` 평가에 사용 → D4 API가 저장/승격 시 컴파일 파이프라인 호출.
