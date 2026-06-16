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

export interface ApiConfig {
  readonly port: number;
  /** HS256 JWT verification secret. Resolved out-of-band (env) because no `jwt` SecretRef purpose exists in
   *  the least-privilege matrix yet (backlog: JWKS/RS256 verifier + Vault purpose). Fail-closed required. */
  readonly jwtHs256Secret: string;
  /** Console origin allowlist for CORS; omit for same-origin (no CORS registered). No wildcard. */
  readonly corsOrigins?: readonly string[];
  readonly hsts: boolean;
}

export function loadApiConfig(): ApiConfig {
  const origins = opt("CORS_ORIGINS");
  const jwtHs256Secret = req("JWT_HS256_SECRET");
  if (jwtHs256Secret.length < 32) {
    throw new Error("JWT_HS256_SECRET must be at least 32 characters (HS256 key strength)");
  }
  return {
    port: num("PORT", 8080),
    jwtHs256Secret,
    corsOrigins: origins
      ? origins.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined,
    hsts: bool("ENABLE_HSTS", true),
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
  readonly graphileSchema?: string;
  readonly graphileConcurrency: number;
  readonly graphilePollIntervalMs: number;
}

export function loadWorkerConfig(common: CommonConfig): WorkerConfig {
  return {
    vaultRuntimeWorker: loadVaultIdentity("RUNTIME_WORKER"),
    resumeTokenRef: `rpa/${common.rpaEnv}/runtime-worker/resume_token_hmac/active`,
    graphileSchema: opt("GRAPHILE_WORKER_SCHEMA"),
    graphileConcurrency: num("GRAPHILE_CONCURRENCY", 1),
    graphilePollIntervalMs: num("GRAPHILE_POLL_INTERVAL_MS", 2000),
  };
}
