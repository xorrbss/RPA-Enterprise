import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const source = readFileSync(`${ROOT}app/dev/run-loop.ts`, "utf8");

const marker = "const driveDeps = {";
const start = source.indexOf(marker);
assert.notEqual(start, -1, "dev run-loop driveDeps should exist");

const end = source.indexOf("};", start);
assert.notEqual(end, -1, "dev run-loop driveDeps should be closed");

const driveDeps = source.slice(start, end);
assert.match(driveDeps, /recordExecutorSteps:\s*true/, "dev run-loop must persist run_steps for RunTrace");
assert.match(driveDeps, /sessionProvider:\s*runProvider/, "dev run-loop must keep live session capture wiring (per-run session snapshot)");
assert.match(driveDeps, /suspensionPort,/, "dev run-loop must support @human_task suspend");
assert.match(driveDeps, /resumeTokenCodec,/, "dev run-loop must issue and verify resume tokens");
assert.match(source, /driveClaimedRun\(runInput,\s*driveDeps\)/, "dev run-loop must still drive queued runs");
assert.match(source, /driveResumeRequestedRun\(runInput,\s*driveDeps,\s*next\.resume_token\)/, "dev run-loop must resume approved human-task runs");

console.log("PASS: dev run-loop contract records executor steps and supports suspend/resume");
