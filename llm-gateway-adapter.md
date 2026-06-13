# LLM Gateway Backend Adapter 계약 (v1)

> Gateway ↔ 모델 백엔드(Codex / LiteLLM / self-hosted vLLM) 사이의 adapter 인터페이스.
> 모든 Executor(StagehandExecutor, VLM verifier, VisionExecutor)는 Gateway만 호출하고, Gateway가 adapter를 호출한다. Executor는 adapter를 직접 알 수 없다.
> 전송 기본: **SSE 스트리밍**. sync는 폴백.

---

## 1. Adapter 인터페이스

```ts
interface LLMBackendAdapter {
  id: string;                                  // "codex-sse" | "litellm-sse" | "vllm-sse" | ...
  capabilities(): ModelCapabilities;
  streamCall(req: LLMRequest, signal: AbortSignal): AsyncIterable<LLMStreamEvent>;  // 메인
  syncCall?(req: LLMRequest): Promise<LLMResponse>;                                 // 폴백(짧은 분류)
}

type ModelCapabilities = {
  domReasoning: boolean;     // act/observe/extract용 텍스트 추론
  vision: boolean;           // VLM verify / VisionExecutor
  jsonMode: boolean;         // structured output 지원
  toolCall: boolean;         // tool/function call 지원
  sse: boolean;              // 스트리밍 지원(false면 sync 폴백 강제)
  maxContextTokens: number;
};
```

Gateway는 호출 전 `capabilities()`로 primitive 적합성 검사 — 예: extract+jsonMode=false면 거부(`LLM_CAPABILITY_MISMATCH`), VisionExecutor+vision=false면 거부.

---

## 2. Request 스키마

```ts
type LLMRequest = {
  model: string;
  promptTemplateVersion: string;             // 캐시 키·stagehand_calls 기록
  messages: LLMMessage[];                     // system / user 분리 — 웹페이지 텍스트는 항상 user
  responseFormat?: {
    type: "json_schema";
    schemaRef: string;                        // extract 출력 스키마
    schemaVersion: string;
    strict: boolean;                          // true면 비준수 시 fail(repair 금지)
  };
  images?: RedactedImageRef[];                // VLM 입력 — 이미 redaction된 참조만(원본 금지)
  tools?: ToolSpec[];
  metadata: {                                 // 관측·과금 상관
    tenantId: string; runId: string; stepId: string;
    primitive: "act"|"observe"|"extract"|"agent"|"vlm_verify"|"self_heal";
    correlationId: string;
  };
  budget: { maxInputTokens: number; maxOutputTokens: number; maxCost: number };
  sampling?: { temperature: number; seed?: number };   // 재현성 위해 seed 권장
};

type LLMMessage =
  | { role: "system"; content: string }                // 신뢰 영역. 페이지 텍스트 절대 금지.
  | { role: "user"; content: RedactedString | RedactedContentBlock[] };  // 페이지 컨텍스트는 여기로만
```

규칙: **messages는 이미 redaction 통과한 상태로 adapter에 전달**(redaction은 Gateway redaction 단계 — `security-contracts.md` §4 step2, adapter 진입 전). adapter는 redaction 책임 없음. `images`도 마스킹된 참조만.

---

## 3. SSE 응답 이벤트 (표준화)

adapter는 백엔드별 SSE 포맷을 내부 `LLMStreamEvent`로 정규화한다.

```ts
type LLMStreamEvent =
  | { type: "open" }
  | { type: "text_delta"; text: string }                      // act/observe reasoning 토큰
  | { type: "json_delta"; partial: string }                   // structured output 누적 조각
  | { type: "tool_call_delta"; id: string; name?: string; argsPartial?: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cost: number }
  | { type: "done"; finishReason: "stop"|"length"|"tool_call"|"content_filter" }
  | { type: "error"; code: AdapterErrorCode; retryable: boolean; message: string }
  | { type: "aborted" };                                      // signal.abort → 즉시 방출
```

처리 규칙:
- `json_delta`는 **누적만** 하고 `done` 시점에 1회 JSON Schema 검증. 부분 파싱으로 성공 판정 금지(false success 방지).
- `text_delta`는 운영 UI 실시간 스트림 가능(evidence). 최종 누적 텍스트를 output_ref로 저장.
- `usage` 미수신 백엔드는 adapter가 토큰 추정치 계산(추정 플래그).
- **[FIX #4] 스트림 중 예산 강제**: `usage` 누적(미수신 시 추정치)이 `budget.maxCost` 또는 `budget.maxOutputTokens`를 초과하면 adapter는 **즉시 SSE 연결 close → `error{code:BUDGET_EXCEEDED, retryable:false}` 1회 방출 → 과금 중단**. `done`까지 기다리지 않는다(비용 폭주 차단). Gateway는 이를 `LLM_BUDGET_EXCEEDED`로 매핑. 부분 누적 결과는 폐기(false success 방지).
- `abort`: `signal.abort()` 시 adapter는 SSE 연결 close 후 `aborted` 1회 방출, 진행 토큰 과금 중단.

---

## 4. Retry classification (adapter 책임 분류, Gateway가 정책 적용)

| 백엔드 신호 | AdapterErrorCode | retryable | Gateway 처리 |
|---|---|---|---|
| 429 | `RATE_LIMIT` | true | 백오프 후 재시도(최대 N), 소진 시 `LLM_RATE_LIMITED`(System) |
| 5xx | `BACKEND_ERROR` | true | 재시도, 소진 시 `LLM_BACKEND_UNAVAILABLE`(System) |
| idle timeout(토큰 무수신) | `STREAM_IDLE_TIMEOUT` | true | 1회 재시도 → fallback model |
| wall-clock timeout | `STREAM_TIMEOUT` | false | System 예외 |
| **예산 초과(스트림 중)** | `BUDGET_EXCEEDED` | false | 즉시 중단 → `LLM_BUDGET_EXCEEDED`(System). 재시도 안 함 |
| JSON 비준수(strict) | `MALFORMED_OUTPUT` | true(repair 1회 한정) | strict=false면 repair 1회 후 성공/실패. strict=true면 repair 없이 Business 예외(extract→`EXTRACT_SCHEMA_INVALID`) |
| content filter | `CONTENT_FILTERED` | false | Security/Business 판단 |
| 연결 실패 | `CONNECTION_FAILED` | true | fallback model, 소진 시 `LLM_CONNECTION_FAILED`(System) |

`fallback model`: primary adapter 실패 시 Gateway가 secondary adapter로 1회 폴백, 사유를 stagehand_calls.stream_status에 기록.

---

## 5. Structured output validation

```text
done(json) → 누적 partial을 JSON parse
  → 실패: MALFORMED_OUTPUT (repair 정책)
  → 성공: schemaRef@schemaVersion으로 JSON Schema 검증
      → 실패: strict=true면 fail(extract→Business 예외 EXTRACT_SCHEMA_INVALID)
              strict=false면 1회 repair 호출(원문+에러를 다시 user로)
      → 성공: extracted로 StepResult에 첨부
```

repair는 **최대 1회**. repair도 실패하면 Business 예외 고정.

---

## 6. Prompt / image artifact 정책

| 항목 | 저장 |
|---|---|
| redacted prompt | 기본 **hash만** 저장(input_redacted_ref=hash). 디버그 모드 한정 full(redacted) 저장, retention 짧게 |
| VLM input image | 마스킹된 이미지만 artifact(type=vlm_input), redaction_status 필수 |
| output | 누적 결과 전체 저장(output_ref). extract는 추출 데이터, act/observe는 reasoning 요약 |

image redaction 순서: 스크린샷 캡처 → 민감 영역 마스킹 → artifact 저장(vlm_input) → 그 참조를 LLMRequest.images로 → adapter. **원본 스크린샷이 adapter에 가는 경로 없음.**

---

## 7. Codex SSE 어댑터 (메인 구현)

- `id: "codex-sse"`. OpenAI 호환 `/v1/chat/completions` SSE(`stream: true`)를 기준으로 §3 이벤트로 매핑.
- `response_format: { type: "json_schema" }` 지원 여부를 capabilities.jsonMode에 반영. 미지원 시 prompt 내 스키마 지시 + strict 검증으로 대체.
- abort: HTTP 연결 abort로 SSE 종료.
- P1(self-hosted vLLM)도 동일 OpenAI 호환 SSE이면 같은 adapter 재사용, sse=false인 모델만 sync 폴백.

오픈 확인(PRD §19): Codex의 structured-output 스트리밍 지원 범위, abort 시그널 규격 — 미지원 시 jsonMode=false 경로로 동작.
