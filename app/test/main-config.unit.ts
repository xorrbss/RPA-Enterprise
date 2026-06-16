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
  loadRunMode,
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
  "VAULT_RUNTIME_WORKER_ROLE_ID", "VAULT_RUNTIME_WORKER_SECRET_ID",
  "GRAPHILE_WORKER_SCHEMA", "GRAPHILE_CONCURRENCY", "GRAPHILE_POLL_INTERVAL_MS",
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
};

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

  // ApiConfig — fail-closed on missing/short JWT secret; CORS parse; HSTS default.
  withEnv({ ...FULL, JWT_HS256_SECRET: "" }, () => expectThrow("api blank JWT throws", () => loadApiConfig()));
  withEnv({ ...FULL, JWT_HS256_SECRET: "short" }, () => expectThrow("api short JWT (<32) throws", () => loadApiConfig()));
  withEnv(FULL, () => {
    const a = loadApiConfig();
    check("api port", a.port === 8080);
    check("api hsts default true", a.hsts === true);
    check("api cors undefined when unset", a.corsOrigins === undefined);
  });
  withEnv({ ...FULL, CORS_ORIGINS: "https://a.example, https://b.example" }, () => {
    const a = loadApiConfig();
    check("api cors parsed", a.corsOrigins?.length === 2 && a.corsOrigins[0] === "https://a.example");
  });

  // WorkerConfig — fail-closed on missing Vault AppRole; resumeTokenRef templated from rpaEnv.
  const common: CommonConfig = { rpaEnv: "staging", connectionString: "x", healthPort: 8081 };
  withEnv({}, () => expectThrow("worker missing Vault AppRole throws", () => loadWorkerConfig(common)));
  withEnv(FULL, () => {
    const w = loadWorkerConfig(common);
    check(
      "worker resumeTokenRef templated",
      w.resumeTokenRef === "rpa/staging/runtime-worker/resume_token_hmac/active",
      w.resumeTokenRef,
    );
    check("worker concurrency default 1", w.graphileConcurrency === 1);
  });

  if (failures > 0) {
    console.error(`\nmain-config.unit: ${failures} FAIL`);
    process.exit(1);
  }
  console.log("\nmain-config.unit: ALL PASS");
}

main();
