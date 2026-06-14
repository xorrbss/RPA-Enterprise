/**
 * LLM Gateway 오케스트레이션 골격 (D5 — llm-gateway-adapter.md §1·§4·§5).
 *
 * Executor 는 Gateway 만 호출하고 Gateway 가 adapter 를 호출한다(Executor 는 adapter 를 모른다).
 * 흐름: CapabilityGate → 멱등 reserve(replay 단락) → adapter 스트림 소비(retry §4 + fallback 1회) →
 * AdapterErrorCode → ErrorCode 매핑(§4) → structured output 검증/repair(§5) → LLMResponse.
 *
 * 모든 외부 의존(adapter·gate·멱등 store·schema validator·artifact sink)은 주입형 포트라 키/DB 없이
 * 오프라인 검증 가능하다. retry/repair/fallback 횟수는 ops-defaults §4(retry_max 2·fallback 1·repair 1).
 */
import type { ArtifactRef } from "../../../ts/core-types";
import type { ErrorCode } from "../../../ts/error-catalog";
import type {
  AdapterErrorCode,
  CapabilityGate,
  LLMBackendAdapter,
  LLMCallIdempotencyStore,
  LLMRequest,
  LLMResponse,
} from "../../../ts/security-middleware-contract";

type Transport = "sse" | "sync";
type Usage = LLMResponse["usage"];
type FinishReason = LLMResponse["finishReason"];

/** §5 structured output 검증 포트(ajv 등 실제 검증기 주입 — 재구현 금지). */
export interface StructuredOutputValidator {
  validate(input: { schemaRef: string; schemaVersion: string; value: unknown }):
    | { ok: true }
    | { ok: false; reason: string };
}

/** 누적 출력 저장 포트 → outputRef(§6 artifact). */
export interface GatewayArtifactSink {
  put(content: string, meta: Pick<LLMRequest["metadata"], "tenantId" | "runId" | "stepId">): Promise<ArtifactRef>;
}

export interface LlmGatewayConfig {
  retryMax: number; // ops llm.retry_max (2): 동일 adapter 재시도 횟수
  fallbackAttempts: number; // ops llm.fallback_attempts (1): secondary adapter 시도
  repairAttempts: number; // ops llm.repair_attempts (1): MALFORMED/스키마 불일치 repair
}

export interface LlmGatewayDeps {
  primary: LLMBackendAdapter;
  fallback?: LLMBackendAdapter;
  gate: CapabilityGate;
  validator: StructuredOutputValidator;
  sink: GatewayArtifactSink;
  idempotency?: LLMCallIdempotencyStore;
  config: LlmGatewayConfig;
}

/** 카탈로그 ErrorCode 로 분류된 Gateway 종결 실패. */
export class GatewayError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    /** 원 AdapterErrorCode(멱등 store.fail 기록용). */
    readonly adapterCode?: AdapterErrorCode,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/** run abort 전파 — 카탈로그 ErrorCode 가 아닌 제어 흐름 신호(run 단위 취소가 처리). */
export class GatewayAbortedError extends Error {
  constructor() {
    super("LLM call aborted");
    this.name = "GatewayAbortedError";
  }
}

/** §4: AdapterErrorCode → 종결 ErrorCode. */
function mapTerminal(code: AdapterErrorCode): ErrorCode {
  switch (code) {
    case "RATE_LIMIT":
      return "LLM_RATE_LIMITED";
    case "BACKEND_ERROR":
      return "LLM_BACKEND_UNAVAILABLE";
    case "STREAM_IDLE_TIMEOUT":
      return "LLM_STREAM_IDLE_TIMEOUT";
    case "STREAM_TIMEOUT":
      return "LLM_STREAM_TIMEOUT";
    case "BUDGET_EXCEEDED":
      return "LLM_BUDGET_EXCEEDED";
    case "MALFORMED_OUTPUT":
      return "LLM_MALFORMED_OUTPUT";
    case "CONTENT_FILTERED":
      return "LLM_CONTENT_FILTERED";
    case "CONNECTION_FAILED":
      return "LLM_CONNECTION_FAILED";
  }
}

type ConsumeResult =
  | { kind: "ok"; text: string; usage?: Usage; finishReason: FinishReason }
  | { kind: "error"; code: AdapterErrorCode; retryable: boolean }
  | { kind: "aborted" };

export class LlmGateway {
  constructor(private readonly deps: LlmGatewayDeps) {}

  async call(req: LLMRequest, signal: AbortSignal): Promise<LLMResponse> {
    const decision = this.deps.gate.evaluate({
      primitive: req.metadata.primitive,
      responseFormat: req.responseFormat,
      images: req.images,
      capabilities: this.deps.primary.capabilities(),
    });
    if (decision.kind === "deny") {
      throw new GatewayError(decision.code, decision.reason);
    }

    const idem = this.deps.idempotency;
    let callId: string | undefined;
    if (idem) {
      const reservation = await idem.reserve(req);
      if (reservation.kind === "replay") return reservation.response; // side effect 재실행 금지(§ store)
      if (reservation.kind === "reserved") callId = reservation.callId;
      else {
        // TODO: [BLOCKED]
        //   violated: 가정 금지(전용 ErrorCode 부재)
        //   reason: in_flight(동시 호출)·blocked(request_hash_mismatch)는 전용 카탈로그 코드가 없다
        //           (security-middleware-contract 주석: "until a dedicated catalog code exists").
        //   required_change: gateway conflict 정책 코드 신설 후 매핑. 현재는 명시적 throw(조용한 진행 금지).
        throw new GatewayError(
          "CONTROL_PLANE_INTERNAL_ERROR",
          `idempotency reservation '${reservation.kind}' has no dedicated gateway policy yet`,
        );
      }
    }

    try {
      const consumed = await this.runWithRetryAndFallback(req, decision.transport, signal);
      const response = await this.finalize(req, consumed, decision.transport, signal);
      if (idem && callId) await idem.complete(callId, response);
      return response;
    } catch (e) {
      if (idem && callId && e instanceof GatewayError) {
        await idem.fail(callId, e.adapterCode ?? "BACKEND_ERROR");
      }
      throw e;
    }
  }

  private async runWithRetryAndFallback(
    req: LLMRequest,
    transport: Transport,
    signal: AbortSignal,
  ): Promise<ConsumeResult & { kind: "ok" }> {
    const chain: Array<{ adapter: LLMBackendAdapter; tries: number }> = [
      { adapter: this.deps.primary, tries: this.deps.config.retryMax + 1 },
      ...(this.deps.fallback ? [{ adapter: this.deps.fallback, tries: this.deps.config.fallbackAttempts }] : []),
    ];

    let last: { code: AdapterErrorCode } | undefined;
    for (const link of chain) {
      for (let t = 0; t < link.tries; t += 1) {
        const r = await this.consumeOnce(link.adapter, req, transport, signal);
        if (r.kind === "ok") return r;
        if (r.kind === "aborted") throw new GatewayAbortedError();
        last = { code: r.code };
        // 비재시도(STREAM_TIMEOUT/BUDGET_EXCEEDED/CONTENT_FILTERED 등) → 즉시 종결(재시도·fallback 안 함, §4).
        if (!r.retryable) throw new GatewayError(mapTerminal(r.code), `terminal ${r.code}`, r.code);
        // 재시도 가능 → 동일 adapter 재시도, tries 소진 시 다음 link(fallback).
      }
    }
    const code = last?.code ?? "BACKEND_ERROR";
    throw new GatewayError(mapTerminal(code), "retries and fallback exhausted", code);
  }

  private async consumeOnce(
    adapter: LLMBackendAdapter,
    req: LLMRequest,
    transport: Transport,
    signal: AbortSignal,
  ): Promise<ConsumeResult> {
    if (transport === "sync") {
      if (!adapter.syncCall) return { kind: "error", code: "BACKEND_ERROR", retryable: false };
      try {
        const r = await adapter.syncCall(req);
        return { kind: "ok", text: "", usage: r.usage, finishReason: r.finishReason };
      } catch {
        return { kind: "error", code: "CONNECTION_FAILED", retryable: true };
      }
    }

    let text = "";
    let usage: Usage | undefined;
    let finishReason: FinishReason = "stop";
    for await (const ev of adapter.streamCall(req, signal)) {
      if (ev.type === "text_delta") text += ev.text;
      else if (ev.type === "json_delta") text += ev.partial;
      else if (ev.type === "usage")
        usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cost: ev.cost, estimated: ev.estimated };
      else if (ev.type === "done") return { kind: "ok", text, usage, finishReason: ev.finishReason };
      else if (ev.type === "error") return { kind: "error", code: ev.code, retryable: ev.retryable };
      else if (ev.type === "aborted") return { kind: "aborted" };
    }
    // done 없이 종료 — 누적분 마감.
    return { kind: "ok", text, usage, finishReason };
  }

  private async finalize(
    req: LLMRequest,
    consumed: ConsumeResult & { kind: "ok" },
    transport: Transport,
    signal: AbortSignal,
  ): Promise<LLMResponse> {
    const usage: Usage = consumed.usage ?? { inputTokens: 0, outputTokens: 0, cost: 0, estimated: true };
    const meta = req.metadata;

    if (!req.responseFormat) {
      const outputRef = await this.deps.sink.put(consumed.text, meta);
      return { outputRef, usage, finishReason: consumed.finishReason };
    }

    // §5: 누적 텍스트 parse → schema 검증 → strict fail / repair 1회.
    const rf = req.responseFormat;
    let text = consumed.text;
    for (let repair = 0; ; repair += 1) {
      const parsed = this.tryParse(text);
      if (parsed.ok) {
        const v = this.deps.validator.validate({ schemaRef: rf.schemaRef, schemaVersion: rf.schemaVersion, value: parsed.value });
        if (v.ok) {
          const outputRef = await this.deps.sink.put(text, meta);
          return { outputRef, usage, finishReason: consumed.finishReason, parsedJson: parsed.value };
        }
        if (rf.strict || repair >= this.deps.config.repairAttempts) throw this.structuredFail(req, v.reason);
        text = (await this.repairOnce(req, text, v.reason, transport, signal)).text;
        continue;
      }
      // JSON parse 실패
      if (rf.strict || repair >= this.deps.config.repairAttempts) throw this.structuredFail(req, "output is not valid JSON");
      text = (await this.repairOnce(req, text, "output is not valid JSON", transport, signal)).text;
    }
  }

  private tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: false };
    }
  }

  /** §4/§5: strict 또는 repair 소진 시 종결. extract 는 Business EXTRACT_SCHEMA_INVALID, 그 외 LLM_MALFORMED_OUTPUT. */
  private structuredFail(req: LLMRequest, reason: string): GatewayError {
    const code: ErrorCode = req.metadata.primitive === "extract" ? "EXTRACT_SCHEMA_INVALID" : "LLM_MALFORMED_OUTPUT";
    return new GatewayError(code, `structured output invalid: ${reason}`, "MALFORMED_OUTPUT");
  }

  /** repair: 원 출력+오류를 user 로 다시 실어 1회 재호출(§5). */
  private async repairOnce(
    req: LLMRequest,
    priorText: string,
    reason: string,
    transport: Transport,
    signal: AbortSignal,
  ): Promise<ConsumeResult & { kind: "ok" }> {
    const repairReq: LLMRequest = {
      ...req,
      messages: [
        ...req.messages,
        // repair 지시는 Gateway 생성 신뢰 텍스트(페이지 컨텍스트 아님). 메시지는 이미 redaction 통과 상태.
        {
          role: "user",
          content: `Previous output was invalid (${reason}). Return only corrected JSON.\n${priorText}`,
        } as unknown as LLMRequest["messages"][number],
      ],
    };
    const r = await this.consumeOnce(this.deps.primary, repairReq, transport, signal);
    if (r.kind === "ok") return r;
    if (r.kind === "aborted") throw new GatewayAbortedError();
    throw new GatewayError(mapTerminal(r.code), `repair failed: ${r.code}`, r.code);
  }
}
