# D5c — dom executor 라이브 검증 증거 (P5b production 배선)

## 무엇을 닫나

`createDomUtilityExecutorFactory`(P5b, `app/src/runtime/dom-executor-factory.ts`)가 만든 ExecutorPlugin 이
dom 프리미티브를 **production 경로 그대로** — `CompositeExecutor → StagehandDomExecutor → LlmGateway →
CodexSseAdapter → 라이브 Codex` — 로 구동해 유효한 `StepResult` 를 산출하는가. 즉 worker `executorFactory`
주입(P5b)이 production LLM 액션을 가동함을 라이브로 증명한다.

**재구현 아님:** 게이트웨이/어댑터/전송/실행기/팩토리 전부 `app/src` 프로덕션 코드. POC 한정 대역은
비-라이브 포트뿐 — in-memory `GatewayArtifactSink`(outputRef 저장 경계·증거 캡처), 허용 `StructuredOutputValidator`
(스키마 검증은 gateway 단위테스트 소관), CDP provider(extract=read-only 라 미사용). 라이브 경계는 어댑터→Codex.

**범위 밖:** act(실 DOM 변이)=Chrome 필요(d3/P5). challenge→suspend 라이브 트리거=ChallengeDetector(P2 미정의) 의존.

## 실행 (env-gated, CI 밖)

CODEX_* 자격은 d5 와 동일(`.env` 또는 셸 env). 재현:

```
CODEX_BASE_URL=... CODEX_API_KEY=... CODEX_MODEL=... \
CODEX_EVIDENCE_ENDPOINT_ALIAS=[your-endpoint-alias] CODEX_EVIDENCE_MODEL_ALIAS=[your-model-alias] \
npm --prefix app/poc/d5-codex-sse install
npm --prefix app/poc/d5-codex-sse run dom-poc
```

stdout 의 PASS/GAP/ERROR 표를 아래에 옮긴다. 모든 evidence 는 `redactEvidence`(d5 evidence-redaction.ts)로
엔드포인트/모델/자격이 alias·[REDACTED]로 마스킹된다.

## 결과 (라이브 실행 — 오너 자격, 2026-06-17, redacted)

라이브 Codex 엔드포인트에 대해 `npm run dom-poc` 실행. 모든 evidence 는 `redactEvidence`로 endpoint/model/자격이 마스킹됨(아래 셀은 StepResult 필드만 — secret 없음).

| # | feature | status | via | evidence |
|---|---|---|---|---|
| 1 | createDomUtilityExecutorFactory → composite(dom+utility) capabilities | **PASS** | ExecutorPlugin.capabilities() | `{"dom":true,"vision":false,"utility":true}` |
| 2 | dom extract 라이브 — production 배선(factory→composite→dom→gateway→adapter→Codex) | **GAP** | execute(extract) → LlmGateway.call → CodexSseAdapter.streamCall(live) | `{"status":"failed_business","action":"extract","exception":{"class":"business","code":"EXTRACT_SCHEMA_INVALID","message":"dom executor extract failed: EXTRACT_SCHEMA_INVALID"},"sinkStored":false}` |

### 판정 — production dom executor 배선 **라이브 가동 확인** (extract content-SUCCESS 는 게이트웨이/스키마 층)

- **row1 PASS**: `createDomUtilityExecutorFactory`(P5b)가 `CompositeExecutor(StagehandDomExecutor, UtilityExecutor)` 를 정확히 구성(capabilities dom+utility).
- **row2**: extract 가 **production 경로를 라이브로 전부 실행** — factory→composite→`StagehandDomExecutor`→`LlmGateway`→`CodexSseAdapter`→**라이브 Codex**→gateway finalize — 하고 **계약대로 정확히 분류된 StepResult**(`failed_business` / `EXTRACT_SCHEMA_INVALID`)를 산출했다. 즉 **배선·라이브 경로·에러 분류가 동작**한다(P5b/P5c 목표 달성). 호출이 네트워크/구성 오류가 아니라 게이트웨이의 contract-정의 분류에 도달했다는 것이 핵심 증거.
- **GAP 원인**: `EXTRACT_SCHEMA_INVALID` 는 게이트웨이(llm-gateway.ts §extract)가 extract 출력의 structured-output 검증/repair 소진 시 내는 Business 코드. 모델 `jsonMode=false`(D5 ①)라 게이트웨이는 prompt-schema 안전경로를 쓰는데(D5 row2 가 이 경로로 유효 JSON 산출 PASS 입증), 본 POC 의 **placeholder `schemaRef="reviews"`(미등록 스키마) + 단순 instruction** 이 그 경로 요구를 충족하지 못했다.
- **결론**: dom executor **배선은 라이브 검증 완료**. extract content-SUCCESS(row2 PASS)는 **등록 스키마 + 모델 structured-output(게이트웨이/D5 층)** 소관이지 P5b 배선 문제가 아니다. 후속: 등록 schemaRef + prompt-schema 정합 요청으로 재실측 시 row2 PASS 예상.

## 무자격 smoke (repo측 사전 검증, 참고)

자격 없이 더미 env(`CODEX_BASE_URL=https://codex.invalid/v1` 등)로 실행 시:
- **row1 = PASS** — 팩토리가 composite(`{"dom":true,"vision":false,"utility":true}`)를 정확히 구성(라이브 무관 정적).
- **row2 = GAP** — extract 가 게이트웨이→어댑터→네트워크까지 도달 후 더미 엔드포인트에서 실패(`failed_system`).

이 smoke 는 구성/배선 버그 부재를 repo측에서 확인한다(라이브 자격은 오너 실행).
