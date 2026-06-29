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
const RESTORE_DATABASE = "rpa_contract_gate_restore";
const ROLE_PASSWORD = "rpa_smoke";
const RESTORE_TENANT_ID = "10000000-0000-0000-0000-000000009001";
const RESTORE_SITE_ID = "10000000-0000-0000-0000-000000009002";
const RESTORE_WORKER_ID = "10000000-0000-0000-0000-000000009003";

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
    DATABASE,
    "-c",
    `GRANT USAGE, CREATE ON SCHEMA public TO ${ROLE}; GRANT CREATE ON DATABASE ${DATABASE} TO ${ROLE};`,
  ], {
    diagnostic: "grant smoke role migration DDL scope",
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

  const status = parsed.restoreDrill ? runRestoreDrill(bin, port, adminEnv, env) : runSelectedTarget(parsed, env);
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
  let restoreDrill = false;
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
    } else if (arg === "--restore-drill") {
      restoreDrill = true;
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

  const selectedModes = [preflightOnly, localGates, restoreDrill].filter(Boolean).length;
  if (selectedModes > 1) fail(["--preflight-only, --local-gates, and --restore-drill are mutually exclusive"], 2);
  if (command.length > 0 && selectedModes > 0) {
    fail(["custom command after -- cannot be combined with --preflight-only, --local-gates, or --restore-drill"], 2);
  }

  return { help, keepTemp, preflightOnly, localGates, restoreDrill, port, command };
}

function runSelectedTarget(parsed, env) {
  const command = targetCommand(parsed);
  console.log(`temp postgres gate: running ${command.join(" ")}`);
  return runTarget(command, env);
}

function targetCommand(parsed) {
  if (parsed.command.length > 0) return parsed.command;
  if (parsed.localGates) return ["node", "scripts/run-local-gates.mjs"];
  if (parsed.preflightOnly) return ["node", "scripts/db-migration-smoke.mjs", "--preflight-only", "--require-non-bypass"];
  return ["node", "scripts/db-migration-smoke.mjs", "--require-non-bypass"];
}

function runRestoreDrill(bin, port, adminEnv, sourceEnv) {
  requireRestoreTool(bin.pgDump, "pg_dump");
  requireRestoreTool(bin.pgRestore, "pg_restore");

  console.log("temp postgres gate: running restore drill");
  const migrate = ["node", "scripts/db-migrate.mjs", "--smoke", "--require-non-bypass"];
  console.log(`temp postgres restore drill: source migrate ${migrate.join(" ")}`);
  const migrateStatus = runTarget(migrate, sourceEnv);
  if (migrateStatus !== 0) return migrateStatus;

  runPsql(bin.psql, port, ROLE, DATABASE, seedRestoreDrillSql(), {
    diagnostic: "seed restore drill source rows",
    env: sourceEnv,
    timeoutMs: 30000,
  });

  const sourceCounts = restoreDrillCounts(bin.psql, port, DATABASE, sourceEnv);
  assertRestoreCounts("source", sourceCounts);
  console.log(
    `temp postgres restore drill: seeded source rows (schema_migrations=${sourceCounts.migrations}, site=${sourceCounts.site}, worker=${sourceCounts.worker})`,
  );

  const dumpDir = mkdtempSync(join(tmpdir(), "rpa-restore-drill-"));
  const dumpFile = join(dumpDir, "backup.dump");
  try {
    run(bin.pgDump, ["-Fc", "-d", DATABASE, "-f", dumpFile], {
      diagnostic: "create logical backup for restore drill",
      env: { ...adminEnv, PGHOST: "127.0.0.1", PGPORT: String(port), PGUSER: "postgres", PGDATABASE: DATABASE },
      timeoutMs: 120000,
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
      `CREATE DATABASE ${RESTORE_DATABASE} OWNER ${ROLE};`,
    ], {
      diagnostic: "create restore drill target database",
      env: adminEnv,
      timeoutMs: 30000,
    });

    run(bin.pgRestore, ["-d", RESTORE_DATABASE, dumpFile], {
      diagnostic: "restore logical backup into fresh database",
      env: { ...adminEnv, PGHOST: "127.0.0.1", PGPORT: String(port), PGUSER: "postgres", PGDATABASE: RESTORE_DATABASE },
      timeoutMs: 120000,
    });
  } finally {
    cleanupRestoreDrillTemp(dumpDir);
  }

  const restoreEnv = { ...sourceEnv, PGDATABASE: RESTORE_DATABASE };
  const verify = ["node", "scripts/db-migrate.mjs", "--baseline-existing", "--smoke", "--require-non-bypass"];
  console.log(`temp postgres restore drill: restored DB verify ${verify.join(" ")}`);
  const verifyStatus = runTarget(verify, restoreEnv);
  if (verifyStatus !== 0) return verifyStatus;

  const restoredCounts = restoreDrillCounts(bin.psql, port, RESTORE_DATABASE, restoreEnv);
  assertRestoreCounts("restored", restoredCounts);
  console.log(
    `temp postgres restore drill: verified restored rows (schema_migrations=${restoredCounts.migrations}, site=${restoredCounts.site}, worker=${restoredCounts.worker})`,
  );
  console.log("temp postgres restore drill: backup/restore smoke passed");
  return 0;
}

function requireRestoreTool(path, label) {
  if (!path) {
    fail([
      `${label} is required for --restore-drill.`,
      "Install PostgreSQL 15 client tools or set PG_DUMP_BIN/PG_RESTORE_BIN alongside PSQL_BIN.",
    ], 2);
  }
}

function seedRestoreDrillSql() {
  return [
    "BEGIN;",
    `SELECT set_config('app.tenant_id', '${RESTORE_TENANT_ID}', true);`,
    `INSERT INTO site_profiles (id, tenant_id, name, url_pattern)`,
    `VALUES ('${RESTORE_SITE_ID}', '${RESTORE_TENANT_ID}', 'restore-drill-site', 'https://restore-drill.example/*')`,
    `ON CONFLICT (tenant_id, name) DO UPDATE SET url_pattern = excluded.url_pattern;`,
    "COMMIT;",
    `INSERT INTO workers (id, kind, status)`,
    `VALUES ('${RESTORE_WORKER_ID}', 'sweeper', 'active')`,
    `ON CONFLICT (id) DO UPDATE SET status = 'active', heartbeat_at = now();`,
  ].join("\n");
}

function restoreDrillCounts(psql, port, database, env) {
  const migrations = Number(queryPsqlLast(psql, port, ROLE, database, env, [
    "SELECT count(*)",
    "FROM schema_migrations",
    "WHERE version IN ('0001','0002') AND status = 'applied';",
  ].join(" ")));
  const site = Number(queryPsqlLast(psql, port, ROLE, database, env, [
    "BEGIN;",
    `SELECT set_config('app.tenant_id', '${RESTORE_TENANT_ID}', true);`,
    "SELECT count(*)",
    "FROM site_profiles",
    `WHERE id = '${RESTORE_SITE_ID}' AND tenant_id = '${RESTORE_TENANT_ID}' AND name = 'restore-drill-site';`,
    "ROLLBACK;",
  ].join("\n")));
  const worker = Number(queryPsqlLast(psql, port, ROLE, database, env, [
    "SELECT count(*)",
    "FROM workers",
    `WHERE id = '${RESTORE_WORKER_ID}' AND kind = 'sweeper' AND status = 'active';`,
  ].join(" ")));
  return { migrations, site, worker };
}

function assertRestoreCounts(label, counts) {
  const failures = [];
  if (counts.migrations !== 2) failures.push(`schema_migrations=${counts.migrations}`);
  if (counts.site !== 1) failures.push(`site=${counts.site}`);
  if (counts.worker !== 1) failures.push(`worker=${counts.worker}`);
  if (failures.length > 0) {
    fail([`restore drill ${label} row verification failed: ${failures.join(", ")}`], 1);
  }
}

function runPsql(psql, port, user, database, sql, options) {
  return run(psql, [
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-U",
    user,
    "-d",
    database,
    "-c",
    sql,
  ], options);
}

function queryPsqlLast(psql, port, user, database, env, sql) {
  const result = run(psql, [
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-qAt",
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-U",
    user,
    "-d",
    database,
    "-c",
    sql,
  ], {
    diagnostic: "query restore drill verification rows",
    env,
    capture: true,
    timeoutMs: 30000,
  });
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.at(-1) ?? "";
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
      pgDump: process.env.PG_DUMP_BIN?.trim() || join(dir, `pg_dump${exe}`),
      pgRestore: process.env.PG_RESTORE_BIN?.trim() || join(dir, `pg_restore${exe}`),
      label: dir,
    };
    if ([bin.psql, bin.initdb, bin.pgCtl, bin.postgres].every((tool) => existsSync(tool)) && isPostgres15(bin.postgres)) {
      return {
        psql: resolve(bin.psql),
        initdb: resolve(bin.initdb),
        pgCtl: resolve(bin.pgCtl),
        postgres: resolve(bin.postgres),
        pgDump: existsSync(bin.pgDump) ? resolve(bin.pgDump) : undefined,
        pgRestore: existsSync(bin.pgRestore) ? resolve(bin.pgRestore) : undefined,
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

function cleanupRestoreDrillTemp(tempRoot) {
  const resolvedTemp = resolve(tempRoot);
  const resolvedOsTemp = resolve(tmpdir());
  if (!resolvedTemp.startsWith(resolvedOsTemp) || !basename(resolvedTemp).startsWith("rpa-restore-drill-")) {
    console.error(`WARN: refusing to remove unexpected restore drill temp path ${resolvedTemp}`);
    return;
  }
  try {
    rmSync(resolvedTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.error(`WARN: failed to remove restore drill temp path ${resolvedTemp}: ${error.message}`);
  }
}

function printUsage() {
  console.log([
    "Usage: node scripts/db-temp-postgres-gate.mjs [--preflight-only] [--local-gates] [--restore-drill] [--keep-temp] [--port PORT] [-- command ...]",
    "",
    "Starts a disposable PostgreSQL 15 cluster on 127.0.0.1, creates a",
    "non-SUPERUSER/non-BYPASSRLS rpa_smoke role, runs the selected gate with",
    "PSQL_BIN/PGHOST/PGPORT/PGDATABASE/PGUSER set, then stops and removes the cluster.",
    "",
    "Default gate:",
    "  node scripts/db-migration-smoke.mjs --require-non-bypass",
    "",
    "Restore drill:",
    "  --restore-drill applies repo migrations, seeds representative rows,",
    "  runs pg_dump/pg_restore into a fresh database, then reruns",
    "  db-migrate --baseline-existing --smoke --require-non-bypass against the restored DB.",
    "",
    "Examples:",
    "  npm --prefix codegen run db:temp-smoke",
    "  npm --prefix codegen run db:restore-drill:temp",
    "  npm --prefix codegen run ci:local:temp-db",
    "  node scripts/db-temp-postgres-gate.mjs -- npm --prefix codegen run db:smoke",
  ].join("\n"));
}

function fail(lines, code) {
  console.error(["FAIL:", ...lines.map((line) => `  ${line}`)].join("\n"));
  process.exit(code);
}
