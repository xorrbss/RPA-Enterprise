# D5 PoC 증거 — Codex SSE 라이브 외부 사실 실측

> llm-gateway-adapter.md §7(line 143) / README §19 가 정의한 **라이브로만 확정되는 외부 사실 3가지**를
> 실제 OpenAI 호환 Codex 엔드포인트로 실측하는 하니스. **프로덕션 코드**(`app/src/gateway/codex-sse-adapter.ts`
> 의 `CodexSseAdapter` + `codex-sse-transport.ts` 의 `FetchCodexSseTransport`)를 그대로 라이브 검증한다 —
> 재구현이 아니다. 자격증명은 env 로만 주입하고 repo 에 남기지 않는다.

## 닫아야 할 외부 사실(가정 금지)

| # | 외부 사실 | 확정 대상 |
|---|---|---|
| ① | structured-output 스트리밍 지원 범위 | `capabilities.jsonMode` (true→빠른경로 / false→prompt-schema 안전경로 유지) |
| ② | abort 시그널 규격 | `signal.abort()` 시 SSE close + `aborted` 1회 + hang 없음 + 과금 누수 없음 |
| ③ | maxContextTokens | 모델 실제 컨텍스트 한도(config 권장값) |

## 재현 방법

```bash
# 자격증명은 셸 env 로만 주입 — repo 에 저장 금지
export CODEX_BASE_URL=https://<host>/v1     # 끝 슬래시 없음
export CODEX_API_KEY=<key>
export CODEX_MODEL=<model-id>
export CODEX_MAX_CONTEXT_TOKENS=<n>          # 선택(기본 8192)

npm --prefix app/poc/d5-codex-sse install
npm --prefix app/poc/d5-codex-sse run poc    # stdout 표를 아래에 옮긴다
```

2026-06-15 자격증명 보유자가 위 명령으로 실행 완료 → 결과는 아래 `결과` 절 참조. 재실측 시 동일 명령.

## 검사 항목(하니스가 실행하는 5개 테스트)

| # | 테스트 | 경로(via) | 매핑 |
|---|---|---|---|
| 1 | 기본 SSE 스트리밍 | `CodexSseAdapter.streamCall` + `FetchCodexSseTransport` | 안전경로 정규화(open→text_delta→usage→done) 동작 |
| 2 | structured-output(안전경로) | prompt 지시 → 텍스트 스트림 → `JSON.parse`+shape 검증 | jsonMode=false 경로(§7 prompt-schema+strict)가 라이브에서 실제로 유효 JSON 산출하는지 |
| 3 | native json_schema 스트리밍(빠른경로 프로브) | 직접 POST `response_format:{json_schema}` `stream:true` | **외부 사실 ①** → `capabilities.jsonMode` 확정 |
| 4 | abort 시그널 규격 | 첫 토큰 후 `signal.abort()` → 내부 AbortController close | **외부 사실 ②** |
| 5 | maxContextTokens | GET `/models` 메타데이터 프로브 | **외부 사실 ③** |

## 분류 기준

- `PASS` — 라이브로 충족(또는 빠른경로 활성 가능).
- `GAP` — 미지원/메타데이터 부재. **#3 native json_schema** 와 **#5 model metadata** 에서만 허용된다.
  #3 이 GAP 이면 `jsonMode=false` 안전경로를 유지하고, #5 가 GAP 이면 보수적 `maxContextTokens` config 를 유지한다.
- `ERROR` — 실행 예외(네트워크/자격증명/엔드포인트 문제).

Release evidence 기준: #1 기본 SSE, #2 prompt-schema 안전경로, #4 abort 규격은 반드시 `PASS` 여야 한다.
이 셋 중 하나라도 `GAP`/`ERROR` 이면 하니스는 nonzero 로 종료하고 D5 release evidence 로 사용할 수 없다.

## 결과 (라이브 실행 2026-06-15)

> 상태: **CONFIRMED.** 실행 환경 = OpenAI `api.openai.com/v1`, model `gpt-4o-mini`,
> `CODEX_MAX_CONTEXT_TOKENS=128000`. OpenAI 호환 계약(Bearer + `/chat/completions` SSE +
> `response_format:{json_schema}`)을 실측했다. 실제 Codex 엔드포인트가 다르면 그 엔드포인트로 재실측한다.

```
| # | 필요 기능 | 상태 | 증거 |
|---|---|---|---|
| 1 | 기본 SSE 스트리밍(안전경로 정규화) | PASS | events=[open,text_delta×3,usage,done] textLen=5 |
| 2 | structured-output(안전경로 prompt-schema) | PASS | parsed={"city":"Paris","country":"France"} |
| 3 | native json_schema 스트리밍(빠른경로 → jsonMode) | PASS | accepted + valid streamed JSON → jsonMode=true 활성 가능 |
| 4 | abort 시그널 규격 | PASS | events=[open,text_delta,aborted] aborted=true elapsedMs=639 postAbortDeltas=0 |
| 5 | maxContextTokens | GAP | /models 에 context 필드 없음 → 보수적 config(128000) 유지 |

결과: 4/5 PASS
release evidence: #1/#2/#4 모두 PASS ✅. #5 GAP 은 보수적 maxContextTokens fallback 으로 허용.
```

### 확정 결론 (D5 하드 블로커 해소)

- **① structured-output 스트리밍 = 지원(jsonMode native 가용).** #3 PASS — provider 가
  `response_format:{type:json_schema}` + `stream:true` 를 수용하고 유효 JSON 을 스트리밍.
- **② abort 규격 = 확정.** #4 PASS — `signal.abort()` 후 close + `aborted` 1회, hang 없음,
  abort 후 토큰 누수 0. 현 어댑터 구현이 규격 충족(변경 불요).
- **③ maxContextTokens = 메타데이터 부재.** #5 GAP — `/models` 미노출. 보수적 config 유지가 정답.
- **안전경로 자체가 production-ready.** #1·#2 PASS — jsonMode=false prompt-schema+strict 경로가
  라이브에서 유효 JSON 산출. 빠른경로 미적용이어도 D5 동작은 완결.

## 어댑터 config 반영 / 후속

- **abort**: 변경 없음 — 현 어댑터가 규격 충족(#4 PASS).
- **maxContextTokens**: 보수적 `cfg.maxContextTokens`(128000) 유지 — provider 메타데이터 부재(#5 GAP).
- **안전경로(jsonMode=false)**: 현 production 기본 유지 — 라이브 검증 완료(#1·#2 PASS).
- **빠른경로(jsonMode native) — 1단계 구현됨**: `FetchCodexSseTransport` 에 opt-in `nativeStructuredOutput`
  추가 → `req.responseFormat` 존재 시 `response_format:{type:"json_object"}` 전송으로 **provider 측 유효-JSON
  강제**(prompt-schema 유지 + Gateway validator 가 스키마 적합성 검증). 켤 때 어댑터 `capabilities.jsonMode=true`
  와 짝(불일치=조용한 false 금지). 검증: `app/test/codex-sse-transport.unit.ts`(opt-out 미전송 / opt-in 전송 /
  무responseFormat 미강제 / stream 유지).
- **빠른경로 2단계(json_schema 스키마 적합성 provider 강제) — 후속**: `LLMRequest.responseFormat` 은
  `schemaRef`만 담아 스키마 본문이 없다 → `response_format:{type:"json_schema", json_schema:{schema}}` 는
  schemaRef→스키마 해석 **레지스트리**가 선행돼야 한다(= ajv `StructuredOutputValidator` 와 동일 갭).
  레지스트리 도입 시 transport 가 json_schema 로 승격하고 회귀 검증한다.

## 결정 로그

이 PoC 는 D5 의 라이브 외부 사실을 닫기 위한 하니스다. #1/#2/#4 가 PASS 여야 release evidence 로
인용할 수 있고, #3/#5 GAP 은 이미 정의된 fallback 경로를 유지한다는 뜻일 뿐이다. 어느 경우든
"조용한 false/unknown" 없이 명시 경로로 수렴한다.
