# Product Open Candidate Report

This report records the repository evidence for a Product Open Candidate state.
It is a contract-first candidate report, not an external release approval or
deployment authorization. The tagged Product Open Candidate baseline has green
repo-controlled evidence on `main`; the last merged staging-readiness baseline
has PR #6 and post-merge `main` remote CI evidence, but later D4.4 deltas still
need their own green remote Contract Gates evidence before they can be cited as
current. This delta names and evidences the durable security audit writer
boundary locally, including PostgreSQL append evidence; any remaining active blocker is listed in
`release-open-checklist.md` and the packets below. External
Product Open still requires the resolved staging/release owners to approve and
operate the deployment path outside this repository.

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
  an expanded SecretRef evidence packet with five specific unchecked rows.
  The durable security audit writer D4.4 row is now resolved locally by
  `DurableSecurityAuditDecisionWriter` evidence.
  The current audit enforces both directions: every actionable blocked-decision
  marker is tracked by an active checklist blocker, every active unchecked
  staging/open blocker has a matching actionable TODO, and each split SecretRef
  evidence row has a matching specific evidence-packet TODO line. Current local
  output: 22 markers, 8 actionable blockers, 13 known release decisions tracked,
  and 13 release decisions checked. New unresolved
  behavior must still use the repository
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
  `app/test/api-runs-graphile.int.ts`, `app/test/scenarios.int.ts`, and
  `app/test/security-audit.int.ts`.
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
  (current output: 22 markers, 8 actionable blockers, 13 known release
  decisions tracked, 13 release decisions checked)
- `npm --prefix codegen run yaml:parse`
  (parses every workflow YAML plus OpenAPI/AsyncAPI, preserves the GitHub
  Actions `on` key, blocks deploy/environment-bound contract jobs, and requires
  checkout steps to set `persist-credentials: false`)
- `npm --prefix codegen run secret:scan-fixtures`
  (covers reject/allow fixtures for workflow secret contexts,
  scalar/quoted/object-form `environment: staging`, one-line and block env
  dump/xtrace commands, YAML `env:` maps, and CI-only PostgreSQL smoke
  credentials)
- `npm --prefix codegen run secret:scan`
  (covers high-risk secret markers plus staging workflow hazards such as
  GitHub secret context references, scalar/quoted/object-form
  `environment: staging`, and env dump/xtrace commands)
- `npm --prefix codegen run db:static-smoke`
  (covers artifact redaction RLS, immutable audit hash-chain, idempotency/CAS
  anchors, explicit and missing `events_outbox.retention_until` smoke fixtures,
  and rollback harness)
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
- PR #6 merged staging-readiness baseline evidence packet:
  `https://github.com/xorrbss/RPA-Enterprise/pull/6`
- `main` after PR #6:
  `https://github.com/xorrbss/RPA-Enterprise/actions/runs/27497854075`
  (`Contract Gates` success on merge `357795d2eff3a3f7f1d0c6a559f94e53f7f9f271`).
- Post-merge `main` required merged-baseline job URLs:
  `secret-scan`: `https://github.com/xorrbss/RPA-Enterprise/actions/runs/27497854075/job/81275168021`
  `PostgreSQL 15 migration smoke`: `https://github.com/xorrbss/RPA-Enterprise/actions/runs/27497854075/job/81275168108`
  `App runtime typecheck and tests`: `https://github.com/xorrbss/RPA-Enterprise/actions/runs/27497854075/job/81275168208`

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

- Repo-controlled Product Open Candidate gap: none remain for the tagged
  repo-controlled Product Open Candidate baseline. Last merged
  staging-readiness baseline remote evidence is represented by PR #6 and
  post-merge `main` `Contract Gates` run `27497854075`; this closes only the
  merged-baseline remote evidence pointer and does not close later branch/delta
  evidence requirements. This branch delta still needs its own green remote
  Contract Gates evidence before being cited as current.
- Current D4.4 branch-delta gap: executable scenario runtime readiness now has
  per-expression `compiled_ast` export, app promote `If-Match`/idempotency
  coverage, `SecretRef`/`SecretStore`-backed signed command registry wiring
  for shell `cmd_ref` validation, repo-owned `events_outbox.retention_until`
  source/duration/calculation/fail-closed evidence, and durable security audit
  writer coverage for security boundary decisions. No repo-controlled D4.4
  blocker remains in the local checklist after this delta; remaining blockers
  are external/staging scope and must not be inferred closed.
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
- TODO: [BLOCKED] External concrete staging deploy target is not defined for executable Product Open deployment outside this contract repository.
  Required decision: Platform/release authority must name the exact staging platform repo, GitHub Environment `staging` protection/approver configuration, concrete deploy target identifier (namespace/service or equivalent), rollback owner, release approver, and SecretRef/SecretStore provisioning path before staging/open deployment is authorized.
- TODO: [BLOCKED] External staging SecretRef/SecretStore provisioning readiness is not defined outside this repository.
  Required decision: External staging secret provisioning must name the SecretStore backend (Vault mount/path or cloud KMS/secret-manager alias), SecretRef namespace convention, runtime identities allowed to resolve each namespace, initial secret inventory, rotation owner/cadence, and evidence location. No staging deploy may proceed until CI/deploy logs prove no plaintext secret materialization, no env dump, and no weakening of RBAC/redaction gates.
- TODO: [BLOCKED] External staging producer retention duration/source policy is not defined for non-app writers that must set `retention_until`.
  Required decision: Runtime/platform owners must define per-producer retention duration/source for `raw_items.raw_payload`, `normalized_records.record`, `artifacts.object_ref`, `audit_log.payload`, and any non-D4.3 writer of `control_plane_idempotency_keys.response_body`; the D4.3 app idempotency writer uses `expires_at` as the repo-controlled retention source, while repo-owned `events_outbox` retention is tracked separately above. Staging evidence must prove each payload-bearing writer sets `retention_until` or fails closed.

### Durable Security Audit Writer Decision Packet

Resolved locally for the repo-owned boundary/evidence slice:

- Boundary: `DurableSecurityAuditDecisionWriter` in
  `ts/security-middleware-contract.ts`; app-runtime durable implementation:
  `PgDurableSecurityAuditDecisionWriter` in `app/src/api/security-audit.ts`.
- Covered security decisions: `artifact.read`, `secret.resolve`,
  `connector.enable`, `connector.install`, `network.request`, `prompt.inspect`,
  and `bypassrls.use`.
- Durable schema anchor: PostgreSQL `audit_log.payload_schema_ref` is fixed to
  `audit/security-boundary-decision@1`; unknown refs fail closed at insert time.
- Runtime evidence: `security/compliance-scaffold.ts`
  `ContractDurableSecurityAuditWriter` proves the typed boundary, while
  `app/src/api/security-audit.ts` `PgDurableSecurityAuditDecisionWriter`
  appends to PostgreSQL `audit_log` before returning the protected decision,
  rejects PlainSecret payloads through `safeSerialize`, validates
  `retentionUntil`, and fails closed if durable append is unavailable.
- Test evidence: `npm --prefix codegen run redaction:audit-smoke` covers all
  listed actions, append-before-return, append failure, and PlainSecret payload
  rejection; `app/test/security-audit.int.ts` covers PostgreSQL hash-chain,
  payload schema, retention, duplicate-idempotency, PlainSecret rejection, and
  fail-closed append behavior.
- Scope note: broader Fastify routes that do not exist in the repo-owned app
  runtime are still scoped out until implemented or explicitly wired to this
  boundary.

### Events Outbox Retention Decision Packet

Resolved for repo-owned app/runtime outbox producers.

- Source: `ops-defaults.md#events_outbox.retention_default`, passed explicitly
  into `emitOutboxEvent` as `EVENTS_OUTBOX_RETENTION_POLICY`.
- Duration/scope: uniform 90d for every tenant-scoped `events_outbox` event
  type in v1.
- Calculation basis: `retention_until = PostgreSQL transaction timestamp
  (now()) + duration`; supplied `occurredAt` only sets envelope `occurred_at`
  and does not backdate retention.
- Fail-closed behavior: missing, unsupported, non-finite, or non-positive
  runtime policy input throws before insert, and `events_outbox.retention_until`
  is `NOT NULL` so direct SQL producers cannot persist unknown retention.
- Evidence: `app/test/graphile-worker.int.ts` covers missing/invalid runtime
  policy and supplied historical `occurredAt`; `app/test/run-transition.int.ts`
  covers transition-produced rows; `db/migration_smoke.sql` and
  `scripts/db-static-smoke.mjs` cover direct SQL NULL rejection.

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
4. Keep the durable security audit writer wired as broader security-relevant app
   routes are implemented.
5. Keep any new unresolved behavior out of implementation paths unless it uses
   the repository blocked-decision marker with nearby required-decision text.
