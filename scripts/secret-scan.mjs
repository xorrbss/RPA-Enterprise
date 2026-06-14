#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const SKIP_DIRS = new Set([".git", "node_modules"]);
const MAX_BYTES = 5 * 1024 * 1024;
const args = process.argv.slice(2);
const allowedArgs = new Set(["--self-test"]);
const unknownArgs = args.filter((arg) => !allowedArgs.has(arg));

const patterns = [
  ["private key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g],
  ["aws access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["github token", /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g],
  ["slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ["openai key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g],
];
const workflowHazards = [
  ["GitHub secret context reference in contract workflow", /\$\{\{\s*secrets\./g],
  ["staging environment binding in contract workflow", /^\s*environment\s*:\s*staging\b/gim],
  ["workflow env dump command", /^\s*(?:-\s*)?(?:printenv(?:\s|$)|env(?!:)(?:\s|$)|set\s+-x\b|Get-ChildItem\s+Env:)/gim],
  ["workflow one-line env dump command", /^\s*(?:-\s*)?run\s*:\s*["']?(?:printenv\b|env\b|set\s+-x\b|Get-ChildItem\s+Env:)/gim],
];

if (unknownArgs.length > 0) {
  console.error(`FAIL: unknown secret-scan option(s): ${unknownArgs.join(", ")}`);
  process.exit(2);
}

if (args.includes("--self-test")) {
  runSelfTest();
  process.exit(0);
}

const hits = scanRepository(ROOT);

if (hits.length > 0) {
  console.error(`secret scan: ${hits.length} high-risk marker(s) found`);
  for (const hit of hits) console.error(`FAIL: ${hit}`);
  process.exit(1);
}

console.log("secret scan: no high-risk secret markers or staging secret workflow hazards found");

function scanRepository(root) {
  const hits = [];
  for (const abs of walk(root)) {
    const relPath = relative(root, abs).replaceAll("\\", "/");
    const stat = statSync(abs);
    if (stat.size > MAX_BYTES) continue;

    let text;
    try {
      text = UTF8.decode(readFileSync(abs));
    } catch {
      continue;
    }

    hits.push(...scanText(text, relPath));
  }
  return hits;
}

function scanText(text, relPath) {
  const hits = [];
  scanPatterns(text, relPath, patterns, hits);
  if (relPath.startsWith(".github/workflows/")) {
    scanPatterns(text, relPath, workflowHazards, hits);
  }
  return hits;
}

function scanPatterns(text, relPath, scanPatterns, hits) {
  for (const [label, pattern] of scanPatterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      hits.push(`${relPath}:${line}: ${label}`);
    }
  }
}

function runSelfTest() {
  const rejectCases = [
    ["GitHub secret context", "name: bad\njobs:\n  test:\n    steps:\n      - run: echo ${{ secrets.STAGING_TOKEN }}\n"],
    ["staging environment", "name: bad\njobs:\n  deploy:\n    environment: staging\n    steps: []\n"],
    ["one-line env", "name: bad\njobs:\n  test:\n    steps:\n      - run: env\n"],
    ["one-line printenv", "name: bad\njobs:\n  test:\n    steps:\n      - run: printenv\n"],
    ["one-line set -x", "name: bad\njobs:\n  test:\n    steps:\n      - run: \"set -x\"\n"],
    ["one-line powershell env", "name: bad\njobs:\n  test:\n    steps:\n      - run: Get-ChildItem Env:\n"],
    ["block env", "name: bad\njobs:\n  test:\n    steps:\n      - run: |\n          env | sort\n"],
  ];
  const allowCases = [
    ["workflow env map", "name: ok\nenv:\n  NODE_VERSION: \"24\"\njobs:\n  test:\n    steps:\n      - run: node scripts/secret-scan.mjs\n"],
    ["ci postgres smoke credentials", "services:\n  postgres:\n    env:\n      POSTGRES_PASSWORD: postgres\nenv:\n  PGSMOKE_USER: rpa_smoke\nsteps:\n  - run: node scripts/db-migration-smoke.mjs --require-non-bypass\n"],
  ];
  const failures = [];

  for (const [label, text] of rejectCases) {
    const hits = scanText(text, ".github/workflows/fixture.yml");
    if (hits.length === 0) failures.push(`${label}: expected workflow hazard hit`);
  }
  for (const [label, text] of allowCases) {
    const hits = scanText(text, ".github/workflows/fixture.yml");
    if (hits.length > 0) failures.push(`${label}: unexpected hit(s): ${hits.join("; ")}`);
  }

  if (failures.length > 0) {
    console.error(`secret scan self-test: ${failures.length} failed`);
    for (const failure of failures) console.error(`FAIL: ${failure}`);
    process.exit(1);
  }
  console.log("secret scan self-test: workflow hazard fixtures passed");
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      yield* walk(abs);
    } else if (stat.isFile()) {
      yield abs;
    }
  }
}
