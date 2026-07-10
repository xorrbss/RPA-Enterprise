/**
 * 말로 고치기(revise) 라우트 (F1/v2.37) — POST /v1/scenario-generations/{generationId}/revise.
 *
 * 서버가 원장에서 prompt_redacted·params_context·evidence_policy·planner/model 을 로드해
 * `${prompt_redacted}\n\n[수정 요청] ${instruction}` 합성 프롬프트로 기존 planAndCompileScenario
 * 파이프라인(AJV + IREL + V1~V13 동일 경계)을 재실행하고, persistGeneration 의 revise 분기로
 * 기존 시나리오에 version=head+1 draft 를 원자 저장한다(설계 §1 D2/D3). target 은 head IR 에서
 * 회수(run 경로 parseTarget(baseIr.target) 선례), start_url 은 params_context 에서 승계한다.
 * 의존: scenario-generations(planAndCompileScenario)·store(persistGeneration)·failed-ledger·
 * scenarios-support(signedCommandRefsFor) — 단방향(본 모듈을 역참조하는 곳 없음).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { ERROR_CATALOG } from "../../../ts/error-catalog";
import type { CanonicalRequestHash, IdempotencyKey } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { ApiResponseError } from "../runtime/errors";
import { canonicalRequestHash, completeIdempotencyInTx, idempotencyRecordRowId } from "./idempotency";
import { apiErrorBody, isRecord, type CommandResponse } from "./command";
import { extractFirstHttpUrl, isHttpUrl } from "./scenario-generation-url";
import {
  parseEvidencePolicy,
  parseGenerationReviseRequest,
  parseParamsContext,
  parseScenarioPlannerId,
  parseTarget,
} from "./scenario-generation-parse";
import { upsertFailedGenerationLedger } from "./scenario-generation-failed-ledger";
import { persistGeneration } from "./scenario-generation-store";
import {
  IDEMPOTENCY_TTL_MS,
  planAndCompileScenario,
  ScenarioGenerationPlanningError,
  type PlannedCompileResult,
} from "./scenario-generations";
import { signedCommandRefsFor } from "./scenarios-support";
import { requirePrincipal, UUID_RE, type ApiServerDeps } from "./server-shared";
import type { GenerationRequest } from "./scenario-generation-types";

const MAX_PROMPT_LENGTH = 20000;

/** 합성 프롬프트: 저장된 redaction 통과본 + 수정 지시. 총길이 상한은 생성 POST 의 prompt_too_long 과 동일. */
export function synthesizeRevisePrompt(promptRedacted: string, instruction: string): string {
  const prompt = `${promptRedacted}\n\n[수정 요청] ${instruction}`;
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "prompt_too_long", max: MAX_PROMPT_LENGTH });
  }
  return prompt;
}

interface ReviseSourceGeneration {
  prompt_redacted: string;
  planner: string;
  model: string | null;
  params_context: unknown;
  evidence_policy: unknown;
  scenario_id: string;
}

interface ReviseScenarioHead {
  name: string;
  version: number;
  ir: unknown;
}

interface ReviseSource {
  generation: ReviseSourceGeneration;
  head: ReviseScenarioHead;
}

async function loadReviseSource(client: PoolClient, tenantId: string, generationId: string): Promise<ReviseSource> {
  const result = await client.query<{
    prompt_redacted: string | null;
    planner: string;
    model: string | null;
    params_context: unknown;
    evidence_policy: unknown;
    scenario_id: string | null;
  }>(
    `SELECT prompt_redacted, planner, model, params_context, evidence_policy, scenario_id
       FROM scenario_generations
      WHERE id=$1::uuid`,
    [generationId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND");
  }
  if (row.scenario_id === null) {
    // draft_only 였거나 저장 실패(failed ledger) — 수정을 얹을 시나리오가 없다(조용한 신규 생성 금지).
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "scenario_not_persisted" });
  }
  if (row.prompt_redacted === null) {
    // prompt_redacted 영속(v2.37) 이전 구세대 원장 — 원본 요청이 보존되지 않아 서버 합성이 불가능하다.
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "prompt_not_retained" });
  }
  const head = await client.query<{ name: string; version: number; ir: unknown }>(
    `SELECT s.name, sv.version, sv.ir
       FROM scenarios s
       JOIN scenario_versions sv ON sv.tenant_id=s.tenant_id AND sv.scenario_id=s.id
      WHERE s.tenant_id=$1::uuid AND s.id=$2::uuid AND s.archived_at IS NULL
      ORDER BY sv.version DESC
      LIMIT 1`,
    [tenantId, row.scenario_id],
  );
  const headRow = head.rows[0];
  if (headRow === undefined) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND");
  }
  return {
    generation: { ...row, prompt_redacted: row.prompt_redacted, scenario_id: row.scenario_id },
    head: headRow,
  };
}

/**
 * §8-⑦: evidence_policy/planner/model 은 원 generation 값을 그대로 승계한다(예외는 P2 — 구현하지 않음).
 * §8-①: start_url 은 params_context(양 플래너가 params.start_url 로 스탬프, 비민감 키라 redaction 생존),
 *   target 은 head IR(draftIr.target — run 경로 선례)에서 회수한다. 원장 컬럼 확장 불필요.
 */
function buildReviseGenerationRequest(source: ReviseSource, prompt: string): GenerationRequest {
  const params = parseParamsContext(source.generation.params_context);
  const startUrl =
    typeof params.start_url === "string" && isHttpUrl(params.start_url) ? params.start_url : extractFirstHttpUrl(prompt);
  const planner = parseScenarioPlannerId(source.generation.planner);
  return {
    prompt,
    name: source.head.name,
    mode: "save",
    ...(planner !== undefined ? { planner } : {}),
    ...(startUrl !== undefined ? { startUrl } : {}),
    target: parseTarget(isRecord(source.head.ir) ? source.head.ir.target : undefined),
    params,
    model: source.generation.model,
    evidence: parseEvidencePolicy(source.generation.evidence_policy),
  };
}

export function registerScenarioGenerationReviseRoute(app: FastifyInstance, deps: ApiServerDeps): void {
  app.post<{ Params: { generationId: string } }>(
    "/v1/scenario-generations/:generationId/revise",
    { config: { rbacAction: "scenario.create" } },
    async (request, reply) => {
      const result = await reviseScenarioGeneration(deps, request.params.generationId, request);
      reply.code(result.status).send(result.body);
    },
  );
}

async function reviseScenarioGeneration(
  deps: ApiServerDeps,
  generationId: string,
  request: FastifyRequest,
): Promise<CommandResponse> {
  const principal = requirePrincipal(request);
  if (!UUID_RE.test(generationId)) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND");
  }
  const parsed = parseGenerationReviseRequest(request.body);
  const idempotencyKey = request.headers["idempotency-key"];
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_idempotency_key", header: "Idempotency-Key" });
  }

  const requestHash = canonicalRequestHash("POST", `/v1/scenario-generations/${generationId}/revise`, request.body ?? null);
  const reservation = await deps.idempotency.reserve({
    tenantId: principal.tenantId,
    endpoint: "reviseScenarioGeneration",
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
  const newGenerationId = idempotencyRecordRowId(recordId);
  let reviseRequest: GenerationRequest | undefined;
  let planned: PlannedCompileResult | undefined;
  try {
    const source = await withTenantTx(deps.pool, principal.tenantId, (client) =>
      loadReviseSource(client, principal.tenantId, generationId),
    );
    // 선행 base_version 대조(빠른 실패) — 권위 대조는 persistGeneration 이 저장 tx 안에서 head 를 재확인한다.
    if (source.head.version !== parsed.baseVersion) {
      throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", {
        reason: "base_version_mismatch",
        currentVersion: source.head.version,
      });
    }
    const prompt = synthesizeRevisePrompt(source.generation.prompt_redacted, parsed.instruction);
    reviseRequest = buildReviseGenerationRequest(source, prompt);
    const signedCommandRefs = await signedCommandRefsFor(deps, principal, "scenario.save");
    planned = await planAndCompileScenario(deps, reviseRequest, signedCommandRefs, {
      tenantId: principal.tenantId,
      correlationId: request.correlationId,
      generationId: newGenerationId,
      principal: { subjectId: principal.subjectId, roles: principal.roles },
    });
    const { plan, compiled } = planned;

    const response = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
      const response = await persistGeneration(client, deps, principal, request.correlationId, newGenerationId, plan, compiled, {
        scenarioId: source.generation.scenario_id,
        baseVersion: parsed.baseVersion,
        signedCommandRefs,
      });
      await completeIdempotencyInTx(client, recordId, response);
      return response;
    });
    await deps.scenarioGenerationArtifacts?.commitGenerationArtifacts(newGenerationId);
    return response;
  } catch (err) {
    await deps.scenarioGenerationArtifacts?.discardGenerationArtifacts(newGenerationId);
    await deps.scenarioGenerationLlmCalls?.discardGenerationLlmCalls({
      tenantId: principal.tenantId,
      generationId: newGenerationId,
    });
    const planningError = err instanceof ScenarioGenerationPlanningError ? err : undefined;
    const apiError = planningError?.apiError ?? (err instanceof ApiResponseError ? err : undefined);
    if (apiError !== undefined && !ERROR_CATALOG[apiError.code].retryable) {
      // 실제 생성 시도(합성 요청 구성 이후) 실패만 failed ledger 에 남긴다 — 소스 조회/버전 대조 거부는
      //   generateScenario 의 parse-단계 거부와 동형으로 ledger 를 만들지 않는다(충돌 스팸 방지).
      const failedRequest = reviseRequest;
      if (failedRequest !== undefined) {
        await withTenantTx(deps.pool, principal.tenantId, (client) =>
          upsertFailedGenerationLedger(client, {
            generationId: newGenerationId,
            principal,
            request: failedRequest,
            apiError,
            failedPlan: planningError?.failedPlan ?? planned?.plan,
            failedCompile: planningError?.failedCompile ?? planned?.compiled,
          }),
        );
      }
      await deps.idempotency.saveFailure(recordId, apiErrorBody(apiError, request.correlationId));
    }
    throw apiError ?? err;
  }
}
