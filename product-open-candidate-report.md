# Product Open Candidate Report

This report records the current repository evidence for a Product Open Candidate
state. It is a contract-first candidate report, not an external release approval.
Product Open itself now depends on capturing remote CI evidence and completing
manual release review outside this contract-first repository.

## Candidate Status

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

- CI should still capture the GitHub Actions service-DB smoke as remote release
  evidence.
- Remote GitHub Actions cannot be run from this exact worktree yet:
  `.github/workflows/contract-gates.yml` is untracked, absent from
  `origin/main`, and `feat/d2-runtime` is not a remote branch. The workflow must
  first be included in a commit and pushed through a branch/PR before
  `contract-gates` can produce release evidence.
- Manual release review still needs PR-level evidence attachment: gate outputs,
  UI route smoke note/screenshot, and DB smoke result or documented
  local-environment exception.

## Next 24h Actions

1. Commit the workflow/checklist/report artifacts, push a branch or open a PR,
   and confirm GitHub shows the `contract-gates` workflow for that remote ref.
2. Capture the remote `contract-gates` run URL from the PR/push run, or use
   `workflow_dispatch` only after the workflow file is present remotely, then
   attach the `db-migration-smoke` job result.
3. If local DB evidence is required, install PostgreSQL 15 client/server or set
   `PSQL_BIN`/PG env to an existing PostgreSQL 15 target and run
   `npm --prefix codegen run db:smoke`; otherwise run
   `npm --prefix codegen run db:temp-smoke`.
4. Attach the local `ci:local:temp-db` evidence, including PostgreSQL 15.18 and
   non-`SUPERUSER`/non-`BYPASSRLS` `rpa_smoke` role proof.
5. Attach `product-open-browser-smoke.png` or an equivalent reviewer note for
   the Product-open gate and representative route coverage.
