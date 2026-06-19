/**
 * Fail-closed environment config loader for the production composition root (app/src/main.ts).
 *
 * Honors the repo invariant "조용한 false/unknown 금지": every required value (and every secret) MUST be
 * present or the process throws before constructing anything. There are NO silent defaults for secrets.
 * Non-secret operational knobs may carry an explicit documented default.
 *
 * This is the only place app code reads process.env for the production entrypoint (dev/serve.ts is dev-only).
 */

export type RunMode = "api" | "worker" | "all";

function req(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") {
    throw new Error(`missing required env ${name} (fail-closed config — refusing to start)`);
  }
  return v.trim();
}

function opt(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function num(name: string, dflt: number): number {
  const v = opt(name);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a finite number, got ${JSON.stringify(v)}`);
  return n;
}

function bool(name: string, dflt: boolean): boolean {
  const v = opt(name);
  if (v === undefined) return dflt;
  return v.toLowerCase() !== "false";
}

function strictBool(name: string, dflt: boolean): boolean {
  const v = opt(name);
  if (v === undefined) return dflt;
  const normalized = v.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`env ${name} must be true|false, got ${JSON.stringify(v)}`);
}

export function loadRunMode(): RunMode {
  const m = (opt("RUN_MODE") ?? "all").toLowerCase();
  if (m !== "api" && m !== "worker" && m !== "all") {
    throw new Error(`RUN_MODE must be one of api|worker|all, got ${JSON.stringify(m)}`);
  }
  return m;
}

export interface CommonConfig {
  /** RPA_ENV (e.g. staging|prod) — templates every SecretRef path rpa/<env>/<runtime>/<purpose>/<name>. */
  readonly rpaEnv: string;
  /** Explicit connection string for graphile-worker run()/runMigrations() (needs a string, not libpq env). */
  readonly connectionString: string;
  /** Unauthenticated health probe port (separate http server — bypasses the Fastify auth/RBAC chain). */
  readonly healthPort: number;
}

export function loadCommonConfig(): CommonConfig {
  // node-pg (createPool) reads PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD directly; graphile needs a URL.
  const connectionString = opt("DATABASE_URL") ?? buildPgConnString();
  return {
    rpaEnv: req("RPA_ENV"),
    connectionString,
    healthPort: num("HEALTH_PORT", 8081),
  };
}

function buildPgConnString(): string {
  const host = req("PGHOST");
  const port = opt("PGPORT") ?? "5432";
  const user = req("PGUSER");
  const password = req("PGPASSWORD");
  const database = req("PGDATABASE");
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

/**
 * JWT verification config. `JWKS_URL` selects the production RS256/JWKS verifier (keys fetched from the IdP);
 * absent → the v1 HS256 shared-secret default (dev/tests). Each mode is fail-closed on its own required value;
 * the algorithm/issuer/JWKS endpoint are deploy-config (auth-rbac.md fixes only the claims, not the algorithm).
 */
export type ApiJwtConfig =
  | { readonly mode: "hs256"; readonly secret: string }
  | { readonly mode: "jwks"; readonly jwksUrl: string; readonly issuer?: string; readonly audience?: string };

export interface ApiConfig {
  readonly port: number;
  readonly jwt: ApiJwtConfig;
  readonly signedCommandRegistry:
    | { readonly mode: "vault"; readonly vaultApi: VaultIdentityConfig; readonly sourceRef: string }
    | { readonly mode: "deny_all" };
  /** Console origin allowlist for CORS; omit for same-origin (no CORS registered). No wildcard. */
  readonly corsOrigins?: readonly string[];
  readonly hsts: boolean;
  /** Optional object-store root the API may read for audited artifact body/blob disclosure. */
  readonly artifactDir?: string;
  /** Enables natural-language scenario generation to request run-level masked WebM capture. */
  readonly videoRecordingEnabled: boolean;
}

function loadApiJwtConfig(): ApiJwtConfig {
  const jwksUrl = opt("JWKS_URL");
  if (jwksUrl !== undefined) {
    // RS256/JWKS mode: https-forced (IdP keys must not be fetched over cleartext).
    const issuer = opt("JWT_ISSUER");
    const audience = opt("JWT_AUDIENCE");
    return {
      mode: "jwks",
      jwksUrl: assertHttpsUrl("JWKS_URL", jwksUrl),
      ...(issuer !== undefined ? { issuer } : {}),
      ...(audience !== undefined ? { audience } : {}),
    };
  }
  // HS256 shared-secret mode (v1 default). Env-sourced — no `jwt` SecretRef purpose exists in the
  // least-privilege matrix yet (mirrors the gateway key gap, release-decisions D8-A16). Fail-closed required.
  const secret = req("JWT_HS256_SECRET");
  if (secret.length < 32) {
    throw new Error("JWT_HS256_SECRET must be at least 32 characters (HS256 key strength)");
  }
  return { mode: "hs256", secret };
}

function loadSignedCommandRegistryConfig(common: CommonConfig): ApiConfig["signedCommandRegistry"] {
  const mode = req("SIGNED_COMMAND_REGISTRY_MODE").toLowerCase();
  if (mode === "deny_all") {
    return { mode };
  }
  if (mode !== "vault") {
    throw new Error(`SIGNED_COMMAND_REGISTRY_MODE must be one of vault|deny_all, got ${JSON.stringify(mode)}`);
  }
  return {
    mode,
    vaultApi: loadVaultIdentity("API"),
    sourceRef: opt("SIGNED_COMMAND_REGISTRY_REF") ?? `rpa/${common.rpaEnv}/api/signed_command/registry`,
  };
}

export function loadApiConfig(common: CommonConfig, options: { readonly runMode?: RunMode } = {}): ApiConfig {
  const origins = opt("CORS_ORIGINS");
  const videoRecordingEnabled = strictBool("VISUAL_EVIDENCE_VIDEO_ENABLED", false);
  if (videoRecordingEnabled) {
    req("VISUAL_EVIDENCE_FFMPEG_PATH");
    if (options.runMode === "api" && !strictBool("VISUAL_EVIDENCE_VIDEO_WORKER_CONFIRMED", false)) {
      throw new Error("VISUAL_EVIDENCE_VIDEO_WORKER_CONFIRMED must be true when API-only mode advertises video recording");
    }
  }
  return {
    port: num("PORT", 8080),
    jwt: loadApiJwtConfig(),
    signedCommandRegistry: loadSignedCommandRegistryConfig(common),
    corsOrigins: origins
      ? origins.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined,
    hsts: bool("ENABLE_HSTS", true),
    artifactDir: opt("API_ARTIFACT_DIR") ?? opt("GATEWAY_ARTIFACT_DIR"),
    videoRecordingEnabled,
  };
}

export interface VaultIdentityConfig {
  readonly addr: string;
  readonly mount: string;
  readonly roleId: string;
  readonly secretId: string;
}

function loadVaultIdentity(prefix: string): VaultIdentityConfig {
  return {
    addr: req("VAULT_ADDR"),
    mount: opt("VAULT_MOUNT") ?? "secret",
    roleId: req(`VAULT_${prefix}_ROLE_ID`),
    secretId: req(`VAULT_${prefix}_SECRET_ID`),
  };
}

export interface WorkerConfig {
  /** AppRole identity for the runtime-worker (least-privilege: resume_token_hmac, executor). */
  readonly vaultRuntimeWorker: VaultIdentityConfig;
  /** SecretRef for the active resume-token HMAC signing key (HmacResumeTokenCodec). */
  readonly resumeTokenRef: string;
  /** SecretRef for the active browser session AES-256-GCM data key (base64/base64url encoded 32 bytes). */
  readonly browserSessionKeyRef: string;
  /** SecretRef identifier for the artifact-lifecycle object_store port binding. */
  readonly artifactObjectStoreRef: string;
  /** Non-secret object-store backend alias used in lifecycle evidence. */
  readonly artifactObjectStoreBackendAlias: string;
  readonly graphileSchema?: string;
  readonly graphileConcurrency: number;
  readonly graphilePollIntervalMs: number;
  readonly videoRecordingEnabled: boolean;
  readonly videoFfmpegPath?: string;
  readonly videoFrameIntervalMs: number;
  readonly videoFrameRate: number;
}

export function loadWorkerConfig(common: CommonConfig): WorkerConfig {
  const videoRecordingEnabled = strictBool("VISUAL_EVIDENCE_VIDEO_ENABLED", false);
  const videoFrameIntervalMs = num("VISUAL_EVIDENCE_VIDEO_FRAME_INTERVAL_MS", 1000);
  if (!Number.isInteger(videoFrameIntervalMs) || videoFrameIntervalMs <= 0) {
    throw new Error(`VISUAL_EVIDENCE_VIDEO_FRAME_INTERVAL_MS must be a positive integer, got ${videoFrameIntervalMs}`);
  }
  const videoFrameRate = num("VISUAL_EVIDENCE_VIDEO_FPS", Math.max(1, Math.round(1000 / videoFrameIntervalMs)));
  if (!Number.isInteger(videoFrameRate) || videoFrameRate <= 0) {
    throw new Error(`VISUAL_EVIDENCE_VIDEO_FPS must be a positive integer, got ${videoFrameRate}`);
  }
  return {
    vaultRuntimeWorker: loadVaultIdentity("RUNTIME_WORKER"),
    resumeTokenRef: `rpa/${common.rpaEnv}/runtime-worker/resume_token_hmac/active`,
    browserSessionKeyRef: `rpa/${common.rpaEnv}/runtime-worker/browser_session/active`,
    artifactObjectStoreRef: req("ARTIFACT_OBJECT_STORE_REF"),
    artifactObjectStoreBackendAlias: opt("ARTIFACT_OBJECT_STORE_BACKEND_ALIAS") ?? "fs-local",
    graphileSchema: opt("GRAPHILE_WORKER_SCHEMA"),
    graphileConcurrency: num("GRAPHILE_CONCURRENCY", 1),
    graphilePollIntervalMs: num("GRAPHILE_POLL_INTERVAL_MS", 2000),
    videoRecordingEnabled,
    ...(videoRecordingEnabled ? { videoFfmpegPath: req("VISUAL_EVIDENCE_FFMPEG_PATH") } : {}),
    videoFrameIntervalMs,
    videoFrameRate,
  };
}

/** API 세션 캡처 봉투암호화 설정 — api AppRole(Vault) + 활성 KEK SecretRef. */
export interface ApiSessionEncryptionConfig {
  readonly vault: VaultIdentityConfig;
  readonly kekRef: string;
}

/**
 * 세션 캡처(POST .../session/capture/complete) 봉투암호화 설정 — `VAULT_API_ROLE_ID` 가 있을 때만 활성(미설정 →
 * undefined → 엔드포인트 미등록, fail-closed). KEK 는 api identity 의 browser_session purpose namespace 에서 1회 해소.
 */
export function loadApiSessionEncryption(common: CommonConfig): ApiSessionEncryptionConfig | undefined {
  if (opt("VAULT_API_ROLE_ID") === undefined) return undefined;
  return {
    vault: loadVaultIdentity("API"),
    kekRef: `rpa/${common.rpaEnv}/api/browser_session/active`,
  };
}

/**
 * In-process LLM Gateway config for the worker (release-decisions D8-A16, owner-ratified).
 *
 * Secret-sourcing (NOT Vault, mirrors the JWT_HS256_SECRET gap): the D8-A12 least-privilege matrix defines
 * no SecretRef purpose for a raw LLM provider API key, so CODEX_* come from env. Object store = FsObjectStore
 * (GATEWAY_ARTIFACT_DIR) because the worker identity is not authorized for the `object_store` purpose
 * (artifact-lifecycle only). Operational knobs are ops-defaults §4/§6 fixed constants (per-tenant override is
 * gateway_policies, not entrypoint env); only deploy-varying provider facts + the artifact dir are env.
 */
export interface GatewayConfig {
  readonly codexBaseUrl: string;
  /** LLM provider API key — secret (env-sourced per D8-A16; never logged). */
  readonly codexApiKey: string;
  readonly codexModel: string;
  /** capabilities.maxContextTokens — conservative default until a live capability PoC confirms (D5 §19). */
  readonly codexMaxContextTokens: number;
  /** Per-1k token price (USD). 0 (default) = cost cap inactive, output-token cap still enforced (adapter §). */
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
    promptTemplateVersion: opt("SCENARIO_GENERATION_LLM_PROMPT_TEMPLATE_VERSION") ?? "scenario-planner@1",
  };
}

/**
 * HTTPS-forced URL (no localhost exception), matching the repo discipline for credentialed egress
 * (S3ObjectStore/VaultSecretStore). The Codex API key travels as a Bearer header, so plaintext http is
 * refused to prevent cleartext secret transmission.
 */
/** Validate a given value is an absolute https URL (no localhost exception) — cleartext refused for
 *  credentialed/key-bearing endpoints (S3/Vault store discipline; Codex Bearer key; JWKS key fetch). */
function assertHttpsUrl(name: string, v: string): string {
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    throw new Error(`env ${name} must be an absolute URL, got ${JSON.stringify(v)}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`env ${name} must be an https URL (no plaintext), got protocol ${JSON.stringify(parsed.protocol)}`);
  }
  return v;
}

function reqHttpsUrl(name: string): string {
  return assertHttpsUrl(name, req(name));
}

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
    // ops-defaults §4 — v1 fixed (override layer is gateway_policies, not entrypoint env).
    idleTimeoutMs: 20_000,
    wallTimeoutMs: 120_000,
    retryMax: 2,
    fallbackAttempts: 1,
    repairAttempts: 1,
    artifactDir: req("GATEWAY_ARTIFACT_DIR"),
    artifactRetentionDays: num("GATEWAY_ARTIFACT_RETENTION_DAYS", 90), // ops-defaults §6 retention_default
    budget: {
      maxInputTokens: Math.floor(codexMaxContextTokens * 0.9), // ops-defaults §4: 90% of maxContextTokens
      maxOutputTokens: 4096, // ops-defaults §4 llm.budget.max_output_tokens
      maxCost: 0.85, // ops-defaults §4 llm.budget.max_cost_per_run
    },
    promptTemplateVersion: opt("PROMPT_TEMPLATE_VERSION") ?? "dom-executor@1",
  };
}

/**
 * Browser session provider config for the worker (backlog item 2 — activates the assembled executorFactory).
 *
 * The StagehandBrowserSessionProvider launches a fresh real Chrome per lease at bind() time, so the only
 * deploy-varying fact is the Chrome executable path (required, fail-closed — never a silent default for a
 * binary that must exist for any run to drive). headless + download root are operational knobs with defaults.
 */
export interface BrowserConfig {
  /** Real Chrome executable path (deploy-time; bind() launches it per lease). */
  readonly chromeExecutablePath: string;
  readonly headless: boolean;
  /** Per-lease download directory root (defaults to OS tmp inside the provider when unset). */
  readonly downloadRootDir?: string;
}

export function loadBrowserConfig(): BrowserConfig {
  const downloadRootDir = opt("BROWSER_DOWNLOAD_ROOT_DIR");
  return {
    chromeExecutablePath: req("CHROME_EXECUTABLE_PATH"),
    headless: bool("BROWSER_HEADLESS", true),
    ...(downloadRootDir !== undefined ? { downloadRootDir } : {}),
  };
}
