# RPA Gap Remediation Draft Review

Date: 2026-06-27
Source: internal adoption evaluation report, "사내 개발 솔루션 vs 시장 검토 솔루션"
Status: superseded implementation draft. Use `docs/rpa-adoption-full-design-2026-06-29.md`, `docs/rpa-adoption-90plus-design-2026-06-29.md`, and `docs/current-readiness-report.md` as current evidence. The original P0 draft candidates below have since been implemented and verified for PR0/pilot evidence unless marked production-open.

Implementation evidence update (2026-06-29):
- Packaging now has root `Dockerfile`, `.dockerignore`, `compose.yaml`, and `deploy/docker.env.example` with DB role split.
- Kubernetes packaging now has `deploy/k8s/base`, `deploy/helm/rpa`, and `npm --prefix codegen run k8s:static-smoke` as static packaging evidence.
- Migration evidence now uses `scripts/db-migrate.mjs`, `schema_migrations`, deep baseline verification, non-bypass smoke, and `npm --prefix codegen run db:restore-drill:temp`.
- Maintenance discovery and worker heartbeat are implemented with focused unit tests and readiness documentation.
- Production HA/DR/failover, owner-controlled PITR/SLO/on-call evidence, platform namespace/ingress approval, and external deployment approval remain production-open.

## Executive Summary

The report scores this platform at 57.6/100: strong in security, tenant isolation, RBAC, audit discipline, HITL, and contract-first validation, but weak in turnkey packaging, broad integrations, ecosystem maturity, external operations delivery, and some advertised AI breadth.

This draft does not try to inflate the score with spec-only promises. It sketches three concrete P0 gap candidates that are directly implementable from the current codebase:

1. Container packaging for API, worker, lifecycle worker, PostgreSQL bootstrap, and local artifact storage.
2. Maintenance tenant auto-discovery when `MAINTENANCE_TENANT_IDS` is empty.
3. Worker self-registration and heartbeat so Bot Pool capacity does not depend on manual worker seed rows.

These candidates were reviewed against `docs/rpa-adoption-full-design-2026-06-29.md` before adoption. The current Compose path uses the repo-local versioned migration runner instead of the original raw SQL-only bootstrap.

## Gap Reassessment

| Report gap | Current status | Action |
|---|---|---|
| Packaging absent: no Dockerfile/Compose/k8s/Helm | Closed for PR0/pilot Docker/Compose and Kubernetes/Helm packaging evidence; production deployment approval remains open | Root `Dockerfile`, `.dockerignore`, `compose.yaml`, `deploy/docker.env.example`, `deploy/k8s/base`, `deploy/helm/rpa`, static smoke |
| Sweeper dormant unless tenant ids are manually configured | Closed for PR0/pilot with guarded lifecycle BYPASSRLS discovery | `maintenance-scheduler`, lifecycle bypass config, focused unit tests |
| Worker self-registration/heartbeat absent | Closed for runtime worker and artifact lifecycle worker startup paths | worker heartbeat policy, startup dependency ordering, focused unit tests |
| External alert delivery absent | Intentionally future-only in current contract | No fake delivery. Keep console-only until SecretRef-backed route/channel policy is opened |
| Credential lease policy exists but dispatch path must enforce it | Existing runtime has browser lease path and credential policy surfaces; separate dispatch enforcement audit still required | Track as P0 runtime dispatch enforcement |
| Versioned migration framework absent | Closed for repo-local PR0/pilot runner; managed migration tooling remains optional future replacement | `scripts/db-migrate.mjs`, deep baseline verifier, Graphile worker flag, non-bypass smoke, restore drill |
| Desktop/SAP/Citrix/Office/IDP/OCR absent | True product-scope gap | Strategic P1/P2, not a small patch |
| VLM and challenge auto-resolution advertised but unavailable | True by design: unsupported capabilities fail loud | Keep explicit unsupported behavior until actual executor exists |

## Draft Implementation Notes

### Container packaging

- `Dockerfile` builds one runtime image for `RUN_MODE=api|worker|lifecycle-worker|all`.
- The image installs Chromium and sets `CHROME_EXECUTABLE_PATH=/usr/bin/chromium` for the browser worker path.
- The image runs TypeScript through the existing `npm --prefix app run start` surface, preserving the current package architecture instead of introducing a new build artifact contract.
- `compose.yaml` starts PostgreSQL 15, a one-shot raw SQL bootstrap in the required order, and the API service.
- `--profile worker` starts worker and lifecycle-worker services using the same image.

This original draft is superseded. The current compose migrator uses `scripts/db-migrate.mjs` with a `schema_migrations` ledger, checksum drift detection, fresh install, existing DB baseline support, Graphile worker migration support, and non-bypass release smoke.

### Maintenance tenant auto-discovery

When `MAINTENANCE_TENANT_IDS` is empty, `maintenance-scheduler` now discovers tenants with due operational work:

- `browser_leases.state IN ('reserved','active') AND expires_at < now`
- `credential_leases.status='active' AND locked_until < now`
- expiring `human_tasks`
- expired `workitems.checkout_expires_at`
- pending, unclaimed artifact redaction rows

If `MAINTENANCE_TENANT_IDS` is provided, it remains authoritative. That preserves controlled staging deployments while making default deployments recover from stale leases and timeouts.

### Worker self-registration and heartbeat

Runtime workers in the draft upsert their own `workers` row at startup and refresh `heartbeat_at` every 30 seconds:

- control/browser worker uses `kind='browser'`
- artifact lifecycle worker uses `kind='sweeper'`

This is the desired direction for Bot Pool live capacity. Before adoption, startup failure paths after heartbeat creation must stop the timer and avoid reporting fake liveness.

## Remaining Strategic Work

- External notification delivery follows the v0.2 design split: Product Open v1 remains console-only; P0-adoption may add a SecretRef-backed webhook sender with `sent` evidence only.
- Production HA/DR/failover, owner-controlled PITR/SLO/on-call evidence, platform namespace/ingress approval, and external deployment approval remain outside the PR0/pilot evidence now implemented.
- Desktop/SAP/Citrix/Office automation remains out of P0 scope.
- OCR/IDP and VLM execution need concrete executor contracts, evidence schemas, and HITL fallback rules before being scored as implemented.

## Verification Targets

- `npm --prefix app run typecheck`
- `npm --prefix app exec -- tsx test/maintenance-scheduler.unit.ts`
- `npm --prefix app exec -- tsx test/worker-heartbeat.unit.ts`
- `npm --prefix codegen run db:restore-drill:temp`
- `npm --prefix codegen run k8s:static-smoke`
- `docker compose config`
- Optional local smoke: `docker compose up --build api`
