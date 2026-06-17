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
 *   - SinkDeliveryPort, SessionRestorer, RunAbortDrainer, a real SecretStore-backed SignedCommandRegistry (a
 *     fail-closed deny-all placeholder is used here — BLOCKED on a contract decision: no signed_command resolve
 *     authorization for the api identity + undefined registry signature algorithm), and a recurring sweeper
 *     scheduler. JWT verification now supports RS256 via remote JWKS (set JWKS_URL) or the HS256 default.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
import http from "node:http";

import { run, runMigrations, type Runner } from "graphile-worker";
import type { FastifyInstance } from "fastify";

import { hmacJwtVerifier, jwksRs256Verifier, JwtAuthenticationBoundary } from "./api/auth";
import { PgControlPlaneIdempotencyStore } from "./api/idempotency";
import { RoleMatrixRbacMiddleware } from "./api/rbac";
import { PgGraphileRunEnqueuer } from "./api/run-queue";
import { buildServer } from "./api/server";
import {
  loadApiConfig,
  loadBrowserConfig,
  loadCommonConfig,
  loadGatewayConfig,
  loadRunMode,
  loadWorkerConfig,
  type ApiConfig,
} from "./config/env";
import { createPool, type PgPool } from "./db/pool";
import { AjvStructuredOutputValidator } from "./gateway/ajv-structured-output-validator";
import { SafeCapabilityGate } from "./gateway/capability-gate";
import { CodexSseAdapter } from "./gateway/codex-sse-adapter";
import { FetchCodexSseTransport } from "./gateway/codex-sse-transport";
import { LlmGateway } from "./gateway/llm-gateway";
import { FsObjectStore, PgGatewayArtifactSink } from "./gateway/pg-gateway-artifact-sink";
import { StagehandBrowserSessionProvider } from "./executor/browser-session-provider";
import { PgChallengeSuspensionPort } from "./runtime/challenge-suspension-port";
import { createDomUtilityExecutorFactory } from "./runtime/dom-executor-factory";
import { HmacResumeTokenCodec } from "./runtime/resume-token-codec";
import { VaultSecretStore } from "./secrets/vault-secret-store";
import { buildTaskList } from "./worker/graphile-runner";
import { pgBrowserLeasePlanResolver } from "./worker/pg-browser-lease-plan-resolver";
import type { PgRuntimeWorkerOptions, RunExecutorFactory } from "./worker/runtime-worker";
import { DeterministicGatewayRedactionBoundary } from "../../gateway/redaction-boundary";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry, SignedCommandRegistryReadResult } from "../../ts/security-middleware-contract";

/**
 * Fail-closed deny-all SignedCommandRegistry placeholder. A real SecretStore-backed registry
 * (rpa/<env>/api/signed_command/registry-verify) is backlog; until then the scenario signed-command compile
 * path resolves to an EMPTY allow-list (every signed command denied) — never silently "available with unknown".
 */
class DenyAllSignedCommandRegistry implements SignedCommandRegistry {
  async listAllowedCommandRefs(): Promise<SignedCommandRegistryReadResult> {
    return {
      kind: "available",
      snapshot: { sourceRef: "secret://unconfigured/signed-command-registry" as SecretRef, commands: [] },
    };
  }
}

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

async function startApi(pool: PgPool): Promise<FastifyInstance> {
  const cfg = loadApiConfig();
  const api = buildServer({
    pool,
    auth: new JwtAuthenticationBoundary(buildJwtVerifier(cfg.jwt)),
    rbac: new RoleMatrixRbacMiddleware(),
    idempotency: new PgControlPlaneIdempotencyStore(pool),
    enqueuer: new PgGraphileRunEnqueuer(),
    signedCommandRegistry: new DenyAllSignedCommandRegistry(),
    security: { corsOrigins: cfg.corsOrigins, hsts: cfg.hsts },
    // artifactStore/securityAudit intentionally unset — artifact body-read stays unregistered until an
    // object_store-authorized credential is provisioned for the API identity (deploy-time, see backlog).
  });
  await api.listen({ host: "0.0.0.0", port: cfg.port });
  console.log(JSON.stringify({ at: "main", msg: "control-plane API listening", port: cfg.port, jwtMode: cfg.jwt.mode }));
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
    sink: new PgGatewayArtifactSink(pool, new FsObjectStore(gw.artifactDir), {
      retentionDays: gw.artifactRetentionDays,
    }),
    redactionBoundary: new DeterministicGatewayRedactionBoundary(),
    config: { retryMax: gw.retryMax, fallbackAttempts: gw.fallbackAttempts, repairAttempts: gw.repairAttempts },
  });
  return createDomUtilityExecutorFactory(gateway, {
    model: gw.codexModel,
    promptTemplateVersion: gw.promptTemplateVersion,
    budget: gw.budget,
  });
}

async function startWorker(pool: PgPool, connectionString: string): Promise<Runner> {
  const cfg = loadWorkerConfig(loadCommonConfig());
  // Install/upgrade the graphile_worker schema (idempotent; fails fast if the DB role lacks rights).
  await runMigrations({ connectionString });

  const runtimeWorkerStore = new VaultSecretStore({
    baseUrl: cfg.vaultRuntimeWorker.addr,
    mount: cfg.vaultRuntimeWorker.mount,
    kvApiVersion: 2,
    appRole: { roleId: cfg.vaultRuntimeWorker.roleId, secretId: cfg.vaultRuntimeWorker.secretId },
  });

  // Worker ports: the real adapters whose deps exist now. browserLeasePlanResolver resolves a run's
  // {site_profile, browser_identity, network_policy} from the scenario's ir.target (Pg, RLS-scoped).
  // executorFactory assembles the in-process LLM gateway (D8-A16) so dom primitives drive through Codex.
  // browserSessionProvider (real Stagehand/Chrome, backlog item 2) binds a live CDP session per lease at
  // claim time, putting the executorFactory on the live drive path — bind() launches Chrome from
  // CHROME_EXECUTABLE_PATH (deploy-provisioned) and loud-throws if it is absent (fail-closed, no silent
  // claim-only). Still-unwired drive-path ports (sink delivery, session restorer, abort drainer) loud-throw
  // per job kind when needed, see SCOPE above.
  const browser = loadBrowserConfig();
  const workerOptions: PgRuntimeWorkerOptions = {
    suspensionPort: new PgChallengeSuspensionPort(),
    resumeTokenCodec: new HmacResumeTokenCodec(runtimeWorkerStore, cfg.resumeTokenRef as SecretRef),
    browserLeasePlanResolver: pgBrowserLeasePlanResolver,
    executorFactory: buildExecutorFactory(pool),
    browserSessionProvider: new StagehandBrowserSessionProvider({
      chromeExecutablePath: browser.chromeExecutablePath,
      headless: browser.headless,
      ...(browser.downloadRootDir !== undefined ? { downloadRootDir: browser.downloadRootDir } : {}),
    }),
  };

  const runner = await run({
    connectionString,
    taskList: buildTaskList(pool, workerOptions),
    concurrency: cfg.graphileConcurrency,
    pollInterval: cfg.graphilePollIntervalMs,
    ...(cfg.graphileSchema !== undefined ? { schema: cfg.graphileSchema } : {}),
  });
  console.log(JSON.stringify({ at: "main", msg: "worker daemon running", concurrency: cfg.graphileConcurrency }));
  return runner;
}

async function main(): Promise<void> {
  const mode = loadRunMode();
  const common = loadCommonConfig();
  const pool = createPool();
  // Fail fast on DB connectivity before binding anything.
  await pool.query("SELECT 1");

  const health = startHealthServer(pool, common.healthPort);
  let api: FastifyInstance | undefined;
  let runner: Runner | undefined;

  if (mode === "api" || mode === "all") api = await startApi(pool);
  if (mode === "worker" || mode === "all") runner = await startWorker(pool, common.connectionString);

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
        if (runner !== undefined) await runner.stop();
      } finally {
        await pool.end().catch(() => undefined);
      }
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

void main().catch((e) => {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  console.error(JSON.stringify({ at: "main", fatal: text }));
  process.exit(1);
});
