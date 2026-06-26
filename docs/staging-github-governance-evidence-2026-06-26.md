# Staging GitHub Governance Evidence - 2026-06-26

This document records the external GitHub governance work completed for row 43.
It is evidence for the GitHub Environment, approval, rollback-plan, and
identifier-only provisioning portions only. It is not a full row 43 closure
packet.

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

This is a governance/approval target. A managed application/container staging
target is still not provisioned by this evidence.

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

## Not Yet Row 43 Closure

Do not flip row 43 to closed from this document alone. The following evidence is
still required before a full redacted staging release packet can be attached:

- A managed application/container staging deploy target, or an owner-ratified
  statement that the GitHub Actions environment gate is the concrete staging
  deployment target for this release.
- Final deploy-environment `npm --prefix app run preflight:artifact-store --
  --topology split-worker-lifecycle` PASS evidence. The local pilot remains
  separate because `RPA_ENV=staging` rejects `local_fs`.
- Actual Vault/SecretStore provisioning proof behind the aliases, without
  resolved secret values.
- Live row 50 D5 evidence aliases for the release packet, if the previous
  row 50 aliases are not owner-ratified for this staging approval run.
- A validator-passing `[STAGING RELEASE PACKET -- redacted]` block assembled
  from real external evidence.
