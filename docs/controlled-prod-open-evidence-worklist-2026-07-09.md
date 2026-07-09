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
