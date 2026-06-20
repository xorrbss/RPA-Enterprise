/**
 * Unit coverage for the llm_v1 ScenarioPlanner adapter.
 *
 * 실행: npm --prefix app exec -- tsx app/test/llm-scenario-planner.unit.ts
 */
import type { LLMRequest, LLMResponse } from "../../ts/security-middleware-contract";
import type { CompileOutcome } from "../src/api/compile-pipeline";
import { ApiResponseError } from "../src/api/errors";
import {
  createLlmScenarioPlanner,
  LlmGatewayScenarioPlannerClient,
  type LlmScenarioPlannerCallInput,
  type ScenarioPlannerGateway,
} from "../src/api/llm-scenario-planner";
import { GatewayError } from "../src/gateway/llm-gateway";
import type { GenerationRequest, ScenarioPlannerContext } from "../src/api/scenario-generation-types";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function validIr(name = "llm-unit-generated"): Record<string, unknown> {
  return {
    meta: { name, version: 1, ir_version: "1.x", studio_mode: "easy" },
    params_schema: { type: "object", additionalProperties: true },
    start: "extract_results",
    nodes: {
      extract_results: {
        what: [
          {
            action: "extract",
            instruction: "Extract the requested records.",
            schema_ref: "generated/default_result@1",
            args: {
              schema_version: "1",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["summary", "rows"],
                properties: {
                  summary: { type: "string" },
                  rows: { type: "array", items: { type: "object", additionalProperties: true } },
                },
              },
            },
          },
        ],
        next: "done",
        side_effect: { kind: "read_only" },
        policy: { recording: "never" },
      },
      done: { terminal: "success" },
    },
  };
}

const request: GenerationRequest = {
  prompt: "Collect recent public notices from https://example.com/notices",
  name: "generated-by-llm-unit",
  mode: "save",
  planner: "llm_v1",
  startUrl: "https://example.com/notices",
  params: {},
  model: "planner-model",
  evidence: { screenshot: "failure", video: "never" },
};

const context: ScenarioPlannerContext = {
  tenantId: "00000000-0000-4000-8000-0000000000a1",
  correlationId: "00000000-0000-4000-8000-0000000000c1",
  generationId: "00000000-0000-4000-8000-0000000000d1",
};

async function caught(p: Promise<unknown>): Promise<ApiResponseError | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err instanceof ApiResponseError ? err : undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  {
    const calls: LlmScenarioPlannerCallInput[] = [];
    const planner = createLlmScenarioPlanner({
      async complete(input) {
        calls.push(input);
        return {
          draft_ir: validIr(),
          blockers: ["target_required_for_auto_run"],
        };
      },
    });
    const plan = await planner.plan(request, { videoRecording: false }, context);
    check("llm planner id is llm_v1", planner.id === "llm_v1");
    check("llm planner calls client once for plan", calls.length === 1 && calls[0]?.kind === "plan");
    check(
      "llm planner maps output into GenerationPlan",
      plan.planner === "llm_v1" &&
        plan.draftIr.start === "extract_results" &&
        plan.blockers.includes("target_required_for_auto_run") &&
        plan.request.params.start_url === "https://example.com/notices" &&
        /^[a-f0-9]{64}$/.test(plan.promptHash),
      JSON.stringify(plan),
    );
    check(
      "llm planner system prompt coaches extract/pagination/target conventions",
      calls[0]?.systemPrompt.includes("{ summary: string, rows: object[] }") &&
        calls[0].systemPrompt.includes("max_pages") &&
        calls[0].systemPrompt.includes("site_profile_id, browser_identity_id, network_policy_id"),
      calls[0]?.systemPrompt,
    );
  }

  {
    const planner = createLlmScenarioPlanner({
      async complete() {
        return { draft_ir: validIr(), blockers: [], params: { start_url: "https://evil.example/notices" } };
      },
    });
    const err = await caught(Promise.resolve(planner.plan(request, { videoRecording: false }, context)));
    check(
      "llm planner rejects model-returned runtime params",
      err?.code === "IR_SCHEMA_INVALID" &&
        isRecord(err.details) &&
        err.details.reason === "llm_planner_params_forbidden" &&
        Array.isArray(err.details.fields) &&
        err.details.fields.includes("start_url"),
      JSON.stringify(err?.details),
    );
  }

  {
    const planner = createLlmScenarioPlanner({
      async complete() {
        return { draft_ir: validIr(), blockers: [42] };
      },
    });
    const err = await caught(Promise.resolve(planner.plan(request, { videoRecording: false }, context)));
    check("llm planner rejects invalid blocker shape", err?.code === "IR_SCHEMA_INVALID");
  }

  {
    const calls: LlmScenarioPlannerCallInput[] = [];
    const planner = createLlmScenarioPlanner({
      async complete(input) {
        calls.push(input);
        return { draft_ir: validIr("llm-unit-repaired"), blockers: [] };
      },
    });
    const compileError = {
      ok: false,
      code: "IR_SCHEMA_INVALID",
      details: { stage: "static", errors: [{ message: "missing start node" }] },
    } as Extract<CompileOutcome, { ok: false }>;
    const plan = await planner.repair?.({
      request,
      capabilities: { videoRecording: true },
      context,
      failedPlan: {
        planner: "llm_v1",
        request,
        promptHash: "hash",
        draftIr: { meta: { name: "bad", version: 1 }, start: "missing", nodes: { done: { terminal: "success" } } },
        blockers: [],
      },
      compileError,
      attempt: 1,
    });
    check("llm planner repair calls client with compile error", calls.length === 1 && calls[0]?.kind === "repair");
    check(
      "llm planner repair returns repaired plan",
      plan?.planner === "llm_v1" && plan.draftIr.meta !== undefined && calls[0]?.userPayload.compile_error === compileError,
      JSON.stringify({ plan, payload: calls[0]?.userPayload }),
    );
  }

  {
    let captured: LLMRequest | undefined;
    const gateway: ScenarioPlannerGateway = {
      async call(req) {
        captured = req;
        return {
          outputRef: "artifact://planner-output" as LLMResponse["outputRef"],
          usage: { inputTokens: 10, outputTokens: 20, cost: 0.01 },
          finishReason: "stop",
          parsedJson: { draft_ir: validIr(), blockers: [] },
        };
      },
    };
    const client = new LlmGatewayScenarioPlannerClient(gateway, {
      model: "default-planner-model",
      promptTemplateVersion: "scenario-planner@1",
      budget: { maxInputTokens: 1000, maxOutputTokens: 800, maxCost: 1 },
    });
    const output = await client.complete({
      kind: "plan",
      request: { ...request, model: null },
      capabilities: { videoRecording: false },
      context,
      systemPrompt: "system prompt",
      userPayload: { task: "draft_scenario_ir" },
      attempt: 0,
    });
    const schema = captured?.responseFormat?.schema as { properties?: Record<string, unknown> } | undefined;
    check("gateway planner client returns parsed JSON", typeof output === "object" && output !== null);
    check(
      "gateway planner client builds structured LLM request",
      captured?.model === "default-planner-model" &&
        captured.promptTemplateVersion === "scenario-planner@1" &&
        captured.responseFormat?.schemaRef === "scenario-generation/planner-output@1" &&
        captured.responseFormat.strict === false &&
        captured.metadata.tenantId === context.tenantId &&
        captured.metadata.runId === context.generationId &&
        captured.metadata.stepId === "scenario_generation_plan" &&
        captured.metadata.primitive === "extract" &&
        captured.budget.maxOutputTokens === 800 &&
        captured.idempotencyKey.startsWith(`scenario-generation:${context.generationId}:plan:0:`) &&
        schema?.properties !== undefined &&
        Object.prototype.hasOwnProperty.call(schema.properties, "params"),
      JSON.stringify(captured),
    );
  }

  {
    const gateway: ScenarioPlannerGateway = {
      async call() {
        return {
          outputRef: "artifact://planner-output" as LLMResponse["outputRef"],
          usage: { inputTokens: 10, outputTokens: 20, cost: 0.01 },
          finishReason: "stop",
          parsedJson: { draft_ir: validIr(), blockers: [], notes: "do not trust model extras" },
        };
      },
    };
    const client = new LlmGatewayScenarioPlannerClient(gateway, {
      model: "default-planner-model",
      promptTemplateVersion: "scenario-planner@1",
      budget: { maxInputTokens: 1000, maxOutputTokens: 800, maxCost: 1 },
    });
    const err = await caught(
      client.complete({
        kind: "plan",
        request,
        capabilities: { videoRecording: false },
        context,
        systemPrompt: "system prompt",
        userPayload: { task: "draft_scenario_ir" },
        attempt: 0,
      }),
    );
    check(
      "gateway planner client rejects unknown top-level parsed fields",
      err?.code === "IR_SCHEMA_INVALID" &&
        isRecord(err.details) &&
        err.details.reason === "llm_planner_unknown_output_fields",
      JSON.stringify(err?.details),
    );
  }

  {
    const gateway: ScenarioPlannerGateway = {
      async call() {
        return {
          outputRef: "artifact://planner-output" as LLMResponse["outputRef"],
          usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
          finishReason: "stop",
        };
      },
    };
    const client = new LlmGatewayScenarioPlannerClient(gateway, {
      model: "default-planner-model",
      promptTemplateVersion: "scenario-planner@1",
      budget: { maxInputTokens: 1000, maxOutputTokens: 800, maxCost: 1 },
    });
    const err = await caught(
      client.complete({
        kind: "plan",
        request,
        capabilities: { videoRecording: false },
        context,
        systemPrompt: "system prompt",
        userPayload: { task: "draft_scenario_ir" },
        attempt: 0,
      }),
    );
    check("gateway planner client fails closed without structured output", err?.code === "IR_SCHEMA_INVALID");
  }

  {
    const gateway: ScenarioPlannerGateway = {
      async call() {
        throw new GatewayError("LLM_CONTENT_FILTERED", "filtered", "CONTENT_FILTERED", "stagehand-call-1");
      },
    };
    const client = new LlmGatewayScenarioPlannerClient(gateway, {
      model: "default-planner-model",
      promptTemplateVersion: "scenario-planner@1",
      budget: { maxInputTokens: 1000, maxOutputTokens: 800, maxCost: 1 },
    });
    const err = await caught(
      client.complete({
        kind: "plan",
        request,
        capabilities: { videoRecording: false },
        context,
        systemPrompt: "system prompt",
        userPayload: { task: "draft_scenario_ir" },
        attempt: 0,
      }),
    );
    check("gateway planner client maps GatewayError to ApiResponseError", err?.code === "LLM_CONTENT_FILTERED");
  }

  if (failures > 0) {
    console.error(`\nFAIL: llm-scenario-planner.unit (${failures})`);
    process.exit(1);
  }
  console.log("\nPASS: llm-scenario-planner.unit");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
