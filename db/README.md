# DB Migration Runbook

This directory is the PostgreSQL 15+ contract-first DDL source for the RPA SSoT.
Apply migrations in this exact order:

1. `migration_concurrency_idempotency.sql`
2. `migration_core_entities.sql`

Do not apply `migration_core_entities.sql` first. It adds FKs/RLS policies over the
lease, raw, normalized, sink, and challenge tables created by the concurrency
migration.

## Versioned Migration Runner Contract

P0-adoption uses a repo-local Node migration runner as the default migration
tool. Flyway, Sqitch, or a managed deploy tool may replace it later, but the
behavior below is the contract the implementation must satisfy.

The runner owns a `schema_migrations` ledger with these fields:

- `version`: monotonic migration version or ordered migration id.
- `name`: migration file or logical step name.
- `checksum`: SHA-256 of the exact applied migration content.
- `applied_at`: database timestamp when the migration completed.
- `applied_by`: migration actor or runtime identity.
- `duration_ms`: non-negative integer execution duration.
- `status`: closed enum `applied|failed`.
- `baseline`: boolean. `true` means the row records an existing schema that was
  verified and adopted without rerunning DDL.

Fresh install behavior:

1. Create the ledger if absent.
2. Apply `migration_concurrency_idempotency.sql`.
3. Apply `migration_core_entities.sql`.
4. Record both rows with `baseline=false`, `status='applied'`, and their
   checksums.
5. Run `migration_smoke.sql` and at least one non-BYPASSRLS RLS smoke before
   product-open evidence is accepted.

Existing DB baseline behavior:

1. Detect whether the core schema already exists.
2. Verify required tables, constraints, RLS posture, and migration order shape.
3. Compute the current repo checksums for the two ordered SQL files.
4. If the database shape matches the expected contract, insert ledger rows with
   `baseline=true`, `status='applied'`, and the computed checksums.
5. If the shape is incomplete, unexpected, or ambiguous, stop with drift rather
   than repairing automatically.

Baseline deep verification minimum:

| Check | Required behavior |
|---|---|
| Required tables and columns | Verify every contracted table and critical column, not just a representative table count |
| Constraints | Verify CHECK constraints, UNIQUE constraints, tenant composite FKs, and idempotency keys required by the two baseline SQL files |
| RLS posture | Verify `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` for every tenant-scoped table |
| RLS policy body | Reject permissive or ambiguous policies such as `USING (true)`. Tenant policies must bind to strict `current_setting('app.tenant_id')::uuid` or an equivalent fail-closed expression |
| Audit append-only trigger | Verify the audit append/update/delete protection trigger and hash-chain columns exist before adopting the schema |
| Audit verifier evidence | Verify `audit_verifier_runs` exists with tenant RLS, status/sequence checks, retention fields, legal hold, and a 90-day evidence-retention path |
| BYPASSRLS split | Verify API/worker roles used for smoke are non-`SUPERUSER` and non-`BYPASSRLS`; superuser smoke is catalog-only evidence |
| Migration order | Verify concurrency/idempotency objects exist before core FK/RLS objects |

The runner must not insert `baseline=true`, `status='applied'` rows if only table
presence and `relrowsecurity`/`relforcerowsecurity` flags were checked. That
would permanently bless an unverified tenant-isolation or audit-integrity shape.
The repo runner implements this by applying the ordered migrations into an
isolated expected schema in the same database, then comparing public catalog
shape before writing baseline rows. The comparison includes tables, columns,
defaults, constraints, indexes/idempotency shapes, tenant composite FKs, exact
RLS policy bodies, strict `current_setting('app.tenant_id')` usage, and
append-only trigger/function evidence for `audit_log`.

Re-run and drift behavior:

- Reapplying the same version with the same checksum is a no-op.
- Reapplying the same version with a different checksum fails closed.
- Applying migrations out of order fails closed.
- A failed migration must not be recorded as partial success.
- The runner must not synthesize rollback success. Database rollback is backup
  restore/PITR or a forward fix migration, distinct from scenario release
  rollback.

## Roles

- The migration role may own DDL.
- Product-open RLS smoke should run as, or at least repeat under, an application
  role without `SUPERUSER` or `BYPASSRLS`.
- `migration_smoke.sql` detects `SUPERUSER`/`BYPASSRLS`. Under those roles it still
  verifies catalog policy shape, strict `current_setting('app.tenant_id')`, and all
  non-RLS constraints, but row-visibility assertions are skipped because PostgreSQL
  bypasses RLS for those roles.
- Runtime code must bind `SET LOCAL app.tenant_id = '<tenant-uuid>'` on every
  transaction boundary. Policies intentionally use strict
  `current_setting('app.tenant_id')`, not `current_setting(..., true)`.
- API and browser worker connections must not use the migration owner or
  `postgres` superuser role for product-open evidence. Local compose may use a
  superuser only when the run is explicitly labeled review-only/catalog-only.
- `compose.yaml` follows this split: `role-bootstrap` uses the image bootstrap
  owner only to apply `db/roles.sql` and inject local LOGIN passwords;
  `migrate` runs as `rpa_migrator` with `--graphile-worker --require-non-bypass`;
  API/runtime worker services connect as `rpa_app`. A compose run that changes API/worker
  back to `${POSTGRES_USER}`/`postgres` is catalog or wiring evidence only, not
  product-open DB/RLS evidence.
- Artifact lifecycle or maintenance BYPASSRLS credentials are operational-only
  and must be reviewed as separate audited maintenance evidence. They do not
  satisfy the Product Open API/runtime-worker RLS evidence requirement.

## Smoke

Run against an empty disposable database or an existing database where the
temporary schema name `rpa_migration_smoke` is available:

```powershell
psql -v ON_ERROR_STOP=1 -f db/migration_smoke.sql
```

Preferred repo-local wrapper:

```powershell
node scripts/db-migration-smoke.mjs --preflight-only
node scripts/db-migration-smoke.mjs
```

When PostgreSQL 15 binaries are installed locally but no disposable database is
already configured, use the temp-cluster wrapper:

```powershell
npm --prefix codegen run db:temp-smoke
npm --prefix codegen run ci:local:temp-db
```

`db:temp-smoke` locates `psql`, `initdb`, and `pg_ctl` from `PSQL_BIN`, `PATH`,
or the default Windows PostgreSQL 15 install directory. It creates a temporary
cluster under the OS temp directory, binds it to `127.0.0.1`, creates `rpa_smoke`
as non-`SUPERUSER`/non-`BYPASSRLS`, runs the smoke with repo-local PG env, and
then stops/removes the cluster. It does not use the installed Windows PostgreSQL
service or modify its authentication config.

Pilot backup/restore drill evidence:

```powershell
npm --prefix codegen run db:restore-drill:temp
```

This starts the same disposable PostgreSQL 15 cluster, applies
`scripts/db-migrate.mjs --smoke --require-non-bypass` as the non-bypass
`rpa_smoke` role, seeds representative tenant and infrastructure rows, performs a
logical `pg_dump`/`pg_restore` into a fresh database, and then reruns
`scripts/db-migrate.mjs --baseline-existing --smoke --require-non-bypass` against
the restored database. The temporary cluster uses its bootstrap `postgres` owner
only for the dump/restore operation; release evidence is accepted only after the
restored database passes the non-`SUPERUSER`/non-`BYPASSRLS` smoke. This is
pilot logical-restore evidence, not production PITR/HA/DR evidence.

The wrapper detects `psql` from `PSQL_BIN` first, then `PATH` (`psql.exe` on
Windows). It checks the PostgreSQL client version, connects to the configured
server, verifies PostgreSQL 15+, prints the target without exposing
`PGPASSWORD`, warns when the current role has `SUPERUSER`/`BYPASSRLS`, and then
runs the smoke with `psql -X`.

Supported libpq environment variables:

```powershell
$env:PSQL_BIN = 'C:\Program Files\PostgreSQL\15\bin\psql.exe' # optional
$env:PGHOST = 'localhost'
$env:PGPORT = '5432'
$env:PGDATABASE = 'rpa_contract_gate'
$env:PGUSER = 'rpa_smoke_app'
$env:PGPASSWORD = '<SecretRef-resolved outside repo>'
node scripts/db-migration-smoke.mjs
```

`PGSERVICE` is also honored by `psql`. Do not commit passwords or service files;
secrets remain outside the repository behind `SecretRef`/`SecretStore`.

Product-open evidence must preserve the wrapper's role posture. A run as
`SUPERUSER`/`BYPASSRLS` is catalog/non-RLS evidence only and does not satisfy
Product Open DB smoke by itself. The migration smoke `ROLLBACK` proves cleanup
of the isolated migration harness; it is not external deploy rollback evidence.

If the PostgreSQL client is not installed locally, the wrapper reports whether
`docker` or `podman` is available. A container-only fallback is:

```powershell
docker run --rm --name rpa-pg15-smoke `
  -e POSTGRES_PASSWORD=postgres `
  -e POSTGRES_DB=rpa_contract_gate `
  -p 55432:5432 `
  -v ${PWD}:/work `
  -w /work `
  postgres:15
```

In another shell:

```powershell
docker exec -w /work rpa-pg15-smoke `
  psql -U postgres -d rpa_contract_gate `
  -v ON_ERROR_STOP=1 `
  -f db/migration_smoke.sql
```

Use `podman` in place of `docker` when that is the available runtime. This
container-only path is a syntax/catalog smoke because it runs as the image
superuser by default; Product Open still requires one non-bypass role run.

The smoke runs inside a transaction, creates `rpa_migration_smoke`, sets
`search_path`, applies both migrations with `\ir`, executes assertions, and ends
with `ROLLBACK`. A successful run leaves no smoke schema or data behind.

GitHub Actions can use the same wrapper after provisioning PostgreSQL 15+. The
current service DB path is `.github/workflows/contract-gates.yml`:
`postgres:15` service, `PGHOST=localhost`, `PGPORT=5432`,
`PGDATABASE=rpa_contract_gate`, install `postgresql-client`, create a
non-`SUPERUSER`/non-`BYPASSRLS` `rpa_smoke` role, create/own the smoke database
with that role, then run `node scripts/db-migration-smoke.mjs` with
`PGUSER=rpa_smoke`. No root package manager or backend runtime is required for
this repository.

## Coverage

- PostgreSQL 15+ syntax and required migration order.
- Expected core/concurrency tables exist after ordered application.
- Tenant tables have `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`.
- Tenant policies use strict `current_setting('app.tenant_id')`.
- Missing tenant binding fails under non-bypass RLS roles.
- Artifact `SELECT` gate requires tenant match, `deleted_at IS NULL`,
  `quarantine = false`, and `redaction_status IN ('redacted','not_required')`.
- Artifact application-role `UPDATE`/`DELETE` policies are intentionally absent.
  Redaction, retention, integrity, and orphan sweeper mutations require a
  dedicated operational role with BYPASSRLS plus immutable `bypassrls.use`
  audit evidence before mutation.
- Artifact lifecycle claim lease anchors live on `artifacts` as all-or-none
  claim fields with tenant-local unique claim IDs, worker/correlation binding,
  expiry ordering, and an application-role insert policy that rejects
  application-supplied claim fields. Migration smoke also proves SQL-level
  active claim no-steal, expired claim reclaim, claim-bound finalize CAS miss
  for wrong/cross-tenant/expired claims, and no tombstone on transient
  retention failure.
- Artifact metadata rejects unknown retention deadlines unless `legal_hold` is
  true: `artifacts` requires `legal_hold OR retention_until IS NOT NULL`, and
  smoke fixtures prove missing retention fails closed.
- `workers` remains infrastructure-scoped with no `tenant_id` and no tenant RLS;
  user traffic must not be routed through BYPASSRLS infrastructure roles.
- `control_plane_idempotency_keys` rejects same-tenant duplicate
  `(endpoint, Idempotency-Key)` rows while allowing the same key across tenants.
- `run_triggers` and `run_trigger_fires` keep scheduled-run definitions separate
  from tenant-local fire idempotency, so duplicate cron fires cannot create
  duplicate runs.
- Credential lease slot trigger, active-slot non-steal CAS, released-slot takeover,
  and expired-slot takeover.
- Browser lease owner-only renewal, no renewal after expiry, and idempotent sweeper
  CAS.
- `raw_items` has PG15 `UNIQUE NULLS NOT DISTINCT` and rejects duplicate NULL
  `source_item_key` rows.
- Raw collection rows carry the connector target natural key
  `(tenant_id, connector_id, target_id)`.
- `events_outbox` rejects same-tenant duplicate idempotency keys, allows the same
  key across tenants, rejects cross-tenant run references through composite FKs,
  rejects `worker.*` infrastructure telemetry, and uses publish CAS
  (`published_at IS NULL`) to avoid double publish. `retention_until` is
  `NOT NULL`; smoke fixtures use explicit retention and also prove omitted
  retention is rejected.
- Step-bound artifacts, step events, and `stagehand_calls` reference
  `run_steps` by `(tenant_id, run_id, step_id, attempt)`.
- `run_steps.status='started'` is the nonterminal executor attempt row used for
  truthful `step.started`/producer FK ownership; final executor `StepResult`
  values still use the eight final `StepStatus` values.
- Payload-bearing tables carry inline `retention_until`, `deleted_at`, and
  `legal_hold` columns; artifact writers must not persist non-legal-hold rows
  with unknown retention.
- `stagehand_calls` stores durable LLM `idempotency_key`/`request_hash` and
  rejects same-tenant duplicate idempotency keys.
- `audit_log` is tenant-scoped, append-only, and hash-chained with a
  tenant-local genesis row and no cross-tenant continuation.
- `audit_log.payload_schema_ref` is fixed to
  `audit/security-boundary-decision@1` so durable security-boundary decisions
  have an explicit schema anchor and unknown refs fail closed at insert time.

## Resolved DB Release Decisions

- Decision #1: canonical step references use
  `(tenant_id, run_id, step_id, attempt)`; no `run_step_id` surrogate is
  introduced in v1.
- Decision #5: payload-bearing PostgreSQL tables use inline
  `retention_until`, `deleted_at`, and `legal_hold` columns.
- Decision #6: connector targets use `(tenant_id, connector_id, target_id)`.
- Decision #10: durable LLM idempotency is stored on `stagehand_calls` with
  uniqueness by `(tenant_id, idempotency_key)`.
- Decision #11: immutable audit authority is PostgreSQL `audit_log`, append-only
  with tenant-scoped hash chaining.
- Decision #12: `worker.*` infrastructure telemetry is not accepted by the
  tenant-scoped `events_outbox`.

## Product-Open Rule

Treat this smoke as a release gate for DB readiness. Full product-open requires a
green run under PostgreSQL 15+ and at least one non-bypass RLS role run for the
row-visibility assertions, plus resolution or accepted scope exclusion for every
blocked decision above.
