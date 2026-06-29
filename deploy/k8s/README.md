# RPA Kubernetes Packaging

This directory provides reviewable Kubernetes packaging for the enterprise RPA runtime.
It is intentionally separate from local `compose.yaml`.

## Scope

- `base/` is a plain Kubernetes manifest set for a pilot or staging namespace.
- `../helm/rpa/` is the Helm chart surface for platform-owned promotion.
- DB role bootstrap is not included in-cluster. Apply `db/roles.sql` and inject
  LOGIN passwords through the platform/DBA path before running the migration Job.
- API and worker pods use `rpa_app`; migration uses `rpa_migrator`; lifecycle
  and maintenance discovery use dedicated BYPASSRLS DSNs only through Secret refs.

## Local Review

```powershell
npm --prefix codegen run k8s:static-smoke
```

Optional cluster-side dry run after secrets/config are supplied by the platform:

```powershell
kubectl apply --dry-run=server -f deploy/k8s/base
```

## Promotion Boundary

This package is Kubernetes packaging evidence, not production approval. Controlled
production still requires platform-selected namespace/ingress, managed PostgreSQL,
PITR or managed-backup restore drill evidence, object storage, on-call/RACI,
SLO dashboards, and explicit deployment approval.

## Controlled-Prod Packaging Guards

- API pods have a PDB, HPA, hard hostname anti-affinity, and topology spread
  constraints. Worker pods stay single-replica by default until unique worker ID
  allocation is modeled.
- `base/30-policies.yaml` denies runtime egress by default and allows DNS only.
  Apply `base/32-egress-owner-allowlist.optional.yaml` only after replacing every
  `OWNER_DECISION_REQUIRED_*_CIDR` with platform-approved destination CIDRs and
  ports for managed PostgreSQL, Vault, object storage, OTLP, and LLM providers.
- `base/40-ingress.optional.yaml` is intentionally not in `kustomization.yaml`.
  Add it only after the platform owner supplies ingress class, host, TLS secret,
  and matching NetworkPolicy source approval.
