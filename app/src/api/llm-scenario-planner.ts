/**
 * LLM-backed natural-language scenario planner.
 *
 * This module does not bypass the contract compiler. The model may draft IR, but
 * scenario-generations.ts still runs compileScenario and the bounded repair loop
 * before any scenario/run is saved.
 */
import { createHash } from "node:crypto";

import type { ArtifactRef } from "../../../ts/core-types";
import type {
  CanonicalRequestHash,
  LLMCallIdempotencyKey,
  LLMRequest,
  LLMResponse,
  RunId,
  StepId,
  TenantId,
  CorrelationId,
} from "../../../ts/security-middleware-contract";
import { ApiResponseError } from "./errors";
import { GatewayError } from "../gateway/llm-gateway";
import type {
  GenerationCapabilities,
  GenerationPlan,
  GenerationRequest,
  ScenarioPlanner,
  ScenarioPlannerContext,
  ScenarioPlannerRepairInput,
} from "./scenario-generation-types";

export interface ScenarioPlannerGateway {
  call(req: LLMRequest, signal: AbortSignal): Promise<LLMResponse>;
}

export interface LlmScenarioPlannerClient {
  complete(input: LlmScenarioPlannerCallInput): Promise<unknown>;
}

export interface LlmScenarioPlannerCallInput {
  readonly kind: "plan" | "repair";
  readonly request: GenerationRequest;
  readonly capabilities: GenerationCapabilities;
  readonly context: ScenarioPlannerContext;
  readonly systemPrompt: string;
  readonly userPayload: Record<string, unknown>;
  readonly attempt: number;
}

export interface LlmGatewayScenarioPlannerClientConfig {
  readonly model: string;
  readonly promptTemplateVersion: string;
  readonly budget: LLMRequest["budget"];
}

const SCENARIO_PLANNER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["draft_ir"],
  properties: {
    draft_ir: {
      type: "object",
      additionalProperties: true,
    },
    blockers: {
      type: "array",
      items: { type: "string", minLength: 1 },
      default: [],
    },
    params: {
      type: "object",
      additionalProperties: true,
      default: {},
    },
  },
} as const;

const SYSTEM_PROMPT = [
  "You are the RPA scenario planner for a contract-first enterprise automation platform.",
  "Return only JSON that matches the provided schema.",
  "Create a conservative, read-only IR draft unless the user explicitly provides enough approved target context.",
  "Do not invent secrets, credentials, selectors, records, or execution results.",
  "When a request is unsafe or underspecified, still return contract-shaped IR and add a machine-readable blocker.",
  "The server will compile and validate your IR before saving or running it.",
].join("\n");

export function createLlmScenarioPlanner(client: LlmScenarioPlannerClient): ScenarioPlanner {
  return new LlmScenarioPlanner(client);
}

export class LlmScenarioPlanner implements ScenarioPlanner {
  readonly id = "llm_v1" as const;

  constructor(private readonly client: LlmScenarioPlannerClient) {}

  async plan(
    request: GenerationRequest,
    capabilities: GenerationCapabilities,
    context: ScenarioPlannerContext,
  ): Promise<GenerationPlan> {
    const output = await this.client.complete({
      kind: "plan",
      request,
      capabilities,
      context,
      systemPrompt: SYSTEM_PROMPT,
      userPayload: {
        task: "draft_scenario_ir",
        request: publicRequestPayload(request),
        capabilities,
      },
      attempt: 0,
    });
    return planFromLlmOutput(request, output);
  }

  async repair(input: ScenarioPlannerRepairInput): Promise<GenerationPlan> {
    const output = await this.client.complete({
      kind: "repair",
      request: input.request,
      capabilities: input.capabilities,
      context: input.context,
      systemPrompt: SYSTEM_PROMPT,
      userPayload: {
        task: "repair_scenario_ir",
        request: publicRequestPayload(input.request),
        capabilities: input.capabilities,
        failed_plan: {
          draft_ir: input.failedPlan.draftIr,
          blockers: input.failedPlan.blockers,
        },
        compile_error: input.compileError,
      },
      attempt: input.attempt,
    });
    return planFromLlmOutput(input.request, output);
  }
}

export class LlmGatewayScenarioPlannerClient implements LlmScenarioPlannerClient {
  constructor(
    private readonly gateway: ScenarioPlannerGateway,
    private readonly cfg: LlmGatewayScenarioPlannerClientConfig,
  ) {}

  async complete(input: LlmScenarioPlannerCallInput): Promise<unknown> {
    const requestHash = hashJson({
      kind: input.kind,
      attempt: input.attempt,
      prompt: input.request.prompt,
      name: input.request.name,
      mode: input.request.mode,
      startUrl: input.request.startUrl,
      target: input.request.target,
      params: input.request.params,
      model: input.request.model,
      evidence: input.request.evidence,
      payload: input.userPayload,
    });
    const stepId = `scenario_generation_${input.kind}` as StepId;
    const req: LLMRequest = {
      model: input.request.model ?? this.cfg.model,
      promptTemplateVersion: this.cfg.promptTemplateVersion,
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: JSON.stringify(input.userPayload) },
      ],
      responseFormat: {
        type: "json_schema",
        schemaRef: "scenario-generation/planner-output@1",
        schemaVersion: "1",
        strict: false,
        schema: SCENARIO_PLANNER_OUTPUT_SCHEMA as Record<string, unknown>,
      },
      metadata: {
        tenantId: input.context.tenantId as TenantId,
        runId: input.context.generationId as RunId,
        stepId,
        attempt: input.attempt,
        primitive: "extract",
        correlationId: input.context.correlationId as CorrelationId,
      },
      budget: this.cfg.budget,
      idempotencyKey: `scenario-generation:${input.context.generationId}:${input.kind}:${input.attempt}:${requestHash.slice(0, 16)}` as LLMCallIdempotencyKey,
      requestHash: requestHash as CanonicalRequestHash,
    } as unknown as LLMRequest;

    let response: LLMResponse;
    try {
      response = await this.gateway.call(req, new AbortController().signal);
    } catch (err) {
      if (err instanceof GatewayError) {
        const code = err.code === "DEAD_LETTER" ? "CONTROL_PLANE_INTERNAL_ERROR" : err.code;
        throw new ApiResponseError(code, {
          reason: "llm_planner_gateway_failed",
          stagehand_call_id: err.stagehandCallId,
        });
      }
      throw err;
    }
    if (response.parsedJson === undefined) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", {
        reason: "llm_planner_missing_structured_output",
        output_ref: response.outputRef as ArtifactRef,
      });
    }
    return response.parsedJson;
  }
}

function planFromLlmOutput(request: GenerationRequest, output: unknown): GenerationPlan {
  if (!isRecord(output)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "llm_planner_output_object_required" });
  }
  const draftIr = output.draft_ir;
  if (!isRecord(draftIr)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "llm_planner_draft_ir_required" });
  }
  const blockers = parseBlockers(output.blockers);
  const params = parseParams(output.params);
  const promptHash = createHash("sha256").update(request.prompt).digest("hex");
  return {
    planner: "llm_v1",
    request: {
      ...request,
      params: { ...request.params, ...params },
    },
    promptHash,
    draftIr,
    blockers,
  };
}

function parseBlockers(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "llm_planner_invalid_blockers" });
  }
  return value.map((item) => item.trim());
}

function parseParams(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "llm_planner_invalid_params" });
  }
  return value;
}

function publicRequestPayload(request: GenerationRequest): Record<string, unknown> {
  return {
    prompt: request.prompt,
    name: request.name,
    mode: request.mode,
    planner: request.planner,
    start_url: request.startUrl,
    target: request.target,
    params: request.params,
    model: request.model,
    evidence: request.evidence,
  };
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortValue(value[key]);
    }
    return out;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
