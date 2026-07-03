#!/usr/bin/env node
// File-length gate: app/src + web/src source files must stay within the 500-line
// rule (파일 제한 — CLAUDE.md ULTIMATE INVARIANTS #7). Pre-existing violations are
// frozen in scripts/file-length-baseline.json as a ratchet: a baselined file may
// shrink but never grow, a compliant file may not cross 500, and the baseline
// itself must stay honest (no stale/redundant/slack entries).
//
// Root cause this guards: the 2026-06-21 god-class decomposition brought src to
// zero violations, but with no gate the Phase 6~10 feature wave (06-24~06-30)
// reintroduced 51 oversized files. This gate stops that regression creep without
// requiring an upfront mass decomposition.
//
// To fix a failure: split the file along meaning boundaries (see CLAUDE.md).
// Only when a split is deliberately deferred, regenerate the baseline with
//   node scripts/file-length-gate.mjs --update-baseline
// and let the PR diff of file-length-baseline.json carry that decision.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LIMIT = 500;
const SCAN_DIRS = ["app/src", "web/src"];
const SOURCE_RE = /\.(ts|tsx)$/;
const BASELINE_PATH = join(ROOT, "scripts", "file-length-baseline.json");

const updateBaseline = process.argv.includes("--update-baseline");

function walk(dir, acc) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, acc);
    else if (SOURCE_RE.test(entry.name)) acc.push(abs);
  }
  return acc;
}

function countLines(absPath) {
  const content = readFileSync(absPath, "utf8");
  let lines = content.split("\n").length;
  if (content.endsWith("\n")) lines -= 1;
  return lines;
}

const measured = new Map();
for (const dir of SCAN_DIRS) {
  for (const abs of walk(join(ROOT, dir), [])) {
    const rel = abs.slice(ROOT.length).replaceAll("\\", "/").replace(/^\//, "");
    measured.set(rel, countLines(abs));
  }
}

if (updateBaseline) {
  const next = {};
  for (const [rel, lines] of [...measured.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (lines > LIMIT) next[rel] = lines;
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
  console.log(
    `file-length gate: baseline regenerated — ${Object.keys(next).length} files over ${LIMIT} lines frozen`
  );
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const failures = [];

// 1. No file may exceed max(LIMIT, its frozen baseline).
for (const [rel, lines] of measured) {
  const allowed = Math.max(LIMIT, baseline[rel] ?? 0);
  if (lines > allowed) {
    failures.push(
      baseline[rel] !== undefined
        ? `baselined file grew: ${rel} is ${lines} lines (frozen at ${baseline[rel]}) — split it, or shrink back under its baseline`
        : `new violation: ${rel} is ${lines} lines (limit ${LIMIT}) — split it along meaning boundaries (CLAUDE.md 파일 제한)`
    );
  }
}

// 2. Baseline must stay honest: no stale, redundant, or slack entries.
for (const [rel, frozen] of Object.entries(baseline)) {
  const lines = measured.get(rel);
  if (lines === undefined) {
    failures.push(`stale baseline entry: ${rel} no longer exists — run --update-baseline`);
  } else if (lines <= LIMIT) {
    failures.push(`redundant baseline entry: ${rel} is now ${lines} lines (≤ ${LIMIT}) — run --update-baseline`);
  } else if (lines < frozen) {
    failures.push(
      `slack baseline entry: ${rel} shrank to ${lines} lines (frozen at ${frozen}) — run --update-baseline to ratchet down`
    );
  }
}

if (failures.length > 0) {
  console.error(`file-length gate: ${failures.length} failed`);
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}

const overCount = Object.keys(baseline).length;
console.log(
  `file-length gate: OK — ${measured.size} source files scanned, ` +
    `${overCount} pre-existing violations frozen in baseline, 0 regressions`
);
