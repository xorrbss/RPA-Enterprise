#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NPM = "npm";
const COMMON_ENV = {
  CODEX_BASE_URL: "https://codex.invalid/v1",
  CODEX_API_KEY: "local-nonsecret-placeholder",
  CODEX_MODEL: "local-model-alias",
  GATEWAY_ARTIFACT_DIR: join(ROOT, ".tmp", "local-staging-artifacts"),
  ARTIFACT_LIFECYCLE_DATABASE_URL: "postgresql://local-pilot@localhost/rpa_local",
  ARTIFACT_LIFECYCLE_WORKER_ID: "20000000-0000-4000-8000-0000000000aa",
};

main();

function main() {
  console.log("local staging release pilot: LOCAL PILOT ONLY, not row 43 closure evidence");

  runPass("local artifact-store topology preflight", [
    "--prefix",
    "app",
    "run",
    "preflight:artifact-store",
    "--",
    "--topology",
    "split-worker-lifecycle",
  ], {
    ...COMMON_ENV,
    RPA_ENV: "local",
    ARTIFACT_LIFECYCLE_OBJECT_STORE_MODE: "local_fs",
    ARTIFACT_OBJECT_STORE_REF: "rpa/local/artifact-lifecycle/object_store/fs",
  });

  runExpectedFailure("staging local_fs negative control", [
    "--prefix",
    "app",
    "run",
    "preflight:artifact-store",
    "--",
    "--topology",
    "split-worker-lifecycle",
  ], {
    ...COMMON_ENV,
    RPA_ENV: "staging",
    ARTIFACT_LIFECYCLE_OBJECT_STORE_MODE: "local_fs",
    ARTIFACT_OBJECT_STORE_REF: "rpa/staging/artifact-lifecycle/object_store/fs",
  }, "ARTIFACT_LIFECYCLE_OBJECT_STORE_MODE=local_fs is allowed only when RPA_ENV is dev|local");

  runPass("local packet shape validation", [
    "--prefix",
    "codegen",
    "run",
    "release-packet:validate",
    "--",
    "--file",
    "../docs/local-staging-release-pilot.md",
  ]);
}

function runPass(label, args, overlay = {}) {
  const result = run(args, overlay);
  writeOutput(result);
  if (result.status !== 0) {
    console.error(`local staging release pilot: FAIL ${label}`);
    process.exit(result.status ?? 1);
  }
  console.log(`local staging release pilot: PASS ${label}`);
}

function runExpectedFailure(label, args, overlay, expectedReason) {
  const result = run(args, overlay);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeOutput(result);
  if (result.status === 0 || !output.includes(expectedReason)) {
    console.error(`local staging release pilot: FAIL ${label}`);
    process.exit(1);
  }
  console.log(`local staging release pilot: PASS ${label} blocked as expected`);
}

function run(args, overlay) {
  const command = process.platform === "win32" ? "cmd.exe" : NPM;
  const commandArgs = process.platform === "win32" ? ["/d", "/c", quoteCmd([NPM, ...args])] : args;
  return spawnSync(command, commandArgs, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...overlay },
  });
}

function writeOutput(result) {
  if (result.error) process.stderr.write(`${result.error.message}\n`);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function quoteCmd(parts) {
  return parts.map((part, index) => {
    if (index === 0) return part;
    return /^[A-Za-z0-9_./:=-]+$/.test(part) ? part : `"${part.replaceAll('"', '\\"')}"`;
  }).join(" ");
}
