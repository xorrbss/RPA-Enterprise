/**
 * Production composition root — worker/executor/artifact-lifecycle wiring.
 * 분해 전 main.ts 내부였음(CLAUDE.md #7). main.ts(entry)가 startWorker/startArtifactLifecycleWorker/
 * buildApiSessionStore 를 import 한다. main(entry/API)을 import 하지 않는 단방향.
 */


import { run, runMigrations, type Runner } from "graphile-worker";

import { PgGraphileRunEnqueuer } from "./api/run-queue";
import { PgDurableSecurityAuditDecisionWriter } from "./api/security-audit";
import { loadApiSessionEncryption, loadArtifactLifecycleWorkerConfig, loadBrowserConfig, loadGatewayConfig, loadWorkerConfig, type ArtifactLifecycleWorkerConfig, type CommonConfig } from "./config/env";
import { createPool, type PgPool } from "./db/pool";
import { registerQueueDepthGauge } from "./observability/queue-depth-gauge";
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
import { PgActionPlanCache } from "./executor/pg-action-plan-cache";
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
    securityAudit: new PgDurableSecurityAuditDecisionWriter(pool),
    redactionBoundary: new DeterministicGatewayRedactionBoundary(),
    config: { retryMax: gw.retryMax, fallbackAttempts: gw.fallbackAttempts, repairAttempts: gw.repairAttempts },
  });
  return createDomUtilityExecutorFactory(gateway, {
    model: gw.codexModel,
    promptTemplateVersion: gw.promptTemplateVersion,
    budget: gw.budget,
  }, {
    cache: new PgActionPlanCache(pool),
    extractArtifactSink: approvalInboxArtifactSink,
  });
}

/**
 * 세션 캡처 봉투암호화 스토어를 조립한다(POST .../session/capture/complete 가 이걸로 등록). KEK SecretRef
 * (rpa/<env>/api/browser_session/active) 가 프로비저닝됐을 때만(VAULT_API_ROLE_ID 게이트) 활성 — 미설정이면 undefined →
 * 엔드포인트 미등록(fail-closed, 평문 at-rest 금지). KEK 는 api AppRole VaultSecretStore 에서 1회 해소. **워커 복원과 동일
 * {kid,key} 를 각자 namespace 에 seed 하면** API 가 암호화한 세션을 워커가 복호화한다(cross-identity round-trip).
 */
export async function buildApiSessionStore(pool: PgPool, common: CommonConfig): Promise<BrowserSessionStore | undefined> {
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

export interface StartedWorker {
  readonly runner: Runner;
  readonly maintenance?: MaintenanceScheduler;
}

export async function startWorker(pool: PgPool, common: CommonConfig): Promise<StartedWorker> {
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
  registerQueueDepthGauge(pool);
  const maintenance = startMaintenanceScheduler(pool, { tenantIds: cfg.maintenanceTenantIds });
  console.log(JSON.stringify({
    at: "main",
    msg: "worker daemon running",
    concurrency: cfg.graphileConcurrency,
    maintenanceTenantCount: cfg.maintenanceTenantIds.length,
  }));
  return { runner, ...(maintenance !== undefined ? { maintenance } : {}) };
}

export interface ArtifactLifecycleRunner {
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

export async function startArtifactLifecycleWorker(): Promise<ArtifactLifecycleRunner> {
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

