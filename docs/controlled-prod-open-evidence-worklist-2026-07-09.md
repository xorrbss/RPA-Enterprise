# Controlled-Prod Open Evidence Worklist - 2026-07-09

This worklist tracks the remaining owner-controlled evidence needed before a
controlled-production open claim. It is not a production approval, not a
deployment authorization, and not evidence that the bracket aliases below map
to real systems. The owner must provide redacted evidence aliases and keep raw
URLs, tokens, credentials, rosters, training documents, provider responses,
`ObjectRef` values, and resolved `SecretRef` material out of the repository.

## Current Status

- Latest repo-controlled product-code `main` commit checked:
  `31fac6c3dbc98019bc90a64a1faab78112727635`.
- `main` `Contract Gates` run `29020806944` concluded `success`; required
  job URLs are recorded below and in the release evidence docs.
- The cancelled run `29018141965` for commit `01e36cac07dc5932112a59000630f47bea69669e`
  is not passing evidence. It was superseded by a newer `main` push under the
  `contract-gates-${{ github.ref }}` concurrency group.
- Evidence-only documentation commits after this worklist still require their
  own `main` `Contract Gates` `conclusion=success` check before external
  release citation.
- Staging governance packet: `docs/staging-github-governance-evidence-2026-06-26.md`.
- Controlled-prod packet shape: `docs/controlled-prod-readiness-packet-template.md`.
- Staging governance does not imply managed runtime deployment or production
  open. Row 43 currently records `controlled_prod_ready=false` with deferred
  owner gates.

## Required Controlled-Prod Evidence

Before any controlled-production claim, the live readiness path must prove:

- `GET /v1/ops/production-readiness`
- `status=ready`
- `summary.controlled_prod_ready=true`
- `blocker_count=0`
- `warning_count=0`
- `deferred_count=0`
- `external_alert_delivery=pass`
- `managed_backup_restore_drill=pass`
- `slo_oncall_signoff=pass`
- `support_training_completion=pass`
- `observability_telemetry_wiring=pass`

The owner must register valid metadata-only evidence through
`POST /v1/ops/production-readiness/evidence` for every owner gate:

| Evidence type | Required metadata |
| --- | --- |
| `external_alert_delivery` | `channel`, `provider_alias`, `receipt_id`, `receipt_at`, `delivery_status=delivered` |
| `managed_backup_restore_drill` | `backup_policy_ref`, `restore_scope`, `restore_completed_at`, `rto_minutes<=120`, `rpo_minutes<=15` |
| `slo_oncall_signoff` | `slo_dashboard`, `severity_model`, `oncall_rota`, `raci_ref`, `support_hours` |
| `support_training_completion` | `support_model_ref`, `training_completion_ref`, `trained_role_count`, `trained_user_count`, `coverage_percent`, `completed_at` |
| `observability_telemetry_wiring` | `exporter=prometheus|otlp`, `collector_ref`, `dashboard_ref`, `alert_route_ref`, `sampled_at` |

Negative controls must prove the packet contains no endpoint URLs, webhook
URLs, dashboard URLs, DSNs, hostnames, IP addresses, bearer/API tokens,
Vault/AppRole material, SMTP secrets, provider response bodies containing
credentials, raw rosters, user lists, training documents, env dumps, shell
xtrace output, resolved `SecretRef` material, raw `ObjectRef`, or fake/test
evidence.

## Validation Commands

Run these before attaching a controlled-prod readiness packet:

```powershell
npm --prefix codegen run prod-readiness-packet:fixtures
npm --prefix codegen run prod-readiness-packet:validate -- --file <owner-packet.md>
git diff --check
npm --prefix codegen run blocked:audit
```

The validator checks packet shape and redaction safety. It does not prove that
an alias maps to real owner-operated infrastructure.

## Release Approval And Operations Evidence

Before external release review, attach:

- Latest successful repo-controlled product-code `main` `Contract Gates` run:
  `https://github.com/xorrbss/RPA-Enterprise/actions/runs/29020806944`
  on commit `31fac6c3dbc98019bc90a64a1faab78112727635`; required jobs:
  `secret-scan`
  `https://github.com/xorrbss/RPA-Enterprise/actions/runs/29020806944/job/86126869836`,
  `PostgreSQL 15 migration smoke`
  `https://github.com/xorrbss/RPA-Enterprise/actions/runs/29020806944/job/86126869821`,
  `Operations console (web) typecheck, tests, build`
  `https://github.com/xorrbss/RPA-Enterprise/actions/runs/29020806944/job/86126869878`,
  and `App runtime typecheck and tests`
  `https://github.com/xorrbss/RPA-Enterprise/actions/runs/29020806944/job/86126869909`.
- Staging governance packet validation result.
- Owner release approval reference.
- Rollback confirmation and recovery path.
- SecretStore alias/path and identifier-only `SecretRef` inventory.
- Controlled-prod readiness packet validation result after owner evidence is
  present.

## External Sink Delivery Scope

External sink delivery is not claimed for this release unless owner evidence is
attached for all of the following:

- Customer/provider endpoint ownership.
- Allowed-host approval.
- Endpoint `SecretRef` provisioning.
- Real HTTPS `real_sink` egress using the approved endpoint `SecretRef`.
- Downstream `Idempotency-Key` derived from `sink_idempotency_key`.
- Redacted delivery receipt or attempt alias.
- No raw payload, Authorization header, resolved endpoint URL, or resolved
  `SecretRef` material in logs, audit, or release evidence.

Repo-controlled DB mechanics, DLQ/replay behavior, and `real_sink` guardrails
exist, but they do not by themselves prove staging/product external delivery.

## External IDP/OCR Scope

External IDP/OCR is not claimed as a completed OCR feature in this release.
The included slice is:

- Built-in deterministic extraction over redaction-visible text/CSV/JSON
  artifacts.
- Human validation for missing or low-confidence fields.
- Metadata-only normalized-result intake from external providers through
  `POST /v1/document-jobs/{job_id}/external-extractions`.

Out of scope until owner/provider evidence and new contracts exist:

- Image/PDF OCR.
- OCR engine/provider operation.
- Provider invocation/classification/training.
- Raw OCR text or long OCR text storage.
- Raw endpoint URLs, signed URLs, tokens, provider response bodies, and
  resolved `SecretRef` material.

## Next Actions

1. Repo-controlled product-code CI evidence is recorded for run `29020806944`
   / commit `31fac6c3dbc98019bc90a64a1faab78112727635`.
2. After this evidence-only docs update is pushed, confirm that commit's own
   `main` `Contract Gates` run has `conclusion=success` before external review.
3. Ask the owner to provide a real controlled-prod readiness packet using
   `docs/controlled-prod-readiness-packet-template.md`.
4. Validate the owner packet with
   `npm --prefix codegen run prod-readiness-packet:validate -- --file <owner-packet.md>`.

## Owner Execution Runbook (2026-07-11)

This runbook tells the single owner, in execution order, what to run and where
each proof must land so that every gate in `GET /v1/ops/production-readiness`
reports `pass`. It inherits the redaction policy at the top of this document:
evidence is recorded as redacted aliases only; raw URLs, webhook URLs, tokens,
DSNs, rosters, training documents, provider response bodies, resolved
`SecretRef` material, and raw `ObjectRef` never enter the repository or the
evidence API. The evidence API enforces this server-side: strings containing
`http(s)://` or secret-looking pairs and metadata keys matching
url/token/secret/password/credential/dsn/smtp/roster/payload are rejected
fail-closed (`app/src/api/production-readiness-evidence-validation.ts:326-358`).

Code anchors below were measured on 2026-07-11 against `main`. Re-verify the
file:line anchors before relying on them if the readiness code changes.

### Gate inventory (measured)

`GET /v1/ops/production-readiness` assembles 13 gates
(`app/src/api/production-readiness.ts:108-122`). `summary.status="ready"` and
`summary.controlled_prod_ready=true` require
`blocker_count=warning_count=deferred_count=0`
(`app/src/api/production-readiness-gates.ts:106-122`). Readiness is a live
computation, not a stored badge — any gate can regress after it first passes.

| # | gate_id | Console label | Green condition (code anchor) | Act / record via |
| --- | --- | --- | --- | --- |
| 1 | `auth_sso_readiness` | Auth/SSO readiness | JWT mode `jwks` with JWKS URL, issuer, audience all configured (`app/src/api/production-readiness-gates.ts:40-80`, `app/src/api/auth-readiness.ts:33-46`) | API process env (`app/src/config/env-auth.ts:22-37`) |
| 2 | `ai_governance_runtime` | AI governance runtime | No tenant LLM usage → auto-pass; else runtime policy exists and every required evidence item is valid (`app/src/api/ai-governance-readiness.ts:45-55,103-144`) | `PUT /v1/ai-governance/runtime-policy`, `POST /v1/ai-governance/evidence` (`app/src/api/ai-governance-evidence.ts:71,109`) |
| 3 | `database_migrations` | DB 변경 적용 | `schema_migrations` has versions `0001`,`0002` with `status='applied'` (`app/src/api/production-readiness-gates.ts:37,124-156`) | `node scripts/db-migrate.mjs` (`scripts/db-migrate.mjs:16-19,179-191`) |
| 4 | `graphile_queue` | Graphile queue | `graphile_worker.jobs` view readable (`app/src/api/production-readiness-gates.ts:158-179`) | worker boot auto-migrate (default) or `node scripts/db-migrate.mjs --graphile-worker` (`app/src/main-worker.ts:209-210`, `scripts/db-migrate.mjs:619-651`) |
| 5 | `browser_pool_ha` | 브라우저 실행기 이중화 | Tenant assigned to an explicit pool (`pool_key != "default"`) and `active_workers >= 2` (`app/src/api/production-readiness-gates.ts:181-214`, `app/src/runtime/bot-pool-read.ts:205-226`) | `POST /v1/worker-pools`, `PUT /v1/worker-pool`, `PUT /v1/worker-pools/{pool_key}/workers/{worker_id}` (`app/src/api/worker-pools.ts:98,184,220`) + two worker daemons |
| 6 | `browser_lease_hygiene` | Browser lease hygiene | `expired_open=0` for reserved/active browser leases (`app/src/api/production-readiness-gates.ts:216-237`) | `lease_sweeper` maintenance job, 5s cadence (`app/src/worker/maintenance-scheduler.ts:29,58`, `app/src/worker/runtime-worker.ts:212`) |
| 7 | `stale_run_backlog` | Stale run backlog | `nonterminal_over_15m=0` (`app/src/api/production-readiness-gates.ts:239-260`) | `POST /v1/runs/{run_id}/abort` or `POST /v1/runs/{run_id}/resume` (`app/src/api/server.ts:279,297`) |
| 8 | `audit_chain_evidence` | 감사 체인 증빙 | `audit_log` rows exist, latest verifier run `valid`, age ≤ 75 min (`app/src/api/production-readiness-gates.ts:38,262-320`) | `POST /v1/audit-log/verification-runs/verify` (`app/src/api/audit-log.ts:123`) + hourly `audit_verifier` job (`app/src/worker/maintenance-scheduler.ts:83-92`) |
| 9 | `external_alert_delivery` | 외부 알림 전달 | Valid unexpired owner evidence and latest provider delivery (if any) not `failed`; or a `delivered` provider receipt fresher than 90 days (`app/src/api/production-readiness-owner-gates.ts:5,7-62`) | Evidence POST / console form; real receipt via `POST /v1/ops-alerts/{alert_id}/deliveries` or signed provider callback (`app/src/api/ops-alerts-deliveries.ts:104,125-203`) |
| 10 | `managed_backup_restore_drill` | 백업 복구 리허설 | Latest owner evidence `valid` and unexpired (`app/src/api/production-readiness-owner-gates.ts:64-77,124-178`) | Evidence POST / console form |
| 11 | `slo_oncall_signoff` | SLO·당직 승인 | Same owner-evidence rule (`app/src/api/production-readiness-owner-gates.ts:79-92`) | Evidence POST / console form |
| 12 | `observability_telemetry_wiring` | 관측성 연결 | Same owner-evidence rule (`app/src/api/production-readiness-owner-gates.ts:94-107`) | Evidence POST / console form |
| 13 | `support_training_completion` | 지원·교육 완료 | Same owner-evidence rule (`app/src/api/production-readiness-owner-gates.ts:109-122`) | Evidence POST / console form |

Korean console labels come from
`web/src/views/orchestration/production-readiness-labels.ts:38-48`; gates
without a Korean mapping display the API label as-is. The console surface is
`#automationOps?section=readiness` — the "실행 예약·알림" view, "운영 전환 증빙"
tab, "운영 전환 준비 상태" panel (`web/src/views/Orchestration.tsx:39-45`,
`web/src/views/orchestration/ProductionReadinessPanel.tsx:163`).

### Common prerequisites (owner-owned)

- A deployed controlled-prod stack: PostgreSQL 15+, API (`RUN_MODE=api` or
  `all`), worker (`RUN_MODE=worker` or `all`). Deployment env inventory, DB
  role separation (`rpa_migrator`/`rpa_app`), token minting, and per-env ALM
  are in `docs/staging-deploy-runbook.md` — apply them per environment; they
  are not duplicated here.
- An access token whose role maps to `admin`. The write actions used below —
  `ops_readiness.manage`, `ops_alert.deliver`, `audit.verify`,
  `worker_pool.manage`, `ai_governance.manage` — are admin-only
  (`ts/rbac-policy.ts:164-234`). Reading readiness needs only
  `ops_alert.read` (all roles).
- Every mutating call needs `Authorization: Bearer <admin-token>`,
  `Content-Type: application/json`, and an `Idempotency-Key` header; a missing
  key is rejected (`app/src/api/command.ts:53`).
- Owner-side real assets, referenced by alias only: an external alert channel
  (webhook/Teams/Slack/email) that can produce a provider receipt, a managed
  backup/PITR target, an SLO dashboard with on-call/RACI sign-off, an
  OTLP/Prometheus collector with dashboard and alert route, and support model
  plus training-completion records.

### Step 1 — Migrations and queue schema (gates 3, 4)

Prepare: migrator DSN (`rpa_migrator`, DG1 section of the staging runbook).

```powershell
$env:DATABASE_URL = "<migrator DSN — deploy-platform secret, never committed>"
node scripts/db-migrate.mjs
node scripts/db-migrate.mjs --graphile-worker
```

There is no npm alias for this runner; call the script directly. `0001` maps
to `db/migration_concurrency_idempotency.sql`, `0002` to
`db/migration_core_entities.sql` (`scripts/db-migrate.mjs:16-19`). The
graphile schema also self-installs at worker boot when
`GRAPHILE_MIGRATIONS_MODE` is unset (default `runtime`,
`app/src/config/env-worker.ts:174-178`); the explicit `--graphile-worker` run
additionally grants runtime queue privileges.

Green check: gates 3 and 4 report `pass` with evidence lines
`schema_migrations:0001:applied`, `schema_migrations:0002:applied`, and
`pending_jobs=<n>`.

### Step 2 — Browser worker HA (gates 5, 6)

Prepare: two worker processes (separate hosts or processes) with distinct
`WORKER_ID` values, Chrome installed, worker env per the staging runbook.

1. Start two workers with `RUN_MODE=worker`, unique `WORKER_ID`, and
   `WORKER_POOL_KEYS=<pool_key>` (`app/src/config/env-worker.ts:67,75`). Each
   worker self-registers in `workers` and heartbeats
   (`app/src/main-worker.ts:154-167,332`).
2. Create the pool: `POST /v1/worker-pools` with body `{"pool_key":
   "<pool_key>"}` (optional `description`, `status`, `max_concurrency`,
   `priority` — `app/src/api/worker-pools.ts:98-135,307`).
3. Assign the tenant: `PUT /v1/worker-pool` with `{"pool_key": "<pool_key>"}`
   (`app/src/api/worker-pools.ts:184`). Without this the capacity stays
   implicit-default and the gate blocks
   (`app/src/runtime/bot-pool-read.ts:220-224`).
4. Enroll both workers: `PUT /v1/worker-pools/{pool_key}/workers/{worker_id}`
   (`app/src/api/worker-pools.ts:220`).
5. Keep the maintenance scheduler alive for lease hygiene: the worker daemon
   runs `lease_sweeper` every 5 seconds, which needs `MAINTENANCE_TENANT_IDS`
   (or a dedicated BYPASSRLS lifecycle pool) configured
   (`app/src/config/env-worker.ts:61`,
   `app/src/worker/maintenance-scheduler-tenant-discovery.ts:2,259`).

Green check: gate 5 `pass` with `pool_key=<pool_key>`, `active_workers>=2`;
gate 6 `pass` with `expired_open=0`.

### Step 3 — Enterprise SSO (gate 1)

Prepare: owner IdP with a JWKS endpoint, an issuer value, an audience value,
and an admin-role mapping for the owner principal (claim mapping and
`JWT_ROLE_MAP` env per `app/src/config/env-auth.ts:55-67`).

Set on the API process and restart: `JWKS_URL` (https enforced), `JWT_ISSUER`,
`JWT_AUDIENCE` (`app/src/config/env-auth.ts:22-37`). With `RPA_ENV=prod` the
process refuses to boot when issuer or audience is missing (fail-closed,
`app/src/config/env-auth.ts:27-33`).

Dependency: the API verifies only the configured mode, so HS256 pilot tokens
stop working after the switch; subsequent API calls in this runbook need an
IdP-issued admin JWT. Single-mode behavior is per
`app/src/config/env-auth.ts:5` — verify token acceptance at execution time.

Green check: gate 1 `pass` with `provider_mode=jwks`, `issuer_configured=true`,
`audience_configured=true`.

### Step 4 — AI governance runtime (gate 2)

If the tenant has no `gateway_policies` model rows and no observed prompt
template versions, the gate auto-passes with `ai_runtime_enabled=false`
(`app/src/api/ai-governance-readiness.ts:45-55`) — nothing to do.

Otherwise:

1. `PUT /v1/ai-governance/runtime-policy` with observe/warn/block mode and
   owner-approved policy references (`app/src/api/ai-governance-evidence.ts:71`;
   exact body fields per the parser in `app/src/api/ai-governance-policy.ts` —
   verify at execution time).
2. `POST /v1/ai-governance/evidence` for every generated requirement:
   `model_registry:<model>` per configured model, `cost_control:tenant` when
   any model exists, and `prompt_registry:<version>` plus
   `eval_result:<version>` per observed prompt version
   (`app/src/api/ai-governance-evidence-requirements.ts:3,28-45`).

Green check: gate 2 `pass` with detail "AI runtime policy and required
model/prompt/cost/eval evidence are valid."

### Step 5 — Owner evidence for gates 9-13

For each of the five owner gates: run the real drill first on owner
infrastructure, then record metadata-only evidence. Two equivalent recording
paths:

- Console: `#automationOps?section=readiness`, forms "알림 전달 증빙 기록",
  "백업 복구 리허설 증빙 기록", "SLO·당직 승인 증빙 기록", "지원·교육 증빙 기록",
  "관측성 증빙 기록" (visible only with `ops_readiness.manage`,
  `web/src/views/orchestration/useReadinessSection.tsx:153-165`). The forms
  set `evidence_at=now` and default expiry to +90 days.
- API: `POST /v1/ops/production-readiness/evidence`
  (`app/src/api/production-readiness.ts:76-90`), body fields
  `evidence_type`, `status`, `evidence_at`, `expires_at`, `summary`,
  `evidence_ref`, `metadata`, `legal_hold`; unknown fields are rejected
  (`app/src/api/production-readiness-evidence-validation.ts:17-49`).
  Per-type required metadata is the "Required Controlled-Prod Evidence" table
  above, enforced at
  `app/src/api/production-readiness-evidence-validation.ts:93-260`
  (channel enum, `delivery_status=delivered`, `rto_minutes<=120`,
  `rpo_minutes<=15`, coverage 0-100, exporter `prometheus|otlp`, timestamps
  not in the future).

Example (aliases only, one line per JSON field for readability):

```text
POST /v1/ops/production-readiness/evidence
Idempotency-Key: readiness-external-alert-2026-07-11-1
{ "evidence_type": "external_alert_delivery", "status": "valid",
  "evidence_at": "<now ISO>", "expires_at": "<now+90d ISO>",
  "summary": "Provider delivered the controlled-prod alert drill.",
  "evidence_ref": "[external-alert-delivery-1]",
  "metadata": { "channel": "webhook", "provider_alias": "[provider-alias-1]",
    "receipt_id": "[receipt-id-1]", "receipt_at": "<receipt ISO>",
    "delivery_status": "delivered" }, "legal_hold": false }
```

Semantics that affect green:

- The latest evidence row per type wins (`evidence_at` descending,
  `app/src/api/production-readiness-evidence.ts:63-97`). `status=valid`
  requires a future `expires_at`; expired evidence degrades the gate to
  deferred, and a latest `failed` row hard-blocks until a newer valid row is
  recorded (`app/src/api/production-readiness-owner-gates.ts:124-178`).
- `external_alert_delivery` additionally reads the live delivery ledger: if
  any `ops_notification_deliveries` row exists, the latest one must not be
  `failed` even when owner evidence is valid; a `delivered` provider receipt
  fresher than 90 days passes the gate on its own
  (`app/src/api/production-readiness-owner-gates.ts:24-61`). The real-receipt
  path is `POST /v1/ops-alerts/{alert_id}/deliveries` (metadata-only manual
  record) or the send-webhook attempt plus HMAC-signed provider callback
  (`app/src/api/ops-alerts-deliveries.ts:104,125-203`), both admin
  (`ops_alert.deliver`).

Green check: gates 9-13 `pass`; list rows via
`GET /v1/ops/production-readiness/evidence?evidence_type=<type>&limit=3`
(`app/src/api/production-readiness.ts:65-74`).

### Step 6 — Runtime hygiene at snapshot time (gates 6, 7)

- Keep the worker daemon (and its maintenance scheduler) running so
  `lease_sweeper` reclaims expired browser leases automatically.
- Drain stale runs: read `signals.ops_health.stale_runs` from the readiness
  response, then `POST /v1/runs/{run_id}/abort` (or `/resume` for suspended
  runs that should continue) per run (`app/src/api/server.ts:279,297`).

Green check: gate 6 `expired_open=0`, gate 7 `nonterminal_over_15m=0`.

### Step 7 — Audit chain freshness (gate 8), last before snapshot

Audit rows accumulate from the audited control-plane commands executed in the
earlier steps; confirm `audit_count>0` from the gate evidence at execution
time. Then produce a fresh verifier run:

```text
POST /v1/audit-log/verification-runs/verify   (admin, audit.verify)
```

The run must be `valid` and no older than 75 minutes when the final snapshot
is taken (`app/src/api/production-readiness-gates.ts:38,296-306`). The hourly
`audit_verifier` maintenance job keeps this green continuously when the worker
maintenance scheduler is configured
(`app/src/worker/maintenance-scheduler.ts:83-92`,
`app/src/worker/maintenance-scheduler-tenant-discovery.ts:9`).

### Step 8 — Final snapshot and packet

1. `GET /v1/ops/production-readiness` and confirm every field in the
   "Required Controlled-Prod Evidence" section above: `status=ready`,
   `summary.controlled_prod_ready=true`, zero blocker/warning/deferred, and
   `pass` on all five owner gates.
2. Build the owner packet from
   `docs/controlled-prod-readiness-packet-template.md` and run the
   "Validation Commands" section above (not duplicated here).
3. Record the packet aliases and update row 43 / this worklist. The docs
   commit carrying the evidence still needs its own `main` `Contract Gates`
   `conclusion=success` before external citation (see Current Status).

### Execution order summary

1. Step 1 (migrations, queue) — everything else assumes the schema.
2. Step 2 (workers, pool, maintenance env) — needed for gates 4, 5, 6 and the
   hourly audit verifier.
3. Step 3 (SSO switch) — any time before the final snapshot, but all later
   API calls then require IdP-issued admin tokens, so switching early avoids
   re-recording anything under a throwaway identity.
4. Step 4 (AI governance) — only if tenant LLM usage exists.
5. Step 5 (owner drills and evidence) — independent of each other; evidence
   expires, so record within the expiry window of the open claim.
6. Steps 6-7 (hygiene, audit verifier) — immediately before the snapshot;
   gate 8 has a 75-minute window.
7. Step 8 (snapshot, packet, validation).

This runbook is not a production approval, not a deployment authorization,
and not an operations-open approval. Completing it produces the inputs for
the readiness packet; release approval, external review, and closure of the
deferred owner gates in row 43 remain separate owner decisions, and none of
the aliases above prove by themselves that they map to real owner-operated
systems.
