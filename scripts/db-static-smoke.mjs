#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DB = join(ROOT, "db");

const smoke = readSql("migration_smoke.sql");
const concurrency = readSql("migration_concurrency_idempotency.sql");
const core = readSql("migration_core_entities.sql");
const roles = readSql("roles.sql");
const allMigrations = `${concurrency}\n${core}`;
const failures = [];

const expectedTables = [
  "credential_concurrency_policies",
  "credential_leases",
  "browser_leases",
  "browser_sessions",
  "capture_sessions",
  "raw_items",
  "normalized_records",
  "sink_deliveries",
  "challenge_resolution_attempts",
  "site_profiles",
  "site_profile_approvals",
  "site_block_samples",
  "site_element_repository",
  "browser_recording_sessions",
  "browser_recording_events",
  "approval_decisions",
  "workers",
  "browser_identities",
  "network_policies",
  "gateway_policies",
  "control_plane_idempotency_keys",
  "scenarios",
  "scenario_versions",
  "automation_ideas",
  "roi_estimates",
  "run_triggers",
  "run_trigger_fires",
  "scenario_generations",
  "workitems",
  "runs",
  "run_steps",
  "human_tasks",
  "principals",
  "artifacts",
  "document_jobs",
  "document_extractions",
  "events_outbox",
  "dead_letter",
  "action_plan_cache",
  "stagehand_calls",
  "scenario_generation_llm_calls",
  "audit_log",
  "scenario_promotion_requests",
  "worker_pools",
  "worker_pool_assignments",
];

// worker_pools 는 workers/artifacts 처럼 인프라(non-RLS) 도메인이라 테넌트 RLS 검증에서 제외한다.
const tenantTables = expectedTables.filter(
  (table) => table !== "workers" && table !== "artifacts" && table !== "worker_pools",
);
const expectedEventTypes = readdirSync(join(ROOT, "schema", "events"))
  .filter((name) => name.endsWith(".schema.json") && name !== "common-empty-payload.schema.json")
  .map((name) => name.replace(/\.schema\.json$/, ""))
  .filter((eventType) => !eventType.startsWith("worker."))
  .sort();

checkSmokeHarness();
checkCreatedTables();
checkTenantRlsLoop();
checkArtifactRls();
checkWorkerBypassDomain();
checkNetworkPolicyFailClosed();
checkTenantForeignKeys();
checkPayloadRetentionContracts();
checkCanonicalStepReferences();
checkIdempotencyAndCasContracts();
checkAuditLogContract();
checkEventsOutboxContract();
checkForbiddenSql();
checkRoles();

if (failures.length > 0) {
  console.error(`db static smoke: ${failures.length} failed`);
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}

console.log(
  `db static smoke: ${expectedTables.length} tables, ${tenantTables.length} tenant RLS tables, ${expectedEventTypes.length} event types checked`,
);
console.log(
  "db static smoke coverage: artifact read/mutation RLS, artifact lifecycle claim/finalize CAS anchors, immutable audit hash-chain, idempotency/CAS anchors, rollback harness",
);

function checkSmokeHarness() {
  const includeOrder = [...smoke.matchAll(/^\\ir\s+(.+)$/gim)].map((match) => match[1].trim());
  expectEqualArray("migration_smoke.sql include order", includeOrder, [
    "migration_concurrency_idempotency.sql",
    "migration_core_entities.sql",
  ]);

  requireIn("migration_smoke.sql", smoke, "\\set ON_ERROR_STOP on");
  requireIn("migration_smoke.sql", smoke, "BEGIN;");
  requireIn("migration_smoke.sql", smoke, "CREATE SCHEMA rpa_migration_smoke");
  requireRegex("migration_smoke.sql", smoke, /SET\s+LOCAL\s+search_path\s*=\s*rpa_migration_smoke,\s*public/i);
  requireRegex("migration_smoke.sql", smoke, /server_version_num'\)::int\s*<\s*150000/i);
  requireIn("migration_smoke.sql", smoke, "ROLLBACK;");

  expectEqualArray(
    "migration_smoke.sql expected_tables",
    arrayAssignment(smoke, "expected_tables"),
    expectedTables,
  );
  expectEqualArray(
    "migration_smoke.sql tenant_tables",
    arrayAssignment(smoke, "tenant_tables"),
    tenantTables,
  );
}

function checkRoles() {
  // DG1 — 최소권한 역할 분리(db/roles.sql). rpa_app(런타임)은 DDL/superuser/bypassrls 없이 DML 만.
  requireRegex("roles.sql rpa_migrator non-privileged", roles, /CREATE\s+ROLE\s+rpa_migrator\s+NOLOGIN\s+NOSUPERUSER\s+NOBYPASSRLS/i);
  requireRegex("roles.sql rpa_app least-privilege attrs", roles, /CREATE\s+ROLE\s+rpa_app\s+NOLOGIN\s+NOSUPERUSER\s+NOBYPASSRLS\s+NOCREATEDB\s+NOCREATEROLE/i);
  requireRegex("roles.sql rpa_app schema USAGE only", roles, /GRANT\s+USAGE\s+ON\s+SCHEMA\s+public\s+TO\s+rpa_app/i);
  requireRegex("roles.sql rpa_app DML grant", roles, /GRANT\s+SELECT,\s*INSERT,\s*UPDATE,\s*DELETE\s+ON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+public\s+TO\s+rpa_app/i);
  requireRegex("roles.sql default privileges for migrator", roles, /ALTER\s+DEFAULT\s+PRIVILEGES\s+FOR\s+ROLE\s+rpa_migrator\s+IN\s+SCHEMA\s+public/i);
  // rpa_app 에 DDL(스키마 CREATE) 을 부여하면 최소권한이 깨진다 — 금지.
  if (/GRANT\s+CREATE\s+ON\s+SCHEMA\s+public\s+TO\s+rpa_app/i.test(roles)) {
    failures.push("roles.sql must NOT grant CREATE on schema public to rpa_app (DDL must stay denied)");
  }
}

function checkCreatedTables() {
  const createdTables = unique(
    [...allMigrations.matchAll(/\bCREATE\s+TABLE\s+([a-z_][a-z0-9_]*)\s*\(/gi)]
      .map((match) => match[1])
      .sort(),
  );
  expectEqualArray("created table set", createdTables, [...expectedTables].sort());
}

function checkTenantRlsLoop() {
  const rlsTables = arrayAfter(allMigrations, "FOREACH tenant_table IN ARRAY ARRAY");
  expectEqualArray("tenant RLS loop table set", rlsTables, tenantTables);
  requireRegex("tenant RLS loop", allMigrations, /ALTER\s+TABLE\s+%I\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
  requireRegex("tenant RLS loop", allMigrations, /ALTER\s+TABLE\s+%I\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i);
  requireRegex("tenant RLS loop", allMigrations, /CREATE\s+POLICY\s+tenant_isolation\s+ON\s+%I/i);
  requireRegex("tenant RLS loop", allMigrations, /tenant_id\s*=\s*current_setting\(''app\.tenant_id''\)::uuid/i);
}

function checkArtifactRls() {
  requireRegex("artifacts RLS", allMigrations, /ALTER\s+TABLE\s+artifacts\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
  requireRegex("artifacts RLS", allMigrations, /ALTER\s+TABLE\s+artifacts\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i);
  requireRegex("artifacts RLS", allMigrations, /CREATE\s+POLICY\s+artifacts_visible_isolation\s+ON\s+artifacts/i);
  requireRegex("artifacts RLS", allMigrations, /deleted_at\s+IS\s+NULL/i);
  requireRegex("artifacts RLS", allMigrations, /quarantine\s*=\s*false/i);
  requireRegex("artifacts RLS", allMigrations, /redaction_status\s+IN\s+\('redacted','not_required'\)/i);
  requireRegex("artifacts RLS", allMigrations, /CREATE\s+POLICY\s+artifacts_insert_isolation\s+ON\s+artifacts/i);
  requireRegex("artifacts insert policy lifecycle claim guard", allMigrations, /lifecycle_claim_id\s+IS\s+NULL/i);
  requireRegex("artifacts insert policy lifecycle claim guard", allMigrations, /lifecycle_claim_expires_at\s+IS\s+NULL/i);
  rejectRegex("artifacts RLS", allMigrations, /CREATE\s+POLICY\s+\S+\s+ON\s+artifacts\s+FOR\s+(UPDATE|DELETE|ALL)\b/i);
  requireRegex("migration_smoke.sql artifacts no app mutation policy check", smoke, /artifact UPDATE\/DELETE policies must not exist for the application role/i);
  requireRegex("migration_smoke.sql artifacts lifecycle claim insert check", smoke, /artifact application insert must not set lifecycle claim lease fields/i);
}

function checkWorkerBypassDomain() {
  requireRegex("workers infrastructure table", allMigrations, /CREATE\s+TABLE\s+workers\s*\([\s\S]*?id\s+uuid\s+PRIMARY\s+KEY/i);
  requireRegex("migration_smoke.sql workers bypass domain check", smoke, /table_name\s*=\s*'workers'[\s\S]*?column_name\s*=\s*'tenant_id'[\s\S]*?relrowsecurity[\s\S]*?relforcerowsecurity/i);
}

function checkNetworkPolicyFailClosed() {
  requireRegex("network policy fail-closed", allMigrations, /block_on_violation\s+boolean\s+NOT\s+NULL\s+DEFAULT\s+true\s+CHECK\s*\(\s*block_on_violation\s*=\s*true\s*\)/i);
}

function checkTenantForeignKeys() {
  const compositeFkTables = [
    "site_profile_approvals",
    "site_block_samples",
    "site_element_repository",
    "browser_recording_sessions",
    "browser_recording_events",
    "approval_decisions",
    "browser_identities",
    "scenario_versions",
    "runs",
    "run_steps",
    "human_tasks",
    "document_jobs",
    "document_extractions",
    "artifacts",
    "document_jobs",
    "document_extractions",
    "events_outbox",
    "dead_letter",
    "action_plan_cache",
    "stagehand_calls",
    "credential_leases",
    "credential_concurrency_policies",
    "browser_leases",
    "browser_sessions",
    "capture_sessions",
    "challenge_resolution_attempts",
    "normalized_records",
    "sink_deliveries",
  ];

  for (const table of compositeFkTables) {
    requireRegex(
      `${table} tenant FK`,
      allMigrations,
      new RegExp(`ALTER\\s+TABLE\\s+${table}[\\s\\S]*?FOREIGN\\s+KEY\\s*\\(tenant_id,`, "i"),
    );
  }
}

function checkIdempotencyAndCasContracts() {
  const artifactsBody = createTableBody("artifacts");
  for (const column of [
    "lifecycle_claim_id",
    "lifecycle_claim_kind",
    "lifecycle_claim_worker_id",
    "lifecycle_claim_correlation_id",
    "lifecycle_claimed_at",
    "lifecycle_claim_expires_at",
  ]) {
    requireRegex(`artifact lifecycle claim column ${column}`, artifactsBody, new RegExp(`${column}\\s+`, "i"));
  }
  requireRegex("artifact lifecycle claim kind enum", artifactsBody, /lifecycle_claim_kind\s+text\s+CHECK\s*\(\s*lifecycle_claim_kind\s+IN\s+\('artifact_redaction','artifact_retention'\)\s*\)/i);
  requireRegex("artifact lifecycle claim worker FK", artifactsBody, /lifecycle_claim_worker_id\s+uuid\s+REFERENCES\s+workers\(id\)/i);
  requireRegex("artifact lifecycle claim all-or-none check", artifactsBody, /lifecycle_claim_id\s+IS\s+NULL[\s\S]*?lifecycle_claim_expires_at\s+IS\s+NULL[\s\S]*?lifecycle_claim_id\s+IS\s+NOT\s+NULL[\s\S]*?lifecycle_claim_expires_at\s+>\s+lifecycle_claimed_at/i);
  requireRegex("artifact lifecycle claim unique tenant claim id", allMigrations, /CREATE\s+UNIQUE\s+INDEX\s+idx_artifacts_lifecycle_claim\s+ON\s+artifacts\s*\(tenant_id,\s*lifecycle_claim_id\)[\s\S]*?WHERE\s+lifecycle_claim_id\s+IS\s+NOT\s+NULL/i);
  requireRegex("artifact lifecycle claim expiry index", allMigrations, /CREATE\s+INDEX\s+idx_artifacts_lifecycle_claim_expiry\s+ON\s+artifacts\s*\(tenant_id,\s*lifecycle_claim_kind,\s*lifecycle_claim_expires_at\)[\s\S]*?WHERE\s+lifecycle_claim_id\s+IS\s+NOT\s+NULL/i);
  requireRegex("artifact lifecycle claim smoke active no-steal", smoke, /artifact lifecycle active claim must not be stolen/i);
  requireRegex("artifact lifecycle claim smoke expired reclaim", smoke, /artifact lifecycle expired claim should be reclaimed exactly once/i);
  requireRegex("artifact lifecycle finalize smoke wrong claim", smoke, /artifact lifecycle finalize CAS must reject wrong claim id/i);
  requireRegex("artifact lifecycle finalize smoke cross tenant", smoke, /artifact lifecycle finalize CAS must reject cross-tenant claim/i);
  requireRegex("artifact lifecycle finalize smoke expired claim", smoke, /artifact lifecycle finalize CAS must reject expired claim/i);
  requireRegex("artifact lifecycle finalize smoke worker binding", smoke, /lifecycle_claim_worker_id\s*=\s*worker_id[\s\S]*?lifecycle_claim_correlation_id\s*=/i);
  requireRegex("artifact lifecycle retention transient smoke", smoke, /artifact lifecycle transient retention failure must not tombstone or retain claim/i);
  requireRegex("raw item dedup", allMigrations, /UNIQUE\s+NULLS\s+NOT\s+DISTINCT\s*\(tenant_id,\s*connector_id,\s*target_id,\s*source_item_key,\s*raw_hash\)/i);
  requireRegex("raw connector target key", allMigrations, /CREATE\s+INDEX\s+idx_raw_items_connector_target\s+ON\s+raw_items\s*\(tenant_id,\s*connector_id,\s*target_id\)/i);
  requireRegex("control-plane idempotency", allMigrations, /UNIQUE\s*\(tenant_id,\s*endpoint,\s*idempotency_key\)/i);
  requireRegex("events outbox idempotency", allMigrations, /UNIQUE\s*\(tenant_id,\s*idempotency_key\)/i);
  requireRegex("one run per workitem", allMigrations, /CREATE\s+UNIQUE\s+INDEX\s+idx_runs_one_per_workitem\s+ON\s+runs\s*\(tenant_id,\s*workitem_id\)[\s\S]*?WHERE\s+workitem_id\s+IS\s+NOT\s+NULL/i);
  requireRegex("run abort source status column", createTableBody("runs"), /abort_source_status\s+text[\s\S]*?CHECK\s*\(\s*abort_source_status\s+IS\s+NULL\s+OR\s+abort_source_status\s+IN\s+\('running','suspended','resume_requested','resuming'\)\s*\)/i);
  requireRegex("run abort source status positive smoke", smoke, /run abort source status should accept persisted abort source/i);
  requireRegex("run abort source status negative smoke", smoke, /run abort source status must reject unknown source/i);
  requireRegex("stagehand idempotency", allMigrations, /CREATE\s+TABLE\s+stagehand_calls\s*\([\s\S]*?idempotency_key\s+text\s+NOT\s+NULL[\s\S]*?request_hash\s+text\s+NOT\s+NULL[\s\S]*?UNIQUE\s*\(tenant_id,\s*idempotency_key\)/i);
  requireRegex("scenario generation llm idempotency", allMigrations, /CREATE\s+TABLE\s+scenario_generation_llm_calls\s*\([\s\S]*?generation_id\s+uuid\s+NOT\s+NULL[\s\S]*?correlation_id\s+uuid\s+NOT\s+NULL[\s\S]*?idempotency_key\s+text\s+NOT\s+NULL[\s\S]*?request_hash\s+text\s+NOT\s+NULL[\s\S]*?prompt_template_version\s+text\s+NOT\s+NULL[\s\S]*?parsed_json\s+jsonb[\s\S]*?retention_until\s+timestamptz\s+NOT\s+NULL[\s\S]*?UNIQUE\s*\(tenant_id,\s*idempotency_key\)/i);
  requireRegex("scenario generation llm stream status check", allMigrations, /chk_scenario_generation_llm_calls_stream_status[\s\S]*?stream_status\s+IS\s+NOT\s+NULL[\s\S]*?open[\s\S]*?done[\s\S]*?error[\s\S]*?aborted/i);
  requireRegex("action plan cache family", allMigrations, /UNIQUE\s*\(scenario_version_id,\s*step_id,\s*url_pattern,\s*dom_structural_hash,\s*model,\s*prompt_template_version,\s*browser_identity_version\)/i);
  requireRegex("credential lease slot PK", allMigrations, /PRIMARY\s+KEY\s*\(tenant_id,\s*credential_ref,\s*site_profile_id,\s*slot_no\)/i);
  requireRegex("credential slot trigger", allMigrations, /CREATE\s+TRIGGER\s+trg_validate_credential_lease_slot/i);
  requireRegex("control-plane idempotency smoke", smoke, /INSERT\s+INTO\s+control_plane_idempotency_keys[\s\S]*?WHEN\s+unique_violation/i);
  requireRegex("one run per workitem smoke", smoke, /runs must reject duplicate workitem_id per tenant/i);
  requireRegex("browser lease owner heartbeat CAS", smoke, /owner_worker_id\s*=\s*wrong_worker_id[\s\S]*?ROW_COUNT/i);
  requireRegex("event publish CAS", smoke, /WHERE\s+events_outbox\.event_id\s*=\s*smoke_event_id[\s\S]*?AND\s+published_at\s+IS\s+NULL/i);
}

function checkPayloadRetentionContracts() {
  for (const table of [
    "control_plane_idempotency_keys",
    "raw_items",
    "normalized_records",
    "artifacts",
    "events_outbox",
    "audit_log",
  ]) {
    const body = createTableBody(table);
    requireRegex(`${table} retention_until`, body, /retention_until\s+timestamptz/i);
    requireRegex(`${table} deleted_at`, body, /deleted_at\s+timestamptz/i);
    requireRegex(`${table} legal_hold`, body, /legal_hold\s+boolean\s+NOT\s+NULL\s+DEFAULT\s+false/i);
  }

  requireRegex("events_outbox retention_until not null", createTableBody("events_outbox"), /retention_until\s+timestamptz\s+NOT\s+NULL/i);
  requireRegex("migration_smoke.sql retention column check", smoke, /payload-bearing table % missing retention column %/i);
  requireRegex("events_outbox smoke retention assertion", smoke, /events_outbox smoke rows must set retention_until explicitly/i);
  requireRegex("events_outbox null retention rejection", smoke, /events_outbox must reject missing retention_until/i);
}

function checkCanonicalStepReferences() {
  requireRegex("run_steps canonical step key", allMigrations, /UNIQUE\s*\(tenant_id,\s*run_id,\s*step_id,\s*attempt\)/i);
  requireRegex("run_steps started attempt status", createTableBody("run_steps"), /status\s+IN\s*\('started','success'/i);

  for (const table of ["artifacts", "events_outbox", "stagehand_calls"]) {
    const body = createTableBody(table);
    requireRegex(`${table} attempt column`, body, /attempt\s+int[\s\S]*?CHECK\s*\(attempt\s*>=\s*0\)/i);
    requireRegex(
      `${table} step attempt tenant FK`,
      allMigrations,
      new RegExp(
        `ALTER\\s+TABLE\\s+${table}[\\s\\S]*?FOREIGN\\s+KEY\\s*\\(tenant_id,\\s*run_id,\\s*step_id,\\s*attempt\\)\\s+REFERENCES\\s+run_steps\\s*\\(tenant_id,\\s*run_id,\\s*step_id,\\s*attempt\\)`,
        "i",
      ),
    );
  }

  requireRegex("artifact step FK smoke", smoke, /artifact step reference must reject unknown/i);
  requireRegex("artifact retention CHECK", createTableBody("artifacts"), /CHECK\s*\(\s*legal_hold\s+OR\s+retention_until\s+IS\s+NOT\s+NULL\s*\)/i);
  requireRegex("artifact missing retention smoke", smoke, /artifact metadata must reject missing retention_until unless legal_hold/i);
  requireRegex("stagehand step FK smoke", smoke, /stagehand_calls step reference must reject unknown/i);
  requireRegex("events_outbox step ref CHECK", allMigrations, /event_type\s+NOT\s+LIKE\s+'step\.%'/i);
  requireIn("migration_smoke.sql step.started payload ref", smoke, "'events/step.started@1'");
  requireRegex("events_outbox missing step ref smoke", smoke, /events_outbox step event must reject missing step_id\/attempt/i);
  requireRegex("events_outbox step FK smoke", smoke, /events_outbox step event must reject unknown/i);
}

function checkAuditLogContract() {
  const body = createTableBody("audit_log");
  requireRegex("audit log outcome enum", body, /outcome\s+text\s+NOT\s+NULL\s+CHECK\s*\(\s*outcome\s+IN\s*\('allow','deny','blocked','error'\)\s*\)/i);
  requireRegex("audit log sequence", body, /sequence_no\s+bigint\s+NOT\s+NULL\s+CHECK\s*\(sequence_no\s*>=\s*1\)/i);
  requireRegex("audit log previous hash", body, /previous_hash\s+text/i);
  requireRegex("audit log hash", body, /hash\s+text\s+NOT\s+NULL\s+CHECK\s*\(length\(hash\)\s*>\s*0\)/i);
  requireRegex(
    "audit log payload schema ref",
    body,
    /payload_schema_ref\s+text\s+NOT\s+NULL\s+DEFAULT\s+'audit\/security-boundary-decision@1'\s+CHECK\s*\(\s*payload_schema_ref\s*=\s*'audit\/security-boundary-decision@1'\s*\)/i,
  );
  requireRegex("audit log tenant sequence unique", body, /UNIQUE\s*\(tenant_id,\s*sequence_no\)/i);
  requireRegex("audit log idempotency unique", body, /UNIQUE\s*\(tenant_id,\s*idempotency_key\)/i);
  requireRegex("audit log hash unique", body, /UNIQUE\s*\(tenant_id,\s*hash\)/i);
  requireRegex("audit log tenant chain FK", body, /FOREIGN\s+KEY\s*\(tenant_id,\s*previous_hash\)\s+REFERENCES\s+audit_log\s*\(tenant_id,\s*hash\)/i);
  requireRegex("audit log single genesis", allMigrations, /CREATE\s+UNIQUE\s+INDEX\s+uq_audit_log_tenant_genesis\s+ON\s+audit_log\s*\(tenant_id\)\s+WHERE\s+previous_hash\s+IS\s+NULL/i);
  requireRegex("audit log no branching", allMigrations, /CREATE\s+UNIQUE\s+INDEX\s+uq_audit_log_tenant_previous_hash\s+ON\s+audit_log\s*\(tenant_id,\s*previous_hash\)\s+WHERE\s+previous_hash\s+IS\s+NOT\s+NULL/i);
  requireRegex("audit log append-only trigger", allMigrations, /CREATE\s+TRIGGER\s+trg_audit_log_append_only\s+BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+audit_log/i);
  requireRegex("audit log payload schema smoke", smoke, /audit_log must reject unknown payload_schema_ref/i);
  requireRegex("audit log append-only smoke", smoke, /audit_log must reject UPDATE[\s\S]*?audit_log must reject DELETE/i);
  requireRegex("audit log cross-tenant chain smoke", smoke, /audit_log must reject cross-tenant previous_hash chaining/i);
}

function checkEventsOutboxContract() {
  const ddlEventTypes = extractEventTypeCheck(allMigrations);
  expectEqualArray("events_outbox event_type CHECK", ddlEventTypes, expectedEventTypes);
  if (ddlEventTypes.some((eventType) => eventType.startsWith("worker."))) {
    failures.push("events_outbox event_type CHECK must not include worker.* infrastructure telemetry");
  }
  requireRegex("events_outbox payload schema column", allMigrations, /payload_schema_ref\s+text\s+NOT\s+NULL/i);
  requireIn("migration_smoke.sql representative payload ref", smoke, "'events/run.started@1'");
  requireRegex("migration_smoke.sql worker event exclusion", smoke, /events_outbox must reject worker\.\* infrastructure telemetry/i);
}

function checkForbiddenSql() {
  const checks = [
    [/current_setting\('app\.tenant_id'\s*,\s*true\)/i, "RLS must not use missing-tenant fallback"],
    [/USING\s*\(\s*true\s*\)/i, "RLS must not allow USING (true)"],
    [/WITH\s+CHECK\s*\(\s*true\s*\)/i, "RLS must not allow WITH CHECK (true)"],
  ];

  for (const [pattern, message] of checks) {
    if (pattern.test(allMigrations)) failures.push(message);
  }
}

function readSql(name) {
  return stripSqlComments(readFileSync(join(DB, name), "utf8"));
}

function arrayAssignment(source, name) {
  const match = source.match(new RegExp(`${name}\\s+text\\[\\]\\s*:=\\s*ARRAY\\s*\\[([\\s\\S]*?)\\]`, "i"));
  if (!match) {
    failures.push(`missing array assignment ${name}`);
    return [];
  }
  return stringsIn(match[1]);
}

function arrayAfter(source, marker) {
  const index = source.indexOf(marker);
  if (index < 0) {
    failures.push(`missing array marker ${marker}`);
    return [];
  }
  const rest = source.slice(index + marker.length);
  const match = rest.match(/\[([\s\S]*?)\]/);
  if (!match) {
    failures.push(`missing array body after ${marker}`);
    return [];
  }
  return stringsIn(match[1]);
}

function createTableBody(table) {
  const match = allMigrations.match(new RegExp(`CREATE\\s+TABLE\\s+${table}\\s*\\(([\\s\\S]*?)\\);`, "i"));
  if (!match) {
    failures.push(`missing CREATE TABLE body for ${table}`);
    return "";
  }
  return match[1];
}

function extractEventTypeCheck(source) {
  const match = source.match(/event_type\s+text\s+NOT\s+NULL\s+CHECK\s*\(event_type\s+IN\s*\(([\s\S]*?)\)\s*\)/i);
  if (!match) {
    failures.push("missing events_outbox event_type CHECK");
    return [];
  }
  return stringsIn(match[1]).sort();
}

function stringsIn(source) {
  return unique([...source.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort());
}

function expectEqualArray(label, actual, expected) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  const missing = right.filter((value) => !left.includes(value));
  const extra = left.filter((value) => !right.includes(value));
  if (missing.length || extra.length) {
    failures.push(`${label} mismatch; missing=[${missing.join(", ")}] extra=[${extra.join(", ")}]`);
  }
}

function requireIn(label, source, needle) {
  if (!source.includes(needle)) failures.push(`${label}: missing ${JSON.stringify(needle)}`);
}

function requireRegex(label, source, pattern) {
  if (!pattern.test(source)) failures.push(`${label}: missing ${pattern}`);
}

function rejectRegex(label, source, pattern) {
  if (pattern.test(source)) failures.push(`${label}: forbidden ${pattern}`);
}

function unique(values) {
  return [...new Set(values)];
}

function stripSqlComments(source) {
  let out = "";
  let i = 0;
  let quote = null;
  let dollarTag = null;

  while (i < source.length) {
    const next = source.slice(i, i + 2);

    if (!quote && !dollarTag && next === "--") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }

    if (!quote && !dollarTag && next === "/*") {
      i += 2;
      while (i < source.length && source.slice(i, i + 2) !== "*/") i += 1;
      i += 2;
      out += " ";
      continue;
    }

    if (!quote && !dollarTag && source[i] === "$") {
      const match = source.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        dollarTag = match[0];
        out += dollarTag;
        i += dollarTag.length;
        continue;
      }
    } else if (dollarTag && source.startsWith(dollarTag, i)) {
      out += dollarTag;
      i += dollarTag.length;
      dollarTag = null;
      continue;
    }

    if (!dollarTag && !quote && (source[i] === "'" || source[i] === '"')) {
      quote = source[i];
      out += source[i];
      i += 1;
      continue;
    }

    if (!dollarTag && quote && source[i] === quote) {
      out += source[i];
      if (source[i + 1] === quote) {
        out += source[i + 1];
        i += 2;
        continue;
      }
      quote = null;
      i += 1;
      continue;
    }

    out += source[i];
    i += 1;
  }

  return out;
}
