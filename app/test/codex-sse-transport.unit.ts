/**
 * D5 단위 테스트 — FetchCodexSseTransport 빠른경로(jsonMode native) 전송 본문 검증.
 *
 * 라이브 엔드포인트 없이 `fetchImpl` 주입으로 요청 본문만 검증한다(전송 로직 오프라인 검증).
 * D5 라이브 PoC 2026-06-15 #3 가 native response_format 가용을 확정 → 전송이 opt-in 시에만,
 * 그리고 responseFormat 가 있을 때만 `response_format` 를 싣는지 확인(불일치/오강제 방지).
 *
 * 실행: tsx test/codex-sse-transport.unit.ts (app/package.json test:unit 등록은 codex 동시편집
 * 회피로 보류 — typecheck(tsconfig include test/**)로 타입 게이팅, 행위는 본 수동 실행 증거).
 */
import type { LLMRequest } from "../../ts/security-middleware-contract";
import { FetchCodexSseTransport } from "../src/gateway/codex-sse-transport";

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
    messages: [{ role: "user", content: "hello" }],
    metadata: { tenantId: "t", runId: "r", stepId: "s", primitive: "extract", correlationId: "c" },
    budget: { maxInputTokens: 10000, maxOutputTokens: 10000, maxCost: 100 },
    idempotencyKey: "idem",
    requestHash: "hash",
    ...over,
  } as unknown as LLMRequest;
}

const RESPONSE_FORMAT = {
  type: "json_schema",
  schemaRef: "extract/result",
  schemaVersion: "1",
  strict: true,
} as const;

/** 본문을 캡처하고 최소 SSE 스트림으로 응답하는 fake fetch. */
function capturingFetch(): { fetchImpl: typeof fetch; body: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    captured = JSON.parse(init.body) as Record<string, unknown>;
    return new Response(
      'data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, body: () => captured };
}

async function drain(transport: FetchCodexSseTransport, req: LLMRequest): Promise<void> {
  const signal = new AbortController().signal;
  for await (const _ of transport.open(req, signal)) {
    /* 본문 캡처가 목적 — 청크는 소비만 */
  }
}

async function main(): Promise<void> {
  const base = { baseUrl: "https://host/v1", apiKey: "k", model: "codex" };

  // 1) 기본(opt-out) + responseFormat 있음 → response_format 미전송(안전경로).
  {
    const cap = capturingFetch();
    await drain(new FetchCodexSseTransport({ ...base, fetchImpl: cap.fetchImpl }), makeReq({ responseFormat: RESPONSE_FORMAT }));
    check("opt-out: response_format 미전송", cap.body().response_format === undefined, JSON.stringify(cap.body().response_format));
  }

  // 2) 빠른경로 on + responseFormat 있음 → response_format:{type:"json_object"} 전송.
  {
    const cap = capturingFetch();
    await drain(
      new FetchCodexSseTransport({ ...base, fetchImpl: cap.fetchImpl, nativeStructuredOutput: true }),
      makeReq({ responseFormat: RESPONSE_FORMAT }),
    );
    const rf = cap.body().response_format as { type?: string } | undefined;
    check("빠른경로: response_format={type:json_object} 전송", rf?.type === "json_object", JSON.stringify(rf));
  }

  // 3) 빠른경로 on + responseFormat 없음 → 자유텍스트 호출엔 강제 안 함.
  {
    const cap = capturingFetch();
    await drain(new FetchCodexSseTransport({ ...base, fetchImpl: cap.fetchImpl, nativeStructuredOutput: true }), makeReq());
    check("빠른경로+무responseFormat: response_format 미전송", cap.body().response_format === undefined, JSON.stringify(cap.body().response_format));
  }

  // 4) stream:true 는 항상 유지(빠른경로와 무관).
  {
    const cap = capturingFetch();
    await drain(new FetchCodexSseTransport({ ...base, fetchImpl: cap.fetchImpl, nativeStructuredOutput: true }), makeReq({ responseFormat: RESPONSE_FORMAT }));
    check("stream:true 유지", cap.body().stream === true);
  }

  console.log(`\ncodex-sse-transport.unit: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
