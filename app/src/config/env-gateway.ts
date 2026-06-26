import { assertHttpsUrl, num, opt, req, reqHttpsUrl, strictBool } from "./env-primitives";

/**
 * In-process LLM Gateway config for the worker (release-decisions D8-A16, owner-ratified).
 *
 * Secret-sourcing (NOT Vault, mirrors the JWT_HS256_SECRET gap): the D8-A12 least-privilege matrix defines
 * no SecretRef purpose for a raw LLM provider API key, so CODEX_* come from env. Gateway/runtime artifacts
 * default to FsObjectStore and can explicitly switch to a SecretRef-backed S3 producer store
 * for staging. Operational knobs are ops-defaults 짠4/짠6 fixed constants (per-tenant override is
 * gateway_policies, not entrypoint env); only deploy-varying provider facts + the artifact store are env.
 */
export type GatewayArtifactStoreMode = "fs" | "s3";

export type GatewayArtifactStoreConfig =
  | {
      readonly mode: "fs";
      /** FsObjectStore root for gateway output artifacts. */
      readonly artifactDir: string;
    }
  | {
      readonly mode: "s3";
      readonly endpoint: string;
      readonly region: string;
      readonly bucket: string;
      readonly accessKeyId: string;
      /** SecretRef for the S3-compatible secret access key. */
      readonly secretAccessKeyRef: string;
      /** Non-secret object-store backend alias used in release/preflight evidence. */
      readonly backendAlias: string;
      readonly forcePathStyle: boolean;
    };

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
  /** Runtime/gateway artifact producer object store. */
  readonly artifactStore: GatewayArtifactStoreConfig;
  /** Back-compat convenience for fs mode only. Prefer artifactStore. */
  readonly artifactDir?: string;
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
  const artifactStore = loadGatewayArtifactStoreConfig();
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
    artifactStore,
    ...(artifactStore.mode === "fs" ? { artifactDir: artifactStore.artifactDir } : {}),
    artifactRetentionDays: num("GATEWAY_ARTIFACT_RETENTION_DAYS", 90), // ops-defaults 짠6 retention_default
    budget: {
      maxInputTokens: Math.floor(codexMaxContextTokens * 0.9), // ops-defaults 짠4: 90% of maxContextTokens
      maxOutputTokens: 4096, // ops-defaults 짠4 llm.budget.max_output_tokens
      maxCost: 0.85, // ops-defaults 짠4 llm.budget.max_cost_per_run
    },
    promptTemplateVersion: opt("PROMPT_TEMPLATE_VERSION") ?? "dom-executor@1",
  };
}

function loadGatewayArtifactStoreConfig(): GatewayArtifactStoreConfig {
  const mode = gatewayArtifactStoreMode();
  if (mode === "fs") {
    return { mode, artifactDir: req("GATEWAY_ARTIFACT_DIR") };
  }
  return {
    mode,
    secretAccessKeyRef: reqGatewayArtifactObjectStoreRef("GATEWAY_ARTIFACT_OBJECT_STORE_REF"),
    endpoint: assertHttpsUrl(
      "GATEWAY_ARTIFACT_OBJECT_STORE_S3_ENDPOINT",
      opt("GATEWAY_ARTIFACT_OBJECT_STORE_S3_ENDPOINT") ?? req("ARTIFACT_OBJECT_STORE_S3_ENDPOINT"),
    ),
    region: reqGatewayS3Value("GATEWAY_ARTIFACT_OBJECT_STORE_S3_REGION", "ARTIFACT_OBJECT_STORE_S3_REGION"),
    bucket: reqGatewayS3Value("GATEWAY_ARTIFACT_OBJECT_STORE_S3_BUCKET", "ARTIFACT_OBJECT_STORE_S3_BUCKET"),
    accessKeyId: reqGatewayS3Value("GATEWAY_ARTIFACT_OBJECT_STORE_S3_ACCESS_KEY_ID", "ARTIFACT_OBJECT_STORE_S3_ACCESS_KEY_ID"),
    backendAlias: opt("GATEWAY_ARTIFACT_OBJECT_STORE_BACKEND_ALIAS") ?? opt("ARTIFACT_OBJECT_STORE_BACKEND_ALIAS") ?? "s3-compatible",
    forcePathStyle: strictBool(
      "GATEWAY_ARTIFACT_OBJECT_STORE_S3_FORCE_PATH_STYLE",
      strictBool("ARTIFACT_OBJECT_STORE_S3_FORCE_PATH_STYLE", true),
    ),
  };
}

function gatewayArtifactStoreMode(): GatewayArtifactStoreMode {
  const raw = opt("GATEWAY_ARTIFACT_STORE_MODE") ?? "fs";
  const normalized = raw.toLowerCase().replace(/-/g, "_");
  if (normalized === "fs" || normalized === "local_fs") return "fs";
  if (normalized === "s3" || normalized === "s3_compatible") return "s3";
  throw new Error(`GATEWAY_ARTIFACT_STORE_MODE must be one of fs|s3|s3-compatible, got ${JSON.stringify(raw)}`);
}

function reqGatewayS3Value(primary: string, fallback: string): string {
  return opt(primary) ?? req(fallback);
}

function reqGatewayArtifactObjectStoreRef(name: string): string {
  const ref = req(name);
  const parts = ref.split("/");
  const rpaEnv = req("RPA_ENV").toLowerCase();
  if (
    parts.length < 5 ||
    parts.some((part) => part.length === 0) ||
    parts[0] !== "rpa" ||
    parts[2] !== "runtime-worker" ||
    parts[3] !== "object_store"
  ) {
    throw new Error(
      `env ${name} must be a SecretRef under rpa/<env>/runtime-worker/object_store/<name>, got ${JSON.stringify(ref)}`,
    );
  }
  if (parts[1] !== rpaEnv) {
    throw new Error(
      `env ${name} SecretRef env segment must match RPA_ENV=${JSON.stringify(rpaEnv)}, got ${JSON.stringify(parts[1])}`,
    );
  }
  return ref;
}
