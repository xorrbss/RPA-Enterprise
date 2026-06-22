import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const source = readFileSync(`${ROOT}app/dev/run-loop.ts`, "utf8");

const marker = "const drive = driveClaimedRun(";
const start = source.indexOf(marker);
assert.notEqual(start, -1, "dev run-loop driveClaimedRun call should exist");

const end = source.indexOf(");", start);
assert.notEqual(end, -1, "dev run-loop driveClaimedRun call should be closed");

const driveCall = source.slice(start, end);
assert.match(driveCall, /recordExecutorSteps:\s*true/, "dev run-loop must persist run_steps for RunTrace");
assert.match(driveCall, /sessionProvider:\s*runProvider/, "dev run-loop must keep live session capture wiring (per-run session snapshot)");

console.log("PASS: dev run-loop contract records executor steps");
