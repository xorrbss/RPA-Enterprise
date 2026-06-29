import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import { readAiGovernanceReadiness, type AiGovernanceReadinessSnapshot } from "./ai-governance-enforcement";
import { DEFAULT_AUTH_READINESS_CONFIG, evaluateAuthSsoReadiness } from "./auth-readiness";
import { readBrowserBotPool } from "./bot-pools";
import { runIdempotentCommand, isRecord } from "./command";
import { ApiResponseError } from "./errors";
import { parseLimit } from "./list-query";
import { readOpsHealth } from "./ops-health";
import { readLatestOpsNotificationDelivery, type OpsNotificationDelivery } from "./ops-alerts";
import { requirePrincipal, type ApiServerDeps, type AuthReadinessConfig } from "./server-shared";

export type ProductionReadinessStatus = "ready" | "warning" | "blocked";
export type ProductionReadinessGateStatus = "pass" | "warning" | "blocked" | "deferred";
export type ProductionReadinessEvidenceType =
  | "external_alert_delivery"
  | "managed_backup_restore_drill"
  | "slo_oncall_signoff"
  | "observability_telemetry_wiring"
  | "support_training_completion";
export type ProductionReadinessEvidenceStatus = "valid" | "failed";

export interface ProductionReadinessConfig {
  readonly authReadiness?: AuthReadinessConfig;
  readonly aiGovernanceConfiguredModels?: readonly string[];
  readonly aiGovernanceConfiguredPromptVersions?: readonly string[];
}

interface ProductionReadinessGate {
  readonly gate_id: string;
  readonly label: string;
  readonly status: ProductionReadinessGateStatus;
  readonly reason_code: string | null;
  readonly detail: string;
  readonly evidence: readonly string[];
  readonly required_action: string | null;
}

interface AuditVerifierEvidence {
  readonly audit_count: number;
  readonly latest_run_id: string | null;
  readonly latest_status: "valid" | "invalid" | "failed" | null;
  readonly latest_completed_at: string | null;
  readonly rows_checked: number | null;
  readonly violation_count: number | null;
  readonly stale: boolean;
}

interface MigrationEvidence {
  readonly available: boolean;
  readonly applied_versions: readonly string[];
  readonly missing_versions: readonly string[];
}

interface ProductionReadinessEvidence {
  readonly evidence_id: string;
  readonly evidence_type: ProductionReadinessEvidenceType;
  readonly status: ProductionReadinessEvidenceStatus;
  readonly evidence_at: string;
  readonly expires_at: string | null;
  readonly summary: string;
  readonly evidence_ref: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly recorded_by: string;
  readonly recorded_at: string;
  readonly legal_hold: boolean;
}

interface ProductionReadinessEvidenceRow {
  readonly id: string;
  readonly evidence_type: ProductionReadinessEvidenceType;
  readonly status: ProductionReadinessEvidenceStatus;
  readonly evidence_at: Date;
  readonly expires_at: Date | null;
  readonly summary: string;
  readonly evidence_ref: string | null;
  readonly metadata: unknown;
  readonly recorded_by: string;
  readonly recorded_at: Date;
  readonly legal_hold: boolean;
}

interface ProductionReadinessEvidenceInput {
  readonly evidenceType: ProductionReadinessEvidenceType;
  readonly status: ProductionReadinessEvidenceStatus;
  readonly evidenceAt: Date;
  readonly expiresAt: Date | null;
  readonly summary: string;
  readonly evidenceRef: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly legalHold: boolean;
}

const REQUIRED_SCHEMA_MIGRATION_VERSIONS = ["0001", "0002"] as const;
const AUDIT_VERIFIER_FRESHNESS_MINUTES = 75;
const EXTERNAL_ALERT_DELIVERY_FRESHNESS_DAYS = 90;
const CONTROLLED_PROD_RESTORE_RTO_MINUTES = 120;
const CONTROLLED_PROD_RESTORE_RPO_MINUTES = 15;
const OWNER_EVIDENCE_TYPES: readonly ProductionReadinessEvidenceType[] = [
  "external_alert_delivery",
  "managed_backup_restore_drill",
  "slo_oncall_signoff",
  "observability_telemetry_wiring",
  "support_training_completion",
];
const OWNER_EVIDENCE_RETENTION_DAYS = 365;

export function registerProductionReadinessRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/ops/production-readiness", { config: { rbacAction: "ops_alert.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const readiness = await withTenantTx(deps.pool, principal.tenantId, async (client) =>
      readProductionReadiness(client, principal.tenantId, {
        authReadiness: deps.authReadiness,
        aiGovernanceConfiguredModels: deps.aiGovernanceConfiguredModels,
        aiGovernanceConfiguredPromptVersions: deps.aiGovernanceConfiguredPromptVersions,
      }),
    );
    reply.code(200).send(readiness);
  });

  app.get("/v1/ops/production-readiness/evidence", { config: { rbacAction: "ops_alert.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const evidenceType = parseEvidenceTypeQuery(query.evidence_type);
    const limit = parseLimit(query.limit);
    const items = await withTenantTx(deps.pool, principal.tenantId, (client) =>
      readProductionReadinessEvidence(client, principal.tenantId, evidenceType, limit),
    );
    reply.code(200).send({ items, next_cursor: null });
  });

  app.post("/v1/ops/production-readiness/evidence", { config: { rbacAction: "ops_readiness.manage" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseEvidenceRequest(request.body);
    const response = await runIdempotentCommand(
      deps,
      request,
      "recordProductionReadinessEvidence",
      "/v1/ops/production-readiness/evidence",
      async (client, tenantId) => {
        const item = await insertProductionReadinessEvidence(client, tenantId, principal.subjectId, body);
        return { status: 201, body: item };
      },
    );
    reply.code(response.status).send(response.body);
  });
}

export async function readProductionReadiness(
  client: PoolClient,
  tenantId: string,
  config: ProductionReadinessConfig = {},
) {
  const health = await readOpsHealth(client, tenantId);
  const botPool = await readBrowserBotPool(client, tenantId);
  const audit = await readAuditVerifierEvidence(client, tenantId);
  const migrations = await readMigrationEvidence(client);
  const ownerEvidence = await readLatestOwnerEvidence(client, tenantId);
  const externalDelivery = await readLatestOpsNotificationDelivery(client, tenantId);
  const aiGovernance = await readAiGovernanceReadiness(client, tenantId, {
    configuredModels: config.aiGovernanceConfiguredModels,
    configuredPromptVersions: config.aiGovernanceConfiguredPromptVersions,
  });
  const gates: ProductionReadinessGate[] = [
    authSsoReadinessGate(config.authReadiness),
    aiGovernanceRuntimeGate(aiGovernance),
    migrationGate(migrations),
    graphileQueueGate(health.queue),
    browserPoolHaGate(botPool),
    browserLeaseGate(health.browser_leases.expired_open),
    staleRunGate(health.stale_runs.nonterminal_over_15m, health.stale_runs.oldest_updated_at),
    auditVerifierGate(audit),
    externalAlertDeliveryGate(ownerEvidence.external_alert_delivery, externalDelivery),
    managedBackupRestoreDrillGate(ownerEvidence.managed_backup_restore_drill),
    sloOncallSignoffGate(ownerEvidence.slo_oncall_signoff),
    observabilityTelemetryWiringGate(ownerEvidence.observability_telemetry_wiring),
    supportTrainingCompletionGate(ownerEvidence.support_training_completion),
  ];
  const summary = summarize(gates);
  return {
    status: summary.status,
    evaluated_at: new Date().toISOString(),
    environment: {
      target: "controlled_prod",
      tenant_id: tenantId,
    },
    summary,
    gates,
    signals: {
      ops_health: health,
      bot_pool: {
        bot_pool_id: botPool.bot_pool_id,
        capacity_slots: botPool.capacity_slots,
        workers: botPool.workers,
        leases: botPool.leases,
        queue: botPool.queue,
        health: botPool.health,
      },
      audit_verifier: audit,
      ai_governance: aiGovernance.signals,
    },
  };
}

function authSsoReadinessGate(config: AuthReadinessConfig | undefined): ProductionReadinessGate {
  const effectiveConfig = config ?? DEFAULT_AUTH_READINESS_CONFIG;
  const readiness = evaluateAuthSsoReadiness(effectiveConfig);
  const evidence = [
    `provider_mode=${effectiveConfig.mode}`,
    `configuration_source=${effectiveConfig.configurationSource}`,
    `jwks_url_configured=${readiness.jwksConfigured}`,
    `jwks_host=${readiness.jwksHost ?? "none"}`,
    `issuer_configured=${readiness.issuerConfigured}`,
    `audience_configured=${readiness.audienceConfigured}`,
  ];

  if (readiness.enterpriseSsoReady) {
    return gate(
      "auth_sso_readiness",
      "Auth/SSO readiness",
      "pass",
      null,
      "JWT verification uses RS256/JWKS with issuer and audience checks configured.",
      evidence,
      null,
    );
  }

  const missing = [
    effectiveConfig.mode !== "jwks" ? "jwks_mode" : null,
    !readiness.jwksConfigured ? "jwks_url" : null,
    !readiness.issuerConfigured ? "issuer" : null,
    !readiness.audienceConfigured ? "audience" : null,
  ].filter((item): item is string => item !== null);

  return gate(
    "auth_sso_readiness",
    "Auth/SSO readiness",
    "blocked",
    authSsoReadinessReason(effectiveConfig, readiness),
    `Controlled production requires enterprise SSO readiness; missing ${missing.join(", ")}.`,
    evidence,
    "Configure RS256/JWKS auth with explicit JWT_ISSUER and JWT_AUDIENCE before controlled production open.",
  );
}

function authSsoReadinessReason(
  config: AuthReadinessConfig,
  readiness: ReturnType<typeof evaluateAuthSsoReadiness>,
): string {
  if (config.mode !== "jwks") return "auth_sso_jwks_required";
  if (!readiness.jwksConfigured) return "auth_sso_jwks_url_missing";
  if (!readiness.issuerConfigured && !readiness.audienceConfigured) return "auth_sso_issuer_audience_missing";
  if (!readiness.issuerConfigured) return "auth_sso_issuer_missing";
  if (!readiness.audienceConfigured) return "auth_sso_audience_missing";
  return "auth_sso_not_ready";
}

function aiGovernanceRuntimeGate(snapshot: AiGovernanceReadinessSnapshot): ProductionReadinessGate {
  return gate(
    "ai_governance_runtime",
    "AI governance runtime",
    snapshot.status,
    snapshot.reasonCode,
    snapshot.detail,
    snapshot.evidence,
    snapshot.requiredAction,
  );
}

function summarize(gates: readonly ProductionReadinessGate[]) {
  const blockerCount = gates.filter((gate) => gate.status === "blocked").length;
  const warningCount = gates.filter((gate) => gate.status === "warning").length;
  const deferredCount = gates.filter((gate) => gate.status === "deferred").length;
  const status: ProductionReadinessStatus = blockerCount > 0
    ? "blocked"
    : warningCount > 0 || deferredCount > 0
      ? "warning"
      : "ready";
  return {
    controlled_prod_ready: status === "ready",
    status,
    blocker_count: blockerCount,
    warning_count: warningCount,
    deferred_count: deferredCount,
  };
}

function migrationGate(evidence: MigrationEvidence): ProductionReadinessGate {
  if (!evidence.available) {
    return gate(
      "database_migrations",
      "Database migrations",
      "blocked",
      "schema_migrations_missing",
      "The schema migration ledger is missing, so the deployment cannot prove its applied contract baseline.",
      ["schema_migrations table not found"],
      "Run the repo migration runner and retain schema_migrations evidence for the deployed database.",
    );
  }
  if (evidence.missing_versions.length > 0) {
    return gate(
      "database_migrations",
      "Database migrations",
      "blocked",
      "schema_migrations_incomplete",
      `Missing required migrations: ${evidence.missing_versions.join(", ")}.`,
      [`applied=${evidence.applied_versions.join(",") || "none"}`],
      "Apply the missing migrations before opening controlled production traffic.",
    );
  }
  return gate(
    "database_migrations",
    "Database migrations",
    "pass",
    null,
    "Required schema migrations are recorded as applied.",
    evidence.applied_versions.map((version) => `schema_migrations:${version}:applied`),
    null,
  );
}

function graphileQueueGate(queue: { readonly available: boolean; readonly pending_jobs: number | null }): ProductionReadinessGate {
  if (!queue.available) {
    return gate(
      "graphile_queue",
      "Graphile queue",
      "blocked",
      "graphile_queue_unavailable",
      "The job queue view is unavailable, so scheduler and worker backlog cannot be proven.",
      ["graphile_worker.jobs unavailable"],
      "Install and migrate the Graphile worker schema for the deployment database.",
    );
  }
  return gate(
    "graphile_queue",
    "Graphile queue",
    "pass",
    null,
    "The job queue view is available for tenant-scoped backlog evidence.",
    [`pending_jobs=${queue.pending_jobs ?? 0}`],
    null,
  );
}

function browserPoolHaGate(botPool: Awaited<ReturnType<typeof readBrowserBotPool>>): ProductionReadinessGate {
  const activeWorkers = botPool.workers.active;
  if (!botPool.capacity.live_capacity.available) {
    return gate(
      "browser_pool_ha",
      "Browser pool HA",
      "blocked",
      botPool.capacity.live_capacity.reason_code ?? "worker_pool_assignment_missing",
      "Tenant traffic is still using implicit default browser capacity rather than an assigned worker pool.",
      [`pool_key=${botPool.capacity.live_capacity.pool_key}`, `active_workers=${activeWorkers}`],
      "Assign the tenant to an explicit worker pool with at least two live browser workers.",
    );
  }
  if (activeWorkers < 2) {
    return gate(
      "browser_pool_ha",
      "Browser pool HA",
      "blocked",
      "insufficient_browser_worker_replicas",
      "Controlled production requires at least two active browser workers for a single worker failure.",
      [`pool_key=${botPool.capacity.live_capacity.pool_key}`, `active_workers=${activeWorkers}`],
      "Add another active browser worker to the assigned pool and confirm fresh heartbeat.",
    );
  }
  return gate(
    "browser_pool_ha",
    "Browser pool HA",
    "pass",
    null,
    "The assigned browser pool has at least two active workers.",
    [`pool_key=${botPool.capacity.live_capacity.pool_key}`, `active_workers=${activeWorkers}`],
    null,
  );
}

function browserLeaseGate(expiredOpen: number): ProductionReadinessGate {
  if (expiredOpen > 0) {
    return gate(
      "browser_lease_hygiene",
      "Browser lease hygiene",
      "blocked",
      "expired_open_browser_leases",
      "Expired reserved/active browser leases are still open.",
      [`expired_open=${expiredOpen}`],
      "Run lease cleanup and confirm no expired open browser leases remain.",
    );
  }
  return gate(
    "browser_lease_hygiene",
    "Browser lease hygiene",
    "pass",
    null,
    "No expired open browser leases are present for the tenant.",
    ["expired_open=0"],
    null,
  );
}

function staleRunGate(count: number, oldestUpdatedAt: string | null): ProductionReadinessGate {
  if (count > 0) {
    return gate(
      "stale_run_backlog",
      "Stale run backlog",
      "blocked",
      "stale_nonterminal_runs",
      "Nonterminal runs have been stale for more than 15 minutes.",
      [`nonterminal_over_15m=${count}`, `oldest_updated_at=${oldestUpdatedAt ?? "unknown"}`],
      "Drain, resume, or cancel stale runs before opening controlled production.",
    );
  }
  return gate(
    "stale_run_backlog",
    "Stale run backlog",
    "pass",
    null,
    "No stale nonterminal runs are older than 15 minutes.",
    ["nonterminal_over_15m=0"],
    null,
  );
}

function auditVerifierGate(evidence: AuditVerifierEvidence): ProductionReadinessGate {
  if (evidence.audit_count === 0) {
    return gate(
      "audit_chain_evidence",
      "Audit chain evidence",
      "blocked",
      "audit_log_empty",
      "No audit rows exist yet, so controlled production has no tamper-evidence baseline.",
      ["audit_count=0"],
      "Generate governance/security audit events and run the audit hash-chain verifier.",
    );
  }
  if (evidence.latest_run_id === null) {
    return gate(
      "audit_chain_evidence",
      "Audit chain evidence",
      "blocked",
      "audit_verifier_missing",
      "Audit rows exist but no verifier run has recorded chain evidence.",
      [`audit_count=${evidence.audit_count}`],
      "Run the audit verifier and retain the verification run evidence.",
    );
  }
  if (evidence.latest_status !== "valid") {
    return gate(
      "audit_chain_evidence",
      "Audit chain evidence",
      "blocked",
      "audit_verifier_not_valid",
      "The latest audit verifier run is not valid.",
      [`latest_run_id=${evidence.latest_run_id}`, `latest_status=${evidence.latest_status ?? "unknown"}`],
      "Investigate the verifier violations before opening controlled production.",
    );
  }
  if (evidence.stale) {
    return gate(
      "audit_chain_evidence",
      "Audit chain evidence",
      "blocked",
      "audit_verifier_stale",
      `The latest valid audit verifier run is older than ${AUDIT_VERIFIER_FRESHNESS_MINUTES} minutes.`,
      [`latest_run_id=${evidence.latest_run_id}`, `latest_completed_at=${evidence.latest_completed_at ?? "unknown"}`],
      "Run the verifier again or confirm hourly maintenance is delivering verifier evidence.",
    );
  }
  return gate(
    "audit_chain_evidence",
    "Audit chain evidence",
    "pass",
    null,
    "The latest audit verifier run is valid and fresh.",
    [
      `latest_run_id=${evidence.latest_run_id}`,
      `rows_checked=${evidence.rows_checked ?? 0}`,
      `violation_count=${evidence.violation_count ?? 0}`,
    ],
    null,
  );
}

function externalAlertDeliveryGate(
  evidence: ProductionReadinessEvidence | null,
  latestDelivery: OpsNotificationDelivery | null,
): ProductionReadinessGate {
  const ownerGateInput = {
    gateId: "external_alert_delivery",
    label: "External alert delivery",
    missingReason: "external_delivery_evidence_missing",
    missingDetail: "Console alerts are available, but controlled production needs an owner-attested external delivery drill receipt.",
    missingEvidence: ["ops_alert.delivery.external_delivery=false", "external_delivery_drill=evidence_required"],
    missingAction: "Record a successful external alert delivery drill receipt without endpoint URLs, tokens, or webhook secrets.",
    failedReason: "external_delivery_drill_failed",
    expiredReason: "external_delivery_evidence_expired",
    passDetail: "External alert delivery drill evidence is valid and unexpired.",
    evidence,
  };
  const ownerGate = ownerEvidenceGate(ownerGateInput);
  if (ownerGate.status === "blocked") return ownerGate;

  if (latestDelivery !== null) {
    if (latestDelivery.status === "failed") {
      return gate(
        "external_alert_delivery",
        "External alert delivery",
        "blocked",
        "external_delivery_receipt_failed",
        latestDelivery.summary,
        notificationDeliveryEvidenceLines(latestDelivery),
        "Resolve the failed external delivery and record a newer delivered provider receipt.",
      );
    }
    const maxAgeMs = EXTERNAL_ALERT_DELIVERY_FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
    if (latestDelivery.status === "delivered" && Date.parse(latestDelivery.receipt_at) > Date.now() - maxAgeMs) {
      return gate(
        "external_alert_delivery",
        "External alert delivery",
        "pass",
        null,
        "External alert delivery has a fresh provider delivered receipt.",
        notificationDeliveryEvidenceLines(latestDelivery),
        null,
      );
    }
    if (ownerGate.status === "pass") return ownerGate;
    return gate(
      "external_alert_delivery",
      "External alert delivery",
      "deferred",
      latestDelivery.status === "sent" ? "external_delivery_receipt_not_delivered" : "external_delivery_receipt_expired",
      "The latest external delivery receipt is not a fresh delivered provider receipt.",
      notificationDeliveryEvidenceLines(latestDelivery),
      "Record a newer delivered provider receipt or attach owner-approved external delivery evidence.",
    );
  }
  return ownerGate;
}

function managedBackupRestoreDrillGate(evidence: ProductionReadinessEvidence | null): ProductionReadinessGate {
  return ownerEvidenceGate({
    gateId: "managed_backup_restore_drill",
    label: "Managed backup restore drill",
    missingReason: "owner_controlled_pitr_evidence_missing",
    missingDetail: "Repo-local restore drills exist, but owner-controlled managed backup/PITR restore evidence is external to this deployment.",
    missingEvidence: ["local_restore_drill=available", "managed_backup_pitr=evidence_required", "rto_rpo_targets=evidence_required"],
    missingAction: "Record owner-controlled backup/PITR restore drill evidence with RTO/RPO timestamps before production open.",
    failedReason: "managed_backup_restore_drill_failed",
    expiredReason: "managed_backup_restore_evidence_expired",
    passDetail: "Owner-controlled managed backup/PITR restore drill evidence is valid and unexpired.",
    evidence,
  });
}

function sloOncallSignoffGate(evidence: ProductionReadinessEvidence | null): ProductionReadinessGate {
  return ownerEvidenceGate({
    gateId: "slo_oncall_signoff",
    label: "SLO/on-call sign-off",
    missingReason: "slo_oncall_signoff_missing",
    missingDetail: "Controlled production needs owner-attested SLO targets, severity policy, and on-call/RACI coverage evidence.",
    missingEvidence: ["slo_dashboard=evidence_required", "on_call_raci=evidence_required", "support_hours=evidence_required"],
    missingAction: "Record metadata-only SLO dashboard and on-call/RACI sign-off evidence before production open.",
    failedReason: "slo_oncall_signoff_failed",
    expiredReason: "slo_oncall_signoff_expired",
    passDetail: "SLO dashboard and on-call/RACI sign-off evidence is valid and unexpired.",
    evidence,
  });
}

function observabilityTelemetryWiringGate(evidence: ProductionReadinessEvidence | null): ProductionReadinessGate {
  return ownerEvidenceGate({
    gateId: "observability_telemetry_wiring",
    label: "Observability telemetry wiring",
    missingReason: "observability_telemetry_evidence_missing",
    missingDetail: "Controlled production needs owner-attested OTLP/Prometheus exporter, collector, dashboard, and alert-route evidence.",
    missingEvidence: ["telemetry_exporter=evidence_required", "collector_ref=evidence_required", "dashboard_alert_route=evidence_required"],
    missingAction: "Record metadata-only telemetry wiring evidence for exporter, collector, dashboard, and alert route before production open.",
    failedReason: "observability_telemetry_wiring_failed",
    expiredReason: "observability_telemetry_evidence_expired",
    passDetail: "Observability exporter, collector, dashboard, and alert-route evidence is valid and unexpired.",
    evidence,
  });
}

function supportTrainingCompletionGate(evidence: ProductionReadinessEvidence | null): ProductionReadinessGate {
  return ownerEvidenceGate({
    gateId: "support_training_completion",
    label: "Support and training completion",
    missingReason: "support_training_completion_missing",
    missingDetail: "Controlled production needs owner-attested support model and role training completion evidence.",
    missingEvidence: ["support_model=evidence_required", "training_completion=evidence_required", "coverage_percent=evidence_required"],
    missingAction: "Record metadata-only support model and role training completion evidence before production open.",
    failedReason: "support_training_completion_failed",
    expiredReason: "support_training_completion_expired",
    passDetail: "Support model and training completion evidence is valid and unexpired.",
    evidence,
  });
}

function ownerEvidenceGate(input: {
  readonly gateId: string;
  readonly label: string;
  readonly missingReason: string;
  readonly missingDetail: string;
  readonly missingEvidence: readonly string[];
  readonly missingAction: string;
  readonly failedReason: string;
  readonly expiredReason: string;
  readonly passDetail: string;
  readonly evidence: ProductionReadinessEvidence | null;
}): ProductionReadinessGate {
  if (input.evidence === null) {
    return gate(
      input.gateId,
      input.label,
      "deferred",
      input.missingReason,
      input.missingDetail,
      input.missingEvidence,
      input.missingAction,
    );
  }
  if (input.evidence.status === "failed") {
    return gate(
      input.gateId,
      input.label,
      "blocked",
      input.failedReason,
      input.evidence.summary,
      evidenceLines(input.evidence),
      "Resolve the failed drill and record a new valid evidence item before production open.",
    );
  }
  if (input.evidence.expires_at === null || Date.parse(input.evidence.expires_at) <= Date.now()) {
    return gate(
      input.gateId,
      input.label,
      "deferred",
      input.expiredReason,
      "The latest owner evidence is expired or missing an expiry boundary.",
      evidenceLines(input.evidence),
      "Run the drill again and record fresh unexpired evidence.",
    );
  }
  return gate(
    input.gateId,
    input.label,
    "pass",
    null,
    input.passDetail,
    evidenceLines(input.evidence),
    null,
  );
}

function evidenceLines(evidence: ProductionReadinessEvidence): readonly string[] {
  const lines = [
    `evidence_id=${evidence.evidence_id}`,
    `status=${evidence.status}`,
    `evidence_at=${evidence.evidence_at}`,
    `expires_at=${evidence.expires_at ?? "none"}`,
  ];
  if (evidence.evidence_ref !== null) lines.push(`evidence_ref=${evidence.evidence_ref}`);
  for (const [key, value] of Object.entries(evidence.metadata).slice(0, 5)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}=${String(value)}`);
    }
  }
  return lines;
}

function notificationDeliveryEvidenceLines(delivery: OpsNotificationDelivery): readonly string[] {
  const lines = [
    `delivery_id=${delivery.delivery_id}`,
    `alert_id=${delivery.alert_id}`,
    `channel=${delivery.channel}`,
    `provider_alias=${delivery.provider_alias}`,
    `status=${delivery.status}`,
    `receipt_at=${delivery.receipt_at}`,
    `attempt_no=${delivery.attempt_no}`,
  ];
  if (delivery.recipient_group_ref !== null) lines.push(`recipient_group_ref=${delivery.recipient_group_ref}`);
  if (delivery.receipt_id !== null) lines.push(`receipt_id=${delivery.receipt_id}`);
  if (delivery.error_code !== null) lines.push(`error_code=${delivery.error_code}`);
  for (const [key, value] of Object.entries(delivery.metadata).slice(0, 3)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}=${String(value)}`);
    }
  }
  return lines;
}

function gate(
  gateId: string,
  label: string,
  status: ProductionReadinessGateStatus,
  reasonCode: string | null,
  detail: string,
  evidence: readonly string[],
  requiredAction: string | null,
): ProductionReadinessGate {
  return {
    gate_id: gateId,
    label,
    status,
    reason_code: reasonCode,
    detail,
    evidence,
    required_action: requiredAction,
  };
}

async function readMigrationEvidence(client: PoolClient): Promise<MigrationEvidence> {
  const ledger = await client.query<{ regclass: string | null }>(
    `SELECT to_regclass('schema_migrations')::text AS regclass`,
  );
  if (ledger.rows[0]?.regclass === null || ledger.rows[0]?.regclass === undefined) {
    return { available: false, applied_versions: [], missing_versions: [...REQUIRED_SCHEMA_MIGRATION_VERSIONS] };
  }
  const applied = await client.query<{ version: string }>(
    `SELECT version
       FROM schema_migrations
      WHERE version = ANY($1::text[])
        AND status = 'applied'
      ORDER BY version`,
    [[...REQUIRED_SCHEMA_MIGRATION_VERSIONS]],
  );
  const appliedVersions = applied.rows.map((row) => row.version);
  const appliedSet = new Set(appliedVersions);
  return {
    available: true,
    applied_versions: appliedVersions,
    missing_versions: REQUIRED_SCHEMA_MIGRATION_VERSIONS.filter((version) => !appliedSet.has(version)),
  };
}

async function readAuditVerifierEvidence(client: PoolClient, tenantId: string): Promise<AuditVerifierEvidence> {
  const result = await client.query<{
    audit_count: string;
    latest_run_id: string | null;
    latest_status: "valid" | "invalid" | "failed" | null;
    latest_completed_at: Date | null;
    rows_checked: string | null;
    violation_count: number | null;
    stale: boolean;
  }>(
    `WITH latest AS (
       SELECT id, status, completed_at, rows_checked, violation_count
         FROM audit_verifier_runs
        WHERE tenant_id = $1::uuid
        ORDER BY completed_at DESC, id DESC
        LIMIT 1
     )
     SELECT
       (SELECT count(*)::text FROM audit_log WHERE tenant_id = $1::uuid) AS audit_count,
       latest.id::text AS latest_run_id,
       latest.status AS latest_status,
       latest.completed_at AS latest_completed_at,
       latest.rows_checked::text AS rows_checked,
       latest.violation_count AS violation_count,
       COALESCE(latest.completed_at <= now() - ($2::int * interval '1 minute'), true) AS stale
     FROM latest
     RIGHT JOIN (SELECT 1) anchor ON true`,
    [tenantId, AUDIT_VERIFIER_FRESHNESS_MINUTES],
  );
  const row = result.rows[0];
  return {
    audit_count: Number(row?.audit_count ?? 0),
    latest_run_id: row?.latest_run_id ?? null,
    latest_status: row?.latest_status ?? null,
    latest_completed_at: row?.latest_completed_at?.toISOString() ?? null,
    rows_checked: row?.rows_checked === null || row?.rows_checked === undefined ? null : Number(row.rows_checked),
    violation_count: row?.violation_count ?? null,
    stale: row?.stale ?? true,
  };
}

async function readLatestOwnerEvidence(
  client: PoolClient,
  tenantId: string,
): Promise<Record<ProductionReadinessEvidenceType, ProductionReadinessEvidence | null>> {
  const rows = await client.query<ProductionReadinessEvidenceRow>(
    `WITH ranked AS (
       SELECT id::text, evidence_type, status, evidence_at, expires_at, summary, evidence_ref,
              metadata, recorded_by, recorded_at, legal_hold,
              row_number() OVER (
                PARTITION BY evidence_type
                ORDER BY evidence_at DESC, recorded_at DESC, id DESC
              ) AS rn
         FROM production_readiness_evidence
        WHERE tenant_id = $1::uuid
          AND deleted_at IS NULL
          AND evidence_type = ANY($2::text[])
     )
     SELECT id, evidence_type, status, evidence_at, expires_at, summary, evidence_ref,
            metadata, recorded_by, recorded_at, legal_hold
       FROM ranked
      WHERE rn = 1`,
    [tenantId, [...OWNER_EVIDENCE_TYPES]],
  );
  const out: Record<ProductionReadinessEvidenceType, ProductionReadinessEvidence | null> = {
    external_alert_delivery: null,
    managed_backup_restore_drill: null,
    slo_oncall_signoff: null,
    observability_telemetry_wiring: null,
    support_training_completion: null,
  };
  for (const row of rows.rows) {
    out[row.evidence_type] = mapEvidence(row);
  }
  return out;
}

async function readProductionReadinessEvidence(
  client: PoolClient,
  tenantId: string,
  evidenceType: ProductionReadinessEvidenceType | undefined,
  limit: number,
): Promise<ProductionReadinessEvidence[]> {
  const result = await client.query<ProductionReadinessEvidenceRow>(
    `SELECT id::text, evidence_type, status, evidence_at, expires_at, summary, evidence_ref,
            metadata, recorded_by, recorded_at, legal_hold
       FROM production_readiness_evidence
      WHERE tenant_id = $1::uuid
        AND deleted_at IS NULL
        AND ($2::text IS NULL OR evidence_type = $2::text)
      ORDER BY evidence_at DESC, recorded_at DESC, id DESC
      LIMIT $3`,
    [tenantId, evidenceType ?? null, limit],
  );
  return result.rows.map(mapEvidence);
}

async function insertProductionReadinessEvidence(
  client: PoolClient,
  tenantId: string,
  recordedBy: string,
  input: ProductionReadinessEvidenceInput,
): Promise<ProductionReadinessEvidence> {
  const retentionUntil = new Date(Date.now() + OWNER_EVIDENCE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result = await client.query<ProductionReadinessEvidenceRow>(
    `INSERT INTO production_readiness_evidence (
       id, tenant_id, evidence_type, status, evidence_at, expires_at, summary,
       evidence_ref, metadata, recorded_by, retention_until, legal_hold
     )
     VALUES ($1::uuid,$2::uuid,$3,$4,$5::timestamptz,$6::timestamptz,$7,$8,$9::jsonb,$10,$11::timestamptz,$12)
     RETURNING id::text, evidence_type, status, evidence_at, expires_at, summary, evidence_ref,
               metadata, recorded_by, recorded_at, legal_hold`,
    [
      randomUUID(),
      tenantId,
      input.evidenceType,
      input.status,
      input.evidenceAt.toISOString(),
      input.expiresAt?.toISOString() ?? null,
      input.summary,
      input.evidenceRef,
      JSON.stringify(input.metadata),
      recordedBy,
      retentionUntil.toISOString(),
      input.legalHold,
    ],
  );
  return mapEvidence(result.rows[0]);
}

function mapEvidence(row: ProductionReadinessEvidenceRow): ProductionReadinessEvidence {
  return {
    evidence_id: row.id,
    evidence_type: row.evidence_type,
    status: row.status,
    evidence_at: row.evidence_at.toISOString(),
    expires_at: row.expires_at?.toISOString() ?? null,
    summary: row.summary,
    evidence_ref: row.evidence_ref,
    metadata: isRecord(row.metadata) ? row.metadata : {},
    recorded_by: row.recorded_by,
    recorded_at: row.recorded_at.toISOString(),
    legal_hold: row.legal_hold,
  };
}

function parseEvidenceTypeQuery(raw: unknown): ProductionReadinessEvidenceType | undefined {
  if (raw === undefined) return undefined;
  return parseEvidenceType(raw);
}

function parseEvidenceRequest(raw: unknown): ProductionReadinessEvidenceInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "production_readiness_evidence_body_expected_object" });
  const allowed = new Set(["evidence_type", "status", "evidence_at", "expires_at", "summary", "evidence_ref", "metadata", "legal_hold"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "production_readiness_evidence_unknown_field", field: key });
    }
  }
  const evidenceType = parseEvidenceType(raw.evidence_type);
  const status = parseEvidenceStatus(raw.status);
  const evidenceAt = parseIsoDate(raw.evidence_at, "evidence_at");
  const expiresAt = raw.expires_at === undefined || raw.expires_at === null ? null : parseIsoDate(raw.expires_at, "expires_at");
  const now = Date.now();
  if (evidenceAt.getTime() > now + 5 * 60 * 1000) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "evidence_at_in_future" });
  }
  if (status === "valid") {
    if (expiresAt === null) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "expires_at_required_for_valid_evidence" });
    if (expiresAt.getTime() <= now) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "expires_at_must_be_future" });
  }
  if (expiresAt !== null && expiresAt.getTime() <= evidenceAt.getTime()) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "expires_at_must_be_after_evidence_at" });
  }
  const summary = parseBoundedString(raw.summary, "summary", 1, 1000);
  assertSafeEvidenceString(summary, "summary");
  const evidenceRef = raw.evidence_ref === undefined || raw.evidence_ref === null || raw.evidence_ref === ""
    ? null
    : parseEvidenceRef(raw.evidence_ref);
  const metadata = parseEvidenceMetadata(raw.metadata);
  assertEvidenceTypeMetadata(evidenceType, status, evidenceRef, metadata);
  const legalHold = raw.legal_hold === undefined ? false : parseBoolean(raw.legal_hold, "legal_hold");
  return { evidenceType, status, evidenceAt, expiresAt, summary, evidenceRef, metadata, legalHold };
}

function parseEvidenceType(raw: unknown): ProductionReadinessEvidenceType {
  if (
    raw === "external_alert_delivery" ||
    raw === "managed_backup_restore_drill" ||
    raw === "slo_oncall_signoff" ||
    raw === "observability_telemetry_wiring" ||
    raw === "support_training_completion"
  ) return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_production_readiness_evidence_type" });
}

function parseEvidenceStatus(raw: unknown): ProductionReadinessEvidenceStatus {
  if (raw === "valid" || raw === "failed") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_production_readiness_evidence_status" });
}

function parseIsoDate(raw: unknown, field: string): Date {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_iso_datetime", field });
  }
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_iso_datetime", field });
  }
  return date;
}

function parseEvidenceRef(raw: unknown): string {
  const value = parseBoundedString(raw, "evidence_ref", 1, 500);
  assertSafeEvidenceString(value, "evidence_ref");
  return value;
}

function parseEvidenceMetadata(raw: unknown): Readonly<Record<string, unknown>> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_must_be_object" });
  const encoded = JSON.stringify(raw);
  if (encoded.length > 4000) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_too_large" });
  assertSafeMetadata(raw, "metadata");
  return raw;
}

function assertEvidenceTypeMetadata(
  evidenceType: ProductionReadinessEvidenceType,
  status: ProductionReadinessEvidenceStatus,
  evidenceRef: string | null,
  metadata: Readonly<Record<string, unknown>>,
): void {
  if (status !== "valid") return;
  if (evidenceType === "external_alert_delivery") {
    assertExternalAlertDeliveryMetadata(evidenceRef, metadata);
    return;
  }
  if (evidenceType === "managed_backup_restore_drill") {
    assertManagedBackupRestoreMetadata(evidenceRef, metadata);
    return;
  }
  if (evidenceType === "observability_telemetry_wiring") {
    assertObservabilityTelemetryWiringMetadata(evidenceRef, metadata);
    return;
  }
  if (evidenceType === "support_training_completion") {
    assertSupportTrainingCompletionMetadata(evidenceRef, metadata);
    return;
  }
  if (evidenceType !== "slo_oncall_signoff") return;
  if (evidenceRef === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "slo_oncall_evidence_ref_required",
      field: "evidence_ref",
    });
  }
  for (const key of ["slo_dashboard", "severity_model", "oncall_rota", "raci_ref", "support_hours"] as const) {
    assertRequiredEvidenceMetadataString(metadata, key, "slo_oncall_metadata_required");
  }
}

function assertExternalAlertDeliveryMetadata(
  evidenceRef: string | null,
  metadata: Readonly<Record<string, unknown>>,
): void {
  if (evidenceRef === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "external_alert_delivery_evidence_ref_required",
      field: "evidence_ref",
    });
  }
  const channel = assertRequiredEvidenceMetadataString(metadata, "channel", "external_alert_delivery_metadata_required");
  if (!["teams", "slack", "email", "webhook"].includes(channel)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "external_alert_delivery_channel_invalid",
      field: "metadata.channel",
    });
  }
  assertRequiredEvidenceMetadataString(metadata, "provider_alias", "external_alert_delivery_metadata_required");
  assertRequiredEvidenceMetadataString(metadata, "receipt_id", "external_alert_delivery_metadata_required");
  const deliveryStatus = assertRequiredEvidenceMetadataString(metadata, "delivery_status", "external_alert_delivery_metadata_required");
  if (deliveryStatus !== "delivered") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "external_alert_delivery_status_must_be_delivered",
      field: "metadata.delivery_status",
    });
  }
  const receiptAtRaw = assertRequiredEvidenceMetadataString(metadata, "receipt_at", "external_alert_delivery_metadata_required");
  const receiptAt = parseIsoDate(receiptAtRaw, "metadata.receipt_at");
  if (receiptAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "receipt_at_in_future",
      field: "metadata.receipt_at",
    });
  }
}

function assertObservabilityTelemetryWiringMetadata(
  evidenceRef: string | null,
  metadata: Readonly<Record<string, unknown>>,
): void {
  if (evidenceRef === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "observability_telemetry_evidence_ref_required",
      field: "evidence_ref",
    });
  }
  const exporter = assertRequiredEvidenceMetadataString(metadata, "exporter", "observability_telemetry_metadata_required");
  if (!["prometheus", "otlp"].includes(exporter)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "observability_telemetry_exporter_invalid",
      field: "metadata.exporter",
    });
  }
  assertRequiredEvidenceMetadataString(metadata, "collector_ref", "observability_telemetry_metadata_required");
  assertRequiredEvidenceMetadataString(metadata, "dashboard_ref", "observability_telemetry_metadata_required");
  assertRequiredEvidenceMetadataString(metadata, "alert_route_ref", "observability_telemetry_metadata_required");
  const sampledAtRaw = assertRequiredEvidenceMetadataString(metadata, "sampled_at", "observability_telemetry_metadata_required");
  const sampledAt = parseIsoDate(sampledAtRaw, "metadata.sampled_at");
  if (sampledAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "observability_telemetry_sampled_at_in_future",
      field: "metadata.sampled_at",
    });
  }
}

function assertSupportTrainingCompletionMetadata(
  evidenceRef: string | null,
  metadata: Readonly<Record<string, unknown>>,
): void {
  if (evidenceRef === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "support_training_evidence_ref_required",
      field: "evidence_ref",
    });
  }
  assertRequiredEvidenceMetadataString(metadata, "support_model_ref", "support_training_metadata_required");
  assertRequiredEvidenceMetadataString(metadata, "training_completion_ref", "support_training_metadata_required");
  const trainedRoleCount = assertRequiredEvidenceMetadataFiniteNumber(metadata, "trained_role_count", "support_training_metadata_required");
  const trainedUserCount = assertRequiredEvidenceMetadataFiniteNumber(metadata, "trained_user_count", "support_training_metadata_required");
  const coveragePercent = assertRequiredEvidenceMetadataFiniteNumber(metadata, "coverage_percent", "support_training_metadata_required");
  if (!Number.isInteger(trainedRoleCount) || trainedRoleCount <= 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "support_training_role_count_invalid", field: "metadata.trained_role_count" });
  }
  if (!Number.isInteger(trainedUserCount) || trainedUserCount <= 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "support_training_user_count_invalid", field: "metadata.trained_user_count" });
  }
  if (coveragePercent < 0 || coveragePercent > 100) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "support_training_coverage_invalid", field: "metadata.coverage_percent" });
  }
  const completedAtRaw = assertRequiredEvidenceMetadataString(metadata, "completed_at", "support_training_metadata_required");
  const completedAt = parseIsoDate(completedAtRaw, "metadata.completed_at");
  if (completedAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "support_training_completed_at_in_future",
      field: "metadata.completed_at",
    });
  }
}

function assertManagedBackupRestoreMetadata(
  evidenceRef: string | null,
  metadata: Readonly<Record<string, unknown>>,
): void {
  if (evidenceRef === null) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "managed_backup_restore_evidence_ref_required",
      field: "evidence_ref",
    });
  }
  assertRequiredEvidenceMetadataString(metadata, "backup_policy_ref", "managed_backup_restore_metadata_required");
  assertRequiredEvidenceMetadataString(metadata, "restore_scope", "managed_backup_restore_metadata_required");
  assertRequiredEvidenceMetadataString(metadata, "restore_completed_at", "managed_backup_restore_metadata_required");
  const restoreCompletedAt = parseIsoDate(metadata.restore_completed_at, "metadata.restore_completed_at");
  if (restoreCompletedAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "restore_completed_at_in_future",
      field: "metadata.restore_completed_at",
    });
  }
  assertRequiredEvidenceMetadataNumber(
    metadata,
    "rto_minutes",
    CONTROLLED_PROD_RESTORE_RTO_MINUTES,
    "managed_backup_restore_rto_target_missed",
  );
  assertRequiredEvidenceMetadataNumber(
    metadata,
    "rpo_minutes",
    CONTROLLED_PROD_RESTORE_RPO_MINUTES,
    "managed_backup_restore_rpo_target_missed",
  );
}

function assertRequiredEvidenceMetadataString(
  metadata: Readonly<Record<string, unknown>>,
  key: string,
  reason: string,
): string {
  const value = metadata[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 200) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason,
      field: `metadata.${key}`,
    });
  }
  return value.trim();
}

function assertRequiredEvidenceMetadataNumber(
  metadata: Readonly<Record<string, unknown>>,
  key: string,
  max: number,
  targetMissedReason: string,
): void {
  const value = metadata[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: "managed_backup_restore_metadata_required",
      field: `metadata.${key}`,
    });
  }
  if (value > max) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason: targetMissedReason,
      field: `metadata.${key}`,
      target_max_minutes: max,
    });
  }
}

function assertRequiredEvidenceMetadataFiniteNumber(
  metadata: Readonly<Record<string, unknown>>,
  key: string,
  reason: string,
): number {
  const value = metadata[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", {
      reason,
      field: `metadata.${key}`,
    });
  }
  return value;
}

function parseBoundedString(raw: unknown, field: string, min: number, max: number): string {
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  const value = raw.trim();
  if (value.length < min || value.length > max) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  return value;
}

function parseBoolean(raw: unknown, field: string): boolean {
  if (typeof raw === "boolean") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function assertSafeMetadata(value: unknown, path: string): void {
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value === "string") {
    assertSafeEvidenceString(value, path);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertSafeMetadata(item, `${path}.${index}`);
    return;
  }
  if (!isRecord(value)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_value_not_json", path });
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || forbiddenEvidenceKey(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_secret_or_endpoint_key_forbidden", path: `${path}.${key}` });
    }
    assertSafeMetadata(item, `${path}.${key}`);
  }
}

function assertSafeEvidenceString(value: string, path: string): void {
  if (
    /https?:\/\//i.test(value) ||
    /hooks\.slack\.com/i.test(value) ||
    /bearer\s+[a-z0-9._-]+/i.test(value) ||
    /\b(?:api[_-]?key|secret|token|password|credential|authorization|webhook_secret)\s*[:=]/i.test(value)
  ) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_or_endpoint_value_forbidden", path });
  }
}

function forbiddenEvidenceKey(key: string): boolean {
  return /(^|[_.-])(secret|token|password|credential|authorization|cookie|webhook_url|endpoint_url|url|dsn|smtp|raw_roster|training_roster|participant_list|user_list|raw_training_document|training_document_body|payload|body)([_.-]|$)/i.test(key);
}
