/**
 * Gateway policy mutation route (A2 — api-surface §6, release-decisions D8-A2).
 *
 * `PUT /v1/gateway/policy` — admin(`gateway_policy.edit`)-only optimistic-concurrency 갱신.
 *  - `If-Match`(현재 version) 필수 → `(tenant_id, model, version)` CAS; 미존재/불일치 → POLICY_VERSION_CONFLICT(412).
 *  - `Idempotency-Key` 필수(runIdempotentCommand) — 재제출 시 부작용 재실행 없이 최초 응답 재생.
 *  - PUT-time coherence는 **구조적 토큰 정합만** 결정형 검사: budget.maxInputTokens/maxOutputTokens가
 *    capabilities.maxContextTokens를 초과하면 LLM_CAPABILITY_MISMATCH(422). 의미적 모델-능력 정합(모델이
 *    실제 jsonMode를 지원하는지 등)은 라이브 caps 의존 → call-time SafeCapabilityGate + D5 라이브 PoC 소유.
 *  - "조용한 false 금지": 형식 무효/미존재/불일치를 명시 코드로 표면화.
 */
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import { runIdempotentCommand, isRecord, type CommandResponse } from "./command";
import { ApiResponseError } from "./errors";
import { requirePrincipal, type ApiServerDeps } from "./server";

interface PolicyBody {
  model: string;
  capabilities: Record<string, unknown>;
  budget: Record<string, unknown>;
  fallbackConfig: Record<string, unknown> | null;
  maxContextTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}

const TOP_LEVEL_KEYS = new Set(["model", "capabilities", "budget", "fallback_config"]);

export function registerGatewayRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  // PUT /v1/gateway/policy — 정책 갱신(api-surface §6). If-Match + Idempotency-Key + admin RBAC.
  app.put("/v1/gateway/policy", { config: { rbacAction: "gateway_policy.edit" } }, async (request, reply) => {
    // (1) body 형상 선검사(멱등 키 소모 이전 — malformed는 키를 쓰지 않는다).
    const body = parsePolicyBody(request.body);

    // (2) If-Match(version) 필수. ETag 대상은 gateway_policies.version(api-surface §6 / §0.3).
    const expectedVersion = parseIfMatch(request.headers["if-match"]);
    if (expectedVersion === undefined) {
      throw new ApiResponseError("POLICY_VERSION_CONFLICT", { reason: "missing_if_match" });
    }

    // (3) 구조적 토큰 coherence(키 소모 이전). 토큰 예산이 모델 컨텍스트를 초과하면 정의 불가(D8-A2).
    if (body.maxInputTokens > body.maxContextTokens || body.maxOutputTokens > body.maxContextTokens) {
      throw new ApiResponseError("LLM_CAPABILITY_MISMATCH", {
        reason: "budget_exceeds_max_context_tokens",
        maxContextTokens: body.maxContextTokens,
      });
    }

    const principal = requirePrincipal(request);
    const result = await runIdempotentCommand(
      deps,
      request,
      "updateGatewayPolicy",
      "/v1/gateway/policy",
      (client, tenantId) => applyPolicyUpdate(client, tenantId, principal.subjectId, body, expectedVersion),
    );
    reply.code(result.status);
    if (isRecord(result.body) && typeof result.body.version === "number") {
      reply.header("ETag", String(result.body.version));
    }
    reply.send(result.body);
  });
}

/**
 * (tenant_id, model, version) CAS 갱신. version+1, capabilities/budget/fallback 교체. 0 rows면
 * 미존재 정책 또는 version 불일치 → POLICY_VERSION_CONFLICT(412) (조용한 false 금지, 최신 재조회 유도).
 */
async function applyPolicyUpdate(
  client: PoolClient,
  tenantId: string,
  updatedBy: string,
  body: PolicyBody,
  expectedVersion: number,
): Promise<CommandResponse> {
  const updated = await client.query<{ version: number }>(
    `UPDATE gateway_policies
        SET capabilities = $4::jsonb,
            budget = $5::jsonb,
            fallback_config = $6::jsonb,
            version = version + 1,
            updated_by = $7::uuid,
            updated_at = now()
      WHERE tenant_id = $1::uuid AND model = $2 AND version = $3
    RETURNING version`,
    [
      tenantId,
      body.model,
      expectedVersion,
      JSON.stringify(body.capabilities),
      JSON.stringify(body.budget),
      body.fallbackConfig !== null ? JSON.stringify(body.fallbackConfig) : null,
      updatedBy,
    ],
  );
  if (updated.rowCount === 0) {
    // RLS가 타테넌트 정책을 숨기므로 cross-tenant도 동일하게 미존재 → 412(최신 재조회 후 재시도).
    throw new ApiResponseError("POLICY_VERSION_CONFLICT", { reason: "if_match_mismatch_or_absent", expectedVersion });
  }
  return {
    status: 200,
    body: {
      model: body.model,
      version: updated.rows[0].version,
      capabilities: body.capabilities,
      budget: body.budget,
      fallback: body.fallbackConfig,
    },
  };
}

/** 닫힌 shape 검증 + coherence에 필요한 수치 추출. 무효 → IR_SCHEMA_INVALID(422, 키 소모 이전). */
function parsePolicyBody(raw: unknown): PolicyBody {
  if (!isRecord(raw)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  }
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unknown_field", field: key });
    }
  }
  const model = raw.model;
  if (typeof model !== "string" || model.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "model_required" });
  }
  const capabilities = raw.capabilities;
  if (!isRecord(capabilities)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "capabilities_object_required" });
  }
  const budget = raw.budget;
  if (!isRecord(budget)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "budget_object_required" });
  }
  const maxContextTokens = positiveInt(capabilities.maxContextTokens, "capabilities.maxContextTokens");
  const maxInputTokens = nonNegativeNumber(budget.maxInputTokens, "budget.maxInputTokens");
  const maxOutputTokens = nonNegativeNumber(budget.maxOutputTokens, "budget.maxOutputTokens");
  nonNegativeNumber(budget.maxCost, "budget.maxCost"); // 형식 검증만(coherence엔 미사용).
  let fallbackConfig: Record<string, unknown> | null = null;
  if (raw.fallback_config !== undefined && raw.fallback_config !== null) {
    if (!isRecord(raw.fallback_config)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "fallback_config_object_required" });
    }
    fallbackConfig = raw.fallback_config;
  }
  return { model, capabilities, budget, fallbackConfig, maxContextTokens, maxInputTokens, maxOutputTokens };
}

function positiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "positive_integer_required", field });
  }
  return value;
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "non_negative_number_required", field });
  }
  return value;
}

/** If-Match → version(int). 약한 ETag 접두/따옴표 허용. scenarios.ts parseIfMatch와 동일 규약. */
function parseIfMatch(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/^W\//, "").replace(/^"|"$/g, "");
  const parsed = Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}
