/**
 * 라이브 Codex SSE 전송 (D5 — llm-gateway-adapter.md §7).
 *
 * OpenAI 호환 `/v1/chat/completions`(`stream:true`)에 연결해 `text/event-stream` 프레임을
 * `OpenAiSseChunk` 로 파싱한다. abort 는 fetch `signal` 로 연결 close(§3·§7). **라이브 경계** —
 * 도달 가능한 엔드포인트+키가 있어야 동작하며(이 환경 미실행), capabilities 실범위는 PoC 로 확정한다(README §19).
 *
 * structured output 은 기본적으로 Gateway 가 prompt-schema 로 messages 에 주입한 상태로 전달된다
 * (redaction 완료, §2). **빠른경로**(`nativeStructuredOutput`)를 켜면 provider 측 유효-JSON 강제를 위해
 * `response_format` 도 함께 전송한다 — D5 라이브 PoC 2026-06-15 #3 로 가용 확정(app/poc/d5-codex-sse).
 */
import type { LLMRequest } from "../../../ts/security-middleware-contract";
import type { CodexSseTransport, OpenAiSseChunk } from "./codex-sse-adapter";

export interface FetchCodexSseOptions {
  /** OpenAI 호환 base, 예: "https://host/v1" (끝 슬래시 없음). */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 테스트/대체용 fetch 주입(기본 global fetch). */
  fetchImpl?: typeof fetch;
  /**
   * 빠른경로(jsonMode native). true 면 `req.responseFormat` 존재 시 OpenAI `response_format`을 전송해
   * provider 측 **유효-JSON 강제**(prompt-schema 는 그대로 유지, Gateway validator 가 스키마 적합성 검증).
   * D5 라이브 PoC 2026-06-15 #3 로 가용 확정. 현재는 `{type:"json_object"}`만 — `LLMRequest.responseFormat`
   * 은 `schemaRef`만 담고 스키마 본문이 없어, 스키마 적합성까지 provider 강제하는 `json_schema` 는 schemaRef
   * 해석 레지스트리(= ajv validator 와 동일 갭) 도입 후속이다. 반드시 어댑터 `capabilities.jsonMode=true`
   * 와 짝으로만 켠다(capabilities 와 전송 불일치 = 조용한 false 금지).
   */
  nativeStructuredOutput?: boolean;
}

// 메시지 content 직렬화: string|RedactedString 은 그대로, RedactedContentBlock[](Gateway redaction 산출)은 text/json
// 블록을 이어붙인다. 비-string 을 ""로 떨어뜨리던 기존 동작은 redact 된 user 메시지를 통째로 누락(조용한 false)시켜
// LLM 이 빈 입력을 받게 했다. OpenAI content-parts 대신 평문 합성(현 어댑터는 텍스트 스트림 경로).
function serializeMessageContent(content: LLMRequest["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  return content.map((b) => (typeof b.content === "string" ? b.content : JSON.stringify(b.content))).join("\n");
}

export class FetchCodexSseTransport implements CodexSseTransport {
  constructor(private readonly opts: FetchCodexSseOptions) {}

  async *open(req: LLMRequest, signal: AbortSignal): AsyncIterable<OpenAiSseChunk> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const body = {
      model: this.opts.model,
      stream: true,
      stream_options: { include_usage: true }, // 최종 usage 청크 수신(없으면 어댑터가 추정)
      messages: req.messages.map((m) => ({
        role: m.role,
        content: serializeMessageContent(m.content),
      })),
      // 빠른경로: responseFormat 가 있을 때만 provider 유효-JSON 강제(자유텍스트 호출엔 강제 안 함).
      ...(this.opts.nativeStructuredOutput && req.responseFormat
        ? { response_format: { type: "json_object" as const } }
        : {}),
      ...(req.sampling ? { temperature: req.sampling.temperature, seed: req.sampling.seed } : {}),
    };

    const res = await doFetch(`${this.opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
        accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok || res.body === null) {
      // §4 분류는 어댑터 책임 — 상태코드를 메시지에 실어 전파(조용한 흡수 금지).
      throw new Error(`codex-sse HTTP ${res.status} ${res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        // SSE 이벤트는 빈 줄(\n\n) 경계. 프레임별 data: 라인 파싱.
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          for (const line of frame.split("\n")) {
            const t = line.trim();
            if (!t.startsWith("data:")) continue;
            const data = t.slice(5).trim();
            if (data === "[DONE]") return;
            try {
              yield JSON.parse(data) as OpenAiSseChunk;
            } catch {
              // keepalive/주석 등 비-JSON 프레임은 건너뛴다(스트림 유지).
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
