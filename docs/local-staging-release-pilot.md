# Local Staging Release Pilot

This file records a local-only pilot for the row 43 staging release packet.
It is intentionally not row 43 closure evidence.

Use it when the owner wants to rehearse the staging governance, approval,
rollback, and provisioning evidence flow on a developer machine before creating
the real external staging platform evidence.

## Boundary

- This pilot runs with `RPA_ENV=local`, not `RPA_ENV=staging`.
- It does not create a GitHub Environment, deployment approval, deploy target,
  Vault path, SecretRef inventory, object-store backend, or live D5 run.
- It may be validated with `release-packet:validate` to prove packet shape and
  redaction safety only.
- It must not be attached to `release-open-checklist.md` or
  `product-open-candidate-report.md` as row 43 closure evidence.

The current runtime guard rejects `ARTIFACT_LIFECYCLE_OBJECT_STORE_MODE=local_fs`
outside `RPA_ENV=dev|local`. That is why the local dry-run can pass while a real
staging packet still requires owner-provided external deploy evidence.

## Local Preflight

Preferred local replay:

```powershell
node scripts/run-local-staging-pilot.mjs
```

The helper runs the local preflight, confirms that the same filesystem mode is
blocked under `RPA_ENV=staging`, and validates this packet's shape.

Equivalent PowerShell command for the local preflight step:

```powershell
$env:RPA_ENV='local'
$env:CODEX_BASE_URL='https://codex.invalid/v1'
$env:CODEX_API_KEY='local-nonsecret-placeholder'
$env:CODEX_MODEL='local-model-alias'
$env:GATEWAY_ARTIFACT_DIR=(Join-Path (Get-Location) '.tmp/local-staging-artifacts')
$env:ARTIFACT_LIFECYCLE_DATABASE_URL='postgresql://local-pilot@localhost/rpa_local'
$env:ARTIFACT_LIFECYCLE_WORKER_ID='20000000-0000-4000-8000-0000000000aa'
$env:ARTIFACT_LIFECYCLE_OBJECT_STORE_MODE='local_fs'
$env:ARTIFACT_OBJECT_STORE_REF='rpa/local/artifact-lifecycle/object_store/fs'
npm --prefix app run preflight:artifact-store -- --topology split-worker-lifecycle
```

Observed result:

```json
{"at":"artifact-store-topology-preflight","status":"pass","topology":"split_worker_lifecycle","label":"split worker/lifecycle processes"}
```

Negative control for the same local filesystem mode under `RPA_ENV=staging`:

```json
{"at":"artifact-store-topology-preflight","status":"fail","topology":"split_worker_lifecycle","label":"split worker/lifecycle processes","reason":"ARTIFACT_LIFECYCLE_OBJECT_STORE_MODE=local_fs is allowed only when RPA_ENV is dev|local"}
```

## Local Packet Shape

The block below is a local-pilot packet. It is deliberately worded so that each
field names a dry-run alias rather than an external staging fact.

```text
[STAGING RELEASE PACKET -- redacted]
- staging platform repo            : [local-platform-repo-1] local worktree C:/project/RPA; local-pilot only; not an external platform repo
- concrete deploy target           : [local-deploy-target-1] local process set api/worker/lifecycle-worker; no managed staging target created
- GitHub Environment `staging`      : protection=local-simulated, required reviewer=[local-owner-approval-1], branch policy=local-main-only; no GitHub Environment was created by this pilot
- release approval reference        : [local-owner-approval-1] local owner-requested dry-run evidence; no deployment approval URL created
- rollback confirmation             : forward-only(D7-4) + prior-image local redeploy drill; owner=#13; evidence=[local-rollback-plan-1]
- SecretStore alias/path            : Vault KV v2 mount `secret/`, intended staging base `secret/data/rpa/staging/<runtime>/<purpose>/<name>`; local-pilot alias=[local-vault-plan-1]; values omitted
- namespace / identity map          : D8-A12 local dry-run identity map aliases [local-runtime-worker-1], [local-browser-worker-1], [local-artifact-lifecycle-1], [local-llm-gateway-1]
- SecretRef inventory               : D8-A12 identifier-only local inventory [local-secretref-inventory-1]; no resolved material
- runtime artifact object-store env : local dry-run uses `ARTIFACT_OBJECT_STORE_REF=rpa/local/artifact-lifecycle/object_store/fs`; intended staging alias=[staging-object-store-ref-1]
- artifact store topology preflight  : run `npm --prefix app run preflight:artifact-store -- --topology split-worker-lifecycle`; PASS with RPA_ENV=local/local_fs; evidence=[local-preflight-1]
- retention policy                  : D8-A11/D8-A14 and ops-defaults section 6.1 rehearsed locally; DB alias=[local-pg-1]
- live D5 evidence                  : row 50 existing packet aliases [codex-staging-1]/[model-a]; local pilot creates no new live D5 run; evidence=[d5-live-alias-only-1]
- secret.resolve audit sample       : seq#1/hash#[local-audit-hash-1], no material
- negative control proof            : secret-scan rejects GitHub `secrets` context, environment: staging binding, env dump commands, and xtrace; evidence=[local-negative-control-1]
```

Validate the shape only:

```powershell
npm --prefix codegen run release-packet:validate -- --file ../docs/local-staging-release-pilot.md
```

## Promotion Requirements

To promote this rehearsal into real row 43 closure, replace every `local-*`
alias with owner-controlled external evidence from:

- A concrete platform or deployment repository outside this contract repo.
- A real GitHub Environment named `staging` with protection, required reviewer,
  and deployment branch policy.
- A concrete deploy target such as namespace/service or equivalent managed
  container target.
- A release approval reference and rollback confirmation owned by #13.
- Vault KV v2 staging paths, D8-A12 identity map, and identifier-only SecretRef
  inventory.
- Final deploy-env `preflight:artifact-store` PASS evidence.
- Live row 50 D5 aliases and negative-control evidence with no env dump, xtrace,
  or resolved secret material.
