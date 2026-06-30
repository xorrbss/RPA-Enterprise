#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DB = join(ROOT, "db");
const appRequire = createRequire(join(ROOT, "app", "package.json"));
const psql = process.env.PSQL_BIN?.trim() || (process.platform === "win32" ? "psql.exe" : "psql");

const migrations = [
  { version: "0001", name: "migration_concurrency_idempotency.sql" },
  { version: "0002", name: "migration_core_entities.sql" },
];

const baselineCoreTables = [
  "credential_concurrency_policies",
  "credential_binding_events",
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
  "ai_governance_evidence",
  "ai_runtime_policies",
  "control_plane_idempotency_keys",
  "scenarios",
  "scenario_versions",
  "scenario_releases",
  "scenario_environment_bindings",
  "scenario_release_events",
  "process_mining_imports",
  "automation_ideas",
  "roi_estimates",
  "run_triggers",
  "run_trigger_fires",
  "scenario_generations",
  "workitems",
  "runs",
  "run_reruns",
  "run_pause_requests",
  "run_steps",
  "human_tasks",
  "scim_providers",
  "scim_group_role_mappings",
  "principals",
  "principal_role_assignments",
  "principal_role_assignment_events",
  "artifacts",
  "document_jobs",
  "document_extractions",
  "events_outbox",
  "ops_alert_acknowledgements",
  "dead_letter",
  "action_plan_cache",
  "stagehand_calls",
  "scenario_generation_llm_calls",
  "audit_log",
  "audit_verifier_runs",
  "scenario_promotion_requests",
  "worker_pools",
  "worker_pool_assignments",
  "worker_pool_memberships",
];

const args = new Set(process.argv.slice(2));
const allowedArgs = new Set(["--baseline-existing", "--graphile-worker", "--smoke", "--require-non-bypass", "--help", "-h"]);
const unknownArgs = [...args].filter((arg) => !allowedArgs.has(arg));
if (unknownArgs.length > 0) {
  fail([`unknown option(s): ${unknownArgs.join(", ")}`], 2);
}

if (args.has("--help") || args.has("-h")) {
  printUsage();
  process.exit(0);
}

const baselineExisting = args.has("--baseline-existing");
const runGraphileWorkerAfter = args.has("--graphile-worker");
const runSmokeAfter = args.has("--smoke");
const requireNonBypass = args.has("--require-non-bypass");

await main();

async function main() {
  const plans = await Promise.all(
    migrations.map(async (migration) => ({
      ...migration,
      path: join(DB, migration.name),
      checksum: await checksumFile(join(DB, migration.name)),
    })),
  );

  assertPostgres15Client();
  const serverInfo = readServerInfo();
  assertPostgres15Server(serverInfo);
  enforceNonBypassIfRequested(serverInfo);

  console.log(`db migrate: target ${describePgTarget()} as ${serverInfo.user}, PostgreSQL ${serverInfo.serverVersion}`);
  ensureLedger();

  const existing = readLedger();
  const coreState = readCoreSchemaState();

  if (existing.size === 0 && coreState.anyCoreTable) {
    if (!baselineExisting) {
      fail([
        "public schema already contains RPA core tables but schema_migrations is empty.",
        "Run with --baseline-existing only after verifying this database is an expected existing deployment.",
      ], 2);
    }
    verifyBaselineShape();
    baselineLedger(plans);
  } else {
    applyPendingMigrations(plans, existing);
  }

  verifyBaselineShape();
  if (runGraphileWorkerAfter) await runGraphileWorkerMigrations();
  if (runSmokeAfter) runMigrationSmoke();
  console.log("db migrate: complete");
}

function applyPendingMigrations(plans, existing) {
  for (let index = 0; index < plans.length; index += 1) {
    const migration = plans[index];
    const row = existing.get(migration.version);
    if (row !== undefined) {
      if (row.status !== "applied") {
        fail([`migration ${migration.version} ${migration.name} has non-applied status ${row.status}`], 2);
      }
      if (row.checksum !== migration.checksum) {
        fail([
          `checksum drift for migration ${migration.version} ${migration.name}`,
          `ledger=${row.checksum}`,
          `file=${migration.checksum}`,
        ], 2);
      }
      console.log(`db migrate: ${migration.version} ${migration.name} already applied`);
      continue;
    }

    const missingPrior = plans.slice(0, index).filter((prior) => !existing.has(prior.version));
    if (missingPrior.length > 0) {
      fail([
        `cannot apply ${migration.version} ${migration.name} before prior migration(s): ${missingPrior.map((m) => m.version).join(", ")}`,
      ], 2);
    }

    applyMigration(migration);
    existing.set(migration.version, {
      checksum: migration.checksum,
      status: "applied",
      baseline: "false",
    });
  }
}

function applyMigration(migration) {
  console.log(`db migrate: applying ${migration.version} ${migration.name}`);
  const wrapper = [
    "\\set ON_ERROR_STOP on",
    "BEGIN;",
    `\\i '${psqlPath(migration.path)}'`,
    `INSERT INTO schema_migrations (version, name, checksum, applied_at, applied_by, duration_ms, status, baseline)`,
    `VALUES (${sqlString(migration.version)}, ${sqlString(migration.name)}, ${sqlString(migration.checksum)}, now(), current_user, 0, 'applied', false);`,
    "COMMIT;",
    "",
  ].join("\n");
  runPsqlFile(wrapper, `apply ${migration.version} ${migration.name}`);
}

function baselineLedger(plans) {
  console.log("db migrate: baselining existing schema without rerunning DDL");
  const values = plans
    .map((migration) =>
      `(${sqlString(migration.version)}, ${sqlString(migration.name)}, ${sqlString(migration.checksum)}, now(), current_user, 0, 'applied', true)`,
    )
    .join(",\n");
  execSql(
    `INSERT INTO schema_migrations (version, name, checksum, applied_at, applied_by, duration_ms, status, baseline)
     VALUES ${values}
     ON CONFLICT (version) DO NOTHING;`,
    "baseline schema_migrations",
  );
}

function ensureLedger() {
  execSql(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version text PRIMARY KEY,
       name text NOT NULL,
       checksum text NOT NULL CHECK (checksum ~ '^sha256:[0-9a-f]{64}$'),
       applied_at timestamptz NOT NULL DEFAULT now(),
       applied_by text NOT NULL DEFAULT current_user,
       duration_ms int NOT NULL CHECK (duration_ms >= 0),
       status text NOT NULL CHECK (status IN ('applied','failed')),
       baseline boolean NOT NULL DEFAULT false
     );`,
    "ensure schema_migrations ledger",
  );
}

function readLedger() {
  const output = queryScalar(
    `SELECT version || E'\\t' || checksum || E'\\t' || status || E'\\t' || baseline::text
       FROM schema_migrations
      ORDER BY version`,
    "read schema_migrations",
  );
  const rows = new Map();
  for (const line of output.split("\n").map((value) => value.trim()).filter(Boolean)) {
    const [version, checksum, status, baseline] = line.split("\t");
    rows.set(version, { checksum, status, baseline });
  }
  return rows;
}

function readCoreSchemaState() {
  const tableList = sqlArray(baselineCoreTables);
  const output = queryScalar(
    `WITH required AS (
       SELECT unnest(ARRAY[${tableList}]) AS table_name
     ),
     present AS (
       SELECT r.table_name
         FROM required r
         JOIN information_schema.tables t
           ON t.table_schema = 'public'
          AND t.table_name = r.table_name
     )
     SELECT (SELECT count(*) FROM present)::text
            || E'\\t' || (SELECT count(*) FROM required)::text`,
    "inspect existing public schema",
  );
  const [present, required] = output.trim().split("\t").map((value) => Number(value));
  return {
    anyCoreTable: present > 0,
    present,
    required,
  };
}

function verifyBaselineShape() {
  const expectedSchema = `rpa_baseline_expected_${process.pid}_${Date.now()}`.slice(0, 60);
  console.log("db migrate: verifying public schema against migration catalog shape");
  runPsqlFile(baselineVerificationSql(expectedSchema), "deep verify existing DB baseline");
  console.log("db migrate: baseline catalog verification passed");
}

function baselineVerificationSql(expectedSchema) {
  const includeLines = migrations.map((migration) => `\\i '${psqlPath(join(DB, migration.name))}'`);
  return [
    "\\set ON_ERROR_STOP on",
    "BEGIN;",
    `CREATE SCHEMA ${sqlIdentifier(expectedSchema)};`,
    `SET LOCAL search_path = ${sqlIdentifier(expectedSchema)}, public;`,
    ...includeLines,
    "SET LOCAL search_path = pg_catalog, public;",
    `DO $baseline$`,
    `DECLARE`,
    `  expected_schema text := ${sqlString(expectedSchema)};`,
    `  actual_schema text := 'public';`,
    `  problems text[];`,
    `BEGIN`,
    `  PERFORM set_config('search_path', format('%I, %I, pg_catalog', expected_schema, actual_schema), true);`,
    ``,
    `  WITH expected AS (`,
    `    SELECT c.relname`,
    `      FROM pg_class c`,
    `      JOIN pg_namespace n ON n.oid = c.relnamespace`,
    `     WHERE n.nspname = expected_schema`,
    `       AND c.relkind IN ('r','p')`,
    `  ), actual AS (`,
    `    SELECT c.relname`,
    `      FROM pg_class c`,
    `      JOIN pg_namespace n ON n.oid = c.relnamespace`,
    `     WHERE n.nspname = actual_schema`,
    `       AND c.relkind IN ('r','p')`,
    `  )`,
    `  SELECT array_agg(e.relname ORDER BY e.relname) INTO problems`,
    `    FROM expected e`,
    `   WHERE NOT EXISTS (SELECT 1 FROM actual a WHERE a.relname = e.relname);`,
    `  IF problems IS NOT NULL THEN`,
    `    RAISE EXCEPTION 'existing DB baseline rejected: missing table(s): %', array_to_string(problems, ', ');`,
    `  END IF;`,
    ``,
    `  WITH expected AS (`,
    `    SELECT c.relname AS table_name, a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS data_type,`,
    `           a.attnotnull, COALESCE(pg_get_expr(d.adbin, d.adrelid), '') AS default_expr`,
    `      FROM pg_class c`,
    `      JOIN pg_namespace n ON n.oid = c.relnamespace`,
    `      JOIN pg_attribute a ON a.attrelid = c.oid`,
    `      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum`,
    `     WHERE n.nspname = expected_schema`,
    `       AND c.relkind IN ('r','p')`,
    `       AND a.attnum > 0`,
    `       AND NOT a.attisdropped`,
    `  ), actual AS (`,
    `    SELECT c.relname AS table_name, a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS data_type,`,
    `           a.attnotnull, COALESCE(pg_get_expr(d.adbin, d.adrelid), '') AS default_expr`,
    `      FROM pg_class c`,
    `      JOIN pg_namespace n ON n.oid = c.relnamespace`,
    `      JOIN pg_attribute a ON a.attrelid = c.oid`,
    `      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum`,
    `     WHERE n.nspname = actual_schema`,
    `       AND c.relkind IN ('r','p')`,
    `       AND a.attnum > 0`,
    `       AND NOT a.attisdropped`,
    `  )`,
    `  SELECT array_agg(format('%I.%I expected %s not_null=%s default=%s got %s not_null=%s default=%s',`,
    `                          e.table_name, e.column_name, e.data_type, e.attnotnull, NULLIF(e.default_expr, ''),`,
    `                          a.data_type, a.attnotnull, NULLIF(a.default_expr, '')) ORDER BY e.table_name, e.column_name)`,
    `    INTO problems`,
    `    FROM expected e`,
    `    LEFT JOIN actual a ON a.table_name = e.table_name AND a.column_name = e.column_name`,
    `   WHERE a.column_name IS NULL`,
    `      OR a.data_type <> e.data_type`,
    `      OR a.attnotnull <> e.attnotnull`,
    `      OR a.default_expr IS DISTINCT FROM e.default_expr;`,
    `  IF problems IS NOT NULL THEN`,
    `    RAISE EXCEPTION 'existing DB baseline rejected: column drift: %', array_to_string(problems, '; ');`,
    `  END IF;`,
    ``,
    `  WITH expected AS (`,
    `    SELECT c.relname AS table_name, a.attname AS column_name`,
    `      FROM pg_class c`,
    `      JOIN pg_namespace n ON n.oid = c.relnamespace`,
    `      JOIN pg_attribute a ON a.attrelid = c.oid`,
    `     WHERE n.nspname = expected_schema`,
    `       AND c.relkind IN ('r','p')`,
    `       AND a.attnum > 0`,
    `       AND NOT a.attisdropped`,
    `  ), actual AS (`,
    `    SELECT c.relname AS table_name, a.attname AS column_name`,
    `      FROM pg_class c`,
    `      JOIN pg_namespace n ON n.oid = c.relnamespace`,
    `      JOIN pg_attribute a ON a.attrelid = c.oid`,
    `     WHERE n.nspname = actual_schema`,
    `       AND c.relkind IN ('r','p')`,
    `       AND a.attnum > 0`,
    `       AND NOT a.attisdropped`,
    `  )`,
    `  SELECT array_agg(format('%I.%I', a.table_name, a.column_name) ORDER BY a.table_name, a.column_name)`,
    `    INTO problems`,
    `    FROM actual a`,
    `   WHERE EXISTS (SELECT 1 FROM expected e WHERE e.table_name = a.table_name)`,
    `     AND NOT EXISTS (SELECT 1 FROM expected e WHERE e.table_name = a.table_name AND e.column_name = a.column_name);`,
    `  IF problems IS NOT NULL THEN`,
    `    RAISE EXCEPTION 'existing DB baseline rejected: unexpected column(s): %', array_to_string(problems, ', ');`,
    `  END IF;`,
    ``,
    `  WITH expected AS (`,
    `    SELECT t.relname AS table_name, con.contype,`,
    `           lower(regexp_replace(replace(replace(pg_get_constraintdef(con.oid), expected_schema || '.', ''), actual_schema || '.', ''), '\\s+', ' ', 'g')) AS definition`,
    `      FROM pg_constraint con`,
    `      JOIN pg_class t ON t.oid = con.conrelid`,
    `      JOIN pg_namespace n ON n.oid = t.relnamespace`,
    `     WHERE n.nspname = expected_schema`,
    `       AND con.contype IN ('p','u','f','c')`,
    `  ), actual AS (`,
    `    SELECT t.relname AS table_name, con.contype,`,
    `           lower(regexp_replace(replace(replace(pg_get_constraintdef(con.oid), expected_schema || '.', ''), actual_schema || '.', ''), '\\s+', ' ', 'g')) AS definition`,
    `      FROM pg_constraint con`,
    `      JOIN pg_class t ON t.oid = con.conrelid`,
    `      JOIN pg_namespace n ON n.oid = t.relnamespace`,
    `     WHERE n.nspname = actual_schema`,
    `       AND con.contype IN ('p','u','f','c')`,
    `  )`,
    `  SELECT array_agg(format('%I %s %s', e.table_name, e.contype, e.definition) ORDER BY e.table_name, e.definition)`,
    `    INTO problems`,
    `    FROM expected e`,
    `   WHERE NOT EXISTS (`,
    `     SELECT 1 FROM actual a`,
    `      WHERE a.table_name = e.table_name`,
    `        AND a.contype = e.contype`,
    `        AND a.definition = e.definition`,
    `   );`,
    `  IF problems IS NOT NULL THEN`,
    `    RAISE EXCEPTION 'existing DB baseline rejected: missing constraint(s): %', array_to_string(problems, '; ');`,
    `  END IF;`,
    ``,
    `  WITH expected AS (`,
    `    SELECT t.relname AS table_name, i.relname AS index_name,`,
    `           lower(regexp_replace(replace(replace(pg_get_indexdef(i.oid), expected_schema || '.', ''), actual_schema || '.', ''), '\\s+', ' ', 'g')) AS definition`,
    `      FROM pg_index x`,
    `      JOIN pg_class t ON t.oid = x.indrelid`,
    `      JOIN pg_class i ON i.oid = x.indexrelid`,
    `      JOIN pg_namespace n ON n.oid = t.relnamespace`,
    `     WHERE n.nspname = expected_schema`,
    `  ), actual AS (`,
    `    SELECT t.relname AS table_name, i.relname AS index_name,`,
    `           lower(regexp_replace(replace(replace(pg_get_indexdef(i.oid), expected_schema || '.', ''), actual_schema || '.', ''), '\\s+', ' ', 'g')) AS definition`,
    `      FROM pg_index x`,
    `      JOIN pg_class t ON t.oid = x.indrelid`,
    `      JOIN pg_class i ON i.oid = x.indexrelid`,
    `      JOIN pg_namespace n ON n.oid = t.relnamespace`,
    `     WHERE n.nspname = actual_schema`,
    `  )`,
    `  SELECT array_agg(format('%I.%I', e.table_name, e.index_name) ORDER BY e.table_name, e.index_name)`,
    `    INTO problems`,
    `    FROM expected e`,
    `   WHERE NOT EXISTS (`,
    `     SELECT 1 FROM actual a`,
    `      WHERE a.table_name = e.table_name`,
    `        AND a.index_name = e.index_name`,
    `        AND a.definition = e.definition`,
    `   );`,
    `  IF problems IS NOT NULL THEN`,
    `    RAISE EXCEPTION 'existing DB baseline rejected: missing index/idempotency shape(s): %', array_to_string(problems, ', ');`,
    `  END IF;`,
    ``,
    `  WITH fk AS (`,
    `    SELECT n.nspname, t.relname AS table_name, rt.relname AS referenced_table,`,
    `           ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS source_columns,`,
    `           ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS referenced_columns`,
    `      FROM pg_constraint con`,
    `      JOIN pg_class t ON t.oid = con.conrelid`,
    `      JOIN pg_class rt ON rt.oid = con.confrelid`,
    `      JOIN pg_namespace n ON n.oid = t.relnamespace`,
    `     WHERE con.contype = 'f'`,
    `  ), expected AS (`,
    `    SELECT * FROM fk WHERE nspname = expected_schema`,
    `  ), actual AS (`,
    `    SELECT * FROM fk WHERE nspname = actual_schema`,
    `  )`,
    `  SELECT array_agg(format('%I (%s) -> %I (%s)', e.table_name, array_to_string(e.source_columns, ','), e.referenced_table, array_to_string(e.referenced_columns, ',')) ORDER BY e.table_name)`,
    `    INTO problems`,
    `    FROM expected e`,
    `   WHERE 'tenant_id' = ANY(e.source_columns)`,
    `     AND array_length(e.source_columns, 1) > 1`,
    `     AND NOT EXISTS (`,
    `       SELECT 1 FROM actual a`,
    `        WHERE a.table_name = e.table_name`,
    `          AND a.referenced_table = e.referenced_table`,
    `          AND a.source_columns = e.source_columns`,
    `          AND a.referenced_columns = e.referenced_columns`,
    `     );`,
    `  IF problems IS NOT NULL THEN`,
    `    RAISE EXCEPTION 'existing DB baseline rejected: missing tenant composite FK(s): %', array_to_string(problems, '; ');`,
    `  END IF;`,
    ``,
    `  WITH expected AS (`,
    `    SELECT c.relname AS table_name, c.relrowsecurity, c.relforcerowsecurity`,
    `      FROM pg_class c`,
    `      JOIN pg_namespace n ON n.oid = c.relnamespace`,
    `     WHERE n.nspname = expected_schema`,
    `       AND c.relkind IN ('r','p')`,
    `       AND (c.relrowsecurity OR c.relforcerowsecurity)`,
    `  ), actual AS (`,
    `    SELECT c.relname AS table_name, c.relrowsecurity, c.relforcerowsecurity`,
    `      FROM pg_class c`,
    `      JOIN pg_namespace n ON n.oid = c.relnamespace`,
    `     WHERE n.nspname = actual_schema`,
    `       AND c.relkind IN ('r','p')`,
    `  )`,
    `  SELECT array_agg(format('%I expected rls=%s force=%s got rls=%s force=%s', e.table_name, e.relrowsecurity, e.relforcerowsecurity, a.relrowsecurity, a.relforcerowsecurity) ORDER BY e.table_name)`,
    `    INTO problems`,
    `    FROM expected e`,
    `    LEFT JOIN actual a ON a.table_name = e.table_name`,
    `   WHERE a.table_name IS NULL`,
    `      OR a.relrowsecurity <> e.relrowsecurity`,
    `      OR a.relforcerowsecurity <> e.relforcerowsecurity;`,
    `  IF problems IS NOT NULL THEN`,
    `    RAISE EXCEPTION 'existing DB baseline rejected: tenant RLS/FORCE RLS shape mismatch: %', array_to_string(problems, '; ');`,
    `  END IF;`,
    ``,
    `  WITH expected AS (`,
    `    SELECT t.relname AS table_name, p.polname, p.polcmd, p.polpermissive,`,
    `           lower(regexp_replace(replace(replace(COALESCE(pg_get_expr(p.polqual, p.polrelid), ''), expected_schema || '.', ''), actual_schema || '.', ''), '\\s+', ' ', 'g')) AS using_expr,`,
    `           lower(regexp_replace(replace(replace(COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), ''), expected_schema || '.', ''), actual_schema || '.', ''), '\\s+', ' ', 'g')) AS check_expr`,
    `      FROM pg_policy p`,
    `      JOIN pg_class t ON t.oid = p.polrelid`,
    `      JOIN pg_namespace n ON n.oid = t.relnamespace`,
    `     WHERE n.nspname = expected_schema`,
    `  ), actual AS (`,
    `    SELECT t.relname AS table_name, p.polname, p.polcmd, p.polpermissive,`,
    `           lower(regexp_replace(replace(replace(COALESCE(pg_get_expr(p.polqual, p.polrelid), ''), expected_schema || '.', ''), actual_schema || '.', ''), '\\s+', ' ', 'g')) AS using_expr,`,
    `           lower(regexp_replace(replace(replace(COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), ''), expected_schema || '.', ''), actual_schema || '.', ''), '\\s+', ' ', 'g')) AS check_expr`,
    `      FROM pg_policy p`,
    `      JOIN pg_class t ON t.oid = p.polrelid`,
    `      JOIN pg_namespace n ON n.oid = t.relnamespace`,
    `     WHERE n.nspname = actual_schema`,
    `  )`,
    `  SELECT array_agg(format('%I.%I', e.table_name, e.polname) ORDER BY e.table_name, e.polname)`,
    `    INTO problems`,
    `    FROM expected e`,
    `   WHERE NOT EXISTS (`,
    `     SELECT 1 FROM actual a`,
    `      WHERE a.table_name = e.table_name`,
    `        AND a.polname = e.polname`,
    `        AND a.polcmd = e.polcmd`,
    `        AND a.polpermissive = e.polpermissive`,
    `        AND a.using_expr = e.using_expr`,
    `        AND a.check_expr = e.check_expr`,
    `   );`,
    `  IF problems IS NOT NULL THEN`,
    `    RAISE EXCEPTION 'existing DB baseline rejected: missing or drifted RLS policy body: %', array_to_string(problems, ', ');`,
    `  END IF;`,
    ``,
    `  WITH actual_policy_body AS (`,
    `    SELECT t.relname AS table_name, p.polname,`,
    `           lower(regexp_replace(COALESCE(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), ''), '\\s+', ' ', 'g')) AS body`,
    `      FROM pg_policy p`,
    `      JOIN pg_class t ON t.oid = p.polrelid`,
    `      JOIN pg_namespace n ON n.oid = t.relnamespace`,
    `     WHERE n.nspname = actual_schema`,
    `       AND EXISTS (`,
    `         SELECT 1`,
    `           FROM pg_policy ep`,
    `           JOIN pg_class et ON et.oid = ep.polrelid`,
    `           JOIN pg_namespace en ON en.oid = et.relnamespace`,
    `          WHERE en.nspname = expected_schema`,
    `            AND et.relname = t.relname`,
    `            AND ep.polname = p.polname`,
    `       )`,
    `  )`,
    `  SELECT array_agg(format('%I.%I body=%s', table_name, polname, body) ORDER BY table_name, polname)`,
    `    INTO problems`,
    `    FROM actual_policy_body`,
    `   WHERE body !~ 'current_setting\\(''app\\.tenant_id''(::text)?\\)'`,
    `      OR body ~ 'current_setting\\([^)]*,[[:space:]]*true\\)'`,
    `      OR body ~ '(^|[[:space:]\\(])true([[:space:]\\)]|$)';`,
    `  IF problems IS NOT NULL THEN`,
    `    RAISE EXCEPTION 'existing DB baseline rejected: RLS policies must use strict current_setting(''app.tenant_id'') and must not allow true/fallback: %', array_to_string(problems, '; ');`,
    `  END IF;`,
    ``,
    `  WITH expected AS (`,
    `    SELECT t.relname AS table_name, tg.tgname, tg.tgtype, p.proname`,
    `      FROM pg_trigger tg`,
    `      JOIN pg_class t ON t.oid = tg.tgrelid`,
    `      JOIN pg_namespace n ON n.oid = t.relnamespace`,
    `      JOIN pg_proc p ON p.oid = tg.tgfoid`,
    `     WHERE n.nspname = expected_schema`,
    `       AND NOT tg.tgisinternal`,
    `  ), actual AS (`,
    `    SELECT t.relname AS table_name, tg.tgname, tg.tgtype, p.proname`,
    `      FROM pg_trigger tg`,
    `      JOIN pg_class t ON t.oid = tg.tgrelid`,
    `      JOIN pg_namespace n ON n.oid = t.relnamespace`,
    `      JOIN pg_proc p ON p.oid = tg.tgfoid`,
    `     WHERE n.nspname = actual_schema`,
    `       AND NOT tg.tgisinternal`,
    `  )`,
    `  SELECT array_agg(format('%I.%I', e.table_name, e.tgname) ORDER BY e.table_name, e.tgname)`,
    `    INTO problems`,
    `    FROM expected e`,
    `   WHERE NOT EXISTS (`,
    `     SELECT 1 FROM actual a`,
    `      WHERE a.table_name = e.table_name`,
    `        AND a.tgname = e.tgname`,
    `        AND a.tgtype = e.tgtype`,
    `        AND a.proname = e.proname`,
    `   );`,
    `  IF problems IS NOT NULL THEN`,
    `    RAISE EXCEPTION 'existing DB baseline rejected: missing trigger(s): %', array_to_string(problems, ', ');`,
    `  END IF;`,
    ``,
    `  IF NOT EXISTS (`,
    `    SELECT 1`,
    `      FROM pg_trigger tg`,
    `      JOIN pg_class t ON t.oid = tg.tgrelid`,
    `      JOIN pg_namespace n ON n.oid = t.relnamespace`,
    `      JOIN pg_proc p ON p.oid = tg.tgfoid`,
    `     WHERE n.nspname = actual_schema`,
    `       AND t.relname = 'audit_log'`,
    `       AND tg.tgname = 'trg_audit_log_append_only'`,
    `       AND NOT tg.tgisinternal`,
    `       AND (tg.tgtype & 1) = 1`,
    `       AND (tg.tgtype & 2) = 2`,
    `       AND (tg.tgtype & 8) = 8`,
    `       AND (tg.tgtype & 16) = 16`,
    `       AND p.proname = 'prevent_audit_log_mutation'`,
    `       AND pg_get_functiondef(p.oid) LIKE '%audit_log is append-only%'`,
    `  ) THEN`,
    `    RAISE EXCEPTION 'existing DB baseline rejected: audit_log append-only UPDATE/DELETE trigger is missing or weakened';`,
    `  END IF;`,
    `END`,
    `$baseline$;`,
    "ROLLBACK;",
    "",
  ].join("\n");
}

function runMigrationSmoke() {
  const smokeArgs = ["scripts/db-migration-smoke.mjs"];
  if (requireNonBypass) smokeArgs.push("--require-non-bypass");
  console.log(`db migrate: running migration smoke (${smokeArgs.join(" ")})`);
  const result = spawnSync(process.execPath, smokeArgs, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    fail(["migration smoke failed after migration run"], result.status ?? 1);
  }
}

async function runGraphileWorkerMigrations() {
  console.log("db migrate: applying graphile-worker schema migrations");
  let graphileWorker;
  try {
    graphileWorker = appRequire("graphile-worker");
  } catch (err) {
    fail([
      "graphile-worker package is required for --graphile-worker.",
      "Run npm install --prefix app, or execute this inside the runtime image.",
      String(err),
    ], 2);
  }
  await graphileWorker.runMigrations({ connectionString: graphileConnectionString() });
  grantGraphileRuntimePrivileges();
}

function grantGraphileRuntimePrivileges() {
  execSql(
    [
      `DO $$`,
      `BEGIN`,
      `  IF to_regnamespace('graphile_worker') IS NULL THEN`,
      `    RAISE EXCEPTION 'graphile_worker schema is missing after graphile migration';`,
      `  END IF;`,
      `END $$;`,
      `GRANT USAGE ON SCHEMA graphile_worker TO rpa_app, rpa_lifecycle_bypass;`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA graphile_worker TO rpa_app, rpa_lifecycle_bypass;`,
      `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA graphile_worker TO rpa_app, rpa_lifecycle_bypass;`,
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA graphile_worker TO rpa_app, rpa_lifecycle_bypass;`,
    ].join("\n"),
    "grant graphile-worker runtime privileges",
  );
}

function assertPostgres15Client() {
  const result = runPsql(["--version"], "detect PostgreSQL client", { capture: true, noConnection: true });
  const match = result.stdout.match(/\(PostgreSQL\)\s+(\d+)(?:\.(\d+))?/);
  if (!match) fail([`unable to parse psql version output: ${result.stdout.trim()}`], 2);
  if (Number(match[1]) < 15) fail([`PostgreSQL 15+ client is required; found ${result.stdout.trim()}`], 2);
}

function readServerInfo() {
  const sql = [
    "SELECT",
    "current_setting('server_version_num')",
    "|| E'\\t' || current_setting('server_version')",
    "|| E'\\t' || current_database()",
    "|| E'\\t' || current_user",
    "|| E'\\t' || COALESCE((SELECT (rolsuper OR rolbypassrls)::text FROM pg_roles WHERE rolname = current_user), 'unknown')",
  ].join(" ");
  const output = queryScalar(sql, "connect to PostgreSQL server");
  const [serverVersionNum, serverVersion, database, user, bypassesRls] = output.trim().split("\t");
  if (!serverVersionNum || !serverVersion || !database || !user || !bypassesRls) {
    fail([`unexpected PostgreSQL preflight output: ${JSON.stringify(output.trim())}`], 2);
  }
  return { serverVersionNum, serverVersion, database, user, bypassesRls };
}

function assertPostgres15Server(serverInfo) {
  const serverVersionNum = Number(serverInfo.serverVersionNum);
  if (!Number.isInteger(serverVersionNum) || serverVersionNum < 150000) {
    fail([
      `PostgreSQL 15+ server is required; found ${serverInfo.serverVersion} (${serverInfo.serverVersionNum}).`,
    ], 2);
  }
}

function enforceNonBypassIfRequested(serverInfo) {
  if (!requireNonBypass) return;
  if (serverInfo.bypassesRls === "true") {
    fail(["current role has SUPERUSER or BYPASSRLS, but --require-non-bypass was set"], 2);
  }
  if (serverInfo.bypassesRls !== "false") {
    fail(["could not prove current role BYPASSRLS status, but --require-non-bypass was set"], 2);
  }
}

function queryScalar(sql, diagnostic) {
  return runPsql(["-Atqc", sql], diagnostic, { capture: true }).stdout.trim();
}

function execSql(sql, diagnostic) {
  runPsql(["-c", sql], diagnostic, { capture: false });
}

function runPsqlFile(sql, diagnostic) {
  const dir = mkdtempSync(join(tmpdir(), "rpa-db-migrate-"));
  const file = join(dir, "migration-wrapper.sql");
  try {
    writeFileSync(file, sql, "utf8");
    runPsql(["-f", file], diagnostic, { capture: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runPsql(args, diagnostic, options) {
  const result = spawnSync(psql, ["-X", "-v", "ON_ERROR_STOP=1", ...connectionArgs(options.noConnection), ...args], {
    cwd: ROOT,
    stdio: options.capture ? "pipe" : "inherit",
    env: process.env,
    encoding: "utf8",
  });

  if (result.error?.code === "ENOENT") {
    fail([
      `psql is required for db migration (${diagnostic}).`,
      "Install PostgreSQL 15 client tools, put psql on PATH, or set PSQL_BIN.",
    ], 2);
  }
  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stderr ?? "");
      process.stdout.write(result.stdout ?? "");
    }
    fail([`psql failed while trying to ${diagnostic}.`, `Target: ${describePgTarget()}`], result.status ?? 1);
  }
  return result;
}

function connectionArgs(noConnection) {
  if (noConnection) return [];
  const databaseUrl = process.env.DATABASE_URL?.trim();
  return databaseUrl ? ["-d", databaseUrl] : [];
}

async function checksumFile(file) {
  const body = await readFile(file);
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function sqlArray(values) {
  return values.map(sqlString).join(",");
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function psqlPath(value) {
  return value.replaceAll("\\", "/").replaceAll("'", "''");
}

function describePgTarget() {
  if (process.env.DATABASE_URL?.trim()) return "DATABASE_URL=<set>";
  const host = process.env.PGHOST || "default local socket/localhost";
  const port = process.env.PGPORT || "default";
  const database = process.env.PGDATABASE || "current user default";
  const user = process.env.PGUSER || "current OS user";
  const password = process.env.PGPASSWORD ? "<set>" : "<unset>";
  return `PGHOST=${host} PGPORT=${port} PGDATABASE=${database} PGUSER=${user} PGPASSWORD=${password}`;
}

function graphileConnectionString() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) return databaseUrl;
  const host = process.env.PGHOST?.trim();
  const port = process.env.PGPORT?.trim() || "5432";
  const database = process.env.PGDATABASE?.trim();
  const user = process.env.PGUSER?.trim();
  if (!host || !database || !user) {
    fail([
      "--graphile-worker requires DATABASE_URL or PGHOST/PGDATABASE/PGUSER because graphile-worker runMigrations needs a connection string.",
    ], 2);
  }
  const password = process.env.PGPASSWORD?.trim();
  const auth = password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}` : encodeURIComponent(user);
  return `postgresql://${auth}@${host}:${port}/${encodeURIComponent(database)}`;
}

function printUsage() {
  console.log([
    "Usage: node scripts/db-migrate.mjs [--baseline-existing] [--graphile-worker] [--smoke] [--require-non-bypass]",
    "",
    "Behavior:",
    "  Fresh DB: creates schema_migrations, applies ordered SQL migrations, records checksums.",
    "  Existing DB: with --baseline-existing, verifies core shape and records baseline rows without rerunning DDL.",
    "  Re-run: same checksum is no-op; checksum drift or out-of-order state fails closed.",
    "  Graphile: with --graphile-worker, applies graphile_worker schema migrations and grants runtime queue privileges.",
    "",
    "Environment:",
    "  DATABASE_URL  Optional PostgreSQL connection string. Takes precedence over PG* libpq vars.",
    "  PSQL_BIN      Optional path to PostgreSQL 15+ psql.",
    "  PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD are honored by psql when DATABASE_URL is unset.",
  ].join("\n"));
}

function fail(lines, code) {
  console.error(["FAIL:", ...lines.map((line) => `  ${line}`)].join("\n"));
  process.exit(code);
}
