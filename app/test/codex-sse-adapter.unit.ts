/**
 * D5 단위 테스트 — Codex SSE 어댑터 안전 경로 골격(llm-gateway-adapter.md §1·§3·§4·§7).
 *
 * 라이브 엔드포인트/키 없이 **fake 전송**으로 정규화·예산·abort·타임아웃 로직만 검증한다.
 * 실행: `npm --prefix app run test:unit` (또는 tsx test/codex-sse-adapter.unit.ts).
 */
import type { LLMRequest, LLMStreamEvent } from "../../ts/security-middleware-contract";
import { CodexSseAdapter, type CodexSseConfig, type CodexSseTransport, type OpenAiSseChunk } from "../src/gateway/codex-sse-adapter";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function makeReq(over: Record<string, unknown> = {}): LLMRequest {
  return {
    model: "codex",
    promptTemplateVersion: "v1",
    messages: [{ role: "user", content: "hello world" }],
    metadata: { tenantId: "t", runId: "r", stepId: "s", primitive: "extract", correlationId: "c" },
    budget: { maxInputTokens: 10000, maxOutputTokens: 10000, maxCost: 100 },
    idempotencyKey: "idem",
    requestHash: "hash",
    ...over,
  } as unknown as LLMRequest;
}

function cfg(over: Partial<CodexSseConfig> = {}): CodexSseConfig {
  return {
    model: "codex",
    maxContextTokens: 8000,
    idleTimeoutMs: 10000,
    wallTimeoutMs: 10000,
    pricePer1kInputUsd: 0,
    pricePer1kOutputUsd: 0,
    ...over,
  };
}

/** 청크를 순서대로 방출하고 끝나는 전송. */
function fixedTransport(chunks: OpenAiSseChunk[]): CodexSseTransport {
  return {
    async *open() {
      for (const c of chunks) yield c;
    },
  };
}

/** 청크 방출 후 signal abort 까지 hang(전송 정리 검증용). */
function hangTransport(chunks: OpenAiSseChunk[]): CodexSseTransport {
  return {
    async *open(_req, signal) {
      for (const c of chunks) yield c;
      await new Promise<void>((res) => {
        if (signal.aborted) return res();
        signal.addEventListener("abort", () => res(), { once: true });
      });
    },
  };
}

/** 첫 next 에서 throw(전송 실패 분류 검증용). */
function throwingTransport(message: string): CodexSseTransport {
  return {
    // eslint-disable-next-line require-yield
    async *open() {
      throw new Error(message);
    },
  };
}

async function collect(events: AsyncIterable<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const out: LLMStreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}
const types = (es: LLMStreamEvent[]): string[] => es.map((e) => e.type);

async function main(): Promise<void> {
  // 1) 정규화: open → text_delta* → usage(실측) → done(stop)
  {
    const a = new CodexSseAdapter(
      fixedTransport([
        { choices: [{ delta: { content: "Hel" } }] },
        { choices: [{ delta: { content: "lo" } }] },
        { usage: { prompt_tokens: 5, completion_tokens: 1 } },
        { choices: [{ finish_reason: "stop" }] },
      ]),
      cfg(),
    );
    const es = await collect(a.streamCall(makeReq(), new AbortController().signal));
    check("normalize: event sequence", types(es).join(",") === "open,text_delta,text_delta,usage,done", types(es).join(","));
    const usage = es.find((e) => e.type === "usage");
    check("normalize: usage from backend (estimated=false)", usage?.type === "usage" && usage.estimated === false && usage.inputTokens === 5 && usage.outputTokens === 1);
    const done = es.at(-1);
    check("normalize: done finishReason=stop", done?.type === "done" && done.finishReason === "stop");
  }

  // 2) 스트림 중 예산 강제(§3 FIX#4): out 토큰 상한 초과 → error BUDGET_EXCEEDED, done 없음
  {
    const a = new CodexSseAdapter(fixedTransport([{ choices: [{ delta: { content: "abcdefghij" } }] }]), cfg());
    const es = await collect(a.streamCall(makeReq({ budget: { maxInputTokens: 10000, maxOutputTokens: 1, maxCost: 100 } }), new AbortController().signal));
    const err = es.find((e) => e.type === "error");
    check("budget: BUDGET_EXCEEDED emitted", err?.type === "error" && err.code === "BUDGET_EXCEEDED" && err.retryable === false);
    check("budget: no done after cut (false success 방지)", !types(es).includes("done"));
  }

  // 3) abort: 진행 중 signal.abort → aborted 1회
  {
    const a = new CodexSseAdapter(hangTransport([{ choices: [{ delta: { content: "x" } }] }]), cfg());
    const ac = new AbortController();
    const p = collect(a.streamCall(makeReq(), ac.signal));
    setTimeout(() => ac.abort(), 30);
    const es = await p;
    check("abort: ends with aborted", es.at(-1)?.type === "aborted");
    check("abort: saw text before abort", types(es).includes("text_delta"));
  }

  // 4) idle timeout: 토큰 무수신 → STREAM_IDLE_TIMEOUT(retryable)
  {
    const a = new CodexSseAdapter(hangTransport([]), cfg({ idleTimeoutMs: 40 }));
    const es = await collect(a.streamCall(makeReq(), new AbortController().signal));
    const err = es.find((e) => e.type === "error");
    check("idle: STREAM_IDLE_TIMEOUT(retryable)", err?.type === "error" && err.code === "STREAM_IDLE_TIMEOUT" && err.retryable === true);
  }

  // 5) 전송 실패(§4 분류): 429 → RATE_LIMIT(retryable)
  {
    const a = new CodexSseAdapter(throwingTransport("codex-sse HTTP 429 Too Many Requests"), cfg());
    const es = await collect(a.streamCall(makeReq(), new AbortController().signal));
    const err = es.find((e) => e.type === "error");
    check("transport error: 429 → RATE_LIMIT(retryable)", err?.type === "error" && err.code === "RATE_LIMIT" && err.retryable === true);
  }

  // 6) finish 매핑: tool_calls → tool_call
  {
    const a = new CodexSseAdapter(fixedTransport([{ choices: [{ delta: { content: "x" }, finish_reason: "tool_calls" }] }]), cfg());
    const es = await collect(a.streamCall(makeReq(), new AbortController().signal));
    const done = es.find((e) => e.type === "done");
    check("finish: tool_calls → tool_call", done?.type === "done" && done.finishReason === "tool_call");
  }

  // 7) 안전 경로 capabilities: jsonMode=false, sse=true (보수적 기본)
  {
    const a = new CodexSseAdapter(fixedTransport([]), cfg());
    const cap = a.capabilities();
    check("capabilities: safe defaults (jsonMode=false, sse=true)", cap.jsonMode === false && cap.sse === true && cap.maxContextTokens === 8000);
  }

  // 8) 사전 abort: open 전에 aborted
  {
    const a = new CodexSseAdapter(fixedTransport([{ choices: [{ delta: { content: "x" } }] }]), cfg());
    const ac = new AbortController();
    ac.abort();
    const es = await collect(a.streamCall(makeReq(), ac.signal));
    check("pre-abort: only aborted", types(es).join(",") === "aborted");
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D5 codex-sse adapter unit green (safe path)");
  process.exit(0);
}

main().catch((e) => {
  console.error("unit fatal:", e);
  process.exit(1);
});
