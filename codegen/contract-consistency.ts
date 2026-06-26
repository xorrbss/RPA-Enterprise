/**
 * Cross-contract consistency smoke.
 *
 * This is not a generator. It only catches drift between authoritative
 * contract artifacts that must move together before product-open work starts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import eventEnvelopeSchema from "../schema/event-envelope.schema.json";
import { ERROR_CATALOG } from "../ts/error-catalog";
import { EVENT_PAYLOAD_SCHEMA_REFS, EVENT_PAYLOAD_SCHEMAS } from "./event-payload-registry";
import { EVENT_TYPES } from "./types";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const EXPECTED_RUN_STATES = [
  "queued",
  "claimed",
  "running",
  "suspending",
  "suspended",
  "resume_requested",
  "resuming",
  "completing",
  "completed",
  "aborting",
  "cancelled",
  "failed_business",
  "failed_system",
] as const;

const EXPECTED_WORKITEM_STATES = [
  "new",
  "processing",
  "successful",
  "retry",
  "failed_business",
  "failed_system",
  "abandoned",
] as const;

const EXPECTED_HUMAN_TASK_STATES = [
  "open",
  "assigned",
  "in_progress",
  "resolved",
  "expired",
  "cancelled",
  "escalated",
] as const;

const EXPECTED_HUMAN_TASK_KINDS = [
  "approval",
  "validation",
  "exception",
  "captcha",
  "mfa",
] as const;

const failures: string[] = [];

assertUnique("EVENT_TYPES", EVENT_TYPES);
assertEqualSet("schema eventType enum", schemaEventTypes(), EVENT_TYPES);
assertEqualSet("AsyncAPI channels", asyncApiChannels(), EVENT_TYPES);
assertEqualSet("events_outbox CHECK event_type", sqlEventTypes(), EVENT_TYPES);

for (const eventType of EVENT_TYPES) {
  const expectedRef = `events/${eventType}@1`;
  const actualRef = EVENT_PAYLOAD_SCHEMA_REFS[eventType];
  if (actualRef !== expectedRef) {
    failures.push(`payload_schema_ref drift for ${eventType}: expected ${expectedRef}, got ${actualRef}`);
  }

  const schema = EVENT_PAYLOAD_SCHEMAS[eventType];
  if (schema.$id !== `https://rpa.local/contracts/events/${eventType}@1`) {
    failures.push(`payload schema $id drift for ${eventType}: ${schema.$id}`);
  }
  if (schema.additionalProperties !== false) {
    failures.push(`payload schema for ${eventType} must be closed while body fields remain BLOCKED`);
  }
}

const errorCodes = Object.keys(ERROR_CATALOG).sort();
assertEqualSet("OpenAPI ErrorCode enum", openApiEnum("ErrorCode"), errorCodes);
assertEqualSet("OpenAPI RunState enum", openApiEnum("RunState"), EXPECTED_RUN_STATES);
assertEqualSet("OpenAPI WorkitemState enum", openApiEnum("WorkitemState"), EXPECTED_WORKITEM_STATES);
assertEqualSet("OpenAPI HumanTaskState enum", openApiEnum("HumanTaskState"), EXPECTED_HUMAN_TASK_STATES);
assertEqualSet("OpenAPI HumanTaskKind enum", openApiEnum("HumanTaskKind"), EXPECTED_HUMAN_TASK_KINDS);
assertOpenApiContains(
  "createRun requestBody required",
  "      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              $ref: '#/components/schemas/RunCreateRequest'",
);
assertOpenApiSchemaContains("RunCreateRequest", "        model:\n          type: string");
assertOpenApiSchemaContains("Run", "        - current_node");
assertOpenApiSchemaContains("Run", "        - failure_reason");
assertOpenApiSchemaContains("Run", "        - scenario_id");
assertOpenApiSchemaContains("Run", "        current_node:\n          type: [string, \"null\"]");
assertOpenApiSchemaContains("Run", "        failure_reason:\n          type: [object, \"null\"]");
assertOpenApiSchemaContains("ScenarioGeneration", "        - params_context");
assertOpenApiSchemaContains("ScenarioGeneration", "        params_context:\n          type: object");
assertOpenApiPath("/runs/{run_id}/steps");
assertOpenApiPath("/runs/{run_id}/artifacts");
assertOpenApiPath("/run-triggers");
assertOpenApiPath("/run-triggers/{trigger_id}");
assertOpenApiPath("/run-triggers/{trigger_id}/pause");
assertOpenApiPath("/run-triggers/{trigger_id}/resume");
assertOpenApiPath("/run-triggers/{trigger_id}/fires");
assertOpenApiPath("/webhooks/run-triggers/{tenant_id}/{trigger_id}");
assertOpenApiPath("/ops-alerts");
assertOpenApiPath("/ops-alerts/{alert_id}/ack");
assertOpenApiPath("/ops/health");
assertOpenApiPath("/automation-ideas");
assertOpenApiPath("/automation-ideas/{idea_id}");
assertOpenApiPath("/automation-ideas/{idea_id}/transition");
assertOpenApiPath("/automation-ideas/{idea_id}/roi-estimate");
assertOpenApiPath("/scenarios/{scenario_id}/promote-from-run");
assertOpenApiPath("/scenario-generations/{generation_id}/run");
assertOpenApiPath("/scenario-generations/{generation_id}/artifacts");
assertOpenApiPath("/scenario-generations/{generation_id}/artifacts/{artifact_id}");
assertOpenApiPath("/scenario-generations/capabilities");
assertOpenApiPath("/sites/{site_profile_id}/session/capture");
assertOpenApiPath("/sites/{site_profile_id}/page-state");
assertOpenApiPath("/sites/{site_profile_id}/elements");
assertOpenApiPath("/sites/{site_profile_id}/elements/{element_id}");
assertOpenApiPath("/sites/{site_profile_id}/elements/{element_id}/probe");
assertOpenApiPath("/sites/{site_profile_id}/recordings");
assertOpenApiPath("/sites/{site_profile_id}/recordings/{recording_session_id}/events");
assertOpenApiPath("/sites/{site_profile_id}/recordings/{recording_session_id}/complete");
assertControlPlanePath("/v1/runs/{run_id}/steps");
assertControlPlanePath("/v1/runs/{run_id}/artifacts");
assertControlPlanePath("/v1/run-triggers");
assertControlPlanePath("/v1/run-triggers/{trigger_id}");
assertControlPlanePath("/v1/run-triggers/{trigger_id}/pause");
assertControlPlanePath("/v1/run-triggers/{trigger_id}/resume");
assertControlPlanePath("/v1/run-triggers/{trigger_id}/fires");
assertControlPlanePath("/v1/ops-alerts");
assertControlPlanePath("/v1/ops-alerts/{alert_id}/ack");
assertControlPlanePath("/v1/ops/health");
assertControlPlanePath("/v1/automation-ideas");
assertControlPlanePath("/v1/automation-ideas/{idea_id}");
assertControlPlanePath("/v1/automation-ideas/{idea_id}/transition");
assertControlPlanePath("/v1/automation-ideas/{idea_id}/roi-estimate");
assertControlPlanePath("/v1/scenarios/{scenario_id}/promote-from-run");
assertControlPlanePath("/v1/scenario-generations/{generation_id}/run");
assertControlPlanePath("/v1/scenario-generations/{generation_id}/artifacts");
assertControlPlanePath("/v1/scenario-generations/{generation_id}/artifacts/{artifact_id}");
assertControlPlanePath("/v1/scenario-generations/capabilities");
assertControlPlanePath("/v1/sites/{site_profile_id}/session/capture");
assertControlPlanePath("/v1/sites/{site_profile_id}/page-state");
assertControlPlanePath("/v1/sites/{site_profile_id}/elements");
assertControlPlanePath("/v1/sites/{site_profile_id}/elements/{element_id}");
assertControlPlanePath("/v1/sites/{site_profile_id}/elements/{element_id}/probe");
assertControlPlanePath("/v1/sites/{site_profile_id}/recordings");
assertControlPlanePath("/v1/sites/{site_profile_id}/recordings/{recording_session_id}/events");
assertControlPlanePath("/v1/sites/{site_profile_id}/recordings/{recording_session_id}/complete");
assertOperationId("listRunSteps");
assertOperationId("listRunArtifacts");
assertOperationId("listRunTriggers");
assertOperationId("createRunTrigger");
assertOperationId("getRunTrigger");
assertOperationId("updateRunTrigger");
assertOperationId("pauseRunTrigger");
assertOperationId("resumeRunTrigger");
assertOperationId("listRunTriggerFires");
assertOperationId("listOpsAlerts");
assertOperationId("ackOpsAlert");
assertOperationId("getOpsHealth");
assertOperationId("listAutomationIdeas");
assertOperationId("createAutomationIdea");
assertOperationId("getAutomationIdea");
assertOperationId("updateAutomationIdea");
assertOperationId("transitionAutomationIdea");
assertOperationId("upsertRoiEstimate");
assertOperationId("getRoiEstimate");
assertOpenApiPath("/auth/readiness");
assertControlPlanePath("/v1/auth/readiness");
assertOperationId("getAuthReadiness");
assertOperationId("listAuditLog");
assertOperationId("exportAuditLog");
assertOperationId("listConnectors");
assertOperationId("listTemplates");
assertOperationId("listDocumentJobs");
assertOperationId("createDocumentJob");
assertOperationId("getDocumentJob");
assertOperationId("extractDocumentJob");
assertOperationId("getDocumentExtraction");
assertOperationId("createDocumentValidationTask");
assertOperationId("promoteScenarioFromRun");
assertOperationId("runScenarioGeneration");
assertOperationId("getScenarioGenerationCapabilities");
assertOperationId("listScenarioGenerationArtifacts");
assertOperationId("getScenarioGenerationArtifact");
assertOpenApiPath("/principals");
assertControlPlanePath("/v1/principals");
assertOperationId("listPrincipals");
assertOperationId("listSessionCaptures");
assertOperationId("updateSitePageState");
assertOperationId("listSiteElements");
assertOperationId("createSiteElement");
assertOperationId("updateSiteElement");
assertOperationId("probeSiteElement");
assertOperationId("deleteSiteElement");
assertOperationId("listBrowserRecordings");
assertOperationId("startBrowserRecording");
assertOperationId("listBrowserRecordingEvents");
assertOperationId("appendBrowserRecordingEvents");
assertOperationId("completeBrowserRecording");

if (failures.length > 0) {
  console.error(`contract consistency: ${failures.length} failed`);
  for (const failure of failures) console.error("FAIL:", failure);
  process.exit(1);
}

console.log("contract consistency: all checks passed");

function text(pathFromRoot: string): string {
  return readFileSync(`${ROOT}/${pathFromRoot}`, "utf8").replace(/\r\n/g, "\n");
}

function schemaEventTypes(): string[] {
  const schema = eventEnvelopeSchema as {
    $defs?: { eventType?: { enum?: unknown } };
  };
  const values = schema.$defs?.eventType?.enum;
  if (!Array.isArray(values) || !values.every((value): value is string => typeof value === "string")) {
    failures.push("event-envelope.schema.json $defs.eventType.enum is missing or non-string");
    return [];
  }
  return values;
}

function asyncApiChannels(): string[] {
  const body = text("codegen/asyncapi.yaml");
  const channels = body.match(/channels:\n(?<channels>[\s\S]*?)\ncomponents:/)?.groups?.channels;
  if (channels === undefined) {
    failures.push("AsyncAPI channels block not found");
    return [];
  }
  return [...channels.matchAll(/^  ([a-z0-9_.]+):$/gm)].map((match) => match[1]).filter(isString);
}

function sqlEventTypes(): string[] {
  const body = text("db/migration_core_entities.sql");
  const eventCheck = body.match(/CHECK \(event_type IN \(\s*(?<values>[\s\S]*?)\s*\)\),/);
  if (eventCheck?.groups?.values === undefined) {
    failures.push("events_outbox event_type CHECK block not found");
    return [];
  }
  return [...eventCheck.groups.values.matchAll(/'([^']+)'/g)].map((match) => match[1]).filter(isString);
}

function openApiEnum(schemaName: string): string[] {
  const body = text("codegen/openapi.yaml");
  const lines = body.split(/\r?\n/);
  const anchorIndex = lines.findIndex((line) => line.trim() === `${schemaName}:`);
  if (anchorIndex < 0) {
    failures.push(`OpenAPI schema ${schemaName} not found`);
    return [];
  }
  const enumIndex = lines.findIndex((line, index) => index > anchorIndex && line.trim() === "enum:");
  if (enumIndex < 0) {
    failures.push(`OpenAPI schema ${schemaName} enum not found`);
    return [];
  }

  const values: string[] = [];
  for (const line of lines.slice(enumIndex + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      values.push(trimmed.slice(2));
      continue;
    }
    if (trimmed.length > 0) break;
  }
  return values;
}

function assertOpenApiPath(path: string): void {
  if (!text("codegen/openapi.yaml").includes(`  ${path}:\n`)) {
    failures.push(`OpenAPI path missing: ${path}`);
  }
}

function assertOpenApiContains(label: string, expected: string): void {
  if (!text("codegen/openapi.yaml").includes(expected)) {
    failures.push(`OpenAPI drift: ${label}`);
  }
}

function assertOpenApiSchemaContains(schemaName: string, expected: string): void {
  const body = text("codegen/openapi.yaml");
  const lines = body.split(/\r?\n/);
  const anchorIndex = lines.findIndex((line) => line.trim() === `${schemaName}:`);
  if (anchorIndex < 0) {
    failures.push(`OpenAPI schema ${schemaName} not found`);
    return;
  }

  const blockLines: string[] = [];
  for (const line of lines.slice(anchorIndex)) {
    if (blockLines.length > 0 && /^    [A-Za-z0-9]+:/.test(line)) break;
    blockLines.push(line);
  }
  if (!blockLines.join("\n").includes(expected)) {
    failures.push(`OpenAPI schema ${schemaName} missing expected contract: ${expected.trim()}`);
  }
}

function assertControlPlanePath(path: string): void {
  if (!text("ts/control-plane-contract.ts").includes(`| "${path}"`)) {
    failures.push(`ControlPlanePath missing: ${path}`);
  }
}

function assertOperationId(operationId: string): void {
  if (!text("ts/control-plane-contract.ts").includes(`| "${operationId}"`)) {
    failures.push(`OperationId missing: ${operationId}`);
  }
}

function assertUnique(label: string, values: readonly string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) failures.push(`${label} contains duplicate value ${value}`);
    seen.add(value);
  }
}

function assertEqualSet(label: string, actualValues: readonly string[], expectedValues: readonly string[]): void {
  const actual = new Set(actualValues);
  const expected = new Set(expectedValues);
  for (const value of expected) {
    if (!actual.has(value)) failures.push(`${label} missing ${value}`);
  }
  for (const value of actual) {
    if (!expected.has(value)) failures.push(`${label} has unexpected ${value}`);
  }
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}
