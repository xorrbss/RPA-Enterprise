# Product Open Candidate Report

This report records the repository evidence for a Product Open Candidate state.
It is a contract-first candidate report, not an external release approval or
deployment authorization. The tagged Product Open Candidate baseline has green
repo-controlled evidence on `main`; the current merged repo-controlled product-code
evidence is `main` `Contract Gates` run `27849888784` on commit
`939fa31f1cb4e413fc1080287165becc6fc4bf55`, superseding the earlier D4.4
and Phase 7 remote evidence packets for current-main release judgment.
This current merged delta names and evidences the durable security audit writer
boundary, including PostgreSQL append evidence; any remaining active blocker is listed in
`release-open-checklist.md` and the packets below. Product
Open still requires the project owner to approve and operate the deployment
path at deploy time (no external release/oncall team exists).

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
  boundary instead of a silent unknown. Expired `processing` rows are reclaimable
  only for the same canonical request hash; different-hash reuse still maps to
  `SCENARIO_VERSION_CONFLICT` instead of silently re-running side effects.
  Cross-tenant `scenario_version_id` and `workitem_id` command references fail
  without enqueueing, while the same idempotency key remains tenant-local and
  independently usable by the owning tenant.
- D4.2 control-plane RBAC is wired for `GET /v1/runs/{run_id}` using
  `auth-rbac.md` §2. Routes without an explicit `rbacAction` fail closed, while
  unmatched routes and unsupported methods converge to `RESOURCE_NOT_FOUND`
  instead of leaking authorization state.
- GitHub Actions contract gates now run under Node 24 with Node 24-compatible
  official actions (`actions/checkout@v5`, `actions/setup-node@v5`).
- The 13 release decisions are resolved and tracked by
  `release-open-checklist.md` / `release-decisions.md`.
- `blocked:audit` reports the repo-controlled candidate decisions plus active
  blockers split by scope: the one remaining external/staging blocker category
  is the concrete staging platform/deploy target + GitHub Environment.
  Repo-controlled D4.5 API P1 and
  D3 runtime execution blocker rows are now resolved locally as fail-closed
  API behavior, real executor orchestration/outcome mapping, and artifact
  lifecycle port/evidence guardrails.
  The durable security audit writer D4.4 row remains resolved locally by
  `DurableSecurityAuditDecisionWriter` evidence.
  The current audit enforces both directions: every actionable blocked-decision
  marker is tracked by an active checklist blocker, every active unchecked
  staging/open blocker has a matching actionable TODO, and each split SecretRef
  evidence row has a matching specific evidence-packet TODO line. Current local
  output: 20 markers, 1 actionable blockers, 13 known release decisions tracked,
  13 release decisions checked (1 active deploy-time provisioning checklist rows;
  0 repo-controlled D4.5 API P1 open rows; 0 repo-controlled D3 runtime open rows). New unresolved behavior must still use the repository
  blocked-decision marker with nearby required-decision text.

## Changed Files / Evidence Scope

This section is a cumulative candidate/delta scope list, not a live
`git status` inventory. Every final release packet must also paste the current
`git status --short --branch -uall` and `git diff --stat` output before
approval. The Phase 7 runtime packet includes new recorder and
runtime-worker tests such as `app/src/runtime/executor-invocation-recorder.ts`,
`app/test/executor-invocation-recorder.int.ts`,
`app/test/graphile-runner.unit.ts`, `app/test/raw-cdp.unit.ts`, and
`app/test/runtime-worker-claim.int.ts`; they are not part of the tagged Product
Open Candidate baseline until merged and backed by a later PR/main gate.

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
  `app/src/runtime/outbox.ts`, `app/src/worker/runtime-worker.ts`,
  `app/src/gateway/llm-gateway.ts`,
  `app/src/gateway/pg-gateway-artifact-sink.ts`, `app/src/executor/*`, and the app tests
  covering API, Graphile enqueue, scenario promotion, security audit, raw CDP,
  gateway, artifact sink pending metadata, runtime-worker claim/lease behavior,
  and final executor invocation recording.
- D5 live capability harness: `app/poc/d5-codex-sse/*`. This is a
  credential-holder PoC harness only; pending live output is not release
  evidence.
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
- `scripts/validate-staging-release-packet.mjs`
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
- `npm --prefix app run test:executor`
  (D3 deterministic Stagehand v3/CDP dry-run only; this is not staging
  execution readiness because real executor orchestration,
  artifact redaction/retention jobs, executor audit semantics, and remote
  RBAC/tenant runtime gates remain unwired for real run execution.)
- `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app run test:int`
- App integration now includes real `PgGraphileRunEnqueuer` commit/rollback
  evidence for `POST /v1/runs` `run_claim` enqueue, queue-driven configured
  `run_claim` consumption evidence in the Phase 7 runtime delta, and D4.4
  `SignedCommandRegistry` registry-ref use during save/validate/promote; shell
  `cmd_ref` tests cover registered, unregistered, and registry-unavailable
  paths. It also includes final `PgExecutorInvocationRecorder` evidence for
  tenant-bound `run_steps`, canonical `step.completed` outbox refs, pending
  artifact metadata retention, stagehand ref rollback, duplicate/cross-tenant
  fail-closed behavior, and PlainSecret rejection. The D5
  `PgGatewayArtifactSink` integration covers producer-side pending artifact
  metadata/object-store writes, canonical `(run_id, step_id, attempt)` linkage,
  `outputRef` as `artifacts.id`/`ArtifactRef` while raw `object_ref` remains an
  internal `ObjectRef`, pending-redaction RLS invisibility, cross-tenant
  isolation, object cleanup on metadata insert failure/missing `run_step`,
  PlainSecret rejection before object write, and invalid retentionDays
  rejection. Control-plane fake fixtures now keep `/v1/artifacts/{artifact_id}`
  lookup keyed by `artifacts.id` and authorize the internal redacted `ObjectRef`
  only after redaction/RBAC gates pass before the artifact response exposes a
  `ref`. `app/test/api-human-tasks.int.ts` now covers D4.5 human_task command
  behavior: matching assignee and assignee_role can resolve, mismatched
  assignee or assignee_role returns `AUTHZ_FORBIDDEN` before idempotency-key
  reservation, denied tasks remain `in_progress`, H6 assign from `escalated`
  records the explicit reassigned assignee, and H5 manual escalate fails closed
  with rollback unless an explicit routing/assignment owner is configured. `app/test/api-runs-abort.int.ts`
  now proves queued abort cancellation, claimed abort BrowserLease expiry,
  claimed multi-lease fail-closed rollback, running/resuming abort `aborting`
  state entry with persisted `abort_source_status` and same-transaction
  `run_abort` enqueue, idempotent `aborting` replay re-enqueue, and fail-closed
  rejection of `suspending` before idempotency reservation unless a
  bookmark-cancel owner or durable abort intent is configured. `app/test/runtime-worker-abort-finalization.int.ts`
  proves `run_abort` drains and timeouts finalize through R23/R24 exactly once,
  expire BrowserLease rows by tenant/run/owner CAS, claim one lease as
  `draining` so duplicate jobs defer instead of invoking the drainer twice,
  release transient/terminal drain claims for retry, finalize expired leases via
  timeout without a false drain, fail closed on multiple leases, missing drain
  ports, or running-source missing workers, and preserve cancelled replay
  idempotency. `app/test/api-runs-graphile.int.ts` proves stale cancelled
  `run_claim` jobs are consumed without invoking the browser lease resolver.
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
  (current output: 20 markers, 1 actionable blockers, 13 known release
  decisions tracked, 13 release decisions checked (1 active deploy-time provisioning
  checklist rows; 0 repo-controlled D4.5 API P1 open rows; 0 repo-controlled D3
  runtime open rows))
- Current Phase 7 local gate evidence for 2026-06-15 KST includes
  DB-backed release posture from `npm --prefix codegen run ci:local:temp-db`,
  `npm --prefix codegen run db:temp-smoke`, or
  `node scripts/db-temp-postgres-gate.mjs -- npm --prefix codegen run db:smoke:release`,
  plus `npm --prefix app run typecheck`, `npm --prefix app run test:unit`,
  `npm --prefix app run test:executor`, and `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app run test:int`.
  `ci:local:no-db` remains diagnostic skip-only evidence and does not prove
  DB posture.
  This proves the local non-bypass PostgreSQL 15 posture for the Phase 7 runtime
  delta only; remote PR/main `Contract Gates` job URLs remain required before
  this delta can be cited as merged/current staging-open evidence.
- `npm --prefix codegen run yaml:parse`
  (parses every workflow YAML plus OpenAPI/AsyncAPI, preserves the GitHub
  Actions `on` key, blocks deploy/environment-bound contract jobs, and requires
  checkout steps to set `persist-credentials: false`)
- `npm --prefix codegen run secret:scan-fixtures`
  (covers reject/allow fixtures for workflow secret contexts,
  scalar/quoted/object-form `environment: staging`, one-line and block env
  dump/xtrace commands, YAML `env:` maps, and CI-only PostgreSQL smoke
  credentials, plus sensitive filename deny rules for `.env*`, private key,
  certificate bundle, and service-account JSON paths)
- `npm --prefix codegen run secret:scan`
  (covers high-risk secret markers plus staging workflow hazards such as
  GitHub secret context references, scalar/quoted/object-form
  `environment: staging`, and env dump/xtrace commands)
- `npm --prefix codegen run db:static-smoke`
  (covers artifact redaction RLS, immutable audit hash-chain, idempotency/CAS
  anchors, explicit and missing `events_outbox.retention_until` smoke fixtures,
  canonical `step.*` outbox ref checks, the artifact metadata retention
  deadline check, and rollback harness)
- `npm --prefix codegen run html:smoke`
- `npm --prefix codegen run html:http-smoke`
- `python scripts/yaml-parse.py`
- `npm --prefix app/poc/d5-codex-sse run typecheck`
  (harness typecheck only; live `npm --prefix app/poc/d5-codex-sse run poc`
  requires external Codex endpoint/model credentials and is not executed in
  this repository environment)
- `npm --prefix app/poc/d5-codex-sse run test:redaction`
  (proves D5 live evidence cells redact Bearer/sk/API-key/token/secret/password
  patterns, JSON-style provider error bodies, URL userinfo/query secrets,
  multiline/control characters, length overflow, and Markdown table pipes before
  release evidence is copied)
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
- PR #8 current D4.4 staging-readiness evidence packet:
  `https://github.com/xorrbss/RPA-Enterprise/pull/8`
- PR #8 head `Contract Gates` run:
  `https://github.com/xorrbss/RPA-Enterprise/actions/runs/27499567251`
- Historical `main` after PR #8:
  `https://github.com/xorrbss/RPA-Enterprise/actions/runs/27499599708`
  (`Contract Gates` success on merge `276bae845c74c5d40f218dec661fdcdc255afac6`).
- Historical D4.4 post-merge required job URLs:
  `secret-scan`: `https://github.com/xorrbss/RPA-Enterprise/actions/runs/27499599708/job/81279945156`
  `PostgreSQL 15 migration smoke`: `https://github.com/xorrbss/RPA-Enterprise/actions/runs/27499599708/job/81279945033`
  `App runtime typecheck and tests`: `https://github.com/xorrbss/RPA-Enterprise/actions/runs/27499599708/job/81279945101`
- Current `main` merged repo-controlled product-code evidence:
  `https://github.com/xorrbss/RPA-Enterprise/actions/runs/27849888784`
  (`Contract Gates` success on commit `939fa31f1cb4e413fc1080287165becc6fc4bf55`).
- Current `main` required job URLs:
  `secret-scan`: `https://github.com/xorrbss/RPA-Enterprise/actions/runs/27849888784/job/82426746756`
  `PostgreSQL 15 migration smoke`: `https://github.com/xorrbss/RPA-Enterprise/actions/runs/27849888784/job/82426746841`
  `App runtime typecheck and tests`: `https://github.com/xorrbss/RPA-Enterprise/actions/runs/27849888784/job/82426746745`
- Phase 7 `main` runtime-delta `Contract Gates` attempt:
  `https://github.com/xorrbss/RPA-Enterprise/actions/runs/27525226281`
  on commit `6ac33af251bd362a4de200d2eba956d371408cf3`. The latest non-skipped
  Phase 7 push run, the prior code-delta run `27524267891`, and the failed-job rerun did
  not start hosted runner jobs. GitHub Actions annotations report that recent
  account payments have failed or the spending limit must be increased. **That
  billing/admin blocker is now resolved**: hosted-runner execution is restored and
  `main` `Contract Gates` run `27609993667` (commit `848413ce`, post-merge of #82)
  first restored hosted-runner evidence, and the latest `main` `Contract Gates` run
  `27849888784` (commit `939fa31f1cb4e413fc1080287165becc6fc4bf55`) is the
  current success with the required `secret-scan` / `PostgreSQL 15 migration smoke` /
  `App runtime typecheck and tests` job URLs, closing the remote job URL gate for the
  Phase 7 delta as currently merged on `main`.

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
- Repo-controlled schema/DB/TS/codegen/runtime contract artifacts needed for
  the Product Open gate surface have been migrated to those decisions.

## Remaining Gap to Product Open

- Repo-controlled Product Open Candidate gap: none remain for the tagged
  repo-controlled Product Open Candidate baseline. Current merged repo-controlled
  remote evidence is represented by latest `main` `Contract Gates` run
  `27849888784` on commit `939fa31f1cb4e413fc1080287165becc6fc4bf55`; this closes only the
  repo-controlled D4.4 remote evidence pointer and does not close external
  staging/open approval or active external blockers.
- Current D4.4 repo-controlled contract/runtime evidence includes
  per-expression `compiled_ast` export, app promote `If-Match`/idempotency
  coverage, `SecretRef`/`SecretStore`-backed signed command registry wiring
  for shell `cmd_ref` validation, repo-owned `events_outbox.retention_until`
  source/duration/calculation/fail-closed evidence, and durable security audit
  writer coverage for security boundary decisions. No repo-controlled D4.4
  blocker remains in the local checklist after this delta; remaining blockers
  are external/staging scope and must not be inferred closed.
- Phase 7 local D3 runtime evidence: deterministic Stagehand v3/CDP
  UtilityExecutor/PageStateResolver is proven as PoC/dry-run evidence only.
  `PgRuntimeWorker` now has `run_resume` R17-R20 evidence that consumes the R17
  `restoreSession` side effect through an injected `SessionRestorer` outside
  the DB transaction, persists R17 worker ownership under tenant lock, maps
  restored/login-bypass/invalid-token outcomes through R18/R19/R20, and handles
  `resuming` retry plus active lease deferral.
  `PgRuntimeWorker` now has first-slice `run_claim` claim/BrowserLease gate
  evidence when an explicit worker identity and lease plan resolver are
  configured, plus first-slice `workitem_checkout` W1 `new → processing`
  evidence that requires worker identity and correlation id, fails duplicate
  checkout explicitly, and preserves tenant boundaries. `PgRuntimeWorker` also
  owns the closed `run_abort` runtime job for `running`/`resuming` aborts after
  `aborting` state entry, trusts persisted `abort_source_status`, resolves
  stored worker/BrowserLease ownership under tenant lock, claims exactly one
  active/reserved lease as `draining` before external drain work, defers
  duplicate jobs, invokes the injected `RunAbortDrainer` outside the DB
  transaction, finalizes drained/timeout/expired-lease outcomes through R23/R24,
  releases transient/terminal drain claims for retry without acknowledgement,
  and fails closed on ambiguous lease, missing worker, or port ownership.
  Graphile runtime task
  wiring can inject that worker identity and resolver without putting worker
  identity into the job payload, Graphile task
  acknowledgment is restricted to `completed` results so `deferred`/`failed`
  worker outcomes cannot become silent successes, non-browser or open-circuit
  workers reject fail-closed, the 5-minute browser lease default matches
  `ops-defaults.md`, and tenant/owner-bound BrowserLease
  heartbeat/drain CAS primitives plus tenant-scoped `lease_sweeper` evidence
  cover stale BrowserLease/CredentialLease expiry under RLS. The local
  `PgExecutorInvocationRecorder` slice persists final `StepResult` rows,
  canonical `step.completed` outbox events, and pending artifact metadata with
  explicit retention while failing closed on missing stagehand refs,
  duplicate/cross-tenant refs, missing step outbox refs, and PlainSecret values
  in JSON payloads plus page-state/artifact/object refs. `PgRuntimeWorker`
  now gates `artifact_redaction` and `artifact_retention` behind explicit
  injected lifecycle ports, worker identity, correlation id, and a
  non-`SUPERUSER` dedicated `BYPASSRLS` operational role. The local worker now
  persists a short artifact-row claim lease, calls injected fakeable
  `ArtifactRedactor` / `ArtifactRetentionStore` ports outside the DB
  transaction, and finalizes by tenant/claim/worker/correlation/unexpired-lease
  CAS; local non-bypass evidence proves application roles still refuse both
  jobs before object I/O, while temporary non-superuser BYPASSRLS evidence
  proves active-claim defer, redaction finalize, retention deleted/not-found
  success, transient no-tombstone behavior, skip predicates, and no audit
  `ObjectRef` leak.
  `ts/runtime-contract.ts`
  names the operational guardrail contract for those future jobs: dedicated
  `artifact_redaction_job` / `artifact_retention_sweeper` BYPASSRLS use cases,
  tenant-scoped SQL even under operational roles, fail-closed `bypassrls.use`
  audit before mutation, internal-only `ObjectRef`, public `ArtifactRef`
  evidence, no `ObjectRef` logs, persisted artifact-row claim lease anchors
  that application inserts cannot set, tenant-unique claim IDs,
  worker/correlation binding, active-claim defer/retry metadata, no object I/O
  inside claim/finalize DB transactions, SQL-level active claim no-steal,
  expired claim reclaim, claim-id-bound tenant finalize CAS with an unexpired
  lease, wrong/cross-tenant/expired finalize CAS miss, stale object-I/O result
  rejection, fail-closed unknown/leaking port results, non-quarantined
  claim/finalize filters, and idempotent delete/not-found retention semantics.
  The DB boundary now rejects non-legal-hold artifact metadata with unknown
  `retention_until` and application-supplied lifecycle claims. This
  Phase 7 local delta is not merged/current remote release evidence until a later
  PR/main `Contract Gates` run attaches the required job URLs, and it is still
  not executable staging/open evidence until production/staging
  SecretRef-backed artifact object I/O/deletion receipts and remote RBAC/tenant
  execution gate URLs are supplied outside this local repo environment.
- Current app-runtime scope gap: the real Fastify app gate covers the wired app
  routes (`GET/POST /v1/runs`, run abort, human-task assign/start/resolve and
  fail-closed escalate, DLQ replay, and scenario create/read/validate/promote).
  Broader api-surface routes such as workitem checkout/read APIs, artifact read,
  gateway policy update, network policy update, site approval, connector
  enable/install, and SecretStore resolution endpoints still rely on
  contract/fake control-plane fixtures until their real app routes are
  implemented or explicitly scoped out of a staging packet.
- Current D5 gateway scope gap: the repo-owned Codex SSE adapter safe path,
  live-probe harness, and local `PgGatewayArtifactSink` pending-metadata path
  exist, but the intended staging model/endpoint has not been probed by a
  credential holder. The harness must record mandatory PASS for basic SSE,
  prompt-schema safe path, and abort behavior before it can be cited as external
  live-model evidence, and its evidence table uses endpoint/model aliases,
  rejects endpoint URLs carrying credentials/query/fragment material, and
  redacts provider error bodies plus secret-like fields before printing;
  optional native `json_schema` and model metadata GAP results are allowed only
  with documented fallback. The local artifact sink
  evidence is producer-side metadata/object-store evidence only, keeps
  `ArtifactRef` aligned to `artifacts.id` while raw object locators remain
  `ObjectRef`, and does not close artifact redaction/retention worker object-I/O
  blockers.
- Deploy-time gap: staging approval, secret provisioning, deployment,
  rollback, and any production/staging operation remain the project owner's
  deploy-time work outside this contract-first repository. Those steps must use
  the resolved staging decision and must not materialize plaintext secrets in
  this repo.

### Readiness Blocker Ownership Matrix

| Blocker family | Closeable by repo code stream | Requires owner deploy-time provisioning |
|---|---|---|
| D4.5 API behavior | Yes: `suspending` abort bookmark-cancel ownership and human-task `reassignAssignee` ownership can close with contract/API/runtime code plus targeted tests and PR/main gates. | No external deploy evidence is needed for the repo behavior, but staging/open still remains blocked by the deploy-time rows below. |
| D3 executor/runtime orchestration | Yes: real executor invocation, `step.started` enforcement, explicit system/security/challenge/unknown outcome mapping, and executor audit semantics can close with repo code plus non-bypass DB and app-runtime evidence. | Live staging execution evidence is still separate; do not infer it from Stagehand/CDP dry-run or temp-DB tests. |
| Artifact redaction/retention lifecycle | Partly: repo can close the real port/worker implementation, claim/finalize CAS, fail-closed audit, and targeted tests. | Yes: staging SecretRef-backed operational credential path, object-store redaction/deletion evidence, deployment target, approval, rollback, and retention evidence must come from the project owner at deploy time. |
| Staging platform, SecretStore, deploy, rollback, producer retention, D5 live model | No: this contract repo can define the shape and negative controls only. | Yes: at deploy time the project owner must provide the platform repo, GitHub Environment protection, deploy target, owner release-approval, owner rollback confirmation, SecretStore alias/path, namespace/identity map, SecretRef inventory, rotation/break-glass owner, non-app producer retention policy, and redacted live D5 capability output. |

No deploy-time blocker may be closed from local aliases, fixture names,
hard-coded SecretRef identifiers, CI service-container credentials, or unredacted
live logs. Evidence intake must follow the Staging Secret Provisioning
Evidence Packet below and preserve RBAC/redaction/RLS boundaries.

- TODO: [BLOCKED] Deploy-time concrete staging deploy target is not defined for executable Product Open deployment outside this contract repository.
  Required decision: At deploy time, the project owner must name the exact staging platform repo, GitHub Environment `staging` protection/approver configuration, concrete deploy target identifier (namespace/service or equivalent), release approval evidence, rollback confirmation, and SecretRef/SecretStore provisioning path before staging/open deployment is authorized.
- Blocked summary: Deploy-time staging SecretRef/SecretStore provisioning readiness is not defined outside this repository; the specific actionable evidence blockers are tracked in the Staging Secret Provisioning Evidence Packet below.
- Resolved (owner-attested staging evidence): Deploy-time per-producer retention policy is defined and proven on staging. Policy (release-decisions D8-A11 / D8-A14): `raw_items.raw_payload` 30d and `normalized_records.record` 90d via the inline retention source supplied by the ingest/normalize callers; `artifacts` retention is enforced by the `legal_hold OR retention_until IS NOT NULL` CHECK; `audit_log.payload` 2555d (7y, v1 default, override-able); repo-owned `events_outbox.retention_until` is `NOT NULL`; the D4.3 app idempotency writer uses `expires_at` as the repo-controlled retention source. Staging evidence: against a real staging PostgreSQL (redacted alias `[staging-pg-1]`, server PostgreSQL 16.x) under a non-`SUPERUSER`/non-`BYPASSRLS` application role, `npm --prefix codegen run db:smoke:release` PASSED with `non-bypass RLS/redaction row-visibility assertions executed` (retention columns present on every payload table, `artifacts` CHECK + `events_outbox.retention_until` NOT NULL fail-closed enforcement, tenant RLS row-visibility), and the payload-bearing producer integration tests PASSED under the same non-bypass role proving each writer sets `retention_until` or fails closed — `security-audit.int` (`all rows persist retention_until`; invalid/malformed/calendar-invalid retention timestamp fails closed; duplicate idempotency key fails closed), `executor-invocation-recorder.int` (`step.completed retention set`; PlainSecret/cross-tenant fail-closed), `pipeline.int` (raw-ingest/normalize dedup + cross-tenant RLS row count 0), `outbox-relay.int` (`events_outbox` ordered idempotent relay), `api-artifacts.int` (artifact RLS redaction-gate). No host/IP/credential/env dump recorded (redacted endpoint alias only). Former Required decision: define per-producer retention duration/source and prove on staging that each payload-bearing writer sets `retention_until` or fails closed.
- Resolved (owner-attested live evidence): D5 Codex SSE live capability captured. Production `CodexSseAdapter`/`FetchCodexSseTransport` ran live (`npm --prefix app/poc/d5-codex-sse run poc`) against endpoint `[codex-staging-1]` / model `[model-a]` (redacted aliases; absolute HTTPS, no credential/query/fragment). **4/5 PASS** — mandatory #1 basic SSE / #2 prompt-schema safe path / #4 abort all PASS; #3 native `json_schema` PASS (jsonMode=true active); #5 model metadata GAP with documented fallback (conservative `maxContextTokens=8192` retained). No plaintext API key, raw endpoint/model identifier, env dump, or resolved SecretRef material recorded (harness self-redaction; `CODEX_API_KEY` kept in a gitignored local `.env`). Former Required decision: run the D5 PoC and record redacted mandatory-PASS evidence.
- Resolved repo evidence: cancelable `suspending` abort and H5/R15 `reassignAssignee` are explicit fail-closed v1 paths. Successful in-flight bookmark abort still requires a future bookmark-cancel owner or durable abort intent; successful manual escalate still requires a future routing/assignment owner. Until then the API rejects/rolls back before reporting success, preserving no silent false/unknown.
- Resolved repo evidence: runtime executor orchestration and audit semantics now have a local path through `PgExecutorStepOrchestrator`, `ExecutorStepAttemptStore`, `PgExecutorInvocationRecorder`, and `PgExecutorCompletionCoordinator`; executor plugins run outside DB transactions, step-bound producer writes require `step.started`, system/security/challenge/uncertain outcomes map through explicit catalog-backed paths, lifecycle jobs are enqueued for artifact-producing terminal outcomes, and executor evidence does not misuse security-boundary `audit_log`.
- Resolved (owner-ratified object-I/O evidence, D8-A15): Runtime artifact_redaction object I/O is evidenced on an owner-operated real S3-compatible object store (MinIO, real SigV4 over HTTPS) with a SecretRef-backed credential resolved via the real SecretStore (Vault AppRole → `VaultSecretStore.resolve`; `S3_SECRET_ACCESS_KEY` unset). `objectstore:smoke` PASS: the production `S3ArtifactRedactor` with the injected §4 `ContentRedactionTransform` reads the source object, masks it, and writes a redacted object to a new `ObjectRef`; a planted credential+email is confirmed ABSENT from the redacted object on re-GET, the `redact` real-port receipt carries `sha256`, and the self-check confirms no plaintext Secret/PII, accessKeyId, internal `ObjectRef`, or AWS-credential-shape in the printed output or raw rows. Redacted backend alias `[s3-staging-1]`; no host/credential recorded. Masking is honest best-effort §4 (not a completeness proof for arbitrary content). Scope-split (repo-controlled, NOT claimed from this smoke): the claim-lease/finalize CAS — `redaction_status` CAS from `pending`, quarantine/deleted claim skip, and `bypassrls.use` audit — live in `runtime-worker.ts` `claimRedactionArtifact` and are proven by `runtime-worker-claim.int.ts` under main `Contract Gates` `test:int` (runtime-execution-gates row); the `redaction_attempts < max` threshold predicate is present in code (claim + finalize retry→failed) but exercised at attempts=0 only by that test. Owner ratification of an owner-operated local real object store is recorded in release-decisions D8-A15 and the amended Deploy-Time Provisioning Blockers gate. Former Required decision: provide real object-store redaction object-I/O evidence with SecretRef-backed credentials and redacted receipts.
- Resolved (owner-ratified object-I/O evidence, D8-A15): Runtime artifact_retention external object deletion is evidenced on an owner-operated real S3-compatible object store (MinIO, real SigV4 over HTTPS) with a SecretRef-backed credential resolved via the real SecretStore (Vault AppRole → `VaultSecretStore.resolve`). `objectstore:smoke` PASS: the production `S3ArtifactRetentionStore.deleteObject` returns `deleted` on first delete of a real test object and `not_found` on re-delete (idempotent), each with a redacted real-port `delete` receipt; transient (5xx/network) maps to `transient_failed` with no tombstone. The `not_found` path required a real-S3 fix — `S3ObjectStore.deleteDistinguishing` now HEAD-checks existence before DELETE, because real S3/MinIO DELETE returns 204 even for a missing key (merged PR #103, with a method-aware unit test). Redacted backend alias `[s3-staging-1]`; no host/credential recorded. Scope-split (repo-controlled, NOT claimed from this smoke): legal-hold/quarantine SKIP and `deleted_at`-set-under-unexpired-claim CAS live in `runtime-worker.ts` retention claim (`legal_hold = false AND quarantine = false AND deleted_at IS NULL`) and are proven by `runtime-worker-claim.int.ts` under main `Contract Gates` `test:int` (runtime-execution-gates row). Owner ratification recorded in release-decisions D8-A15 and the amended Deploy-Time Provisioning Blockers gate. Former Required decision: provide real external object deletion evidence with SecretRef-backed credentials, delete/not-found receipts, and legal-hold/quarantine handling.
- Resolved (remote evidence): Runtime execution staging gates now have current remote `main` CI evidence. GitHub Actions hosted-runner execution is restored (the account payment/spending-limit blocker no longer applies — `main` `Contract Gates` runs start and succeed). The Phase 7 runtime delta is merged on `main` (`executor-step-orchestrator.ts` / `executor-completion-coordinator.ts` / `executor-invocation-recorder.ts`), and `main` `Contract Gates` run `27849888784` (commit `939fa31f1cb4e413fc1080287165becc6fc4bf55`) is `success` with the required job URLs — `App runtime typecheck and tests` (https://github.com/xorrbss/RPA-Enterprise/actions/runs/27849888784/job/82426746745), `Secret scan` (https://github.com/xorrbss/RPA-Enterprise/actions/runs/27849888784/job/82426746756), `PostgreSQL 15 migration smoke` (https://github.com/xorrbss/RPA-Enterprise/actions/runs/27849888784/job/82426746841). The `App runtime typecheck and tests` job runs `test:int` under a non-`SUPERUSER`/non-`BYPASSRLS` PostgreSQL 15 role, proving tenant boundary / RBAC/redaction / no `BYPASSRLS` / no silent false-unknown. Former Required decision: restore GitHub Actions hosted-runner execution, rerun `Contract Gates` on the Phase 7 `main` head, and provide the required PR/main job URLs.

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
  boundary. Executor invocation recording does not use `audit_log` as a generic
  recorder; executor audit semantics remain blocked until the runtime contract
  defines that evidence path.

### Executor Invocation Recorder Evidence Packet

Resolved locally for started-attempt, executor plugin orchestration,
final-recording, terminal completion, explicit outcome mapping, and executor
evidence semantics:

- Boundary: `ExecutorInvocationRecorder` in `ts/runtime-contract.ts`; app-runtime
  implementation: `PgExecutorInvocationRecorder` in
  `app/src/runtime/executor-invocation-recorder.ts`.
- Covered behavior: records already-final `StepResult` values to `run_steps`,
  emits canonical `step.completed` outbox rows with `(run_id, step_id, attempt)`,
  persists pending artifact metadata with explicit retention, and keeps browser,
  LLM, and plugin side effects outside the DB transaction.
- Local started-attempt ownership: `ExecutorStepAttemptStore` and
  `RunStepPersistedStatus` in `ts/runtime-contract.ts` preserve final-only
  `StepResult.status` while allowing persisted `run_steps.status='started'` as
  a truthful nonterminal row. `PgExecutorStepAttemptStore` in
  `app/src/runtime/executor-step-attempt-store.ts` locks the running run, owns
  `MAX(attempt)+1` allocation, inserts the canonical step attempt, and emits
  `step.started` in the same transaction. Local evidence proves cross-tenant
  fail-closed start, retry attempt ownership, `stagehand_calls` FK insertion
  after start, recorder CAS finalization of the same row, and
  `PgGatewayArtifactSink` pending artifact metadata writes after the started row.
- Local terminal success/business-failure completion: `PgExecutorCompletionCoordinator` in
  `app/src/runtime/executor-completion-coordinator.ts` reuses the recorder inside
  the same tenant transaction, requires every terminal-success finalization
  evidence key to be present and exactly `true`, rejects unknown evidence keys, maps a
  successful terminal result through `running -> completing -> completed` and
  linked workitem `processing -> successful`, maps `failed_business` with
  `exception.class='business'` through `running -> failed_business` and linked
  workitem `processing -> failed_business`, emits canonical `run.completed` or
  `run.failed_business` plus `step.completed`, enqueues artifact
  redaction/retention runtime job intents when artifacts exist, and rolls back
  the step/run/workitem transition when artifact-producing completion lacks a
  lifecycle enqueue port.
- Executor orchestration and non-success outcomes: `PgExecutorStepOrchestrator`
  begins a local attempt in a DB transaction, invokes the configured
  `ExecutorPlugin` outside that transaction, resolves artifact metadata, and
  records or completes the result through the recorder/coordinator. System,
  security, challenge, and uncertain outcomes now map through explicit
  catalog-backed run/workitem paths; unsupported outcomes fail closed instead
  of defaulting to success or business failure.
- Fail-closed behavior: duplicate final attempts, cross-tenant references,
  cross-tenant starts, missing stagehand calls, artifact metadata mismatches,
  missing `step.*` outbox refs, invalid timings, missing/false/unknown terminal
  finalization evidence, missing lifecycle enqueue port for artifact-producing
  terminal completion, missing/wrong business exception
  classification, and PlainSecret values in JSON payloads plus page-state,
  artifact, and object refs roll back the transaction instead of silently
  succeeding.
- DB boundary: non-legal-hold artifact metadata must set `retention_until`;
  artifact reads require tenant match, `deleted_at IS NULL`,
  `quarantine = false`, and `redaction_status IN ('redacted','not_required')`.
  Application-role artifact `UPDATE`/`DELETE` policies are intentionally absent;
  redaction/retention mutation requires audited operational BYPASSRLS.
  `db/migration_smoke.sql`, `scripts/db-static-smoke.mjs`, and
  `codegen/control-plane.fixtures.ts` prove omitted retention, quarantined
  artifact reads, and accidental app-role artifact mutation policy exposure
  fail closed before any lifecycle job can inherit an unknown or unsafe artifact
  state.
- Artifact lifecycle guardrail boundary: `ARTIFACT_LIFECYCLE_OPERATIONAL_CONTRACT`
  in `ts/runtime-contract.ts`; runtime fixtures prove dedicated operational
  BYPASSRLS use cases, tenant-scoped SQL, fail-closed audit-before-mutation,
  internal `ObjectRef`, public `ArtifactRef`, claim filters, and idempotent
  retention delete semantics. This does not provide production/staging lifecycle
  object I/O evidence or operational credential approval.
- Scope note: this is repo-controlled runtime evidence, not external staging
  execution evidence. Positive challenge suspension and security notification
  integrations remain fail-closed unless their explicit ports are provided, and
  production/staging artifact object I/O/deletion evidence remains blocked on
  external SecretRef-backed object-store receipts.
- Test evidence: `app/test/executor-invocation-recorder.int.ts`,
  `app/test/gateway-artifact-sink.int.ts`, `db/migration_smoke.sql`, and
  `scripts/db-static-smoke.mjs`.

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

At deploy time, the project owner provides this packet with redacted aliases
and `SecretRef` identifiers only. Do not record secret values, resolved SecretRef material, env
dumps, or deployment credentials in this repository.

| Evidence field | Required redacted content | Status |
|---|---|---|
| SecretStore backend alias/path | Vault mount/path or cloud KMS/secret-manager alias only; no plaintext values | BLOCKED external evidence |
| SecretRef namespace and runtime identity map | Namespace convention plus runtime identities allowed to resolve each namespace | BLOCKED external evidence |
| Initial SecretRef inventory | SecretRef identifiers, owning service/runtime, and intended purpose only | BLOCKED external evidence |
| Rotation and break-glass ownership | Rotation owner/cadence plus break-glass/update owner and procedure | BLOCKED external evidence |
| CI/deploy and SecretStore resolution proof | Artifact URL proving authorized/unauthorized SecretStore resolution smoke, `secret.resolve` audit proof without material, no plaintext materialization, no env dump/xtrace, the secret-scan or equivalent negative control, and no RBAC/redaction weakening | Resolved — owner-operated real Vault `secretstore:smoke` PASS ([A] ALLOW + [B] DENY, `secret.resolve` audit seq/hash, redaction self-check), per D8-A15; bucket/secret values remain deploy-time |
| Release approval and rollback confirmation | Owner release-approval and rollback confirmation at deploy time | Tracked by the deploy target blocker above |

Evidence intake rules for this packet:

- Allowed fields: redacted endpoint/model aliases, `SecretRef` identifiers,
  SecretStore backend alias/path, namespace convention, runtime identity names,
  owning service/runtime, purpose, rotation cadence/owner, break-glass owner,
  `secret.resolve` audit row IDs/hashes/counts, allow/deny outcomes,
  CI/deploy artifact URLs, and release/rollback approval references.
- Forbidden fields: plaintext secret values, bearer/API keys, resolved
  `SecretRef` material, raw staging endpoint URLs, raw model identifiers when
  they are considered sensitive by the staging owner, value-derived hashes or
  fingerprints, sensitive raw backend paths, env dumps, shell xtrace output,
  `secrets.*` GitHub context output, provider error bodies containing
  credentials, or screenshots/logs that bypass RBAC/redaction.
- Required negative proof: the attached CI/deploy evidence must identify the
  secret-scan or equivalent control that rejects high-risk secret markers,
  GitHub `secrets` context echoing, `environment: staging` binding in this
  contract-only workflow, env dump commands, and xtrace before the staging
  packet can be treated as ready. The same packet must include SecretStore
  allow/deny smoke and `secret.resolve` audit metadata without resolved
  material before it can be treated as staging-ready.

- Resolved (owner-attested): SecretStore backend alias/path named — HashiCorp Vault, KV v2, mount `secret/`, base path `secret/data/rpa/staging/<runtime>/<purpose>/<name>` (no plaintext); identity map per D8-A12. Auth method (AppRole) is evidenced at the row-48 resolution smoke. Former Required decision: name the Vault mount/path or cloud KMS/secret-manager alias used by staging without exposing plaintext secret values.
- Resolved (D8-A12): SecretRef namespace convention and runtime identity map are named — `rpa/<env>/<runtime>/<purpose>/<name>` with the owner-confirmed least-privilege resolve matrix (incl. `artifact-lifecycle`→`object_store`, D8-A10) in staging-decision-proposals.md §3. The real SecretStore backend mount/path remains row 44 (external). Former Required decision: name the namespace convention and the runtime identities allowed to resolve each namespace before staging deploy.
- Resolved (D8-A12): Initial SecretRef inventory is listed by identifier only (owning runtime + purpose, no resolved material) in staging-decision-proposals.md §4. Former Required decision: list initial SecretRef identifiers, owning service/runtime, and intended purpose only; resolved secret material must remain outside this repository.
- Resolved (D8-A13): Rotation/break-glass policy and rotation owner are named — cadence defaults (`gateway_policy` 90d, `resume_token_hmac` kid 180d, `executor` 90d, `signed_command` 365d), break-glass procedure, and rotation owner = single project owner (release-decisions #13) in staging-decision-proposals.md §5. Former Required decision: name the rotation owner/cadence and break-glass/update procedure before staging deploy.
- Resolved (owner-ratified Vault resolution evidence, D8-A15): SecretStore resolution + `secret.resolve` audit are evidenced on an owner-operated real HashiCorp Vault (AppRole auth, KV v2) with the durable `PgDurableSecurityAuditDecisionWriter` writing the hash-chained audit to a real PostgreSQL `audit_log` under a non-`SUPERUSER`/non-`BYPASSRLS` role. `secretstore:smoke` PASS: [A] authorized `runtime-worker` → `resume_token_hmac` (ref `rpa/staging/runtime-worker/resume_token_hmac/active`) → **ALLOW** (resolved via AppRole; PlainSecret non-empty, value never materialized/printed), `secret.resolve` audit seq#1 + hash; [B] unauthorized `browser-worker` → `gateway_policy` → **DENY** (`SECRET_ACCESS_DENIED`, least-privilege D8-A12 matrix, denied in-app before any Vault read), audit seq#2 + hash. redaction self-check PASS: no AppRole role_id/secret_id, Vault token, or resolved secret value in the printed output or raw report (no env dump/xtrace). The repo `Secret scan` CI gate is the standing negative control (AppRole creds are env-only, never committed). Owner ratification recorded in release-decisions D8-A15 and the amended Deploy-Time Provisioning Blockers gate. Former Required decision: provide authorized/unauthorized SecretStore resolution smoke + `secret.resolve` audit proof without material + log redaction + no-env-dump + secret-scan negative control.

### Artifact Object-Store Evidence Packet (B3 / checklist rows 48-49)

At deploy time, the project owner provides redacted object-I/O receipts only. The evidence
shape is fixed by `ts/runtime-contract.ts` (`ArtifactObjectIoEvidence`,
`artifact/object-io-evidence@1`); `test_fake` bindings carry
`mayBeUsedAsStagingEvidence:false` and cannot close these rows. Do not record
`ObjectRef`, plaintext credentials, or resolved SecretRef material.

| Evidence field | Required redacted content | Status |
|---|---|---|
| Object-store backend + credential | `real_object_store` `backendAlias` plus SecretRef `credentialRef` identifier only; no plaintext | BLOCKED external evidence |
| Redaction receipt | `artifact/object-io-evidence@1` with `operation:redact`, `redacted`/`not_required` outcome, `artifactRef`, `receiptId`, `sha256`, and no `ObjectRef` | BLOCKED external evidence |
| Retention delete receipt | `operation:delete`, `deleted`/`not_found` idempotent outcome, legal-hold/quarantine handling, and `transient_failed` leaving `deleted_at` unset | BLOCKED external evidence |
| Operational audit + redaction proof | `bypassrls.use` audit for `artifact_redaction_job`/`artifact_retention_sweeper` with no plaintext Secret/PII or `ObjectRef` emitted | BLOCKED external evidence |
| Object-store credential SecretRef purpose | Resolved (release-decisions D8-A10): dedicated `object_store` value added to `SecretAccessRequest.purpose` (least-privilege; not reused from `executor`). The concrete backend alias/credential value stays a deploy-time `[EXTERNAL-FACT]` (Object-store backend + credential row above). | Resolved (repo decision) |

These rows are tracked by the existing artifact_redaction and artifact_retention
object-I/O blocked markers above; this packet fixes only the redacted evidence
shape and neither adds a new blocker nor closes an existing one.

### D5 Codex SSE Live Capability Evidence Packet (B4 / checklist row 47)

At deploy time, the project owner runs `npm --prefix app/poc/d5-codex-sse run poc`
outside this repo and records only redacted aliases. Raw endpoint/model
identifiers, plaintext keys, env dumps, and resolved SecretRef material are
forbidden.

| Evidence field | Required redacted content | Status |
|---|---|---|
| Endpoint/model aliases | `CODEX_EVIDENCE_ENDPOINT_ALIAS` / `CODEX_EVIDENCE_MODEL_ALIAS` only; absolute HTTPS `CODEX_BASE_URL` with no credential/query/fragment material | Provided: `[codex-staging-1]` / `[model-a]` (absolute HTTPS, no creds/query/fragment) |
| Mandatory PASS | #1 basic SSE, #2 prompt-schema safe path, and #4 abort behavior all PASS | Provided: #1 / #2 / #4 all PASS |
| Optional GAP | #3 native `json_schema` / #5 model metadata may GAP only with documented fallback | #3 native `json_schema` PASS (jsonMode=true); #5 model metadata GAP — fallback `maxContextTokens=8192` retained |
| Redaction proof | Harness `run test:redaction` self-test plus redacted provider error bodies before evidence copy | Provided: output redacted to aliases only; no plaintext key/identifier |

This packet records the live D5 evidence that closed the D5 blocker above (4/5 PASS;
mandatory #1/#2/#4 PASS). The `CODEX_API_KEY` stays in a gitignored local `.env`; no plaintext recorded.

## Remaining External Evidence Notes

All repo-controlled D4.5 API P1 and D3 runtime execution rows are locally
resolved in this patch. The one remaining unchecked row requires owner deploy-time
provisioning: the concrete staging platform/deploy target + GitHub Environment
(row 43).

Do not close those rows from local fixtures, temp DBs, fake object-store ports,
hard-coded aliases, CI service-container credentials, or unredacted logs. When
the owner provisions evidence at deploy time, update the matching checklist row, replace the
matching blocked marker in this report with a redacted evidence reference, and
refresh the `blocked:audit` count in both documents.

## Next 24h Actions

1. Attach the tag, latest `contract-gates` run URL, DB migration smoke job, and
   UI smoke screenshot/note to the external release review packet.
2. As the single project owner, take Product Open through deploy-time approval
   and rollback ownership (no external release/oncall team exists).
3. Obtain the concrete staging deploy target, SecretStore provisioning
   evidence, owner release-approval, and rollback confirmation before any
   staging/open deployment.
4. At deploy time, run the D5 Codex SSE PoC with SecretRef-resolved
   credentials outside the repo and attach redacted mandatory PASS evidence.
5. Define the next repo-owned runtime slice: real executor orchestration,
   artifact redaction/retention jobs, executor audit semantics, and real app
   artifact-read routing backed by the redaction/RBAC
   `ArtifactRef`/`ObjectRef` boundary.
6. Keep the durable security audit writer wired as broader security-relevant app
   routes are implemented.
7. Keep any new unresolved behavior out of implementation paths unless it uses
   the repository blocked-decision marker with nearby required-decision text.
