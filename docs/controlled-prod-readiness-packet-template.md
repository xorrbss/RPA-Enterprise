# Controlled-Prod Readiness Packet Template

This is the owner-facing packet shape for a controlled-production open claim.
It is stricter than the row 43 staging release packet. Row 43 proves governance
and deploy-target evidence; this packet proves that
`GET /v1/ops/production-readiness` can truthfully return
`summary.controlled_prod_ready=true`.

The validator checks packet shape and redaction safety only. It does not prove
that a bracket alias maps to real owner-controlled evidence. Do not claim
controlled production open from this template alone.

## Validator Contract

The validator reads only a block beginning with:

```text
[CONTROLLED-PROD READINESS PACKET -- redacted]
```

Required field labels:

1. `readiness snapshot`
2. `external alert delivery evidence`
3. `managed backup restore evidence`
4. `slo on-call signoff evidence`
5. `support training completion evidence`
6. `observability telemetry evidence`
7. `prod release gate evidence`
8. `negative control proof`

Required evidence rules:

- `readiness snapshot` must include `GET /v1/ops/production-readiness`,
  `status=ready`, `controlled_prod_ready=true`, `blocker_count=0`,
  `warning_count=0`, `deferred_count=0`, `external_alert_delivery=pass`,
  `managed_backup_restore_drill=pass`,
  `slo_oncall_signoff=pass`, `support_training_completion=pass`,
  `observability_telemetry_wiring=pass`, and `evidence=production_readiness_evidence`.
- `external alert delivery evidence` must record
  `evidence_type=external_alert_delivery`, `status=valid`,
  `metadata.channel=teams|slack|email|webhook`,
  `metadata.provider_alias=`, `metadata.receipt_id=`,
  `metadata.receipt_at=`, `metadata.delivery_status=delivered`, and
  `no endpoint_url/token/webhook_secret`.
- `managed backup restore evidence` must record
  `evidence_type=managed_backup_restore_drill`, `status=valid`,
  `metadata.backup_policy_ref=`, `metadata.restore_scope=`,
  `metadata.restore_completed_at=`, `metadata.rto_minutes<=120`, and
  `metadata.rpo_minutes<=15`, plus `no dsn/url/credential`.
- `slo on-call signoff evidence` must record
  `evidence_type=slo_oncall_signoff`, `status=valid`,
  `metadata.slo_dashboard=`, `metadata.severity_model=`,
  `metadata.oncall_rota=`, `metadata.raci_ref=`,
  `metadata.support_hours=`, plus `no dashboard_url/token/secret`.
- `support training completion evidence` must record
  `evidence_type=support_training_completion`, `status=valid`,
  `evidence_ref=`, `expires_at=`, `metadata.support_model_ref=`,
  `metadata.training_completion_ref=`, `metadata.trained_role_count=`,
  `metadata.trained_user_count=`, `metadata.coverage_percent=`,
  `metadata.completed_at=`, plus
  `no raw_roster/user_list/training_document/url/token/secret`.
- `observability telemetry evidence` must record
  `evidence_type=observability_telemetry_wiring`, `status=valid`,
  `metadata.exporter=prometheus|otlp`, `metadata.collector_ref=`,
  `metadata.dashboard_ref=`, `metadata.alert_route_ref=`,
  `metadata.sampled_at=`, plus `no collector_url/dashboard_url/token/secret`.
- `prod release gate evidence` must show that prod approve/deploy requires
  `summary.controlled_prod_ready=true`, while rollback remains a recovery path
  and is not blocked by readiness.

## Redaction Rules

Use bracket aliases for owner-controlled evidence artifacts, such as
`[prod-readiness-1]`, `[external-alert-delivery-1]`,
`[managed-backup-drill-1]`, `[slo-oncall-1]`,
`[support-training-1]`, and `[prod-release-gate-1]`.

Do not include endpoint URLs, webhook URLs, dashboard URLs, DSNs, hostnames,
IP addresses, bearer/API tokens, Vault/AppRole material, SMTP secrets,
provider response bodies containing credentials, raw rosters, user lists,
training documents, training-document URLs, env dumps, shell xtrace output,
resolved SecretRef material, raw `ObjectRef`, or fake/test evidence.

## Packet Skeleton

```text
[CONTROLLED-PROD READINESS PACKET -- redacted]
- readiness snapshot : GET /v1/ops/production-readiness; status=ready; controlled_prod_ready=true; blocker_count=0; warning_count=0; deferred_count=0; external_alert_delivery=pass; managed_backup_restore_drill=pass; slo_oncall_signoff=pass; support_training_completion=pass; observability_telemetry_wiring=pass; evidence=production_readiness_evidence [prod-readiness-1]
- external alert delivery evidence : POST /v1/ops/production-readiness/evidence; evidence_type=external_alert_delivery; status=valid; evidence_ref=[external-alert-delivery-1]; expires_at=[external-alert-expiry-1]; metadata.channel=webhook; metadata.provider_alias=[provider-alias-1]; metadata.receipt_id=[receipt-id-1]; metadata.receipt_at=[receipt-at-1]; metadata.delivery_status=delivered; no endpoint_url/token/webhook_secret
- managed backup restore evidence : POST /v1/ops/production-readiness/evidence; evidence_type=managed_backup_restore_drill; status=valid; evidence_ref=[managed-backup-drill-1]; expires_at=[backup-expiry-1]; metadata.backup_policy_ref=[backup-policy-1]; metadata.restore_scope=[restore-scope-1]; metadata.restore_completed_at=[restore-at-1]; metadata.rto_minutes=45; metadata.rpo_minutes=5; no dsn/url/credential
- slo on-call signoff evidence : POST /v1/ops/production-readiness/evidence; evidence_type=slo_oncall_signoff; status=valid; evidence_ref=[slo-oncall-1]; expires_at=[slo-expiry-1]; metadata.slo_dashboard=[slo-dashboard-1]; metadata.severity_model=sev1-sev4; metadata.oncall_rota=[oncall-rota-1]; metadata.raci_ref=[raci-1]; metadata.support_hours=24x7; no dashboard_url/token/secret
- support training completion evidence : POST /v1/ops/production-readiness/evidence; evidence_type=support_training_completion; status=valid; evidence_ref=[support-training-1]; expires_at=[support-training-expiry-1]; metadata.support_model_ref=[support-model-1]; metadata.training_completion_ref=[training-completion-1]; metadata.trained_role_count=4; metadata.trained_user_count=12; metadata.coverage_percent=100; metadata.completed_at=[training-completed-at-1]; no raw_roster/user_list/training_document/url/token/secret
- observability telemetry evidence : POST /v1/ops/production-readiness/evidence; evidence_type=observability_telemetry_wiring; status=valid; evidence_ref=[observability-1]; expires_at=[observability-expiry-1]; metadata.exporter=otlp; metadata.collector_ref=[otel-collector-1]; metadata.dashboard_ref=[slo-dashboard-1]; metadata.alert_route_ref=[alert-route-1]; metadata.sampled_at=[observability-sampled-at-1]; no collector_url/dashboard_url/token/secret
- prod release gate evidence : target_environment=prod; require summary.controlled_prod_ready=true; approve_deploy=blocked_unless_ready; rollback_not_blocked_by_readiness; evidence=scenario_releases [prod-release-gate-1]
- negative control proof : secret-scan rejects endpoint URLs, webhook URLs, raw URLs, tokens, secrets, raw rosters, user lists, training documents, env dump, xtrace, and resolved SecretRef material; evidence=[prod-negative-control-1]
```

## Validation Commands

```powershell
npm --prefix codegen run prod-readiness-packet:fixtures
npm --prefix codegen run prod-readiness-packet:validate -- --file [owner-packet-file]
git diff --check
```

Before accepting the packet, also verify the live API evidence path:

```powershell
GET /v1/ops/production-readiness
```

The response must include `summary.controlled_prod_ready=true` and pass gates
for `external_alert_delivery`, `managed_backup_restore_drill`, and
`slo_oncall_signoff`, `support_training_completion`, and
`observability_telemetry_wiring`.
