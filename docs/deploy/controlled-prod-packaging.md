# Controlled-Prod Packaging Gap Notes

This note records repository-local Kubernetes/Helm packaging evidence for the
controlled-prod gap without turning unresolved owner decisions into success.

## Implemented Packaging Evidence

- Base Kubernetes now includes API HPA, PDB, hard hostname anti-affinity,
  topology spread constraints, and default-deny egress with DNS-only allowance.
- The K8s `base/` directory is a fail-closed template, not a release artifact.
  `deploy/k8s/overlays/staging-sample/` shows the apply-time shape with
  documentation-only CIDRs and a sample digest so platform owners can copy the
  structure without treating repository-local values as approved infrastructure.
- Base ingress and owner-approved external egress are optional templates. They
  retain `OWNER_DECISION_REQUIRED_*` placeholders and are not included in the
  base `kustomization.yaml`.
- Helm values expose matching ingress, autoscaling, scheduling, and
  NetworkPolicy options. `ingress.enabled=false` by default, and enabling ingress
  without class, host, and TLS secret fails template rendering.
- Helm default values intentionally omit the image repository, tag, and digest.
  `deploy/helm/rpa/values.release.example.yaml` is sample evidence only; real
  release values must set `image.repository` plus an immutable sha256 digest
  from the approved release artifact.
- Helm egress allowlists default to empty. Owner-approved CIDRs must be explicit,
  and `0.0.0.0/0` or `::/0` are rejected by the template.
- K8s and Helm promotion require SBOM, provenance, and signing evidence for the
  runtime image before the digest is accepted into a platform-owned overlay or
  values file.

## Still Owner Decisions

- Actual ingress host, TLS certificate/secret, ingress controller, and approved
  source namespace or policy.
- Managed PostgreSQL, Vault, object storage, OTLP collector, and LLM provider
  egress destinations. Owner-approved CIDRs and ports are required before
  anything beyond DNS egress is opened. Standard Kubernetes NetworkPolicy is
  CIDR/selector based; FQDN egress requires a platform/CNI-specific approved
  policy.
- Release artifact identity: immutable image digest, SBOM/provenance references,
  signing verification evidence, and the repository/registry that owns the
  promoted artifact.
- Production collector, dashboard, alert route, on-call/SLO evidence, and
  RPO/RTO/PITR restore-drill evidence. The packaging does not synthesize those
  as production-open evidence.
