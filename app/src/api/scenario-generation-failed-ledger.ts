/**
 * 실패한 시나리오 생성 원장(ledger) 영속 — 플래너/리페어/저장 실패 시 prompt 평문 없이 redaction 된
 * placeholder IR·검증리포트·blocker·사유를 scenario_generations(status='failed')에 upsert 한다.
 * scenario-generations.ts(라우트)가 호출. (분해 전 scenario-generation-store.ts 내부였음 — CLAUDE.md #7.)
 */
import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import type { AuthenticatedPrincipal } from "../../../ts/security-middleware-contract";
import type { CompileOutcome } from "./compile-pipeline";
import { isRecord } from "./command";
import { ApiResponseError } from "./errors";
import { redactGenerationDraftIr, redactGenerationFailureDetails, redactParamsContext } from "./scenario-generation-redaction";
import { uniqueStrings } from "./scenario-generation-planner";
import type { GenerationPlan, GenerationRequest } from "./scenario-generation-types";

export async function upsertFailedGenerationLedger(
  client: PoolClient,
  input: {
    generationId: string;
    principal: AuthenticatedPrincipal;
    request: GenerationRequest;
    apiError: ApiResponseError;
    failedPlan?: GenerationPlan;
    failedCompile?: CompileOutcome;
  },
): Promise<void> {
  const request = input.failedPlan?.request ?? input.request;
  const promptHash = input.failedPlan?.promptHash ?? createHash("sha256").update(input.request.prompt).digest("hex");
  const planner = input.failedPlan?.planner ?? input.request.planner ?? "deterministic_mvp";
  const draftIr = input.failedPlan !== undefined
    ? redactGenerationDraftIr(input.failedPlan.draftIr)
    : failedGenerationPlaceholderIr(input.request, promptHash);
  const validationReport = failedGenerationValidationReport(input.apiError, input.failedCompile, input.request);
  const blockers = failedGenerationBlockers(input.apiError, input.failedCompile, input.failedPlan);
  const upserted = await client.query<{ id: string }>(
    `INSERT INTO scenario_generations
       (id, tenant_id, mode, status, prompt_hash, planner, model, params_context, draft_ir, validation_report,
        evidence_policy, blockers, scenario_id, scenario_version_id, run_id, created_by)
     VALUES ($1::uuid, $2::uuid, $3, 'failed', $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb,
             $10::jsonb, $11::jsonb, NULL, NULL, NULL, $12)
     ON CONFLICT (id) DO UPDATE
       SET status='failed',
           planner=EXCLUDED.planner,
           model=EXCLUDED.model,
           params_context=EXCLUDED.params_context,
           draft_ir=EXCLUDED.draft_ir,
           validation_report=EXCLUDED.validation_report,
           evidence_policy=EXCLUDED.evidence_policy,
           blockers=EXCLUDED.blockers
      WHERE scenario_generations.tenant_id=$2::uuid
      RETURNING id::text`,
    [
      input.generationId,
      input.principal.tenantId,
      request.mode,
      promptHash,
      planner,
      request.model ?? null,
      JSON.stringify(redactParamsContext(request.params)),
      JSON.stringify(draftIr),
      JSON.stringify(validationReport),
      JSON.stringify(request.evidence),
      JSON.stringify(blockers),
      input.principal.subjectId,
    ],
  );
  if (upserted.rows[0]?.id !== input.generationId) {
    throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "scenario_generation_failed_ledger_upsert_missing_returning_row" });
  }
}

function failedGenerationPlaceholderIr(request: GenerationRequest, promptHash: string): Record<string, unknown> {
  return {
    meta: {
      name: request.name ?? `failed-prompt-${promptHash.slice(0, 12)}`,
      version: 1,
      ir_version: "1.x",
      studio_mode: "easy",
      evidence: request.evidence,
    },
    params_schema: { type: "object", additionalProperties: true },
    ...(request.target !== undefined ? { target: request.target } : {}),
    start: "failed",
    nodes: {
      failed: { terminal: "fail_system" },
    },
  };
}

function failedGenerationValidationReport(
  apiError: ApiResponseError,
  compile: CompileOutcome | undefined,
  request: GenerationRequest,
): Record<string, unknown> {
  if (compile?.report !== undefined) return compile.report as unknown as Record<string, unknown>;
  return {
    errors: [
      {
        code: apiError.code,
        reason: failedGenerationReason(apiError, compile),
        details: redactGenerationFailureDetails(apiError.details, request.prompt),
      },
    ],
    warnings: [],
  };
}

function failedGenerationBlockers(
  apiError: ApiResponseError,
  compile: CompileOutcome | undefined,
  plan: GenerationPlan | undefined,
): string[] {
  const blockers = [...(plan?.blockers ?? []), "scenario_generation_failed"];
  if (compile !== undefined && !compile.ok) blockers.push("compile_failed");
  const reason = apiErrorDetailsReason(apiError.details);
  if (reason !== undefined) blockers.push(reason);
  return uniqueStrings(blockers);
}

function failedGenerationReason(apiError: ApiResponseError, compile: CompileOutcome | undefined): string {
  const reason = apiErrorDetailsReason(apiError.details);
  if (reason !== undefined) return reason;
  if (compile !== undefined && !compile.ok) return "compile_failed";
  return "scenario_generation_failed";
}

function apiErrorDetailsReason(details: unknown): string | undefined {
  return isRecord(details) && typeof details.reason === "string" && details.reason.length > 0 ? details.reason : undefined;
}
