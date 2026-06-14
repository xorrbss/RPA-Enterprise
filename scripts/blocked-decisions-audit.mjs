#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const BLOCKED_MARKER = "TODO:" + " [BLOCKED]";

const knownReleaseDecisions = [
  "Canonical step event/reference key is not defined",
  "Event-specific closed payload body fields are not defined",
  "Reserved handler explicit return/input contract is not defined",
  "Loop body/exit target contract is not defined",
  "Payload retention/deletion class is not defined",
  "Connector target FK contract is not defined",
  "Control-plane command/API error mapping is incomplete",
  "Human task escalation RBAC action is not defined",
  "Worker job payload/completion event contracts are not defined",
  "Durable LLM idempotency contract is not defined",
  "Durable immutable audit storage contract is not defined",
  "Tenantless worker event routing contract is not defined",
  "Staging deploy target is not defined",
];

const releaseDecisionRules = [
  {
    label: "Staging deploy target is not defined",
    aliases: ["Staging deploy target is not defined"],
  },
  {
    label: "Event-specific closed payload body fields are not defined",
    aliases: [
      "Event-specific closed payload body fields are not defined",
      "per-event payload body fields",
      "per-event payload body field schemas",
      "per-event payload fields",
      "per-event closed payload body fields",
      "Closed per-event payload fields",
      "event-payload-registry fixes event_type",
      "exact payload fields",
      "exact fields for every events/{event_type}@1 schema",
    ],
  },
  {
    label: "Reserved handler explicit return/input contract is not defined",
    aliases: [
      "Reserved handler explicit return/input contract is not defined",
      "reserved-handler target object",
      "explicit return_node/input contract",
      "explicit `return_node`/handler input",
      "reserved handler",
    ],
  },
  {
    label: "Loop body/exit target contract is not defined",
    aliases: [
      "Loop body/exit target contract is not defined",
      "loop body/exit shape",
      "`loop`",
      "loop nodes cannot be promoted",
    ],
  },
  {
    label: "Payload retention/deletion class is not defined",
    aliases: [
      "Payload retention/deletion class is not defined",
      "payload retention/deletion class",
      "payload retention or deletion",
      "retention/deletion class",
      "retention_until",
      "deleted_at",
      "legal_hold",
    ],
  },
  {
    label: "Connector target FK contract is not defined",
    aliases: [
      "Connector target FK contract is not defined",
      "Connector target table/tenant FK contract is not defined",
      "connector target table/tenant FK contract is not defined",
      "target entity key shape",
      "(tenant_id, connector_id, target_id)",
    ],
  },
  {
    label: "Canonical step event/reference key is not defined",
    aliases: [
      "Canonical step event/reference key is not defined",
      "event-type-specific envelope identity requirements",
      "step/body required fields are unresolved",
      "canonical step-level event reference",
      "canonical step event reference key",
      "step-level artifact FK",
      "step-level stagehand FK",
      "Step-level reference key",
      "run_step_id",
      "(run_id, step_id, attempt)",
    ],
  },
  {
    label: "Control-plane command/API error mapping is incomplete",
    aliases: [
      "Control-plane command/API error mapping is incomplete",
      "API catalog has no ErrorCode/HTTP response for an unmatched control-plane route",
      "Idempotency-Key on command POSTs but does not define the ErrorCode/HTTP response",
      "Same Idempotency-Key with different method/path/body request_hash",
      "Concurrent duplicate Idempotency-Key while the first response is still processing",
      "api-surface.md fixes request_hash storage but does not",
      "request_hash_mismatch",
    ],
  },
  {
    label: "Human task escalation RBAC action is not defined",
    aliases: [
      "Human task escalation RBAC action is not defined",
      "human_task escalate",
      "human_task.escalate",
      "escalateHumanTask",
    ],
  },
  {
    label: "Worker job payload/completion event contracts are not defined",
    aliases: [
      "Worker job payload/completion event contracts are not defined",
      "Worker job payloads for run_claim/run_resume/workitem_checkout",
      "job-specific input payloads and completion events",
      "artifact jobs",
    ],
  },
  {
    label: "Durable LLM idempotency contract is not defined",
    aliases: [
      "Durable LLM idempotency contract is not defined",
      "LLM idempotency-key reuse with a different request hash",
      "stagehand_calls currently has no idempotency_key/request_hash",
      "Durable replay can only be implemented",
      "durable LLM idempotency",
    ],
  },
  {
    label: "Durable immutable audit storage contract is not defined",
    aliases: [
      "Durable immutable audit storage contract is not defined",
      "append-only audit log",
      "durable audit table",
      "external WORM sink",
      "immutable audit sink",
    ],
  },
  {
    label: "Tenantless worker event routing contract is not defined",
    aliases: [
      "Tenantless worker event routing contract is not defined",
      "tenantless worker event stream",
      "operational tenant",
      "worker event routing",
      "worker telemetry",
    ],
  },
];

const scanExtensions = new Set([
  ".md",
  ".json",
  ".sql",
  ".ts",
  ".js",
  ".mjs",
  ".py",
  ".yaml",
  ".yml",
  ".html",
]);
const skippedDirs = new Set([".git", "node_modules", ".next", "dist", "coverage"]);
const informationalFiles = new Set([
  "AGENTS.md",
  "build-prompt.md",
  "CLAUDE.md",
  "README.md",
  "rpa_enterprise_console.html",
  "scripts/blocked-decisions-audit.mjs",
  "scripts/contract-lint.mjs",
  "scripts/yaml-parse.py",
]);

const failures = [];
const todos = [];
let releaseDecisionLines = [];

for (const relPath of collectFiles(ROOT)) {
  let text;
  try {
    text = UTF8.decode(readFileSync(join(ROOT, relPath)));
  } catch (error) {
    failures.push(`${relPath}: not valid UTF-8: ${error.message}`);
    continue;
  }

  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.includes(BLOCKED_MARKER)) continue;

    const lineNo = index + 1;
    const context = lines.slice(index, Math.min(lines.length, index + 4)).join("\n");
    todos.push({ relPath, lineNo, line, context });

    if (isInformational(relPath, line)) continue;
    if (!/Required[\s/*-]+decision:/i.test(context)) {
      failures.push(`${relPath}:${lineNo}: blocked TODO must include Required decision within the same line or next 3 lines`);
    }
  }
}

checkReleaseChecklist();
checkActionableChecklistTracking();
checkEventPlaceholderCoverage();

if (failures.length > 0) {
  console.error(`blocked decision audit: ${failures.length} failed`);
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}

const actionable = actionableTodos().length;
console.log(
  `blocked decision audit: ${todos.length} markers, ${actionable} actionable blockers, ${knownReleaseDecisions.length} known release decisions tracked, ${releaseDecisionLines.length} release decisions checked`,
);

function checkReleaseChecklist() {
  const checklist = readFileSync(join(ROOT, "release-open-checklist.md"), "utf8");
  const sectionMatch = checklist.match(/## Resolved Release Decisions([\s\S]*?)(?:\n## |$)/);
  if (!sectionMatch) {
    failures.push("release-open-checklist.md: missing Resolved Release Decisions section");
    return;
  }

  releaseDecisionLines = sectionMatch[1]
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("- Resolved:"));

  if (releaseDecisionLines.length !== releaseDecisionRules.length) {
    failures.push(
      `release-open-checklist.md: expected ${releaseDecisionRules.length} tracked release decisions, found ${releaseDecisionLines.length}`,
    );
  }

  for (const label of knownReleaseDecisions) {
    const line = releaseDecisionLines.find((candidate) => candidate.includes(label));
    if (!line) {
      failures.push(`release-open-checklist.md: missing resolved release decision ${JSON.stringify(label)}`);
      continue;
    }
    if (!line.includes("Former Required decision:")) {
      failures.push(`release-open-checklist.md: resolved decision ${JSON.stringify(label)} must preserve former Required decision`);
    }
  }

  for (const rule of releaseDecisionRules) {
    const line = releaseDecisionLines.find((candidate) => candidate.includes(rule.label));
    if (!line) {
      failures.push(`release-open-checklist.md: missing tracked resolved release decision ${JSON.stringify(rule.label)}`);
      continue;
    }
    if (!line.includes("Former Required decision:")) {
      failures.push(`release-open-checklist.md: resolved decision ${JSON.stringify(rule.label)} must preserve former Required decision`);
    }
  }
}

function checkActionableChecklistTracking() {
  for (const todo of actionableTodos()) {
    const rule = trackedDecisionFor(todo);
    if (!rule) {
      failures.push(
        `${todo.relPath}:${todo.lineNo}: actionable blocked TODO must be tracked by release-open-checklist.md Required Release Decisions`,
      );
    }
  }
}

function checkEventPlaceholderCoverage() {
  const eventDir = join(ROOT, "schema", "events");
  const expectedPayloadDescription =
    "Closed empty payload body for v1. Identity and correlation fields stay in the event envelope; adding body fields requires a versioned schema change.";
  const expectedCommonDescription =
    "Shared v1 event payload contract. Event bodies are closed empty objects; identity and correlation fields stay in the event envelope. Adding body fields requires a versioned schema change.";
  const perEventSchemas = readdirSync(eventDir)
    .filter((name) => name.endsWith(".schema.json") && name !== "common-empty-payload.schema.json")
    .sort();

  if (perEventSchemas.length === 0) {
    failures.push("schema/events: expected per-event placeholder schemas");
  }

  const commonSchema = JSON.parse(readFileSync(join(eventDir, "common-empty-payload.schema.json"), "utf8"));
  if (commonSchema.description !== expectedCommonDescription) {
    failures.push("schema/events/common-empty-payload.schema.json: common payload description must reflect the v1 closed-empty decision");
  }
  if (String(commonSchema.description).includes(BLOCKED_MARKER)) {
    failures.push("schema/events/common-empty-payload.schema.json: common payload description must not be blocked TODO language");
  }

  for (const name of perEventSchemas) {
    const relPath = `schema/events/${name}`;
    if (name.startsWith("worker.")) {
      failures.push(`${relPath}: worker telemetry must not be a tenant-scoped event payload schema`);
      continue;
    }
    const schema = JSON.parse(readFileSync(join(ROOT, relPath), "utf8"));
    if (schema.description !== expectedPayloadDescription) {
      failures.push(`${relPath}: payload description must reflect the v1 closed-empty decision`);
    }
    if (String(schema.description).includes(BLOCKED_MARKER)) {
      failures.push(`${relPath}: payload description must not be blocked TODO language`);
    }
    if (schema.additionalProperties !== false) {
      failures.push(`${relPath}: placeholder schema must remain closed`);
    }
    if (schema.properties !== undefined && Object.keys(schema.properties).length !== 0) {
      failures.push(`${relPath}: v1 payload body must not declare fields`);
    }
  }

  const envelope = readFileSync(join(ROOT, "schema/event-envelope.schema.json"), "utf8");
  if (envelope.includes(BLOCKED_MARKER)) {
    failures.push("schema/event-envelope.schema.json: event contract must not carry blocked decision TODO language after migration");
  }
  for (const workerEvent of ["worker.heartbeat", "worker.circuit_opened", "worker.circuit_closed"]) {
    if (envelope.includes(workerEvent)) {
      failures.push(`schema/event-envelope.schema.json: ${workerEvent} must not be a tenant-scoped event_type`);
    }
  }
  if (!envelope.includes("(tenant_id, run_id, step_id, attempt)")) {
    failures.push("schema/event-envelope.schema.json: missing canonical step reference decision text");
  }

  const registry = readFileSync(join(ROOT, "codegen/event-payload-registry.ts"), "utf8");
  for (const workerEvent of ["worker.heartbeat", "worker.circuit_opened", "worker.circuit_closed"]) {
    if (registry.includes(workerEvent) || registry.includes(`events/${workerEvent}@1`)) {
      failures.push(`codegen/event-payload-registry.ts: ${workerEvent} must not be registered as a tenant event payload`);
    }
  }

  const asyncApi = readFileSync(join(ROOT, "codegen/asyncapi.yaml"), "utf8");
  for (const workerEvent of ["worker.heartbeat", "worker.circuit_opened", "worker.circuit_closed"]) {
    if (asyncApi.includes(workerEvent) || asyncApi.includes(`events/${workerEvent}@1`)) {
      failures.push(`codegen/asyncapi.yaml: ${workerEvent} must not be listed as a tenant event channel or payload ref`);
    }
  }
  if (asyncApi.includes(BLOCKED_MARKER)) {
    failures.push("codegen/asyncapi.yaml: migrated event contract must not carry blocked TODO language");
  }
}

function collectFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (skippedDirs.has(entry)) continue;
    const abs = join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      files.push(...collectFiles(abs));
      continue;
    }
    if (stat.isFile() && scanExtensions.has(extname(entry))) {
      files.push(relative(ROOT, abs).replaceAll("\\", "/"));
    }
  }
  return files.sort();
}

function isInformational(relPath, line) {
  if (informationalFiles.has(relPath)) return true;
  if (relPath === "release-open-checklist.md" && !line.trim().startsWith(`- ${BLOCKED_MARKER}`)) return true;
  if (relPath.startsWith("schema/events/") && relPath.endsWith(".schema.json")) return true;
  if (relPath.endsWith(".fixtures.ts")) return true;
  if (relPath === "security-contracts.md" && line.includes("BYPASSRLS")) return true;
  if (line.includes(`includes("${BLOCKED_MARKER}`) || line.includes(`includes('${BLOCKED_MARKER}`)) return true;
  if (line.includes("blocked_decisions:")) return true;
  return false;
}

function actionableTodos() {
  return todos.filter((todo) => !isInformational(todo.relPath, todo.line));
}

function trackedDecisionFor(todo) {
  const text = `${todo.relPath}\n${todo.context}`.toLocaleLowerCase("en-US");
  for (const rule of releaseDecisionRules) {
    const trackedInChecklist = releaseDecisionLines.some((line) => line.includes(rule.label));
    if (!trackedInChecklist) continue;
    if (rule.aliases.some((alias) => text.includes(alias.toLocaleLowerCase("en-US")))) {
      return rule;
    }
  }
  return undefined;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
