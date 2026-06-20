/**
 * Production composition-root config loader (app/src/config/env.ts) — fail-closed unit test.
 *
 * Locks the "조용한 false/unknown 금지" guarantee for the prod entrypoint: every required value/secret throws
 * when missing or blank; only non-secret operational knobs carry documented defaults. Prevents silent
 * regression of the fail-closed config (adversarial-review recommendation).
 */
import {
  assertArtifactStoreTopologyCompatibility,
  assertInProcessArtifactStoreCompatibility,
  loadApiConfig,
  loadArtifactLifecycleWorkerConfig,
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
  "WORKER_ID", "ARTIFACT_LIFECYCLE_DATABASE_URL", "ARTIFACT_LIFECYCLE_WORKER_ID",
  "ARTIFACT_LIFECYCLE_GRAPHILE_CONCURRENCY", "ARTIFACT_LIFECYCLE_GRAPHILE_POLL_INTERVAL_MS",
  "PORT", "JWT_HS256_SECRET", "CORS_ORIGINS", "ENABLE_HSTS", "HEALTH_PORT", "VAULT_ADDR", "VAULT_MOUNT",
  "VAULT_RUNTIME_WORKER_ROLE_ID", "VAULT_RUNTIME_WORKER_SECRET_ID", "VAULT_API_ROLE_ID", "VAULT_API_SECRET_ID",
  "SIGNED_COMMAND_REGISTRY_MODE", "SIGNED_COMMAND_REGISTRY_REF",
  "ARTIFACT_OBJECT_STORE_REF", "ARTIFACT_OBJECT_STORE_KIND", "ARTIFACT_OBJECT_STORE_BACKEND_ALIAS",
  "S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_FORCE_PATH_STYLE",
  "ARTIFACT_LIFECYCLE_OBJECT_STORE_MODE",
  "ARTIFACT_OBJECT_STORE_S3_ENDPOINT", "ARTIFACT_OBJECT_STORE_S3_REGION", "ARTIFACT_OBJECT_STORE_S3_BUCKET",
  "ARTIFACT_OBJECT_STORE_S3_ACCESS_KEY_ID", "ARTIFACT_OBJECT_STORE_S3_FORCE_PATH_STYLE",
  "GRAPHILE_WORKER_SCHEMA", "GRAPHILE_CONCURRENCY", "GRAPHILE_POLL_INTERVAL_MS", "MAINTENANCE_TENANT_IDS",
  "SINK_DELIVERY_MAX_ATTEMPTS", "SINK_DELIVERY_RETRY_AFTER_MS",
  "CODEX_BASE_URL", "CODEX_API_KEY", "CODEX_MODEL", "CODEX_MAX_CONTEXT_TOKENS",
  "CODEX_PRICE_PER_1K_INPUT_USD", "CODEX_PRICE_PER_1K_OUTPUT_USD",
  "API_ARTIFACT_DIR", "GATEWAY_ARTIFACT_DIR", "GATEWAY_ARTIFACT_RETENTION_DAYS", "PROMPT_TEMPLATE_VERSION",
  "SCENARIO_GENERATION_LLM_V1_ENABLED", "SCENARIO_GENERATION_LLM_PROMPT_TEMPLATE_VERSION",
  "JWKS_URL", "JWT_ISSUER", "JWT_AUDIENCE",
  "VISUAL_EVIDENCE_VIDEO_ENABLED", "VISUAL_EVIDENCE_VIDEO_WORKER_CONFIRMED", "VISUAL_EVIDENCE_FFMPEG_PATH",
  "VISUAL_EVIDENCE_VIDEO_FRAME_INTERVAL_MS", "VISUAL_EVIDENCE_VIDEO_FPS",
  "VAULT_ARTIFACT_LIFECYCLE_ROLE_ID", "VAULT_ARTIFACT_LIFECYCLE_SECRET_ID",
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
  WORKER_ID: "10000000-0000-4000-8000-0000000000aa",
  PORT: "8080", JWT_HS256_SECRET: "x".repeat(40), VAULT_ADDR: "https://v:8200",
  VAULT_RUNTIME_WORKER_ROLE_ID: "r", VAULT_RUNTIME_WORKER_SECRET_ID: "s",
  VAULT_ARTIFACT_LIFECYCLE_ROLE_ID: "artifact-role", VAULT_ARTIFACT_LIFECYCLE_SECRET_ID: "artifact-secret",
  ARTIFACT_OBJECT_STORE_REF: "rpa/staging/artifact-lifecycle/object_store/s3",
  ARTIFACT_OBJECT_STORE_S3_ENDPOINT: "https://s3.example.internal",
  ARTIFACT_OBJECT_STORE_S3_REGION: "ap-northeast-2",
  ARTIFACT_OBJECT_STORE_S3_BUCKET: "rpa-artifacts",
  ARTIFACT_OBJECT_STORE_S3_ACCESS_KEY_ID: "rpa-lifecycle-access-key-id",
  SIGNED_COMMAND_REGISTRY_MODE: "deny_all",
};
const API_COMMON: CommonConfig = { rpaEnv: "staging", connectionString: "x", healthPort: 8081 };

function main(): void {
  // RUN_MODE
  withEnv({}, () => check("RUN_MODE default all", loadRunMode() === "all"));
  withEnv({ RUN_MODE: "api" }, () => check("RUN_MODE api", loadRunMode() === "api"));
  withEnv({ RUN_MODE: "lifecycle-worker" }, () => check("RUN_MODE lifecycle-worker", loadRunMode() === "lifecycle-worker"));
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
  withEnv({ ...FULL, API_ARTIFACT_DIR: "/var/lib/rpa/artifacts", GATEWAY_ARTIFACT_DIR: "/var/lib/rpa/artifacts" }, () =>
    check("api artifactDir accepts shared API/GATEWAY root", loadApiConfig(API_COMMON).artifactDir === "/var/lib/rpa/artifacts"));
  withEnv({ ...FULL, API_ARTIFACT_DIR: "/api", GATEWAY_ARTIFACT_DIR: "/gateway" }, () =>
    expectThrow("api artifactDir rejects API/GATEWAY drift", () => loadApiConfig(API_COMMON)));
  withEnv({
    ...FULL,
    ARTIFACT_OBJECT_STORE_KIND: "s3",
    ARTIFACT_OBJECT_STORE_REF: "rpa/staging/artifact-lifecycle/object_store/s3",
    S3_ENDPOINT: "https://s3.example",
    S3_REGION: "ap-northeast-2",
    S3_BUCKET: "rpa-artifacts",
    S3_ACCESS_KEY_ID: "s3-access-id",
  }, () =>
    expectThrow("api artifact s3 reader requires API Vault AppRole", () => loadApiConfig(API_COMMON)));
  withEnv({
    ...FULL,
    ARTIFACT_OBJECT_STORE_KIND: "s3",
    ARTIFACT_OBJECT_STORE_REF: "rpa/staging/artifact-lifecycle/object_store/s3",
    VAULT_API_ROLE_ID: "api-role",
    VAULT_API_SECRET_ID: "api-secret",
    S3_ENDPOINT: "https://s3.example",
    S3_REGION: "ap-northeast-2",
    S3_BUCKET: "rpa-artifacts",
    S3_ACCESS_KEY_ID: "s3-access-id",
    S3_FORCE_PATH_STYLE: "false",
  }, () => {
    const a = loadApiConfig(API_COMMON);
    check("api artifact s3 reader config present", a.artifactObjectStore?.objectStore.kind === "s3");
    check(
      "api artifact s3 reader config carried",
      a.artifactObjectStore?.objectStore.kind === "s3" &&
        a.artifactObjectStore.objectStore.endpoint === "https://s3.example" &&
        a.artifactObjectStore.objectStore.region === "ap-northeast-2" &&
        a.artifactObjectStore.objectStore.bucket === "rpa-artifacts" &&
        a.artifactObjectStore.objectStore.accessKeyId === "s3-access-id" &&
        a.artifactObjectStore.objectStore.forcePathStyle === false &&
        a.artifactObjectStore.objectStoreRef === "rpa/staging/artifact-lifecycle/object_store/s3",
      JSON.stringify(a.artifactObjectStore),
    );
    check("api artifact s3 reader vault identity carried", a.artifactObjectStore?.vaultApi.roleId === "api-role");
  });
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
  withEnv({ ...FULL, WORKER_ID: "" }, () =>
    expectThrow("worker missing stable WORKER_ID throws", () => loadWorkerConfig(common)));
  withEnv({ ...FULL, ARTIFACT_OBJECT_STORE_REF: "" }, () =>
    check("control worker does not require lifecycle object-store SecretRef", loadWorkerConfig(common).workerId === FULL.WORKER_ID));
  withEnv(FULL, () => {
    const w = loadWorkerConfig(common);
    check("worker stable workerId carried", w.workerId === "10000000-0000-4000-8000-0000000000aa");
    check(
      "worker resumeTokenRef templated",
      w.resumeTokenRef === "rpa/staging/runtime-worker/resume_token_hmac/active",
      w.resumeTokenRef,
    );
    check("worker has no lifecycle artifact SecretRef config", !("artifactObjectStoreRef" in w));
    check("worker concurrency default 1", w.graphileConcurrency === 1);
    check("worker maintenance tenant list default empty", w.maintenanceTenantIds.length === 0);
    check("worker sink delivery policy defaults", w.sinkDeliveryMaxAttempts === 3 && w.sinkDeliveryRetryAfterMs === 5000);
    check("worker video recording default false", w.videoRecordingEnabled === false);
    check("worker video frame defaults", w.videoFrameIntervalMs === 1000 && w.videoFrameRate === 1);
  });
  withEnv({ ...FULL, SINK_DELIVERY_MAX_ATTEMPTS: "5", SINK_DELIVERY_RETRY_AFTER_MS: "2500" }, () => {
    const w = loadWorkerConfig(common);
    check("worker sink delivery policy overrides carried", w.sinkDeliveryMaxAttempts === 5 && w.sinkDeliveryRetryAfterMs === 2500);
  });
  withEnv({ ...FULL, SINK_DELIVERY_MAX_ATTEMPTS: "0" }, () =>
    expectThrow("worker sink delivery max attempts rejects non-positive", () => loadWorkerConfig(common)));
  withEnv({ ...FULL, SINK_DELIVERY_RETRY_AFTER_MS: "1.5" }, () =>
    expectThrow("worker sink delivery retry-after rejects fractional", () => loadWorkerConfig(common)));
  withEnv({ ...FULL, MAINTENANCE_TENANT_IDS: "00000000-0000-4000-8000-0000000000a1, 00000000-0000-4000-8000-0000000000a2" }, () => {
    const w = loadWorkerConfig(common);
    check(
      "worker maintenance tenant list parsed",
      w.maintenanceTenantIds.length === 2 && w.maintenanceTenantIds[1] === "00000000-0000-4000-8000-0000000000a2",
      JSON.stringify(w.maintenanceTenantIds),
    );
  });
  withEnv({ ...FULL, MAINTENANCE_TENANT_IDS: "not-a-uuid" }, () =>
    expectThrow("worker maintenance tenant list rejects non-UUID", () => loadWorkerConfig(common)));
  withEnv({ ...FULL, MAINTENANCE_TENANT_IDS: "00000000-0000-4000-8000-0000000000a1," }, () =>
    expectThrow("worker maintenance tenant list rejects empty entries", () => loadWorkerConfig(common)));
  withEnv({
    ...FULL,
    MAINTENANCE_TENANT_IDS: "00000000-0000-4000-8000-0000000000a1,00000000-0000-4000-8000-0000000000A1",
  }, () => expectThrow("worker maintenance tenant list rejects duplicates", () => loadWorkerConfig(common)));
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
  withEnv(FULL, () =>
    expectThrow("artifact lifecycle worker missing BYPASSRLS database URL throws", () => loadArtifactLifecycleWorkerConfig()));
  withEnv({ ...FULL, ARTIFACT_LIFECYCLE_DATABASE_URL: "postgresql://lifecycle@db/rpa" }, () =>
    expectThrow("artifact lifecycle worker missing stable worker id throws", () => loadArtifactLifecycleWorkerConfig()));
  withEnv({
    ...FULL,
    ARTIFACT_LIFECYCLE_DATABASE_URL: "postgresql://lifecycle@db/rpa",
    ARTIFACT_LIFECYCLE_WORKER_ID: "20000000-0000-4000-8000-0000000000aa",
    ARTIFACT_LIFECYCLE_OBJECT_STORE_MODE: "bogus",
  }, () => expectThrow("artifact lifecycle invalid object-store mode throws", () => loadArtifactLifecycleWorkerConfig()));
  withEnv({
    ...FULL,
    ARTIFACT_LIFECYCLE_DATABASE_URL: "postgresql://lifecycle@db/rpa",
    ARTIFACT_LIFECYCLE_WORKER_ID: "20000000-0000-4000-8000-0000000000aa",
    ARTIFACT_OBJECT_STORE_REF: "rpa/staging/runtime-worker/object_store/s3",
  }, () => expectThrow("artifact lifecycle wrong object-store SecretRef boundary throws", () => loadArtifactLifecycleWorkerConfig()));
  withEnv({
    ...FULL,
    ARTIFACT_LIFECYCLE_DATABASE_URL: "postgresql://lifecycle@db/rpa",
    ARTIFACT_LIFECYCLE_WORKER_ID: "20000000-0000-4000-8000-0000000000aa",
    ARTIFACT_OBJECT_STORE_REF: "rpa/prod/artifact-lifecycle/object_store/s3",
  }, () => expectThrow("artifact lifecycle object-store SecretRef env mismatch throws", () => loadArtifactLifecycleWorkerConfig()));
  withEnv({
    ...FULL,
    ARTIFACT_LIFECYCLE_DATABASE_URL: "postgresql://lifecycle@db/rpa",
    ARTIFACT_LIFECYCLE_WORKER_ID: "20000000-0000-4000-8000-0000000000aa",
    ARTIFACT_OBJECT_STORE_S3_ENDPOINT: "",
  }, () => expectThrow("artifact lifecycle s3 missing endpoint throws", () => loadArtifactLifecycleWorkerConfig()));
  withEnv({
    ...FULL,
    ARTIFACT_LIFECYCLE_DATABASE_URL: "postgresql://lifecycle@db/rpa",
    ARTIFACT_LIFECYCLE_WORKER_ID: "20000000-0000-4000-8000-0000000000aa",
    ARTIFACT_OBJECT_STORE_S3_ENDPOINT: "http://s3.example.internal",
  }, () => expectThrow("artifact lifecycle s3 plaintext endpoint throws", () => loadArtifactLifecycleWorkerConfig()));
  withEnv({
    ...FULL,
    ARTIFACT_LIFECYCLE_DATABASE_URL: "postgresql://lifecycle@db/rpa",
    ARTIFACT_LIFECYCLE_WORKER_ID: "20000000-0000-4000-8000-0000000000aa",
    ARTIFACT_OBJECT_STORE_S3_REGION: "",
  }, () => expectThrow("artifact lifecycle s3 missing region throws", () => loadArtifactLifecycleWorkerConfig()));
  withEnv({
    ...FULL,
    ARTIFACT_LIFECYCLE_DATABASE_URL: "postgresql://lifecycle@db/rpa",
    ARTIFACT_LIFECYCLE_WORKER_ID: "20000000-0000-4000-8000-0000000000aa",
    ARTIFACT_OBJECT_STORE_S3_BUCKET: "",
  }, () => expectThrow("artifact lifecycle s3 missing bucket throws", () => loadArtifactLifecycleWorkerConfig()));
  withEnv({
    ...FULL,
    ARTIFACT_LIFECYCLE_DATABASE_URL: "postgresql://lifecycle@db/rpa",
    ARTIFACT_LIFECYCLE_WORKER_ID: "20000000-0000-4000-8000-0000000000aa",
    ARTIFACT_OBJECT_STORE_S3_ACCESS_KEY_ID: "",
  }, () => expectThrow("artifact lifecycle s3 missing access key id throws", () => loadArtifactLifecycleWorkerConfig()));
  withEnv({
    ...FULL,
    ARTIFACT_LIFECYCLE_DATABASE_URL: "postgresql://lifecycle@db/rpa",
    ARTIFACT_LIFECYCLE_WORKER_ID: "20000000-0000-4000-8000-0000000000aa",
    VAULT_ARTIFACT_LIFECYCLE_ROLE_ID: "",
  }, () => expectThrow("artifact lifecycle s3 missing Vault AppRole throws", () => loadArtifactLifecycleWorkerConfig()));
  withEnv({
    ...FULL,
    ARTIFACT_LIFECYCLE_DATABASE_URL: "postgresql://lifecycle@db/rpa",
    ARTIFACT_LIFECYCLE_WORKER_ID: "20000000-0000-4000-8000-0000000000aa",
  }, () => {
    const l = loadArtifactLifecycleWorkerConfig();
    check("artifact lifecycle database URL carried", l.connectionString === "postgresql://lifecycle@db/rpa");
    check("artifact lifecycle worker id carried", l.workerId === "20000000-0000-4000-8000-0000000000aa");
    check("artifact lifecycle object-store default mode is s3", l.objectStore.mode === "s3");
    check(
      "artifact lifecycle s3 endpoint carried",
      l.objectStore.mode === "s3" && l.objectStore.endpoint === "https://s3.example.internal",
      l.objectStore.mode === "s3" ? l.objectStore.endpoint : l.objectStore.mode,
    );
    check("artifact lifecycle s3 region/bucket carried", l.objectStore.mode === "s3" && l.objectStore.region === "ap-northeast-2" && l.objectStore.bucket === "rpa-artifacts");
    check("artifact lifecycle s3 access key id carried", l.objectStore.mode === "s3" && l.objectStore.accessKeyId === "rpa-lifecycle-access-key-id");
    check("artifact lifecycle s3 SecretRef carried, not value", l.objectStore.mode === "s3" && l.objectStore.secretAccessKeyRef === FULL.ARTIFACT_OBJECT_STORE_REF);
    check("artifact lifecycle s3 backend alias default", l.objectStore.mode === "s3" && l.objectStore.backendAlias === "s3-compatible");
    check("artifact lifecycle s3 forcePathStyle default true", l.objectStore.mode === "s3" && l.objectStore.forcePathStyle === true);
    check("artifact lifecycle Vault identity carried for s3", l.vaultArtifactLifecycle?.roleId === "artifact-role");
    check("artifact lifecycle retention default 90", l.artifactRetentionDays === 90);
    check("artifact lifecycle graphile defaults reuse worker defaults", l.graphileConcurrency === 1 && l.graphilePollIntervalMs === 2000);
  });
  withEnv({
    ...FULL,
    ARTIFACT_LIFECYCLE_DATABASE_URL: "postgresql://lifecycle@db/rpa",
    ARTIFACT_LIFECYCLE_WORKER_ID: "20000000-0000-4000-8000-0000000000aa",
    ARTIFACT_OBJECT_STORE_BACKEND_ALIAS: "minio-prod-a",
    ARTIFACT_OBJECT_STORE_S3_FORCE_PATH_STYLE: "false",
  }, () => {
    const l = loadArtifactLifecycleWorkerConfig();
    check("artifact lifecycle s3 backend alias override", l.objectStore.mode === "s3" && l.objectStore.backendAlias === "minio-prod-a");
    check("artifact lifecycle s3 forcePathStyle override false", l.objectStore.mode === "s3" && l.objectStore.forcePathStyle === false);
  });
  withEnv({
    ...FULL,
    RPA_ENV: "staging",
    ARTIFACT_LIFECYCLE_DATABASE_URL: "postgresql://lifecycle@db/rpa",
    ARTIFACT_LIFECYCLE_WORKER_ID: "20000000-0000-4000-8000-0000000000aa",
    ARTIFACT_LIFECYCLE_OBJECT_STORE_MODE: "local_fs",
    GATEWAY_ARTIFACT_DIR: "/var/lib/rpa/gw-artifacts",
  }, () => expectThrow("artifact lifecycle local_fs rejected outside dev/local RPA_ENV", () => loadArtifactLifecycleWorkerConfig()));
  withEnv({
    RPA_ENV: "local",
    ARTIFACT_LIFECYCLE_DATABASE_URL: "postgresql://lifecycle@db/rpa",
    ARTIFACT_LIFECYCLE_WORKER_ID: "20000000-0000-4000-8000-0000000000aa",
    ARTIFACT_LIFECYCLE_OBJECT_STORE_MODE: "local_fs",
    ARTIFACT_OBJECT_STORE_REF: "rpa/local/artifact-lifecycle/object_store/fs",
    GATEWAY_ARTIFACT_DIR: "/tmp/rpa-artifacts",
  }, () => {
    const l = loadArtifactLifecycleWorkerConfig();
    check("artifact lifecycle local_fs explicit mode carried", l.objectStore.mode === "local_fs");
    check("artifact lifecycle local_fs artifact dir carried", l.objectStore.mode === "local_fs" && l.objectStore.artifactDir === "/tmp/rpa-artifacts");
    check("artifact lifecycle local_fs SecretRef carried", l.objectStore.mode === "local_fs" && l.objectStore.credentialRef === "rpa/local/artifact-lifecycle/object_store/fs");
    check("artifact lifecycle local_fs backend alias default", l.objectStore.mode === "local_fs" && l.objectStore.backendAlias === "fs-local");
    check("artifact lifecycle local_fs does not require Vault identity", l.vaultArtifactLifecycle === undefined);
  });
  withEnv({
    ...FULL,
    GRAPHILE_CONCURRENCY: "3",
    GRAPHILE_POLL_INTERVAL_MS: "4000",
    ARTIFACT_LIFECYCLE_GRAPHILE_CONCURRENCY: "2",
    ARTIFACT_LIFECYCLE_GRAPHILE_POLL_INTERVAL_MS: "1500",
    ARTIFACT_LIFECYCLE_DATABASE_URL: "postgresql://lifecycle@db/rpa",
    ARTIFACT_LIFECYCLE_WORKER_ID: "20000000-0000-4000-8000-0000000000aa",
  }, () => {
    const l = loadArtifactLifecycleWorkerConfig();
    check("artifact lifecycle graphile overrides carried", l.graphileConcurrency === 2 && l.graphilePollIntervalMs === 1500);
  });

  // GatewayConfig (D8-A16) — fail-closed on missing Codex provider creds / artifact dir; ops-defaults knobs.
  const GW_REQ = {
    CODEX_BASE_URL: "https://api.example/v1", CODEX_API_KEY: "sk-test", CODEX_MODEL: "gpt-x",
    GATEWAY_ARTIFACT_DIR: "/var/lib/rpa/gw-artifacts",
  };
  withEnv({
    ...FULL,
    ...GW_REQ,
    ARTIFACT_LIFECYCLE_DATABASE_URL: "postgresql://lifecycle@db/rpa",
    ARTIFACT_LIFECYCLE_WORKER_ID: "20000000-0000-4000-8000-0000000000aa",
  }, () =>
    expectThrow("RUN_MODE=all rejects fs producers with s3 lifecycle store", () => assertInProcessArtifactStoreCompatibility("all")));
  withEnv({
    ...FULL,
    ...GW_REQ,
    ARTIFACT_LIFECYCLE_DATABASE_URL: "postgresql://lifecycle@db/rpa",
    ARTIFACT_LIFECYCLE_WORKER_ID: "20000000-0000-4000-8000-0000000000aa",
  }, () =>
    expectThrow("split worker/lifecycle topology rejects fs producers with s3 lifecycle store", () => assertArtifactStoreTopologyCompatibility("split_worker_lifecycle")));
  withEnv({
    RPA_ENV: "local",
    ...GW_REQ,
    ARTIFACT_LIFECYCLE_DATABASE_URL: "postgresql://lifecycle@db/rpa",
    ARTIFACT_LIFECYCLE_WORKER_ID: "20000000-0000-4000-8000-0000000000aa",
    ARTIFACT_LIFECYCLE_OBJECT_STORE_MODE: "local_fs",
    ARTIFACT_OBJECT_STORE_REF: "rpa/local/artifact-lifecycle/object_store/fs",
  }, () => {
    assertInProcessArtifactStoreCompatibility("all");
    check("RUN_MODE=all accepts shared local_fs lifecycle store in local env", true);
  });
  withEnv({
    RPA_ENV: "local",
    ...GW_REQ,
    ARTIFACT_LIFECYCLE_DATABASE_URL: "postgresql://lifecycle@db/rpa",
    ARTIFACT_LIFECYCLE_WORKER_ID: "20000000-0000-4000-8000-0000000000aa",
    ARTIFACT_LIFECYCLE_OBJECT_STORE_MODE: "local_fs",
    ARTIFACT_OBJECT_STORE_REF: "rpa/local/artifact-lifecycle/object_store/fs",
  }, () => {
    assertArtifactStoreTopologyCompatibility("split_worker_lifecycle");
    check("split worker/lifecycle topology accepts shared local_fs lifecycle store in local env", true);
  });
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
