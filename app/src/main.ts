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
 * job paths that need them ("조용한 false 금지" — never a silent no-op). Enumerated backlog (see
 * product-open-candidate-report.md / staging-deploy-runbook.md):
 *   - StagehandBrowserSessionProvider + real Chrome, executorFactory/LlmGateway wiring (the ajv
 *     StructuredOutputValidator now exists; needs gateway assembly), SinkDeliveryPort, SessionRestorer,
 *     RunAbortDrainer, a real SecretStore-backed SignedCommandRegistry (a fail-closed deny-all placeholder is
 *     used here), a JWKS/RS256 JWT verifier (HS256 is used here), and a recurring sweeper scheduler.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
import http from "node:http";

import { run, runMigrations, type Runner } from "graphile-worker";
import type { FastifyInstance } from "fastify";

import { hmacJwtVerifier, JwtAuthenticationBoundary } from "./api/auth";
import { PgControlPlaneIdempotencyStore } from "./api/idempotency";
import { RoleMatrixRbacMiddleware } from "./api/rbac";
import { PgGraphileRunEnqueuer } from "./api/run-queue";
import { buildServer } from "./api/server";
import { loadApiConfig, loadCommonConfig, loadRunMode, loadWorkerConfig } from "./config/env";
import { createPool, type PgPool } from "./db/pool";
import { PgChallengeSuspensionPort } from "./runtime/challenge-suspension-port";
import { HmacResumeTokenCodec } from "./runtime/resume-token-codec";
import { VaultSecretStore } from "./secrets/vault-secret-store";
import { buildTaskList } from "./worker/graphile-runner";
import { pgBrowserLeasePlanResolver } from "./worker/pg-browser-lease-plan-resolver";
import type { PgRuntimeWorkerOptions } from "./worker/runtime-worker";
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

async function startApi(pool: PgPool): Promise<FastifyInstance> {
  const cfg = loadApiConfig();
  const api = buildServer({
    pool,
    auth: new JwtAuthenticationBoundary(hmacJwtVerifier(new TextEncoder().encode(cfg.jwtHs256Secret))),
    rbac: new RoleMatrixRbacMiddleware(),
    idempotency: new PgControlPlaneIdempotencyStore(pool),
    enqueuer: new PgGraphileRunEnqueuer(),
    signedCommandRegistry: new DenyAllSignedCommandRegistry(),
    security: { corsOrigins: cfg.corsOrigins, hsts: cfg.hsts },
    // artifactStore/securityAudit intentionally unset — artifact body-read stays unregistered until an
    // object_store-authorized credential is provisioned for the API identity (deploy-time, see backlog).
  });
  await api.listen({ host: "0.0.0.0", port: cfg.port });
  console.log(JSON.stringify({ at: "main", msg: "control-plane API listening", port: cfg.port }));
  return api;
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
  // Still-unwired drive-path ports (browser session provider + real Chrome, executor factory/validator,
  // sink delivery, session restorer, abort drainer) loud-throw per job kind when needed (fail-closed),
  // see SCOPE above.
  const workerOptions: PgRuntimeWorkerOptions = {
    suspensionPort: new PgChallengeSuspensionPort(),
    resumeTokenCodec: new HmacResumeTokenCodec(runtimeWorkerStore, cfg.resumeTokenRef as SecretRef),
    browserLeasePlanResolver: pgBrowserLeasePlanResolver,
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
