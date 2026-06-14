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

이 환경은 라이브 Codex 엔드포인트/키가 없어 **하니스만 제공**한다. 실행 권한자(자격증명 보유)가
위 명령으로 실행하고 결과 표를 아래 `결과` 절에 채운다.

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

## 결과 (라이브 실행 후 채움)

> 상태: **PENDING — 자격증명 보유자의 라이브 실행 대기.** 이 환경에서는 미실행.

```
| # | 필요 기능 | 상태 | 경로(via) | 증거 |
|---|---|---|---|---|
| 1 | 기본 SSE 스트리밍(안전경로 정규화) | (실행 후) | ... | ... |
| 2 | structured-output(안전경로 prompt-schema) | (실행 후) | ... | ... |
| 3 | native json_schema 스트리밍(빠른경로 → jsonMode) | (실행 후) | ... | ... |
| 4 | abort 시그널 규격 | (실행 후) | ... | ... |
| 5 | maxContextTokens | (실행 후) | ... | ... |

결과: _/5 PASS
release evidence: #1/#2/#4 모두 PASS 필요. #3/#5 GAP 은 fallback 근거와 함께 허용.
```

## capabilities 결론 → 어댑터 config 반영

라이브 실행 후 확정값을 `CodexSseConfig.capabilities` / `maxContextTokens` 에 반영한다.

- **③ jsonMode=true 로 확정되면**: `CodexSseAdapter` 생성 시 `capabilities: { jsonMode: true }` override +
  전송이 `response_format` 를 native 로 전달하도록 빠른경로 활성. (현재는 보수적 기본 false.)
- **③ jsonMode=false(GAP) 이면**: 변경 없음 — Gateway prompt-schema+strict 안전경로가 정답(테스트 2 가 입증).
- **② abort PASS**: 현 어댑터 구현이 규격 충족 — 변경 없음.
- **⑤ maxContextTokens PASS**: 확정값을 `cfg.maxContextTokens` 로 설정(현재 보수적 기본).

## 결정 로그

이 PoC 는 D5 의 라이브 외부 사실을 닫기 위한 하니스다. #1/#2/#4 가 PASS 여야 release evidence 로
인용할 수 있고, #3/#5 GAP 은 이미 정의된 fallback 경로를 유지한다는 뜻일 뿐이다. 어느 경우든
"조용한 false/unknown" 없이 명시 경로로 수렴한다.
