/**
 * 자연어 generation 영속·ledger 저장소 (scenario-generations.ts 분해 — 동작 무변경 이동).
 *
 * scenario_generations/scenarios/scenario_versions DB read/write: load(FOR UPDATE)·생성(persistGeneration)·
 * 실행 보정(persistGenerationRun)·실패 ledger(upsertFailedGenerationLedger)·row→응답 매핑(mapGenerationRow)·
 * 커서(encodeListCursor). route/orchestration(잔류)이 본 모듈 export를 호출(단방향, back-cycle 없음). 내부
 * failed-ledger 헬퍼·RUN_REPAIRABLE_BLOCKERS는 비-export. compile/run-create/redaction/parse/planner/target leaf 의존.
 */
import { createHash, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { AuthenticatedPrincipal } from "../../../ts/security-middleware-contract";
import { compileScenario, type CompileOutcome } from "./compile-pipeline";
import { isRecord, type CommandResponse } from "./command";
import { ApiResponseError } from "./errors";
import { cloneJsonRecord, parseEvidencePolicy, parseGenerationBlockers, parseParamsContext, parseTarget } from "./scenario-generation-parse";
import { recordingPolicy } from "./scenario-generation-policy";
import { prepareGenerationRunIr, startUrlFromParams, uniqueStrings } from "./scenario-generation-planner";
import { containsRedactedParamsMarker, redactGenerationDraftIr, redactGenerationFailureDetails, redactParamsContext } from "./scenario-generation-redaction";
import { inferRuntimeTargetForStartUrl, runtimeTargetBlocker } from "./scenario-generation-target";
import type {
  GenerationMode,
  GenerationPlan,
  GenerationRequest,
  GenerationRunRequest,
  GenerationStatus,
} from "./scenario-generation-types";
import type { ApiServerDeps } from "./server";
import { createRunInTx } from "./server";

export interface ScenarioGenerationRow {
  id: string;
  mode: GenerationMode;
  status: GenerationStatus;
  prompt_hash: string;
  prompt_redacted_ref: string | null;
  planner: string;
  model: string | null;
  params_context: unknown;
  draft_ir: unknown;
  validation_report: unknown;
  evidence_policy: unknown;
  blockers: unknown;
  scenario_id: string | null;
  scenario_version_id: string | null;
  run_id: string | null;
  created_by: string;
  created_at: string;
}

const RUN_REPAIRABLE_BLOCKERS: ReadonlySet<string> = new Set([
  "target_required_for_auto_run",
  "start_url_required_for_auto_run",
  "target_start_url_site_mismatch",
  "site_profile_not_found",
  "site_profile_blocked",
  "browser_identity_not_found",
  "browser_identity_site_mismatch",
  "network_policy_not_found",
  "network_policy_domain_mismatch",
  "video_recording_port_not_configured",
  "params_context_redacted_value_required",
]);

export async function loadGenerationForRun(client: PoolClient, generationId: string): Promise<ScenarioGenerationRow> {
  const result = await client.query<ScenarioGenerationRow>(
    `SELECT id, mode, status, prompt_hash, prompt_redacted_ref, planner, model, params_context, draft_ir, validation_report,
            evidence_policy, blockers, scenario_id, scenario_version_id, run_id,
            created_by, created_at::text AS created_at
       FROM scenario_generations
      WHERE id=$1::uuid
      FOR UPDATE`,
    [generationId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND");
  }
  if (row.run_id !== null) {
    throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", {
      reason: "scenario_generation_already_run",
      run_id: row.run_id,
    });
  }
  if (row.scenario_id === null || row.scenario_version_id === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "scenario_generation_not_saved" });
  }
  return row;
}

export async function loadScenarioVersionIrForRun(client: PoolClient, generation: ScenarioGenerationRow): Promise<Record<string, unknown>> {
  if (generation.scenario_version_id === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "scenario_generation_not_saved" });
  }
  const result = await client.query<{ ir: unknown }>(
    `SELECT ir
       FROM scenario_versions
      WHERE id=$1::uuid
      FOR UPDATE`,
    [generation.scenario_version_id],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "scenario_version_not_found" });
  }
  return cloneJsonRecord(row.ir, "scenario_version_ir_invalid");
}

export async function persistGenerationRun(
  client: PoolClient,
  deps: ApiServerDeps,
  principal: AuthenticatedPrincipal,
  correlationId: string,
  generation: ScenarioGenerationRow,
  baseIr: Record<string, unknown>,
  request: GenerationRunRequest,
  signedCommandRefs: readonly string[] | undefined,
  videoRecording: boolean,
): Promise<CommandResponse> {
  if (generation.scenario_version_id === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "scenario_generation_not_saved" });
  }
  const existingBlockers = parseGenerationBlockers(generation.blockers);
  const blockers = existingBlockers.filter((blocker) => !RUN_REPAIRABLE_BLOCKERS.has(blocker));
  const evidence = request.evidence ?? parseEvidencePolicy(generation.evidence_policy);
  const recording = recordingPolicy(evidence);
  const storedParamsContext = parseParamsContext(generation.params_context);
  const effectiveRequestParams = request.paramsProvided ? request.params : storedParamsContext;
  const startUrl = request.startUrl ?? startUrlFromParams(effectiveRequestParams);
  const explicitOrStoredTarget = request.target ?? parseTarget(baseIr.target);
  const target = explicitOrStoredTarget ?? (
    startUrl !== undefined
      ? await inferRuntimeTargetForStartUrl(client, principal.tenantId, startUrl)
      : undefined
  );
  const model = request.model !== undefined ? request.model : generation.model;

  if (containsRedactedParamsMarker(effectiveRequestParams)) blockers.push("params_context_redacted_value_required");
  if (target === undefined) blockers.push("target_required_for_auto_run");
  if (startUrl === undefined) blockers.push("start_url_required_for_auto_run");
  if (evidence.video !== "never" && !videoRecording) {
    blockers.push("video_recording_port_not_configured");
  }
  if (target !== undefined) {
    const targetBlocker = await runtimeTargetBlocker(client, principal.tenantId, target, startUrl);
    if (targetBlocker !== undefined) blockers.push(targetBlocker);
  }

  const runIr = prepareGenerationRunIr(baseIr, { target, startUrl, evidence, recording });
  const compiled = compileScenario(runIr, { signedCommandRefs });
  if (!compiled.ok) {
    throw new ApiResponseError(compiled.code, compiled.details);
  }

  await client.query(
    `UPDATE scenario_versions
        SET ir=$3::jsonb,
            compiled_ast=$4,
            params_schema=$5::jsonb
      WHERE id=$1::uuid
        AND tenant_id=$2::uuid`,
    [
      generation.scenario_version_id,
      principal.tenantId,
      JSON.stringify(compiled.ir),
      compiled.compiledAst,
      compiled.ir.params_schema !== undefined ? JSON.stringify(compiled.ir.params_schema) : null,
    ],
  );

  const uniqueBlockers = uniqueStrings(blockers);
  let runId: string | null = null;
  let nextStatus: GenerationStatus = "blocked";
  let nextParamsContext = redactParamsContext({
    ...effectiveRequestParams,
    ...(startUrl !== undefined ? { start_url: startUrl } : {}),
  });
  if (uniqueBlockers.length === 0 && startUrl !== undefined) {
    const asOf = typeof effectiveRequestParams.as_of === "string" ? effectiveRequestParams.as_of : new Date().toISOString();
    const params = { ...effectiveRequestParams, start_url: startUrl, as_of: asOf };
    nextParamsContext = redactParamsContext({
      ...effectiveRequestParams,
      start_url: startUrl,
      ...(typeof effectiveRequestParams.as_of === "string" ? { as_of: effectiveRequestParams.as_of } : {}),
    });
    runId = randomUUID();
    await createRunInTx(client, deps.enqueuer, {
      runId,
      tenantId: principal.tenantId,
      scenarioVersionId: generation.scenario_version_id,
      params,
      asOf,
      correlationId,
      model,
    });
    nextStatus = "run_queued";
  }

  const ledgerDraftIr = redactGenerationDraftIr(compiled.ir);
  const updated = await client.query<ScenarioGenerationRow>(
    `UPDATE scenario_generations
        SET status=$3,
            model=$4,
            draft_ir=$5::jsonb,
            validation_report=$6::jsonb,
            evidence_policy=$7::jsonb,
            blockers=$8::jsonb,
            run_id=$9::uuid,
            params_context=$10::jsonb
      WHERE id=$1::uuid
        AND tenant_id=$2::uuid
      RETURNING id, mode, status, prompt_hash, prompt_redacted_ref, planner, model, params_context, draft_ir, validation_report,
                evidence_policy, blockers, scenario_id, scenario_version_id, run_id,
                created_by, created_at::text AS created_at`,
    [
      generation.id,
      principal.tenantId,
      nextStatus,
      model,
      JSON.stringify(ledgerDraftIr),
      JSON.stringify(compiled.report),
      JSON.stringify(evidence),
      JSON.stringify(uniqueBlockers),
      runId,
      JSON.stringify(nextParamsContext),
    ],
  );
  const row = updated.rows[0];
  if (row === undefined) {
    throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "scenario_generation_update_missing_returning_row" });
  }
  return {
    status: runId === null ? 200 : 201,
    body: mapGenerationRow(row),
  };
}

export async function persistGeneration(
  client: PoolClient,
  deps: ApiServerDeps,
  principal: AuthenticatedPrincipal,
  correlationId: string,
  generationId: string,
  plan: GenerationPlan,
  compiled: Extract<ReturnType<typeof compileScenario>, { ok: true }>,
): Promise<CommandResponse> {
  let scenarioId: string | null = null;
  let scenarioVersionId: string | null = null;
  let runId: string | null = null;
  let status: GenerationStatus = plan.request.mode === "draft_only" ? "drafted" : "saved";
  const blockers = [...plan.blockers];

  if (plan.request.mode !== "draft_only") {
    scenarioId = randomUUID();
    const scenario = await client.query<{ id: string }>(
      `INSERT INTO scenarios (id, tenant_id, name)
       VALUES ($1::uuid, $2::uuid, $3)
       ON CONFLICT (tenant_id, name) WHERE archived_at IS NULL DO NOTHING
       RETURNING id`,
      [scenarioId, principal.tenantId, compiled.ir.meta.name],
    );
    if (scenario.rowCount === 0) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "scenario_name_in_use", name: compiled.ir.meta.name });
    }

    scenarioVersionId = randomUUID();
    await client.query(
      `INSERT INTO scenario_versions
         (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast, params_schema)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'draft', $5::jsonb, $6, $7::jsonb)`,
      [
        scenarioVersionId,
        principal.tenantId,
        scenarioId,
        compiled.ir.meta.version,
        JSON.stringify(compiled.ir),
        compiled.compiledAst,
        compiled.ir.params_schema !== undefined ? JSON.stringify(compiled.ir.params_schema) : null,
      ],
    );
  }

  if (plan.request.mode === "save_and_run") {
    const targetBlocker = plan.request.target !== undefined
      ? await runtimeTargetBlocker(client, principal.tenantId, plan.request.target, plan.request.startUrl)
      : undefined;
    if (targetBlocker !== undefined) {
      blockers.push(targetBlocker);
    }
    if (blockers.length === 0 && scenarioVersionId !== null) {
      const asOf = typeof plan.request.params.as_of === "string" ? plan.request.params.as_of : new Date().toISOString();
      const params = { ...plan.request.params, as_of: asOf };
      runId = randomUUID();
      await createRunInTx(client, deps.enqueuer, {
        runId,
        tenantId: principal.tenantId,
        scenarioVersionId,
        params,
        asOf,
        correlationId,
        model: plan.request.model ?? null,
      });
      status = "run_queued";
    } else {
      status = "blocked";
    }
  } else if (blockers.length > 0 && plan.request.mode !== "draft_only") {
    status = "blocked";
  }

  const ledgerDraftIr = redactGenerationDraftIr(compiled.ir);
  const paramsContext = redactParamsContext(plan.request.params);
  const inserted = await client.query<Pick<ScenarioGenerationRow, "created_by" | "created_at">>(
    `INSERT INTO scenario_generations
       (id, tenant_id, mode, status, prompt_hash, planner, model, params_context, draft_ir, validation_report,
        evidence_policy, blockers, scenario_id, scenario_version_id, run_id, created_by)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb,
             $11::jsonb, $12::jsonb, $13::uuid, $14::uuid, $15::uuid, $16)
     RETURNING created_by, created_at::text AS created_at`,
    [
      generationId,
      principal.tenantId,
      plan.request.mode,
      status,
      plan.promptHash,
      plan.planner,
      plan.request.model ?? null,
      JSON.stringify(paramsContext),
      JSON.stringify(ledgerDraftIr),
      JSON.stringify(compiled.report),
      JSON.stringify(plan.request.evidence),
      JSON.stringify(blockers),
      scenarioId,
      scenarioVersionId,
      runId,
      principal.subjectId,
    ],
  );
  const created = inserted.rows[0];
  if (created === undefined) {
    throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "scenario_generation_insert_missing_returning_row" });
  }
  const generationArtifactRefs = await deps.scenarioGenerationArtifacts?.flushGenerationArtifacts(client, {
    tenantId: principal.tenantId,
    generationId,
  }) ?? [];
  if (generationArtifactRefs.length > 0) {
    if (deps.enqueuer.enqueueArtifactRedaction === undefined) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", {
        reason: "scenario_generation_artifact_redaction_queue_not_configured",
      });
    }
    await deps.enqueuer.enqueueArtifactRedaction(client, {
      tenantId: principal.tenantId,
      generationId,
      correlationId,
    });
  }

  return {
    status: plan.request.mode === "draft_only" ? 200 : 201,
    body: {
      generation_id: generationId,
      status,
      mode: plan.request.mode,
      scenario_id: scenarioId,
      scenario_version_id: scenarioVersionId,
      run_id: runId,
      prompt_hash: plan.promptHash,
      planner: plan.planner,
      model: plan.request.model ?? null,
      params_context: paramsContext,
      evidence_policy: plan.request.evidence,
      blockers,
      created_by: created.created_by,
      created_at: created.created_at,
      validation_report: compiled.report,
      draft_ir: ledgerDraftIr,
    },
  };
}

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

export function mapGenerationRow(row: ScenarioGenerationRow): Record<string, unknown> {
  return {
    generation_id: row.id,
    mode: row.mode,
    status: row.status,
    prompt_hash: row.prompt_hash,
    prompt_redacted_ref: row.prompt_redacted_ref,
    planner: row.planner,
    model: row.model,
    params_context: parseParamsContext(row.params_context),
    draft_ir: row.draft_ir,
    validation_report: row.validation_report,
    evidence_policy: row.evidence_policy,
    blockers: row.blockers,
    scenario_id: row.scenario_id,
    scenario_version_id: row.scenario_version_id,
    run_id: row.run_id,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

export function encodeListCursor(row: ScenarioGenerationRow): string {
  return Buffer.from(JSON.stringify({ created_at: row.created_at, id: row.id }), "utf8").toString("base64url");
}

