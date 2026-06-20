/**
 * Natural-language scenario generation MVP.
 *
 * This is intentionally a deterministic planner first: it turns a prompt plus
 * explicit execution hints into a contract-valid IR, then reuses the existing
 * scenario save and run-create pipeline. A future LLM planner can implement the
 * same ScenarioPlanner port while preserving validation, persistence, RBAC, and idempotency.
 */
import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { ERROR_CATALOG } from "../../../ts/error-catalog";
import type {
  AuthenticatedPrincipal,
  CanonicalRequestHash,
  IdempotencyKey,
  SignedCommandRegistryPurpose,
} from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { compileScenario, type CompileOutcome } from "./compile-pipeline";
import { ApiResponseError } from "./errors";
import { canonicalRequestHash, completeIdempotencyInTx, idempotencyRecordRowId } from "./idempotency";
import { apiErrorBody, isRecord } from "./command";
import { extractFirstHttpUrl, hostOfHttpUrl, isHostAllowed, isHttpUrl } from "./scenario-generation-url";
import { containsRedactedParamsMarker, redactGenerationDraftIr, redactGenerationFailureDetails, redactParamsContext } from "./scenario-generation-redaction";
import { cloneJsonRecord, parseEvidencePolicy, parseGenerationBlockers, parseGenerationRequest, parseGenerationRunRequest, parseGenerationStatusFilter, parseListCursor, parseListLimit, parseParamsContext, parseRunIdFilter, parseTarget, UUID_RE } from "./scenario-generation-parse";
import { DEFAULT_PAGINATION_MAX_PAGES, MAX_AUTO_PAGINATION_PAGES, recordingPolicy, type RecordingPolicy } from "./scenario-generation-policy";
import { finalizeDraftIrEvidence, looksLikeSideEffectPrompt, paginationPlan, prepareGenerationRunIr, scenarioPlannerFor, startUrlFromParams, uniqueStrings } from "./scenario-generation-planner";
import { createRunInTx, requirePrincipal, type ApiServerDeps } from "./server";
import type {
  EvidencePolicy,
  GenerationCapabilities,
  GenerationMode,
  GenerationPlan,
  GenerationRequest,
  GenerationRunRequest,
  GenerationStatus,
  ScenarioPlanner,
  ScenarioPlannerContext,
  ScenarioPlannerId,
} from "./scenario-generation-types";
import type { RunEnqueuer } from "./run-queue";
import { originOf, resolveSiteProfileId, type SiteResolutionCode, SiteResolutionError } from "../runtime/site-resolution";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PLANNER_REPAIR_ATTEMPTS = 1;

interface ScenarioGenerationRow {
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

interface CommandResponse {
  status: number;
  body: unknown;
}

interface PlannedCompileResult {
  plan: GenerationPlan;
  compiled: Extract<ReturnType<typeof compileScenario>, { ok: true }>;
}

class ScenarioGenerationPlanningError extends Error {
  constructor(
    readonly apiError: ApiResponseError,
    readonly failedPlan?: GenerationPlan,
    readonly failedCompile?: CompileOutcome,
  ) {
    super(apiError.message);
    this.name = "ScenarioGenerationPlanningError";
  }
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

function scenarioGenerationCapabilities(deps: ApiServerDeps): GenerationCapabilities {
  return {
    // API capability means an operator can request video and later retrieve the saved WebM artifact.
    videoRecording: deps.scenarioGenerationCapabilities?.videoRecording === true && deps.artifactStore !== undefined,
  };
}

function defaultEvidencePolicy(capabilities: GenerationCapabilities): EvidencePolicy {
  return {
    screenshot: "each_step",
    video: capabilities.videoRecording ? "always" : "never",
  };
}

export function registerScenarioGenerationRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get(
    "/v1/scenario-generations/capabilities",
    { config: { rbacAction: "scenario.read" } },
    async () => {
      const { videoRecording } = scenarioGenerationCapabilities(deps);
      const planners: ScenarioPlannerId[] = [
        "deterministic_mvp",
        ...(deps.scenarioGenerationPlanner !== undefined ? [deps.scenarioGenerationPlanner.id] : []),
      ];
      return {
        planner: {
          default_planner: "deterministic_mvp",
          available: [...new Set(planners)],
        },
        visual_evidence: {
          screenshot: {
            enabled: true,
            policies: ["never", "failure", "each_step"],
            default_policy: "each_step",
          },
          video: {
            enabled: videoRecording,
            policies: videoRecording ? ["never", "failure", "always"] : ["never"],
            default_policy: videoRecording ? "always" : "never",
            artifact_type: "video_masked",
            media_type: "video/webm",
          },
        },
      };
    },
  );

  app.get<{ Querystring: { limit?: string; cursor?: string; status?: string; run_id?: string } }>(
    "/v1/scenario-generations",
    { config: { rbacAction: "scenario.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const limit = parseListLimit(request.query.limit);
      const cursor = parseListCursor(request.query.cursor);
      const status = parseGenerationStatusFilter(request.query.status);
      const runId = parseRunIdFilter(request.query.run_id);
      const rows = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
        const result = await client.query<ScenarioGenerationRow>(
          `SELECT id, mode, status, prompt_hash, prompt_redacted_ref, planner, model, params_context, draft_ir, validation_report,
                  evidence_policy, blockers, scenario_id, scenario_version_id, run_id,
                  created_by, created_at::text AS created_at
            FROM scenario_generations
            WHERE tenant_id=$1::uuid
              AND ($4::text IS NULL OR status=$4)
              AND ($6::uuid IS NULL OR run_id=$6::uuid)
              AND (
                $2::timestamptz IS NULL
                OR created_at < $2::timestamptz
                OR (created_at = $2::timestamptz AND id < $3::uuid)
              )
            ORDER BY created_at DESC, id DESC
            LIMIT $5::int`,
          [principal.tenantId, cursor?.createdAt ?? null, cursor?.id ?? null, status ?? null, limit + 1, runId ?? null],
        );
        return result.rows;
      });
      const pageRows = rows.slice(0, limit);
      const last = pageRows[pageRows.length - 1];
      reply.code(200).send({
        items: pageRows.map(mapGenerationRow),
        next_cursor: rows.length > limit && last !== undefined ? encodeListCursor(last) : null,
      });
    },
  );

  app.post("/v1/scenario-generations", { config: { rbacAction: "scenario.create" } }, async (request, reply) => {
    const result = await generateScenario(deps, request);
    reply.code(result.status).send(result.body);
  });

  app.post<{ Params: { generationId: string } }>(
    "/v1/scenario-generations/:generationId/run",
    { config: { rbacAction: "run.create" } },
    async (request, reply) => {
      const result = await runScenarioGeneration(deps, request.params.generationId, request);
      reply.code(result.status).send(result.body);
    },
  );

  app.get<{ Params: { generationId: string } }>(
    "/v1/scenario-generations/:generationId",
    { config: { rbacAction: "scenario.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const generationId = request.params.generationId;
      if (!UUID_RE.test(generationId)) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const row = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
        const result = await client.query<ScenarioGenerationRow>(
          `SELECT id, mode, status, prompt_hash, prompt_redacted_ref, planner, model, params_context, draft_ir, validation_report,
                  evidence_policy, blockers, scenario_id, scenario_version_id, run_id,
                  created_by, created_at::text AS created_at
             FROM scenario_generations
            WHERE id=$1::uuid`,
          [generationId],
        );
        return result.rows[0] ?? null;
      });
      if (row === null) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      reply.code(200).send(mapGenerationRow(row));
    },
  );
}

async function generateScenario(deps: ApiServerDeps, request: FastifyRequest): Promise<CommandResponse> {
  const principal = requirePrincipal(request);
  const capabilities = scenarioGenerationCapabilities(deps);
  const parsed = parseGenerationRequest(request.body, defaultEvidencePolicy(capabilities));
  if (parsed.mode === "save_and_run") {
    const decision = await deps.rbac.authorize(principal, { action: "run.create", tenantId: principal.tenantId });
    if (decision.kind === "deny") {
      throw new ApiResponseError(decision.code);
    }
  }

  const idempotencyKey = request.headers["idempotency-key"];
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_idempotency_key", header: "Idempotency-Key" });
  }
  const requestHash = canonicalRequestHash("POST", "/v1/scenario-generations", request.body ?? null);
  const reservation = await deps.idempotency.reserve({
    tenantId: principal.tenantId,
    endpoint: "generateScenario",
    key: idempotencyKey as IdempotencyKey,
    requestHash: requestHash as CanonicalRequestHash,
    expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString(),
  });
  if (reservation.kind === "replay") {
    return { status: reservation.response.status, body: reservation.response.body };
  }
  if (reservation.kind === "in_flight") {
    throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", { reason: "idempotency_in_flight" });
  }
  if (reservation.kind === "blocked") {
    throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "idempotency_request_hash_mismatch" });
  }

  const recordId = reservation.recordId;
  const generationId = idempotencyRecordRowId(recordId);
  let planned: PlannedCompileResult | undefined;
  try {
    const inferred = await withTenantTx(deps.pool, principal.tenantId, (client) =>
      inferRuntimeTargetForRequest(client, principal.tenantId, parsed),
    );
    const signedCommandRefs = await signedCommandRefsFor(deps, principal, "scenario.save");
    planned = await planAndCompileScenario(deps, inferred, signedCommandRefs, {
      tenantId: principal.tenantId,
      correlationId: request.correlationId,
      generationId,
      principal: { subjectId: principal.subjectId, roles: principal.roles },
    });
    const { plan, compiled } = planned;

    const response = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
      const response = await persistGeneration(client, deps, principal, request.correlationId, generationId, plan, compiled);
      await completeIdempotencyInTx(client, recordId, response);
      return response;
    });
    await deps.scenarioGenerationArtifacts?.commitGenerationArtifacts(generationId);
    return response;
  } catch (err) {
    await deps.scenarioGenerationArtifacts?.discardGenerationArtifacts(generationId);
    await deps.scenarioGenerationLlmCalls?.discardGenerationLlmCalls({
      tenantId: principal.tenantId,
      generationId,
    });
    const planningError = err instanceof ScenarioGenerationPlanningError ? err : undefined;
    const apiError = planningError?.apiError ?? (err instanceof ApiResponseError ? err : undefined);
    if (apiError !== undefined && !ERROR_CATALOG[apiError.code].retryable) {
      await withTenantTx(deps.pool, principal.tenantId, (client) =>
        upsertFailedGenerationLedger(client, {
          generationId,
          principal,
          request: parsed,
          apiError,
          failedPlan: planningError?.failedPlan ?? planned?.plan,
          failedCompile: planningError?.failedCompile ?? planned?.compiled,
        }),
      );
      await deps.idempotency.saveFailure(recordId, apiErrorBody(apiError, request.correlationId));
    }
    throw apiError ?? err;
  }
}

async function runScenarioGeneration(
  deps: ApiServerDeps,
  generationId: string,
  request: FastifyRequest,
): Promise<CommandResponse> {
  const principal = requirePrincipal(request);
  if (!UUID_RE.test(generationId)) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND");
  }
  const parsed = parseGenerationRunRequest(request.body);
  const idempotencyKey = request.headers["idempotency-key"];
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_idempotency_key", header: "Idempotency-Key" });
  }

  const requestHash = canonicalRequestHash("POST", `/v1/scenario-generations/${generationId}/run`, request.body ?? null);
  const reservation = await deps.idempotency.reserve({
    tenantId: principal.tenantId,
    endpoint: "runScenarioGeneration",
    key: idempotencyKey as IdempotencyKey,
    requestHash: requestHash as CanonicalRequestHash,
    expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString(),
  });
  if (reservation.kind === "replay") {
    return { status: reservation.response.status, body: reservation.response.body };
  }
  if (reservation.kind === "in_flight") {
    throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", { reason: "idempotency_in_flight" });
  }
  if (reservation.kind === "blocked") {
    throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "idempotency_request_hash_mismatch" });
  }

  const recordId = reservation.recordId;
  try {
    const signedCommandRefs = await signedCommandRefsFor(deps, principal, "scenario.save");
    return await withTenantTx(deps.pool, principal.tenantId, async (client) => {
      const generation = await loadGenerationForRun(client, generationId);
      const baseIr = await loadScenarioVersionIrForRun(client, generation);
      const response = await persistGenerationRun(
        client,
        deps,
        principal,
        request.correlationId,
        generation,
        baseIr,
        parsed,
        signedCommandRefs,
      );
      await completeIdempotencyInTx(client, recordId, response);
      return response;
    });
  } catch (err) {
    if (err instanceof ApiResponseError && !ERROR_CATALOG[err.code].retryable) {
      await deps.idempotency.saveFailure(recordId, apiErrorBody(err, request.correlationId));
    }
    throw err;
  }
}

async function loadGenerationForRun(client: PoolClient, generationId: string): Promise<ScenarioGenerationRow> {
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

async function loadScenarioVersionIrForRun(client: PoolClient, generation: ScenarioGenerationRow): Promise<Record<string, unknown>> {
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

async function persistGenerationRun(
  client: PoolClient,
  deps: ApiServerDeps,
  principal: AuthenticatedPrincipal,
  correlationId: string,
  generation: ScenarioGenerationRow,
  baseIr: Record<string, unknown>,
  request: GenerationRunRequest,
  signedCommandRefs: readonly string[] | undefined,
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
  if (evidence.video !== "never" && !scenarioGenerationCapabilities(deps).videoRecording) {
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

async function planAndCompileScenario(
  deps: ApiServerDeps,
  request: GenerationRequest,
  signedCommandRefs: readonly string[] | undefined,
  context: ScenarioPlannerContext,
): Promise<PlannedCompileResult> {
  const planner = scenarioPlannerFor(deps, request.planner);
  const capabilities = scenarioGenerationCapabilities(deps);
  let plan = await planner.plan(request, capabilities, context);
  try {
    assertPlannerResult(planner, request, plan);
    plan = finalizePlannerEvidence(plan, request, capabilities);
  } catch (err) {
    if (err instanceof ApiResponseError) throw new ScenarioGenerationPlanningError(err, plan);
    throw err;
  }

  for (let repairAttempt = 0; ; repairAttempt += 1) {
    const compiled = compileScenario(plan.draftIr, { signedCommandRefs });
    if (compiled.ok) {
      return { plan, compiled };
    }
    if (planner.repair === undefined || repairAttempt >= MAX_PLANNER_REPAIR_ATTEMPTS) {
      throw new ScenarioGenerationPlanningError(new ApiResponseError(compiled.code, compiled.details), plan, compiled);
    }
    plan = await planner.repair({
      request,
      capabilities,
      context,
      failedPlan: plan,
      compileError: compiled,
      attempt: repairAttempt + 1,
    });
    try {
      assertPlannerResult(planner, request, plan);
      plan = finalizePlannerEvidence(plan, request, capabilities);
    } catch (err) {
      if (err instanceof ApiResponseError) throw new ScenarioGenerationPlanningError(err, plan, compiled);
      throw err;
    }
  }
}

function finalizePlannerEvidence(plan: GenerationPlan, trustedRequest: GenerationRequest, capabilities: GenerationCapabilities): GenerationPlan {
  const recording = recordingPolicy(trustedRequest.evidence);
  const blockers = new Set(plan.blockers);
  const startUrl = trustedRequest.startUrl ?? extractFirstHttpUrl(trustedRequest.prompt);
  const pagination = paginationPlan(trustedRequest.prompt, { ...trustedRequest.params });
  if (trustedRequest.mode === "save_and_run") {
    if (trustedRequest.target === undefined) blockers.add("target_required_for_auto_run");
    if (startUrl === undefined) blockers.add("start_url_required_for_auto_run");
  }
  if (looksLikeSideEffectPrompt(trustedRequest.prompt, { allowPaginationControls: pagination.enabled })) {
    blockers.add("side_effect_prompt_requires_review");
  }
  if (pagination.blocker !== undefined) {
    blockers.add(pagination.blocker);
  }
  if (trustedRequest.evidence.video !== "never" && !capabilities.videoRecording) {
    blockers.add("video_recording_port_not_configured");
  }
  return {
    ...plan,
    draftIr: finalizeDraftIrEvidence(plan.draftIr, trustedRequest.evidence, recording),
    blockers: [...blockers],
  };
}

function assertPlannerResult(planner: ScenarioPlanner, trustedRequest: GenerationRequest, plan: GenerationPlan): void {
  if (plan.planner !== planner.id) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "planner_id_mismatch", requested: planner.id, planned: plan.planner });
  }
  const mutatedFields: string[] = [];
  if (plan.request.mode !== trustedRequest.mode) mutatedFields.push("mode");
  if (plan.request.planner !== trustedRequest.planner) mutatedFields.push("planner");
  if ((plan.request.model ?? null) !== (trustedRequest.model ?? null)) mutatedFields.push("model");
  if ((plan.request.startUrl ?? null) !== (trustedRequest.startUrl ?? null)) mutatedFields.push("start_url");
  if (!sameJson(plan.request.target ?? null, trustedRequest.target ?? null)) mutatedFields.push("target");
  if (!sameJson(plan.request.evidence, trustedRequest.evidence)) mutatedFields.push("evidence");
  if (mutatedFields.length > 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "planner_request_mutation_forbidden",
      fields: mutatedFields,
    });
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function persistGeneration(
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

async function upsertFailedGenerationLedger(
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

async function runtimeTargetBlocker(
  client: PoolClient,
  tenantId: string,
  target: NonNullable<GenerationRequest["target"]>,
  startUrl?: string,
): Promise<string | undefined> {
  const site = await client.query<{ risk: string; approved: boolean; url_pattern: string }>(
    `SELECT risk, approved, url_pattern FROM site_profiles WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    [tenantId, target.site_profile_id],
  );
  const siteRow = site.rows[0];
  if (siteRow === undefined) return "site_profile_not_found";
  if (siteRow.risk === "red" && siteRow.approved !== true) return "site_profile_blocked";
  if (startUrl !== undefined && originOf(siteRow.url_pattern) !== originOf(startUrl)) {
    return "target_start_url_site_mismatch";
  }
  const identity = await client.query<{ site_profile_id: string | null }>(
    `SELECT site_profile_id::text AS site_profile_id FROM browser_identities WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    [tenantId, target.browser_identity_id],
  );
  const identityRow = identity.rows[0];
  if (identityRow === undefined) return "browser_identity_not_found";
  if (identityRow.site_profile_id !== target.site_profile_id) return "browser_identity_site_mismatch";
  const network = await client.query<{ allowed_domains: string[] }>(
    `SELECT allowed_domains FROM network_policies WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    [tenantId, target.network_policy_id],
  );
  const networkRow = network.rows[0];
  if (networkRow === undefined) return "network_policy_not_found";
  const siteHost = hostOfHttpUrl(siteRow.url_pattern);
  if (siteHost === null || !isHostAllowed(siteHost, networkRow.allowed_domains)) {
    return "network_policy_domain_mismatch";
  }
  return undefined;
}

async function inferRuntimeTargetForRequest(
  client: PoolClient,
  tenantId: string,
  request: GenerationRequest,
): Promise<GenerationRequest> {
  if (request.target !== undefined) return request;
  const startUrl = request.startUrl ?? extractFirstHttpUrl(request.prompt);
  if (startUrl === undefined) return request;

  const target = await inferRuntimeTargetForStartUrl(client, tenantId, startUrl);
  if (target === undefined) return request;

  return {
    ...request,
    ...(request.startUrl !== undefined ? {} : { startUrl }),
    target,
  };
}

async function inferRuntimeTargetForStartUrl(
  client: PoolClient,
  tenantId: string,
  startUrl: string,
): Promise<GenerationRequest["target"]> {
  const siteProfileId = await resolveSiteProfileId(client, { tenantId, entryUrlRef: startUrl }).catch((error: unknown) => {
    if (error instanceof SiteResolutionError && isInferenceMiss(error.code)) return null;
    throw error;
  });
  if (siteProfileId === null) return undefined;

  const identity = await client.query<{ id: string }>(
    `SELECT id::text AS id
       FROM browser_identities
      WHERE tenant_id=$1::uuid AND site_profile_id=$2::uuid
      ORDER BY version DESC, created_at DESC, id DESC
      LIMIT 1`,
    [tenantId, siteProfileId],
  );
  const identityId = identity.rows[0]?.id;
  if (identityId === undefined) return undefined;

  const startHost = hostOfHttpUrl(startUrl);
  if (startHost === null) return undefined;
  const network = await client.query<{ id: string; allowed_domains: string[] }>(
    `SELECT id::text AS id, allowed_domains
       FROM network_policies
      WHERE tenant_id=$1::uuid
      ORDER BY created_at DESC, id DESC
      LIMIT 50`,
    [tenantId],
  );
  const matchingNetworkPolicies = network.rows.filter((row) => isHostAllowed(startHost, row.allowed_domains));
  if (matchingNetworkPolicies.length !== 1) return undefined;
  const networkPolicyId = matchingNetworkPolicies[0]?.id;
  if (networkPolicyId === undefined) return undefined;

  return {
    site_profile_id: siteProfileId,
    browser_identity_id: identityId,
    network_policy_id: networkPolicyId,
  };
}

function isInferenceMiss(code: SiteResolutionCode): boolean {
  return code === "SITE_PROFILE_UNRESOLVED" || code === "SITE_PROFILE_AMBIGUOUS";
}

function mapGenerationRow(row: ScenarioGenerationRow): Record<string, unknown> {
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

function encodeListCursor(row: ScenarioGenerationRow): string {
  return Buffer.from(JSON.stringify({ created_at: row.created_at, id: row.id }), "utf8").toString("base64url");
}

async function signedCommandRefsFor(
  deps: ApiServerDeps,
  principal: AuthenticatedPrincipal,
  purpose: SignedCommandRegistryPurpose,
): Promise<readonly string[] | undefined> {
  const result = await deps.signedCommandRegistry.listAllowedCommandRefs({ principal, purpose });
  if (result.kind === "unavailable") {
    return undefined;
  }
  const snapshot = result.snapshot;
  if (typeof snapshot.sourceRef !== "string" || snapshot.sourceRef.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "signed_command_registry_source_missing" });
  }
  if (!Array.isArray(snapshot.commands)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "signed_command_registry_commands_invalid" });
  }
  const cmdRefs: string[] = [];
  for (const command of snapshot.commands) {
    if (
      command === undefined ||
      typeof command.cmdRef !== "string" ||
      command.cmdRef.length === 0 ||
      typeof command.kid !== "string" ||
      command.kid.length === 0 ||
      typeof command.signature !== "string" ||
      command.signature.length === 0 ||
      typeof command.verificationKeyRef !== "string" ||
      command.verificationKeyRef.length === 0
    ) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "signed_command_registry_ref_invalid" });
    }
    cmdRefs.push(command.cmdRef);
  }
  return cmdRefs;
}
