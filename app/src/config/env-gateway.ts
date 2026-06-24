import { num, opt, req, reqHttpsUrl, strictBool } from "./env-primitives";

/**
 * In-process LLM Gateway config for the worker (release-decisions D8-A16, owner-ratified).
 *
 * Secret-sourcing (NOT Vault, mirrors the JWT_HS256_SECRET gap): the D8-A12 least-privilege matrix defines
 * no SecretRef purpose for a raw LLM provider API key, so CODEX_* come from env. Object store = FsObjectStore
 * (GATEWAY_ARTIFACT_DIR) because the worker identity is not authorized for the `object_store` purpose
 * (artifact-lifecycle only). Operational knobs are ops-defaults 짠4/짠6 fixed constants (per-tenant override is
 * gateway_policies, not entrypoint env); only deploy-varying provider facts + the artifact dir are env.
 */
export interface GatewayConfig {
  readonly codexBaseUrl: string;
  /** LLM provider API key ??secret (env-sourced per D8-A16; never logged). */
  readonly codexApiKey: string;
  readonly codexModel: string;
  /** capabilities.maxContextTokens ??conservative default until a live capability PoC confirms (D5 짠19). */
  readonly codexMaxContextTokens: number;
  /** Per-1k token price (USD). 0 (default) = cost cap inactive, output-token cap still enforced (adapter 짠). */
  readonly pricePer1kInputUsd: number;
  readonly pricePer1kOutputUsd: number;
  readonly idleTimeoutMs: number;
  readonly wallTimeoutMs: number;
  readonly retryMax: number;
  readonly fallbackAttempts: number;
  readonly repairAttempts: number;
  /** FsObjectStore root for gateway output artifacts (D8-A16: FS, not S3, in v1). */
  readonly artifactDir: string;
  readonly artifactRetentionDays: number;
  readonly budget: { readonly maxInputTokens: number; readonly maxOutputTokens: number; readonly maxCost: number };
  readonly promptTemplateVersion: string;
}

export interface ScenarioGenerationLlmV1Config {
  readonly gateway: GatewayConfig;
  readonly promptTemplateVersion: string;
}

export function loadScenarioGenerationLlmV1Config(): ScenarioGenerationLlmV1Config | undefined {
  if (!strictBool("SCENARIO_GENERATION_LLM_V1_ENABLED", false)) return undefined;
  return {
    gateway: loadGatewayConfig(),
    promptTemplateVersion: opt("SCENARIO_GENERATION_LLM_PROMPT_TEMPLATE_VERSION") ?? "scenario-planner@2",
  };
}

/**
 * HTTPS-forced URL (no localhost exception), matching the repo discipline for credentialed egress
 * (S3ObjectStore/VaultSecretStore). The Codex API key travels as a Bearer header, so plaintext http is
 * refused to prevent cleartext secret transmission.
 */
export function loadGatewayConfig(): GatewayConfig {
  const codexMaxContextTokens = num("CODEX_MAX_CONTEXT_TOKENS", 8192);
  if (!Number.isInteger(codexMaxContextTokens) || codexMaxContextTokens <= 0) {
    throw new Error(`CODEX_MAX_CONTEXT_TOKENS must be a positive integer, got ${codexMaxContextTokens}`);
  }
  return {
    codexBaseUrl: reqHttpsUrl("CODEX_BASE_URL"),
    codexApiKey: req("CODEX_API_KEY"),
    codexModel: req("CODEX_MODEL"),
    codexMaxContextTokens,
    pricePer1kInputUsd: num("CODEX_PRICE_PER_1K_INPUT_USD", 0),
    pricePer1kOutputUsd: num("CODEX_PRICE_PER_1K_OUTPUT_USD", 0),
    // ops-defaults 짠4 ??v1 fixed (override layer is gateway_policies, not entrypoint env).
    idleTimeoutMs: 20_000,
    wallTimeoutMs: 120_000,
    retryMax: 2,
    fallbackAttempts: 1,
    repairAttempts: 1,
    artifactDir: req("GATEWAY_ARTIFACT_DIR"),
    artifactRetentionDays: num("GATEWAY_ARTIFACT_RETENTION_DAYS", 90), // ops-defaults 짠6 retention_default
    budget: {
      maxInputTokens: Math.floor(codexMaxContextTokens * 0.9), // ops-defaults 짠4: 90% of maxContextTokens
      maxOutputTokens: 4096, // ops-defaults 짠4 llm.budget.max_output_tokens
      maxCost: 0.85, // ops-defaults 짠4 llm.budget.max_cost_per_run
    },
    promptTemplateVersion: opt("PROMPT_TEMPLATE_VERSION") ?? "dom-executor@1",
  };
}
