#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const SKIP_DIRS = new Set([".git", "node_modules"]);
const MAX_BYTES = 5 * 1024 * 1024;

const patterns = [
  ["private key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g],
  ["aws access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["github token", /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g],
  ["slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ["openai key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g],
];

const hits = [];

for (const abs of walk(ROOT)) {
  const relPath = relative(ROOT, abs).replaceAll("\\", "/");
  const stat = statSync(abs);
  if (stat.size > MAX_BYTES) continue;

  let text;
  try {
    text = UTF8.decode(readFileSync(abs));
  } catch {
    continue;
  }

  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      hits.push(`${relPath}:${line}: ${label}`);
    }
  }
}

if (hits.length > 0) {
  console.error(`secret scan: ${hits.length} high-risk marker(s) found`);
  for (const hit of hits) console.error(`FAIL: ${hit}`);
  process.exit(1);
}

console.log("secret scan: no high-risk secret markers found");

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
