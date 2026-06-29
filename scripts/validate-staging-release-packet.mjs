#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const args = process.argv.slice(2);
const REQUIRED_FIELDS = [
  "staging platform repo",
  "concrete deploy target",
  "GitHub Environment `staging`",
  "release approval reference",
  "rollback confirmation",
  "SecretStore alias/path",
  "namespace / identity map",
  "SecretRef inventory",
  "runtime artifact object-store env",
  "artifact store topology preflight",
  "retention policy",
  "controlled-prod readiness snapshot",
  "external alert delivery evidence",
  "ops webhook sender evidence",
  "live D5 evidence",
  "secret.resolve audit sample",
  "negative control proof",
];

const FORBIDDEN_PATTERNS = [
  ["private key block", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i],
  ["plaintext AppRole role_id", /\brole_id\s*[:=]\s*[^,\s)]+/i],
  ["plaintext AppRole secret_id", /\bsecret_id\s*[:=]\s*[^,\s)]+/i],
  ["Vault token", /\bhv[bs]\.[A-Za-z0-9_-]{8,}\b/i],
  ["S3 secret access key", /\b(?:S3_)?SECRET_ACCESS_KEY\s*[:=]\s*[^,\s)]+/i],
  ["AWS access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ["OpenAI key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ["internal ObjectRef", /\bObjectRef\b|(?:file|s3):\/\/[^\s)]+/i],
  ["raw model identifier", /\b(?:gpt|claude|gemini)-[A-Za-z0-9._-]+\b/i],
  ["raw roster/user list", /\b(?:raw_roster(?:_rows)?|training_roster|roster_rows|participant_list|user_list|raw_user_list|trainee_list)\s*[:=]\s*[^,\s)]+/i],
  ["raw training document/url", /\b(?:training_document(?:_body)?|raw_training_document|training_doc(?:ument)?|training_url|training_document_url|document_url)\s*[:=]\s*[^,\s)]+/i],
];

const READINESS_GATE_STATUSES = new Set(["pass", "warning", "blocked", "deferred"]);
const EXTERNAL_EVIDENCE_PACKET_STATUSES = new Set(["valid", "failed", "deferred", "blocked"]);
const OPS_WEBHOOK_EVIDENCE_STATUSES = new Set(["pending", "sending", "sent", "failed", "dead_letter", "delivered", "deferred"]);
const EXTERNAL_ALERT_CHANNELS = new Set(["teams", "slack", "email", "webhook"]);

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
      console.error(`staging release packet validator: ${result.failures.length} failed`);
      for (const failure of result.failures) console.error(`FAIL: ${failure}`);
      process.exit(1);
    }
    console.log(`staging release packet validator: PASS ${file === "-" ? "stdin" : basename(file)}`);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`staging release packet validator: ${message}`);
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
    return { ok: false, failures: [`${source}: missing [STAGING RELEASE PACKET -- redacted] block`] };
  }

  scanForbidden(packet, failures);
  scanUrls(packet, failures);

  const fields = parseFields(packet, failures);
  for (const field of REQUIRED_FIELDS) {
    if (!fields.has(field)) failures.push(`missing required field: ${field}`);
  }

  for (const [field, value] of fields.entries()) {
    if (value.trim().length === 0) failures.push(`${field}: blank value`);
    if (hasUnfilledPlaceholder(field, value)) failures.push(`${field}: unresolved template placeholder`);
  }

  requireContains(fields, failures, "GitHub Environment `staging`", ["protection=", "required reviewer=", "branch policy="]);
  requireContains(fields, failures, "rollback confirmation", ["forward-only", "owner=#13"]);
  requireContains(fields, failures, "SecretStore alias/path", ["Vault", "KV v2", "secret/", "secret/data/rpa/staging"]);
  requireContains(fields, failures, "namespace / identity map", ["D8-A12"]);
  requireContains(fields, failures, "SecretRef inventory", ["D8-A12"]);
  requireContains(fields, failures, "runtime artifact object-store env", [
    "GATEWAY_ARTIFACT_STORE_MODE=s3",
    "GATEWAY_ARTIFACT_OBJECT_STORE_REF=",
    "ARTIFACT_OBJECT_STORE_REF=",
  ]);
  requireContains(fields, failures, "artifact store topology preflight", [
    "npm --prefix app run preflight:artifact-store -- --topology split-worker-lifecycle",
    "PASS",
  ]);
  requireContains(fields, failures, "retention policy", ["D8-A11", "D8-A14"]);
  requireContains(fields, failures, "controlled-prod readiness snapshot", [
    "GET /v1/ops/production-readiness",
    "controlled_prod_ready=",
    "blocker_count=",
    "deferred_count=",
    "evidence=production_readiness_evidence",
    "external_alert_delivery=",
    "support_training_completion=",
    "observability_telemetry_wiring=",
  ]);
  requireContains(fields, failures, "external alert delivery evidence", [
    "evidence_type=external_alert_delivery",
    "status=",
    "metadata.channel=",
    "metadata.provider_alias=",
    "metadata.receipt_id=",
    "metadata.receipt_at=",
    "metadata.delivery_status=delivered",
    "evidence=production_readiness_evidence",
    "no endpoint_url/token/webhook_secret",
  ]);
  requireNoFieldPattern(fields, failures, "external alert delivery evidence", [
    ["plaintext endpoint URL", /\b(?:endpoint_url|webhook_url)\s*[:=]\s*https?:\/\//i],
    ["plaintext token or webhook secret", /\b(?:token|webhook_secret|endpoint_secret|credential_secret)\s*[:=]\s*[^,\s;)]+/i],
    ["test/fake provider evidence", /\b(?:test_fake|fake_provider|fake_sender)\b/i],
  ]);
  requireContains(fields, failures, "ops webhook sender evidence", [
    "POST /v1/ops-alerts/{alert_id}/deliveries/send-webhook",
    "ops_notification_attempts",
    "ops_notification_deliveries",
    "endpoint_secret_ref=SecretRef",
    "route_policy_ref=",
    "allowed_hosts=public_dns",
    "status=",
    "no webhook_url/token",
  ]);
  requireNoFieldPattern(fields, failures, "ops webhook sender evidence", [
    ["plaintext endpoint URL", /\b(?:endpoint_url|webhook_url)\s*[:=]\s*https?:\/\//i],
    ["plaintext token or secret value", /\b(?:token|webhook_secret|endpoint_secret|credential_secret)\s*[:=]\s*[^,\s;)]+/i],
    ["raw endpoint secret value", /\bendpoint_secret_value\s*[:=]\s*[^,\s;)]+/i],
    ["raw credential secret value", /\bcredential_secret_value\s*[:=]\s*[^,\s;)]+/i],
    ["test/fake webhook evidence", /\b(?:test_fake|fake_provider|fake_sender)\b/i],
  ]);
  validateControlledProdReadinessSnapshot(fields, failures);
  validateExternalAlertDeliveryEvidence(fields, failures);
  validateOpsWebhookSenderEvidence(fields, failures);
  requireContains(fields, failures, "live D5 evidence", ["row 50"]);
  requireBracketedAliases(fields, failures, "live D5 evidence", 2);
  requireContains(fields, failures, "secret.resolve audit sample", ["seq", "hash"]);
  requireNotContains(fields, failures, "secret.resolve audit sample", ["material=present", "value="]);
  requireContains(fields, failures, "negative control proof", ["secret-scan", "GitHub `secrets`", "environment: staging", "env dump", "xtrace"]);

  return { ok: failures.length === 0, failures };
}

function extractPacket(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\[STAGING RELEASE PACKET\b/i.test(line.trim()));
  if (start < 0) return undefined;
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

function hasUnfilledPlaceholder(field, value) {
  const allowedSecretStoreBase = field === "SecretStore alias/path" && value.includes("secret/data/rpa/staging/<runtime>/<purpose>/<name>");
  const valueToCheck = allowedSecretStoreBase
    ? value.replace("secret/data/rpa/staging/<runtime>/<purpose>/<name>", "")
    : value;
  return /<[^>]+>/.test(valueToCheck);
}

function scanForbidden(packet, failures) {
  for (const [label, pattern] of FORBIDDEN_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(packet)) failures.push(`forbidden ${label} in packet`);
  }
}

function scanUrls(packet, failures) {
  for (const match of packet.matchAll(/\bhttps?:\/\/[^\s)]+/g)) {
    try {
      const url = new URL(match[0]);
      if (url.protocol !== "https:") failures.push(`non-HTTPS URL is not allowed: ${url.origin}${url.pathname}`);
      if (url.username || url.password) failures.push(`URL credentials are not allowed: ${url.origin}${url.pathname}`);
      if (url.search || url.hash) failures.push(`URL query/fragment is not allowed: ${url.origin}${url.pathname}`);
    } catch {
      failures.push(`invalid URL in packet: ${match[0]}`);
    }
  }
}

function requireContains(fields, failures, field, needles) {
  const value = fields.get(field);
  if (value === undefined) return;
  for (const needle of needles) {
    if (!value.includes(needle)) failures.push(`${field}: missing ${JSON.stringify(needle)}`);
  }
}

function requireNotContains(fields, failures, field, needles) {
  const value = fields.get(field);
  if (value === undefined) return;
  for (const needle of needles) {
    if (value.includes(needle)) failures.push(`${field}: must not include ${JSON.stringify(needle)}`);
  }
}

function requireNoFieldPattern(fields, failures, field, patterns) {
  const value = fields.get(field);
  if (value === undefined) return;
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) failures.push(`${field}: forbidden ${label}`);
  }
}

function requireBracketedAliases(fields, failures, field, minimumCount) {
  const value = fields.get(field);
  if (value === undefined) return;
  const aliases = value.match(/\[[A-Za-z0-9._-]+\]/g) ?? [];
  if (aliases.length < minimumCount) failures.push(`${field}: requires at least ${minimumCount} bracketed redacted alias(es)`);
}

function validateControlledProdReadinessSnapshot(fields, failures) {
  const field = "controlled-prod readiness snapshot";
  const value = fields.get(field);
  if (value === undefined) return;
  const ready = requirePacketValue(value, field, "controlled_prod_ready", failures);
  const blockerCount = requireNonNegativeIntegerPacketValue(value, field, "blocker_count", failures);
  const deferredCount = requireNonNegativeIntegerPacketValue(value, field, "deferred_count", failures);
  const externalAlertDelivery = requireEnumPacketValue(value, field, "external_alert_delivery", READINESS_GATE_STATUSES, failures);
  const supportTrainingCompletion = requireEnumPacketValue(value, field, "support_training_completion", READINESS_GATE_STATUSES, failures);
  const observabilityTelemetry = requireEnumPacketValue(value, field, "observability_telemetry_wiring", READINESS_GATE_STATUSES, failures);
  if (ready !== "true" && ready !== "false" && ready !== null) {
    failures.push(`${field}: controlled_prod_ready must be true or false`);
  }
  if (ready === "true" && (blockerCount !== 0 || deferredCount !== 0)) {
    failures.push(`${field}: controlled_prod_ready=true requires blocker_count=0 and deferred_count=0`);
  }
  if (ready === "true" && externalAlertDelivery !== "pass") {
    failures.push(`${field}: controlled_prod_ready=true requires external_alert_delivery=pass`);
  }
  if (ready === "true" && supportTrainingCompletion !== "pass") {
    failures.push(`${field}: controlled_prod_ready=true requires support_training_completion=pass`);
  }
  if (ready === "true" && observabilityTelemetry !== "pass") {
    failures.push(`${field}: controlled_prod_ready=true requires observability_telemetry_wiring=pass`);
  }
}

function validateExternalAlertDeliveryEvidence(fields, failures) {
  const field = "external alert delivery evidence";
  const value = fields.get(field);
  if (value === undefined) return;
  const status = requireEnumPacketValue(value, field, "status", EXTERNAL_EVIDENCE_PACKET_STATUSES, failures);
  const deliveryStatus = requirePacketValue(value, field, "metadata.delivery_status", failures);
  if (deliveryStatus !== null && deliveryStatus !== "delivered") {
    failures.push(`${field}: metadata.delivery_status must be delivered`);
  }
  const readinessState = packetValue(fields.get("controlled-prod readiness snapshot") ?? "", "external_alert_delivery");
  if (readinessState === "pass" && status !== "valid") {
    failures.push(`${field}: readiness external_alert_delivery=pass requires status=valid`);
  }
  if (status === "valid") {
    requireEnumPacketValue(value, field, "metadata.channel", EXTERNAL_ALERT_CHANNELS, failures);
  }
}

function validateOpsWebhookSenderEvidence(fields, failures) {
  const field = "ops webhook sender evidence";
  const value = fields.get(field);
  if (value === undefined) return;
  const status = requireEnumPacketValue(value, field, "status", OPS_WEBHOOK_EVIDENCE_STATUSES, failures);
  if (status === "delivered") {
    requirePacketValue(value, field, "receipt_id", failures);
    requirePacketValue(value, field, "receipt_at", failures);
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

function requireEnumPacketValue(value, field, key, allowed, failures) {
  const raw = requirePacketValue(value, field, key, failures);
  if (raw === null) return null;
  if (!allowed.has(raw)) {
    failures.push(`${field}: ${key} must be one of ${Array.from(allowed).join("|")}`);
  }
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
    "[STAGING RELEASE PACKET -- redacted]",
    "- staging platform repo            : xorrbss/rpa-platform-deploy",
    "- concrete deploy target           : rpa-staging/runtime-worker",
    "- GitHub Environment `staging`      : protection=on, required reviewer=owner, branch policy=protected-main",
    "- release approval reference        : https://github.com/xorrbss/rpa-platform-deploy/actions/runs/123456789",
    "- rollback confirmation             : forward-only(D7-4) + prior-image redeploy; owner=#13",
    "- SecretStore alias/path            : Vault KV v2 mount `secret/`, base secret/data/rpa/staging/<runtime>/<purpose>/<name> (values omitted)",
    "- namespace / identity map          : D8-A12 staging-decision-proposals section 3",
    "- SecretRef inventory               : D8-A12 staging-decision-proposals section 4 identifiers only",
    "- runtime artifact object-store env : `GATEWAY_ARTIFACT_STORE_MODE=s3`; `GATEWAY_ARTIFACT_OBJECT_STORE_REF=rpa/staging/runtime-worker/object_store/s3-producer`; `ARTIFACT_OBJECT_STORE_REF=rpa/staging/artifact-lifecycle/object_store/s3`; alias=[s3-staging-1]",
    "- artifact store topology preflight  : run `npm --prefix app run preflight:artifact-store -- --topology split-worker-lifecycle`; PASS before process start",
    "- retention policy                  : D8-A11/D8-A14 and ops-defaults section 6.1",
    "- controlled-prod readiness snapshot : GET /v1/ops/production-readiness; controlled_prod_ready=false; blocker_count=0; deferred_count=5; external_alert_delivery=deferred; support_training_completion=deferred; observability_telemetry_wiring=deferred; evidence=production_readiness_evidence [readiness-snapshot-1]",
    "- external alert delivery evidence : evidence_type=external_alert_delivery; status=deferred; metadata.channel=[pending-channel]; metadata.provider_alias=[pending-provider]; metadata.receipt_id=[pending-receipt]; metadata.receipt_at=[pending-receipt-at]; metadata.delivery_status=delivered required before production open; evidence=production_readiness_evidence [external-alert-1]; no endpoint_url/token/webhook_secret",
    "- ops webhook sender evidence : POST /v1/ops-alerts/{alert_id}/deliveries/send-webhook; ops_notification_attempts=[webhook-attempts-1]; ops_notification_deliveries=[webhook-deliveries-1]; endpoint_secret_ref=SecretRef alias [webhook-secretref-1]; route_policy_ref=[webhook-route-1]; allowed_hosts=public_dns [webhook-hosts-1]; status=sent; no webhook_url/token",
    "- live D5 evidence                  : row 50 packet aliases [codex-staging-1]/[model-a]",
    "- secret.resolve audit sample       : seq#1/hash#abc123, no material",
    "- negative control proof            : secret-scan rejects GitHub `secrets` context, environment: staging binding, env dump commands, and xtrace",
    "[forbidden: plaintext credentials omitted]",
  ].join("\n");

  const cases = [
    ["valid packet", valid, true],
    ["missing field", valid.replace(/^- live D5 evidence.*\n/m, ""), false],
    ["missing external alert evidence", valid.replace(/^- external alert delivery evidence.*\n/m, ""), false],
    ["unfilled repo placeholder", valid.replace("xorrbss/rpa-platform-deploy", "<org/repo name>"), false],
    ["missing topology pass", valid.replace("PASS before process start", "pending before process start"), false],
    ["role id leak", `${valid}\nrole_id=plain-role-id`, false],
    ["url query leak", valid.replace("/runs/123456789", "/runs/123456789?token=redacted"), false],
    ["object ref leak", valid.replace("no material", "ObjectRef s3://bucket/raw-key"), false],
    ["raw model leak", valid.replace("[model-a]", "gpt-5"), false],
    ["access key leak", `${valid}\n${"AKIA"}IOSFODNN7EXAMPLE`, false],
    ["negative proof missing", valid.replace(/^- negative control proof.*\n/m, ""), false],
    ["webhook url leak", valid.replace("no webhook_url/token", "webhook_url=https://hooks.example.com/services/a"), false],
    ["invalid readiness count", valid.replace("blocker_count=0", "blocker_count=none"), false],
    ["missing support training gate", valid.replace("; support_training_completion=deferred", ""), false],
    ["ready with deferred external alert", valid.replace("controlled_prod_ready=false", "controlled_prod_ready=true"), false],
    ["ambiguous webhook status", valid.replace("status=sent; no webhook_url/token", "status=queued/sent; no webhook_url/token"), false],
    ["test fake receipt", valid.replace("[external-alert-1]", "test_fake"), false],
    ["raw roster leak", `${valid}\nraw_roster_rows=alice,bob`, false],
    ["training document leak", `${valid}\ntraining_document=raw.pdf`, false],
  ];

  const failures = [];
  for (const [label, text, expected] of cases) {
    const actual = validatePacket(text, label).ok;
    if (actual !== expected) failures.push(`${label}: expected ${expected ? "PASS" : "FAIL"}, got ${actual ? "PASS" : "FAIL"}`);
  }

  if (failures.length > 0) {
    console.error(`staging release packet validator self-test: ${failures.length} failed`);
    for (const failure of failures) console.error(`FAIL: ${failure}`);
    process.exit(1);
  }
  console.log("staging release packet validator self-test: fixtures passed");
}

function printUsage() {
  console.log([
    "Usage: node scripts/validate-staging-release-packet.mjs [--file packet.md|-]",
    "       node scripts/validate-staging-release-packet.mjs --self-test",
    "",
    "Validates the redacted row-43 staging release packet shape without resolving or printing secrets.",
  ].join("\n"));
}

main();
