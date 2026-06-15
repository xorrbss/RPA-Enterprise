#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const isWin = process.platform === "win32";
const ROLE = "rpa_smoke";
const DATABASE = "rpa_contract_gate";
const ROLE_PASSWORD = "rpa_smoke";

const parsed = parseArgs(process.argv.slice(2));
if (parsed.help) {
  printUsage();
  process.exit(0);
}

const bin = discoverPostgresBinaries();
const tempRoot = mkdtempSync(join(tmpdir(), "rpa-pg15-smoke-"));
const dataDir = join(tempRoot, "data");
const logFile = join(tempRoot, "postgres.log");
let started = false;
let targetStatus = 0;

try {
  const port = parsed.port ?? await findFreePort();
  console.log(`temp postgres gate: using PostgreSQL tools from ${bin.label}`);
  console.log(`temp postgres gate: data=${dataDir} port=${port}`);

  run(bin.initdb, ["-D", dataDir, "--username=postgres", "--auth=trust", "--encoding=UTF8", "--locale=C"], {
    diagnostic: "initialize temporary PostgreSQL cluster",
    timeoutMs: 120000,
  });

  run(bin.pgCtl, ["-D", dataDir, "-l", logFile, "-o", `-p ${port} -h 127.0.0.1`, "-w", "-t", "30", "start"], {
    diagnostic: "start temporary PostgreSQL cluster",
    timeoutMs: 60000,
  });
  started = true;

  const adminEnv = { ...process.env, PGCONNECT_TIMEOUT: "5" };
  run(bin.psql, [
    "-v",
    "ON_ERROR_STOP=1",
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-c",
    `CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;`,
  ], {
    diagnostic: "create non-bypass smoke role",
    env: adminEnv,
    timeoutMs: 30000,
  });
  run(bin.psql, [
    "-v",
    "ON_ERROR_STOP=1",
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-c",
    `CREATE DATABASE ${DATABASE} OWNER ${ROLE};`,
  ], {
    diagnostic: "create smoke database",
    env: adminEnv,
    timeoutMs: 30000,
  });

  const roleCheck = run(bin.psql, [
    "-v",
    "ON_ERROR_STOP=1",
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-Atc",
    `SELECT rolsuper::text || E'\\t' || rolbypassrls::text FROM pg_roles WHERE rolname = '${ROLE}';`,
  ], {
    diagnostic: "verify smoke role privileges",
    env: adminEnv,
    capture: true,
    timeoutMs: 30000,
  }).stdout.trim();
  if (roleCheck !== "false\tfalse") {
    fail([`temporary smoke role must be non-SUPERUSER/non-BYPASSRLS; got ${JSON.stringify(roleCheck)}`], 2);
  }
  console.log(`temp postgres gate: verified ${ROLE} is non-SUPERUSER/non-BYPASSRLS`);

  const command = targetCommand(parsed);
  console.log(`temp postgres gate: running ${command.join(" ")}`);
  const env = {
    ...process.env,
    PSQL_BIN: bin.psql,
    PGHOST: "127.0.0.1",
    PGPORT: String(port),
    PGDATABASE: DATABASE,
    PGUSER: ROLE,
    PGPASSWORD: ROLE_PASSWORD,
    PGCONNECT_TIMEOUT: "5",
  };
  delete env.PGSERVICE;
  delete env.PGPASSFILE;

  const status = runTarget(command, env);
  targetStatus = status;
  if (status === 0) {
    console.log("temp postgres gate: command passed");
  }
} finally {
  if (started) {
    const stopResult = spawnSync(bin.pgCtl, ["-D", dataDir, "-m", "fast", "-w", "-t", "30", "stop"], {
      cwd: ROOT,
      stdio: "inherit",
      encoding: "utf8",
      timeout: 45000,
    });
    if (stopResult.error?.code === "ETIMEDOUT" || stopResult.status !== 0) {
      console.error(`WARN: fast PostgreSQL shutdown failed for ${dataDir}; trying immediate no-wait stop`);
      spawnSync(bin.pgCtl, ["-D", dataDir, "-m", "immediate", "-W", "stop"], {
        cwd: ROOT,
        stdio: "inherit",
        encoding: "utf8",
        timeout: 5000,
      });
    }
  }
  if (parsed.keepTemp) {
    console.log(`temp postgres gate: kept ${tempRoot}`);
  } else {
    cleanupTemp(tempRoot);
  }
}

if (targetStatus !== 0) process.exit(targetStatus);

function parseArgs(args) {
  const commandIndex = args.indexOf("--");
  const optionArgs = commandIndex === -1 ? args : args.slice(0, commandIndex);
  const command = commandIndex === -1 ? [] : args.slice(commandIndex + 1);
  let help = false;
  let keepTemp = process.env.PG_TEMP_KEEP === "1";
  let preflightOnly = false;
  let localGates = false;
  let port;

  for (let i = 0; i < optionArgs.length; i += 1) {
    const arg = optionArgs[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--keep-temp") {
      keepTemp = true;
    } else if (arg === "--preflight-only") {
      preflightOnly = true;
    } else if (arg === "--local-gates") {
      localGates = true;
    } else if (arg === "--port") {
      const value = optionArgs[i + 1];
      if (value === undefined) fail(["--port requires a value"], 2);
      port = Number(value);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) fail([`invalid --port value: ${value}`], 2);
      i += 1;
    } else {
      fail([`unknown option: ${arg}`], 2);
    }
  }

  if (preflightOnly && localGates) fail(["--preflight-only cannot be combined with --local-gates"], 2);
  if (command.length > 0 && (preflightOnly || localGates)) {
    fail(["custom command after -- cannot be combined with --preflight-only or --local-gates"], 2);
  }

  return { help, keepTemp, preflightOnly, localGates, port, command };
}

function targetCommand(parsed) {
  if (parsed.command.length > 0) return parsed.command;
  if (parsed.localGates) return ["node", "scripts/run-local-gates.mjs"];
  if (parsed.preflightOnly) return ["node", "scripts/db-migration-smoke.mjs", "--preflight-only", "--require-non-bypass"];
  return ["node", "scripts/db-migration-smoke.mjs", "--require-non-bypass"];
}

function discoverPostgresBinaries() {
  const exe = isWin ? ".exe" : "";
  const dirs = [
    process.env.PG_BIN_DIR?.trim(),
    process.env.POSTGRES_BIN_DIR?.trim(),
    process.env.PSQL_BIN?.trim() ? dirname(process.env.PSQL_BIN.trim()) : undefined,
    findOnPath(isWin ? "psql.exe" : "psql"),
    ...(isWin ? windowsPostgresDirs() : unixPostgresDirs()),
  ].filter((candidate) => candidate !== undefined && candidate.length > 0);

  for (const dirOrPsql of dirs) {
    const dir = basename(dirOrPsql).toLowerCase().startsWith("psql") ? dirname(dirOrPsql) : dirOrPsql;
    const bin = {
      psql: process.env.PSQL_BIN?.trim() || join(dir, `psql${exe}`),
      initdb: process.env.INITDB_BIN?.trim() || join(dir, `initdb${exe}`),
      pgCtl: process.env.PG_CTL_BIN?.trim() || join(dir, `pg_ctl${exe}`),
      postgres: process.env.POSTGRES_BIN?.trim() || join(dir, `postgres${exe}`),
      label: dir,
    };
    if ([bin.psql, bin.initdb, bin.pgCtl, bin.postgres].every((tool) => existsSync(tool)) && isPostgres15(bin.postgres)) {
      return {
        psql: resolve(bin.psql),
        initdb: resolve(bin.initdb),
        pgCtl: resolve(bin.pgCtl),
        postgres: resolve(bin.postgres),
        label: resolve(bin.label),
      };
    }
  }

  fail([
    "could not find PostgreSQL 15+ psql/initdb/pg_ctl/postgres binaries.",
    "Set PG_BIN_DIR, or set PSQL_BIN plus optional INITDB_BIN/PG_CTL_BIN/POSTGRES_BIN.",
  ], 2);
}

function windowsPostgresDirs() {
  const roots = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    "C:\\Program Files",
    "C:\\Program Files (x86)",
  ].filter((root) => root !== undefined && root.length > 0);
  const dirs = [];
  for (const root of roots) {
    const pgRoot = join(root, "PostgreSQL");
    if (!existsSync(pgRoot)) continue;
    try {
      for (const child of readdirSync(pgRoot)) dirs.push(join(pgRoot, child, "bin"));
    } catch {
      // Ignore unreadable install roots; explicit env vars remain available.
    }
  }
  return [...new Set(dirs)].sort().reverse();
}

function unixPostgresDirs() {
  return [
    "/usr/lib/postgresql/18/bin",
    "/usr/lib/postgresql/17/bin",
    "/usr/lib/postgresql/16/bin",
    "/usr/lib/postgresql/15/bin",
    "/opt/homebrew/opt/postgresql@15/bin",
    "/usr/local/opt/postgresql@15/bin",
  ];
}

function isPostgres15(postgres) {
  const result = spawnSync(postgres, ["--version"], {
    cwd: ROOT,
    stdio: "pipe",
    encoding: "utf8",
  });
  const match = result.stdout.match(/\(PostgreSQL\)\s+(\d+)(?:\.(\d+))?/);
  return result.status === 0 && match !== null && Number(match[1]) >= 15;
}

function findOnPath(command) {
  const result = spawnSync(isWin ? "where.exe" : "which", [command], {
    cwd: ROOT,
    stdio: "pipe",
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  const psql = result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  return psql === undefined ? undefined : dirname(psql);
}

async function findFreePort() {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("unable to allocate TCP port")));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: options.capture ? "pipe" : "inherit",
    env: options.env || process.env,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30000,
  });

  if (result.error?.code === "ENOENT") {
    fail([`${basename(command)} is required to ${options.diagnostic}`], 2);
  }

  if (result.error?.code === "ETIMEDOUT") {
    fail([`${basename(command)} timed out while trying to ${options.diagnostic}`], 124);
  }

  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stderr);
      process.stdout.write(result.stdout);
    }
    fail([`${basename(command)} failed while trying to ${options.diagnostic}`], result.status ?? 1);
  }

  return result;
}

function runTarget(command, env) {
  const executable = isWin && ["npm", "npx"].includes(command[0]) ? `${command[0]}.cmd` : command[0];
  const spawnCommand = isWin ? "cmd.exe" : executable;
  const spawnArgs = isWin
    ? ["/d", "/s", "/c", [executable, ...command.slice(1)].map(quoteCmdArg).join(" ")]
    : command.slice(1);
  const result = spawnSync(spawnCommand, spawnArgs, {
    cwd: ROOT,
    stdio: "inherit",
    env,
  });
  if (result.error?.code === "ENOENT") {
    console.error(`FAIL: ${command[0]} is not available on PATH`);
    return 2;
  }
  return result.status ?? 1;
}

function quoteCmdArg(value) {
  if (/^[A-Za-z0-9_./:=\\-]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

function cleanupTemp(tempRoot) {
  const resolvedTemp = resolve(tempRoot);
  const resolvedOsTemp = resolve(tmpdir());
  if (!resolvedTemp.startsWith(resolvedOsTemp) || !basename(resolvedTemp).startsWith("rpa-pg15-smoke-")) {
    console.error(`WARN: refusing to remove unexpected temp path ${resolvedTemp}`);
    return;
  }
  try {
    rmSync(resolvedTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.error(`WARN: failed to remove temp path ${resolvedTemp}: ${error.message}`);
  }
}

function printUsage() {
  console.log([
    "Usage: node scripts/db-temp-postgres-gate.mjs [--preflight-only] [--local-gates] [--keep-temp] [--port PORT] [-- command ...]",
    "",
    "Starts a disposable PostgreSQL 15 cluster on 127.0.0.1, creates a",
    "non-SUPERUSER/non-BYPASSRLS rpa_smoke role, runs the selected gate with",
    "PSQL_BIN/PGHOST/PGPORT/PGDATABASE/PGUSER set, then stops and removes the cluster.",
    "",
    "Default gate:",
    "  node scripts/db-migration-smoke.mjs --require-non-bypass",
    "",
    "Examples:",
    "  npm --prefix codegen run db:temp-smoke",
    "  npm --prefix codegen run ci:local:temp-db",
    "  node scripts/db-temp-postgres-gate.mjs -- npm --prefix codegen run db:smoke",
  ].join("\n"));
}

function fail(lines, code) {
  console.error(["FAIL:", ...lines.map((line) => `  ${line}`)].join("\n"));
  process.exit(code);
}
