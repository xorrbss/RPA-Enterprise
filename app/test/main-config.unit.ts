/**
 * Production composition-root config loader (app/src/config/env.ts) — fail-closed unit test.
 *
 * Locks the "조용한 false/unknown 금지" guarantee for the prod entrypoint: every required value/secret throws
 * when missing or blank; only non-secret operational knobs carry documented defaults. Prevents silent
 * regression of the fail-closed config (adversarial-review recommendation).
 */
import {
  loadApiConfig,
  loadCommonConfig,
  loadGatewayConfig,
  loadRunMode,
  loadScenarioGenerationLlmV1Config,
  loadWorkerConfig,
  type CommonConfig,
} from "../src/config/env";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
  }
}
function expectThrow(label: string, fn: () => unknown): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  check(label, threw, "expected throw, got none");
}

const CLEAR = [
  "RPA_ENV", "RUN_MODE", "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "DATABASE_URL",
  "PORT", "JWT_HS256_SECRET", "CORS_ORIGINS", "ENABLE_HSTS", "HEALTH_PORT", "VAULT_ADDR", "VAULT_MOUNT",
  "VAULT_RUNTIME_WORKER_ROLE_ID", "VAULT_RUNTIME_WORKER_SECRET_ID", "VAULT_API_ROLE_ID", "VAULT_API_SECRET_ID",
  "SIGNED_COMMAND_REGISTRY_MODE", "SIGNED_COMMAND_REGISTRY_REF",
  "ARTIFACT_OBJECT_STORE_REF", "ARTIFACT_OBJECT_STORE_BACKEND_ALIAS",
  "GRAPHILE_WORKER_SCHEMA", "GRAPHILE_CONCURRENCY", "GRAPHILE_POLL_INTERVAL_MS",
  "CODEX_BASE_URL", "CODEX_API_KEY", "CODEX_MODEL", "CODEX_MAX_CONTEXT_TOKENS",
  "CODEX_PRICE_PER_1K_INPUT_USD", "CODEX_PRICE_PER_1K_OUTPUT_USD",
  "API_ARTIFACT_DIR", "GATEWAY_ARTIFACT_DIR", "GATEWAY_ARTIFACT_RETENTION_DAYS", "PROMPT_TEMPLATE_VERSION",
  "SCENARIO_GENERATION_LLM_V1_ENABLED", "SCENARIO_GENERATION_LLM_PROMPT_TEMPLATE_VERSION",
  "JWKS_URL", "JWT_ISSUER", "JWT_AUDIENCE",
  "VISUAL_EVIDENCE_VIDEO_ENABLED", "VISUAL_EVIDENCE_VIDEO_WORKER_CONFIRMED", "VISUAL_EVIDENCE_FFMPEG_PATH",
  "VISUAL_EVIDENCE_VIDEO_FRAME_INTERVAL_MS", "VISUAL_EVIDENCE_VIDEO_FPS",
];

function withEnv(vars: Record<string, string>, fn: () => void): void {
  const snapshot: Record<string, string | undefined> = {};
  for (const k of CLEAR) {
    snapshot[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, vars);
  try {
    fn();
  } finally {
    for (const k of CLEAR) delete process.env[k];
    for (const [k, v] of Object.entries(snapshot)) if (v !== undefined) process.env[k] = v;
  }
}

const FULL: Record<string, string> = {
  RPA_ENV: "staging", PGHOST: "h", PGPORT: "5432", PGUSER: "u", PGPASSWORD: "p", PGDATABASE: "d",
  PORT: "8080", JWT_HS256_SECRET: "x".repeat(40), VAULT_ADDR: "https://v:8200",
  VAULT_RUNTIME_WORKER_ROLE_ID: "r", VAULT_RUNTIME_WORKER_SECRET_ID: "s",
  ARTIFACT_OBJECT_STORE_REF: "rpa/staging/artifact-lifecycle/object_store/fs",
  SIGNED_COMMAND_REGISTRY_MODE: "deny_all",
};
const API_COMMON: CommonConfig = { rpaEnv: "staging", connectionString: "x", healthPort: 8081 };

function main(): void {
  // RUN_MODE
  withEnv({}, () => check("RUN_MODE default all", loadRunMode() === "all"));
  withEnv({ RUN_MODE: "api" }, () => check("RUN_MODE api", loadRunMode() === "api"));
  withEnv({ RUN_MODE: "bogus" }, () => expectThrow("RUN_MODE invalid throws", () => loadRunMode()));

  // CommonConfig — fail-closed on missing PG; conn string built + encoded; DATABASE_URL override.
  withEnv({}, () => expectThrow("common missing PG/RPA_ENV throws", () => loadCommonConfig()));
  withEnv(FULL, () => {
    const c = loadCommonConfig();
    check("common rpaEnv", c.rpaEnv === "staging");
    check("common conn string from PG*", c.connectionString === "postgresql://u:p@h:5432/d", c.connectionString);
    check("common healthPort default 8081", c.healthPort === 8081);
  });
  withEnv({ ...FULL, DATABASE_URL: "postgresql://x@y/z" }, () =>
    check("DATABASE_URL override", loadCommonConfig().connectionString === "postgresql://x@y/z"));

  // ApiConfig — HS256 default mode: fail-closed on missing/short JWT secret; CORS parse; HSTS default.
  withEnv({ ...FULL, SIGNED_COMMAND_REGISTRY_MODE: "" }, () =>
    expectThrow("api missing signed command registry mode throws", () => loadApiConfig(API_COMMON)));
  withEnv({ ...FULL, SIGNED_COMMAND_REGISTRY_MODE: "bogus" }, () =>
    expectThrow("api invalid signed command registry mode throws", () => loadApiConfig(API_COMMON)));
  withEnv({ ...FULL, JWT_HS256_SECRET: "" }, () => expectThrow("api blank JWT throws", () => loadApiConfig(API_COMMON)));
  withEnv({ ...FULL, JWT_HS256_SECRET: "short" }, () => expectThrow("api short JWT (<32) throws", () => loadApiConfig(API_COMMON)));
  withEnv(FULL, () => {
    const a = loadApiConfig(API_COMMON);
    check("api port", a.port === 8080);
    check("api hsts default true", a.hsts === true);
    check("api cors undefined when unset", a.corsOrigins === undefined);
    check("api jwt mode hs256 (no JWKS_URL)", a.jwt.mode === "hs256");
    check("api jwt hs256 secret carried", a.jwt.mode === "hs256" && a.jwt.secret.length === 40);
    check("api signed command registry explicit deny_all", a.signedCommandRegistry.mode === "deny_all");
    check("api artifactDir undefined when unset", a.artifactDir === undefined);
    check("api video recording capability default false", a.videoRecordingEnabled === false);
  });
  withEnv({ ...FULL, VISUAL_EVIDENCE_VIDEO_ENABLED: "true" }, () =>
    expectThrow("api video enabled without ffmpeg path throws", () => loadApiConfig(API_COMMON)));
  withEnv({ ...FULL, VISUAL_EVIDENCE_VIDEO_ENABLED: "maybe" }, () =>
    expectThrow("api video enabled flag must be true|false", () => loadApiConfig(API_COMMON)));
  withEnv({ ...FULL, VISUAL_EVIDENCE_VIDEO_ENABLED: "true", VISUAL_EVIDENCE_FFMPEG_PATH: "C:\\tools\\ffmpeg.exe" }, () =>
    check("api video recording capability enabled with ffmpeg path", loadApiConfig(API_COMMON).videoRecordingEnabled === true));
  withEnv({ ...FULL, VISUAL_EVIDENCE_VIDEO_ENABLED: "true", VISUAL_EVIDENCE_FFMPEG_PATH: "C:\\tools\\ffmpeg.exe" }, () =>
    expectThrow("api-only video enabled without worker confirmation throws", () => loadApiConfig(API_COMMON, { runMode: "api" })));
  withEnv({ ...FULL, VISUAL_EVIDENCE_VIDEO_ENABLED: "true", VISUAL_EVIDENCE_FFMPEG_PATH: "C:\\tools\\ffmpeg.exe", VISUAL_EVIDENCE_VIDEO_WORKER_CONFIRMED: "false" }, () =>
    expectThrow("api-only video enabled with false worker confirmation throws", () => loadApiConfig(API_COMMON, { runMode: "api" })));
  withEnv({ ...FULL, VISUAL_EVIDENCE_VIDEO_ENABLED: "true", VISUAL_EVIDENCE_FFMPEG_PATH: "C:\\tools\\ffmpeg.exe", VISUAL_EVIDENCE_VIDEO_WORKER_CONFIRMED: "maybe" }, () =>
    expectThrow("api-only video worker confirmation must be true|false", () => loadApiConfig(API_COMMON, { runMode: "api" })));
  withEnv({ ...FULL, VISUAL_EVIDENCE_VIDEO_ENABLED: "true", VISUAL_EVIDENCE_FFMPEG_PATH: "C:\\tools\\ffmpeg.exe", VISUAL_EVIDENCE_VIDEO_WORKER_CONFIRMED: "true" }, () =>
    check("api-only video enabled with worker confirmation", loadApiConfig(API_COMMON, { runMode: "api" }).videoRecordingEnabled === true));
  withEnv({ ...FULL, API_ARTIFACT_DIR: "/var/lib/rpa/api-artifacts" }, () =>
    check("api artifactDir uses API_ARTIFACT_DIR", loadApiConfig(API_COMMON).artifactDir === "/var/lib/rpa/api-artifacts"));
  withEnv({ ...FULL, GATEWAY_ARTIFACT_DIR: "/var/lib/rpa/gw-artifacts" }, () =>
    check("api artifactDir falls back to GATEWAY_ARTIFACT_DIR", loadApiConfig(API_COMMON).artifactDir === "/var/lib/rpa/gw-artifacts"));
  withEnv({ ...FULL, API_ARTIFACT_DIR: "/api", GATEWAY_ARTIFACT_DIR: "/gateway" }, () =>
    check("api artifactDir prefers API_ARTIFACT_DIR", loadApiConfig(API_COMMON).artifactDir === "/api"));
  withEnv({
    ...FULL,
    SIGNED_COMMAND_REGISTRY_MODE: "vault",
    VAULT_API_ROLE_ID: "api-role",
    VAULT_API_SECRET_ID: "api-secret",
  }, () => {
    const a = loadApiConfig(API_COMMON);
    check("api signed command registry vault mode", a.signedCommandRegistry.mode === "vault");
    check(
      "api signed command registry sourceRef templated",
      a.signedCommandRegistry.mode === "vault" &&
        a.signedCommandRegistry.sourceRef === "rpa/staging/api/signed_command/registry",
      a.signedCommandRegistry.mode === "vault" ? a.signedCommandRegistry.sourceRef : a.signedCommandRegistry.mode,
    );
    check(
      "api signed command registry vault identity carried",
      a.signedCommandRegistry.mode === "vault" && a.signedCommandRegistry.vaultApi.roleId === "api-role",
    );
  });
  withEnv({
    ...FULL,
    SIGNED_COMMAND_REGISTRY_MODE: "vault",
    VAULT_API_ROLE_ID: "api-role",
    VAULT_API_SECRET_ID: "api-secret",
    SIGNED_COMMAND_REGISTRY_REF: "rpa/custom/api/signed_command/registry",
  }, () => {
    const a = loadApiConfig(API_COMMON);
    check(
      "api signed command registry custom sourceRef carried",
      a.signedCommandRegistry.mode === "vault" &&
        a.signedCommandRegistry.sourceRef === "rpa/custom/api/signed_command/registry",
    );
  });

  // ApiConfig — JWKS/RS256 mode: JWKS_URL present selects jwks (HS256 secret NOT required); https-forced; iss/aud optional.
  const JWKS = "https://idp.example/.well-known/jwks.json";
  withEnv({ PORT: "8080", JWKS_URL: JWKS, SIGNED_COMMAND_REGISTRY_MODE: "deny_all" }, () => {
    const a = loadApiConfig(API_COMMON);
    check("api jwt mode jwks", a.jwt.mode === "jwks");
    check("api jwks url carried", a.jwt.mode === "jwks" && a.jwt.jwksUrl === JWKS);
    check("api jwks iss/aud undefined when unset", a.jwt.mode === "jwks" && a.jwt.issuer === undefined && a.jwt.audience === undefined);
  });
  withEnv({ JWKS_URL: JWKS, JWT_ISSUER: "https://idp.example/", JWT_AUDIENCE: "rpa-control-plane", SIGNED_COMMAND_REGISTRY_MODE: "deny_all" }, () => {
    const a = loadApiConfig(API_COMMON);
    check("api jwks issuer carried", a.jwt.mode === "jwks" && a.jwt.issuer === "https://idp.example/");
    check("api jwks audience carried", a.jwt.mode === "jwks" && a.jwt.audience === "rpa-control-plane");
  });
  withEnv({ JWKS_URL: "http://idp.example/jwks" }, () =>
    expectThrow("api jwks plaintext http JWKS_URL throws", () => loadApiConfig(API_COMMON)));
  withEnv({ JWKS_URL: "not-a-url" }, () =>
    expectThrow("api jwks non-URL JWKS_URL throws", () => loadApiConfig(API_COMMON)));
  withEnv({ ...FULL, CORS_ORIGINS: "https://a.example, https://b.example" }, () => {
    const a = loadApiConfig(API_COMMON);
    check("api cors parsed", a.corsOrigins?.length === 2 && a.corsOrigins[0] === "https://a.example");
  });

  // WorkerConfig — fail-closed on missing Vault AppRole; resumeTokenRef templated from rpaEnv.
  const common: CommonConfig = { rpaEnv: "staging", connectionString: "x", healthPort: 8081 };
  withEnv({}, () => expectThrow("worker missing Vault AppRole throws", () => loadWorkerConfig(common)));
  withEnv({ ...FULL, ARTIFACT_OBJECT_STORE_REF: "" }, () =>
    expectThrow("worker missing artifact object-store SecretRef throws", () => loadWorkerConfig(common)));
  withEnv(FULL, () => {
    const w = loadWorkerConfig(common);
    check(
      "worker resumeTokenRef templated",
      w.resumeTokenRef === "rpa/staging/runtime-worker/resume_token_hmac/active",
      w.resumeTokenRef,
    );
    check(
      "worker artifact object-store SecretRef carried",
      w.artifactObjectStoreRef === "rpa/staging/artifact-lifecycle/object_store/fs",
      w.artifactObjectStoreRef,
    );
    check("worker artifact backend alias default", w.artifactObjectStoreBackendAlias === "fs-local");
    check("worker concurrency default 1", w.graphileConcurrency === 1);
    check("worker video recording default false", w.videoRecordingEnabled === false);
    check("worker video frame defaults", w.videoFrameIntervalMs === 1000 && w.videoFrameRate === 1);
  });
  withEnv({ ...FULL, VISUAL_EVIDENCE_VIDEO_ENABLED: "true" }, () =>
    expectThrow("worker video enabled without ffmpeg path throws", () => loadWorkerConfig(common)));
  withEnv({ ...FULL, VISUAL_EVIDENCE_VIDEO_ENABLED: "maybe" }, () =>
    expectThrow("worker video enabled flag must be true|false", () => loadWorkerConfig(common)));
  withEnv({ ...FULL, VISUAL_EVIDENCE_VIDEO_FRAME_INTERVAL_MS: "0" }, () =>
    expectThrow("worker video non-positive frame interval throws", () => loadWorkerConfig(common)));
  withEnv({ ...FULL, VISUAL_EVIDENCE_VIDEO_FPS: "0" }, () =>
    expectThrow("worker video non-positive fps throws", () => loadWorkerConfig(common)));
  withEnv({
    ...FULL,
    VISUAL_EVIDENCE_VIDEO_ENABLED: "true",
    VISUAL_EVIDENCE_FFMPEG_PATH: "C:\\tools\\ffmpeg.exe",
    VISUAL_EVIDENCE_VIDEO_FRAME_INTERVAL_MS: "500",
    VISUAL_EVIDENCE_VIDEO_FPS: "2",
  }, () => {
    const w = loadWorkerConfig(common);
    check("worker video enabled carries ffmpeg path", w.videoRecordingEnabled === true && w.videoFfmpegPath === "C:\\tools\\ffmpeg.exe");
    check("worker video cadence overrides carried", w.videoFrameIntervalMs === 500 && w.videoFrameRate === 2);
  });
  withEnv({ ...FULL, ARTIFACT_OBJECT_STORE_BACKEND_ALIAS: "fs-staging-a" }, () =>
    check("worker artifact backend alias override", loadWorkerConfig(common).artifactObjectStoreBackendAlias === "fs-staging-a"));

  // GatewayConfig (D8-A16) — fail-closed on missing Codex provider creds / artifact dir; ops-defaults knobs.
  const GW_REQ = {
    CODEX_BASE_URL: "https://api.example/v1", CODEX_API_KEY: "sk-test", CODEX_MODEL: "gpt-x",
    GATEWAY_ARTIFACT_DIR: "/var/lib/rpa/gw-artifacts",
  };
  withEnv({}, () => expectThrow("gateway missing CODEX_BASE_URL throws", () => loadGatewayConfig()));
  withEnv({ ...GW_REQ, CODEX_API_KEY: "" }, () =>
    expectThrow("gateway blank CODEX_API_KEY throws", () => loadGatewayConfig()));
  withEnv({ ...GW_REQ, CODEX_MODEL: "" }, () =>
    expectThrow("gateway blank CODEX_MODEL throws", () => loadGatewayConfig()));
  withEnv({ CODEX_BASE_URL: "https://api.example/v1", CODEX_API_KEY: "k", CODEX_MODEL: "m" }, () =>
    expectThrow("gateway missing GATEWAY_ARTIFACT_DIR throws", () => loadGatewayConfig()));
  withEnv({ ...GW_REQ, CODEX_BASE_URL: "not-a-url" }, () =>
    expectThrow("gateway non-URL CODEX_BASE_URL throws", () => loadGatewayConfig()));
  withEnv({ ...GW_REQ, CODEX_BASE_URL: "http://api.example/v1" }, () =>
    expectThrow("gateway plaintext http CODEX_BASE_URL throws (Bearer key cleartext)", () => loadGatewayConfig()));
  withEnv({ ...GW_REQ, CODEX_BASE_URL: "ftp://api.example" }, () =>
    expectThrow("gateway non-https CODEX_BASE_URL throws", () => loadGatewayConfig()));
  withEnv({ ...GW_REQ, CODEX_MAX_CONTEXT_TOKENS: "0" }, () =>
    expectThrow("gateway non-positive CODEX_MAX_CONTEXT_TOKENS throws", () => loadGatewayConfig()));
  withEnv(GW_REQ, () => {
    const g = loadGatewayConfig();
    check("gateway maxContextTokens default 8192", g.codexMaxContextTokens === 8192);
    check("gateway price defaults 0 (cost cap inactive)", g.pricePer1kInputUsd === 0 && g.pricePer1kOutputUsd === 0);
    check("gateway ops-defaults knobs", g.retryMax === 2 && g.idleTimeoutMs === 20_000 && g.wallTimeoutMs === 120_000);
    check("gateway budget maxInputTokens = 90% maxContextTokens", g.budget.maxInputTokens === 7372, String(g.budget.maxInputTokens));
    check("gateway budget output/cost ops-defaults", g.budget.maxOutputTokens === 4096 && g.budget.maxCost === 0.85);
    check("gateway retention default 90", g.artifactRetentionDays === 90);
    check("gateway promptTemplateVersion default", g.promptTemplateVersion === "dom-executor@1");
  });
  withEnv({}, () =>
    check("scenario generation llm_v1 default disabled without CODEX env", loadScenarioGenerationLlmV1Config() === undefined));
  withEnv({ SCENARIO_GENERATION_LLM_V1_ENABLED: "false" }, () =>
    check("scenario generation llm_v1 explicit false disabled", loadScenarioGenerationLlmV1Config() === undefined));
  withEnv({ SCENARIO_GENERATION_LLM_V1_ENABLED: "yes" }, () =>
    expectThrow("scenario generation llm_v1 invalid flag throws", () => loadScenarioGenerationLlmV1Config()));
  withEnv({ SCENARIO_GENERATION_LLM_V1_ENABLED: "true" }, () =>
    expectThrow("scenario generation llm_v1 true without gateway env throws", () => loadScenarioGenerationLlmV1Config()));
  withEnv({ ...GW_REQ, SCENARIO_GENERATION_LLM_V1_ENABLED: "true" }, () => {
    const c = loadScenarioGenerationLlmV1Config();
    check("scenario generation llm_v1 true loads gateway config", c?.gateway.codexModel === "gpt-x");
    check("scenario generation llm_v1 prompt version default", c?.promptTemplateVersion === "scenario-planner@1");
  });
  withEnv({
    ...GW_REQ,
    SCENARIO_GENERATION_LLM_V1_ENABLED: "true",
    SCENARIO_GENERATION_LLM_PROMPT_TEMPLATE_VERSION: "scenario-planner@2",
  }, () => {
    const c = loadScenarioGenerationLlmV1Config();
    check("scenario generation llm_v1 prompt version override", c?.promptTemplateVersion === "scenario-planner@2");
  });

  if (failures > 0) {
    console.error(`\nmain-config.unit: ${failures} FAIL`);
    process.exit(1);
  }
  console.log("\nmain-config.unit: ALL PASS");
}

main();
