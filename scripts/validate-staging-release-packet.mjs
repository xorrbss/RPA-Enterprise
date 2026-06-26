#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const args = process.argv.slice(2);
const REQUIRED_FIELDS = [
  "staging platform repo",
  "concrete deploy target",
  "GitHub Environment `staging`",
  "release approval reference",
  "rollback confirmation",
  "SecretStore alias/path",
  "namespace / identity map",
  "SecretRef inventory",
  "runtime artifact object-store env",
  "artifact store topology preflight",
  "retention policy",
  "live D5 evidence",
  "secret.resolve audit sample",
  "negative control proof",
];

const FORBIDDEN_PATTERNS = [
  ["private key block", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i],
  ["plaintext AppRole role_id", /\brole_id\s*[:=]\s*[^,\s)]+/i],
  ["plaintext AppRole secret_id", /\bsecret_id\s*[:=]\s*[^,\s)]+/i],
  ["Vault token", /\bhv[bs]\.[A-Za-z0-9_-]{8,}\b/i],
  ["S3 secret access key", /\b(?:S3_)?SECRET_ACCESS_KEY\s*[:=]\s*[^,\s)]+/i],
  ["AWS access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ["OpenAI key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ["internal ObjectRef", /\bObjectRef\b|(?:file|s3):\/\/[^\s)]+/i],
  ["raw model identifier", /\b(?:gpt|claude|gemini)-[A-Za-z0-9._-]+\b/i],
];

function main() {
  try {
    if (args.includes("--help")) {
      printUsage();
      process.exit(0);
    }
    if (args.includes("--self-test")) {
      runSelfTest();
      return;
    }

    const file = parseFileArg(args);
    const text = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
    const result = validatePacket(text, file);
    if (!result.ok) {
      console.error(`staging release packet validator: ${result.failures.length} failed`);
      for (const failure of result.failures) console.error(`FAIL: ${failure}`);
      process.exit(1);
    }
    console.log(`staging release packet validator: PASS ${file === "-" ? "stdin" : basename(file)}`);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`staging release packet validator: ${message}`);
    process.exit(2);
  }
}

function parseFileArg(argv) {
  if (argv.length === 0) return "-";
  if (argv.length === 1 && argv[0] === "--file") throw new Error("--file requires a path or -");
  if (argv.length === 2 && argv[0] === "--file") return requiredFileValue(argv[1]);
  if (argv.length === 1 && argv[0].startsWith("--file=")) return requiredFileValue(argv[0].slice("--file=".length));
  throw new Error(`unknown option(s): ${argv.join(", ")}`);
}

function requiredFileValue(value) {
  if (value === "") throw new Error("--file requires a path or -");
  return value;
}

function validatePacket(text, source = "packet") {
  const failures = [];
  const packet = extractPacket(text);
  if (packet === undefined) {
    return { ok: false, failures: [`${source}: missing [STAGING RELEASE PACKET -- redacted] block`] };
  }

  scanForbidden(packet, failures);
  scanUrls(packet, failures);

  const fields = parseFields(packet, failures);
  for (const field of REQUIRED_FIELDS) {
    if (!fields.has(field)) failures.push(`missing required field: ${field}`);
  }

  for (const [field, value] of fields.entries()) {
    if (value.trim().length === 0) failures.push(`${field}: blank value`);
    if (hasUnfilledPlaceholder(field, value)) failures.push(`${field}: unresolved template placeholder`);
  }

  requireContains(fields, failures, "GitHub Environment `staging`", ["protection=", "required reviewer=", "branch policy="]);
  requireContains(fields, failures, "rollback confirmation", ["forward-only", "owner=#13"]);
  requireContains(fields, failures, "SecretStore alias/path", ["Vault", "KV v2", "secret/", "secret/data/rpa/staging"]);
  requireContains(fields, failures, "namespace / identity map", ["D8-A12"]);
  requireContains(fields, failures, "SecretRef inventory", ["D8-A12"]);
  requireContains(fields, failures, "runtime artifact object-store env", [
    "GATEWAY_ARTIFACT_STORE_MODE=s3",
    "GATEWAY_ARTIFACT_OBJECT_STORE_REF=",
    "ARTIFACT_OBJECT_STORE_REF=",
  ]);
  requireContains(fields, failures, "artifact store topology preflight", [
    "npm --prefix app run preflight:artifact-store -- --topology split-worker-lifecycle",
    "PASS",
  ]);
  requireContains(fields, failures, "retention policy", ["D8-A11", "D8-A14"]);
  requireContains(fields, failures, "live D5 evidence", ["row 50"]);
  requireBracketedAliases(fields, failures, "live D5 evidence", 2);
  requireContains(fields, failures, "secret.resolve audit sample", ["seq", "hash"]);
  requireNotContains(fields, failures, "secret.resolve audit sample", ["material=present", "value="]);
  requireContains(fields, failures, "negative control proof", ["secret-scan", "GitHub `secrets`", "environment: staging", "env dump", "xtrace"]);

  return { ok: failures.length === 0, failures };
}

function extractPacket(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\[STAGING RELEASE PACKET\b/i.test(line.trim()));
  if (start < 0) return undefined;
  const collected = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (i > start && line.trim() === "```") break;
    if (i > start && /^-{3,}$/.test(line.trim())) break;
    collected.push(line);
  }
  return collected.join("\n");
}

function parseFields(packet, failures) {
  const fields = new Map();
  for (const [index, line] of packet.split(/\r?\n/).entries()) {
    if (!line.startsWith("- ")) continue;
    const match = /^-\s+(.+?)\s+:\s*(.*)$/.exec(line);
    if (!match) {
      failures.push(`line ${index + 1}: malformed packet field`);
      continue;
    }
    const [, label, value] = match;
    if (fields.has(label)) failures.push(`${label}: duplicate field`);
    fields.set(label, value.trim());
  }
  return fields;
}

function hasUnfilledPlaceholder(field, value) {
  const allowedSecretStoreBase = field === "SecretStore alias/path" && value.includes("secret/data/rpa/staging/<runtime>/<purpose>/<name>");
  const valueToCheck = allowedSecretStoreBase
    ? value.replace("secret/data/rpa/staging/<runtime>/<purpose>/<name>", "")
    : value;
  return /<[^>]+>/.test(valueToCheck);
}

function scanForbidden(packet, failures) {
  for (const [label, pattern] of FORBIDDEN_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(packet)) failures.push(`forbidden ${label} in packet`);
  }
}

function scanUrls(packet, failures) {
  for (const match of packet.matchAll(/\bhttps?:\/\/[^\s)]+/g)) {
    try {
      const url = new URL(match[0]);
      if (url.protocol !== "https:") failures.push(`non-HTTPS URL is not allowed: ${url.origin}${url.pathname}`);
      if (url.username || url.password) failures.push(`URL credentials are not allowed: ${url.origin}${url.pathname}`);
      if (url.search || url.hash) failures.push(`URL query/fragment is not allowed: ${url.origin}${url.pathname}`);
    } catch {
      failures.push(`invalid URL in packet: ${match[0]}`);
    }
  }
}

function requireContains(fields, failures, field, needles) {
  const value = fields.get(field);
  if (value === undefined) return;
  for (const needle of needles) {
    if (!value.includes(needle)) failures.push(`${field}: missing ${JSON.stringify(needle)}`);
  }
}

function requireNotContains(fields, failures, field, needles) {
  const value = fields.get(field);
  if (value === undefined) return;
  for (const needle of needles) {
    if (value.includes(needle)) failures.push(`${field}: must not include ${JSON.stringify(needle)}`);
  }
}

function requireBracketedAliases(fields, failures, field, minimumCount) {
  const value = fields.get(field);
  if (value === undefined) return;
  const aliases = value.match(/\[[A-Za-z0-9._-]+\]/g) ?? [];
  if (aliases.length < minimumCount) failures.push(`${field}: requires at least ${minimumCount} bracketed redacted alias(es)`);
}

function runSelfTest() {
  const valid = [
    "[STAGING RELEASE PACKET -- redacted]",
    "- staging platform repo            : xorrbss/rpa-platform-deploy",
    "- concrete deploy target           : rpa-staging/runtime-worker",
    "- GitHub Environment `staging`      : protection=on, required reviewer=owner, branch policy=protected-main",
    "- release approval reference        : https://github.com/xorrbss/rpa-platform-deploy/actions/runs/123456789",
    "- rollback confirmation             : forward-only(D7-4) + prior-image redeploy; owner=#13",
    "- SecretStore alias/path            : Vault KV v2 mount `secret/`, base secret/data/rpa/staging/<runtime>/<purpose>/<name> (values omitted)",
    "- namespace / identity map          : D8-A12 staging-decision-proposals section 3",
    "- SecretRef inventory               : D8-A12 staging-decision-proposals section 4 identifiers only",
    "- runtime artifact object-store env : `GATEWAY_ARTIFACT_STORE_MODE=s3`; `GATEWAY_ARTIFACT_OBJECT_STORE_REF=rpa/staging/runtime-worker/object_store/s3-producer`; `ARTIFACT_OBJECT_STORE_REF=rpa/staging/artifact-lifecycle/object_store/s3`; alias=[s3-staging-1]",
    "- artifact store topology preflight  : run `npm --prefix app run preflight:artifact-store -- --topology split-worker-lifecycle`; PASS before process start",
    "- retention policy                  : D8-A11/D8-A14 and ops-defaults section 6.1",
    "- live D5 evidence                  : row 50 packet aliases [codex-staging-1]/[model-a]",
    "- secret.resolve audit sample       : seq#1/hash#abc123, no material",
    "- negative control proof            : secret-scan rejects GitHub `secrets` context, environment: staging binding, env dump commands, and xtrace",
    "[forbidden: plaintext credentials omitted]",
  ].join("\n");

  const cases = [
    ["valid packet", valid, true],
    ["missing field", valid.replace(/^- live D5 evidence.*\n/m, ""), false],
    ["unfilled repo placeholder", valid.replace("xorrbss/rpa-platform-deploy", "<org/repo name>"), false],
    ["missing topology pass", valid.replace("PASS before process start", "pending before process start"), false],
    ["role id leak", `${valid}\nrole_id=plain-role-id`, false],
    ["url query leak", valid.replace("/runs/123456789", "/runs/123456789?token=redacted"), false],
    ["object ref leak", valid.replace("no material", "ObjectRef s3://bucket/raw-key"), false],
    ["raw model leak", valid.replace("[model-a]", "gpt-5"), false],
    ["access key leak", `${valid}\n${"AKIA"}IOSFODNN7EXAMPLE`, false],
    ["negative proof missing", valid.replace(/^- negative control proof.*\n/m, ""), false],
  ];

  const failures = [];
  for (const [label, text, expected] of cases) {
    const actual = validatePacket(text, label).ok;
    if (actual !== expected) failures.push(`${label}: expected ${expected ? "PASS" : "FAIL"}, got ${actual ? "PASS" : "FAIL"}`);
  }

  if (failures.length > 0) {
    console.error(`staging release packet validator self-test: ${failures.length} failed`);
    for (const failure of failures) console.error(`FAIL: ${failure}`);
    process.exit(1);
  }
  console.log("staging release packet validator self-test: fixtures passed");
}

function printUsage() {
  console.log([
    "Usage: node scripts/validate-staging-release-packet.mjs [--file packet.md|-]",
    "       node scripts/validate-staging-release-packet.mjs --self-test",
    "",
    "Validates the redacted row-43 staging release packet shape without resolving or printing secrets.",
  ].join("\n"));
}

main();
