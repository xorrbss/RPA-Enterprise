\set ON_ERROR_STOP on

\echo 'RPA DB migration smoke: apply migrations in an isolated schema, run contract checks, then rollback.'

BEGIN;

CREATE SCHEMA rpa_migration_smoke;
SET LOCAL search_path = rpa_migration_smoke, public;
SET LOCAL client_min_messages = warning;

DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'RPA migrations require PostgreSQL 15+, current server_version_num=%',
      current_setting('server_version_num');
  END IF;
END $$;

\ir migration_concurrency_idempotency.sql
\ir migration_core_entities.sql

DO $$
DECLARE
  expected_tables text[] := ARRAY[
    'credential_concurrency_policies',
    'credential_leases',
    'browser_leases',
    'browser_sessions',
    'capture_sessions',
    'raw_items',
    'normalized_records',
    'sink_deliveries',
    'challenge_resolution_attempts',
    'site_profiles',
    'site_profile_approvals',
    'browser_identities',
    'network_policies',
    'gateway_policies',
    'control_plane_idempotency_keys',
    'workers',
    'scenarios',
    'scenario_versions',
    'workitems',
    'runs',
    'run_steps',
    'human_tasks',
    'artifacts',
    'events_outbox',
    'dead_letter',
    'action_plan_cache',
    'stagehand_calls',
    'audit_log'
  ];
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY expected_tables LOOP
    IF to_regclass(format('%I.%I', 'rpa_migration_smoke', table_name)) IS NULL THEN
      RAISE EXCEPTION 'migration smoke missing table %', table_name;
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  tenant_tables text[] := ARRAY[
    'credential_concurrency_policies',
    'credential_leases',
    'browser_leases',
    'browser_sessions',
    'capture_sessions',
    'raw_items',
    'normalized_records',
    'sink_deliveries',
    'challenge_resolution_attempts',
    'site_profiles',
    'site_profile_approvals',
    'browser_identities',
    'network_policies',
    'gateway_policies',
    'control_plane_idempotency_keys',
    'scenarios',
    'scenario_versions',
    'workitems',
    'runs',
    'run_steps',
    'human_tasks',
    'events_outbox',
    'dead_letter',
    'action_plan_cache',
    'stagehand_calls',
    'audit_log'
  ];
  table_name text;
  rel_id oid;
  policy_qual text;
  policy_check text;
BEGIN
  FOREACH table_name IN ARRAY tenant_tables LOOP
    SELECT c.oid
      INTO rel_id
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'rpa_migration_smoke'
       AND c.relname = table_name;

    IF rel_id IS NULL THEN
      RAISE EXCEPTION 'missing RLS table %', table_name;
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM pg_class
       WHERE oid = rel_id
         AND relrowsecurity
         AND relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'table % must ENABLE and FORCE RLS', table_name;
    END IF;

    SELECT pg_get_expr(p.polqual, p.polrelid),
           pg_get_expr(p.polwithcheck, p.polrelid)
      INTO policy_qual, policy_check
      FROM pg_policy p
     WHERE p.polrelid = rel_id
       AND p.polname = 'tenant_isolation';

    IF policy_qual IS NULL OR policy_check IS NULL THEN
      RAISE EXCEPTION 'table % missing tenant_isolation policy', table_name;
    END IF;

    IF policy_qual !~ 'current_setting'
       OR policy_qual !~ 'app\.tenant_id'
       OR policy_qual ~ ',[[:space:]]*true'
       OR policy_check !~ 'current_setting'
       OR policy_check !~ 'app\.tenant_id'
       OR policy_check ~ ',[[:space:]]*true' THEN
      RAISE EXCEPTION 'table % must use strict current_setting(''app.tenant_id'') in RLS policy: USING %, CHECK %',
        table_name, policy_qual, policy_check;
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  has_raw_nulls_not_distinct boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'rpa_migration_smoke'
       AND t.relname = 'raw_items'
       AND i.indisunique
       AND i.indnullsnotdistinct
       AND pg_get_indexdef(i.indexrelid) LIKE '%(tenant_id, connector_id, target_id, source_item_key, raw_hash)%'
  )
    INTO has_raw_nulls_not_distinct;

  IF NOT has_raw_nulls_not_distinct THEN
    RAISE EXCEPTION 'raw_items must have UNIQUE NULLS NOT DISTINCT on tenant/connector/target/source_item_key/raw_hash';
  END IF;
END $$;

DO $$
DECLARE
  payload_table text;
  retention_column text;
BEGIN
  FOREACH payload_table IN ARRAY ARRAY[
    'control_plane_idempotency_keys',
    'raw_items',
    'normalized_records',
    'artifacts',
    'events_outbox',
    'audit_log'
  ]
  LOOP
    FOREACH retention_column IN ARRAY ARRAY['retention_until', 'deleted_at', 'legal_hold']
    LOOP
      IF NOT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'rpa_migration_smoke'
           AND table_name = payload_table
           AND column_name = retention_column
      ) THEN
        RAISE EXCEPTION 'payload-bearing table % missing retention column %', payload_table, retention_column;
      END IF;
    END LOOP;
  END LOOP;
END $$;

DO $$
DECLARE
  rel_id oid;
  select_policy text;
  insert_policy text;
BEGIN
  SELECT c.oid
    INTO rel_id
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'rpa_migration_smoke'
     AND c.relname = 'artifacts';

  IF rel_id IS NULL THEN
    RAISE EXCEPTION 'artifacts table missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_class
     WHERE oid = rel_id
       AND relrowsecurity
       AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'artifacts must ENABLE and FORCE RLS';
  END IF;

  SELECT pg_get_expr(p.polqual, p.polrelid)
    INTO select_policy
    FROM pg_policy p
   WHERE p.polrelid = rel_id
     AND p.polname = 'artifacts_visible_isolation'
     AND p.polcmd = 'r';

  SELECT pg_get_expr(p.polwithcheck, p.polrelid)
    INTO insert_policy
    FROM pg_policy p
   WHERE p.polrelid = rel_id
     AND p.polname = 'artifacts_insert_isolation'
     AND p.polcmd = 'a';

  IF select_policy IS NULL
     OR select_policy !~ 'current_setting'
     OR select_policy !~ 'app\.tenant_id'
     OR select_policy ~ ',[[:space:]]*true'
     OR select_policy !~ 'deleted_at IS NULL'
     OR select_policy !~ 'quarantine = false'
     OR select_policy !~ 'redaction_status'
     OR select_policy !~ 'redacted'
     OR select_policy !~ 'not_required' THEN
    RAISE EXCEPTION 'artifact SELECT policy must enforce tenant + redaction + quarantine + soft-delete gate: %', select_policy;
  END IF;

  IF insert_policy IS NULL
     OR insert_policy !~ 'current_setting'
     OR insert_policy !~ 'app\.tenant_id'
     OR insert_policy !~ 'lifecycle_claim_id IS NULL'
     OR insert_policy !~ 'lifecycle_claim_kind IS NULL'
     OR insert_policy !~ 'lifecycle_claim_worker_id IS NULL'
     OR insert_policy !~ 'lifecycle_claim_correlation_id IS NULL'
     OR insert_policy !~ 'lifecycle_claimed_at IS NULL'
     OR insert_policy !~ 'lifecycle_claim_expires_at IS NULL'
     OR insert_policy ~ ',[[:space:]]*true' THEN
    RAISE EXCEPTION 'artifact INSERT policy must use strict tenant isolation and reject application-supplied lifecycle claims: %', insert_policy;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_policy p
     WHERE p.polrelid = rel_id
       AND p.polcmd IN ('w','d','*')
  ) THEN
    RAISE EXCEPTION 'artifact UPDATE/DELETE policies must not exist for the application role; lifecycle mutation requires audited operational BYPASSRLS';
  END IF;
END $$;

DO $$
DECLARE
  rel_id oid;
  bypasses_rls boolean;
BEGIN
  SELECT c.oid
    INTO rel_id
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'rpa_migration_smoke'
     AND c.relname = 'workers';

  IF rel_id IS NULL THEN
    RAISE EXCEPTION 'workers table missing';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'rpa_migration_smoke'
       AND table_name = 'workers'
       AND column_name = 'tenant_id'
  ) THEN
    RAISE EXCEPTION 'workers must remain infrastructure-scoped without tenant_id; do not route user traffic through BYPASSRLS infrastructure roles';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_class
     WHERE oid = rel_id
       AND (relrowsecurity OR relforcerowsecurity)
  ) THEN
    RAISE EXCEPTION 'workers must remain outside tenant RLS and inside explicit BYPASSRLS infrastructure domain';
  END IF;

  SELECT rolsuper OR rolbypassrls
    INTO bypasses_rls
    FROM pg_roles
   WHERE rolname = current_user;

  IF bypasses_rls THEN
    RAISE WARNING 'current_user % has SUPERUSER/BYPASSRLS; row-visibility assertions are skipped and Product Open still requires a non-bypass RLS run',
      current_user;
  END IF;
END $$;

DO $$
DECLARE
  tenant_a uuid := '00000000-0000-0000-0000-0000000000a1';
  bypasses_rls boolean;
BEGIN
  SELECT rolsuper OR rolbypassrls
    INTO bypasses_rls
    FROM pg_roles
   WHERE rolname = current_user;

  IF NOT bypasses_rls THEN
    EXECUTE 'RESET app.tenant_id';

    BEGIN
      INSERT INTO site_profiles (id, tenant_id, name, url_pattern)
      VALUES (
        '10000000-0000-0000-0000-0000000000f0',
        tenant_a,
        'rls-missing-tenant',
        'https://rls-missing-tenant.test/*'
      );
      RAISE EXCEPTION 'strict RLS should reject INSERT when app.tenant_id is not set';
    EXCEPTION
      WHEN undefined_object OR invalid_text_representation THEN
        NULL;
    END;
  END IF;
END $$;

DO $$
DECLARE
  tenant_a uuid := '00000000-0000-0000-0000-0000000000a1';
  tenant_b uuid := '00000000-0000-0000-0000-0000000000b2';
  site_id uuid := '10000000-0000-0000-0000-000000000001';
  browser_identity_id uuid := '10000000-0000-0000-0000-000000000002';
  scenario_id uuid := '10000000-0000-0000-0000-000000000003';
  scenario_version_id uuid := '10000000-0000-0000-0000-000000000004';
  workitem_1 uuid := '10000000-0000-0000-0000-000000000005';
  workitem_2 uuid := '10000000-0000-0000-0000-000000000006';
  run_1 uuid := '10000000-0000-0000-0000-000000000007';
  run_2 uuid := '10000000-0000-0000-0000-000000000008';
  run_duplicate_workitem uuid := '10000000-0000-0000-0000-000000000016';
  worker_id uuid := '10000000-0000-0000-0000-000000000009';
  browser_lease_id uuid := '10000000-0000-0000-0000-000000000010';
  raw_item_id uuid := '10000000-0000-0000-0000-000000000011';
  target_id uuid := '10000000-0000-0000-0000-000000000012';
  smoke_event_id uuid := '10000000-0000-0000-0000-000000000013';
  run_step_1 uuid := '10000000-0000-0000-0000-000000000017';
  run_step_2 uuid := '10000000-0000-0000-0000-000000000018';
  run_step_started uuid := '10000000-0000-0000-0000-000000000036';
  stagehand_call_id uuid := '10000000-0000-0000-0000-000000000019';
  step_event_id uuid := '10000000-0000-0000-0000-000000000022';
  step_started_event_id uuid := '10000000-0000-0000-0000-000000000037';
  audit_1 uuid := '10000000-0000-0000-0000-000000000040';
  audit_2 uuid := '10000000-0000-0000-0000-000000000041';
  scenario_b_id uuid := '10000000-0000-0000-0000-000000000030';
  scenario_version_b_id uuid := '10000000-0000-0000-0000-000000000031';
  workitem_b uuid := '10000000-0000-0000-0000-000000000032';
  run_b uuid := '10000000-0000-0000-0000-000000000033';
  smoke_event_b_id uuid := '10000000-0000-0000-0000-000000000034';
  wrong_worker_id uuid := '10000000-0000-0000-0000-000000000035';
  smoke_retention_until timestamptz := now() + interval '1 day';
  smoke_now timestamptz := now();
  bypasses_rls boolean;
  row_count int;
BEGIN
  SELECT rolsuper OR rolbypassrls
    INTO bypasses_rls
    FROM pg_roles
   WHERE rolname = current_user;

  PERFORM set_config('app.tenant_id', tenant_a::text, true);

  INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved)
  VALUES (site_id, tenant_a, 'smoke-site', 'https://example.test/*', 'green', true);

  INSERT INTO browser_identities (id, tenant_id, site_profile_id, label, version)
  VALUES (browser_identity_id, tenant_a, site_id, 'smoke-browser', 1);

  INSERT INTO scenarios (id, tenant_id, name)
  VALUES (scenario_id, tenant_a, 'smoke-scenario');

  INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
  VALUES (scenario_version_id, tenant_a, scenario_id, 1, 'draft', '{"nodes":[]}'::jsonb);

  INSERT INTO workitems (id, tenant_id, connector_id, unique_reference)
  VALUES
    (workitem_1, tenant_a, 'smoke-connector', 'workitem-1'),
    (workitem_2, tenant_a, 'smoke-connector', 'workitem-2');

  INSERT INTO runs (id, tenant_id, scenario_version_id, workitem_id, status, correlation_id)
  VALUES
    (run_1, tenant_a, scenario_version_id, workitem_1, 'queued', '20000000-0000-0000-0000-000000000001'),
    (run_2, tenant_a, scenario_version_id, workitem_2, 'queued', '20000000-0000-0000-0000-000000000002');

  BEGIN
    INSERT INTO runs (id, tenant_id, scenario_version_id, workitem_id, status, correlation_id)
    VALUES (run_duplicate_workitem, tenant_a, scenario_version_id, workitem_1, 'queued', '20000000-0000-0000-0000-000000000016');
    RAISE EXCEPTION 'runs must reject duplicate workitem_id per tenant';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  INSERT INTO runs (id, tenant_id, scenario_version_id, status, abort_source_status, correlation_id)
  VALUES (
    '10000000-0000-0000-0000-000000000042',
    tenant_a,
    scenario_version_id,
    'aborting',
    'running',
    '20000000-0000-0000-0000-000000000042'
  );

  IF NOT EXISTS (
    SELECT 1
      FROM runs
     WHERE id = '10000000-0000-0000-0000-000000000042'
       AND abort_source_status = 'running'
  ) THEN
    RAISE EXCEPTION 'run abort source status should accept persisted abort source';
  END IF;

  BEGIN
    INSERT INTO runs (id, tenant_id, scenario_version_id, status, abort_source_status, correlation_id)
    VALUES (
      '10000000-0000-0000-0000-000000000043',
      tenant_a,
      scenario_version_id,
      'aborting',
      'queued',
      '20000000-0000-0000-0000-000000000043'
    );
    RAISE EXCEPTION 'run abort source status must reject unknown source';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  INSERT INTO run_steps (id, tenant_id, run_id, step_id, node_id, attempt, action, status)
  VALUES
    (run_step_1, tenant_a, run_1, 'step-1', 'node-1', 0, 'act', 'success'),
    (run_step_2, tenant_a, run_2, 'step-1', 'node-1', 0, 'act', 'success'),
    (run_step_started, tenant_a, run_1, 'step-started', 'node-started', 0, 'extract', 'started');

  INSERT INTO workers (id, kind)
  VALUES (worker_id, 'browser');

  INSERT INTO artifacts (id, tenant_id, run_id, step_id, attempt, type, redaction_status, object_ref, retention_until, quarantine)
  VALUES
    ('10000000-0000-0000-0000-000000000020', tenant_a, run_1, 'step-1', 0, 'screenshot', 'pending', 'obj/pending', smoke_retention_until, false),
    ('10000000-0000-0000-0000-000000000021', tenant_a, run_1, 'step-1', 0, 'screenshot', 'redacted', 'obj/redacted', smoke_retention_until, false),
    ('10000000-0000-0000-0000-000000000022', tenant_a, run_1, 'step-1', 0, 'screenshot', 'redacted', 'obj/quarantined', smoke_retention_until, true);

  IF NOT bypasses_rls THEN
    SELECT count(*) INTO row_count FROM artifacts WHERE tenant_id = tenant_a;
    IF row_count <> 1 THEN
      RAISE EXCEPTION 'artifact redaction/quarantine SELECT gate expected 1 visible row, got %', row_count;
    END IF;

    PERFORM set_config('app.tenant_id', tenant_b::text, true);
    SELECT count(*) INTO row_count FROM runs;
    IF row_count <> 0 THEN
      RAISE EXCEPTION 'RLS tenant isolation expected tenant_b to see 0 tenant_a runs, got %', row_count;
    END IF;
    PERFORM set_config('app.tenant_id', tenant_a::text, true);
  END IF;

  BEGIN
    INSERT INTO artifacts (id, tenant_id, run_id, step_id, attempt, type, redaction_status, object_ref, retention_until)
    VALUES ('10000000-0000-0000-0000-000000000024', tenant_a, run_1, 'step-1', 9, 'screenshot', 'redacted', 'obj/bad-step-attempt', smoke_retention_until);
    RAISE EXCEPTION 'artifact step reference must reject unknown (tenant_id, run_id, step_id, attempt)';
  EXCEPTION
    WHEN foreign_key_violation THEN
      NULL;
  END;

  BEGIN
    INSERT INTO artifacts (id, tenant_id, run_id, step_id, attempt, type, redaction_status, object_ref)
    VALUES ('10000000-0000-0000-0000-000000000029', tenant_a, run_1, 'step-1', 0, 'screenshot', 'pending', 'obj/missing-retention');
    RAISE EXCEPTION 'artifact metadata must reject missing retention_until unless legal_hold';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  BEGIN
    INSERT INTO artifacts (
      id, tenant_id, run_id, step_id, attempt, type, redaction_status, object_ref, retention_until,
      lifecycle_claim_id, lifecycle_claim_kind, lifecycle_claim_worker_id, lifecycle_claim_correlation_id,
      lifecycle_claimed_at, lifecycle_claim_expires_at
    )
    VALUES (
      '10000000-0000-0000-0000-000000000030', tenant_a, run_1, 'step-1', 0, 'screenshot', 'pending', 'obj/app-claim',
      smoke_retention_until, '10000000-0000-0000-0000-000000000031', 'artifact_redaction', worker_id,
      '20000000-0000-0000-0000-000000000001', smoke_now, smoke_now + interval '5 minutes'
    );
    RAISE EXCEPTION 'artifact application insert must not set lifecycle claim lease fields';
  EXCEPTION
    WHEN insufficient_privilege OR check_violation THEN
      NULL;
  END;

  INSERT INTO artifacts (id, tenant_id, run_id, step_id, attempt, type, redaction_status, object_ref, retention_until)
  VALUES ('10000000-0000-0000-0000-000000000025', tenant_a, run_1, 'step-1', 0, 'receipt', 'not_required', 'obj/retention-cas', smoke_now - interval '1 day');

  EXECUTE 'ALTER TABLE artifacts DISABLE ROW LEVEL SECURITY';

  WITH claimed AS (
    UPDATE artifacts
       SET lifecycle_claim_id = '10000000-0000-0000-0000-000000000031',
           lifecycle_claim_kind = 'artifact_redaction',
           lifecycle_claim_worker_id = worker_id,
           lifecycle_claim_correlation_id = '20000000-0000-0000-0000-000000000001',
           lifecycle_claimed_at = smoke_now,
           lifecycle_claim_expires_at = smoke_now + interval '5 minutes'
     WHERE tenant_id = tenant_a
       AND id = '10000000-0000-0000-0000-000000000020'
       AND redaction_status = 'pending'
       AND deleted_at IS NULL
       AND quarantine = false
       AND (lifecycle_claim_id IS NULL OR lifecycle_claim_expires_at <= smoke_now)
     RETURNING 1
  )
  SELECT count(*) INTO row_count FROM claimed;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'artifact lifecycle redaction claim should acquire one eligible row, got %', row_count;
  END IF;

  WITH stolen AS (
    UPDATE artifacts
       SET lifecycle_claim_id = '10000000-0000-0000-0000-000000000032',
           lifecycle_claim_kind = 'artifact_redaction',
           lifecycle_claim_worker_id = wrong_worker_id,
           lifecycle_claim_correlation_id = '20000000-0000-0000-0000-000000000002',
           lifecycle_claimed_at = smoke_now,
           lifecycle_claim_expires_at = smoke_now + interval '5 minutes'
     WHERE tenant_id = tenant_a
       AND id = '10000000-0000-0000-0000-000000000020'
       AND redaction_status = 'pending'
       AND deleted_at IS NULL
       AND quarantine = false
       AND (lifecycle_claim_id IS NULL OR lifecycle_claim_expires_at <= smoke_now)
     RETURNING 1
  )
  SELECT count(*) INTO row_count FROM stolen;
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'artifact lifecycle active claim must not be stolen, got %', row_count;
  END IF;

  UPDATE artifacts
     SET lifecycle_claimed_at = smoke_now - interval '10 minutes',
         lifecycle_claim_expires_at = smoke_now - interval '1 second'
   WHERE tenant_id = tenant_a
     AND id = '10000000-0000-0000-0000-000000000020'
     AND lifecycle_claim_id = '10000000-0000-0000-0000-000000000031';

  WITH reclaimed AS (
    UPDATE artifacts
       SET lifecycle_claim_id = '10000000-0000-0000-0000-000000000033',
           lifecycle_claim_kind = 'artifact_redaction',
           lifecycle_claim_worker_id = worker_id,
           lifecycle_claim_correlation_id = '20000000-0000-0000-0000-000000000003',
           lifecycle_claimed_at = smoke_now,
           lifecycle_claim_expires_at = smoke_now + interval '5 minutes'
     WHERE tenant_id = tenant_a
       AND id = '10000000-0000-0000-0000-000000000020'
       AND redaction_status = 'pending'
       AND deleted_at IS NULL
       AND quarantine = false
       AND lifecycle_claim_expires_at <= smoke_now
     RETURNING 1
  )
  SELECT count(*) INTO row_count FROM reclaimed;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'artifact lifecycle expired claim should be reclaimed exactly once, got %', row_count;
  END IF;

  WITH wrong_finalize AS (
    UPDATE artifacts
       SET redaction_status = 'redacted',
           object_ref = 'obj/wrong-claim-redacted',
           lifecycle_claim_id = NULL,
           lifecycle_claim_kind = NULL,
           lifecycle_claim_worker_id = NULL,
           lifecycle_claim_correlation_id = NULL,
           lifecycle_claimed_at = NULL,
           lifecycle_claim_expires_at = NULL
     WHERE tenant_id = tenant_a
       AND id = '10000000-0000-0000-0000-000000000020'
       AND lifecycle_claim_id = '10000000-0000-0000-0000-000000000032'
       AND lifecycle_claim_kind = 'artifact_redaction'
       AND lifecycle_claim_worker_id = worker_id
       AND lifecycle_claim_correlation_id = '20000000-0000-0000-0000-000000000003'
       AND lifecycle_claim_expires_at > smoke_now
       AND redaction_status = 'pending'
       AND deleted_at IS NULL
       AND quarantine = false
     RETURNING 1
  )
  SELECT count(*) INTO row_count FROM wrong_finalize;
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'artifact lifecycle finalize CAS must reject wrong claim id, got %', row_count;
  END IF;

  WITH cross_tenant_finalize AS (
    UPDATE artifacts
       SET redaction_status = 'redacted'
     WHERE tenant_id = tenant_b
       AND id = '10000000-0000-0000-0000-000000000020'
       AND lifecycle_claim_id = '10000000-0000-0000-0000-000000000033'
       AND lifecycle_claim_kind = 'artifact_redaction'
       AND lifecycle_claim_worker_id = worker_id
       AND lifecycle_claim_correlation_id = '20000000-0000-0000-0000-000000000003'
       AND lifecycle_claim_expires_at > smoke_now
       AND redaction_status = 'pending'
       AND deleted_at IS NULL
       AND quarantine = false
     RETURNING 1
  )
  SELECT count(*) INTO row_count FROM cross_tenant_finalize;
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'artifact lifecycle finalize CAS must reject cross-tenant claim, got %', row_count;
  END IF;

  UPDATE artifacts
     SET lifecycle_claimed_at = smoke_now - interval '10 minutes',
         lifecycle_claim_expires_at = smoke_now - interval '1 second'
   WHERE tenant_id = tenant_a
     AND id = '10000000-0000-0000-0000-000000000020'
     AND lifecycle_claim_id = '10000000-0000-0000-0000-000000000033';

  WITH expired_finalize AS (
    UPDATE artifacts
       SET redaction_status = 'redacted'
     WHERE tenant_id = tenant_a
       AND id = '10000000-0000-0000-0000-000000000020'
       AND lifecycle_claim_id = '10000000-0000-0000-0000-000000000033'
       AND lifecycle_claim_kind = 'artifact_redaction'
       AND lifecycle_claim_worker_id = worker_id
       AND lifecycle_claim_correlation_id = '20000000-0000-0000-0000-000000000003'
       AND lifecycle_claim_expires_at > smoke_now
       AND redaction_status = 'pending'
       AND deleted_at IS NULL
       AND quarantine = false
     RETURNING 1
  )
  SELECT count(*) INTO row_count FROM expired_finalize;
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'artifact lifecycle finalize CAS must reject expired claim, got %', row_count;
  END IF;

  WITH reclaimed_again AS (
    UPDATE artifacts
       SET lifecycle_claim_id = '10000000-0000-0000-0000-000000000034',
           lifecycle_claim_kind = 'artifact_redaction',
           lifecycle_claim_worker_id = worker_id,
           lifecycle_claim_correlation_id = '20000000-0000-0000-0000-000000000004',
           lifecycle_claimed_at = smoke_now,
           lifecycle_claim_expires_at = smoke_now + interval '5 minutes'
     WHERE tenant_id = tenant_a
       AND id = '10000000-0000-0000-0000-000000000020'
       AND redaction_status = 'pending'
       AND deleted_at IS NULL
       AND quarantine = false
       AND lifecycle_claim_expires_at <= smoke_now
     RETURNING 1
  )
  SELECT count(*) INTO row_count FROM reclaimed_again;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'artifact lifecycle expired claim should be reclaimable before finalization, got %', row_count;
  END IF;

  WITH finalized AS (
    UPDATE artifacts
       SET redaction_status = 'redacted',
           redaction_attempts = redaction_attempts + 1,
           object_ref = 'obj/redacted-by-cas',
           sha256 = 'sha256:redacted-by-cas',
           lifecycle_claim_id = NULL,
           lifecycle_claim_kind = NULL,
           lifecycle_claim_worker_id = NULL,
           lifecycle_claim_correlation_id = NULL,
           lifecycle_claimed_at = NULL,
           lifecycle_claim_expires_at = NULL
     WHERE tenant_id = tenant_a
       AND id = '10000000-0000-0000-0000-000000000020'
       AND lifecycle_claim_id = '10000000-0000-0000-0000-000000000034'
       AND lifecycle_claim_kind = 'artifact_redaction'
       AND lifecycle_claim_worker_id = worker_id
       AND lifecycle_claim_correlation_id = '20000000-0000-0000-0000-000000000004'
       AND lifecycle_claim_expires_at > smoke_now
       AND redaction_status = 'pending'
       AND deleted_at IS NULL
       AND quarantine = false
     RETURNING 1
  )
  SELECT count(*) INTO row_count FROM finalized;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'artifact lifecycle redaction finalize CAS should update one claim-bound row, got %', row_count;
  END IF;

  WITH retention_claimed AS (
    UPDATE artifacts
       SET lifecycle_claim_id = '10000000-0000-0000-0000-000000000035',
           lifecycle_claim_kind = 'artifact_retention',
           lifecycle_claim_worker_id = worker_id,
           lifecycle_claim_correlation_id = '20000000-0000-0000-0000-000000000005',
           lifecycle_claimed_at = smoke_now,
           lifecycle_claim_expires_at = smoke_now + interval '5 minutes'
     WHERE tenant_id = tenant_a
       AND id = '10000000-0000-0000-0000-000000000025'
       AND deleted_at IS NULL
       AND legal_hold = false
       AND quarantine = false
       AND retention_until IS NOT NULL
       AND retention_until <= smoke_now
       AND (lifecycle_claim_id IS NULL OR lifecycle_claim_expires_at <= smoke_now)
     RETURNING 1
  )
  SELECT count(*) INTO row_count FROM retention_claimed;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'artifact lifecycle retention claim should acquire one due row, got %', row_count;
  END IF;

  WITH retention_transient AS (
    UPDATE artifacts
       SET lifecycle_claim_id = NULL,
           lifecycle_claim_kind = NULL,
           lifecycle_claim_worker_id = NULL,
           lifecycle_claim_correlation_id = NULL,
           lifecycle_claimed_at = NULL,
           lifecycle_claim_expires_at = NULL
     WHERE tenant_id = tenant_a
       AND id = '10000000-0000-0000-0000-000000000025'
       AND lifecycle_claim_id = '10000000-0000-0000-0000-000000000035'
       AND lifecycle_claim_kind = 'artifact_retention'
       AND lifecycle_claim_worker_id = worker_id
       AND lifecycle_claim_correlation_id = '20000000-0000-0000-0000-000000000005'
       AND lifecycle_claim_expires_at > smoke_now
       AND deleted_at IS NULL
       AND legal_hold = false
       AND quarantine = false
       AND retention_until IS NOT NULL
       AND retention_until <= smoke_now
     RETURNING 1
  )
  SELECT count(*) INTO row_count FROM retention_transient;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'artifact lifecycle transient retention failure should clear one claim, got %', row_count;
  END IF;

  SELECT count(*) INTO row_count
    FROM artifacts
   WHERE tenant_id = tenant_a
     AND id = '10000000-0000-0000-0000-000000000025'
     AND deleted_at IS NULL
     AND deleted_reason IS NULL
     AND deleted_by_job IS NULL
     AND lifecycle_claim_id IS NULL;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'artifact lifecycle transient retention failure must not tombstone or retain claim, got %', row_count;
  END IF;

  EXECUTE 'ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE artifacts FORCE ROW LEVEL SECURITY';

  INSERT INTO control_plane_idempotency_keys (
    id, tenant_id, endpoint, idempotency_key, request_hash, status, response_status,
    response_body, expires_at
  )
  VALUES (
    '10000000-0000-0000-0000-000000000036', tenant_a, 'POST /v1/runs',
    'control-plane-smoke-key', 'sha256:control-plane-smoke', 'succeeded', 202,
    '{"ok":true}'::jsonb, now() + interval '1 hour'
  );

  BEGIN
    INSERT INTO control_plane_idempotency_keys (
      id, tenant_id, endpoint, idempotency_key, request_hash, status, expires_at
    )
    VALUES (
      '10000000-0000-0000-0000-000000000037', tenant_a, 'POST /v1/runs',
      'control-plane-smoke-key', 'sha256:control-plane-smoke-retry', 'processing',
      now() + interval '1 hour'
    );
    RAISE EXCEPTION 'control_plane_idempotency_keys must reject duplicate same-tenant endpoint/idempotency_key';
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;

  PERFORM set_config('app.tenant_id', tenant_b::text, true);

  INSERT INTO control_plane_idempotency_keys (
    id, tenant_id, endpoint, idempotency_key, request_hash, status, expires_at
  )
  VALUES (
    '10000000-0000-0000-0000-000000000038', tenant_b, 'POST /v1/runs',
    'control-plane-smoke-key', 'sha256:control-plane-smoke-tenant-b', 'processing',
    now() + interval '1 hour'
  );

  IF NOT bypasses_rls THEN
    SELECT count(*)
      INTO row_count
      FROM control_plane_idempotency_keys
     WHERE endpoint = 'POST /v1/runs'
       AND idempotency_key = 'control-plane-smoke-key';

    IF row_count <> 1 THEN
      RAISE EXCEPTION 'control-plane idempotency RLS expected tenant_b to see exactly one own row, got %', row_count;
    END IF;
  END IF;

  PERFORM set_config('app.tenant_id', tenant_a::text, true);

  INSERT INTO credential_concurrency_policies (tenant_id, credential_ref, site_profile_id, max_concurrency)
  VALUES (tenant_a, 'secretref://smoke/account', site_id, 2);

  INSERT INTO credential_leases (tenant_id, credential_ref, site_profile_id, slot_no, run_id, status, locked_until)
  VALUES
    (tenant_a, 'secretref://smoke/account', site_id, 0, run_1, 'active', now() + interval '10 minutes'),
    (tenant_a, 'secretref://smoke/account', site_id, 1, run_2, 'active', now() + interval '10 minutes');

  BEGIN
    INSERT INTO credential_leases (tenant_id, credential_ref, site_profile_id, slot_no, run_id, status, locked_until)
    VALUES (tenant_a, 'secretref://smoke/account', site_id, 2, run_1, 'active', now() + interval '10 minutes');
    RAISE EXCEPTION 'credential slot trigger should reject slot_no above max_concurrency';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  WITH occupied AS (
    INSERT INTO credential_leases (tenant_id, credential_ref, site_profile_id, slot_no, run_id, status, locked_until)
    VALUES (tenant_a, 'secretref://smoke/account', site_id, 0, run_2, 'active', now() + interval '10 minutes')
    ON CONFLICT (tenant_id, credential_ref, site_profile_id, slot_no)
      DO UPDATE SET run_id = excluded.run_id,
                    status = 'active',
                    locked_until = excluded.locked_until,
                    acquired_at = now()
      WHERE credential_leases.status IN ('released','expired')
         OR credential_leases.locked_until < now()
    RETURNING 1
  )
  SELECT count(*) INTO row_count FROM occupied;

  IF row_count <> 0 THEN
    RAISE EXCEPTION 'active credential slot must not be stolen by upsert CAS';
  END IF;

  UPDATE credential_leases
     SET status = 'released'
   WHERE tenant_id = tenant_a
     AND credential_ref = 'secretref://smoke/account'
     AND site_profile_id = site_id
     AND slot_no = 0;

  WITH reacquired AS (
    INSERT INTO credential_leases (tenant_id, credential_ref, site_profile_id, slot_no, run_id, status, locked_until)
    VALUES (tenant_a, 'secretref://smoke/account', site_id, 0, run_2, 'active', now() + interval '10 minutes')
    ON CONFLICT (tenant_id, credential_ref, site_profile_id, slot_no)
      DO UPDATE SET run_id = excluded.run_id,
                    status = 'active',
                    locked_until = excluded.locked_until,
                    acquired_at = now()
      WHERE credential_leases.status IN ('released','expired')
         OR credential_leases.locked_until < now()
    RETURNING 1
  )
  SELECT count(*) INTO row_count FROM reacquired;

  IF row_count <> 1 THEN
    RAISE EXCEPTION 'released credential slot should be reacquired exactly once, got %', row_count;
  END IF;

  UPDATE credential_leases
     SET locked_until = now() - interval '1 second'
   WHERE tenant_id = tenant_a
     AND credential_ref = 'secretref://smoke/account'
     AND site_profile_id = site_id
     AND slot_no = 1;

  WITH expired_reacquired AS (
    INSERT INTO credential_leases (tenant_id, credential_ref, site_profile_id, slot_no, run_id, status, locked_until)
    VALUES (tenant_a, 'secretref://smoke/account', site_id, 1, run_1, 'active', now() + interval '10 minutes')
    ON CONFLICT (tenant_id, credential_ref, site_profile_id, slot_no)
      DO UPDATE SET run_id = excluded.run_id,
                    status = 'active',
                    locked_until = excluded.locked_until,
                    acquired_at = now()
      WHERE credential_leases.status IN ('released','expired')
         OR credential_leases.locked_until < now()
    RETURNING 1
  )
  SELECT count(*) INTO row_count FROM expired_reacquired;

  IF row_count <> 1 THEN
    RAISE EXCEPTION 'expired credential slot should be reacquired exactly once, got %', row_count;
  END IF;

  INSERT INTO browser_leases (
    id, tenant_id, site_profile_id, browser_identity_id, run_id, owner_worker_id,
    isolation, state, cleanup_policy, expires_at
  )
  VALUES (
    browser_lease_id, tenant_a, site_id, browser_identity_id, run_1, worker_id,
    'context', 'active', 'clear_all', now() + interval '5 minutes'
  );

  UPDATE browser_leases
     SET heartbeat_at = now(),
         expires_at = now() + interval '5 minutes'
   WHERE id = browser_lease_id
     AND owner_worker_id = wrong_worker_id
     AND state IN ('reserved','active')
     AND expires_at >= now();
  GET DIAGNOSTICS row_count = ROW_COUNT;
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'browser lease heartbeat CAS must reject renewal from a non-owner worker, got %', row_count;
  END IF;

  UPDATE browser_leases
     SET heartbeat_at = now(),
         expires_at = now() + interval '5 minutes'
   WHERE id = browser_lease_id
     AND owner_worker_id = worker_id
     AND state IN ('reserved','active')
     AND expires_at >= now();
  GET DIAGNOSTICS row_count = ROW_COUNT;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'browser lease heartbeat CAS should renew one active row, got %', row_count;
  END IF;

  UPDATE browser_leases
     SET expires_at = now() - interval '1 second'
   WHERE id = browser_lease_id;

  UPDATE browser_leases
     SET heartbeat_at = now(),
         expires_at = now() + interval '5 minutes'
   WHERE id = browser_lease_id
     AND owner_worker_id = worker_id
     AND state IN ('reserved','active')
     AND expires_at >= now();
  GET DIAGNOSTICS row_count = ROW_COUNT;
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'expired browser lease must not be revived by heartbeat CAS';
  END IF;

  WITH swept AS (
    UPDATE browser_leases
       SET state = 'expired'
     WHERE expires_at < now()
       AND state IN ('reserved','active')
     RETURNING 1
  )
  SELECT count(*) INTO row_count FROM swept;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'browser lease sweeper should expire one row, got %', row_count;
  END IF;

  WITH swept_again AS (
    UPDATE browser_leases
       SET state = 'expired'
     WHERE expires_at < now()
       AND state IN ('reserved','active')
     RETURNING 1
  )
  SELECT count(*) INTO row_count FROM swept_again;
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'browser lease sweeper must be idempotent, got % repeated rows', row_count;
  END IF;

  INSERT INTO raw_items (
    id, tenant_id, connector_id, target_id, source_item_key, source_page_key,
    collection_attempt_id, raw_hash, raw_payload
  )
  VALUES (
    raw_item_id, tenant_a, 'smoke-connector', target_id, NULL, 'page-1',
    '30000000-0000-0000-0000-000000000001', 'sha256:smoke', '{"ok":true}'::jsonb
  );

  BEGIN
    INSERT INTO raw_items (
      id, tenant_id, connector_id, target_id, source_item_key, source_page_key,
      collection_attempt_id, raw_hash, raw_payload
    )
    VALUES (
      '10000000-0000-0000-0000-000000000014', tenant_a, 'smoke-connector', target_id, NULL, 'page-2',
      '30000000-0000-0000-0000-000000000002', 'sha256:smoke', '{"ok":true}'::jsonb
    );
    RAISE EXCEPTION 'raw_items UNIQUE NULLS NOT DISTINCT should reject duplicate NULL source_item_key rows';
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;

  INSERT INTO stagehand_calls (
    id, tenant_id, run_id, step_id, attempt, idempotency_key, request_hash, model
  )
  VALUES (
    stagehand_call_id, tenant_a, run_1, 'step-1', 0,
    'stagehand-run-1-step-1-attempt-0', 'sha256:stagehand-smoke', 'gpt-smoke'
  );

  BEGIN
    INSERT INTO stagehand_calls (
      id, tenant_id, run_id, step_id, attempt, idempotency_key, request_hash, model
    )
    VALUES (
      '10000000-0000-0000-0000-000000000025', tenant_a, run_1, 'step-1', 0,
      'stagehand-run-1-step-1-attempt-0', 'sha256:stagehand-smoke-mismatch', 'gpt-smoke'
    );
    RAISE EXCEPTION 'stagehand_calls durable idempotency key should reject duplicate same-tenant keys';
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;

  BEGIN
    INSERT INTO stagehand_calls (
      id, tenant_id, run_id, step_id, attempt, idempotency_key, request_hash, model
    )
    VALUES (
      '10000000-0000-0000-0000-000000000026', tenant_a, run_1, 'step-1', 7,
      'stagehand-run-1-step-1-attempt-7', 'sha256:stagehand-bad-attempt', 'gpt-smoke'
    );
    RAISE EXCEPTION 'stagehand_calls step reference must reject unknown (tenant_id, run_id, step_id, attempt)';
  EXCEPTION
    WHEN foreign_key_violation THEN
      NULL;
  END;

  INSERT INTO events_outbox (
    event_id, event_type, event_version, tenant_id, run_id, workitem_id,
    correlation_id, ordering_key, occurred_at, idempotency_key, payload_schema_ref, payload,
    retention_until
  )
  VALUES (
    smoke_event_id, 'run.started', 1, tenant_a, run_1, workitem_1,
    '20000000-0000-0000-0000-000000000001', run_1::text, now(),
    'run-1:started', 'events/run.started@1', '{}'::jsonb,
    smoke_retention_until
  );

  BEGIN
    INSERT INTO events_outbox (
      event_id, event_type, event_version, tenant_id, run_id, workitem_id,
      correlation_id, ordering_key, occurred_at, idempotency_key, payload_schema_ref, payload,
      retention_until
    )
    VALUES (
      '10000000-0000-0000-0000-000000000015', 'run.started', 1, tenant_a, run_1, workitem_1,
      '20000000-0000-0000-0000-000000000001', run_1::text, now(),
      'run-1:started', 'events/run.started@1', '{}'::jsonb,
      smoke_retention_until
    );
    RAISE EXCEPTION 'events_outbox tenant-scoped idempotency key should reject duplicates';
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;

  INSERT INTO events_outbox (
    event_id, event_type, event_version, tenant_id, run_id, workitem_id,
    step_id, attempt, correlation_id, ordering_key, occurred_at,
    idempotency_key, payload_schema_ref, payload, retention_until
  )
  VALUES (
    step_event_id, 'step.completed', 1, tenant_a, run_1, workitem_1,
    'step-1', 0, '20000000-0000-0000-0000-000000000001', run_1::text, now(),
    'run-1:step-1:0:completed', 'events/step.completed@1', '{}'::jsonb,
    smoke_retention_until
  );

  INSERT INTO events_outbox (
    event_id, event_type, event_version, tenant_id, run_id, workitem_id,
    step_id, attempt, correlation_id, ordering_key, occurred_at,
    idempotency_key, payload_schema_ref, payload, retention_until
  )
  VALUES (
    step_started_event_id, 'step.started', 1, tenant_a, run_1, workitem_1,
    'step-started', 0, '20000000-0000-0000-0000-000000000001', run_1::text, now(),
    'run-1:step-started:0:started', 'events/step.started@1', '{}'::jsonb,
    smoke_retention_until
  );

  BEGIN
    INSERT INTO events_outbox (
      event_id, event_type, event_version, tenant_id, run_id, workitem_id,
      correlation_id, ordering_key, occurred_at,
      idempotency_key, payload_schema_ref, payload, retention_until
    )
    VALUES (
      '10000000-0000-0000-0000-000000000023', 'step.completed', 1, tenant_a, run_1, workitem_1,
      '20000000-0000-0000-0000-000000000001', run_1::text, now(),
      'run-1:step-1:missing-ref:completed', 'events/step.completed@1', '{}'::jsonb,
      smoke_retention_until
    );
    RAISE EXCEPTION 'events_outbox step event must reject missing step_id/attempt';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  BEGIN
    INSERT INTO events_outbox (
      event_id, event_type, event_version, tenant_id, run_id, workitem_id,
      step_id, attempt, correlation_id, ordering_key, occurred_at,
      idempotency_key, payload_schema_ref, payload, retention_until
    )
    VALUES (
      '10000000-0000-0000-0000-000000000027', 'step.completed', 1, tenant_a, run_1, workitem_1,
      'step-1', 9, '20000000-0000-0000-0000-000000000001', run_1::text, now(),
      'run-1:step-1:9:completed', 'events/step.completed@1', '{}'::jsonb,
      smoke_retention_until
    );
    RAISE EXCEPTION 'events_outbox step event must reject unknown (tenant_id, run_id, step_id, attempt)';
  EXCEPTION
    WHEN foreign_key_violation THEN
      NULL;
  END;

  BEGIN
    INSERT INTO events_outbox (
      event_id, event_type, event_version, tenant_id,
      correlation_id, occurred_at, idempotency_key, payload_schema_ref, payload,
      retention_until
    )
    VALUES (
      '10000000-0000-0000-0000-000000000028', 'worker.heartbeat', 1, tenant_a,
      '20000000-0000-0000-0000-000000000001', now(),
      'worker-heartbeat-tenant-outbox-forbidden', 'events/worker.heartbeat@1', '{}'::jsonb,
      smoke_retention_until
    );
    RAISE EXCEPTION 'events_outbox must reject worker.* infrastructure telemetry';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  BEGIN
    INSERT INTO events_outbox (
      event_id, event_type, event_version, tenant_id,
      correlation_id, occurred_at, idempotency_key, payload_schema_ref, payload
    )
    VALUES (
      '10000000-0000-0000-0000-000000000029', 'site.circuit_opened', 1, tenant_a,
      '20000000-0000-0000-0000-000000000001', now(),
      'site-circuit-opened-missing-retention', 'events/site.circuit_opened@1', '{}'::jsonb
    );
    RAISE EXCEPTION 'events_outbox must reject missing retention_until';
  EXCEPTION
    WHEN not_null_violation THEN
      NULL;
  END;

  PERFORM set_config('app.tenant_id', tenant_b::text, true);

  INSERT INTO scenarios (id, tenant_id, name)
  VALUES (scenario_b_id, tenant_b, 'smoke-scenario-b');

  INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
  VALUES (scenario_version_b_id, tenant_b, scenario_b_id, 1, 'draft', '{"nodes":[]}'::jsonb);

  INSERT INTO workitems (id, tenant_id, connector_id, unique_reference)
  VALUES (workitem_b, tenant_b, 'smoke-connector', 'workitem-b');

  INSERT INTO runs (id, tenant_id, scenario_version_id, workitem_id, status, correlation_id)
  VALUES (run_b, tenant_b, scenario_version_b_id, workitem_b, 'queued', '20000000-0000-0000-0000-000000000003');

  INSERT INTO events_outbox (
    event_id, event_type, event_version, tenant_id, run_id, workitem_id,
    correlation_id, ordering_key, occurred_at, idempotency_key, payload_schema_ref, payload,
    retention_until
  )
  VALUES (
    smoke_event_b_id, 'run.started', 1, tenant_b, run_b, workitem_b,
    '20000000-0000-0000-0000-000000000003', run_b::text, now(),
    'run-1:started', 'events/run.started@1', '{}'::jsonb,
    smoke_retention_until
  );

  IF EXISTS (
    SELECT 1 FROM events_outbox
     WHERE event_id = smoke_event_b_id
       AND retention_until IS NULL
  ) THEN
    RAISE EXCEPTION 'events_outbox smoke rows must set retention_until explicitly';
  END IF;

  BEGIN
    INSERT INTO events_outbox (
      event_id, event_type, event_version, tenant_id, run_id,
      correlation_id, ordering_key, occurred_at, idempotency_key, payload_schema_ref, payload,
      retention_until
    )
    VALUES (
      '10000000-0000-0000-0000-000000000016', 'run.started', 1, tenant_b, run_1,
      '20000000-0000-0000-0000-000000000004', run_1::text, now(),
      'tenant-b:cross-run', 'events/run.started@1', '{}'::jsonb,
      smoke_retention_until
    );
    RAISE EXCEPTION 'events_outbox composite FK should reject cross-tenant run reference';
  EXCEPTION
    WHEN foreign_key_violation THEN
      NULL;
  END;
  PERFORM set_config('app.tenant_id', tenant_a::text, true);

  IF EXISTS (
    SELECT 1 FROM events_outbox
     WHERE event_id IN (smoke_event_id, step_event_id)
       AND retention_until IS NULL
  ) THEN
    RAISE EXCEPTION 'events_outbox smoke rows must set retention_until explicitly';
  END IF;

  INSERT INTO audit_log (
    id, tenant_id, sequence_no, actor, action, outcome, reason, correlation_id,
    idempotency_key, occurred_at, payload_schema_ref, payload, retention_until, hash
  )
  VALUES (
    audit_1, tenant_a, 1, '{"kind":"system","id":"smoke"}'::jsonb,
    'artifact.read', 'deny', 'ARTIFACT_NOT_REDACTED',
    '20000000-0000-0000-0000-000000000001',
    'audit-smoke-1', now(), 'audit/security-boundary-decision@1',
    '{"decision_kind":"artifact.read","artifact_id":"10000000-0000-0000-0000-000000000020"}'::jsonb,
    now() + interval '90 days', 'sha256:audit-smoke-1'
  );

  INSERT INTO audit_log (
    id, tenant_id, sequence_no, actor, action, outcome, reason, correlation_id,
    idempotency_key, occurred_at, payload_schema_ref, payload, retention_until, previous_hash, hash
  )
  VALUES (
    audit_2, tenant_a, 2, '{"kind":"system","id":"smoke"}'::jsonb,
    'network.request', 'allow', NULL,
    '20000000-0000-0000-0000-000000000001',
    'audit-smoke-2', now(), 'audit/security-boundary-decision@1',
    '{"decision_kind":"network.request","domain":"example.test"}'::jsonb,
    now() + interval '90 days', 'sha256:audit-smoke-1', 'sha256:audit-smoke-2'
  );

  BEGIN
    INSERT INTO audit_log (
      id, tenant_id, sequence_no, actor, action, outcome, correlation_id,
      idempotency_key, occurred_at, payload_schema_ref, payload, previous_hash, hash
    )
    VALUES (
      '10000000-0000-0000-0000-000000000043', tenant_a, 3,
      '{"kind":"system","id":"smoke"}'::jsonb, 'prompt.inspect',
      'blocked', '20000000-0000-0000-0000-000000000001',
      'audit-smoke-bad-schema', now(), 'audit/unknown@1',
      '{"decision_kind":"prompt.inspect"}'::jsonb,
      'sha256:audit-smoke-2', 'sha256:audit-smoke-bad-schema'
    );
    RAISE EXCEPTION 'audit_log must reject unknown payload_schema_ref';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  BEGIN
    UPDATE audit_log
       SET reason = 'mutated'
     WHERE id = audit_1;
    RAISE EXCEPTION 'audit_log must reject UPDATE because it is append-only';
  EXCEPTION
    WHEN object_not_in_prerequisite_state THEN
      NULL;
  END;

  BEGIN
    DELETE FROM audit_log
     WHERE id = audit_2;
    RAISE EXCEPTION 'audit_log must reject DELETE because it is append-only';
  EXCEPTION
    WHEN object_not_in_prerequisite_state THEN
      NULL;
  END;

  PERFORM set_config('app.tenant_id', tenant_b::text, true);
  BEGIN
    INSERT INTO audit_log (
      id, tenant_id, sequence_no, actor, action, outcome, correlation_id,
      idempotency_key, occurred_at, payload, previous_hash, hash
    )
    VALUES (
      '10000000-0000-0000-0000-000000000042', tenant_b, 2,
      '{"kind":"system","id":"smoke"}'::jsonb, 'bypassrls.use',
      'error', '20000000-0000-0000-0000-000000000003',
      'audit-smoke-cross-tenant', now(), '{}'::jsonb,
      'sha256:audit-smoke-1', 'sha256:audit-smoke-tenant-b'
    );
    RAISE EXCEPTION 'audit_log must reject cross-tenant previous_hash chaining';
  EXCEPTION
    WHEN foreign_key_violation THEN
      NULL;
  END;
  PERFORM set_config('app.tenant_id', tenant_a::text, true);

  WITH published AS (
    UPDATE events_outbox
       SET published_at = now()
     WHERE events_outbox.event_id = smoke_event_id
       AND published_at IS NULL
     RETURNING 1
  )
  SELECT count(*) INTO row_count FROM published;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'events_outbox publish CAS should update one unpublished row, got %', row_count;
  END IF;

  WITH republished AS (
    UPDATE events_outbox
       SET published_at = now()
     WHERE events_outbox.event_id = smoke_event_id
       AND published_at IS NULL
     RETURNING 1
  )
  SELECT count(*) INTO row_count FROM republished;
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'events_outbox publish CAS must not republish, got % rows', row_count;
  END IF;
END $$;

\echo 'RPA DB migration smoke passed; rolling back smoke schema and data.'

ROLLBACK;
