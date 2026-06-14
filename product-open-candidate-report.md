# Product Open Candidate Report

This report records the repository evidence for a Product Open Candidate state.
It is a contract-first candidate report, not an external release approval or
deployment authorization. Repo-controlled Product Open Candidate gates are green
on `main`; external Product Open still requires the resolved staging/release
owners to approve and operate the deployment path outside this repository.

## Candidate Status

- Candidate tag target: `product-open-candidate-2026-06-14`.
- `main` includes Product Open Candidate PR #2 and Node 24 CI PR #3. The D4.2
  RBAC evidence update adds the control-plane role matrix middleware and route
  authorization boundary before the candidate tag is created.
- Repo-controlled automated gates are repeatable locally with DB coverage through
  `npm --prefix codegen run ci:local:temp-db` when PostgreSQL 15 binaries are
  installed, or through `npm --prefix codegen run ci:local` when `PSQL_BIN`/PG
  env already points at a PostgreSQL 15 database with a role that is not
  `SUPERUSER` and does not have `BYPASSRLS`. The direct local gate fails before
  `db:smoke` if it cannot prove that non-bypass role posture. `ci:local:no-db`
  is the documented exception path only when PostgreSQL 15 binaries are
  unavailable.
- PostgreSQL live migration smoke has a repo-local wrapper, static smoke,
  runbook, GitHub Actions service-DB path, and local PostgreSQL 15 smoke
  evidence.
- UI smoke has static, localhost HTTP, and browser route evidence for the
  standalone HTML console.
- Gateway prompt-injection URL allowlist semantics are aligned with the network
  policy path: wildcard domains match subdomains only, not the apex domain.
- Gateway prompt-injection credential-exfiltration phrases such as `send token`
  are blocked even when the referenced URL is on the network allowlist.
- Control-plane and gateway security scaffolds enforce `run.create` RBAC,
  human-task assignee scope, pre-mask credential-exfiltration detection, and
  tenant-scoped LLM idempotency keys.
- D4.2 control-plane RBAC is wired for `GET /v1/runs/{run_id}` using
  `auth-rbac.md` §2. Routes without an explicit `rbacAction` fail closed, while
  unmatched routes and unsupported methods converge to `RESOURCE_NOT_FOUND`
  instead of leaking authorization state.
- GitHub Actions contract gates now run under Node 24 with Node 24-compatible
  official actions (`actions/checkout@v5`, `actions/setup-node@v5`).
- The 13 release decisions are resolved and tracked by
  `release-open-checklist.md` / `release-decisions.md`.
- `blocked:audit` reports zero actionable blockers. New unresolved behavior must
  still use the repository blocked-decision marker with nearby required-decision
  text.

## Changed Files

Tracked modified contract/artifact areas:

- Root contracts and release notes: `.gitignore`, `README.md`, `CLAUDE.md`,
  `api-surface.md`, `auth-rbac.md`, `ir-static-validation.md`,
  `llm-gateway-adapter.md`, `ops-defaults.md`, `reserved-handlers.md`,
  `security-contracts.md`, `state-machine.md`, `d4-prompt.md`.
- Schemas and generated/public contract outputs: `schema/*.json`,
  `codegen/openapi.yaml`, `codegen/asyncapi.yaml`, `codegen/types.ts`,
  `codegen/validators.ts`, `ts/*.ts`.
- State machine and fixtures: `codegen/run-fixtures.ts`,
  `codegen/transitions.ts`, `codegen/transitions.fixtures.ts`,
  `codegen/validators.fixtures.ts`.
- DB contracts: `db/migration_concurrency_idempotency.sql`,
  `db/migration_core_entities.sql`.
- UI mock: `rpa_enterprise_console.html`.

New repo-local support artifacts:

- `.github/workflows/contract-gates.yml`
- `release-open-checklist.md`
- `release-decisions.md`
- `product-open-candidate-report.md`
- `product-open-browser-smoke.png` (local UI evidence artifact)
- `db/README.md`
- `db/migration_smoke.sql`
- `scripts/blocked-decisions-audit.mjs`
- `scripts/contract-lint.mjs`
- `scripts/db-migration-smoke.mjs`
- `scripts/db-static-smoke.mjs`
- `scripts/html-smoke.mjs`
- `scripts/html-http-smoke.mjs`
- `scripts/run-local-gates.mjs`
- `scripts/secret-scan.mjs`
- `scripts/yaml-parse.py`
- `codegen/contract-consistency.ts`
- `codegen/control-plane.fixtures.ts`
- `codegen/event-payload-registry.ts`
- `codegen/event-schema.fixtures.ts`
- `codegen/gateway.fixtures.ts`
- `codegen/irel-compile.ts`
- `codegen/irel.fixtures.ts`
- `codegen/runtime.fixtures.ts`
- `codegen/security.fixtures.ts`
- `codegen/static-validation.ts`
- `control-plane/*`
- `gateway/*`
- `runtime/*`
- `schema/events/*`
- `security/*`
- `ts/control-plane-contract.ts`
- `ts/runtime-contract.ts`
- `ts/security-middleware-contract.ts`

## Verification Evidence

Passed locally:

- `npm --prefix codegen run ci:local:no-db`
- `npm --prefix codegen run ci:local:temp-db`
- `npm --prefix app run typecheck`
- `npm --prefix app run test:unit`
- `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app run test:int`
- `npm --prefix codegen test`
- `npm --prefix codegen run typecheck`
- `npm --prefix codegen run fixtures`
- Gateway regression fixture: `*.vendor.example` permits
  `app.vendor.example:8443` but blocks apex `vendor.example` in the LLM
  redaction boundary.
- `npm --prefix codegen run blocked:audit`
- `npm --prefix codegen run db:static-smoke`
- `npm --prefix codegen run html:smoke`
- `npm --prefix codegen run html:http-smoke`
- `python scripts/yaml-parse.py`
- `git diff --check`
- `node --check` for the repo-local gate scripts
- `npm --prefix codegen run db:temp-smoke` for a repo-local temp PostgreSQL
  cluster wrapper around the same non-bypass DB smoke. The full temp-DB local
  gate uses the same wrapper and verified `rpa_smoke` as non-`SUPERUSER` and
  non-`BYPASSRLS`.

Remote CI evidence:

- PR #2 Product Open Candidate gates:
  `https://github.com/xorrbss/RPA-Enterprise/actions/runs/27489202401`
- `main` after PR #2:
  `https://github.com/xorrbss/RPA-Enterprise/actions/runs/27489228840`
- `main` after Product Open README evidence patch:
  `https://github.com/xorrbss/RPA-Enterprise/actions/runs/27489263731`
- PR #3 Node 24 gates:
  `https://github.com/xorrbss/RPA-Enterprise/actions/runs/27489653721`
- `main` after PR #3:
  `https://github.com/xorrbss/RPA-Enterprise/actions/runs/27489679454`

Browser route smoke evidence:

- `html:http-smoke` derives the 11 routes from the console `viewMeta`, serves the
  standalone HTML on `127.0.0.1`, and verifies initial `#openGate` deep-link
  render, hashchange render for every route, invalid-hash fallback to
  `#dashboard`, and Product-open to workitems nav-click routing without backend
  calls.
- Served `rpa_enterprise_console.html` on `127.0.0.1` with an ephemeral local
  HTTP server.
- Opened the HTTP-served console in local Chrome through Playwright and verified
  all 11 hash routes became active with non-empty content and no page or console
  errors.
- Captured Product-open route screenshot evidence at
  `product-open-browser-smoke.png`.

Environment note:

- `psql` was installed through `winget` as PostgreSQL 15.18. In this Codex app
  process, use `PSQL_BIN=C:\Program Files\PostgreSQL\15\bin\psql.exe`; new user
  terminals should pick up the updated user PATH.
- The installed default Windows PostgreSQL service listens on `localhost:5432`
  and requires password authentication. Smoke evidence was captured against an
  isolated temporary cluster instead of changing that service's authentication
  config.

## Resolved Release Decisions

- The 13 Product Open decisions are resolved in `release-decisions.md`.
- Dependent schema/DB/TS/codegen/runtime artifacts have been migrated to those
  decisions for the repo-controlled Product Open gate surface.

## Remaining Gap to Product Open

- Repo-controlled Product Open Candidate gap: none after the D4.2 RBAC evidence
  PR is green on `main` and the candidate tag is pushed.
- External Product Open gap: staging approval, secret provisioning, deployment,
  rollback ownership, and any production/staging operation remain outside this
  contract-first repository. Those steps must use the resolved staging decision
  and must not materialize plaintext secrets in this repo.

## Next 24h Actions

1. Merge the D4.2 RBAC evidence PR after local and remote gates are green.
2. Create and push annotated tag `product-open-candidate-2026-06-14` on the
   final green `main` commit.
3. Attach the tag, latest `contract-gates` run URL, DB migration smoke job, and
   UI smoke screenshot/note to the external release review packet.
4. Hand external Product Open to the resolved staging owners:
   `release-approvers` for approval and `platform-oncall` for rollback.
5. Keep any new unresolved behavior out of implementation paths unless it uses
   the repository blocked-decision marker with nearby required-decision text.
