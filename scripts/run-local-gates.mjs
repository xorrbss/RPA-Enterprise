#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const allowedArgs = new Set(["--help", "--skip-db"]);
const unknownArgs = args.filter((arg) => !allowedArgs.has(arg));

if (args.includes("--help")) {
  printUsage();
  process.exit(0);
}

if (unknownArgs.length > 0) {
  console.error(`FAIL: unknown local gate option(s): ${unknownArgs.join(", ")}`);
  printUsage();
  process.exit(2);
}

const skipDb = args.includes("--skip-db");

const steps = [
  ["Root contract lint", "node", ["scripts/contract-lint.mjs"]],
  ["Blocked decision audit", "node", ["scripts/blocked-decisions-audit.mjs"]],
  ["Codegen install", "npm", ["ci", "--prefix", "codegen"]],
  ["Codegen typecheck", "npm", ["--prefix", "codegen", "run", "typecheck"]],
  ["State-machine fixtures", "npm", ["--prefix", "codegen", "run", "fixtures"]],
  ["Validator fixtures", "npm", ["--prefix", "codegen", "run", "validators"]],
  ["Contract consistency", "npm", ["--prefix", "codegen", "run", "consistency"]],
  ["OpenAPI/AsyncAPI spectral lint", "npm", ["--prefix", "codegen", "run", "spectral"]],
  ["Full codegen test", "npm", ["--prefix", "codegen", "test"]],
  ["DB static smoke", "node", ["scripts/db-static-smoke.mjs"]],
  ["Workflow/OpenAPI/AsyncAPI YAML parse", "python", ["scripts/yaml-parse.py"]],
  ["Secret scan fixtures", "node", ["scripts/secret-scan.mjs", "--self-test"]],
  ["Secret scan", "node", ["scripts/secret-scan.mjs"]],
  ["App install", "npm", ["ci", "--prefix", "app"]],
  ["App runtime typecheck", "npm", ["--prefix", "app", "run", "typecheck"]],
  ["App ESLint (secret-taint gate)", "npm", ["--prefix", "app", "run", "lint"]],
  ["App runtime unit tests", "npm", ["--prefix", "app", "run", "test:unit"]],
  ["D3 executor dry-run", "npm", ["--prefix", "app", "run", "test:executor"]],
  ["HTML smoke", "node", ["scripts/html-smoke.mjs"]],
  ["HTML HTTP smoke", "node", ["scripts/html-http-smoke.mjs"]],
  ["Console install", "npm", ["ci", "--prefix", "web"]],
  ["Console typecheck", "npm", ["--prefix", "web", "run", "typecheck"]],
  ["Console tests", "npm", ["--prefix", "web", "run", "test"]],
  ["Console build", "npm", ["--prefix", "web", "run", "build"]],
  // 실 브라우저 e2e(빌드 dist + 스텁 API). Chrome 없으면 스크립트가 SKIP(exit 0). app puppeteer-core 재사용.
  ["Console browser e2e", "npm", ["--prefix", "app", "run", "test:console-e2e"]],
];

if (!skipDb) {
  console.log(
    [
      "db:smoke requires PostgreSQL 15+ server and psql client.",
      "Set PSQL_BIN when psql is not on PATH, and set PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE as needed.",
      "Release DB evidence must use npm --prefix codegen run db:smoke:release or node scripts/db-migration-smoke.mjs --require-non-bypass.",
      "Local db:smoke must use a non-SUPERUSER/non-BYPASSRLS role, matching the CI rpa_smoke role.",
      "Use --skip-db only for local environments without PostgreSQL 15; CI always runs db:smoke.",
    ].join("\n"),
  );
  steps.push(["PostgreSQL non-bypass role proof", verifyNonBypassDbRole]);
  steps.push(["PostgreSQL 15 migration smoke", "node", ["scripts/db-migration-smoke.mjs", "--require-non-bypass"]]);
  steps.push(["App runtime integration tests", "npm", ["--prefix", "app", "run", "test:int"]]);
  // 라이브 e2e(browser→Fastify→PostgreSQL). web/dist(Console build) + PG env + Chrome 필요(없으면 SKIP).
  steps.push(["Console live e2e (browser->API->DB)", "npm", ["--prefix", "app", "run", "test:console-live-e2e"]]);
} else {
  console.log(
    [
      "WARNING: PostgreSQL 15 DB-dependent gates skipped by --skip-db.",
      "This does not satisfy the CI db:smoke or app-runtime integration gates; record the local skip reason in the PR/release notes.",
    ].join("\n"),
  );
}

for (const [label, command, args] of steps) {
  console.log(`\n==> ${label}`);
  const status = typeof command === "function" ? command() : run(command, args);
  if (status !== 0) process.exit(status);
}

console.log(
  skipDb
    ? "\nlocal contract gates passed (DB-dependent gates skipped; CI still requires them)"
    : "\nlocal contract gates passed",
);

function printUsage() {
  console.error(
    [
      "Usage: node scripts/run-local-gates.mjs [--skip-db]",
      "",
      "Runs the same automated contract and app-runtime gate set as CI.",
      "--skip-db may be used only when local PostgreSQL 15 is unavailable; CI still requires db:smoke and app integration.",
    ].join("\n"),
  );
}

function run(command, args) {
  const executable = command === "npm" && process.platform === "win32" ? "npm.cmd" : command;
  const spawnCommand = process.platform === "win32" ? "cmd.exe" : executable;
  const spawnArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", [executable, ...args].map(quoteCmdArg).join(" ")]
    : args;
  const result = spawnSync(spawnCommand, spawnArgs, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error?.code === "ENOENT") {
    console.error(`FAIL: ${command} is not available on PATH`);
    return 2;
  }

  return result.status ?? 1;
}

function verifyNonBypassDbRole() {
  const psql = process.env.PSQL_BIN?.trim() || (process.platform === "win32" ? "psql.exe" : "psql");
  const sql = [
    "SELECT",
    "COALESCE((SELECT (rolsuper OR rolbypassrls)::text FROM pg_roles WHERE rolname = current_user), 'unknown')",
  ].join(" ");
  const result = spawnSync(psql, ["-X", "-w", "-v", "ON_ERROR_STOP=1", "-Atqc", sql], {
    cwd: ROOT,
    stdio: "pipe",
    env: { ...process.env, PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT || "5" },
    encoding: "utf8",
  });

  if (result.error?.code === "ENOENT") {
    console.error(
      [
        "FAIL: psql is required to prove the local db:smoke role matches CI.",
        "Install PostgreSQL 15 tools, set PSQL_BIN, or use npm --prefix codegen run ci:local:temp-db.",
        "Release DB evidence should use npm --prefix codegen run db:smoke:release or node scripts/db-migration-smoke.mjs --require-non-bypass.",
      ].join("\n"),
    );
    return 2;
  }

  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.stdout.write(result.stdout);
    console.error(
      [
        "FAIL: could not prove the local db:smoke role is non-SUPERUSER/non-BYPASSRLS.",
        "Check PSQL_BIN/PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD, or use npm --prefix codegen run ci:local:temp-db.",
      ].join("\n"),
    );
    return result.status ?? 1;
  }

  const bypassesRls = result.stdout.trim();
  if (bypassesRls !== "false") {
    console.error(
      [
        "FAIL: local db:smoke must run as a non-SUPERUSER/non-BYPASSRLS role to match CI.",
        `Current role bypass status: ${bypassesRls || "<empty>"}.`,
        "Use a non-bypass PGUSER or npm --prefix codegen run ci:local:temp-db.",
      ].join("\n"),
    );
    return 1;
  }

  console.log("local db:smoke role is non-SUPERUSER/non-BYPASSRLS");
  return 0;
}

function quoteCmdArg(value) {
  if (/^[A-Za-z0-9_./:=\\-]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}
