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
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { ArtifactRef } from "../../../ts/core-types";
import type { ErrorCode } from "../../../ts/error-catalog";
import { SPAN, recordLlmCost, recordLlmTtfbMs, withSpan, type CommonSpanAttrs } from "../observability/telemetry";
import type {
  AdapterErrorCode,
  CapabilityGate,
  CorrelationId,
  DurableSecurityAuditDecisionWriter,
  GatewayRedactionBoundary,
  IdempotencyKey,
  IsoDateTime,
  LLMBackendAdapter,
  LLMCallIdempotencyStore,
  LLMRequest,
  LLMResponse,
  PrincipalId,
  Role,
} from "../../../ts/security-middleware-contract";
import { SECURITY_AUDIT_PAYLOAD_SCHEMA_REF } from "../../../ts/security-middleware-contract";

type Transport = "sse" | "sync";
type Usage = LLMResponse["usage"];
type FinishReason = LLMResponse["finishReason"];
const PROMPT_INSPECT_AUDIT_RETENTION_DAYS = 90;

/** §5 structured output 검증 포트(ajv 등 실제 검증기 주입 — 재구현 금지). */
export interface StructuredOutputValidator {
  validate(input: { schemaRef: string; schemaVersion: string; schema?: unknown; value: unknown }):
    | { ok: true }
    | { ok: false; reason: string };
}

/** 누적 출력 저장 포트 → outputRef(§6 artifact). */
export interface GatewayArtifactSink {
  put(content: string, meta: Pick<LLMRequest["metadata"], "tenantId" | "runId" | "stepId" | "attempt">): Promise<ArtifactRef>;
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
  securityAudit: DurableSecurityAuditDecisionWriter;
  /** security-contracts §4 step2(차단 지점, Gateway 소유): adapter 호출 전 user 메시지 redaction + §3 injection 탐지. */
  redactionBoundary: GatewayRedactionBoundary;
  config: LlmGatewayConfig;
}

/** 카탈로그 ErrorCode 로 분류된 Gateway 종결 실패. */
export class GatewayError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    /** 원 AdapterErrorCode(멱등 store.fail 기록용). */
    readonly adapterCode?: AdapterErrorCode,
    readonly stagehandCallId?: string,
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
  | { kind: "ok"; text: string; usage?: Usage; finishReason: FinishReason; ttfbMs?: number }
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
      else if (reservation.kind === "in_flight") {
        throw new GatewayError("WORKITEM_CHECKOUT_CONFLICT", `idempotency call '${reservation.callId}' is still in flight`);
      } else {
        throw new GatewayError("SCENARIO_VERSION_CONFLICT", `idempotency blocked: ${reservation.reason}`);
      }
    }

    // §E 필수 span: llm_gateway.call(attr primitive/model/transport/stream_status/ttfb_ms). 멱등 replay는
    //   위에서 단락되므로 실제 호출 경로만 계측한다(replay는 실 LLM 호출이 아님). 예외는 withSpan이
    //   record + ERROR status로 표면화(조용한 흡수 금지) 후 재던지며, 바깥 catch가 멱등 fail을 기록한다.
    const meta = req.metadata;
    const common: CommonSpanAttrs = { tenant_id: meta.tenantId, run_id: meta.runId, correlation_id: meta.correlationId };
    try {
      return await withSpan(
        SPAN.llmGatewayCall,
        common,
        { primitive: meta.primitive, model: req.model, transport: decision.transport },
        async (span) => {
          // §7 jsonMode=false safe-path: native json_schema 미지원 모델엔 structured-output 스키마를 prompt 로 지시(어댑터는
          //   텍스트 스트림만). responseFormat.schema(인라인 body) → system 메시지. 그 후 §4 step2 user 메시지 redaction.
          const redactedReq = await this.redactRequest(this.withPromptSchema(req));
          const consumed = await this.runWithRetryAndFallback(redactedReq, decision.transport, signal);
          span.setAttributes({ stream_status: consumed.finishReason, ttfb_ms: consumed.ttfbMs ?? 0 });
          const finalized = await this.finalize(redactedReq, consumed, decision.transport, signal);
          const response: LLMResponse = callId !== undefined ? { ...finalized, stagehandCallId: callId } : finalized;
          // §E 필수 메트릭: llm_cost(usage.cost 누적) + llm_ttfb_ms(첫 토큰 지연). 저카디널리티 attr(tenant/model).
          recordLlmCost(response.usage.cost, { tenant_id: meta.tenantId, model: req.model });
          recordLlmTtfbMs(consumed.ttfbMs ?? 0, { tenant_id: meta.tenantId, model: req.model });
          if (idem && callId) await idem.complete(callId, response);
          return response;
        },
      );
    } catch (e) {
      if (idem && callId && e instanceof GatewayError) {
        await idem.fail(callId, e.adapterCode ?? "BACKEND_ERROR");
        if (e.stagehandCallId === undefined) {
          throw new GatewayError(e.code, e.message, e.adapterCode, callId);
        }
      }
      throw e;
    }
  }

  /**
   * §7 jsonMode=false safe-path(llm-gateway-adapter.md:139 "미지원 시 prompt 내 스키마 지시"): primary 가 native
   * json_schema 미지원(jsonMode=false)이고 responseFormat.schema(인라인 body) 가 있으면, 그 스키마를 **system 메시지**
   * (Gateway 생성 신뢰 텍스트 — redactRequest 통과)에 지시로 추가한다. jsonMode=true 면 native 경로라 미주입.
   * 스키마 부재(또는 jsonMode=true)는 req 불변 — 기존 호출 무영향. 검증(strict/repair)은 finalize §5 소관(불변).
   */
  private withPromptSchema(req: LLMRequest): LLMRequest {
    const schema = req.responseFormat?.schema;
    if (schema === undefined || this.deps.primary.capabilities().jsonMode) return req;
    const instruction = `Respond with ONLY a single JSON value strictly conforming to this JSON Schema. No prose, no markdown, no code fences. JSON Schema: ${JSON.stringify(schema)}`;
    // 첫 system 메시지에 append(system-first 유지). system 부재 시 맨 앞 삽입(방어). user 메시지는 미접촉(redaction 대상).
    let injected = false;
    const messages = req.messages.map((m) => {
      if (!injected && m.role === "system" && typeof m.content === "string") {
        injected = true;
        return { ...m, content: `${m.content}\n${instruction}` };
      }
      return m;
    });
    if (!injected) messages.unshift({ role: "system", content: instruction });
    return { ...req, messages };
  }

  /**
   * security-contracts §4 step2(차단 지점, Gateway 소유): user 메시지(페이지 파생·비신뢰)를 redaction 경계로
   * 통과시켜 비밀/PII 마스킹 + §3 prompt-injection 탐지. injection이면 `PROMPT_INJECTION_DETECTED`로 차단
   * (조용한 통과 금지 — adapter는 마스킹된 참조만 수신, §4 step3). system 메시지는 Gateway 생성 신뢰 텍스트라 통과.
   */
  private async redactRequest(req: LLMRequest): Promise<LLMRequest> {
    const out: LLMRequest["messages"][number][] = [];
    for (const m of req.messages) {
      if (m.role !== "user") {
        out.push(m);
        continue;
      }
      const result = await this.deps.redactionBoundary.redactForGateway({
        tenantId: req.metadata.tenantId,
        runId: req.metadata.runId,
        rawTextOrObject: m.content,
        textRuns: req.promptInspection?.textRuns,
      });
      await this.recordPromptInspectDecision(req, result, { phase: "initial", messageIndex: out.length });
      if (result.kind === "blocked") {
        const signals = result.evidence.map((e) => e.signal).join(",");
        throw new GatewayError(result.code, `prompt injection blocked at gateway (${signals})`);
      }
      out.push({ role: "user", content: result.content });
    }
    const { promptInspection: _promptInspection, ...adapterRequest } = req;
    return { ...adapterRequest, messages: out };
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
    // §E llm_gateway.call ttfb_ms — 첫 스트림 이벤트까지의 wall-clock(모노토닉). IREL 결정론 영역이 아닌
    //   관측 계측이므로 perf_hooks 사용은 허용(now() 금지는 IREL evaluator 한정).
    let ttfbMs: number | undefined;
    const startedAt = performance.now();
    for await (const ev of adapter.streamCall(req, signal)) {
      if (ttfbMs === undefined) ttfbMs = performance.now() - startedAt;
      if (ev.type === "text_delta") text += ev.text;
      else if (ev.type === "json_delta") text += ev.partial;
      else if (ev.type === "usage")
        usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cost: ev.cost, estimated: ev.estimated };
      else if (ev.type === "done") return { kind: "ok", text, usage, finishReason: ev.finishReason, ttfbMs };
      else if (ev.type === "error") return { kind: "error", code: ev.code, retryable: ev.retryable };
      else if (ev.type === "aborted") return { kind: "aborted" };
    }
    // done 없이 종료 — 누적분 마감.
    return { kind: "ok", text, usage, finishReason, ttfbMs };
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
        // action_plan(act primitive)은 inline JSON Schema 없이 다운스트림 parseActionPlan(실행기)이 검증한다 — §5 ajv
        //   검증은 extract 출력 스키마용(llm-gateway-adapter §5). gateway 가 extract-스키마 검증을 schema-없는 action_plan
        //   에 잘못 적용해 valid plan 을 LLM_MALFORMED_OUTPUT 으로 거부하던 결함(LLM-plan act 전면 불능) 수정 — JSON
        //   parse 성공만 강제하고 parsedJson 반환(extract 는 inline schema 동반이라 아래 ajv 경로 유지; no-schema extract 는 fail-closed).
        if (rf.schemaRef === "action_plan" && rf.schema === undefined) {
          const outputRef = await this.deps.sink.put(text, meta);
          return { outputRef, usage, finishReason: consumed.finishReason, parsedJson: parsed.value };
        }
        const v = this.deps.validator.validate({ schemaRef: rf.schemaRef, schemaVersion: rf.schemaVersion, schema: rf.schema, value: parsed.value });
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
    // RQ-029/§4 step2: repair user 메시지는 prior LLM 출력(priorText=비신뢰; 페이지 컨텍스트가 모델을 거쳐 echo될
    //   수 있음)을 담으므로, adapter 전 **반드시** redaction/injection 경계를 통과해야 한다. call() 정상 경로의
    //   redactRequest와 동일 불변(모든 user 메시지는 step2 통과). 원 req.messages는 이미 redaction 통과 상태
    //   (call→redactRequest→finalize(redactedReq))이므로 이중 처리(RedactedContentBlock[] 재-stringify로 mangle)를
    //   피해 **신규 repair 메시지만** 통과시킨다. injection이면 PROMPT_INJECTION_DETECTED로 fail-closed.
    const redacted = await this.deps.redactionBoundary.redactForGateway({
      tenantId: req.metadata.tenantId,
      runId: req.metadata.runId,
      rawTextOrObject: `Previous output was invalid (${reason}). Return only corrected JSON.\n${priorText}`,
    });
    await this.recordPromptInspectDecision(req, redacted, { phase: "repair", messageIndex: req.messages.length });
    if (redacted.kind === "blocked") {
      const signals = redacted.evidence.map((e) => e.signal).join(",");
      throw new GatewayError(redacted.code, `prompt injection blocked at gateway repair (${signals})`);
    }
    const repairReq: LLMRequest = {
      ...req,
      messages: [...req.messages, { role: "user", content: redacted.content } as LLMRequest["messages"][number]],
    };
    const r = await this.consumeOnce(this.deps.primary, repairReq, transport, signal);
    if (r.kind === "ok") return r;
    if (r.kind === "aborted") throw new GatewayAbortedError();
    throw new GatewayError(mapTerminal(r.code), `repair failed: ${r.code}`, r.code);
  }

  private async recordPromptInspectDecision(
    req: LLMRequest,
    result: Awaited<ReturnType<GatewayRedactionBoundary["redactForGateway"]>>,
    input: { phase: "initial" | "repair"; messageIndex: number },
  ): Promise<void> {
    const occurredAt = new Date();
    const actor = req.metadata.auditActor ?? runtimePromptInspectActor();
    const outcome = result.kind === "blocked" ? "blocked" : "allow";
    try {
      await this.deps.securityAudit.recordDecision(
        {
          tenantId: req.metadata.tenantId,
          actor,
          action: "prompt.inspect",
          outcome,
          resource: { kind: "run", id: req.metadata.runId },
          reason: result.kind === "blocked" ? "prompt_injection_detected" : "prompt_inspection_clean",
          correlationId: req.metadata.correlationId as CorrelationId,
          idempotencyKey: randomUUID() as IdempotencyKey,
          occurredAt: occurredAt.toISOString() as IsoDateTime,
          retentionUntil: new Date(
            occurredAt.getTime() + PROMPT_INSPECT_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
          ).toISOString() as IsoDateTime,
          payloadSchemaRef: SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
          failClosed: true,
          payload: {
            decision_kind: "prompt.inspect",
            phase: input.phase,
            message_index: input.messageIndex,
            primitive: req.metadata.primitive,
            step_id: req.metadata.stepId,
            attempt: req.metadata.attempt,
            prompt_template_version: req.promptTemplateVersion,
            model: req.model,
            evidence_signals: result.kind === "blocked" ? result.evidence.map((e) => e.signal) : [],
          },
        },
        { prompt_inspection: outcome, phase: input.phase },
      );
    } catch {
      throw new GatewayError("CONTROL_PLANE_INTERNAL_ERROR", "prompt inspect audit append failed closed");
    }
  }
}

function runtimePromptInspectActor(): { subjectId: PrincipalId; roles: readonly Role[] } {
  return { subjectId: "runtime-worker" as PrincipalId, roles: ["operator"] };
}
