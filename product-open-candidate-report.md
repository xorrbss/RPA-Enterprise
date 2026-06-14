# Product Open Candidate Report

This report records the repository evidence for a Product Open Candidate state.
It is a contract-first candidate report, not an external release approval or
deployment authorization. The tagged Product Open Candidate baseline has green
repo-controlled evidence on `main`; the current staging-readiness delta still
requires remote `app-runtime` CI evidence before it can be claimed as updated
candidate evidence. External Product Open still requires the resolved
staging/release owners to approve and operate the deployment path outside this
repository.

## Candidate Status

- Candidate tag: `product-open-candidate-2026-06-14`.
- `main` includes Product Open Candidate PR #2 and Node 24 CI PR #3. The D4.2
  RBAC evidence update adds the control-plane role matrix middleware and route
  authorization boundary before the candidate tag is created.
- Repo-controlled automated gates are repeatable locally with DB coverage through
  `npm --prefix codegen run ci:local:temp-db` when PostgreSQL 15 binaries are
  installed, or through `npm --prefix codegen run ci:local` when `PSQL_BIN`/PG
  env already points at a PostgreSQL 15 database with a role that is not
  `SUPERUSER` and does not have `BYPASSRLS`. The direct local gate fails before
  DB-dependent checks if it cannot prove that non-bypass role posture. These
  local gates include the app-runtime typecheck/unit checks and, when DB is
  available, app integration tests. `ci:local:no-db` is the documented exception
  path only when PostgreSQL 15 binaries are unavailable.
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
- The D4.3 app idempotency producer writes
  `control_plane_idempotency_keys.retention_until` from the same source as
  `expires_at`, so persisted command responses have an explicit retention
  boundary instead of a silent unknown.
- D4.2 control-plane RBAC is wired for `GET /v1/runs/{run_id}` using
  `auth-rbac.md` §2. Routes without an explicit `rbacAction` fail closed, while
  unmatched routes and unsupported methods converge to `RESOURCE_NOT_FOUND`
  instead of leaking authorization state.
- GitHub Actions contract gates now run under Node 24 with Node 24-compatible
  official actions (`actions/checkout@v5`, `actions/setup-node@v5`).
- The 13 release decisions are resolved and tracked by
  `release-open-checklist.md` / `release-decisions.md`.
- `blocked:audit` reports the repo-controlled candidate decisions plus active
  blockers split by scope: external/staging blocker categories for concrete
  deploy target, secret provisioning, and non-app producer retention policy;
  an expanded SecretRef evidence packet with five specific unchecked rows; and
  one repo-controlled D4.4 branch-delta blocker for the
  `events_outbox.retention_until` source used by the app/runtime outbox helper.
  The current audit enforces both directions: every actionable blocked-decision
  marker is tracked by an active checklist blocker, every active unchecked
  staging/open blocker has a matching actionable TODO, and each split SecretRef
  evidence row has a matching specific evidence-packet TODO line. Current local
  output: 24 markers, 10 actionable blockers, and 13 resolved release decisions
  checked. New unresolved behavior must still use the repository
  blocked-decision marker with nearby required-decision text.

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
- App runtime/API staging-readiness delta: `app/src/api/*`,
  `app/src/runtime/outbox.ts`, `app/test/api-runs.int.ts`,
  `app/test/api-runs-graphile.int.ts`, and `app/test/scenarios.int.ts`.
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
- `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app run test:ci`
- App integration now includes real `PgGraphileRunEnqueuer` commit/rollback
  evidence for `POST /v1/runs` `run_claim` enqueue and D4.4
  `SignedCommandRegistry` registry-ref use during save/validate/promote; shell
  `cmd_ref` tests cover registered, unregistered, and registry-unavailable
  paths.
- `npm --prefix codegen test`
- `npm --prefix codegen run typecheck`
- `npm --prefix codegen run fixtures`
- `npm --prefix codegen run api:smoke`
- `npm --prefix codegen run redaction:audit-smoke`
- `npm --prefix codegen run runtime:recovery-smoke`
- Gateway regression fixture: `*.vendor.example` permits
  `app.vendor.example:8443` but blocks apex `vendor.example` in the LLM
  redaction boundary.
- `npm --prefix codegen run blocked:audit`
  (current output: 24 markers, 10 actionable blockers, 13 known release
  decisions tracked, 13 release decisions checked)
- `npm --prefix codegen run secret:scan-fixtures`
  (covers reject/allow fixtures for workflow secret contexts,
  `environment: staging`, one-line and block env dump commands, YAML `env:`
  maps, and CI-only PostgreSQL smoke credentials)
- `npm --prefix codegen run secret:scan`
  (covers high-risk secret markers plus staging workflow hazards such as
  GitHub secret context references, `environment: staging`, and env dump
  commands)
- `npm --prefix codegen run db:static-smoke`
  (covers artifact redaction RLS, immutable audit hash-chain, idempotency/CAS
  anchors, smoke-only explicit `events_outbox.retention_until` fixtures, and
  rollback harness)
- `npm --prefix codegen run html:smoke`
- `npm --prefix codegen run html:http-smoke`
- `python scripts/yaml-parse.py`
- `git diff --check`
- `node --check` for the repo-local gate scripts
- `npm --prefix codegen run db:temp-smoke` for a repo-local temp PostgreSQL
  cluster wrapper around the same non-bypass DB smoke. The full temp-DB local
  gate uses the same wrapper and verified `rpa_smoke` as non-`SUPERUSER` and
  non-`BYPASSRLS`.

Rollback/recovery evidence:

- Repo rollback/recovery evidence is limited to contract-controlled checks: DB
  smoke rolls back its isolated migration transaction, and runtime fixtures cover
  DLQ replay plus idempotent recovery. This repository does not claim staging or
  production deploy rollback smoke.

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
- Current staging-readiness delta adds the `app-runtime` CI job for app
  typecheck/unit/integration tests. Remote evidence is pending until this branch
  is pushed and GitHub Actions runs that job.

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

- Repo-controlled Product Open Candidate gap: remote `app-runtime` CI evidence
  for the current staging-readiness delta is pending until this branch is pushed
  and GitHub Actions runs that job. After that evidence is attached, none remain
  for the tagged repo-controlled Product Open Candidate baseline; this does not
  close the current D4.4 staging-readiness delta below.
- Current D4.4 branch-delta gap: executable scenario runtime readiness now has
  per-expression `compiled_ast` export, app promote `If-Match`/idempotency
  coverage, and `SecretRef`/`SecretStore`-backed signed command registry wiring
  for shell `cmd_ref` validation. The remaining repo-controlled app-runtime gap
  is the `events_outbox.retention_until` source for repo-owned outbox producers.
  This is tracked in `release-open-checklist.md` and must not be inferred.
- Current app-runtime scope gap: the real Fastify app gate covers the wired app
  routes (`GET/POST /v1/runs` subset plus scenario create/read/validate/promote).
  Broader api-surface routes such as run abort, human-task commands, workitem/DLQ
  replay, artifact read, gateway policy update, and site approval still rely on
  contract/fake control-plane fixtures until their real app routes are
  implemented or explicitly scoped out of a staging packet.
- External Product Open gap: staging approval, secret provisioning, deployment,
  rollback ownership, and any production/staging operation remain outside this
  contract-first repository. Those steps must use the resolved staging decision
  and must not materialize plaintext secrets in this repo.
- TODO: [BLOCKED] Repo-owned events_outbox retention source is not defined for executable app-runtime staging readiness.
  Required decision: Contract/runtime owners must define the duration/source used by `emitOutboxEvent` to populate `events_outbox.retention_until`; after the decision, app/runtime producers must set `retention_until` from that source or fail closed instead of persisting an unknown retention boundary.
- TODO: [BLOCKED] External concrete staging deploy target is not defined for executable Product Open deployment outside this contract repository.
  Required decision: Platform/release authority must name the exact staging platform repo, GitHub Environment `staging` protection/approver configuration, concrete deploy target identifier (namespace/service or equivalent), rollback owner, release approver, and SecretRef/SecretStore provisioning path before staging/open deployment is authorized.
- TODO: [BLOCKED] External staging SecretRef/SecretStore provisioning readiness is not defined outside this repository.
  Required decision: External staging secret provisioning must name the SecretStore backend (Vault mount/path or cloud KMS/secret-manager alias), SecretRef namespace convention, runtime identities allowed to resolve each namespace, initial secret inventory, rotation owner/cadence, and evidence location. No staging deploy may proceed until CI/deploy logs prove no plaintext secret materialization, no env dump, and no weakening of RBAC/redaction gates.
- TODO: [BLOCKED] External staging producer retention duration/source policy is not defined for non-app writers that must set `retention_until`.
  Required decision: Runtime/platform owners must define per-producer retention duration/source for `raw_items.raw_payload`, `normalized_records.record`, `artifacts.object_ref`, `audit_log.payload`, and any non-D4.3 writer of `control_plane_idempotency_keys.response_body`; the D4.3 app idempotency writer uses `expires_at` as the repo-controlled retention source, while repo-owned `events_outbox` retention is tracked separately above. Staging evidence must prove each payload-bearing writer sets `retention_until` or fails closed.

### Staging Secret Provisioning Evidence Packet

External owners must provide this packet with redacted aliases and `SecretRef`
identifiers only. Do not record secret values, resolved SecretRef material, env
dumps, or deployment credentials in this repository.

- TODO: [BLOCKED] External staging SecretRef/SecretStore provisioning readiness evidence is missing the SecretStore backend alias/path.
  Required decision: External staging owners must name the Vault mount/path or cloud KMS/secret-manager alias used by staging without exposing plaintext secret values.
- TODO: [BLOCKED] External staging SecretRef/SecretStore provisioning readiness evidence is missing the SecretRef namespace convention and runtime identity map.
  Required decision: External staging owners must name the namespace convention and the runtime identities allowed to resolve each namespace before staging deploy.
- TODO: [BLOCKED] External staging SecretRef/SecretStore provisioning readiness evidence is missing the initial SecretRef inventory.
  Required decision: External staging owners must list initial SecretRef identifiers, owning service/runtime, and intended purpose only; resolved secret material must remain outside this repository.
- TODO: [BLOCKED] External staging SecretRef/SecretStore provisioning readiness evidence is missing rotation and break-glass ownership.
  Required decision: External staging owners must name the rotation owner/cadence and break-glass/update procedure before staging deploy.
- TODO: [BLOCKED] External staging SecretRef/SecretStore provisioning readiness evidence is missing CI/deploy negative-log proof.
  Required decision: External staging owners must provide the evidence artifact location proving no plaintext secret materialization, no env dump, and no RBAC/redaction weakening in staging CI/deploy logs.

## Next 24h Actions

1. Attach the tag, latest `contract-gates` run URL, DB migration smoke job, and
   UI smoke screenshot/note to the external release review packet.
2. Hand external Product Open to the resolved staging owners:
   `release-approvers` for approval and `platform-oncall` for rollback.
3. Obtain the concrete external staging deploy target, SecretStore provisioning
   evidence, release approver, and rollback confirmation before any staging/open
   deployment.
4. Define the repo-owned `events_outbox.retention_until` source and then update
   `emitOutboxEvent` plus app/runtime tests to set or fail closed on retention.
5. Keep any new unresolved behavior out of implementation paths unless it uses
   the repository blocked-decision marker with nearby required-decision text.
