# Staging GitHub Governance Evidence - 2026-06-26

This document records the row 43 GitHub governance, approval, rollback,
identifier-only provisioning, and artifact-store preflight evidence. The
project owner ratified the GitHub Actions Environment gate as the concrete
staging deployment target for this release; no managed application/container
runtime target is claimed by this packet.

## Completed External Setup

- Platform/deploy repo: `xorrbss/rpa-platform-deploy`
- Repo URL: `https://github.com/xorrbss/rpa-platform-deploy`
- Visibility: public, because branch protection is unavailable for private
  repositories on the current account plan. This repo stores no secret material.
- Default branch: `main`
- Branch protection: `main` is protected.
- Branch protection policy: `enforce_admins=true`, `required_linear_history=true`,
  `allow_force_pushes=false`, `allow_deletions=false`,
  `required_conversation_resolution=true`.

## GitHub Environment

- Environment: `staging`
- Required reviewer: `xorrbss`
- Deployment branch policy: `protected_branches=true`,
  `custom_branch_policies=false`
- Protection rules observed: `required_reviewers`, `branch_policy`
- Approval self-review prevention: `prevent_self_review=false`

## Approval Evidence

- Workflow: `Staging Approval Gate`
- Workflow URL:
  `https://github.com/xorrbss/rpa-platform-deploy/actions/runs/28237204757`
- Event: `workflow_dispatch`
- Head branch: `main`
- Head SHA: `5bc8822e9b82ca7670e3a733f1d0f0d92b3f5eea`
- Created: `2026-06-26T12:11:56Z`
- Completed: `2026-06-26T12:12:15Z`
- Conclusion: `success`
- Deployment id: `5209830863`
- Deployment environment: `staging`
- Deployment status: `success`

The workflow passed through the `staging` Environment approval boundary. The
approval comment used only aliases and did not include secret material.

## Deploy Target Evidence

- Target alias: `[deploy-target-gh-actions-staging-1]`
- Target document:
  `https://github.com/xorrbss/rpa-platform-deploy/blob/main/deploy-targets/staging.md`
- Concrete target recorded: GitHub Actions workflow
  `.github/workflows/staging-approval.yml`, job `approval`, environment
  `staging`.

This is the owner-ratified concrete staging deployment target for this release.
A managed application/container runtime target is not claimed by this evidence.

## Rollback Evidence

- Rollback alias: `[rollback-plan-1]`
- Rollback document:
  `https://github.com/xorrbss/rpa-platform-deploy/blob/main/rollback/staging-rollback.md`
- Rule: `forward-only(D7-4) + prior-image redeploy`
- Owner: `#13`

## Provisioning Evidence

- Provisioning alias: `[secretref-inventory-1]`
- SecretStore alias: `[vault-staging-1]`
- Provisioning document:
  `https://github.com/xorrbss/rpa-platform-deploy/blob/main/provisioning/staging-secretrefs.md`
- SecretStore shape: Vault KV v2, mount `secret/`, base
  `secret/data/rpa/staging/<runtime>/<purpose>/<name>`
- Inventory type: identifier-only D8-A12 SecretRef and identity map aliases.

No plaintext role id, secret id, Vault token, cloud key, provider key, raw model
identifier, object reference, env dump, or xtrace output was added.

## Row 43 Closure Packet

Artifact-store topology evidence after the S3 producer wiring change:

- Preflight alias: `[preflight-s3-1]`
- Command: `npm --prefix app run preflight:artifact-store -- --topology split-worker-lifecycle`
- Environment shape: `RPA_ENV=staging`, `GATEWAY_ARTIFACT_STORE_MODE=s3`,
  producer SecretRef `GATEWAY_ARTIFACT_OBJECT_STORE_REF`, lifecycle SecretRef
  `ARTIFACT_OBJECT_STORE_REF`, and matching S3 endpoint/region/bucket/path-style.
- Result: `PASS`.

[STAGING RELEASE PACKET -- redacted]
- staging platform repo            : xorrbss/rpa-platform-deploy
- concrete deploy target           : owner-ratified GitHub Actions Environment gate [deploy-target-gh-actions-staging-1], deployment id 5209830863; no managed app/container target claimed
- GitHub Environment `staging`      : protection=on, required reviewer=xorrbss, branch policy=protected-main-only
- release approval reference        : https://github.com/xorrbss/rpa-platform-deploy/actions/runs/28237204757
- rollback confirmation             : forward-only(D7-4) + prior-image redeploy; owner=#13; evidence=[rollback-plan-1]
- SecretStore alias/path            : Vault KV v2 mount `secret/`, base secret/data/rpa/staging/<runtime>/<purpose>/<name>; backend alias=[vault-staging-1]; values omitted
- namespace / identity map          : D8-A12 runtime identity map aliases [api-1], [runtime-worker-1], [browser-worker-1], [artifact-lifecycle-1], [llm-gateway-1]; object_store producer/lifecycle identities separated
- SecretRef inventory               : D8-A12 identifier-only inventory [secretref-inventory-1]; no resolved material
- runtime artifact object-store env : `GATEWAY_ARTIFACT_STORE_MODE=s3`; `GATEWAY_ARTIFACT_OBJECT_STORE_REF=rpa/staging/runtime-worker/object_store/s3-producer`; `ARTIFACT_OBJECT_STORE_REF=rpa/staging/artifact-lifecycle/object_store/s3`; backend alias=[s3-staging-1]
- artifact store topology preflight  : run `npm --prefix app run preflight:artifact-store -- --topology split-worker-lifecycle`; PASS [preflight-s3-1]
- retention policy                  : D8-A11/D8-A14 and ops-defaults section 6.1; evidence=[staging-retention-1]
- live D5 evidence                  : row 50 packet aliases [codex-staging-1]/[model-a]
- secret.resolve audit sample       : seq#1/hash#allow, seq#2/hash#deny, no material
- negative control proof            : secret-scan rejects GitHub `secrets` context, environment: staging binding, env dump commands, and xtrace; no plaintext material in packet
[forbidden: plaintext credentials omitted]
