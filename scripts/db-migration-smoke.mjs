#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const smokeFile = join(ROOT, "db", "migration_smoke.sql");
const psql = process.env.PSQL_BIN?.trim() || (process.platform === "win32" ? "psql.exe" : "psql");
const args = new Set(process.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
  printUsage();
  process.exit(0);
}

const requireNonBypass = args.has("--require-non-bypass");
const unknownArgs = [...args].filter((arg) => arg !== "--preflight-only" && arg !== "--require-non-bypass");
if (unknownArgs.length > 0) {
  fail([`unknown option(s): ${unknownArgs.join(", ")}`], 2);
}

const versionOutput = run(psql, ["--version"], {
  allowOutput: false,
  diagnostic: "detect PostgreSQL client",
}).stdout;
assertPostgres15Client(versionOutput);

console.log(
  `db migration smoke: using ${describePsql()} against ${describePgTarget()} with ${versionOutput.trim()}`,
);

const serverInfo = readServerInfo();
assertPostgres15Server(serverInfo);
console.log(
  `db migration smoke: connected to PostgreSQL ${serverInfo.serverVersion} as ${serverInfo.user} on ${serverInfo.database}`,
);

if (serverInfo.bypassesRls === "true") {
  if (requireNonBypass) {
    fail([
      "current role has SUPERUSER or BYPASSRLS, but --require-non-bypass was set.",
      "Use a PostgreSQL role with NOSUPERUSER and NOBYPASSRLS for release DB smoke evidence.",
    ], 2);
  }
  console.warn(
    "WARN: current role has SUPERUSER or BYPASSRLS; row-visibility assertions will be skipped. Repeat under a non-bypass application/migration role for Product Open.",
  );
} else if (serverInfo.bypassesRls !== "false") {
  if (requireNonBypass) {
    fail([
      "could not prove current role BYPASSRLS status, but --require-non-bypass was set.",
      "Release DB smoke evidence must prove a NOSUPERUSER/NOBYPASSRLS role.",
    ], 2);
  }
  console.warn(
    "WARN: could not prove current role BYPASSRLS status; Product Open still requires one non-bypass RLS smoke run.",
  );
}

if (args.has("--preflight-only")) {
  console.log("db migration smoke: preflight passed");
  process.exit(0);
}

run(psql, ["-X", "-v", "ON_ERROR_STOP=1", "-f", smokeFile], {
  allowOutput: true,
  diagnostic: "run migration smoke SQL",
});

const postureEvidence = serverInfo.bypassesRls === "false"
  ? "non-bypass RLS/redaction row-visibility assertions executed"
  : "catalog/non-RLS assertions only; Product Open still requires one non-SUPERUSER/non-BYPASSRLS role run";
console.log(`db migration smoke: PostgreSQL 15 contract smoke passed (${postureEvidence})`);

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: options.allowOutput ? "inherit" : "pipe",
    env: process.env,
    encoding: "utf8",
  });

  if (result.error?.code === "ENOENT") {
    fail([
      `psql is required for db migration smoke (${options.diagnostic}).`,
      "Install the PostgreSQL 15 client, put psql on PATH, or set PSQL_BIN to the psql executable.",
      `Current target: ${describePgTarget()}.`,
      ...containerDiagnostics(),
    ], 2);
  }

  if (result.status !== 0) {
    if (!options.allowOutput) {
      process.stderr.write(result.stderr);
      process.stdout.write(result.stdout);
    }
    fail([
      `psql failed while trying to ${options.diagnostic}.`,
      `Current target: ${describePgTarget()}.`,
      "Check PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD or PGSERVICE, and verify the target database already exists.",
      ...containerDiagnostics(),
    ], result.status ?? 1);
  }

  return result;
}

function assertPostgres15Client(versionOutput) {
  const match = versionOutput.match(/\(PostgreSQL\)\s+(\d+)(?:\.(\d+))?/);
  if (!match) {
    fail([`unable to parse psql version output: ${versionOutput.trim()}`], 2);
  }

  const major = Number(match[1]);
  if (major < 15) {
    fail([`PostgreSQL 15+ client is required; found ${versionOutput.trim()}`], 2);
  }
}

function assertPostgres15Server(serverInfo) {
  const serverVersionNum = Number(serverInfo.serverVersionNum);
  if (!Number.isInteger(serverVersionNum)) {
    fail([`unable to parse server_version_num: ${serverInfo.serverVersionNum}`], 2);
  }
  if (serverVersionNum < 150000) {
    fail([
      `PostgreSQL 15+ server is required; found ${serverInfo.serverVersion} (${serverInfo.serverVersionNum}).`,
    ], 2);
  }
}

function readServerInfo() {
  const sql = [
    "SELECT",
    "current_setting('server_version_num')",
    "|| E'\\t' || current_setting('server_version')",
    "|| E'\\t' || current_database()",
    "|| E'\\t' || current_user",
    "|| E'\\t' || COALESCE((SELECT (rolsuper OR rolbypassrls)::text FROM pg_roles WHERE rolname = current_user), 'unknown')",
  ].join(" ");
  const result = run(psql, ["-X", "-v", "ON_ERROR_STOP=1", "-Atqc", sql], {
    allowOutput: false,
    diagnostic: "connect to PostgreSQL server",
  });
  const [serverVersionNum, serverVersion, database, user, bypassesRls] = result.stdout.trim().split("\t");
  if (!serverVersionNum || !serverVersion || !database || !user || !bypassesRls) {
    fail([`unexpected PostgreSQL preflight output: ${JSON.stringify(result.stdout.trim())}`], 2);
  }
  return { serverVersionNum, serverVersion, database, user, bypassesRls };
}

function describePgTarget() {
  const host = process.env.PGHOST || "default local socket/localhost";
  const port = process.env.PGPORT || "default";
  const database = process.env.PGDATABASE || "current user default";
  const user = process.env.PGUSER || "current OS user";
  const password = process.env.PGPASSWORD ? "<set>" : "<unset>";
  const service = process.env.PGSERVICE || "<unset>";
  return `PGHOST=${host} PGPORT=${port} PGDATABASE=${database} PGUSER=${user} PGPASSWORD=${password} PGSERVICE=${service}`;
}

function describePsql() {
  return process.env.PSQL_BIN?.trim() ? `${psql} (PSQL_BIN)` : `${psql} (PATH)`;
}

function containerDiagnostics() {
  const runtimes = detectContainerRuntimes();
  if (runtimes.length === 0) {
    return [
      "No Docker or Podman CLI was detected on PATH, so this script cannot suggest a local container fallback.",
    ];
  }

  const runtime = runtimes[0];
  return [
    `Detected container runtime: ${runtimes.join(", ")}.`,
    `Container-only smoke fallback: ${runtime} run --rm --name rpa-pg15-smoke -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=rpa_contract_gate -p 55432:5432 -v <repo-absolute-path>:/work -w /work postgres:15`,
    `Then run inside that container: ${runtime} exec -w /work rpa-pg15-smoke psql -U postgres -d rpa_contract_gate -v ON_ERROR_STOP=1 -f db/migration_smoke.sql`,
  ];
}

function detectContainerRuntimes() {
  return ["docker", "podman"].filter((runtime) => {
    const result = spawnSync(runtime, ["--version"], {
      cwd: ROOT,
      stdio: "pipe",
      encoding: "utf8",
    });
    return !result.error && result.status === 0;
  });
}

function printUsage() {
  console.log([
    "Usage: node scripts/db-migration-smoke.mjs [--preflight-only] [--require-non-bypass]",
    "",
    "Environment:",
    "  PSQL_BIN     Optional path to PostgreSQL 15+ psql. Defaults to psql on PATH.",
    "  PGHOST       PostgreSQL host, or libpq default when unset.",
    "  PGPORT       PostgreSQL port, or libpq default when unset.",
    "  PGDATABASE   Target database. The smoke creates and rolls back an isolated schema inside it.",
    "  PGUSER       Database role. Product Open release evidence should use --require-non-bypass.",
    "  PGPASSWORD   Database password. Never printed by this script.",
    "  PGSERVICE    Optional libpq service name.",
  ].join("\n"));
}

function fail(lines, code) {
  console.error(["FAIL:", ...lines.map((line) => `  ${line}`)].join("\n"));
  process.exit(code);
}
