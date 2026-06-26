# Current Readiness Report

Date: 2026-06-26
Branch: `codex/ops-governance-continuation`
Baseline: `origin/main` at `68b26ef1` (`Merge pull request #376 from xorrbss/feat/dg4-credential-meta`)

## Mainline Already Contains

- ALM/RBAC v1 surfaces for scenario release governance and role assignment administration.
- Credential reference registration/deletion with SecretRef boundary checks and credential concurrency policies.
- Worker/Bot pool read and basic assignment surfaces.
- DLQ replay-all, trigger pause/resume, gateway cost/trends, basic CoE/ROI surfaces.
- Audit CSV export and a first-pass command palette/global search entry point.

## This Branch Closes Next

- Credential lifecycle metadata:
  - `status`: `active`, `deprecated`, `revoked`
  - `owner_sub`, `scope`, `rotation_policy`
  - `rotated_at`, `last_used_at`, `deprecated_at`, `revoked_at`
  - `replaced_by_credential_ref`
- Credential lifecycle events in `credential_binding_events`.
- Credential rotation as create-new-ref plus deprecate-old-ref, instead of mutating a live SecretRef primary key.
- Credential decommission as audited soft revocation, with hard delete kept as a compatibility API.
- Console lifecycle visibility and admin-only rotate/decommission controls.
- Worker Pool operational controls:
  - pool `status`: `active`, `draining`, `disabled`
  - pool-level `max_concurrency` and `priority`
  - audited create/update/assign/unassign/delete commands via `worker_pool.manage`
  - Graphile job priority mapping for assigned pools
  - run claim/resume enqueue rejection for `draining`/`disabled` assigned pools
  - worker forbidden flags for inactive pools so queued jobs are not picked while drained/disabled
  - console controls for status, priority, concurrency, tenant assignment, and deletion.
- Failed-run rerun:
  - `POST /v1/runs/:run_id/rerun` for `same_input` and `edited_input`
  - failed-only guard for `failed_business` and `failed_system`
  - child run creation through the existing `createRunInTx` path
  - `run_reruns` lineage table with source run, child run, mode, params snapshot, requester, and reason
  - governance audit row via `run.rerun`
  - RunTrace console actions for same-input and edited-input rerun.
- Queued run priority control:
  - `runs.priority` with `low`, `medium`, `high`, `critical`
  - `POST /v1/runs/:run_id/priority` queued-only guard
  - governance audit row via `run.prioritize`
  - Graphile run_claim priority mapping and stale duplicate claim no-op handling
  - RunTrace console priority selector for queued runs.
- Operator run resume:
  - `POST /v1/runs/:run_id/resume` for `suspended` and `resume_requested` runs
  - unresolved HITL task guard so resume cannot bypass human review
  - `run_resume` re-enqueue path for lost-job repair
  - governance audit row via `run.resume`
  - RunTrace console resume/retry-resume action.
- Monthly automation performance reporting:
  - `GET /v1/reports/automation-performance` for Asia/Seoul month-scoped performance summaries
  - summary metrics for success rate, rerun/reprocessing rate, estimated hours/value, and gateway cost
  - failure Top N and scenario/workflow-level ROI/cost breakdown
  - `GET /v1/reports/automation-performance/export?format=csv|xlsx|poc_markdown` with spreadsheet formula-injection guards plus Markdown link/HTML escaping
  - Dashboard panel with month picker, ROI/failure/workflow summary, CSV/XLSX export, and PoC Markdown report download.
- SCIM/IdP contract reservation:
  - `principals` external identity fields: `external_id`, `idp_provider`, `lifecycle_source`
  - `principal_role_assignments` external identity fields plus `source=scim`
  - effective role resolver includes active SCIM-managed assignments
  - manual console/API revoke rejects externally managed assignments with `externally_managed_role_assignment`
  - console badges distinguish SCIM synchronized principals and assignments.
- Productivity UX, first pass:
  - Command Palette searches recent/loaded scenarios, runs, human tasks, principals, and credential policies
  - deep links to RunTrace, HumanTasks, Playground, and Security focus targets
  - principal and credential focus highlighting on the Security view
  - query gating so global search only fetches entity lists while open and with a useful query.
  - Command Palette quick actions route common operator flows to failed/queued runs, HITL inbox, Credential management, Worker Pool management, and Automation report surfaces.
- Bot Pool health automation, first pass:
  - `/v1/bot-pools` synthetic `browser-default` read model now exposes no-schema queue health: `queued_runs`, `claimed_runs`, `oldest_queued_at`, capacity gap, queue pressure, occupied/available slots, and explicit live-capacity unavailability.
  - Orchestration console capacity panel surfaces worker health, lease occupancy, queue pressure, oldest queued run, and capacity gap without changing worker/bot pool schemas.

## Remaining Work

- Bot Pool health automation:
  - worker-level lease expiry isolation via existing `workers.circuit_state`
  - true per-pool live capacity remains blocked because there is no worker-to-pool membership contract; the current browser-default numbers are synthetic/global over existing `workers`, tenant-scoped `browser_leases`, and tenant-scoped `runs`/`run_triggers` only (`TODO: [BLOCKED]`)
  - Required decision: define worker-to-pool membership, per-pool capacity source of truth, tenant/pool scoping, and health-isolation evidence before claiming true per-pool live capacity.
- In-flight pause operations:
  - runtime-owned operator pause intent/bookmark port remains `TODO: [BLOCKED]`
  - Required decision: define the runtime-owned operator pause intent/bookmark-cancel port, ownership boundary, state transition evidence, and targeted tests before exposing active run pause.
  - active `running -> suspending` operator pause is not exposed until that owner exists
- Reporting/ROI package:
  - deeper cost trend charts beyond current monthly `usage_cost` total
- Productivity UX:
  - full-tenant search beyond recent/loaded lists requires contract-first search API or per-entity `search` filters
- SCIM/IdP sync engine:
  - inbound SCIM schema and provider registration
  - conflict rules for sub/external identity changes
  - lifecycle automation for disable/delete/deprovision events.

## Verification Plan

- `node scripts/run-local-gates.mjs --skip-db`
- `npm --prefix app run typecheck`
- `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-credentials.int.ts`
- `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-worker-pools.int.ts`
- `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-run-rerun.int.ts`
- `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-run-priority.int.ts`
- `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-run-resume.int.ts`
- `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-automation-performance-report.int.ts`
- `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-bot-pools.int.ts`
- `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-principals.int.ts`
- `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-role-assignments.int.ts`
- `npm --prefix app exec tsx -- app/test/run-queue.unit.ts`
- `npm --prefix app exec tsx -- app/test/rbac.unit.ts`
- `npm --prefix web run typecheck`
- `npm --prefix web test -- concurrency-policy worker-pool`
- `npm --prefix web test -- run-rerun`
- `npm --prefix web test -- run-priority`
- `npm --prefix web test -- run-resume client`
- `npm --prefix web test -- dashboard client`
- `npm --prefix web test -- command-palette dashboard client run-resume`
- `npm --prefix web test -- automation-ops`
- `npm --prefix web test -- principals-admin principals-picker client`
- `npm --prefix web test -- browser-recorder document-idp goal-ux prompt-generator-correction session-registration-cta gateway step-trace`
- `npm --prefix web run build`

## Verification Results

- Passed: `node scripts/db-static-smoke.mjs`
- Passed: `npm --prefix app run typecheck`
- Passed: `npm --prefix web run typecheck`
- Passed: `npm --prefix codegen run typecheck`
- Passed: `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-credentials.int.ts`
- Passed: `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-worker-pools.int.ts`
- Passed: `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-bot-pools.int.ts`
- Passed: `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-run-rerun.int.ts`
- Passed: `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-run-priority.int.ts`
- Passed: `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-run-resume.int.ts`
- Passed: `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-automation-performance-report.int.ts`
- Passed: `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-principals.int.ts`
- Passed: `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-role-assignments.int.ts`
- Passed: `npm --prefix app exec tsx -- app/test/pool-forbidden-flags.unit.ts`
- Passed: `npm --prefix app exec tsx -- app/test/run-queue.unit.ts`
- Passed: `npm --prefix app exec tsx -- app/test/rbac.unit.ts`
- Passed: `npm --prefix web test -- concurrency-policy`
- Passed: `npm --prefix web test -- concurrency-policy worker-pool`
- Passed: `npm --prefix web test -- automation-ops`
- Passed: `npm --prefix web test -- run-rerun`
- Passed: `npm --prefix web test -- run-priority`
- Passed: `npm --prefix web test -- run-resume client`
- Passed: `npm --prefix web test -- dashboard client`
- Passed: `npm --prefix web test -- command-palette dashboard client run-resume`
- Passed: `npm --prefix web test -- principals-admin principals-picker client`
- Passed: `npm --prefix web test -- browser-recorder document-idp goal-ux prompt-generator-correction session-registration-cta gateway step-trace`
- Passed: `npm --prefix web run build` (Vite reported the existing large chunk warning)
- Passed: `npm --prefix app run test:console-e2e`
- Passed: `git diff --check`
- Passed: `node scripts/run-local-gates.mjs --skip-db`

The first full-gate rerun exposed a stale console-browser E2E fixture for `GET /v1/reports/automation-performance`; the fixture now mirrors the dashboard report contract and `npm --prefix app run test:console-e2e` passes. The subsequent `run-local-gates` run passed end-to-end.

`run-local-gates` was intentionally run with `--skip-db`; the app Credential, Worker Pool, Run Rerun, Run Priority, Run Resume, Automation Performance Report, Bot Pool, Principal Directory, and Role Assignment integration tests above used temporary PostgreSQL 15 and cover the new DB/API paths directly.

## Notes

- `rpa_enterprise_console.html` remains a legacy standalone review mockup and is not the production console implementation.
- Secret values must remain outside UI/API payloads. This branch only handles SecretRef paths and lifecycle metadata.
- No silent false/unknown behavior is introduced: invalid SecretRef paths, value-bearing fields, missing idempotency keys, and active-lease lifecycle conflicts fail loudly.
