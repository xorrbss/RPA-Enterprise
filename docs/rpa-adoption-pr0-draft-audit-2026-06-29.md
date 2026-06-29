# RPA Adoption PR0 Draft Audit

Date: 2026-06-29
Status: PR0 working note. No implementation in this document is approved by itself.
Design source: `docs/rpa-adoption-full-design-2026-06-29.md`
External review source: attachment `5ec0def4-b431-4c81-8814-73318224ae66/pasted-text.txt`

## Purpose

This document separates unapproved implementation drafts from the approved design
path. It prevents Docker/Compose, maintenance discovery, and worker heartbeat
drafts from being mistaken for completed P0 remediation.

## Current Draft Inventory

| Area | Files | PR0 classification |
|---|---|---|
| Local packaging | `Dockerfile`, `.dockerignore`, `compose.yaml`, `deploy/docker.env.example` | Candidate for P0-1 local Docker/Compose. Not production deployment evidence |
| Migration runner | `scripts/db-migrate.mjs`, `db/README.md`, `compose.yaml` | Candidate for P0-2. Static checks pass; still needs real PostgreSQL fresh-install/baseline evidence |
| Maintenance discovery | `app/src/worker/maintenance-scheduler.ts`, `app/test/maintenance-scheduler.unit.ts`, `ops-defaults.md` | Candidate for P0-3. Needs contract review and DB-backed coverage |
| Worker heartbeat | `app/src/main-worker.ts`, `app/src/main.ts`, `app/test/worker-heartbeat.unit.ts`, `app/package.json`, `ops-defaults.md` | Candidate for P0-4. Needs startup failure cleanup review |
| Readiness wording | `docs/current-readiness-report.md`, `docs/rpa-gap-remediation-plan-2026-06-27.md` | Must say "draft", not "closed" |
| Full design | `docs/rpa-adoption-full-design-2026-06-29.md` | Approved design baseline for next contract PRs |

## Blocking Review Findings Before Adoption

External review score accepted for current readiness: overall 73/100, design
about 80, draft implementation about 63. The draft implementation must not be
adopted before the confirmed-high cluster below is closed.

Confirmed-high cluster:

1. MD-1: `resolveMaintenanceTenantIds` must not rely on unguarded cross-tenant
   queries. It must use either tenant-scoped non-BYPASSRLS transactions with
   `SET LOCAL app.tenant_id`, or a dedicated BYPASSRLS operational role with
   immutable `bypassrls.use` audit evidence.
2. MD-2: daily artifact integrity and orphan sweepers must not be gated by a
   non-empty `MAINTENANCE_TENANT_IDS` list. Orphan sweeping is global and must be
   scheduled once per cadence; integrity/retention must either discover tenants
   safely or surface a blocked/deferred alert.
3. MIG-1: existing DB baseline must verify more than table count and
   `relrowsecurity`/`relforcerowsecurity` flags. Policy body, strict tenant
   binding, constraints, FKs, and audit append-only trigger are required before
   inserting `baseline=true` ledger rows.
4. DEP-01: compose/API/worker product-open evidence must use non-`SUPERUSER`,
   non-`BYPASSRLS` app roles. Superuser smoke is catalog-only evidence.
5. HB-1: worker heartbeat must start only after runtime dependencies are ready,
   or be stopped on any later startup failure.

1. The Compose migrator now calls `scripts/db-migrate.mjs`, but it has not been
   proven against a real PostgreSQL container in this environment. Treat it as a
   runner implementation candidate until fresh-install, baseline, checksum drift,
   and re-run smoke evidence exist.
2. `startWorker` starts heartbeat before all later worker dependencies are
   initialized. If a later startup step throws, the heartbeat timer can outlive a
   failed worker start. The implementation PR must stop heartbeat in that failure
   path.
3. Maintenance discovery hardcodes artifact redaction attempt threshold `5`.
   The implementation PR should bind this to `artifact.redaction_fail_threshold`
   or document why the SQL constant is acceptable.
4. Docker/Compose has not been verified with `docker compose config` in this
   environment because Docker CLI availability has not been proven in the current
   run.
5. Worker profile depends on Vault/LLM/browser runtime values. The local compose
   path must clearly separate API-only smoke from worker smoke so missing external
   secrets are not reported as product failure.

P2/P3 design hygiene backlog:

| ID | Design action |
|---|---|
| DEP-03 | `/readyz` must include migration ledger/topology readiness before controlled-prod |
| DEP-04 | Docker base image digest and Chromium version pinning decision required for browser automation reproducibility |
| CC-1 | `POST /v1/document-jobs/{job_id}/validation-task` duplicate definitions should be cross-linked rather than redefined |
| CC-2 | `worker.stale_threshold` is now an ops-default; implementation literals must reference it |
| CC-3 | `integration.handoff` route cannot be implemented until RBAC action/codegen/role policy are updated |
| DC-3 | ROI payback must return `null`/`not_viable` when monthly value is non-positive |
| DEP-05 | Production command should not rely on `tsx` runtime unless explicitly accepted as a packaging decision |
| DEP-08 | worker/lifecycle-worker healthcheck and restart policy need profile-specific decisions |

## Contract And Implementation Work Completed In PR0

- `db/README.md` now defines the versioned migration runner contract:
  `schema_migrations`, fresh install, existing DB baseline, checksum drift,
  out-of-order rejection, and rollback boundaries.
- `ops-defaults.md` now includes migration runner defaults in addition to the
  maintenance discovery and worker heartbeat parameters.
- `scripts/db-migrate.mjs` now provides a repo-local runner that creates
  `schema_migrations`, records SHA-256 checksums, supports existing DB baseline,
  rejects checksum drift, and can run the DB smoke after migration.
- `compose.yaml` now routes the migration service through the repo-local runner
  instead of raw SQL skip logic.
- Readiness/remediation docs now mark the current implementation as a draft.

## Next Recommended PR

Continue hardening P0-2 migration runner and baseline with a real PostgreSQL
fresh-install/baseline smoke run, then move to P0-5 credential lease dispatch.

Required scope:

- Add unit coverage for ledger behavior and a PostgreSQL smoke path for the
  ordered migrations.
- Run `docker compose config` and compose migration smoke once Docker is
  available in the environment.
