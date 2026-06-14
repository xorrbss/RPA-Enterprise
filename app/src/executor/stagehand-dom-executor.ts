/**
 * StagehandDomExecutor — dom 실행기(act/observe/extract) ↔ LLM Gateway 연결 (D3 LLM 절반 / architecture §9.1 step2).
 *
 * 계약(llm-gateway-adapter.md §1): **Executor 는 Gateway 만 호출하고 adapter 를 직접 모른다.** 따라서 dom
 * 프리미티브는 Stagehand 의 내장 LLM 을 직접 쓰지 않고, PageState 컨텍스트로 `LLMRequest` 를 만들어
 * `LlmGateway.call` 로 보낸 뒤 `LLMResponse` 를 `StepResult` 로 매핑한다. (브라우저 동작 적용은 UtilityExecutor/CDP —
 * act 의 실제 mutation 적용·풍부한 observe 스냅샷·원문 redaction(§4)은 후속 통합.)
 *
 * capability = {dom:true, vision:false, utility:false}. utility/비브라우저 액션은 본 실행기 소관이 아니므로
 * 명시적 throw(조용한 no-op 금지). Gateway 종결 실패(GatewayError)는 error-catalog exceptionClass 로 분류해
 * 실패 StepResult 로 환원한다(조용한 흡수 금지 — 분류는 보존).
 */
import { createHash } from "node:crypto";

import { ERROR_CATALOG, type ErrorCode } from "../../../ts/error-catalog";
import type {
  ExecutorPlugin,
  RunContext,
  StepResult,
  StepStatus,
  VerifyResult,
  ExceptionClass,
} from "../../../ts/core-types";
import type { LLMRequest, LLMResponse } from "../../../ts/security-middleware-contract";
import { GatewayError } from "../gateway/llm-gateway";
import { pageStateRef } from "./page-state-resolver";

/** Gateway 호출 경계(LlmGateway 가 구조적으로 충족). Executor 는 adapter 가 아니라 이 포트만 본다. */
export interface LlmGatewayCaller {
  call(req: LLMRequest, signal: AbortSignal): Promise<LLMResponse>;
}

/** dom 실행기가 지원하는 LLM 프리미티브 액션(IRActionType 의 dom 부분집합). */
export type DomAction =
  | { type: "act"; instruction: string }
  | { type: "observe"; instruction: string }
  | { type: "extract"; instruction: string; output: { schemaRef: string; schemaVersion: string; strict: boolean } };

export type DomExecutorErrorCode = "EXECUTOR_CAPABILITY_MISMATCH" | "IR_SCHEMA_INVALID" | "RUN_ABORTED";

export class StagehandDomExecutorError extends Error {
  constructor(
    readonly code: DomExecutorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StagehandDomExecutorError";
  }
}

export interface StagehandDomExecutorConfig {
  model: string;
  promptTemplateVersion: string;
  budget: LLMRequest["budget"];
}

const UTILITY_ACTIONS = new Set(["navigate", "download", "upload", "api_call", "file", "shell"]);
const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 32);
const nowIso = (): string => new Date().toISOString();

/** error-catalog exceptionClass → StepStatus + StepResult.exception.class(4종 고정; none→system). */
function classify(code: ErrorCode): { status: StepStatus; cls: ExceptionClass } {
  switch (ERROR_CATALOG[code].exceptionClass) {
    case "business":
      return { status: "failed_business", cls: "business" };
    case "challenge":
      return { status: "failed_challenge", cls: "challenge" };
    case "security":
      return { status: "failed_security", cls: "security" };
    default: // system | none → system
      return { status: "failed_system", cls: "system" };
  }
}

export class StagehandDomExecutor implements ExecutorPlugin {
  constructor(
    private readonly gateway: LlmGatewayCaller,
    private readonly cfg: StagehandDomExecutorConfig,
  ) {}

  capabilities(): { dom: boolean; vision: boolean; utility: boolean } {
    return { dom: true, vision: false, utility: false };
  }

  async execute(stepId: string, action: unknown, ctx: RunContext): Promise<StepResult> {
    if (ctx.abortSignal.aborted) {
      throw new StagehandDomExecutorError("RUN_ABORTED", `step '${stepId}' aborted before execute`);
    }
    const a = this.assertDomAction(stepId, action);
    const before = pageStateRef(ctx.pageState);
    const startedAt = nowIso();
    const req = this.buildRequest(stepId, a, ctx);

    let res: LLMResponse;
    try {
      res = await this.gateway.call(req, ctx.abortSignal);
    } catch (e) {
      if (e instanceof GatewayError) {
        // 종결 실패를 분류해 실패 StepResult 로 환원(조용한 흡수 금지 — code/class 보존).
        const { status, cls } = classify(e.code);
        const endedAt = nowIso();
        return {
          stepId,
          action: a.type,
          status,
          pageStateBefore: before,
          pageStateAfter: before,
          artifacts: [],
          stagehandCallIds: [String(req.idempotencyKey)],
          cache: { mode: "bypass" },
          exception: { class: cls, code: e.code, message: e.message as never },
          timings: { startedAt, endedAt, durationMs: Date.parse(endedAt) - Date.parse(startedAt) },
        };
      }
      throw e; // GatewayAbortedError 등 제어 신호는 전파(run 단위 취소가 처리).
    }

    const endedAt = nowIso();
    return {
      stepId,
      action: a.type,
      status: "success",
      output: { outputRef: res.outputRef, finishReason: res.finishReason },
      extracted: a.type === "extract" ? res.parsedJson : undefined,
      pageStateBefore: before,
      // PageState 재산출은 PageStateResolver 소관 — 다음 observe 노드가 갱신(UtilityExecutor 와 동일 패턴).
      pageStateAfter: before,
      artifacts: [res.outputRef],
      stagehandCallIds: [String(req.idempotencyKey)],
      cache: { mode: "bypass" }, // ActionPlanCache(act 재생) 연동은 후속.
      // observe/extract 는 read_only. act 의 실제 mutation 적용(클릭/타이핑)은 action 적용 단계(후속).
      sideEffect: { kind: "read_only", committed: true },
      timings: { startedAt, endedAt, durationMs: Date.parse(endedAt) - Date.parse(startedAt) },
    };
  }

  async verify(_criteria: unknown, _ctx: RunContext): Promise<VerifyResult> {
    // VLM/스크린샷 기반 verify 는 VisionExecutor(vision capability) 소관 — dom 실행기는 비대상(조용히 통과 금지).
    throw new StagehandDomExecutorError(
      "EXECUTOR_CAPABILITY_MISMATCH",
      "VLM verify requires the vision executor, not the dom executor",
    );
  }

  private buildRequest(stepId: string, a: DomAction, ctx: RunContext): LLMRequest {
    const ps = ctx.pageState;
    // 페이지 컨텍스트는 user 역할로만(신뢰영역 분리, §2). 본 골격은 PageState 파생 신호(비민감)만 싣는다 —
    // 원문 DOM/텍스트 + Gateway redaction(§4) 통합은 후속.
    const context = JSON.stringify({
      url: ps.url.pattern,
      auth: ps.auth,
      structuralHash: ps.dom.structuralHash,
      landmarks: ps.dom.landmarks,
      flags: ps.flags,
    });
    const key = sha(
      `${ctx.tenantId}|${ctx.runId}|${stepId}|${a.type}|${this.cfg.promptTemplateVersion}|${a.instruction}|${ps.dom.structuralHash}`,
    );

    return {
      model: this.cfg.model,
      promptTemplateVersion: this.cfg.promptTemplateVersion,
      messages: [
        { role: "system", content: `Deterministic web automation ${a.type} planner.` },
        { role: "user", content: `${a.instruction}\n[page]${context}` },
      ],
      ...(a.type === "extract"
        ? { responseFormat: { type: "json_schema", schemaRef: a.output.schemaRef, schemaVersion: a.output.schemaVersion, strict: a.output.strict } }
        : {}),
      metadata: { tenantId: ctx.tenantId, runId: ctx.runId, stepId, primitive: a.type, correlationId: ctx.runId },
      budget: this.cfg.budget,
      idempotencyKey: key,
      requestHash: key,
    } as unknown as LLMRequest;
  }

  private assertDomAction(stepId: string, action: unknown): DomAction {
    if (typeof action !== "object" || action === null || !("type" in action)) {
      throw new StagehandDomExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' action missing 'type'`);
    }
    const type = (action as { type: unknown }).type;
    if (typeof type === "string" && UTILITY_ACTIONS.has(type)) {
      throw new StagehandDomExecutorError(
        "EXECUTOR_CAPABILITY_MISMATCH",
        `step '${stepId}' action '${type}' is utility/non-browser — not a dom primitive`,
      );
    }
    if (type !== "act" && type !== "observe" && type !== "extract") {
      throw new StagehandDomExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' unknown dom action '${String(type)}'`);
    }
    const instruction = (action as { instruction?: unknown }).instruction;
    if (typeof instruction !== "string" || instruction.trim().length === 0) {
      throw new StagehandDomExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' ${type}.instruction must be a non-empty string`);
    }
    if (type === "extract") {
      const out = (action as { output?: unknown }).output;
      if (typeof out !== "object" || out === null) {
        throw new StagehandDomExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' extract.output(schema) required`);
      }
      const o = out as { schemaRef?: unknown; schemaVersion?: unknown; strict?: unknown };
      if (typeof o.schemaRef !== "string" || typeof o.schemaVersion !== "string" || typeof o.strict !== "boolean") {
        throw new StagehandDomExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' extract.output must be {schemaRef,schemaVersion,strict}`);
      }
      return { type, instruction, output: { schemaRef: o.schemaRef, schemaVersion: o.schemaVersion, strict: o.strict } };
    }
    return { type, instruction };
  }
}
