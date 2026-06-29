#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const args = process.argv.slice(2);
const REQUIRED_FIELDS = [
  "readiness snapshot",
  "external alert delivery evidence",
  "managed backup restore evidence",
  "slo on-call signoff evidence",
  "support training completion evidence",
  "observability telemetry evidence",
  "prod release gate evidence",
  "negative control proof",
];

const FORBIDDEN_PATTERNS = [
  ["private key block", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i],
  ["plaintext AppRole role_id", /\brole_id\s*[:=]\s*[^,\s)]+/i],
  ["plaintext AppRole secret_id", /\bsecret_id\s*[:=]\s*[^,\s)]+/i],
  ["Vault token", /\bhv[bs]\.[A-Za-z0-9_-]{8,}\b/i],
  ["cloud access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ["OpenAI key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ["plaintext secret assignment", /\b(?:secret|token|password|credential|authorization|webhook_secret|endpoint_secret)\s*[:=]\s*[^,\s)]+/i],
  ["endpoint/url alias assignment", /\b(?:endpoint_url|webhook_url|dashboard_url|dsn|url)\s*[:=]\s*[^,\s)]+/i],
  ["internal ObjectRef", /\bObjectRef\b|(?:file|s3):\/\/[^\s)]+/i],
  ["test/fake evidence", /\b(?:test_fake|fake_provider|fake_sender|fake_port)\b/i],
  ["raw roster/user list", /\b(?:raw_roster(?:_rows)?|training_roster|roster_rows|participant_list|user_list|raw_user_list|trainee_list)\s*[:=]\s*[^,\s)]+/i],
  ["raw training document/url", /\b(?:training_document(?:_body)?|raw_training_document|training_doc(?:ument)?|training_url|training_document_url|document_url)\s*[:=]\s*[^,\s)]+/i],
  ["raw IP address", /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
];

const PASS = new Set(["pass"]);
const VALID = new Set(["valid"]);
const ALERT_CHANNELS = new Set(["teams", "slack", "email", "webhook"]);

main();

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
      console.error(`controlled-prod readiness packet validator: ${result.failures.length} failed`);
      for (const failure of result.failures) console.error(`FAIL: ${failure}`);
      process.exit(1);
    }
    console.log(`controlled-prod readiness packet validator: PASS ${file === "-" ? "stdin" : basename(file)}`);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`controlled-prod readiness packet validator: ${message}`);
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
    return { ok: false, failures: [`${source}: missing [CONTROLLED-PROD READINESS PACKET -- redacted] block`] };
  }

  scanForbidden(packet, failures);
  scanUrls(packet, failures);

  const fields = parseFields(packet, failures);
  for (const field of REQUIRED_FIELDS) {
    if (!fields.has(field)) failures.push(`missing required field: ${field}`);
  }

  for (const [field, value] of fields.entries()) {
    if (value.trim().length === 0) failures.push(`${field}: blank value`);
    if (/<[^>]+>/.test(value)) failures.push(`${field}: unresolved angle-bracket placeholder`);
  }

  validateReadinessSnapshot(fields, failures);
  validateExternalAlertEvidence(fields, failures);
  validateManagedBackupEvidence(fields, failures);
  validateSloOncallEvidence(fields, failures);
  validateSupportTrainingEvidence(fields, failures);
  validateObservabilityEvidence(fields, failures);
  validateProdReleaseGate(fields, failures);
  validateNegativeControl(fields, failures);

  return { ok: failures.length === 0, failures };
}

function extractPacket(text) {
  const lines = text.split(/\r?\n/);
  const starts = lines
    .map((line, index) => (/^\[CONTROLLED-PROD READINESS PACKET\b/i.test(line.trim()) ? index : -1))
    .filter((index) => index >= 0);
  if (starts.length === 0) return undefined;
  const candidates = [];
  for (const start of starts) {
    candidates.push(collectPacketFrom(lines, start));
  }
  return candidates.find((candidate) => /(^|\n)-\s+readiness snapshot\s+:/i.test(candidate)) ?? candidates[0];
}

function collectPacketFrom(lines, start) {
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

function validateReadinessSnapshot(fields, failures) {
  const field = "readiness snapshot";
  const value = fields.get(field);
  if (value === undefined) return;
  requireContains(value, failures, field, [
    "GET /v1/ops/production-readiness",
    "evidence=production_readiness_evidence",
  ]);
  const status = requirePacketValue(value, field, "status", failures);
  if (status !== null && status !== "ready") failures.push(`${field}: status must be ready`);
  const ready = requirePacketValue(value, field, "controlled_prod_ready", failures);
  if (ready !== null && ready !== "true") failures.push(`${field}: controlled_prod_ready must be true`);
  const blockerCount = requireNonNegativeIntegerPacketValue(value, field, "blocker_count", failures);
  const warningCount = requireNonNegativeIntegerPacketValue(value, field, "warning_count", failures);
  const deferredCount = requireNonNegativeIntegerPacketValue(value, field, "deferred_count", failures);
  if (blockerCount !== null && blockerCount !== 0) failures.push(`${field}: blocker_count must be 0`);
  if (warningCount !== null && warningCount !== 0) failures.push(`${field}: warning_count must be 0`);
  if (deferredCount !== null && deferredCount !== 0) failures.push(`${field}: deferred_count must be 0`);
  requireEnumPacketValue(value, field, "external_alert_delivery", PASS, failures);
  requireEnumPacketValue(value, field, "managed_backup_restore_drill", PASS, failures);
  requireEnumPacketValue(value, field, "slo_oncall_signoff", PASS, failures);
  requireEnumPacketValue(value, field, "support_training_completion", PASS, failures);
  requireEnumPacketValue(value, field, "observability_telemetry_wiring", PASS, failures);
}

function validateExternalAlertEvidence(fields, failures) {
  const field = "external alert delivery evidence";
  const value = fields.get(field);
  if (value === undefined) return;
  requireContains(value, failures, field, [
    "POST /v1/ops/production-readiness/evidence",
    "evidence_type=external_alert_delivery",
    "metadata.delivery_status=delivered",
    "no endpoint_url/token/webhook_secret",
  ]);
  requireEnumPacketValue(value, field, "status", VALID, failures);
  requirePacketValue(value, field, "evidence_ref", failures);
  requireDateOrAliasPacketValue(value, field, "expires_at", failures);
  requireEnumPacketValue(value, field, "metadata.channel", ALERT_CHANNELS, failures);
  requirePacketValue(value, field, "metadata.provider_alias", failures);
  requirePacketValue(value, field, "metadata.receipt_id", failures);
  requireDateOrAliasPacketValue(value, field, "metadata.receipt_at", failures);
}

function validateManagedBackupEvidence(fields, failures) {
  const field = "managed backup restore evidence";
  const value = fields.get(field);
  if (value === undefined) return;
  requireContains(value, failures, field, [
    "POST /v1/ops/production-readiness/evidence",
    "evidence_type=managed_backup_restore_drill",
    "no dsn/url/credential",
  ]);
  requireEnumPacketValue(value, field, "status", VALID, failures);
  requirePacketValue(value, field, "evidence_ref", failures);
  requireDateOrAliasPacketValue(value, field, "expires_at", failures);
  requirePacketValue(value, field, "metadata.backup_policy_ref", failures);
  requirePacketValue(value, field, "metadata.restore_scope", failures);
  requireDateOrAliasPacketValue(value, field, "metadata.restore_completed_at", failures);
  requireMaxIntegerPacketValue(value, field, "metadata.rto_minutes", 120, failures);
  requireMaxIntegerPacketValue(value, field, "metadata.rpo_minutes", 15, failures);
}

function validateSloOncallEvidence(fields, failures) {
  const field = "slo on-call signoff evidence";
  const value = fields.get(field);
  if (value === undefined) return;
  requireContains(value, failures, field, [
    "POST /v1/ops/production-readiness/evidence",
    "evidence_type=slo_oncall_signoff",
    "no dashboard_url/token/secret",
  ]);
  requireEnumPacketValue(value, field, "status", VALID, failures);
  requirePacketValue(value, field, "evidence_ref", failures);
  requireDateOrAliasPacketValue(value, field, "expires_at", failures);
  for (const key of ["metadata.slo_dashboard", "metadata.severity_model", "metadata.oncall_rota", "metadata.raci_ref", "metadata.support_hours"]) {
    requirePacketValue(value, field, key, failures);
  }
}

function validateSupportTrainingEvidence(fields, failures) {
  const field = "support training completion evidence";
  const value = fields.get(field);
  if (value === undefined) return;
  requireContains(value, failures, field, [
    "POST /v1/ops/production-readiness/evidence",
    "evidence_type=support_training_completion",
    "no raw_roster/user_list/training_document/url/token/secret",
  ]);
  requireEnumPacketValue(value, field, "status", VALID, failures);
  requirePacketValue(value, field, "evidence_ref", failures);
  requireDateOrAliasPacketValue(value, field, "expires_at", failures);
  requirePacketValue(value, field, "metadata.support_model_ref", failures);
  requirePacketValue(value, field, "metadata.training_completion_ref", failures);
  requirePositiveIntegerPacketValue(value, field, "metadata.trained_role_count", failures);
  requirePositiveIntegerPacketValue(value, field, "metadata.trained_user_count", failures);
  requirePercentPacketValue(value, field, "metadata.coverage_percent", failures);
  requireDateOrAliasPacketValue(value, field, "metadata.completed_at", failures);
}

function validateObservabilityEvidence(fields, failures) {
  const field = "observability telemetry evidence";
  const value = fields.get(field);
  if (value === undefined) return;
  requireContains(value, failures, field, [
    "POST /v1/ops/production-readiness/evidence",
    "evidence_type=observability_telemetry_wiring",
    "no collector_url/dashboard_url/token/secret",
  ]);
  requireEnumPacketValue(value, field, "status", VALID, failures);
  requirePacketValue(value, field, "evidence_ref", failures);
  requireDateOrAliasPacketValue(value, field, "expires_at", failures);
  requireEnumPacketValue(value, field, "metadata.exporter", new Set(["prometheus", "otlp"]), failures);
  requirePacketValue(value, field, "metadata.collector_ref", failures);
  requirePacketValue(value, field, "metadata.dashboard_ref", failures);
  requirePacketValue(value, field, "metadata.alert_route_ref", failures);
  requireDateOrAliasPacketValue(value, field, "metadata.sampled_at", failures);
}

function validateProdReleaseGate(fields, failures) {
  const field = "prod release gate evidence";
  const value = fields.get(field);
  if (value === undefined) return;
  requireContains(value, failures, field, [
    "target_environment=prod",
    "require summary.controlled_prod_ready=true",
    "approve_deploy=blocked_unless_ready",
    "rollback_not_blocked_by_readiness",
    "evidence=scenario_releases",
  ]);
}

function validateNegativeControl(fields, failures) {
  const field = "negative control proof";
  const value = fields.get(field);
  if (value === undefined) return;
  requireContains(value, failures, field, [
    "secret-scan",
    "endpoint URLs",
    "webhook URLs",
    "tokens",
    "secrets",
    "raw URLs",
    "raw rosters",
    "user lists",
    "training documents",
    "env dump",
    "xtrace",
    "resolved SecretRef material",
  ]);
}

function scanForbidden(packet, failures) {
  for (const [label, pattern] of FORBIDDEN_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(packet)) failures.push(`forbidden ${label} in packet`);
  }
}

function scanUrls(packet, failures) {
  for (const match of packet.matchAll(/\bhttps?:\/\/[^\s)]+/g)) {
    failures.push(`raw URL is not allowed in controlled-prod readiness packet: ${match[0]}`);
  }
}

function requireContains(value, failures, field, needles) {
  for (const needle of needles) {
    if (!value.includes(needle)) failures.push(`${field}: missing ${JSON.stringify(needle)}`);
  }
}

function requireNonNegativeIntegerPacketValue(value, field, key, failures) {
  const raw = requirePacketValue(value, field, key, failures);
  if (raw === null) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    failures.push(`${field}: ${key} must be a non-negative integer`);
    return null;
  }
  return Number(raw);
}

function requireMaxIntegerPacketValue(value, field, key, max, failures) {
  const raw = requirePacketValue(value, field, key, failures);
  if (raw === null) return null;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    failures.push(`${field}: ${key} must be a positive integer`);
    return null;
  }
  const parsed = Number(raw);
  if (parsed > max) failures.push(`${field}: ${key} must be <= ${max}`);
  return parsed;
}

function requirePositiveIntegerPacketValue(value, field, key, failures) {
  const raw = requirePacketValue(value, field, key, failures);
  if (raw === null) return null;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    failures.push(`${field}: ${key} must be a positive integer`);
    return null;
  }
  return Number(raw);
}

function requirePercentPacketValue(value, field, key, failures) {
  const raw = requirePacketValue(value, field, key, failures);
  if (raw === null) return null;
  if (!/^(?:100(?:\.0+)?|[0-9]{1,2}(?:\.[0-9]+)?)$/.test(raw)) {
    failures.push(`${field}: ${key} must be a number from 0 through 100`);
    return null;
  }
  return Number(raw);
}

function requireEnumPacketValue(value, field, key, allowed, failures) {
  const raw = requirePacketValue(value, field, key, failures);
  if (raw === null) return null;
  if (!allowed.has(raw)) failures.push(`${field}: ${key} must be one of ${Array.from(allowed).join("|")}`);
  return raw;
}

function requireDateOrAliasPacketValue(value, field, key, failures) {
  const raw = requirePacketValue(value, field, key, failures);
  if (raw === null) return null;
  if (/^\[[A-Za-z0-9._-]+\]$/.test(raw)) return raw;
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) failures.push(`${field}: ${key} must be an ISO datetime or bracket alias`);
  return raw;
}

function requirePacketValue(value, field, key, failures) {
  const raw = packetValue(value, key);
  if (raw === null) failures.push(`${field}: missing ${key}= value`);
  return raw;
}

function packetValue(value, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[\\s;,])${escaped}=([^\\s;,]+)`).exec(value);
  return match?.[1] ?? null;
}

function runSelfTest() {
  const valid = [
    "[CONTROLLED-PROD READINESS PACKET -- redacted]",
    "- readiness snapshot : GET /v1/ops/production-readiness; status=ready; controlled_prod_ready=true; blocker_count=0; warning_count=0; deferred_count=0; external_alert_delivery=pass; managed_backup_restore_drill=pass; slo_oncall_signoff=pass; support_training_completion=pass; observability_telemetry_wiring=pass; evidence=production_readiness_evidence [prod-readiness-1]",
    "- external alert delivery evidence : POST /v1/ops/production-readiness/evidence; evidence_type=external_alert_delivery; status=valid; evidence_ref=[external-alert-delivery-1]; expires_at=[external-alert-expiry-1]; metadata.channel=webhook; metadata.provider_alias=[provider-alias-1]; metadata.receipt_id=[receipt-id-1]; metadata.receipt_at=[receipt-at-1]; metadata.delivery_status=delivered; no endpoint_url/token/webhook_secret",
    "- managed backup restore evidence : POST /v1/ops/production-readiness/evidence; evidence_type=managed_backup_restore_drill; status=valid; evidence_ref=[managed-backup-drill-1]; expires_at=[backup-expiry-1]; metadata.backup_policy_ref=[backup-policy-1]; metadata.restore_scope=[restore-scope-1]; metadata.restore_completed_at=[restore-at-1]; metadata.rto_minutes=45; metadata.rpo_minutes=5; no dsn/url/credential",
    "- slo on-call signoff evidence : POST /v1/ops/production-readiness/evidence; evidence_type=slo_oncall_signoff; status=valid; evidence_ref=[slo-oncall-1]; expires_at=[slo-expiry-1]; metadata.slo_dashboard=[slo-dashboard-1]; metadata.severity_model=sev1-sev4; metadata.oncall_rota=[oncall-rota-1]; metadata.raci_ref=[raci-1]; metadata.support_hours=24x7; no dashboard_url/token/secret",
    "- support training completion evidence : POST /v1/ops/production-readiness/evidence; evidence_type=support_training_completion; status=valid; evidence_ref=[support-training-1]; expires_at=[support-training-expiry-1]; metadata.support_model_ref=[support-model-1]; metadata.training_completion_ref=[training-completion-1]; metadata.trained_role_count=4; metadata.trained_user_count=12; metadata.coverage_percent=100; metadata.completed_at=[training-completed-at-1]; no raw_roster/user_list/training_document/url/token/secret",
    "- observability telemetry evidence : POST /v1/ops/production-readiness/evidence; evidence_type=observability_telemetry_wiring; status=valid; evidence_ref=[observability-1]; expires_at=[observability-expiry-1]; metadata.exporter=otlp; metadata.collector_ref=[otel-collector-1]; metadata.dashboard_ref=[slo-dashboard-1]; metadata.alert_route_ref=[alert-route-1]; metadata.sampled_at=[observability-sampled-at-1]; no collector_url/dashboard_url/token/secret",
    "- prod release gate evidence : target_environment=prod; require summary.controlled_prod_ready=true; approve_deploy=blocked_unless_ready; rollback_not_blocked_by_readiness; evidence=scenario_releases [prod-release-gate-1]",
    "- negative control proof : secret-scan rejects endpoint URLs, webhook URLs, raw URLs, tokens, secrets, raw rosters, user lists, training documents, env dump, xtrace, and resolved SecretRef material; evidence=[prod-negative-control-1]",
  ].join("\n");

  const cases = [
    ["valid packet", valid, true],
    ["missing field", valid.replace(/^- managed backup restore evidence.*\n/m, ""), false],
    ["missing support training field", valid.replace(/^- support training completion evidence.*\n/m, ""), false],
    ["missing observability field", valid.replace(/^- observability telemetry evidence.*\n/m, ""), false],
    ["not ready", valid.replace("controlled_prod_ready=true", "controlled_prod_ready=false"), false],
    ["warning status", valid.replace("status=ready", "status=warning"), false],
    ["warning count", valid.replace("warning_count=0", "warning_count=1"), false],
    ["deferred gate", valid.replace("external_alert_delivery=pass", "external_alert_delivery=deferred"), false],
    ["deferred support training gate", valid.replace("support_training_completion=pass", "support_training_completion=deferred"), false],
    ["invalid external evidence status", valid.replace("evidence_type=external_alert_delivery; status=valid", "evidence_type=external_alert_delivery; status=failed"), false],
    ["missing delivered metadata", valid.replace("metadata.delivery_status=delivered", "metadata.delivery_status=sent"), false],
    ["backup rto missed", valid.replace("metadata.rto_minutes=45", "metadata.rto_minutes=121"), false],
    ["backup rpo missed", valid.replace("metadata.rpo_minutes=5", "metadata.rpo_minutes=16"), false],
    ["missing slo rota", valid.replace("metadata.oncall_rota=[oncall-rota-1]; ", ""), false],
    ["missing support training completion ref", valid.replace("metadata.training_completion_ref=[training-completion-1]; ", ""), false],
    ["invalid support training coverage", valid.replace("metadata.coverage_percent=100", "metadata.coverage_percent=101"), false],
    ["missing observability alert route", valid.replace("metadata.alert_route_ref=[alert-route-1]; ", ""), false],
    ["invalid observability exporter", valid.replace("metadata.exporter=otlp", "metadata.exporter=console"), false],
    ["url leak", valid.replace("[slo-dashboard-1]", "https://grafana.example.com/d/rpa"), false],
    ["test fake leak", valid.replace("[receipt-id-1]", "test_fake"), false],
    ["token leak", `${valid}\ntoken=plain`, false],
    ["endpoint url alias leak", valid.replace("metadata.delivery_status=delivered", "metadata.delivery_status=delivered; endpoint_url=[hidden-endpoint-1]"), false],
    ["raw roster leak", `${valid}\nraw_roster_rows=alice,bob`, false],
    ["training document url leak", `${valid}\ntraining_document_url=[training-doc-1]`, false],
  ];

  const failures = [];
  for (const [label, text, expected] of cases) {
    const actual = validatePacket(text, label).ok;
    if (actual !== expected) failures.push(`${label}: expected ${expected ? "PASS" : "FAIL"}, got ${actual ? "PASS" : "FAIL"}`);
  }

  if (failures.length > 0) {
    console.error(`controlled-prod readiness packet validator self-test: ${failures.length} failed`);
    for (const failure of failures) console.error(`FAIL: ${failure}`);
    process.exit(1);
  }
  console.log("controlled-prod readiness packet validator self-test: fixtures passed");
}

function printUsage() {
  console.log([
    "Usage: node scripts/validate-controlled-prod-readiness-packet.mjs [--file packet.md|-]",
    "       node scripts/validate-controlled-prod-readiness-packet.mjs --self-test",
    "",
    "Validates the redacted controlled-production readiness packet shape without resolving or printing secrets.",
  ].join("\n"));
}
