/**
 * D5 단위 테스트 — CapabilityGate + LlmGateway 오케스트레이션 골격(llm-gateway-adapter.md §1·§4·§5).
 *
 * 주입형 fake(adapter·validator·sink·멱등 store)로 키/DB 없이 게이트·retry·fallback·structured-output·
 * repair·멱등 replay 경로를 검증한다. 실행: `tsx test/llm-gateway.unit.ts`.
 */
import type { ArtifactRef } from "../../ts/core-types";
import type {
  AdapterErrorCode,
  LLMBackendAdapter,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  ModelCapabilities,
} from "../../ts/security-middleware-contract";
import { SafeCapabilityGate } from "../src/gateway/capability-gate";
import {
  GatewayError,
  LlmGateway,
  type LlmGatewayDeps,
  type StructuredOutputValidator,
} from "../src/gateway/llm-gateway";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const caps = (over: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  domReasoning: true,
  vision: false,
  jsonMode: false,
  toolCall: false,
  sse: true,
  maxContextTokens: 8000,
  ...over,
});

function makeReq(over: Record<string, unknown> = {}): LLMRequest {
  return {
    model: "codex",
    promptTemplateVersion: "v1",
    messages: [{ role: "user", content: "hi" }],
    metadata: { tenantId: "t", runId: "r", stepId: "s", primitive: "act", correlationId: "c" },
    budget: { maxInputTokens: 10000, maxOutputTokens: 10000, maxCost: 100 },
    idempotencyKey: "idem",
    requestHash: "hash",
    ...over,
  } as unknown as LLMRequest;
}

/** streamCall 마다 다음 시퀀스를 방출하는 fake adapter(retry/fallback 검증용). */
function queueAdapter(seqs: LLMStreamEvent[][], capOver: Partial<ModelCapabilities> = {}, id = "primary") {
  let i = 0;
  const adapter: LLMBackendAdapter = {
    id,
    capabilities: () => caps(capOver),
    async *streamCall() {
      const seq = seqs[Math.min(i, seqs.length - 1)];
      i += 1;
      for (const e of seq) yield e;
    },
  };
  return { adapter, calls: () => i };
}

const textDone = (t: string): LLMStreamEvent[] => [
  { type: "text_delta", text: t },
  { type: "usage", inputTokens: 1, outputTokens: 1, cost: 0 },
  { type: "done", finishReason: "stop" },
];
const errSeq = (code: AdapterErrorCode, retryable: boolean): LLMStreamEvent[] => [
  { type: "error", code, retryable, message: "x" },
];

const okValidator: StructuredOutputValidator = { validate: () => ({ ok: true }) };
const sink: LlmGatewayDeps["sink"] = { put: async () => "art://ref" as ArtifactRef };
const cfg = { retryMax: 2, fallbackAttempts: 1, repairAttempts: 1 };
const sig = () => new AbortController().signal;

function gateway(over: Partial<LlmGatewayDeps>): LlmGateway {
  return new LlmGateway({
    primary: queueAdapter([textDone("ok")]).adapter,
    gate: new SafeCapabilityGate(),
    validator: okValidator,
    sink,
    config: cfg,
    ...over,
  });
}

async function caught(p: Promise<unknown>): Promise<GatewayError | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e instanceof GatewayError ? e : undefined;
  }
}

async function main(): Promise<void> {
  const gate = new SafeCapabilityGate();

  // ── CapabilityGate (§1 + §19 정합) ──────────────────────────────────────────
  check("gate: vlm_verify + vision=false → deny", gate.evaluate({ primitive: "vlm_verify", capabilities: caps({ vision: false }) }).kind === "deny");
  {
    const d = gate.evaluate({ primitive: "extract", responseFormat: { type: "json_schema", schemaRef: "s", schemaVersion: "1", strict: true }, capabilities: caps({ jsonMode: false }) });
    check("gate: extract + jsonMode=false → allow(§19 폴백, not deny)", d.kind === "allow" && d.transport === "sse");
  }
  check("gate: sse=false → allow transport=sync", (() => { const d = gate.evaluate({ primitive: "act", capabilities: caps({ sse: false }) }); return d.kind === "allow" && d.transport === "sync"; })());
  check("gate: extract + domReasoning=false → deny", gate.evaluate({ primitive: "extract", capabilities: caps({ domReasoning: false }) }).kind === "deny");

  // ── happy path ──────────────────────────────────────────────────────────────
  {
    const res = await gateway({ primary: queueAdapter([textDone("hello")]).adapter }).call(makeReq(), sig());
    check("call: happy path returns outputRef+usage", res.outputRef === "art://ref" && res.finishReason === "stop" && res.usage.outputTokens === 1);
  }

  // ── 멱등 replay 단락(adapter 미호출) ───────────────────────────────────────
  {
    const cached: LLMResponse = { outputRef: "art://cached" as ArtifactRef, usage: { inputTokens: 0, outputTokens: 0, cost: 0 }, finishReason: "stop" };
    const q = queueAdapter([textDone("should-not-run")]);
    const res = await gateway({ primary: q.adapter, idempotency: { reserve: async () => ({ kind: "replay", response: cached }), complete: async () => {}, fail: async () => {} } }).call(makeReq(), sig());
    check("call: replay returns cached, adapter not called", res.outputRef === "art://cached" && q.calls() === 0);
  }

  // ── retry(§4): 재시도 가능 1회 후 성공 ──────────────────────────────────────
  {
    const q = queueAdapter([errSeq("RATE_LIMIT", true), textDone("recovered")]);
    const res = await gateway({ primary: q.adapter }).call(makeReq(), sig());
    check("call: retryable RATE_LIMIT then ok (2 attempts)", res.outputRef === "art://ref" && q.calls() === 2);
  }

  // ── fallback(§4): primary 재시도 소진 → secondary 성공 ──────────────────────
  {
    const primary = queueAdapter([errSeq("RATE_LIMIT", true)]); // 매 시도 실패(3회)
    const fb = queueAdapter([textDone("from-fallback")], {}, "fallback");
    const res = await gateway({ primary: primary.adapter, fallback: fb.adapter }).call(makeReq(), sig());
    check("call: primary exhausted → fallback ok", res.outputRef === "art://ref" && primary.calls() === cfg.retryMax + 1 && fb.calls() === 1);
  }

  // ── 종결(비재시도) + 멱등 fail 기록 ────────────────────────────────────────
  {
    let failedCode: string | undefined;
    const err = await caught(
      gateway({
        primary: queueAdapter([errSeq("BUDGET_EXCEEDED", false)]).adapter,
        idempotency: { reserve: async () => ({ kind: "reserved", callId: "c1", idempotencyKey: "idem" as never }), complete: async () => {}, fail: async (_id, code) => { failedCode = code; } },
      }).call(makeReq(), sig()),
    );
    check("call: BUDGET_EXCEEDED → LLM_BUDGET_EXCEEDED (no retry/fallback)", err?.code === "LLM_BUDGET_EXCEEDED");
    check("call: idempotency.fail recorded BUDGET_EXCEEDED", failedCode === "BUDGET_EXCEEDED");
  }

  // ── structured output(§5): strict 위반 → EXTRACT_SCHEMA_INVALID ─────────────
  {
    const req = makeReq({ metadata: { tenantId: "t", runId: "r", stepId: "s", primitive: "extract", correlationId: "c" }, responseFormat: { type: "json_schema", schemaRef: "s", schemaVersion: "1", strict: true } });
    const err = await caught(gateway({ primary: queueAdapter([textDone("not json")]).adapter }).call(req, sig()));
    check("call: extract strict malformed → EXTRACT_SCHEMA_INVALID", err?.code === "EXTRACT_SCHEMA_INVALID");
  }

  // ── structured output(§5): non-strict repair 1회 후 성공 ───────────────────
  {
    let n = 0;
    const validator: StructuredOutputValidator = { validate: () => (n++ === 0 ? { ok: false, reason: "schema" } : { ok: true }) };
    const req = makeReq({ metadata: { tenantId: "t", runId: "r", stepId: "s", primitive: "extract", correlationId: "c" }, responseFormat: { type: "json_schema", schemaRef: "s", schemaVersion: "1", strict: false } });
    const q = queueAdapter([textDone('{"a":1}'), textDone('{"a":2}')]);
    const res = await gateway({ primary: q.adapter, validator }).call(req, sig());
    check("call: non-strict repair once → success", res.parsedJson !== undefined && (res.parsedJson as { a: number }).a === 2 && q.calls() === 2);
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D5 capability-gate + llm-gateway unit green");
  process.exit(0);
}

main().catch((e) => {
  console.error("unit fatal:", e);
  process.exit(1);
});
