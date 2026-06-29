# Controlled-Prod Packaging Gap Notes

This note records repository-local Kubernetes/Helm packaging evidence for the
controlled-prod gap without turning unresolved owner decisions into success.

## Implemented Packaging Evidence

- Base Kubernetes now includes API HPA, PDB, hard hostname anti-affinity,
  topology spread constraints, and default-deny egress with DNS-only allowance.
- Base ingress and owner-approved external egress are optional templates. They
  retain `OWNER_DECISION_REQUIRED_*` placeholders and are not included in the
  base `kustomization.yaml`.
- Helm values expose matching ingress, autoscaling, scheduling, and
  NetworkPolicy options. `ingress.enabled=false` by default, and enabling ingress
  without class, host, and TLS secret fails template rendering.
- Helm egress allowlists default to empty. Owner-approved CIDRs must be explicit,
  and `0.0.0.0/0` or `::/0` are rejected by the template.

## Still Owner Decisions

- Actual ingress host, TLS certificate/secret, ingress controller, and approved
  source namespace or policy.
- Managed PostgreSQL, Vault, object storage, OTLP collector, and LLM provider
  egress destinations. Standard Kubernetes NetworkPolicy is CIDR/selector based;
  FQDN egress requires a platform/CNI-specific approved policy.
- Production collector, dashboard, alert route, on-call/SLO evidence, and
  RPO/RTO/PITR restore-drill evidence. The packaging does not synthesize those
  as production-open evidence.
