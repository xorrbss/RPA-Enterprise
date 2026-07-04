/**
 * Unauthenticated health/readiness probe server for the production composition root (app/src/main.ts).
 * Separate http server on HEALTH_PORT — bypasses the Fastify auth/RBAC chain by design.
 */
import http from "node:http";

import type { PrometheusExporter } from "@opentelemetry/exporter-prometheus";

import type { PgPool } from "./db/pool";

const REQUIRED_SCHEMA_MIGRATION_VERSIONS = ["0001", "0002"] as const;

interface HealthReadiness {
  readonly ready: boolean;
  readonly reason?: string;
}

async function readHealthReadiness(pool: PgPool): Promise<HealthReadiness> {
  await pool.query("SELECT 1");
  const ledger = await pool.query<{ schema_migrations_regclass: string | null }>(
    `SELECT to_regclass('public.schema_migrations')::text AS schema_migrations_regclass`,
  );
  if (ledger.rows[0]?.schema_migrations_regclass === null || ledger.rows[0]?.schema_migrations_regclass === undefined) {
    return { ready: false, reason: "schema_migrations_missing" };
  }

  const applied = await pool.query<{ applied_count: string }>(
    `SELECT count(*)::text AS applied_count
       FROM schema_migrations
      WHERE version = ANY($1::text[])
        AND status = 'applied'`,
    [[...REQUIRED_SCHEMA_MIGRATION_VERSIONS]],
  );
  const appliedCount = Number(applied.rows[0]?.applied_count ?? 0);
  if (appliedCount !== REQUIRED_SCHEMA_MIGRATION_VERSIONS.length) {
    return { ready: false, reason: "schema_migrations_incomplete" };
  }

  const role = await pool.query<{ bypasses_rls: string }>(
    `SELECT COALESCE((SELECT (rolsuper OR rolbypassrls)::text FROM pg_roles WHERE rolname = current_user), 'unknown') AS bypasses_rls`,
  );
  if (role.rows[0]?.bypasses_rls !== "false") {
    return { ready: false, reason: "db_role_bypasses_rls" };
  }
  return { ready: true };
}

/** Unauthenticated health probe server (separate http server — bypasses the Fastify auth/RBAC chain). */
export function startHealthServer(pool: PgPool, port: number, prometheusExporter?: PrometheusExporter): http.Server {
  const server = http.createServer((reqMsg, res) => {
    const url = reqMsg.url ?? "/";
    if (url === "/livez") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "live" }));
      return;
    }
    if (url === "/readyz") {
      readHealthReadiness(pool)
        .then((readiness) => {
          if (!readiness.ready) {
            res.writeHead(503, { "content-type": "application/json" });
            res.end(JSON.stringify({ status: "not-ready", reason: readiness.reason }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "ready" }));
        })
        .catch((err: unknown) => {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "not-ready", reason: String(err) }));
        });
      return;
    }
    if (url === "/metrics" && prometheusExporter !== undefined) {
      prometheusExporter.getMetricsRequestHandler(reqMsg, res);
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
