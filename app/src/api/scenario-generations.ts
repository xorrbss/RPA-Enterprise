/**
 * Natural-language scenario generation MVP.
 *
 * This is intentionally a deterministic planner first: it turns a prompt plus
 * explicit execution hints into a contract-valid IR, then reuses the existing
 * scenario save and run-create pipeline. A future LLM planner can implement the
 * same ScenarioPlanner port while preserving validation, persistence, RBAC, and idempotency.
 */

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
import { apiErrorBody, isRecord, type CommandResponse } from "./command";
import { extractFirstHttpUrl, hostOfHttpUrl, isHostAllowed, isHttpUrl } from "./scenario-generation-url";
import { parseGenerationRequest, parseGenerationRunRequest, parseGenerationStatusFilter, parseListCursor, parseListLimit, parseRunIdFilter, UUID_RE } from "./scenario-generation-parse";
import { DEFAULT_PAGINATION_MAX_PAGES, MAX_AUTO_PAGINATION_PAGES, recordingPolicy, type RecordingPolicy } from "./scenario-generation-policy";
import { finalizeDraftIrEvidence, looksLikeSideEffectPrompt, paginationPlan, scenarioPlannerFor } from "./scenario-generation-planner";
import { inferRuntimeTargetForRequest } from "./scenario-generation-target";
import { encodeListCursor, loadGenerationForRun, loadScenarioVersionIrForRun, mapGenerationRow, persistGeneration, persistGenerationRun, type ScenarioGenerationRow } from "./scenario-generation-store";
import { upsertFailedGenerationLedger } from "./scenario-generation-failed-ledger";
import { requirePrincipal, type ApiServerDeps } from "./server";
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

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PLANNER_REPAIR_ATTEMPTS = 1;

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
        scenarioGenerationCapabilities(deps).videoRecording,
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
    if (trustedRequest.target === undefined) {
      blockers.add("target_required_for_auto_run");
      if (trustedRequest.inferenceBlocker !== undefined) blockers.add(trustedRequest.inferenceBlocker);
    }
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
