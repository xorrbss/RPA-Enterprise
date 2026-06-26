# Current Readiness Report

Date: 2026-06-26
Branch: `codex/remaining-enterprise-ops`
Baseline: `origin/main` at `a16df579` (`Phase 6: 운영 거버넌스 후속 보강`)

## Mainline Already Contains

- Enterprise ALM/RBAC v1 surfaces for scenario release governance and role assignment administration.
- Credential reference registration, rotation/decommission metadata, SecretRef boundary checks, and credential concurrency policies.
- Worker Pool registry, tenant assignment, pool status/priority/concurrency controls, and synthetic Bot Pool health read model.
- DLQ replay-all, trigger pause/resume, failed-run rerun, queued-run priority, operator resume, gateway cost/trends, CoE/ROI, audit CSV export, and command palette.

## This Branch Closes

- Active operator pause:
  - `POST /v1/runs/:run_id/pause` with `Idempotency-Key`, `run.pause` RBAC, and governance audit.
  - `run_pause_requests` durable intent table with RLS and replay-safe open-request handling.
  - Runtime `pauseRequested` port that suspends a running run at the next safe node boundary with `operator_pause` bookmark evidence.
  - Workitem checkout timer pause and resume-token issuance are reused through the existing suspend path.
  - RunTrace exposes a running-run pause action without exposing secret or page-state body data.
- Worker Pool worker membership:
  - `worker_pool_memberships` table plus smoke/RLS coverage.
  - `PUT /v1/worker-pools/:pool_key/workers/:worker_id` and `DELETE /v1/worker-pools/:pool_key/workers/:worker_id`.
  - Worker Pool list now includes member totals, active/stale counts, and worker IDs for admin operations.
  - Bot Pool live capacity is now keyed by tenant-assigned pool and excludes workers outside that pool; unassigned default capacity remains explicit.
- Full-tenant global search:
  - `GET /v1/search?q=&limit=` searches runs, scenarios, human tasks, principals, and credential refs under tenant RLS.
  - Command Palette uses the search API before local quick actions and deep links to RunTrace, HumanTasks, Playground, and Security focus targets.
- SCIM principal sync:
  - `POST /v1/scim/principals` with `scim.sync` RBAC and audit.
  - Upserts SCIM-managed principals and synchronizes active SCIM role assignments.
  - Deactivation revokes active SCIM assignments for the provider-managed principal.
  - Manual revoke still rejects externally managed SCIM assignments.
- Reporting/ROI package:
  - Automation performance report now includes daily `trends`.
  - CSV, XLSX, and PoC Markdown exports include daily trend sections in addition to summary, failure Top N, and workflow ROI/cost.
  - Dashboard shows a recent daily trend table alongside monthly ROI/failure/workflow summaries.

## Remaining Work

- Active pause follow-up tests:
  - Add a DB-backed integration test for `/v1/runs/:run_id/pause` and runtime operator-pause drive once a stable fixture is chosen.
- SCIM hardening:
  - Provider registration, inbound schema versioning, signature/auth boundary, and conflict policy for sub/external identity changes.
- Bot Pool health automation:
  - Worker-level lease expiry isolation can be expanded through existing `workers.circuit_state`, but alert delivery/ack workflows remain future notification contracts.
- Reporting/ROI package:
  - Deeper cost trend charts beyond `runs.usage_cost` and scenario-level ROI estimates remain future analytics work.

## Verification Results

- Passed: `npm --prefix codegen run typecheck`
- Passed: `npm --prefix app run typecheck`
- Passed: `npm --prefix web run typecheck`
- Passed: `npm --prefix codegen run fixtures`
- Passed: `npm --prefix app run test:unit`
- Passed: `npm --prefix web test` (62 files, 653 tests; existing jsdom/React act warnings remain non-fatal)
- Passed: `npm --prefix web run build`
- Passed: `npm --prefix app run test:console-e2e`
- Passed: `node scripts/run-local-gates.mjs --skip-db` (PostgreSQL 15 DB-dependent gates intentionally skipped; DB static smoke ran)

## Notes

- `rpa_enterprise_console.html` remains a legacy standalone review mockup and is not the production console implementation.
- Secret values remain outside UI/API payloads. This branch only exposes SecretRef paths, state, and audit-safe metadata.
- No silent false/unknown behavior is introduced: invalid pause states, malformed SCIM payloads, missing idempotency keys, invalid worker IDs, and unsupported search query shapes fail loudly or return explicit empty results by contract.
