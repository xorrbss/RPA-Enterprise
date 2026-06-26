# Staging Release Packet Template

This is the owner-facing row 43 packet template for the remaining deploy-time
blocker. It documents the exact shape enforced by
`scripts/validate-staging-release-packet.mjs`.

This repository must not invent staging or production facts. The owner must
replace each bracketed alias with an owner-controlled redacted alias that points
to real external evidence. The validator checks packet shape and redaction
safety only; it does not prove that an alias corresponds to real
infrastructure.

## Validator Contract

The validator reads only a block beginning with:

```text
[STAGING RELEASE PACKET -- redacted]
```

Inside that block, every field must be a single Markdown list item in this
exact form:

```text
- exact field label : value
```

The validator rejects missing fields, duplicate labels, malformed list items,
blank values, and unresolved angle-bracket placeholders. Bracketed aliases are
the only placeholder style allowed for redacted external evidence.

Required field labels:

1. `staging platform repo`
2. `concrete deploy target`
3. ``GitHub Environment `staging```
4. `release approval reference`
5. `rollback confirmation`
6. `SecretStore alias/path`
7. `namespace / identity map`
8. `SecretRef inventory`
9. `runtime artifact object-store env`
10. `artifact store topology preflight`
11. `retention policy`
12. `live D5 evidence`
13. `secret.resolve audit sample`
14. `negative control proof`

Additional required substrings:

- ``GitHub Environment `staging``` must include `protection=`, `required reviewer=`, and `branch policy=`.
- `rollback confirmation` must include `forward-only` and `owner=#13`.
- `SecretStore alias/path` must include `Vault`, `KV v2`, `secret/`, and `secret/data/rpa/staging`.
- `namespace / identity map` and `SecretRef inventory` must each include `D8-A12`.
- `runtime artifact object-store env` must include `ARTIFACT_OBJECT_STORE_REF=`.
- `artifact store topology preflight` must include the exact command `npm --prefix app run preflight:artifact-store -- --topology split-worker-lifecycle` and `PASS`.
- `retention policy` must include `D8-A11` and `D8-A14`.
- `live D5 evidence` must include `row 50` and at least two bracketed aliases.
- `secret.resolve audit sample` must include `seq` and `hash`, and must not include resolved material markers.
- `negative control proof` must mention `secret-scan`, GitHub `secrets`, `environment: staging`, `env dump`, and `xtrace`.

## Redaction Rules

Use bracket aliases such as `[platform-repo-1]`, `[deploy-target-1]`,
`[staging-pg-1]`, `[s3-staging-1]`, `[codex-staging-1]`, and `[model-a]`.
Aliases should be stable within the release packet and traceable by the owner
outside this repository.

Do not include plaintext secret values, bearer/API keys, AppRole material,
Vault tokens, cloud access key IDs, resolved `SecretRef` material, internal
artifact object references, raw model identifiers, env dumps, shell xtrace
output, provider error bodies containing credentials, real hosts, or IP
addresses.

If the packet uses an approval or evidence URL, the URL must be HTTPS and must
not include username/password, query string, or fragment. A redacted deployment
ID alias is safer when the URL would reveal a host.

## Packet Skeleton

Copy this shape into an owner-controlled packet file and replace every alias
with a redacted alias sourced from real staging evidence. Do not claim row 43
closure from this skeleton alone.

```text
[STAGING RELEASE PACKET -- redacted]
- staging platform repo            : [platform-repo-1]
- concrete deploy target           : [deploy-target-1]
- GitHub Environment `staging`      : protection=on, required reviewer=[owner-approval-1], branch policy=[protected-main-1]
- release approval reference        : [approval-run-1]
- rollback confirmation             : forward-only(D7-4) + prior-image redeploy; owner=#13; evidence=[rollback-plan-1]
- SecretStore alias/path            : Vault KV v2 mount `secret/`, base `secret/data/rpa/staging/runtime-worker/resume_token_hmac/active` pattern; backend alias=[vault-staging-1]; values omitted
- namespace / identity map          : D8-A12 runtime identity map bound to [runtime-worker-1], [browser-worker-1], [artifact-lifecycle-1], [llm-gateway-1]
- SecretRef inventory               : D8-A12 identifier-only inventory [secretref-inventory-1]; no resolved material
- runtime artifact object-store env : `ARTIFACT_OBJECT_STORE_REF=rpa/staging/artifact-lifecycle/object_store/s3`; backend alias=[s3-staging-1]
- artifact store topology preflight  : run `npm --prefix app run preflight:artifact-store -- --topology split-worker-lifecycle`; PASS; evidence=[preflight-log-1]
- retention policy                  : D8-A11/D8-A14 and ops-defaults section 6.1; DB alias=[staging-pg-1]
- live D5 evidence                  : row 50 packet aliases [codex-staging-1]/[model-a]; evidence=[d5-live-run-1]
- secret.resolve audit sample       : seq#1/hash#[audit-hash-1], no material
- negative control proof            : secret-scan rejects GitHub `secrets` context, environment: staging binding, env dump commands, and xtrace; evidence=[negative-control-1]
```

## Validation Commands

Run these before attaching the packet to the release report:

```powershell
npm --prefix codegen run release-packet:fixtures
npm --prefix codegen run release-packet:validate -- --file [owner-packet-file]
git diff --check
npm --prefix codegen run blocked:audit
```

The owner also needs deploy-environment evidence for the topology preflight:

```powershell
npm --prefix app run preflight:artifact-store -- --topology split-worker-lifecycle
```

## Owner Fill-In Checklist

- Map `[platform-repo-1]` to the real platform or deploy repository outside this contract repository.
- Map `[deploy-target-1]` to the real managed-container namespace/service or equivalent deploy target.
- Map `[owner-approval-1]`, `[approval-run-1]`, and `[rollback-plan-1]` to owner approval and rollback evidence.
- Map `[vault-staging-1]` and the SecretStore path pattern to the real Vault KV v2 staging mount/path without resolved values.
- Map `[secretref-inventory-1]` to the identifier-only SecretRef inventory.
- Map `[s3-staging-1]` to the real object-store backend alias and keep credentials behind SecretRef.
- Map `[staging-pg-1]` to the staging PostgreSQL evidence alias without host or IP.
- Map `[codex-staging-1]` and `[model-a]` to row 50 D5 live evidence aliases.
- Map `[preflight-log-1]`, `[d5-live-run-1]`, and `[negative-control-1]` to redacted artifact/log references.
