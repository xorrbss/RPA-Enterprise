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

const EXPECTED_PRODUCTION_READINESS_EVIDENCE_TYPES = [
  "external_alert_delivery",
  "managed_backup_restore_drill",
  "slo_oncall_signoff",
  "observability_telemetry_wiring",
  "support_training_completion",
] as const;

const EXPECTED_AI_GOVERNANCE_EVIDENCE_TYPES = [
  "model_registry",
  "prompt_registry",
  "eval_result",
  "cost_control",
  "human_override",
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
assertEqualSet(
  "OpenAPI ProductionReadinessEvidenceType enum",
  openApiEnum("ProductionReadinessEvidenceType"),
  EXPECTED_PRODUCTION_READINESS_EVIDENCE_TYPES,
);
assertEqualSet(
  "OpenAPI AiGovernanceEvidenceType enum",
  openApiEnum("AiGovernanceEvidenceType"),
  EXPECTED_AI_GOVERNANCE_EVIDENCE_TYPES,
);
assertOpenApiContains(
  "createRun requestBody required",
  "      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              $ref: '#/components/schemas/RunCreateRequest'",
);
assertOpenApiContains("createRun response requires run mode", "                $ref: '#/components/schemas/RunCreateCommandResponse'");
assertOpenApiSchemaContains("RunCreateRequest", "        model:\n          type: string");
assertOpenApiSchemaContains("RunCreateRequest", "        run_mode:\n          $ref: '#/components/schemas/RunMode'");
assertOpenApiSchemaContains("RunCreateCommandResponse", "      required: [run_id, status, run_mode]");
assertOpenApiSchemaContains("Run", "        - current_node");
assertOpenApiSchemaContains("Run", "        - failure_reason");
assertOpenApiSchemaContains("Run", "        - scenario_id");
assertOpenApiSchemaContains("Run", "        - run_mode");
assertOpenApiSchemaContains("Run", "        run_mode: { $ref: '#/components/schemas/RunMode' }");
assertOpenApiSchemaContains("AutomationPerformanceReport", "        - run_mode");
assertOpenApiSchemaContains("AutomationPerformanceReport", "        run_mode:\n          $ref: '#/components/schemas/AutomationPerformanceRunMode'");
assertOpenApiSchemaContains("Run", "        current_node:\n          type: [string, \"null\"]");
assertOpenApiSchemaContains("Run", "        failure_reason:\n          type: [object, \"null\"]");
assertOpenApiSchemaContains("ScenarioGeneration", "        - params_context");
assertOpenApiSchemaContains("ScenarioGeneration", "        params_context:\n          type: object");
assertControlPlanePath("/v1/runs/{run_id}/steps");
assertControlPlanePath("/v1/runs/{run_id}/artifacts");
assertControlPlanePath("/v1/run-resume-requests");
assertControlPlanePath("/v1/web-attended/run-requests");
assertControlPlanePath("/v1/run-triggers");
assertControlPlanePath("/v1/run-triggers/{trigger_id}");
assertControlPlanePath("/v1/run-triggers/{trigger_id}/pause");
assertControlPlanePath("/v1/run-triggers/{trigger_id}/resume");
assertControlPlanePath("/v1/run-triggers/{trigger_id}/fires");
assertControlPlanePath("/v1/ops-alerts");
assertControlPlanePath("/v1/ops-alerts/{alert_id}/ack");
assertControlPlanePath("/v1/ops-alerts/{alert_id}/deliveries");
assertControlPlanePath("/v1/ops-alerts/{alert_id}/deliveries/send-webhook");
assertControlPlanePath("/v1/ops/health");
assertControlPlanePath("/v1/ai-governance/evidence");
assertControlPlanePath("/v1/automation-ideas");
assertControlPlanePath("/v1/process-mining/imports");
assertControlPlanePath("/v1/automation-ideas/{idea_id}");
assertControlPlanePath("/v1/automation-ideas/{idea_id}/transition");
assertControlPlanePath("/v1/automation-ideas/{idea_id}/roi-estimate");
assertControlPlanePath("/v1/automation-ideas/{idea_id}/adoption-evidence");
assertControlPlanePath("/v1/scenarios/{scenario_id}/versions/{version}/governance-stage");
assertControlPlanePath("/v1/scenarios/{scenario_id}/promote-from-run");
assertControlPlanePath("/v1/scenario-generations/{generation_id}/run");
assertControlPlanePath("/v1/scenario-generations/{generation_id}/revise");
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
assertOperationId("listRunResumeRequests");
assertOperationId("listWebAttendedRunRequests");
assertOperationId("createWebAttendedRunRequest");
assertOperationId("listRunTriggers");
assertOperationId("createRunTrigger");
assertOperationId("getRunTrigger");
assertOperationId("updateRunTrigger");
assertOperationId("pauseRunTrigger");
assertOperationId("resumeRunTrigger");
assertOperationId("listRunTriggerFires");
assertOperationId("listOpsAlerts");
assertOperationId("ackOpsAlert");
assertOperationId("listOpsAlertDeliveries");
assertOperationId("recordOpsAlertDelivery");
assertOperationId("sendOpsAlertWebhookDelivery");
assertOperationId("listOpsAlertNotificationRoutes");
assertOperationId("createOpsAlertNotificationRoute");
assertOperationId("updateOpsAlertNotificationRoute");
assertOperationId("deleteOpsAlertNotificationRoute");
assertControlPlanePath("/v1/ops-alert-routes");
assertControlPlanePath("/v1/ops-alert-routes/{route_id}");
// S4b: session_expiry alert source + browser_session subject must stay in the OpsAlert enums,
// and stored-route source stays restricted to the stable auto-fire sources.
assertOpenApiSchemaContains("OpsAlertSource", "        - session_expiry");
assertOpenApiSchemaContains("OpsAlertSubjectType", "        - browser_session");
assertOpenApiSchemaContains("OpsAlertNotificationRouteSource", "        - session_expiry");
assertOperationId("getOpsHealth");
assertOperationId("listAutomationIdeas");
assertOperationId("listProcessMiningImports");
assertOperationId("createProcessMiningImport");
assertOperationId("createAutomationIdea");
assertOperationId("getAutomationIdea");
assertOperationId("updateAutomationIdea");
assertOperationId("transitionAutomationIdea");
assertOperationId("upsertRoiEstimate");
assertOperationId("getRoiEstimate");
assertOperationId("listAutomationAdoptionEvidence");
assertOperationId("recordAutomationAdoptionEvidence");
assertOperationId("listAiGovernanceEvidence");
assertOperationId("recordAiGovernanceEvidence");
assertOpenApiSchemaContains("AiGovernanceEvidenceRequest", "                required: [eval_suite_ref, dataset_ref, sampled_at, pass_rate, prompt_injection_passed, data_leakage_passed, hallucination_passed, policy_block_passed]");
assertOpenApiSchemaContains("AiGovernanceEvidenceRequest", "            required: [evidence_ref, policy_decision_ref, audit_correlation_id, metadata]");
assertOpenApiSchemaContains("AiGovernanceEvidenceRequest", "              audit_correlation_id:\n                type: string\n                format: uuid");
assertOpenApiSchemaContains("AiGovernanceEvidenceRequest", "              expires_at:\n                type: string\n                format: date-time");
assertOpenApiContains("AI governance idempotency header", "      operationId: recordAiGovernanceEvidence\n      summary: Record AI governance evidence\n      description: >\n        Record admin-only metadata evidence for AI governance controls.");
assertOpenApiContains("AI governance idempotency parameter", "      parameters:\n        - $ref: '#/components/parameters/IdempotencyKey'\n      requestBody:");
assertOperationId("setScenarioVersionGovernanceStage");
assertOpenApiSchemaContains("ScenarioCertification", "        - governance_stage");
assertOpenApiSchemaContains("ScenarioGovernanceStageRequest", "          enum: [review, pilot, deprecated]");
assertOpenApiSchemaContains("ProductionReadinessEvidenceRequest", "                const: support_training_completion");
assertOpenApiSchemaContains("ProductionReadinessEvidenceRequest", "                required: [support_model_ref, training_completion_ref, trained_role_count, trained_user_count, coverage_percent, completed_at]");
assertOpenApiSchemaContains("OpsNotificationAttempt", "        - callback_signature_secret_ref");
assertOpenApiSchemaContains("OpsNotificationWebhookSendRequest", "        callback_signature_secret_ref:");
assertOpenApiSchemaContains("OpsNotificationWebhookCallbackRequest", "          enum: [delivered, failed]");
assertControlPlanePath("/v1/auth/readiness");
assertOperationId("getAuthReadiness");
assertOperationId("listAuditLog");
assertOperationId("exportAuditLog");
assertOperationId("exportOffboardingData");
assertControlPlanePath("/v1/offboarding/export");
assertOpenApiSchemaContains("OffboardingExportQuery", "        format:\n          type: string\n          enum: [csv]");
assertOpenApiSchemaContains("OffboardingExportCsv", "Metadata-only offboarding CSV");
assertOperationId("listConnectors");
assertOperationId("listTemplates");
assertOperationId("listConnectorProfiles");
assertOperationId("createConnectorProfile");
assertOperationId("certifyConnectorProfile");
assertOperationId("listDocumentJobs");
assertOperationId("createDocumentJob");
assertOperationId("getDocumentJob");
assertOperationId("extractDocumentJob");
assertOperationId("recordExternalDocumentExtraction");
assertOperationId("getDocumentExtraction");
assertOperationId("createDocumentValidationTask");
assertOperationId("promoteScenarioFromRun");
assertOperationId("runScenarioGeneration");
assertOperationId("getScenarioGenerationCapabilities");
assertOperationId("listScenarioGenerationArtifacts");
assertOperationId("getScenarioGenerationArtifact");
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

assertOpenApiSurfaceParity();

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

// R1-1: api-surface.md ↔ openapi.yaml 전수 대조(양방향 집합 동등). 이전의 수기 assertOpenApiPath 스팟체크는
// 부분 레지스트리 drift(문서 경로의 28%가 openapi에 없어도 green)를 놓쳤다 — openapi.yaml은 스스로
// "api-surface.md를 1:1 변환한 산출물"이라 선언하므로(헤더 description) 집합 동등이 정확한 게이트다.
// 파라미터 이름은 표기 관례가 갈릴 수 있어({id} vs {artifact_id}) shape({})로 정규화해 비교한다.
function assertOpenApiSurfaceParity(): void {
  const normalize = (method: string, path: string): string => `${method} ${path.replace(/\{[^}]*\}/g, "{}")}`;
  const surface = text("api-surface.md");
  const surfacePairs = new Set<string>();
  // 표 행 표기: | GET | `/v1/...` |
  for (const m of surface.matchAll(/^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`\s]+)`/gm)) {
    const raw = m[2] as string;
    if (!raw.startsWith("/v1/")) continue;
    surfacePairs.add(normalize(m[1] as string, raw.slice(3)));
  }
  // 산문(백틱 인라인) 표기: `GET /v1/...` — auth/readiness·ai-governance·governance-stage 등.
  // '...' 축약(예시/생략)은 canonical 표면이 아니므로 제외.
  for (const m of surface.matchAll(/`(GET|POST|PUT|PATCH|DELETE)\s+(\/v1\/[^`\s]+)`/g)) {
    const raw = m[2] as string;
    if (raw.includes("...")) continue;
    surfacePairs.add(normalize(m[1] as string, raw.slice(3)));
  }
  const openapi = text("codegen/openapi.yaml");
  const openapiPairs = new Set<string>();
  let currentPath: string | null = null;
  let inPaths = false;
  for (const line of openapi.split(/\r?\n/)) {
    if (/^paths:\s*$/.test(line)) { inPaths = true; continue; }
    if (inPaths && /^[A-Za-z]/.test(line)) inPaths = false; // 다음 최상위 키 → paths 종료
    if (!inPaths) continue;
    const pathKey = line.match(/^  (\/[^\s:]*):\s*$/);
    if (pathKey) { currentPath = pathKey[1] as string; continue; }
    const methodKey = line.match(/^    (get|post|put|patch|delete):\s*$/);
    if (methodKey && currentPath !== null) openapiPairs.add(normalize((methodKey[1] as string).toUpperCase(), currentPath));
  }
  if (surfacePairs.size === 0 || openapiPairs.size === 0) {
    failures.push("OpenAPI parity: parsed zero endpoints (parser drift) — check api-surface.md/openapi.yaml formats");
    return;
  }
  for (const pair of surfacePairs) {
    if (!openapiPairs.has(pair)) failures.push(`OpenAPI missing endpoint (documented in api-surface.md): ${pair}`);
  }
  for (const pair of openapiPairs) {
    if (!surfacePairs.has(pair)) failures.push(`OpenAPI extra endpoint (not in api-surface.md): ${pair}`);
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
