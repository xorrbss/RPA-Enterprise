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
import { createRunInTx, requirePrincipal, type ApiServerDeps } from "./server";
import type {
  EvidencePolicy,
  GenerationCapabilities,
  GenerationMode,
  GenerationPlan,
  GenerationRequest,
  GenerationStatus,
  ScenarioPlanner,
  ScenarioPlannerContext,
  ScenarioPlannerId,
} from "./scenario-generation-types";
import type { RunEnqueuer } from "./run-queue";
import { originOf, resolveSiteProfileId, type SiteResolutionCode, SiteResolutionError } from "../runtime/site-resolution";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_8601_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PAGINATION_MAX_PAGES = 3;
const MAX_AUTO_PAGINATION_PAGES = 10;
const MAX_PLANNER_REPAIR_ATTEMPTS = 1;

type RecordingPolicy = "always" | "masked_on_failure" | "never";

interface PaginationPlan {
  enabled: boolean;
  maxPages?: number;
  blocker?: string;
}

const deterministicMvpScenarioPlanner: ScenarioPlanner = {
  id: "deterministic_mvp",
  plan: buildDeterministicMvpGenerationPlan,
};

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

interface GenerationRunRequest {
  target?: NonNullable<GenerationRequest["target"]>;
  startUrl?: string;
  params: Record<string, unknown>;
  paramsProvided: boolean;
  model?: string | null;
  evidence?: EvidencePolicy;
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

const REDACTED_SCENARIO_GENERATION_PARAM = "[REDACTED:scenario_generation_param]";

function scenarioGenerationCapabilities(deps: ApiServerDeps): GenerationCapabilities {
  return deps.scenarioGenerationCapabilities ?? { videoRecording: false };
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
      const videoRecording = deps.scenarioGenerationCapabilities?.videoRecording === true;
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
    });
    const { plan, compiled } = planned;

    return await withTenantTx(deps.pool, principal.tenantId, async (client) => {
      const response = await persistGeneration(client, deps, principal, request.correlationId, generationId, plan, compiled);
      await completeIdempotencyInTx(client, recordId, response);
      return response;
    });
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
  if (evidence.video !== "never" && deps.scenarioGenerationCapabilities?.videoRecording !== true) {
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

function finalizeDraftIrEvidence(
  draftIr: Record<string, unknown>,
  evidence: EvidencePolicy,
  recording: RecordingPolicy,
): Record<string, unknown> {
  const meta = isRecord(draftIr.meta) ? draftIr.meta : {};
  const next: Record<string, unknown> = {
    ...draftIr,
    meta: { ...meta, evidence },
  };
  if (isRecord(draftIr.nodes)) {
    next.nodes = Object.fromEntries(
      Object.entries(draftIr.nodes).map(([nodeId, node]) => [nodeId, finalizeNodeRecordingPolicy(node, recording)]),
    );
  }
  return next;
}

function finalizeNodeRecordingPolicy(node: unknown, recording: RecordingPolicy): unknown {
  if (!isRecord(node) || !Array.isArray(node.what)) return node;
  const policy = isRecord(node.policy) ? node.policy : {};
  return { ...node, policy: { ...policy, recording } };
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
    for (const artifactId of generationArtifactRefs) {
      await deps.enqueuer.enqueueArtifactRedaction(client, {
        tenantId: principal.tenantId,
        correlationId,
        artifactId,
        generationId,
      });
    }
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

function redactGenerationFailureDetails(value: unknown, prompt: string): unknown {
  if (typeof value === "string") {
    return value.includes(prompt) ? value.replaceAll(prompt, "[REDACTED:scenario_generation_prompt]") : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactGenerationFailureDetails(item, prompt));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = key === "prompt" || key === "instruction"
      ? "[REDACTED:scenario_generation_error_detail]"
      : redactGenerationFailureDetails(child, prompt);
  }
  return out;
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

function parseGenerationRequest(body: unknown, defaultEvidence: EvidencePolicy): GenerationRequest {
  if (!isRecord(body)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  }
  const allowed = new Set(["prompt", "name", "mode", "planner", "start_url", "target", "params", "model", "evidence"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unknown_field", field: key });
    }
  }
  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "prompt_required" });
  }
  if (body.prompt.length > 20000) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "prompt_too_long", max: 20000 });
  }
  if (body.name !== undefined && (typeof body.name !== "string" || body.name.trim().length === 0)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_generation_name" });
  }
  const mode = body.mode === undefined ? "save_and_run" : body.mode;
  if (mode !== "draft_only" && mode !== "save" && mode !== "save_and_run") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_generation_mode" });
  }
  const planner = parseScenarioPlannerId(body.planner);
  const params = body.params === undefined ? {} : body.params;
  if (!isRecord(params)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "params_object_required" });
  }
  if (params.as_of !== undefined && (typeof params.as_of !== "string" || !isStrictIsoDateTime(params.as_of))) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_as_of" });
  }
  let startUrl: string | undefined;
  if (body.start_url !== undefined) {
    if (typeof body.start_url !== "string" || !isHttpUrl(body.start_url)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_start_url" });
    }
    startUrl = body.start_url;
  }
  let model: string | null | undefined;
  if (body.model !== undefined && body.model !== null) {
    if (typeof body.model !== "string" || body.model.length === 0) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_model" });
    }
    model = body.model;
  } else if (body.model === null) {
    model = null;
  }

  return {
    prompt: body.prompt.trim(),
    ...(typeof body.name === "string" && body.name.trim().length > 0 ? { name: body.name.trim() } : {}),
    mode,
    ...(planner !== undefined ? { planner } : {}),
    ...(startUrl !== undefined ? { startUrl } : {}),
    target: parseTarget(body.target),
    params: params as Record<string, unknown>,
    ...(model !== undefined ? { model } : {}),
    evidence: parseEvidencePolicy(body.evidence, defaultEvidence),
  };
}

function parseGenerationRunRequest(body: unknown): GenerationRunRequest {
  const requestBody = body === undefined || body === null ? {} : body;
  if (!isRecord(requestBody)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  }
  const allowed = new Set(["target", "start_url", "params", "model", "evidence"]);
  for (const key of Object.keys(requestBody)) {
    if (!allowed.has(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unknown_field", field: key });
    }
  }

  const params = requestBody.params === undefined ? {} : requestBody.params;
  if (!isRecord(params)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "params_object_required" });
  }
  if (params.as_of !== undefined && (typeof params.as_of !== "string" || !isStrictIsoDateTime(params.as_of))) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_as_of" });
  }

  let startUrl: string | undefined;
  if (requestBody.start_url !== undefined) {
    if (typeof requestBody.start_url !== "string" || !isHttpUrl(requestBody.start_url)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_start_url" });
    }
    startUrl = requestBody.start_url;
  }
  if (params.start_url !== undefined) {
    if (typeof params.start_url !== "string" || !isHttpUrl(params.start_url)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_start_url" });
    }
    if (startUrl !== undefined && params.start_url !== startUrl) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "start_url_param_mismatch" });
    }
    startUrl = params.start_url;
  }

  let model: string | null | undefined;
  if (requestBody.model !== undefined && requestBody.model !== null) {
    if (typeof requestBody.model !== "string" || requestBody.model.length === 0) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_model" });
    }
    model = requestBody.model;
  } else if (requestBody.model === null) {
    model = null;
  }

  return {
    target: parseTarget(requestBody.target),
    ...(startUrl !== undefined ? { startUrl } : {}),
    params: params as Record<string, unknown>,
    paramsProvided: requestBody.params !== undefined,
    ...(model !== undefined ? { model } : {}),
    ...(requestBody.evidence !== undefined ? { evidence: parseEvidencePolicy(requestBody.evidence) } : {}),
  };
}

function buildDeterministicMvpGenerationPlan(request: GenerationRequest, capabilities: GenerationCapabilities): GenerationPlan {
  const promptHash = createHash("sha256").update(request.prompt).digest("hex");
  const startUrl = request.startUrl ?? extractFirstHttpUrl(request.prompt);
  const params = { ...request.params };
  if (startUrl !== undefined) {
    params.start_url = startUrl;
  }
  const target = request.target;
  const evidence = request.evidence;
  const recording = recordingPolicy(evidence);
  const pagination = paginationPlan(request.prompt, params);
  const blockers: string[] = [];
  if (request.mode === "save_and_run") {
    if (target === undefined) blockers.push("target_required_for_auto_run");
    if (startUrl === undefined) blockers.push("start_url_required_for_auto_run");
  }
  if (looksLikeSideEffectPrompt(request.prompt, { allowPaginationControls: pagination.enabled })) {
    blockers.push("side_effect_prompt_requires_review");
  }
  if (evidence.video !== "never" && !capabilities.videoRecording) {
    blockers.push("video_recording_port_not_configured");
  }
  if (pagination.blocker !== undefined) {
    blockers.push(pagination.blocker);
  }

  const nodes: Record<string, unknown> = {};
  const observeNode = {
    what: [{ action: "observe", instruction: request.prompt }],
    next: "extract_results",
    policy: { recording },
    side_effect: { kind: "read_only" },
  };
  if (startUrl !== undefined) {
    nodes.open_start_url = {
      what: [{ action: "navigate", url_ref: "start_url" }],
      next: pagination.enabled ? "paginate_pages" : "understand_request",
      policy: { recording },
      side_effect: { kind: "read_only" },
    };
    if (!pagination.enabled) {
      nodes.understand_request = observeNode;
    }
  } else {
    if (!pagination.enabled) {
      nodes.understand_request = observeNode;
    }
  }
  if (pagination.enabled) {
    nodes.paginate_pages = paginateLoopNode(pagination, recording);
    nodes.extract_current_page = extractNode({
      instruction: paginatedExtractionInstruction(request.prompt),
      next: "advance_page",
      recording,
      schemaRef: "generated/paginated_result@1",
    });
    nodes.advance_page = {
      what: [{ action: "act", instruction: advancePageInstruction(request.prompt) }],
      next: "paginate_pages",
      policy: { recording },
      side_effect: { kind: "read_only" },
    };
  } else {
    nodes.extract_results = extractNode({
      instruction: extractionInstruction(request.prompt),
      next: "done",
      recording,
      schemaRef: "generated/default_result@1",
    });
  }
  nodes.done = { terminal: "success" };

  const draftIr: Record<string, unknown> = {
    meta: {
      name: request.name ?? `prompt-${promptHash.slice(0, 12)}`,
      version: 1,
      ir_version: "1.x",
      studio_mode: "easy",
      evidence,
    },
    params_schema: paramsSchema({
      hasStartUrl: startUrl !== undefined,
      pagination: pagination.enabled,
      startUrl,
      maxPages: pagination.maxPages,
    }),
    ...(target !== undefined ? { target } : {}),
    start: startUrl !== undefined ? "open_start_url" : pagination.enabled ? "paginate_pages" : "understand_request",
    nodes,
  };

  return {
    planner: "deterministic_mvp",
    request: { ...request, ...(startUrl !== undefined ? { startUrl } : {}), params },
    promptHash,
    draftIr,
    blockers,
  };
}

function scenarioPlannerFor(deps: ApiServerDeps, requested: ScenarioPlannerId | undefined): ScenarioPlanner {
  if (requested === undefined || requested === "deterministic_mvp") {
    return deterministicMvpScenarioPlanner;
  }
  if (deps.scenarioGenerationPlanner?.id === requested) {
    return deps.scenarioGenerationPlanner;
  }
  throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "scenario_planner_not_configured", planner: requested });
}

function parseTarget(value: unknown): GenerationRequest["target"] {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "target_object_required" });
  }
  const site = value.site_profile_id;
  const identity = value.browser_identity_id;
  const network = value.network_policy_id;
  if (typeof site !== "string" || !UUID_RE.test(site)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_site_profile_id" });
  }
  if (typeof identity !== "string" || !UUID_RE.test(identity)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_browser_identity_id" });
  }
  if (typeof network !== "string" || !UUID_RE.test(network)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_network_policy_id" });
  }
  return { site_profile_id: site, browser_identity_id: identity, network_policy_id: network };
}

function parseEvidencePolicy(value: unknown, defaultEvidence: EvidencePolicy = { screenshot: "failure", video: "never" }): EvidencePolicy {
  if (value === undefined || value === null) {
    return defaultEvidence;
  }
  if (!isRecord(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "evidence_object_required" });
  }
  for (const key of Object.keys(value)) {
    if (key !== "screenshot" && key !== "video") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unknown_evidence_field", field: key });
    }
  }
  const screenshot = value.screenshot ?? defaultEvidence.screenshot;
  const video = value.video ?? defaultEvidence.video;
  if (screenshot !== "never" && screenshot !== "failure" && screenshot !== "each_step") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_evidence_screenshot" });
  }
  if (video !== "never" && video !== "failure" && video !== "always") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_evidence_video" });
  }
  return { screenshot, video };
}

function parseScenarioPlannerId(value: unknown): ScenarioPlannerId | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "deterministic_mvp" || value === "llm_v1") return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_scenario_planner" });
}

function paramsSchema(options: { hasStartUrl: boolean; pagination: boolean; startUrl?: string; maxPages?: number }): Record<string, unknown> {
  const required: string[] = [];
  if (options.hasStartUrl) required.push("start_url");
  if (options.pagination) required.push("max_pages");
  return {
    type: "object",
    additionalProperties: true,
    properties: {
      as_of: { type: "string" },
      ...(options.hasStartUrl
        ? {
            start_url: {
              type: "string",
              format: "uri",
              ...(options.startUrl !== undefined ? { default: options.startUrl } : {}),
            },
          }
        : {}),
      ...(options.pagination
        ? {
            max_pages: {
              type: "integer",
              minimum: 1,
              maximum: MAX_AUTO_PAGINATION_PAGES,
              default: options.maxPages ?? DEFAULT_PAGINATION_MAX_PAGES,
            },
          }
        : {}),
    },
    ...(required.length > 0 ? { required } : {}),
  };
}

function prepareGenerationRunIr(
  baseIr: Record<string, unknown>,
  input: {
    target?: NonNullable<GenerationRequest["target"]>;
    startUrl?: string;
    evidence: EvidencePolicy;
    recording: RecordingPolicy;
  },
): Record<string, unknown> {
  let next = finalizeDraftIrEvidence(baseIr, input.evidence, input.recording);
  if (input.target !== undefined) {
    next = { ...next, target: input.target };
  }
  if (input.startUrl !== undefined) {
    next = ensureStartUrlNavigation(next, input.recording, input.startUrl);
  }
  return next;
}

function ensureStartUrlNavigation(ir: Record<string, unknown>, recording: RecordingPolicy, startUrl?: string): Record<string, unknown> {
  const nodes = isRecord(ir.nodes) ? { ...ir.nodes } : {};
  const currentStart = typeof ir.start === "string" ? ir.start : undefined;
  const openStart = nodes.open_start_url;
  if (!isStartUrlNavigationNode(openStart)) {
    nodes.open_start_url = {
      what: [{ action: "navigate", url_ref: "start_url" }],
      next: startAfterOpenStart(nodes, currentStart),
      policy: { recording },
      side_effect: { kind: "read_only" },
    };
  } else {
    nodes.open_start_url = finalizeNodeRecordingPolicy(openStart, recording);
  }

  return {
    ...ir,
    params_schema: ensureStartUrlParamSchema(ir.params_schema, startUrl),
    start: "open_start_url",
    nodes,
  };
}

function isStartUrlNavigationNode(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.what)) return false;
  return value.what.some((step) => isRecord(step) && step.action === "navigate" && step.url_ref === "start_url");
}

function startAfterOpenStart(nodes: Record<string, unknown>, currentStart: string | undefined): string {
  if (currentStart !== undefined && currentStart !== "open_start_url") return currentStart;
  if (isRecord(nodes.paginate_pages)) return "paginate_pages";
  if (isRecord(nodes.understand_request)) return "understand_request";
  const first = Object.keys(nodes).find((nodeId) => nodeId !== "open_start_url" && nodeId !== "done");
  return first ?? "done";
}

function ensureStartUrlParamSchema(value: unknown, startUrl?: string): Record<string, unknown> {
  const schema = isRecord(value) ? value : { type: "object", additionalProperties: true };
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const existingStartUrl = isRecord(properties.start_url) ? properties.start_url : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
  return {
    ...schema,
    type: "object",
    additionalProperties: schema.additionalProperties ?? true,
    properties: {
      ...properties,
      start_url: {
        ...existingStartUrl,
        type: "string",
        format: "uri",
        ...(startUrl !== undefined ? { default: startUrl } : {}),
      },
    },
    required: uniqueStrings([...required, "start_url"]),
  };
}

function parseGenerationBlockers(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "generation_blockers_invalid" });
  }
  const blockers: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "generation_blocker_invalid" });
    }
    blockers.push(item);
  }
  return blockers;
}

function cloneJsonRecord(value: unknown, reason: string): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(value)) as unknown;
  if (!isRecord(cloned)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
  }
  return cloned;
}

function startUrlFromParams(params: Record<string, unknown>): string | undefined {
  return typeof params.start_url === "string" && isHttpUrl(params.start_url) ? params.start_url : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function extractNode(input: {
  instruction: string;
  next: string;
  recording: RecordingPolicy;
  schemaRef: string;
}): Record<string, unknown> {
  return {
    what: [
      {
        action: "extract",
        instruction: input.instruction,
        schema_ref: input.schemaRef,
        args: {
          schema_version: "1",
          strict: true,
          schema: generatedExtractSchema(),
        },
      },
    ],
    next: input.next,
    policy: { recording: input.recording },
    side_effect: { kind: "read_only" },
  };
}

function paginateLoopNode(pagination: PaginationPlan, recording: RecordingPolicy): Record<string, unknown> {
  const maxPages = pagination.maxPages ?? DEFAULT_PAGINATION_MAX_PAGES;
  return {
    loop: {
      body_target: "extract_current_page",
      exit_target: "done",
      until: "loop.page_count >= params.max_pages",
      max_iterations: maxPages,
    },
    policy: { recording },
    side_effect: { kind: "read_only" },
  };
}

function generatedExtractSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "rows"],
    properties: {
      summary: { type: "string" },
      rows: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
        },
      },
    },
  };
}

function extractionInstruction(prompt: string): string {
  return [
    "사용자의 자연어 요청을 기준으로 화면에서 필요한 업무 결과를 추출한다.",
    "반환 형식은 { summary: string, rows: object[] } 이다.",
    "화면에 결과가 없으면 rows는 빈 배열로 두고 summary에 관찰 내용을 적는다.",
    `사용자 요청: ${prompt}`,
  ].join("\n");
}

function paginatedExtractionInstruction(prompt: string): string {
  return [
    "현재 페이지에 보이는 결과만 추출한다. 이전 페이지나 다음 페이지를 상상해 합치지 않는다.",
    "반복 실행 전체의 병합은 런타임이 담당한다. 각 페이지에서는 { summary: string, rows: object[] }만 반환한다.",
    "페이지에 결과가 없으면 rows는 빈 배열로 둔다.",
    `사용자 요청: ${prompt}`,
  ].join("\n");
}

function advancePageInstruction(prompt: string): string {
  return [
    "현재 페이지의 다음 페이지, next, 더보기, load more 버튼이나 링크가 있으면 한 번만 클릭한다.",
    "다음 페이지 컨트롤이 없거나 비활성화되어 있으면 아무 입력도 하지 않고 성공으로 끝낸다.",
    "데이터를 수정하거나 제출하거나 삭제하는 컨트롤은 클릭하지 않는다.",
    `사용자 요청: ${prompt}`,
  ].join("\n");
}

function paginationPlan(prompt: string, params: Record<string, unknown>): PaginationPlan {
  if (!looksLikePaginationPrompt(prompt)) return { enabled: false };
  const explicitParam = params.max_pages;
  const explicitPrompt = explicitParam === undefined ? promptMaxPages(prompt) : undefined;
  const requested = explicitParam ?? explicitPrompt ?? DEFAULT_PAGINATION_MAX_PAGES;
  if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 1) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_max_pages", min: 1, max: MAX_AUTO_PAGINATION_PAGES });
  }
  if (requested > MAX_AUTO_PAGINATION_PAGES) {
    params.max_pages = MAX_AUTO_PAGINATION_PAGES;
    return { enabled: true, maxPages: MAX_AUTO_PAGINATION_PAGES, blocker: "pagination_page_limit_exceeded" };
  }
  params.max_pages = requested;
  return { enabled: true, maxPages: requested };
}

function looksLikePaginationPrompt(prompt: string): boolean {
  return /(?:모든\s*페이지|전체\s*페이지|여러\s*페이지|다음\s*페이지|페이지마다|페이지네이션|더\s*보기|더보기|끝까지\s*(?:페이지|목록|결과)|(?:페이지|목록|결과)\s*끝까지|all\s+pages|every\s+page|next\s+page|pagination|load\s+more)/i.test(prompt);
}

function promptMaxPages(prompt: string): number | undefined {
  const patterns = [
    /(?:최대|처음|상위|앞)\s*(\d{1,3})\s*페이지/i,
    /(\d{1,3})\s*페이지(?:까지|만|분량|이내)/i,
    /(?:max|first|up to)\s*(\d{1,3})\s*pages?/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(prompt);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return undefined;
}

function recordingPolicy(evidence: EvidencePolicy): RecordingPolicy {
  // Action-level recording controls step screenshot capture only; run video is driven by meta.evidence.video.
  if (evidence.screenshot === "each_step") return "always";
  if (evidence.screenshot === "never") return "never";
  return "masked_on_failure";
}

function looksLikeSideEffectPrompt(prompt: string, options: { allowPaginationControls?: boolean } = {}): boolean {
  const text = options.allowPaginationControls ? stripBenignPaginationControls(prompt) : prompt;
  return /(클릭|입력|제출|등록|삭제|수정|업로드|다운로드|승인|반려|결재|보내|전송|구매|예약|click|type|submit|delete|update|upload|approve|reject|purchase|send)/i.test(text);
}

function stripBenignPaginationControls(prompt: string): string {
  return prompt
    .replace(/\bclick\s+(?:the\s+)?(?:next(?:\s+page)?|load\s+more|more)(?:\s+(?:button|link))?\b/gi, " ")
    .replace(/\b(?:next(?:\s+page)?|load\s+more|more)\s+(?:button|link)\s+click\b/gi, " ")
    .replace(/(?:다음\s*(?:페이지)?|더보기)\s*(?:버튼|링크)?(?:을|를)?\s*(?:클릭|눌러|선택)/g, " ")
    .replace(/(?:클릭|눌러|선택)\s*(?:해서|하여)?\s*(?:다음\s*(?:페이지)?|더보기)/g, " ");
}

function extractFirstHttpUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s"'<>]+/i);
  const candidate = match?.[0];
  if (candidate === undefined) return undefined;
  const trimmed = trimUrlProseSuffix(candidate);
  return isHttpUrl(trimmed) ? trimmed : undefined;
}

const URL_TRAILING_PROSE_PUNCTUATION = new Set([
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
  "。",
  "．",
  "，",
  "、",
  "；",
  "：",
  "！",
  "？",
  "…",
]);

const URL_TRAILING_CLOSERS = new Map([
  [")", "("],
  ["]", "["],
  ["}", "{"],
  ["）", "（"],
  ["】", "【"],
  ["」", "「"],
  ["』", "『"],
  ["》", "《"],
  ["〉", "〈"],
  ["”", "“"],
  ["’", "‘"],
]);

function trimUrlProseSuffix(value: string): string {
  let trimmed = value;
  while (trimmed.length > 0) {
    const char = lastChar(trimmed);
    if (char === undefined) break;
    if (URL_TRAILING_PROSE_PUNCTUATION.has(char)) {
      trimmed = trimLastChar(trimmed, char);
      continue;
    }
    const opener = URL_TRAILING_CLOSERS.get(char);
    if (opener !== undefined && hasUnmatchedClosingDelimiter(trimmed, opener, char)) {
      trimmed = trimLastChar(trimmed, char);
      continue;
    }
    break;
  }
  return trimmed;
}

function hasUnmatchedClosingDelimiter(value: string, opener: string, closer: string): boolean {
  let opens = 0;
  let closes = 0;
  for (const char of value) {
    if (char === opener) opens += 1;
    if (char === closer) closes += 1;
  }
  return closes > opens;
}

function lastChar(value: string): string | undefined {
  const chars = Array.from(value);
  return chars[chars.length - 1];
}

function trimLastChar(value: string, char: string): string {
  return value.slice(0, value.length - char.length);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function hostOfHttpUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isHostAllowed(host: string, allowedDomains: readonly string[]): boolean {
  const normalizedHost = host.toLowerCase();
  return allowedDomains.some((raw) => {
    const domain = raw.trim().toLowerCase();
    if (domain.length === 0) return false;
    if (domain.startsWith("*.")) {
      const suffix = domain.slice(2);
      return normalizedHost.length > suffix.length && normalizedHost.endsWith(`.${suffix}`);
    }
    return normalizedHost === domain;
  });
}

function isStrictIsoDateTime(value: string): boolean {
  const m = ISO_8601_RE.exec(value);
  if (m === null) return false;
  const d = new Date(value);
  return Number.isFinite(d.getTime());
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

function parseParamsContext(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function redactParamsContext(value: Record<string, unknown>): Record<string, unknown> {
  return redactParamsContextRecord(value);
}

function redactParamsContextRecord(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = redactParamsContextValue(key, child);
  }
  return out;
}

function redactParamsContextValue(key: string, value: unknown): unknown {
  if (isSensitiveParamKey(key)) return REDACTED_SCENARIO_GENERATION_PARAM;
  if (Array.isArray(value)) return value.map((item) => redactParamsContextValue(key, item));
  if (isRecord(value)) return redactParamsContextRecord(value);
  if (typeof value === "string" && value.includes("PlainSecret")) return REDACTED_SCENARIO_GENERATION_PARAM;
  return value;
}

function isSensitiveParamKey(key: string): boolean {
  return /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential)/i.test(key);
}

function containsRedactedParamsMarker(value: unknown): boolean {
  if (value === REDACTED_SCENARIO_GENERATION_PARAM) return true;
  if (Array.isArray(value)) return value.some((item) => containsRedactedParamsMarker(item));
  if (isRecord(value)) return Object.values(value).some((item) => containsRedactedParamsMarker(item));
  return false;
}

function redactGenerationDraftIr(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactGenerationDraftIr(item));
  if (!isRecord(value)) return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    redacted[key] = key === "instruction" && typeof child === "string"
      ? "[REDACTED:scenario_generation_instruction]"
      : redactGenerationDraftIr(child);
  }
  return redacted;
}

function parseListLimit(value: string | undefined): number {
  if (value === undefined) return 20;
  if (!/^\d+$/.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_limit" });
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_limit", min: 1, max: 100 });
  }
  return n;
}

function parseListCursor(value: string | undefined): { createdAt: string; id: string } | undefined {
  if (value === undefined || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      isRecord(parsed) &&
      typeof parsed.created_at === "string" &&
      Number.isFinite(Date.parse(parsed.created_at)) &&
      typeof parsed.id === "string" &&
      UUID_RE.test(parsed.id)
    ) {
      return { createdAt: parsed.created_at, id: parsed.id };
    }
  } catch {
    // fall through to uniform API error
  }
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_cursor" });
}

function parseGenerationStatusFilter(value: string | undefined): GenerationStatus | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (value === "drafted" || value === "saved" || value === "run_queued" || value === "blocked" || value === "failed") {
    return value;
  }
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_generation_status" });
}

function parseRunIdFilter(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (UUID_RE.test(value)) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_run_id" });
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
