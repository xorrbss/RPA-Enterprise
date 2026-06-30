import assert from "node:assert/strict";

import { compileScenario, studioValidationStagesFromCompile } from "../src/api/compile-pipeline";

const validOutcome = compileScenario({
  meta: { name: "valid", version: 1 },
  start: "done",
  nodes: { done: { terminal: "success" } },
});
const validStages = studioValidationStagesFromCompile(validOutcome);
assert.equal(validStages.find((stage) => stage.stage === "well_formed")?.status, "pass");
assert.equal(validStages.find((stage) => stage.stage === "runnable")?.status, "not_run");
assert.equal(validStages.find((stage) => stage.stage === "operable")?.status, "not_run");
assert.equal(validStages.find((stage) => stage.stage === "prod_ready")?.status, "not_run");

const staticFailure = compileScenario({
  meta: { name: "broken", version: 1 },
  start: "start",
  nodes: { start: { next: "missing" } },
});
const staticStages = studioValidationStagesFromCompile(staticFailure);
assert.equal(staticStages.find((stage) => stage.stage === "well_formed")?.status, "failed");
assert.equal(staticStages.find((stage) => stage.stage === "runnable")?.status, "blocked");

const schemaFailure = compileScenario({});
const schemaStages = studioValidationStagesFromCompile(schemaFailure);
assert.equal(schemaStages.find((stage) => stage.stage === "well_formed")?.status, "failed");
assert.equal(schemaStages.find((stage) => stage.stage === "prod_ready")?.status, "blocked");

console.log("studio-validation-stages.unit: all assertions passed");
