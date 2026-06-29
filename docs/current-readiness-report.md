# Current Readiness Report

Date: 2026-06-29
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
  - Phase 8 DB integration coverage now exists in `app/test/api-run-pause.int.ts` and `app/test/runtime-worker-operator-pause.int.ts`, both wired into `npm --prefix app run test:int`.
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
  - Phase 8 hardening closes the registered-provider, inbound `scim-principal@1` schema, signed-request, group-to-role mapping, and external identity conflict policy gaps.
  - `app/test/api-scim.int.ts` covers active/disabled provider gates, signature verification through `SecretStoreBoundary`, SecretRef rotation evidence, rotation policy due/overdue status, provider decommission with mapping disable and SCIM assignment revocation, group mapping bulk import/reconciliation, schema rejection, `roles` versus `external_groups`, unmapped/disabled groups, SCIM role revocation, and external-id/sub relink conflicts.
  - SCIM/IdP administration surface now includes admin-only provider registration/status updates, SecretRef rotation evidence, rotation policy monitoring with console-only ops alerts, provider decommission evidence, provider group-to-role mapping management, bulk mapping import/reconciliation, and metadata-only managed IdP SCIM catalog templates. The API stores only `signature_secret_ref`, never signing secret material, and the Security console exposes the same SecretRef-only management path.
- Reporting/ROI package:
  - Automation performance report now includes daily `trends`.
  - ROI estimate now separates gross monthly savings from net `monthly_value` by accepting optional `platform_monthly_cost` and `avoided_license_cost`; `monthly_value <= 0` returns `payback_months = null` and `viability = not_viable`.
  - ROI actual evidence is now separate from ROI estimates through `GET/POST /v1/automation-ideas/{idea_id}/roi-actuals`; it records pilot actual transaction count, failure rate, human intervention minutes, and reprocessing minutes with metadata-only evidence references.
  - Automation performance report now rolls month-contained ROI actual evidence into summary/workflow `roi_actuals` aggregates, separating total actuals from comparable actuals so actual-only pilots remain visible without distorting estimate attainment; reports do not expose evidence refs, summaries, metadata, URLs, or secrets.
  - Automation performance report now includes `model_cost_trends` for daily LLM/model cost attribution and per-model cost deltas.
  - Automation performance report now exposes structured `decision_signal` (`expand`/`hold`/`watch`) at summary and workflow level, and the Dashboard renders it as a monthly adoption decision aid.
  - Automation performance report now exposes `roi_source_lineage` at summary and workflow level, including source/stage counts, bounded department/owner lists, and audit-safe sample idea evidence.
  - CSV, XLSX, and PoC Markdown exports include daily trend, model-cost-trend, decision-signal, ROI source-lineage, and ROI actual comparison sections/columns in addition to summary, failure Top N, and workflow ROI/cost.
  - Dashboard shows recent daily run/cost trends, model-cost trends, compact model-cost sparkline, decision signal, ROI actual comparison, and ROI source/stage lineage mix charts alongside monthly ROI/failure/workflow summaries.
- Ops alert center:
  - Console-only alert acknowledgement is now exposed in the Orchestration console through `POST /v1/ops-alerts/{alert_id}/ack`; acknowledged alerts show the console ack state without implying external delivery success.
  - External notification evidence now has a metadata-only receipt ledger through `GET/POST /v1/ops-alerts/{alert_id}/deliveries`; it records provider receipts with SecretRef identifiers, admin-only `ops_alert.deliver`, and no raw endpoint/token material.
  - Notification routing readiness now has a webhook sender slice: `POST /v1/ops-alerts/{alert_id}/deliveries/send-webhook` creates `ops_notification_attempts` and enqueues `ops_notification_send`; the Orchestration console exposes an admin-only SecretRef/allowed-host/recipient-group-ref send form and receipt drilldown, while the worker resolves `notification` SecretRefs, checks `allowed_hosts`, preserves metadata-only `recipient_group_ref`, and records `sent`/`failed` receipts. Provider delivery callbacks now have a public JWT-skip contract at `POST /v1/webhooks/ops-alerts/{tenant_id}/{attempt_id}` using `X-RPA-Ops-Notification-*` signature headers, `callback_signature_secret_ref` from the originating attempt, and append-only `ops_notification_deliveries.status=delivered|failed` receipts. The connector catalog now exposes this as the implemented `ops-webhook-sender` generic notification connector with SecretRef-only endpoint metadata, while Slack/Teams/email/PagerDuty/ServiceNow-specific profiles stay `candidate` and require owner/provider evidence for auth, route ownership, recipient-group resolution, and provider-specific receipt semantics.
  - Inbound webhook trigger setup now distinguishes the saved receiving trigger and signing SecretRef from owner-side external system registration; the console does not claim that an external producer has been provisioned.
- P0 adoption blocker remediation:
  - Root `Dockerfile`, `compose.yaml`, and `deploy/docker.env.example` now define a local pilot packaging surface with explicit role split. API/browser worker use `rpa_app`; lifecycle/maintenance discovery uses dedicated `rpa_lifecycle_bypass`.
  - `scripts/db-migrate.mjs` is the repo-local migration runner with `schema_migrations`, deep baseline verification, optional Graphile worker schema migration, release smoke, and non-bypass role enforcement.
  - `npm --prefix codegen run db:restore-drill:temp` now provides repo-local pilot restore evidence: migrate as non-bypass `rpa_smoke`, seed representative tenant/infra rows, `pg_dump`/`pg_restore` into a fresh DB, then rerun baseline verification and non-bypass smoke.
  - `deploy/k8s/base` and `deploy/helm/rpa` now provide Kubernetes packaging evidence for API, worker, lifecycle-worker, migration Job, ServiceAccounts, PDB, probes, S3 artifact values, and SecretRef-only credentials. `npm --prefix codegen run k8s:static-smoke` locks the non-root, split-role, external-migration contract.
  - `maintenance-scheduler` now rejects unguarded cross-tenant app-role discovery for both due maintenance work and due cron run-trigger tenant discovery, requires a dedicated lifecycle BYPASSRLS pool when `MAINTENANCE_TENANT_IDS` is empty, and keeps the global orphan sweeper non-dormant.
  - Runtime run claim/resume now acquires scenario credential leases before browser drive/SecretStore resolution can occur, returns `SESSION_LOCKED` without binding an executor when all credential slots are busy, deletes newly reserved browser leases on credential conflicts, and releases credential leases on terminal drive, resume completion, and abort finalization.
  - Runtime browser sessions now require a CDP `Fetch`/`Network` egress guard at bind time. The guard appends durable `network.request` audit rows before allowing or blocking requests, blocks off-allowlist navigation, subresource/fetch/XHR-style requests, iframe/document loads, WebSocket handshakes, and downloads before the lease session is exposed to executor/resolver code, and fails closed if audit append fails.
  - Sink delivery egress has moved from DB/test-port-only evidence to a repo-local `real_sink` runtime capability. The contract requires an HTTPS endpoint SecretRef, approved `allowed_hosts`, downstream `Idempotency-Key` from `sink_idempotency_key`, no Authorization header/raw payload logging, and unchanged retry/dead-letter behavior. Customer/provider endpoint ownership, allowed-host approval, and SecretRef provisioning remain owner evidence; this does not claim production external sink delivery.
  - Audit hash-chain verification is now surfaced as tenant-scoped operational evidence: `audit_verifier_runs`, `GET /v1/audit-log/verification-runs`, admin-only `POST /v1/audit-log/verification-runs/verify`, hourly maintenance `audit_verifier` jobs, Audit Explorer summary/action UI, ops alerts for invalid/failed/stale verifier evidence, 90-day retention, metadata-only violations, and tamper evidence recorded as `status=invalid` rather than unknown healthy.
  - Scenario certification is now a first-class CoE gate: `scenario_versions.certification_status`, `POST /v1/scenarios/{scenario_id}/versions/{version}/certify`, `POST /revoke-certification`, `scenario.certify` RBAC, governance audit evidence, console certification badges/actions, and fail-closed prod release approve/deploy/rollback checks for missing or expired certification.
  - Controlled-prod readiness evidence is now a first-class operational gate: `GET /v1/ops/production-readiness` computes migration ledger, Graphile queue, browser pool HA, expired lease, stale run, and audit verifier freshness from current tenant evidence, while external alert delivery, owner-controlled managed backup/PITR restore drills, SLO/on-call sign-off, support/training completion, and observability telemetry wiring stay `deferred` or `blocked` until metadata-only owner evidence is recorded. Valid external alert delivery evidence now requires `evidence_ref` plus `metadata.channel`, `metadata.provider_alias`, `metadata.receipt_id`, `metadata.receipt_at`, and `metadata.delivery_status="delivered"`; valid SLO/on-call sign-off requires `evidence_ref` plus `metadata.slo_dashboard`, `metadata.severity_model`, `metadata.oncall_rota`, `metadata.raci_ref`, and `metadata.support_hours`; valid support/training evidence requires `evidence_ref` plus `metadata.support_model_ref`, `metadata.training_completion_ref`, `metadata.trained_role_count`, `metadata.trained_user_count`, `metadata.coverage_percent`, and `metadata.completed_at`; valid managed backup/PITR evidence requires `metadata.backup_policy_ref`, `metadata.restore_scope`, `metadata.restore_completed_at`, `metadata.rto_minutes <= 120`, and `metadata.rpo_minutes <= 15`; valid observability telemetry evidence requires `metadata.exporter=prometheus|otlp`, `metadata.collector_ref`, `metadata.dashboard_ref`, `metadata.alert_route_ref`, and `metadata.sampled_at`. Arbitrary owner notes alone cannot satisfy these gates. The Orchestration console renders blocker/deferred counts, owner evidence ledgers, and admin attach forms for all five owner gates. `readiness_evidence` ops alerts now surface latest owner evidence failure, expiry, and 14-day expiry risk without exposing artifact bodies or secrets. Prod scenario release approve/deploy now fail closed unless `summary.controlled_prod_ready=true`; rollback remains a recovery path and is not blocked by readiness.
  - Staging release packets must now include `controlled-prod readiness snapshot`, `external alert delivery evidence`, and `ops webhook sender evidence` fields. The packet must carry `GET /v1/ops/production-readiness` counts, `external_alert_delivery`, `support_training_completion`, and `observability_telemetry_wiring` states, `production_readiness_evidence` ledger references, the delivered-only external alert evidence contract, and SecretRef-only webhook sender attempt/delivery aliases without endpoint URLs, webhook URLs, tokens, raw rosters, or resolved secret material. This prevents promotion evidence from omitting readiness or notification-delivery state.
  - Controlled-production open now has a separate owner-facing packet validator: `npm --prefix codegen run prod-readiness-packet:fixtures` and `prod-readiness-packet:validate`. The packet requires `summary.controlled_prod_ready=true`, `external_alert_delivery=pass`, `managed_backup_restore_drill=pass`, `slo_oncall_signoff=pass`, `support_training_completion=pass`, `observability_telemetry_wiring=pass`, delivered external-alert metadata, PITR/restore RTO/RPO evidence, SLO/on-call metadata, support/training metadata, observability exporter/collector/dashboard/alert-route metadata, and negative proof that endpoint URLs, webhook URLs, dashboard URLs, raw rosters/user lists/training documents, tokens, fake/test evidence, and resolved SecretRef material are absent. This validator defines the production-open evidence shape only; it does not synthesize owner evidence.
  - Runtime worker and artifact lifecycle worker now start heartbeat only after dependencies/Graphile runner are ready and stop heartbeat/runner/pools on startup failure.
  - Worker/bot/ops health stale detection uses the `worker.stale_threshold = 2m` policy constant instead of scattered literals.
  - Observability backend export is now wired as repo-local implementation evidence: `OTEL_EXPORTER=prometheus` exposes metrics at health `/metrics`, while `OTEL_EXPORTER=otlp` pushes traces and metrics to explicit collector endpoints with fail-closed endpoint validation.
  - `docs/local-staging-release-pilot.md` now validates as a local-only row 43 rehearsal packet while preserving the rule that real staging closure still requires owner-controlled external deployment, SecretStore, object-store, approval, and rollback evidence.

## Remaining Work

- SCIM/IdP administration surface:
  - Provider registration/status, signature-secret rotation evidence, rotation policy monitoring, provider decommission evidence, group mapping administration, bulk group mapping import/reconciliation, and metadata-only managed IdP connector catalog templates are now implemented for the pilot control plane. Future managed-IdP work is limited to owner-led external IdP provisioning/connectors and automatic signing-key issuance, not Product Open v1 readiness blockers.
- Bot Pool health automation:
  - Worker-level lease expiry isolation is wired through `workers.circuit_state`; console alert ack, metadata-only provider receipt capture, webhook sender attempts with retry/dead-letter state, signed provider delivery callbacks, metadata-only `recipient_group_ref` routing evidence, and the generic `ops-webhook-sender` catalog entry are contract-ready. Slack/Teams/email/PagerDuty/ServiceNow-specific auth, provider-side recipient-group resolution, and provider-specific delivery receipt semantics remain owner/provider notification contracts.
- Deployment/migration:
  - Local Docker/Compose, Kubernetes/Helm packaging, repo-local migrations, temp-cluster logical restore drill, repo-local OTLP/Prometheus exporter wiring, and computed controlled-prod readiness gates are now pilot-ready evidence. Production HA/DR/failover, platform namespace/ingress approval, owner-controlled PITR/SLO/on-call/support-training evidence, approved collector/dashboard/alert wiring, and external deployment approval remain production-open work and are surfaced as deferred/blocking evidence rather than assumed green.
- Reporting/ROI package:
  - Compact source/stage/model-cost visual evidence is now implemented for the pilot dashboard. Future analytics work is limited to advanced drilldowns, cohort charts, and buyer-specific BI packaging, not Product Open v1 readiness blockers.

## Verification Results

- Passed: `npm --prefix codegen run typecheck`
- Passed: `npm --prefix app run typecheck`
- Passed: `npm --prefix app exec tsx -- app/test/observability-metrics-endpoint.unit.ts`
- Passed: `npm --prefix app exec tsx -- app/test/main-config.unit.ts`
- Passed: `npm --prefix app exec tsx -- app/test/browser-network-guard.unit.ts`
- Passed: `npm --prefix app exec tsx -- app/test/browser-session-provider.unit.ts`
- Passed: `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-audit-verification.int.ts`
- Passed: `npm --prefix app exec tsx -- app/test/rbac.unit.ts`
- Passed: `npm --prefix web run typecheck`
- Passed: `npm exec -- vitest run test/audit-explorer.test.tsx test/client.test.ts` from `web/`
- Passed: `npm --prefix codegen run fixtures`
- Passed: `npm --prefix app run test:unit`
- Passed: `npm --prefix web test` (63 files, 669 tests; existing jsdom/React act warnings remain non-fatal)
- Passed: `npm --prefix web run build`
- Passed: `npm --prefix app run test:console-e2e`
- Passed: `npm --prefix codegen run k8s:static-smoke`
- Passed: `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-scim.int.ts`
- Passed: `npm exec -- vitest run test/scim-provider-panel.test.tsx` from `web/`
- Passed: `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-automation-performance-report.int.ts`
- Passed: `npm exec -- vitest run test/dashboard.test.tsx test/client.test.ts test/automation-ops.test.tsx` from `web/`
- Passed: `npm exec -- vitest run test/automation-ops.test.tsx` from `web/`
- Passed: `node scripts/run-local-gates.mjs --skip-db` (PostgreSQL 15 DB-dependent gates intentionally skipped; DB and Kubernetes static smoke ran)
- Passed: `node scripts/db-temp-postgres-gate.mjs -- node scripts/db-migrate.mjs --smoke --require-non-bypass`
- Passed: `npm --prefix codegen run db:restore-drill:temp`
- Passed: `node scripts/run-local-staging-pilot.mjs`
- Passed: `npm --prefix codegen run release-packet:fixtures`
- Passed: `npm --prefix codegen run prod-readiness-packet:fixtures`
- Passed: `npm --prefix codegen run release-packet:validate -- --file ../docs/staging-release-packet-draft-2026-06-27.md`
- Passed: `node scripts/validate-staging-release-packet.mjs --file docs/local-staging-release-pilot.md`
- Passed: `npm --prefix codegen run release-packet:validate -- --file ../docs/staging-github-governance-evidence-2026-06-26.md`
- Passed: `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/db-roles-least-privilege.int.ts`
- Passed: `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/runtime-worker-drive.int.ts`
- Passed: `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/runtime-worker-resume-drive.int.ts`
- Passed: `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/runtime-worker-abort-finalization.int.ts`
- Passed: `python -c "import pathlib, yaml; yaml.safe_load(pathlib.Path('compose.yaml').read_text(encoding='utf-8'))"`

## Notes

- `rpa_enterprise_console.html` remains a legacy standalone review mockup and is not the production console implementation.
- Secret values remain outside UI/API payloads. This branch only exposes SecretRef paths, state, and audit-safe metadata.
- No silent false/unknown behavior is introduced: invalid pause states, malformed SCIM payloads, missing idempotency keys, invalid worker IDs, and unsupported search query shapes fail loudly or return explicit empty results by contract.
