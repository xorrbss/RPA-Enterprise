/**
 * 라이브 Codex SSE 전송 (D5 — llm-gateway-adapter.md §7).
 *
 * OpenAI 호환 `/v1/chat/completions`(`stream:true`)에 연결해 `text/event-stream` 프레임을
 * `OpenAiSseChunk` 로 파싱한다. abort 는 fetch `signal` 로 연결 close(§3·§7). **라이브 경계** —
 * 도달 가능한 엔드포인트+키가 있어야 동작하며(이 환경 미실행), capabilities 실범위는 PoC 로 확정한다(README §19).
 *
 * 안전 경로: jsonMode 미확정이라 `response_format` 를 native 로 보내지 않는다(어댑터 capabilities 보수적).
 * structured output 은 Gateway 가 prompt-schema 로 messages 에 주입한 상태로 전달된다(redaction 완료, §2).
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
        content: typeof m.content === "string" ? m.content : "",
      })),
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
