/**
 * Scenario-generation LLM planner assembly for the production composition root (app/src/main.ts) —
 * SCENARIO_GENERATION_LLM_V1 활성 시 startApi 가 소비하는 in-process LlmGateway(Codex SSE primary) +
 * artifact sink + LLM call 멱등 store 바인딩.
 */
import { PgAiGovernanceGatewayGuard } from "./api/ai-governance-enforcement";
import { createLlmScenarioPlanner, LlmGatewayScenarioPlannerClient } from "./api/llm-scenario-planner";
import { BufferedScenarioGenerationArtifactSink } from "./api/scenario-generation-artifacts";
import {
  PgScenarioGenerationLlmCallIdempotencyStore,
  type ScenarioGenerationLlmCallCleanup,
} from "./api/scenario-generation-llm-call-idempotency-store";
import type { PgDurableSecurityAuditDecisionWriter } from "./api/security-audit";
import type { ApiConfig, ScenarioGenerationLlmV1Config } from "./config/env";
import type { PgPool } from "./db/pool";
import { AjvStructuredOutputValidator } from "./gateway/ajv-structured-output-validator";
import { SafeCapabilityGate } from "./gateway/capability-gate";
import { CodexSseAdapter } from "./gateway/codex-sse-adapter";
import { FetchCodexSseTransport } from "./gateway/codex-sse-transport";
import { buildGatewayArtifactObjectStore } from "./gateway/artifact-object-store-binding";
import { LlmGateway } from "./gateway/llm-gateway";
import { VaultSecretStore } from "./secrets/vault-secret-store";
import { VaultSecretStoreBoundary } from "./secrets/vault-secret-store-boundary";
import type { AuthenticatedPrincipal, PrincipalId, SecretStoreBoundary, TenantId } from "../../ts/security-middleware-contract";
import { DeterministicGatewayRedactionBoundary } from "../../gateway/redaction-boundary";
import type { PlainSecret, SecretRef, SecretStore } from "../../ts/core-types";
import type { ScenarioPlanner } from "./api/scenario-generation-types";
import type { ScenarioGenerationArtifactBuffer } from "./api/scenario-generation-artifacts";

export interface ScenarioGenerationPlannerBinding {
  readonly planner: ScenarioPlanner;
  readonly artifacts: ScenarioGenerationArtifactBuffer;
  readonly llmCalls: ScenarioGenerationLlmCallCleanup;
}

export async function buildScenarioGenerationPlannerBinding(
  pool: PgPool,
  cfg: ScenarioGenerationLlmV1Config,
  apiCfg: ApiConfig,
  securityAudit: PgDurableSecurityAuditDecisionWriter,
): Promise<ScenarioGenerationPlannerBinding> {
  const gw = cfg.gateway;
  const apiArtifactStoreSecretStore = buildApiGatewayArtifactSecretStore(gw, apiCfg, securityAudit);
  const artifactStore = await buildGatewayArtifactObjectStore(
    gw,
    apiArtifactStoreSecretStore !== undefined ? { secretStore: apiArtifactStoreSecretStore } : {},
  );
  const artifactSink = new BufferedScenarioGenerationArtifactSink(artifactStore, {
    retentionDays: gw.artifactRetentionDays,
  });
  const llmCalls = new PgScenarioGenerationLlmCallIdempotencyStore(pool, {
    retentionDays: gw.artifactRetentionDays,
    staleOpenReclaimMs: gw.wallTimeoutMs,
  });
  const gateway = new LlmGateway({
    primary: new CodexSseAdapter(
      new FetchCodexSseTransport({ baseUrl: gw.codexBaseUrl, apiKey: gw.codexApiKey, model: gw.codexModel }),
      {
        model: gw.codexModel,
        maxContextTokens: gw.codexMaxContextTokens,
        idleTimeoutMs: gw.idleTimeoutMs,
        wallTimeoutMs: gw.wallTimeoutMs,
        pricePer1kInputUsd: gw.pricePer1kInputUsd,
        pricePer1kOutputUsd: gw.pricePer1kOutputUsd,
      },
    ),
    gate: new SafeCapabilityGate(),
    validator: new AjvStructuredOutputValidator(),
    sink: artifactSink,
    idempotency: llmCalls,
    securityAudit,
    redactionBoundary: new DeterministicGatewayRedactionBoundary(),
    aiGovernance: new PgAiGovernanceGatewayGuard(pool),
    config: { retryMax: gw.retryMax, fallbackAttempts: gw.fallbackAttempts, repairAttempts: gw.repairAttempts },
  });
  return {
    planner: createLlmScenarioPlanner(
      new LlmGatewayScenarioPlannerClient(gateway, {
        model: gw.codexModel,
        promptTemplateVersion: cfg.promptTemplateVersion,
        budget: gw.budget,
      }),
    ),
    artifacts: artifactSink,
    llmCalls,
  };
}

function buildApiGatewayArtifactSecretStore(
  gw: ScenarioGenerationLlmV1Config["gateway"],
  cfg: ApiConfig,
  securityAudit: PgDurableSecurityAuditDecisionWriter,
): SecretStore | undefined {
  if (gw.artifactStore.mode === "fs") return undefined;
  const apiArtifactObjectStore = cfg.artifactObjectStore;
  if (apiArtifactObjectStore === undefined || apiArtifactObjectStore.objectStore.kind !== "s3") {
    throw new Error(
      "SCENARIO_GENERATION_LLM_V1 with GATEWAY_ARTIFACT_STORE_MODE=s3 requires ARTIFACT_OBJECT_STORE_KIND=s3 and VAULT_API_* config",
    );
  }
  if (
    apiArtifactObjectStore.objectStore.endpoint !== gw.artifactStore.endpoint ||
    apiArtifactObjectStore.objectStore.region !== gw.artifactStore.region ||
    apiArtifactObjectStore.objectStore.bucket !== gw.artifactStore.bucket ||
    apiArtifactObjectStore.objectStore.forcePathStyle !== gw.artifactStore.forcePathStyle
  ) {
    throw new Error("API artifact S3 reader config must match GATEWAY_ARTIFACT_STORE_MODE=s3 producer config");
  }
  const store = new VaultSecretStore({
    baseUrl: apiArtifactObjectStore.vaultApi.addr,
    mount: apiArtifactObjectStore.vaultApi.mount,
    kvApiVersion: 2,
    appRole: { roleId: apiArtifactObjectStore.vaultApi.roleId, secretId: apiArtifactObjectStore.vaultApi.secretId },
  });
  const boundary = new VaultSecretStoreBoundary({
    store,
    audit: securityAudit,
    enforceRefNamespace: true,
  });
  return new ObjectStoreBoundarySecretStore(boundary, apiObjectStorePrincipal());
}

class ObjectStoreBoundarySecretStore implements SecretStore {
  constructor(
    private readonly boundary: SecretStoreBoundary,
    private readonly principal: AuthenticatedPrincipal,
  ) {}

  resolve(ref: SecretRef): Promise<PlainSecret> {
    return this.boundary.resolveAuthorized({
      principal: this.principal,
      ref,
      purpose: "object_store",
    });
  }
}

function apiObjectStorePrincipal(): AuthenticatedPrincipal {
  return {
    subjectId: "api:scenario-generation-artifacts" as PrincipalId,
    tenantId: "00000000-0000-0000-0000-000000000000" as TenantId,
    roles: ["admin"],
    source: "jwt",
    claims: { runtime_identity: "api" },
  };
}
