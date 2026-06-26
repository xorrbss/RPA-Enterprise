# Staging Release Packet Draft - 2026-06-27

This draft is assembled from the validator contract in
`docs/staging-release-packet-template.md`, the current checklist state in
`release-open-checklist.md`, and the latest merged gate references available in
the repository.

It is ready for final owner fill-in of redacted deploy-time provisioning
aliases. The checklist currently records 19 blocked-decision markers, 0
actionable blockers, and 0 active deploy-time provisioning checklist rows. The
remaining owner work for this packet is alias custody: confirm that each
bracketed alias below maps to owner-controlled external evidence without adding
secret values, resolved material, env dumps, shell xtrace, internal object refs,
or raw model identifiers.

## Evidence Basis

- Source gate closure commit: `15fa27fc` (`Phase 8: staging S3 artifact producer gate closure`).
- Latest merged repo-controlled product-code gate recorded in the checklist:
  `Contract Gates` run `28234600652` on commit
  `b7bd95102c3043316808a2020466c975797d6094`.
- Required job references from that gate:
  `secret-scan` `https://github.com/xorrbss/RPA-Enterprise/actions/runs/28234600652/job/83646278480`,
  `PostgreSQL 15 migration smoke` `https://github.com/xorrbss/RPA-Enterprise/actions/runs/28234600652/job/83646278494`,
  `Operations console (web) typecheck, tests, build` `https://github.com/xorrbss/RPA-Enterprise/actions/runs/28234600652/job/83646278434`,
  and `App runtime typecheck and tests` `https://github.com/xorrbss/RPA-Enterprise/actions/runs/28234600652/job/83646278406`.
- Row 43 governance evidence source:
  `docs/staging-github-governance-evidence-2026-06-26.md`.
- Concrete row 43 boundary: owner-ratified GitHub Actions Environment gate only;
  no managed application/container staging runtime is claimed by this packet.
- S3 producer/lifecycle closure: `GATEWAY_ARTIFACT_STORE_MODE=s3`,
  producer `GATEWAY_ARTIFACT_OBJECT_STORE_REF`, lifecycle
  `ARTIFACT_OBJECT_STORE_REF`, and split-worker-lifecycle topology preflight
  `PASS` under alias `[preflight-s3-1]`.

## Draft Packet

```text
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
- artifact store topology preflight  : run `npm --prefix app run preflight:artifact-store -- --topology split-worker-lifecycle`; PASS; evidence=[preflight-s3-1]
- retention policy                  : D8-A11/D8-A14 and ops-defaults section 6.1; DB alias=[staging-pg-1]; evidence=[staging-retention-1]
- live D5 evidence                  : row 50 packet aliases [codex-staging-1]/[model-a]; mandatory #1/#2/#4 PASS, #3 PASS, #5 metadata GAP fallback retained; evidence=[d5-live-run-1]
- secret.resolve audit sample       : seq#1/hash#[secret-resolve-allow-hash-1], seq#2/hash#[secret-resolve-deny-hash-1], no material
- negative control proof            : secret-scan rejects GitHub `secrets` context, environment: staging binding, env dump commands, and xtrace; latest gate job=https://github.com/xorrbss/RPA-Enterprise/actions/runs/28234600652/job/83646278480; evidence=[negative-control-1]
```

## Owner Fill-In Map

Confirm or replace only these bracketed aliases with owner-controlled redacted
evidence references:

- `[deploy-target-gh-actions-staging-1]`
- `[rollback-plan-1]`
- `[vault-staging-1]`
- `[api-1]`, `[runtime-worker-1]`, `[browser-worker-1]`,
  `[artifact-lifecycle-1]`, `[llm-gateway-1]`
- `[secretref-inventory-1]`
- `[s3-staging-1]`
- `[preflight-s3-1]`
- `[staging-pg-1]`, `[staging-retention-1]`
- `[codex-staging-1]`, `[model-a]`, `[d5-live-run-1]`
- `[secret-resolve-allow-hash-1]`, `[secret-resolve-deny-hash-1]`
- `[negative-control-1]`

## Validation

Run before attaching the owner-final packet:

```powershell
npm --prefix codegen run release-packet:fixtures
npm --prefix codegen run release-packet:validate -- --file ../docs/staging-release-packet-draft-2026-06-27.md
npm --prefix codegen run blocked:audit
git diff --check
```
