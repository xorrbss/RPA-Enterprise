#!/usr/bin/env node
// Test-wiring audit: every app/test/*.{unit,int}.ts must be reachable from a CI
// entry script (so it actually runs in contract-gates.yml), OR be listed in the
// documented allowlist below (live-resource / dev-only tests that are run manually).
//
// Root cause this guards: app/package.json `test:unit`/`test:int` are hand-maintained
// `&&`-chained lists, not globs, so a regression test can silently fall out of CI.
// This audit fails the build when that happens (orphan), when the allowlist names a
// test that IS already wired (redundant), or when it names a file that no longer
// exists (stale).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP = join(ROOT, "app");
const TEST_DIR = join(APP, "test");

// CI entry scripts: the npm scripts that contract-gates.yml actually invokes.
// app job: test:unit, test:executor, test:int, test:pipeline-run, test:pipeline-site,
// test:console-live-e2e. web/console-e2e job: test:console-e2e.
const CI_ENTRY_SCRIPTS = [
  "test:unit",
  "test:executor",
  "test:int",
  "test:pipeline-run",
  "test:pipeline-site",
  "test:console-live-e2e",
  "test:console-e2e",
];

// Intentionally NOT in the default CI gate. Each entry MUST carry a reason.
// These need live external resources (Chrome + a real model) or are dev-only paths,
// so they are run manually via their dedicated npm scripts, not on every push.
const ALLOWLIST = {
  "interpreter-llm.int.ts": "live LLM model + Chrome (run via `npm run test:interpreter-llm`)",
  "run-multisite-resolution.int.ts": "live Chrome + multi-site model (run via `npm run test:multisite`)",
  "dev-gateway-artifact-sink.int.ts": "dev-only DevVisibleGatewayArtifactSink path, not a production gate",
};

const pkg = JSON.parse(readFileSync(join(APP, "package.json"), "utf8"));
const scripts = pkg.scripts ?? {};
const failures = [];

// Resolve the set of test files reachable from the CI entry scripts, transitively
// expanding `npm run <name>` references.
const reachable = new Set();
const visited = new Set();
const queue = [...CI_ENTRY_SCRIPTS];
while (queue.length > 0) {
  const name = queue.shift();
  if (visited.has(name)) continue;
  visited.add(name);
  const body = scripts[name];
  if (typeof body !== "string") {
    failures.push(`CI entry script "${name}" is missing from app/package.json scripts`);
    continue;
  }
  for (const m of body.matchAll(/tsx\s+test\/([A-Za-z0-9._-]+\.ts)/g)) reachable.add(m[1]);
  for (const m of body.matchAll(/npm\s+run\s+([A-Za-z0-9:-]+)/g)) queue.push(m[1]);
}

const onDisk = readdirSync(TEST_DIR)
  .filter((name) => name.endsWith(".unit.ts") || name.endsWith(".int.ts"))
  .sort();

// 1. Every on-disk unit/int test must be reachable or allowlisted.
for (const file of onDisk) {
  if (reachable.has(file)) continue;
  if (file in ALLOWLIST) continue;
  failures.push(
    `orphan test not wired into CI and not allowlisted: test/${file} ` +
      `(add it to test:unit/test:int, or allowlist it with a reason in scripts/test-wiring-audit.mjs)`
  );
}

// 2. Allowlist must stay honest: no redundant or stale entries.
for (const file of Object.keys(ALLOWLIST)) {
  if (!onDisk.includes(file)) {
    failures.push(`stale allowlist entry: test/${file} no longer exists — remove it from ALLOWLIST`);
  } else if (reachable.has(file)) {
    failures.push(`redundant allowlist entry: test/${file} is already wired into CI — remove it from ALLOWLIST`);
  }
}

if (failures.length > 0) {
  console.error(`test-wiring audit: ${failures.length} failed`);
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}

console.log(
  `test-wiring audit: OK — ${onDisk.length} unit/int tests ` +
    `(${onDisk.length - Object.keys(ALLOWLIST).length} CI-wired, ${Object.keys(ALLOWLIST).length} allowlisted)`
);
