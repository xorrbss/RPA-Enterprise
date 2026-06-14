# DB Migration Runbook

This directory is the PostgreSQL 15+ contract-first DDL source for the RPA SSoT.
Apply migrations in this exact order:

1. `migration_concurrency_idempotency.sql`
2. `migration_core_entities.sql`

Do not apply `migration_core_entities.sql` first. It adds FKs/RLS policies over the
lease, raw, normalized, sink, and challenge tables created by the concurrency
migration.

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
- Artifact `SELECT` gate requires tenant match, `deleted_at IS NULL`, and
  `redaction_status IN ('redacted','not_required')`.
- `workers` remains infrastructure-scoped with no `tenant_id` and no tenant RLS;
  user traffic must not be routed through BYPASSRLS infrastructure roles.
- `control_plane_idempotency_keys` rejects same-tenant duplicate
  `(endpoint, Idempotency-Key)` rows while allowing the same key across tenants.
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
  (`published_at IS NULL`) to avoid double publish.
- Step-bound artifacts, step events, and `stagehand_calls` reference
  `run_steps` by `(tenant_id, run_id, step_id, attempt)`.
- Payload-bearing tables carry inline `retention_until`, `deleted_at`, and
  `legal_hold` columns.
- `stagehand_calls` stores durable LLM `idempotency_key`/`request_hash` and
  rejects same-tenant duplicate idempotency keys.
- `audit_log` is tenant-scoped, append-only, and hash-chained with a
  tenant-local genesis row and no cross-tenant continuation.

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
