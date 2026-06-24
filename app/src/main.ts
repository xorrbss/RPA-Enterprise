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

import type { FastifyInstance } from "fastify";
import { ConsoleMetricExporter, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";

import { hmacJwtVerifier, jwksRs256Verifier, JwtAuthenticationBoundary } from "./api/auth";
import { buildApiArtifactObjectReader } from "./api/artifact-object-reader-binding";
import { PgControlPlaneIdempotencyStore } from "./api/idempotency";
import { createLlmScenarioPlanner, LlmGatewayScenarioPlannerClient } from "./api/llm-scenario-planner";
import { PgPrincipalDirectory } from "./api/principal-directory";
import { RoleMatrixRbacMiddleware } from "./api/rbac";
import { PgGraphileRunEnqueuer } from "./api/run-queue";
import { BufferedScenarioGenerationArtifactSink } from "./api/scenario-generation-artifacts";
import { PuppeteerSelectorProbeProvider } from "./api/selector-probe-provider";
import {
  PgScenarioGenerationLlmCallIdempotencyStore,
  type ScenarioGenerationLlmCallCleanup,
} from "./api/scenario-generation-llm-call-idempotency-store";
import { PgDurableSecurityAuditDecisionWriter } from "./api/security-audit";
import { buildServer } from "./api/server";
import { DenyAllSignedCommandRegistry, SecretStoreSignedCommandRegistry } from "./api/signed-command-registry";
import { assertArtifactStoreStartupCompatibility, loadApiConfig, loadApiLogLevel, loadArtifactLifecycleConsumer, loadCommonConfig, loadRunMode, loadScenarioGenerationLlmV1Config, type ApiConfig, type CommonConfig, type ScenarioGenerationLlmV1Config } from "./config/env";
import { createPool, type PgPool } from "./db/pool";
import { bootstrapMetrics, bootstrapTracing } from "./observability/bootstrap";
import { AjvStructuredOutputValidator } from "./gateway/ajv-structured-output-validator";
import { SafeCapabilityGate } from "./gateway/capability-gate";
import { CodexSseAdapter } from "./gateway/codex-sse-adapter";
import { FetchCodexSseTransport } from "./gateway/codex-sse-transport";
import { LlmGateway } from "./gateway/llm-gateway";
import { FsObjectStore } from "./gateway/pg-gateway-artifact-sink";
import { VaultSecretStore } from "./secrets/vault-secret-store";
import { DeterministicGatewayRedactionBoundary } from "../../gateway/redaction-boundary";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";
import type { ScenarioPlanner } from "./api/scenario-generation-types";
import type { ScenarioGenerationArtifactBuffer } from "./api/scenario-generation-artifacts";
import { buildApiSessionStore, startArtifactLifecycleWorker, startWorker, type ArtifactLifecycleRunner, type StartedWorker } from "./main-worker";

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

function buildScenarioGenerationPlannerBinding(
  pool: PgPool,
  cfg: ScenarioGenerationLlmV1Config,
  securityAudit: PgDurableSecurityAuditDecisionWriter,
): ScenarioGenerationPlannerBinding {
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
    securityAudit,
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
  const securityAudit = new PgDurableSecurityAuditDecisionWriter(pool);
  const scenarioPlanner = scenarioGenerationLlmV1 !== undefined
    ? buildScenarioGenerationPlannerBinding(pool, scenarioGenerationLlmV1, securityAudit)
    : undefined;
  const artifactObjectReader = await buildApiArtifactObjectReader(cfg);
  const selectorProbe = cfg.selectorProbe !== undefined
    ? new PuppeteerSelectorProbeProvider({
        chromeExecutablePath: cfg.selectorProbe.chromeExecutablePath,
        headless: cfg.selectorProbe.headless,
        timeoutMs: cfg.selectorProbe.timeoutMs,
      })
    : undefined;
  // 세션 캡처 봉투암호화 스토어 — KEK(api/browser_session) 프로비저닝 시에만 활성(미설정 → undefined → 엔드포인트 미등록, fail-closed).
  const sessionStore = await buildApiSessionStore(pool, common);
  const api = buildServer({
    pool,
    // 구조화 로거(pino, Fastify 번들) — authz 거부·라우트 미설정 경고·미분류 에러 경로의 request.log 가 실제 방출된다.
    //   Authorization/Cookie 헤더는 remove-redact 로 마스킹(secret 경계). 레벨은 API_LOG_LEVEL(기본 info)로 제어.
    logger: {
      level: loadApiLogLevel(),
      redact: { paths: ["req.headers.authorization", "req.headers.cookie"], remove: true },
    },
    auth: new JwtAuthenticationBoundary(buildJwtVerifier(cfg.jwt), {
      claimMapping: cfg.jwt.claimMapping,
      roleMap: cfg.jwt.roleMap,
    }),
    authReadiness: cfg.jwt.mode === "jwks"
      ? {
          mode: "jwks",
          configurationSource: "deployment_config",
          jwksUrl: cfg.jwt.jwksUrl,
          claimMapping: cfg.jwt.claimMapping,
          roleMap: cfg.jwt.roleMap,
          ...(cfg.jwt.issuer !== undefined ? { issuer: cfg.jwt.issuer } : {}),
          ...(cfg.jwt.audience !== undefined ? { audience: cfg.jwt.audience } : {}),
        }
      : {
          mode: "hs256",
          configurationSource: "deployment_config",
          claimMapping: cfg.jwt.claimMapping,
          roleMap: cfg.jwt.roleMap,
        },
    rbac: new RoleMatrixRbacMiddleware(),
    idempotency: new PgControlPlaneIdempotencyStore(pool),
    enqueuer: new PgGraphileRunEnqueuer(),
    principalDirectory: new PgPrincipalDirectory(pool),
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
    ...(selectorProbe !== undefined ? { selectorProbe } : {}),
    ...(artifactObjectReader !== undefined
      ? {
          artifactStore: artifactObjectReader,
          securityAudit,
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
    selectorProbe: selectorProbe !== undefined,
  }));
  return api;
}

/**
 * C4: 전역 OTel Provider 등록(부트스트랩). 미호출 시 getTracer()/getMeter() 가 no-op → 계측된 span/metric 전량
 * 폐기된다. exporter 선택은 env(OTEL_EXPORTER)에 위임(bootstrap.ts §): console=내장 exporter 로 stdout 표면화,
 * none=전역 Provider 미등록(no-op, 명시적 opt-out). OTLP(prod 수집 백엔드)는 후속 — 별도 exporter 패키지를 이
 * 선택지에 추가한다.
 */
function bootstrapObservability(common: CommonConfig): void {
  if (common.telemetryExporter === "none") {
    console.log(JSON.stringify({ at: "main", msg: "observability disabled (OTEL_EXPORTER=none)" }));
    return;
  }
  bootstrapTracing(new ConsoleSpanExporter());
  bootstrapMetrics(new PeriodicExportingMetricReader({ exporter: new ConsoleMetricExporter() }));
  console.log(JSON.stringify({ at: "main", msg: "observability bootstrapped", exporter: common.telemetryExporter }));
}

async function main(): Promise<void> {
  const mode = loadRunMode();
  const common = loadCommonConfig();
  bootstrapObservability(common);
  assertArtifactStoreStartupCompatibility(mode, mode === "worker" ? loadArtifactLifecycleConsumer() : undefined);
  const pool = createPool();
  // Fail fast on DB connectivity before binding anything.
  await pool.query("SELECT 1");

  const health = startHealthServer(pool, common.healthPort);
  let api: FastifyInstance | undefined;
  let worker: StartedWorker | undefined;
  let lifecycleRunner: ArtifactLifecycleRunner | undefined;

  // N1 fail-closed: RUN_MODE=worker 는 run-drive 가 artifact lifecycle job 을 인큐하므로 소비자 토폴로지를 명시 선언해야
  //   한다(미선언이면 loadArtifactLifecycleConsumer 가 throw — startWorker 전에 fail-fast). self → lifecycle-worker 인-프로세스 동반.
  const workerLifecycleConsumer = mode === "worker" ? loadArtifactLifecycleConsumer() : undefined;

  if (mode === "api" || mode === "all") api = await startApi(pool, common, mode);
  if (mode === "worker" || mode === "all") worker = await startWorker(pool, common);
  if (mode === "lifecycle-worker" || mode === "all" || workerLifecycleConsumer === "self")
    lifecycleRunner = await startArtifactLifecycleWorker();

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
