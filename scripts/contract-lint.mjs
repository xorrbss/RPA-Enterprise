#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const UTF8 = new TextDecoder("utf-8", { fatal: true });

const requiredFiles = [
  "AGENTS.md",
  "README.md",
  "CLAUDE.md",
  "build-prompt.md",
  "architecture.md",
  "state-machine.md",
  "api-surface.md",
  "security-contracts.md",
  "auth-rbac.md",
  "ops-defaults.md",
  "ir-expression.md",
  "ir-static-validation.md",
  "reserved-handlers.md",
  "llm-gateway-adapter.md",
  "impl-contracts-bundle.md",
  "release-open-checklist.md",
  "schema/ir.schema.json",
  "schema/verify.schema.json",
  "schema/event-envelope.schema.json",
  "db/migration_concurrency_idempotency.sql",
  "db/migration_core_entities.sql",
  "db/migration_smoke.sql",
  "ts/core-types.ts",
  "ts/error-catalog.ts",
  "ts/state-machine-types.ts",
];

const anchors = new Map([
  ["state-machine.md", ["IllegalTransition", "silent no-op"]],
  ["api-surface.md", ["Idempotency-Key", "If-Match"]],
  ["security-contracts.md", ["SecretStore", "Redaction"]],
  ["auth-rbac.md", ["FORCE ROW LEVEL SECURITY", "AUTHZ_FORBIDDEN"]],
  ["ops-defaults.md", ["TTL", "retention_until", "legal_hold"]],
  ["ir-static-validation.md", ["ValidationReport", "handler-call", "body_target"]],
  ["reserved-handlers.md", ["@challenge", "return_node", "handler-call"]],
  ["release-open-checklist.md", ["Staging deploy target is not defined", "CI must not create external deploys"]],
  ["db/migration_smoke.sql", ["server_version_num", "FORCE RLS"]],
]);

const lintExtensions = new Set([".md", ".json", ".sql", ".ts"]);
const lintPaths = new Set(requiredFiles);

for (const name of readdirSync(ROOT)) {
  const abs = join(ROOT, name);
  if (statSync(abs).isFile() && extname(name) === ".md") {
    lintPaths.add(name);
  }
}

for (const dir of ["schema", "db", "ts"]) {
  collectContractFiles(join(ROOT, dir), lintPaths);
}

const failures = [];

for (const relPath of requiredFiles) {
  try {
    if (!statSync(join(ROOT, relPath)).isFile()) {
      failures.push(`missing required contract file: ${relPath}`);
    }
  } catch {
    failures.push(`missing required contract file: ${relPath}`);
  }
}

for (const relPath of [...lintPaths].sort()) {
  const abs = join(ROOT, relPath);
  let text;
  try {
    text = readUtf8(abs);
  } catch (error) {
    failures.push(`${relPath}: not valid UTF-8: ${error.message}`);
    continue;
  }

  if (!text.trim()) {
    failures.push(`${relPath}: empty file`);
  }

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const lineNo = index + 1;
    if (line.startsWith("<<<<<<<") || line === "=======" || line.startsWith(">>>>>>>")) {
      failures.push(`${relPath}:${lineNo}: unresolved merge conflict marker`);
    }
    if (line.includes("TODO:") && !line.includes("TODO: [BLOCKED]")) {
      failures.push(`${relPath}:${lineNo}: TODO must use TODO: [BLOCKED]`);
    }
  }
}

for (const [relPath, needles] of anchors) {
  const abs = join(ROOT, relPath);
  if (!existsFile(abs)) continue;
  let text;
  try {
    text = readUtf8(abs);
  } catch {
    continue;
  }
  for (const needle of needles) {
    if (!text.includes(needle)) {
      failures.push(`${relPath}: missing expected SSoT anchor ${JSON.stringify(needle)}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`contract lint: ${failures.length} failed`);
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}

console.log(`contract lint: ${lintPaths.size} files checked`);

function collectContractFiles(dir, out) {
  if (!existsDir(dir)) return;
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      collectContractFiles(abs, out);
      continue;
    }
    if (stat.isFile() && lintExtensions.has(extname(entry))) {
      out.add(relative(ROOT, abs).replaceAll("\\", "/"));
    }
  }
}

function readUtf8(abs) {
  return UTF8.decode(readFileSync(abs));
}

function existsFile(abs) {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

function existsDir(abs) {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}
