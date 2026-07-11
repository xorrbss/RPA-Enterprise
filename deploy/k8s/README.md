# RPA Kubernetes Packaging

This directory provides reviewable Kubernetes packaging for the enterprise RPA runtime.
It is intentionally separate from local `compose.yaml`.

## Scope

- `base/` is a fail-closed template for review and static smoke evidence. It is
  not a release artifact until an overlay supplies an approved immutable image
  digest, owner-approved egress, and environment-owned Secret refs.
- `overlays/staging-sample/` is a sample overlay showing the apply-time shape
  for staging without claiming real infrastructure. Its documentation CIDRs and
  sample image digest must be replaced in a platform-owned deployment repo only
  after owner approval.
- `../helm/rpa/` is the Helm chart surface for platform-owned promotion.
- The console is packaged as a separate nginx/static workload. Ingress should
  route to `rpa-console`; nginx keeps the browser same-origin and forwards
  `/api/*` to the API service after stripping `/api`, so `/api/v1/...` reaches
  the upstream as `/v1/...`.
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

Sample overlay review after owner decisions are supplied in a platform-owned
copy:

```powershell
kubectl kustomize deploy/k8s/overlays/staging-sample
```

The sample overlay remains non-release evidence in this repository. Before any
real apply, the owner must approve the runtime image repository and immutable
sha256 digest, verify SBOM/provenance/signing evidence, replace documentation
CIDRs with owner-approved destination CIDRs, and provision the SecretStore-backed
runtime Secret without plaintext material.

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
  Apply `optional/owner-approved-egress/` (its own kustomization directory; the
  sample overlay references it) only after replacing every
  `OWNER_DECISION_REQUIRED_*_CIDR` with owner-approved destination CIDRs and
  ports for managed PostgreSQL, Vault, object storage, OTLP, and LLM providers.
- Runtime images must be promoted by immutable sha256 digest, not mutable tags.
  Keep SBOM, provenance, and signing verification evidence with the release
  packet before applying either the Kustomize overlay or Helm release values.
- `base/40-ingress.optional.yaml` is intentionally not in `kustomization.yaml`.
  Add it only after the platform owner supplies ingress class, host, TLS secret,
  and matching NetworkPolicy source approval.
