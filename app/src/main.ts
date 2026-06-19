/**
 * Production composition root — the first real production entrypoint for the RPA runtime.
 *
 * RUN_MODE-gated (api | worker | all): boots the control-plane API and/or the worker daemon from env +
 * Vault SecretRef. Replaces the dev-only app/dev/serve.ts (temp-PG seed, dev HMAC, 127.0.0.1, no-op enqueuer).
 *
 * ── SCOPE (foundation) ─────────────────────────────────────────────────────────────────────────
 * The control-plane API is FULLY wired and listens (runs/reads/human-tasks/idempotency over real PG with
 * the real PgGraphileRunEnqueuer). The worker boots as a real graphile daemon (graphile `run()` — never
 * composed into a running stack before) and claims jobs. Scenario DRIVE requires production adapters that are
 * not yet implemented (test-fake only); they are deliberately left unwired and the worker LOUD-THROWS on the
 * job paths that need them ("조용한 false 금지" — never a silent no-op). The in-process LLM gateway +
 * dom/utility executorFactory (D8-A16, buildExecutorFactory) AND the real StagehandBrowserSessionProvider
 * (backlog item 2) are now both wired, so the worker drives claimed runs end-to-end: provider.bind() launches
 * a real Chrome per lease at job time (CHROME_EXECUTABLE_PATH, deploy-provisioned) and the executorFactory
 * routes dom primitives through the gateway. Live success therefore requires a real Chrome binary at that
 * path — absent it, bind() loud-throws per run (fail-closed). Enumerated remaining backlog (see
 * product-open-candidate-report.md / staging-deploy-runbook.md):
 *   - SinkDeliveryPort real egress. Sink delivery ops policy is wired, while the actual downstream
 *     network adapter remains an injected deploy-time port. Recurring maintenance fanout is wired for explicit
 *     MAINTENANCE_TENANT_IDS (lease sweeper, artifact redaction, retention). The API composes a
 *     SecretStore-backed SignedCommandRegistry when SIGNED_COMMAND_REGISTRY_MODE=vault; explicit
 *     SIGNED_COMMAND_REGISTRY_MODE=deny_all is available for fail-closed deployments. JWT verification now
 *     supports RS256 via remote JWKS (set JWKS_URL) or the HS256 default. Browser session reuse is wired with
 *     AES-256-GCM using the runtime-worker `browser_session` SecretRef data key.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
import http from "node:http";
import { pathToFileURL } from "node:url";

import { run, runMigrations, type Runner } from "graphile-worker";
import type { FastifyInstance } from "fastify";

import { hmacJwtVerifier, jwksRs256Verifier, JwtAuthenticationBoundary } from "./api/auth";
import { buildApiArtifactObjectReader } from "./api/artifact-object-reader-binding";
import { PgControlPlaneIdempotencyStore } from "./api/idempotency";
import { createLlmScenarioPlanner, LlmGatewayScenarioPlannerClient } from "./api/llm-scenario-planner";
import { RoleMatrixRbacMiddleware } from "./api/rbac";
import { PgGraphileRunEnqueuer } from "./api/run-queue";
import { BufferedScenarioGenerationArtifactSink } from "./api/scenario-generation-artifacts";
import {
  PgScenarioGenerationLlmCallIdempotencyStore,
  type ScenarioGenerationLlmCallCleanup,
} from "./api/scenario-generation-llm-call-idempotency-store";
import { PgDurableSecurityAuditDecisionWriter } from "./api/security-audit";
import { buildServer } from "./api/server";
import { DenyAllSignedCommandRegistry, SecretStoreSignedCommandRegistry } from "./api/signed-command-registry";
import {
  loadApiConfig,
  loadApiSessionEncryption,
  loadArtifactLifecycleWorkerConfig,
  loadBrowserConfig,
  loadCommonConfig,
  loadGatewayConfig,
  loadRunMode,
  loadScenarioGenerationLlmV1Config,
  loadWorkerConfig,
  type ArtifactLifecycleWorkerConfig,
  type ApiConfig,
  type CommonConfig,
  type ScenarioGenerationLlmV1Config,
} from "./config/env";
import { createPool, type PgPool } from "./db/pool";
import { ArtifactRedactionContentTransform } from "./artifacts/artifact-redaction-content-transform";
import { FsArtifactRedactor, FsArtifactRetentionStore } from "./artifacts/fs-artifact-lifecycle-store";
import { S3ArtifactRedactor } from "./artifacts/s3-artifact-redactor";
import { S3ArtifactRetentionStore } from "./artifacts/s3-artifact-retention-store";
import { S3ObjectStore, type S3HttpTransport } from "./artifacts/s3-object-store";
import { AjvStructuredOutputValidator } from "./gateway/ajv-structured-output-validator";
import { SafeCapabilityGate } from "./gateway/capability-gate";
import { CodexSseAdapter } from "./gateway/codex-sse-adapter";
import { FetchCodexSseTransport } from "./gateway/codex-sse-transport";
import { LlmGateway } from "./gateway/llm-gateway";
import { FsObjectStore, PgGatewayArtifactSink } from "./gateway/pg-gateway-artifact-sink";
import { PgLlmCallIdempotencyStore } from "./gateway/pg-llm-call-idempotency-store";
import { StagehandBrowserSessionProvider } from "./executor/browser-session-provider";
import { PgChallengeSuspensionPort } from "./runtime/challenge-suspension-port";
import { PgBrowserSessionStore, buildAesGcmSessionEncryptor, type BrowserSessionStore } from "./runtime/browser-session-store";
import { createDomUtilityExecutorFactory } from "./runtime/dom-executor-factory";
import { PgMergedExtractArtifactSink } from "./runtime/merged-extract-artifact";
import { HmacResumeTokenCodec } from "./runtime/resume-token-codec";
import { PgSessionRestorer } from "./runtime/session-restorer";
import { PgScreenshotFrameVideoRecorder, PgVisualEvidenceRecorder } from "./runtime/visual-evidence";
import { VaultSecretStore } from "./secrets/vault-secret-store";
import { buildTaskList } from "./worker/graphile-runner";
import { startMaintenanceScheduler, type MaintenanceScheduler } from "./worker/maintenance-scheduler";
import { pgBrowserLeasePlanResolver } from "./worker/pg-browser-lease-plan-resolver";
import type { PgRuntimeWorkerOptions, RunExecutorFactory } from "./worker/runtime-worker";
import { DeterministicGatewayRedactionBoundary } from "../../gateway/redaction-boundary";
import type { SecretRef, SecretStore } from "../../ts/core-types";
import {
  ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
  type ArtifactRealObjectStorePortBinding,
} from "../../ts/runtime-contract";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";
import type { ScenarioPlanner } from "./api/scenario-generation-types";
import type { ScenarioGenerationArtifactBuffer } from "./api/scenario-generation-artifacts";

/** Unauthenticated health probe server (separate http server — bypasses the Fastify auth/RBAC chain). */
function startHealthServer(pool: PgPool, port: number): http.Server {
  const server = http.createServer((reqMsg, res) => {
    const url = reqMsg.url ?? "/";
    if (url === "/livez") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "live" }));
      return;
    }
    if (url === "/readyz") {
      pool
        .query("SELECT 1")
        .then(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "ready" }));
        })
        .catch(() => {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "not-ready" }));
        });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  server.on("error", (err) => {
    console.error(JSON.stringify({ at: "main", fatal: `health server error: ${err.message}` }));
    process.exit(1);
  });
  server.listen(port, "0.0.0.0");
  return server;
}

/** JWT verifier per loaded mode: RS256 via remote JWKS (production) or the v1 HS256 shared secret. */
function buildJwtVerifier(jwt: ApiConfig["jwt"]) {
  if (jwt.mode === "jwks") {
    return jwksRs256Verifier({
      jwksUrl: jwt.jwksUrl,
      ...(jwt.issuer !== undefined ? { issuer: jwt.issuer } : {}),
      ...(jwt.audience !== undefined ? { audience: jwt.audience } : {}),
    });
  }
  return hmacJwtVerifier(new TextEncoder().encode(jwt.secret));
}

function buildSignedCommandRegistry(cfg: ApiConfig["signedCommandRegistry"]): SignedCommandRegistry {
  if (cfg.mode === "deny_all") {
    return new DenyAllSignedCommandRegistry();
  }
  const store = new VaultSecretStore({
    baseUrl: cfg.vaultApi.addr,
    mount: cfg.vaultApi.mount,
    kvApiVersion: 2,
    appRole: { roleId: cfg.vaultApi.roleId, secretId: cfg.vaultApi.secretId },
  });
  return new SecretStoreSignedCommandRegistry(store, cfg.sourceRef as SecretRef);
}

interface ScenarioGenerationPlannerBinding {
  readonly planner: ScenarioPlanner;
  readonly artifacts: ScenarioGenerationArtifactBuffer;
  readonly llmCalls: ScenarioGenerationLlmCallCleanup;
}

function buildScenarioGenerationPlannerBinding(pool: PgPool, cfg: ScenarioGenerationLlmV1Config): ScenarioGenerationPlannerBinding {
  const gw = cfg.gateway;
  const artifactSink = new BufferedScenarioGenerationArtifactSink(new FsObjectStore(gw.artifactDir), {
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
    redactionBoundary: new DeterministicGatewayRedactionBoundary(),
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

async function startApi(pool: PgPool, common: CommonConfig, runMode = loadRunMode()): Promise<FastifyInstance> {
  const cfg = loadApiConfig(common, { runMode });
  const scenarioGenerationLlmV1 = loadScenarioGenerationLlmV1Config();
  const scenarioPlanner = scenarioGenerationLlmV1 !== undefined ? buildScenarioGenerationPlannerBinding(pool, scenarioGenerationLlmV1) : undefined;
  const artifactObjectReader = await buildApiArtifactObjectReader(cfg);
  // 세션 캡처 봉투암호화 스토어 — KEK(api/browser_session) 프로비저닝 시에만 활성(미설정 → undefined → 엔드포인트 미등록, fail-closed).
  const sessionStore = await buildApiSessionStore(pool, common);
  const api = buildServer({
    pool,
    auth: new JwtAuthenticationBoundary(buildJwtVerifier(cfg.jwt)),
    rbac: new RoleMatrixRbacMiddleware(),
    idempotency: new PgControlPlaneIdempotencyStore(pool),
    enqueuer: new PgGraphileRunEnqueuer(),
    signedCommandRegistry: buildSignedCommandRegistry(cfg.signedCommandRegistry),
    scenarioGenerationCapabilities: { videoRecording: cfg.videoRecordingEnabled },
    ...(scenarioPlanner !== undefined
      ? {
          scenarioGenerationPlanner: scenarioPlanner.planner,
          scenarioGenerationArtifacts: scenarioPlanner.artifacts,
          scenarioGenerationLlmCalls: scenarioPlanner.llmCalls,
        }
      : {}),
    security: { corsOrigins: cfg.corsOrigins, hsts: cfg.hsts },
    ...(artifactObjectReader !== undefined
      ? {
          artifactStore: artifactObjectReader,
          securityAudit: new PgDurableSecurityAuditDecisionWriter(pool),
        }
      : {}),
    ...(sessionStore !== undefined ? { sessionStore } : {}),
  });
  await api.listen({ host: "0.0.0.0", port: cfg.port });
  console.log(JSON.stringify({
    at: "main",
    msg: "control-plane API listening",
    port: cfg.port,
    jwtMode: cfg.jwt.mode,
    signedCommandRegistryMode: cfg.signedCommandRegistry.mode,
    scenarioGenerationLlmV1Enabled: scenarioGenerationLlmV1 !== undefined,
    sessionCapture: sessionStore !== undefined,
  }));
  return api;
}

/**
 * Assemble the in-process production LLM Gateway and the dom/utility executor factory (release-decisions
 * D8-A16). The gateway = CodexSseAdapter (env-sourced creds) + SafeCapabilityGate + AjvStructuredOutputValidator
 * + PgGatewayArtifactSink(FsObjectStore) + DeterministicGatewayRedactionBoundary, with ops-defaults §4 knobs.
 * The returned RunExecutorFactory routes dom primitives (act/observe/extract) through the gateway and utility
 * actions deterministically.
 *
 * NOTE: with the StagehandBrowserSessionProvider now wired (backlog item 2), this factory is on the live
 * claim-drive path — the worker invokes executorFactory inside driveClaimedRun once a lease is bound. The Q1
 * structured-output safe-path (extract scenarios → prompt-schema injection + ajv validation) is implemented
 * (gateway jsonMode=false path), so a real Chrome run drives end-to-end.
 */
function buildExecutorFactory(pool: PgPool): RunExecutorFactory {
  const gw = loadGatewayConfig();
  const artifactStore = new FsObjectStore(gw.artifactDir);
  const gatewayArtifactSink = new PgGatewayArtifactSink(pool, artifactStore, {
    retentionDays: gw.artifactRetentionDays,
  });
  const approvalInboxArtifactSink = new PgGatewayArtifactSink(pool, artifactStore, {
    type: "approval_inbox",
    retentionDays: gw.artifactRetentionDays,
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
    sink: gatewayArtifactSink,
    idempotency: new PgLlmCallIdempotencyStore(pool),
    redactionBoundary: new DeterministicGatewayRedactionBoundary(),
    config: { retryMax: gw.retryMax, fallbackAttempts: gw.fallbackAttempts, repairAttempts: gw.repairAttempts },
  });
  return createDomUtilityExecutorFactory(gateway, {
    model: gw.codexModel,
    promptTemplateVersion: gw.promptTemplateVersion,
    budget: gw.budget,
  }, {
    extractArtifactSink: approvalInboxArtifactSink,
  });
}

/**
 * 세션 캡처 봉투암호화 스토어를 조립한다(POST .../session/capture/complete 가 이걸로 등록). KEK SecretRef
 * (rpa/<env>/api/browser_session/active) 가 프로비저닝됐을 때만(VAULT_API_ROLE_ID 게이트) 활성 — 미설정이면 undefined →
 * 엔드포인트 미등록(fail-closed, 평문 at-rest 금지). KEK 는 api AppRole VaultSecretStore 에서 1회 해소. **워커 복원과 동일
 * {kid,key} 를 각자 namespace 에 seed 하면** API 가 암호화한 세션을 워커가 복호화한다(cross-identity round-trip).
 */
async function buildApiSessionStore(pool: PgPool, common: CommonConfig): Promise<BrowserSessionStore | undefined> {
  const sessionEnc = loadApiSessionEncryption(common);
  if (sessionEnc === undefined) {
    console.log(JSON.stringify({ at: "main", msg: "session capture unregistered — KEK (api/browser_session) not provisioned, fail-closed" }));
    return undefined;
  }
  const apiStore = new VaultSecretStore({
    baseUrl: sessionEnc.vault.addr,
    mount: sessionEnc.vault.mount,
    kvApiVersion: 2,
    appRole: { roleId: sessionEnc.vault.roleId, secretId: sessionEnc.vault.secretId },
  });
  const encryptor = await buildAesGcmSessionEncryptor(apiStore, sessionEnc.kekRef as SecretRef);
  return new PgBrowserSessionStore({ pool, encryptor });
}

interface StartedWorker {
  readonly runner: Runner;
  readonly maintenance?: MaintenanceScheduler;
}

async function startWorker(pool: PgPool, common: CommonConfig): Promise<StartedWorker> {
  const cfg = loadWorkerConfig(common);
  await runMigrations({ connectionString: common.connectionString });

  const runtimeWorkerStore = new VaultSecretStore({
    baseUrl: cfg.vaultRuntimeWorker.addr,
    mount: cfg.vaultRuntimeWorker.mount,
    kvApiVersion: 2,
    appRole: { roleId: cfg.vaultRuntimeWorker.roleId, secretId: cfg.vaultRuntimeWorker.secretId },
  });
  const browserSessionEncryptor = await buildAesGcmSessionEncryptor(runtimeWorkerStore, cfg.browserSessionKeyRef as SecretRef);
  const resumeTokenCodec = new HmacResumeTokenCodec(runtimeWorkerStore, cfg.resumeTokenRef as SecretRef);
  const sessionStore = new PgBrowserSessionStore({ pool, encryptor: browserSessionEncryptor });

  const browser = loadBrowserConfig();
  const gw = loadGatewayConfig();
  const browserSessionProvider = new StagehandBrowserSessionProvider({
    chromeExecutablePath: browser.chromeExecutablePath,
    headless: browser.headless,
    ...(browser.downloadRootDir !== undefined ? { downloadRootDir: browser.downloadRootDir } : {}),
  });
  const artifactStore = new FsObjectStore(gw.artifactDir);
  const visualEvidenceVideoRecorderFactory: PgRuntimeWorkerOptions["visualEvidenceVideoRecorderFactory"] =
    cfg.videoRecordingEnabled
      ? (provider) => {
          if (cfg.videoFfmpegPath === undefined) {
            throw new Error("VISUAL_EVIDENCE_FFMPEG_PATH is required when VISUAL_EVIDENCE_VIDEO_ENABLED is true");
          }
          return new PgScreenshotFrameVideoRecorder(pool, artifactStore, provider, {
            retentionDays: gw.artifactRetentionDays,
            ffmpegPath: cfg.videoFfmpegPath,
            frameIntervalMs: cfg.videoFrameIntervalMs,
            frameRate: cfg.videoFrameRate,
          });
        }
      : undefined;

  const workerOptions: PgRuntimeWorkerOptions = {
    workerId: cfg.workerId,
    suspensionPort: new PgChallengeSuspensionPort(),
    resumeTokenCodec,
    sessionRestorer: new PgSessionRestorer({ pool, resumeTokenCodec, sessionStore }),
    runAbortDrainer: browserSessionProvider,
    browserLeasePlanResolver: pgBrowserLeasePlanResolver,
    executorFactory: buildExecutorFactory(pool),
    browserSessionProvider,
    sessionStore,
    visualEvidenceRecorder: new PgVisualEvidenceRecorder(pool, artifactStore, {
      retentionDays: gw.artifactRetentionDays,
    }),
    ...(visualEvidenceVideoRecorderFactory !== undefined ? { visualEvidenceVideoRecorderFactory } : {}),
    mergedExtractArtifactSink: new PgMergedExtractArtifactSink(pool, artifactStore, {
      retentionDays: gw.artifactRetentionDays,
    }),
    sinkDeliveryMaxAttempts: cfg.sinkDeliveryMaxAttempts,
    sinkDeliveryRetryAfterMs: cfg.sinkDeliveryRetryAfterMs,
    runtimeJobEnqueuer: new PgGraphileRunEnqueuer(),
  };

  const runner = await run({
    connectionString: common.connectionString,
    taskList: buildTaskList(pool, workerOptions, "control"),
    concurrency: cfg.graphileConcurrency,
    pollInterval: cfg.graphilePollIntervalMs,
    ...(cfg.graphileSchema !== undefined ? { schema: cfg.graphileSchema } : {}),
  });
  const maintenance = startMaintenanceScheduler(pool, { tenantIds: cfg.maintenanceTenantIds });
  console.log(JSON.stringify({
    at: "main",
    msg: "worker daemon running",
    concurrency: cfg.graphileConcurrency,
    maintenanceTenantCount: cfg.maintenanceTenantIds.length,
  }));
  return { runner, ...(maintenance !== undefined ? { maintenance } : {}) };
}

interface ArtifactLifecycleRunner {
  readonly pool: PgPool;
  readonly runner: Runner;
}

export interface ArtifactLifecycleWorkerOptionDeps {
  readonly secretStore?: SecretStore;
  readonly s3Transport?: S3HttpTransport;
}

export async function buildArtifactLifecycleWorkerOptions(
  cfg: ArtifactLifecycleWorkerConfig,
  deps: ArtifactLifecycleWorkerOptionDeps = {},
): Promise<PgRuntimeWorkerOptions> {
  if (cfg.objectStore.mode === "local_fs") {
    const artifactStore = new FsObjectStore(cfg.objectStore.artifactDir);
    const artifactObjectBinding = artifactLifecycleObjectBinding(
      cfg.objectStore.backendAlias,
      cfg.objectStore.credentialRef,
      false,
    );
    return {
      workerId: cfg.workerId,
      artifactLifecycleAuditRetentionDays: cfg.artifactRetentionDays,
      artifactRedactor: new FsArtifactRedactor(
        artifactStore,
        artifactObjectBinding,
        new ArtifactRedactionContentTransform(),
      ),
      artifactRetentionStore: new FsArtifactRetentionStore(artifactStore, artifactObjectBinding),
    };
  }

  const secretStore = deps.secretStore;
  if (secretStore === undefined) {
    throw new Error("artifact lifecycle S3 object store requires a SecretStore for ARTIFACT_OBJECT_STORE_REF");
  }
  const secretAccessKey = await secretStore.resolve(cfg.objectStore.secretAccessKeyRef as SecretRef);
  const artifactStore = new S3ObjectStore({
    endpoint: cfg.objectStore.endpoint,
    region: cfg.objectStore.region,
    bucket: cfg.objectStore.bucket,
    accessKeyId: cfg.objectStore.accessKeyId,
    secretAccessKey,
    forcePathStyle: cfg.objectStore.forcePathStyle,
    ...(deps.s3Transport !== undefined ? { transport: deps.s3Transport } : {}),
  });
  const artifactObjectBinding = artifactLifecycleObjectBinding(
    cfg.objectStore.backendAlias,
    cfg.objectStore.secretAccessKeyRef,
    true,
  );
  return {
    workerId: cfg.workerId,
    artifactLifecycleAuditRetentionDays: cfg.artifactRetentionDays,
    artifactRedactor: new S3ArtifactRedactor(
      artifactStore,
      artifactObjectBinding,
      new ArtifactRedactionContentTransform(),
    ),
    artifactRetentionStore: new S3ArtifactRetentionStore(artifactStore, artifactObjectBinding),
  };
}

function artifactLifecycleObjectBinding(
  backendAlias: string,
  credentialRef: string,
  mayBeUsedAsStagingEvidence: boolean,
): ArtifactRealObjectStorePortBinding {
  return {
    kind: "real_object_store",
    backendAlias,
    credentialRef: credentialRef as SecretRef,
    evidenceSchemaRef: ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
    mayBeUsedAsStagingEvidence,
  };
}

function buildArtifactLifecycleSecretStore(cfg: ArtifactLifecycleWorkerConfig): SecretStore | undefined {
  if (cfg.objectStore.mode !== "s3") return undefined;
  const vault = cfg.vaultArtifactLifecycle;
  if (vault === undefined) {
    throw new Error("artifact lifecycle S3 object store requires VAULT_ARTIFACT_LIFECYCLE_* AppRole config");
  }
  return new VaultSecretStore({
    baseUrl: vault.addr,
    mount: vault.mount,
    kvApiVersion: 2,
    appRole: { roleId: vault.roleId, secretId: vault.secretId },
  });
}

async function startArtifactLifecycleWorker(): Promise<ArtifactLifecycleRunner> {
  const cfg = loadArtifactLifecycleWorkerConfig();
  const pool = createPool({ connectionString: cfg.connectionString });
  try {
    await pool.query("SELECT 1");
    const secretStore = buildArtifactLifecycleSecretStore(cfg);
    const workerOptions = await buildArtifactLifecycleWorkerOptions(
      cfg,
      secretStore !== undefined ? { secretStore } : {},
    );
    const runner = await run({
      connectionString: cfg.connectionString,
      taskList: buildTaskList(pool, workerOptions, "artifact_lifecycle"),
      concurrency: cfg.graphileConcurrency,
      pollInterval: cfg.graphilePollIntervalMs,
      ...(cfg.graphileSchema !== undefined ? { schema: cfg.graphileSchema } : {}),
    });
    console.log(JSON.stringify({
      at: "main",
      msg: "artifact lifecycle worker daemon running",
      concurrency: cfg.graphileConcurrency,
    }));
    return { pool, runner };
  } catch (err) {
    await pool.end().catch(() => undefined);
    throw err;
  }
}

async function main(): Promise<void> {
  const mode = loadRunMode();
  const common = loadCommonConfig();
  const pool = createPool();
  // Fail fast on DB connectivity before binding anything.
  await pool.query("SELECT 1");

  const health = startHealthServer(pool, common.healthPort);
  let api: FastifyInstance | undefined;
  let worker: StartedWorker | undefined;
  let lifecycleRunner: ArtifactLifecycleRunner | undefined;

  if (mode === "api" || mode === "all") api = await startApi(pool, common, mode);
  if (mode === "worker" || mode === "all") worker = await startWorker(pool, common);
  if (mode === "lifecycle-worker" || mode === "all") lifecycleRunner = await startArtifactLifecycleWorker();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ at: "main", msg: "shutdown", signal }));
    void (async () => {
      health.close();
      try {
        // Stop accepting new requests/enqueues first, then drain in-flight worker jobs, then close the pool.
        if (api !== undefined) await api.close();
        if (worker !== undefined) {
          worker.maintenance?.stop();
          await worker.runner.stop();
        }
        if (lifecycleRunner !== undefined) await lifecycleRunner.runner.stop();
      } finally {
        if (lifecycleRunner !== undefined) await lifecycleRunner.pool.end().catch(() => undefined);
        await pool.end().catch(() => undefined);
      }
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

function isDirectEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}

if (isDirectEntrypoint()) {
  void main().catch((e) => {
    const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(JSON.stringify({ at: "main", fatal: text }));
    process.exit(1);
  });
}
