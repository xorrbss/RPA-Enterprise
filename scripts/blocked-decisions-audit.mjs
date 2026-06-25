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
    aliases: [
      "Staging deploy target is not defined",
      "Deploy-time concrete staging deploy target",
      "Deploy-time staging SecretRef/SecretStore provisioning readiness",
      "staging secret provisioning",
      "SecretStore backend",
    ],
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
      "Worker job payloads for run_claim/run_resume/run_abort/workitem_checkout",
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

const activeBlockerRules = [
  {
    label: "Deploy-time concrete staging platform repo and deploy target identifier",
    aliases: [
      "Deploy-time concrete staging deploy target",
      "exact staging platform repo",
      "GitHub Environment `staging` protection",
      "concrete deploy target identifier",
      "release approval evidence",
      "rollback confirmation",
      "SecretRef/SecretStore provisioning path",
    ],
  },
  {
    label: "Deploy-time staging SecretRef/SecretStore provisioning readiness",
    aliases: [
      "Deploy-time staging SecretRef/SecretStore provisioning readiness",
      "SecretStore backend",
      "Vault mount/path",
      "cloud KMS/secret-manager alias",
      "SecretRef namespace convention",
      "runtime identities",
      "staging secret provisioning",
    ],
  },
  {
    label: "Deploy-time staging producer retention duration/source policy",
    aliases: [
      "Deploy-time staging producer retention duration/source policy",
      "raw_items.raw_payload",
      "normalized_records.record",
      "artifacts.object_ref",
      "audit_log.payload",
      "non-D4.3 writer",
      "producer retention duration/source",
    ],
  },
  {
    label: "Deploy-time D5 Codex SSE live capability evidence",
    aliases: [
      "Deploy-time D5 Codex SSE live capability evidence",
      "Codex SSE live capability evidence",
      "intended staging model/endpoint",
      "basic SSE",
      "prompt-schema safe path",
      "abort behavior PASS",
      "native `json_schema`",
      "model metadata",
      "absolute HTTPS `CODEX_BASE_URL`",
      "no credentials/query/fragment material",
      "CODEX_EVIDENCE_ENDPOINT_ALIAS",
      "CODEX_EVIDENCE_MODEL_ALIAS",
      "No plaintext API key",
    ],
  },
  {
    label: "D4.4 events_outbox retention source",
    aliases: [
      "D4.4 events_outbox retention source",
      "events_outbox retention",
      "events_outbox.retention_until",
      "repo-owned events_outbox",
      "emitOutboxEvent",
      "unknown retention boundary",
      "retention decision packet",
      "policy authority/source",
      "effective duration/scope",
      "calculation basis",
      "fail-closed runtime behavior",
      "app/runtime verification evidence",
    ],
  },
  {
    label: "D4.4 durable security audit writer boundary",
    aliases: [
      "D4.4 durable security audit writer boundary",
      "durable security audit writer",
      "security boundary decisions",
      "artifact read",
      "SecretStore resolve",
      "connector enable/install",
      "domain/prompt policy blocks",
      "BYPASSRLS use",
      "immutable audit append",
      "audit writer evidence",
    ],
  },
  {
    label: "PgRuntimeWorker handles `run_resume`",
    aliases: [
      "PgRuntimeWorker handles `run_resume`",
      "run_resume restore side-effect execution contract",
      "R17 restoreSession",
      "SessionRestorer",
      "ResumeCoordinator",
      "resume_token",
      "PageStateRef",
    ],
  },
  {
    label: "Runtime executor orchestration and audit semantics",
    aliases: [
      "Runtime executor orchestration and audit semantics",
      "Runtime executor orchestration",
      "executor audit semantics",
      "real executor orchestration",
      "real executor invocation",
      "StepResult",
      "StepStatus",
      "step.started",
      "system/security/challenge/unknown",
      "artifact redaction/retention jobs",
      "durable executor audit evidence",
      "durable audit evidence under RLS",
    ],
  },
  {
    label: "Runtime artifact_redaction production/staging object I/O and redacted-output implementation",
    aliases: [
      "Runtime artifact_redaction production/staging object I/O and redacted-output implementation",
      "Runtime artifact_redaction object I/O and redacted-output contract",
      "artifact_redaction object I/O",
      "redacted-output contract",
      "ArtifactStore/ArtifactRedactor",
      "SecretRef-backed ArtifactRedactor",
      "fakeable-port plumbing",
      "redaction-safe object/ref",
      "not_required decision",
      "redaction_attempts",
      "object-I/O",
      "artifact lifecycle fail-closed",
      "ArtifactRef/ObjectRef boundary",
      "artifacts.object_ref",
      "raw object locator",
      "raw object locators",
    ],
  },
  {
    label: "Runtime artifact_retention production/staging external object deletion implementation",
    aliases: [
      "Runtime artifact_retention production/staging external object deletion implementation",
      "Runtime artifact_retention external object deletion contract",
      "artifact_retention external object deletion",
      "ArtifactStore delete API",
      "SecretRef-backed ArtifactRetentionStore",
      "fakeable-port plumbing",
      "object_ref",
      "idempotent not-found",
      "when `deleted_at` may be set",
      "external artifact purge",
      "object-I/O",
      "artifact lifecycle fail-closed",
      "ArtifactRef/ObjectRef boundary",
      "artifacts.object_ref",
      "raw object locator",
      "raw object locators",
    ],
  },
  {
    label: "Runtime execution gates prove",
    aliases: [
      "Runtime execution gates prove",
      "tenant boundary",
      "RBAC/redaction",
      "no `BYPASSRLS`",
      "no silent false/unknown",
      "remote CI evidence",
    ],
  },
  {
    label: "Runtime-owned abort drain/finalization",
    aliases: [
      "Runtime-owned abort drain/finalization",
      "cancelable `suspending` abort responses",
      "bookmark-cancel ownership",
      "durable bookmark-cancel port",
      "durable abort intent",
      "abort drain/finalization",
      "sseClose",
      "browserDrain",
      "run.abort_timeout",
      "R23/R24 finalization",
      "no silent false/unknown",
    ],
  },
  {
    label: "Human-task `reassignAssignee` side-effect ownership",
    aliases: [
      "Human-task `reassignAssignee` side-effect ownership",
      "reassignAssignee",
      "manual escalate",
      "admin queue",
      "durable human-task routing port",
      "unknown reassignment side effect",
    ],
  },
  {
    label: "Browser RPA V2 HTTP/API connector authentication contract",
    aliases: [
      "HTTP api_call",
      "SecretRef bearer",
      "basic auth",
      "mTLS",
      "OAuth client credentials",
    ],
  },
  {
    label: "Browser RPA V2 webhook trigger authentication and idempotency contract",
    aliases: ["webhook trigger", "external authentication", "idempotency key"],
  },
  {
    label: "Browser RPA V2 IDP/OCR engine selection",
    aliases: ["IDP/OCR", "OCR engine", "LLM vision"],
  },
  {
    label: "Browser RPA V2 notification channel scope",
    aliases: ["Teams/Slack/email", "Teams", "Slack", "email notification"],
  },
  {
    label: "Browser RPA V2 CoE/ROI product scope",
    aliases: ["CoE/ROI", "ROI", "administrator evaluation screen"],
  },
  {
    label: "Browser RPA V2 business form schema contract",
    aliases: ["업무별 form schema", "business form schema"],
  },
  {
    label: "Run trigger file/queue event contract",
    aliases: [
      "file-arrival and queue-trigger contracts",
      "file-arrival",
      "queue-trigger",
      "file arrival",
    ],
  },
  {
    label: "Run trigger cron catchup and concurrency semantics",
    aliases: [
      "catchup policy",
      "next occurrence calculation",
      "missed-run catchup",
      "concurrent fire semantics",
    ],
  },
  {
    label: "Enterprise ALM/RBAC SCIM synchronization contract",
    aliases: [
      "SCIM 동기화",
      "SCIM provider",
      "inbound schema",
      "conflict rule",
      "source='scim'",
      "role-mapping source of truth",
    ],
  },
];
const activeBlockerSectionHeadings = new Set([
  "## Deploy-Time Provisioning Blockers",
  "## Repo-Controlled D4.5 API P1 Evidence / Open",
  "## Repo-Controlled D3 Runtime Execution Readiness (Local Dirty Evidence / Open)",
  "## Repo-Controlled Browser RPA V2 Product Scope / Open",
  "## Repo-Controlled Enterprise ALM/RBAC Product Scope / Open",
]);
const expectedActiveBlockerSectionCounts = new Map([
  ["## Deploy-Time Provisioning Blockers", 1],
  ["## Repo-Controlled D4.5 API P1 Evidence / Open", 0],
  ["## Repo-Controlled D3 Runtime Execution Readiness (Local Dirty Evidence / Open)", 0],
  ["## Repo-Controlled Browser RPA V2 Product Scope / Open", 0],
  ["## Repo-Controlled Enterprise ALM/RBAC Product Scope / Open", 1],
]);
const activeChecklistEvidenceRules = [
  {
    checklistText: "Deploy-time concrete staging platform repo and deploy target identifier",
    todoLineAliases: [
      "exact staging platform repo",
      "GitHub Environment `staging` protection/approver configuration",
      "concrete deploy target identifier",
      "release approval evidence",
      "rollback confirmation",
      "SecretRef/SecretStore provisioning path",
    ],
  },
  {
    checklistText: "Deploy-time staging SecretRef/SecretStore provisioning readiness - SecretStore backend alias/path",
    todoLineAliases: ["evidence is missing the SecretStore backend alias/path"],
  },
  {
    checklistText: "Deploy-time staging SecretRef/SecretStore provisioning readiness - SecretRef namespace convention",
    todoLineAliases: ["evidence is missing the SecretRef namespace convention and runtime identity map"],
  },
  {
    checklistText: "Deploy-time staging SecretRef/SecretStore provisioning readiness - initial SecretRef inventory",
    todoLineAliases: ["evidence is missing the initial SecretRef inventory"],
  },
  {
    checklistText: "Deploy-time staging SecretRef/SecretStore provisioning readiness - rotation owner/cadence",
    todoLineAliases: ["evidence is missing rotation and break-glass ownership"],
  },
  {
    checklistText: "Deploy-time staging SecretRef/SecretStore provisioning readiness - provisioning evidence artifact location",
    todoLineAliases: [
      "evidence is missing CI/deploy negative-log",
      "secret-scan or equivalent negative control",
      "SecretStore resolution proof",
    ],
  },
  {
    checklistText: "Deploy-time D5 Codex SSE live capability evidence",
    todoLineAliases: [
      "absolute HTTPS `CODEX_BASE_URL`",
      "no credentials/query/fragment material",
      "CODEX_EVIDENCE_ENDPOINT_ALIAS",
      "CODEX_EVIDENCE_MODEL_ALIAS",
      "No plaintext API key",
    ],
  },
  {
    checklistText: "D4.4 events_outbox retention source - policy authority/source",
    todoLineAliases: ["retention source is missing the policy authority/source"],
  },
  {
    checklistText: "D4.4 events_outbox retention source - effective duration/scope",
    todoLineAliases: ["retention source is missing the effective duration/scope"],
  },
  {
    checklistText: "D4.4 events_outbox retention source - calculation basis",
    todoLineAliases: ["retention source is missing the calculation basis"],
  },
  {
    checklistText: "D4.4 events_outbox retention source - fail-closed behavior",
    todoLineAliases: ["retention source is missing the fail-closed runtime behavior"],
  },
  {
    checklistText: "D4.4 events_outbox retention source - app/runtime evidence",
    todoLineAliases: ["retention source is missing app/runtime verification evidence"],
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
  "autonomous-loop-prompt.md",
  "build-prompt.md",
  "finish-loop-prompt.md",
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
let activeChecklistLines = [];
let activeBlockerChecklistItems = [];
let activeBlockerSectionCounts = new Map();
let releaseChecklistText = "";

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

const actionable = actionableTodos().length;
const auditOutput = buildAuditOutput(actionable);
checkReportedAuditOutputs(auditOutput);

if (failures.length > 0) {
  console.error(`blocked decision audit: ${failures.length} failed`);
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}

console.log(`blocked decision audit: ${auditOutput}`);

function checkReleaseChecklist() {
  const checklist = readFileSync(join(ROOT, "release-open-checklist.md"), "utf8");
  releaseChecklistText = checklist;
  const checklistLines = checklist.split(/\r?\n/);
  const allUncheckedChecklistItems = checklistLines
    .map((line, index) => ({ line, lineNo: index + 1 }))
    .filter((item) => item.line.trim().startsWith("- [ ]"));
  activeChecklistLines = allUncheckedChecklistItems.map((item) => item.line);
  activeBlockerChecklistItems = [];
  activeBlockerSectionCounts = new Map();
  let inActiveBlockerSection = false;
  let activeBlockerSectionHeading = "";
  for (const [index, line] of checklistLines.entries()) {
    if (line.startsWith("## ")) {
      activeBlockerSectionHeading = line.trim();
      inActiveBlockerSection = activeBlockerSectionHeadings.has(activeBlockerSectionHeading);
    }
    if (inActiveBlockerSection && line.trim().startsWith("- [ ]")) {
      activeBlockerChecklistItems.push({ line, lineNo: index + 1 });
      activeBlockerSectionCounts.set(
        activeBlockerSectionHeading,
        (activeBlockerSectionCounts.get(activeBlockerSectionHeading) ?? 0) + 1,
      );
    }
  }
  if (allUncheckedChecklistItems.length !== activeBlockerChecklistItems.length) {
    const activeLineNos = new Set(activeBlockerChecklistItems.map((item) => item.lineNo));
    for (const item of allUncheckedChecklistItems) {
      if (!activeLineNos.has(item.lineNo)) {
        failures.push(
          `release-open-checklist.md:${item.lineNo}: unchecked checklist row must live under a configured active blocker section`,
        );
      }
    }
  }
  for (const [heading, expected] of expectedActiveBlockerSectionCounts) {
    const actual = activeBlockerSectionCounts.get(heading) ?? 0;
    if (actual !== expected) {
      failures.push(`release-open-checklist.md: expected ${expected} active blockers in ${heading}, found ${actual}`);
    }
  }
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
  const actionable = actionableTodos();
  for (const todo of actionableTodos()) {
    const rule = trackedActiveBlockerFor(todo);
    if (!rule) {
      failures.push(
        `${todo.relPath}:${todo.lineNo}: actionable blocked TODO must be tracked by an active unchecked blocker in release-open-checklist.md`,
      );
    }
  }

  for (const item of activeBlockerChecklistItems) {
    const rule = activeBlockerRules.find((candidate) => item.line.includes(candidate.label));
    if (!rule) {
      failures.push(
        `release-open-checklist.md:${item.lineNo}: active unchecked blocker must match a configured active blocker label`,
      );
      continue;
    }
    if (!actionable.some((todo) => todoMatchesActiveBlockerRule(todo, rule))) {
      failures.push(
        `release-open-checklist.md:${item.lineNo}: active unchecked blocker must have matching actionable TODO: [BLOCKED] with Required decision in product-open-candidate-report.md or code`,
      );
    }
    const evidenceRule = activeChecklistEvidenceRules.find((candidate) => item.line.includes(candidate.checklistText));
    if (evidenceRule && !actionable.some((todo) => todoLineMatchesEvidenceRule(todo, evidenceRule))) {
      failures.push(
        `release-open-checklist.md:${item.lineNo}: active evidence blocker must have a matching specific evidence-packet TODO line`,
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

function trackedActiveBlockerFor(todo) {
  for (const rule of activeBlockerRules) {
    const trackedInChecklist = activeChecklistLines.some((line) => line.includes(rule.label));
    if (!trackedInChecklist) continue;
    if (todoMatchesActiveBlockerRule(todo, rule)) {
      return rule;
    }
  }
  return undefined;
}

function todoMatchesActiveBlockerRule(todo, rule) {
  const text = `${todo.relPath}\n${todo.context}`.toLocaleLowerCase("en-US");
  return rule.aliases.some((alias) => text.includes(alias.toLocaleLowerCase("en-US")));
}

function todoLineMatchesEvidenceRule(todo, rule) {
  const text = `${todo.line}\n${todo.context}`.toLocaleLowerCase("en-US");
  return rule.todoLineAliases.every((alias) => text.includes(alias.toLocaleLowerCase("en-US")));
}

function buildAuditOutput(actionable) {
  const externalCount = activeBlockerSectionCounts.get("## Deploy-Time Provisioning Blockers") ?? 0;
  const repoD45Count =
    activeBlockerSectionCounts.get("## Repo-Controlled D4.5 API P1 Evidence / Open") ?? 0;
  const repoD3Count =
    activeBlockerSectionCounts.get("## Repo-Controlled D3 Runtime Execution Readiness (Local Dirty Evidence / Open)") ?? 0;
  const browserRpaV2Count =
    activeBlockerSectionCounts.get("## Repo-Controlled Browser RPA V2 Product Scope / Open") ?? 0;
  const enterpriseAlmRbacCount =
    activeBlockerSectionCounts.get("## Repo-Controlled Enterprise ALM/RBAC Product Scope / Open") ?? 0;
  return `${todos.length} markers, ${actionable} actionable blockers, ${knownReleaseDecisions.length} known release decisions tracked, ${releaseDecisionLines.length} release decisions checked (${externalCount} active deploy-time provisioning checklist rows; ${repoD45Count} repo-controlled D4.5 API P1 open rows; ${repoD3Count} repo-controlled D3 runtime open rows; ${browserRpaV2Count} repo-controlled Browser RPA V2 product-scope open rows; ${enterpriseAlmRbacCount} repo-controlled Enterprise ALM/RBAC product-scope open rows)`;
}

function checkReportedAuditOutputs(auditOutput) {
  const expected = normalizeForAuditOutput(auditOutput);
  const files = [
    ["release-open-checklist.md", releaseChecklistText],
    ["product-open-candidate-report.md", readFileSync(join(ROOT, "product-open-candidate-report.md"), "utf8")],
  ];
  for (const [relPath, text] of files) {
    if (!normalizeForAuditOutput(text).includes(expected)) {
      failures.push(`${relPath}: Current local blocked:audit output must match computed output: ${auditOutput}`);
    }
  }
}

function normalizeForAuditOutput(value) {
  return value.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
