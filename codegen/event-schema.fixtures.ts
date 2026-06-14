/**
 * Event schema/AsyncAPI consistency fixture.
 *
 * Runs independently from run-fixtures.ts so this workstream does not need to
 * edit the shared fixture runner. It cross-checks:
 * - event-envelope tenant event_type enum and allOf payload_schema_ref mapping
 * - canonical step references: (tenant_id, run_id, step_id, attempt)
 * - schema/events/*.schema.json closed empty v1 payload artifacts
 * - codegen/event-payload-registry.ts refs/schemas
 * - codegen/asyncapi.yaml channels, payload registry, and enums
 * - validateEvent()/validators.event positive and negative boundary behavior
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import eventEnvelopeSchema from "../schema/event-envelope.schema.json";
import {
  EVENT_PAYLOAD_SCHEMA_REFS,
  EVENT_PAYLOAD_SCHEMAS,
  TENANT_EVENT_TYPES,
  type TenantEventType,
} from "./event-payload-registry";
import { validateEvent, validators } from "./validators";

type JsonRecord = Record<string, unknown>;
type StringRecord = Record<string, string>;

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const ROOT = dirname(fileURLToPath(import.meta.url));
const ASYNCAPI_PATH = join(ROOT, "asyncapi.yaml");
const EVENT_SCHEMA_DIR = join(ROOT, "..", "schema", "events");
const STEP_EVENTS = ["step.started", "step.completed", "step.verify.failed"] as const satisfies readonly TenantEventType[];

const failures: string[] = [];
let consistencyChecks = 0;
let positiveCases = 0;
let negativeCases = 0;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function check(name: string, condition: boolean): void {
  consistencyChecks += 1;
  if (!condition) failures.push(name);
}

function expectedRef(eventType: TenantEventType): `events/${TenantEventType}@1` {
  return `events/${eventType}@1`;
}

function expectedRegistry(): StringRecord {
  const registry: StringRecord = {};
  for (const eventType of TENANT_EVENT_TYPES) {
    registry[eventType] = expectedRef(eventType);
  }
  return registry;
}

function actualRegistryRefs(): StringRecord {
  const registry: StringRecord = {};
  for (const eventType of TENANT_EVENT_TYPES) {
    const ref = EVENT_PAYLOAD_SCHEMA_REFS[eventType];
    check(`event-payload-registry has ${eventType}`, typeof ref === "string");
    if (typeof ref === "string") registry[eventType] = ref;
  }
  return registry;
}

function compareStringRecords(name: string, actual: StringRecord, expected: StringRecord): void {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  check(`${name}: key count`, actualKeys.length === expectedKeys.length);
  for (const key of expectedKeys) {
    check(`${name}: missing key ${key}`, Object.prototype.hasOwnProperty.call(actual, key));
    check(`${name}: ${key} value`, actual[key] === expected[key]);
  }
  for (const key of actualKeys) {
    check(`${name}: unexpected key ${key}`, Object.prototype.hasOwnProperty.call(expected, key));
  }
}

function compareStringArrays(name: string, actual: readonly string[], expected: readonly string[]): void {
  check(`${name}: length`, actual.length === expected.length);
  for (const expectedValue of expected) {
    check(`${name}: contains ${expectedValue}`, actual.includes(expectedValue));
  }
  for (const actualValue of actual) {
    check(`${name}: unexpected ${actualValue}`, expected.includes(actualValue));
  }
}

function parseTopLevelMapping(source: string, topLevelKey: string): StringRecord {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${topLevelKey}:`);
  const mapping: StringRecord = {};
  if (start < 0) {
    failures.push(`AsyncAPI missing ${topLevelKey}`);
    return mapping;
  }

  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && !line.startsWith("#")) break;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const match = /^  ([a-z0-9_.]+): (events\/[a-z0-9_.-]+@[0-9]+)$/.exec(line);
    if (match) mapping[match[1]] = match[2];
  }

  return mapping;
}

function parseAsyncApiChannels(source: string): string[] {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === "channels:");
  const end = lines.findIndex((line, index) => index > start && line === "components:");
  if (start < 0 || end < 0 || end <= start) {
    failures.push("AsyncAPI channels/components section missing");
    return [];
  }

  return lines
    .slice(start + 1, end)
    .flatMap((line) => {
      const match = /^  ([a-z0-9_.]+):$/.exec(line);
      return match ? [match[1]] : [];
    });
}

function parseAsyncApiEnum(source: string, schemaName: string): string[] {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `    ${schemaName}:`);
  if (start < 0) {
    failures.push(`AsyncAPI schema ${schemaName} missing`);
    return [];
  }

  const enumLine = lines.findIndex((line, index) => index > start && line === "      enum:");
  if (enumLine < 0) {
    failures.push(`AsyncAPI schema ${schemaName} enum missing`);
    return [];
  }

  const values: string[] = [];
  for (const line of lines.slice(enumLine + 1)) {
    const match = /^        - ([a-z0-9_.\/@-]+)$/.exec(line);
    if (!match) break;
    values.push(match[1]);
  }
  return values;
}

function parseJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function assertClosedEmptyPayloadSchema(schema: unknown, label: string, id: string): void {
  check(`${label}: schema object`, isRecord(schema));
  if (!isRecord(schema)) return;

  check(`${label}: $schema draft 2020-12`, schema.$schema === "https://json-schema.org/draft/2020-12/schema");
  check(`${label}: $id`, schema.$id === id);
  check(`${label}: type object`, schema.type === "object");
  check(`${label}: additionalProperties false`, schema.additionalProperties === false);

  const properties = schema.properties;
  check(
    `${label}: no body properties in v1`,
    properties === undefined || (isRecord(properties) && Object.keys(properties).length === 0),
  );

  const required = schema.required;
  check(
    `${label}: no body required keys in v1`,
    required === undefined || (Array.isArray(required) && required.length === 0),
  );

  const description = typeof schema.description === "string" ? schema.description : "";
  const normalizedDescription = description.toLocaleLowerCase("en-US");
  check(
    `${label}: payload decision text`,
    normalizedDescription.includes("closed empty") || normalizedDescription.includes("closed empty objects"),
  );
  check(`${label}: no blocked payload TODO`, !description.includes("TODO") && !description.includes("[BLOCKED]"));
}

function isStepEvent(eventType: TenantEventType): boolean {
  return (STEP_EVENTS as readonly string[]).includes(eventType);
}

function eventEnvelope(eventType: TenantEventType, overrides: JsonRecord = {}): JsonRecord {
  return {
    event_id: UUID_A,
    event_type: eventType,
    event_version: 1,
    tenant_id: UUID_A,
    correlation_id: UUID_A,
    occurred_at: "2026-06-13T00:00:00Z",
    idempotency_key: `fixture:${eventType}`,
    payload_schema_ref: expectedRef(eventType),
    payload: {},
    ...(isStepEvent(eventType) ? { run_id: UUID_A, step_id: "extract.review", attempt: 0 } : {}),
    ...overrides,
  };
}

function expectEvent(name: string, data: unknown, expected: boolean): void {
  const result = validateEvent(data).valid;
  if (expected) positiveCases += 1;
  else negativeCases += 1;

  if (result !== expected) {
    failures.push(`${name}: validateEvent expected ${expected}, got ${result}`);
  }

  const publicResult = validators.event(data);
  if (publicResult !== expected) {
    failures.push(`${name}: validators.event expected ${expected}, got ${publicResult}`);
  }
}

function otherPayloadRef(eventType: TenantEventType): string {
  const otherType = TENANT_EVENT_TYPES.find((candidate) => candidate !== eventType);
  if (otherType === undefined) throw new Error("TENANT_EVENT_TYPES must contain at least two entries");
  return expectedRef(otherType);
}

const expected = expectedRegistry();
const asyncApi = readFileSync(ASYNCAPI_PATH, "utf8").replace(/\r\n/g, "\n");

// Envelope schema and correlation checks that are explicitly contract-backed.
compareStringArrays(
  "event-envelope $defs.eventType enum",
  (getPath(eventEnvelopeSchema, ["$defs", "eventType", "enum"]) as string[] | undefined) ?? [],
  TENANT_EVENT_TYPES,
);
const envelopeRequired = (getPath(eventEnvelopeSchema, ["required"]) as string[] | undefined) ?? [];
for (const requiredField of [
  "event_id",
  "event_type",
  "event_version",
  "tenant_id",
  "correlation_id",
  "occurred_at",
  "idempotency_key",
  "payload_schema_ref",
  "payload",
]) {
  check(`event-envelope required ${requiredField}`, envelopeRequired.includes(requiredField));
}
check("event-envelope ordering_key remains optional for run-less tenant events", !envelopeRequired.includes("ordering_key"));
check("event-envelope correlation_id format uuid", getPath(eventEnvelopeSchema, ["properties", "correlation_id", "format"]) === "uuid");
check("event-envelope causation_id format uuid", getPath(eventEnvelopeSchema, ["properties", "causation_id", "format"]) === "uuid");
check("event-envelope attempt integer", getPath(eventEnvelopeSchema, ["properties", "attempt", "type"]) === "integer");
check("event-envelope attempt minimum", getPath(eventEnvelopeSchema, ["properties", "attempt", "minimum"]) === 0);
check("event-envelope step_id minimum length", getPath(eventEnvelopeSchema, ["properties", "step_id", "minLength"]) === 1);
check("event-envelope payload closed at envelope level", getPath(eventEnvelopeSchema, ["properties", "payload", "additionalProperties"]) === false);
check(
  "event-envelope decision comment",
  typeof getPath(eventEnvelopeSchema, ["$comment"]) === "string" &&
    (getPath(eventEnvelopeSchema, ["$comment"]) as string).includes("(tenant_id, run_id, step_id, attempt)") &&
    !(getPath(eventEnvelopeSchema, ["$comment"]) as string).includes("TODO"),
);

const envelopeAllOf = (getPath(eventEnvelopeSchema, ["allOf"]) as unknown[] | undefined) ?? [];
for (const eventType of TENANT_EVENT_TYPES) {
  const ref = expectedRef(eventType);
  const rule = envelopeAllOf.find((candidate) => getPath(candidate, ["if", "properties", "event_type", "const"]) === eventType);
  check(`event-envelope allOf maps ${eventType} -> ${ref}`, getPath(rule, ["then", "properties", "payload_schema_ref", "const"]) === ref);
  if (isStepEvent(eventType)) {
    const required = (getPath(rule, ["then", "required"]) as string[] | undefined) ?? [];
    for (const requiredStepField of ["run_id", "step_id", "attempt"]) {
      check(`event-envelope ${eventType} requires ${requiredStepField}`, required.includes(requiredStepField));
    }
  }
}

// Payload registry and schema artifact checks.
compareStringRecords("event-payload-registry refs", actualRegistryRefs(), expected);

const expectedSchemaFiles = new Set([
  ...TENANT_EVENT_TYPES.map((eventType) => `${eventType}.schema.json`),
  "common-empty-payload.schema.json",
]);
const actualSchemaFiles = readdirSync(EVENT_SCHEMA_DIR)
  .filter((name) => name.endsWith(".schema.json"))
  .sort();
compareStringArrays("schema/events file set", actualSchemaFiles, [...expectedSchemaFiles].sort());

assertClosedEmptyPayloadSchema(
  parseJsonFile(join(EVENT_SCHEMA_DIR, "common-empty-payload.schema.json")),
  "common-empty-payload",
  "https://rpa.local/contracts/events/common-empty-payload@1",
);

for (const eventType of TENANT_EVENT_TYPES) {
  const schema = EVENT_PAYLOAD_SCHEMAS[eventType] as unknown;
  check(`${eventType} payload schema registered`, schema !== undefined);
  assertClosedEmptyPayloadSchema(
    schema,
    `${eventType} payload schema`,
    `https://rpa.local/contracts/events/${eventType}@1`,
  );
}

// AsyncAPI consistency checks.
compareStringRecords("AsyncAPI x-event-payload-registry", parseTopLevelMapping(asyncApi, "x-event-payload-registry"), expected);
compareStringArrays("AsyncAPI channels", parseAsyncApiChannels(asyncApi), TENANT_EVENT_TYPES);
compareStringArrays("AsyncAPI eventType enum", parseAsyncApiEnum(asyncApi, "eventType"), TENANT_EVENT_TYPES);
compareStringArrays("AsyncAPI EventPayloadSchemaRef enum", parseAsyncApiEnum(asyncApi, "EventPayloadSchemaRef"), Object.values(expected));
check("AsyncAPI correlation extension present", asyncApi.includes("x-envelope-correlation-contract:"));
check("AsyncAPI step reference contract present", asyncApi.includes("x-step-reference-contract:"));
check("AsyncAPI step reference decision", asyncApi.includes("(tenant_id, run_id, step_id, attempt)"));
check("AsyncAPI correlation_id required extension", asyncApi.includes("  required:\n    - correlation_id"));
check("AsyncAPI correlation uuid extension", asyncApi.includes("  uuid_fields:\n    - correlation_id\n    - causation_id"));
check("AsyncAPI headers require correlation_id", asyncApi.includes("          - correlation_id"));
check("AsyncAPI headers require idempotency_key", asyncApi.includes("          - idempotency_key"));
check("AsyncAPI no blocked event TODOs", !asyncApi.includes("TODO: [BLOCKED]"));
check("AsyncAPI no worker tenant events", !asyncApi.includes("worker.heartbeat") && !asyncApi.includes("worker.circuit_"));

// Validator positive and negative coverage.
for (const eventType of TENANT_EVENT_TYPES) {
  expectEvent(`${eventType}: canonical empty payload validates`, eventEnvelope(eventType), true);
  expectEvent(
    `${eventType}: mismatched payload_schema_ref rejected`,
    eventEnvelope(eventType, { payload_schema_ref: otherPayloadRef(eventType) }),
    false,
  );
  expectEvent(
    `${eventType}: undocumented payload body field rejected`,
    eventEnvelope(eventType, { payload: { undocumented: true } }),
    false,
  );
}

expectEvent(
  "site.circuit_opened: run-less event may omit run_id and ordering_key",
  eventEnvelope("site.circuit_opened"),
  true,
);
expectEvent(
  "step.completed: canonical step reference accepted",
  eventEnvelope("step.completed", { run_id: UUID_B, step_id: "verify.total", attempt: 2 }),
  true,
);
expectEvent(
  "step.completed: missing run_id rejected",
  eventEnvelope("step.completed", { run_id: undefined }),
  false,
);
const missingStepId = eventEnvelope("step.completed");
delete missingStepId.step_id;
expectEvent("step.completed: missing step_id rejected", missingStepId, false);
const missingAttempt = eventEnvelope("step.completed");
delete missingAttempt.attempt;
expectEvent("step.completed: missing attempt rejected", missingAttempt, false);
expectEvent("step.completed: negative attempt rejected", eventEnvelope("step.completed", { attempt: -1 }), false);
expectEvent("empty step_id rejected when present", eventEnvelope("step.completed", { step_id: "" }), false);

expectEvent(
  "worker.heartbeat rejected from tenant-scoped event envelope",
  {
    ...eventEnvelope("run.completed"),
    event_type: "worker.heartbeat",
    payload_schema_ref: "events/worker.heartbeat@1",
  },
  false,
);
expectEvent(
  "worker.circuit_opened rejected from tenant-scoped event envelope",
  {
    ...eventEnvelope("run.completed"),
    event_type: "worker.circuit_opened",
    payload_schema_ref: "events/worker.circuit_opened@1",
  },
  false,
);

const missingCorrelation = eventEnvelope("run.completed");
delete missingCorrelation.correlation_id;
expectEvent("correlation_id missing rejected", missingCorrelation, false);
const missingPayloadRef = eventEnvelope("run.completed");
delete missingPayloadRef.payload_schema_ref;
expectEvent("payload_schema_ref missing rejected", missingPayloadRef, false);
const missingPayload = eventEnvelope("run.completed");
delete missingPayload.payload;
expectEvent("payload missing rejected", missingPayload, false);
expectEvent("correlation_id non-uuid rejected", eventEnvelope("run.completed", { correlation_id: "not-a-uuid" }), false);
expectEvent("causation_id non-uuid rejected", eventEnvelope("run.completed", { causation_id: "not-a-uuid" }), false);
expectEvent("causation_id uuid accepted", eventEnvelope("run.completed", { causation_id: UUID_B }), true);
expectEvent("ordering_key empty rejected when present", eventEnvelope("run.completed", { ordering_key: "" }), false);
expectEvent("event_version minimum enforced", eventEnvelope("run.completed", { event_version: 0 }), false);
expectEvent("payload must be object", eventEnvelope("run.completed", { payload: null }), false);
expectEvent("unknown event_type rejected", { ...eventEnvelope("run.completed"), event_type: "run.aborted" }, false);
expectEvent("payload_schema_ref version mismatch rejected", eventEnvelope("run.completed", { payload_schema_ref: "events/run.completed@2" }), false);
expectEvent("additional envelope field rejected", eventEnvelope("run.completed", { typo: true }), false);

console.log(
  `event schema fixtures: ${consistencyChecks} consistency checks, ${positiveCases} positive cases, ${negativeCases} negative cases, ${failures.length} failed`,
);
if (failures.length > 0) {
  for (const failure of failures) console.error("FAIL:", failure);
  process.exit(1);
}
console.log("ALL PASS");
