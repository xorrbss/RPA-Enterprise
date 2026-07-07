import type { PoolClient } from "pg";

import type { AiGovernanceReadinessSnapshot } from "./ai-governance-readiness";
import { DEFAULT_AUTH_READINESS_CONFIG, evaluateAuthSsoReadiness } from "./auth-readiness";
import type { readBrowserBotPool } from "../runtime/bot-pool-read";
import type { AuthReadinessConfig } from "./server-shared";

export type ProductionReadinessStatus = "ready" | "warning" | "blocked";
export type ProductionReadinessGateStatus = "pass" | "warning" | "blocked" | "deferred";

export interface ProductionReadinessGate {
  readonly gate_id: string;
  readonly label: string;
  readonly status: ProductionReadinessGateStatus;
  readonly reason_code: string | null;
  readonly detail: string;
  readonly evidence: readonly string[];
  readonly required_action: string | null;
}

export interface AuditVerifierEvidence {
  readonly audit_count: number;
  readonly latest_run_id: string | null;
  readonly latest_status: "valid" | "invalid" | "failed" | null;
  readonly latest_completed_at: string | null;
  readonly rows_checked: number | null;
  readonly violation_count: number | null;
  readonly stale: boolean;
}

export interface MigrationEvidence {
  readonly available: boolean;
  readonly applied_versions: readonly string[];
  readonly missing_versions: readonly string[];
}

const REQUIRED_SCHEMA_MIGRATION_VERSIONS = ["0001", "0002"] as const;
const AUDIT_VERIFIER_FRESHNESS_MINUTES = 75;

export function authSsoReadinessGate(config: AuthReadinessConfig | undefined): ProductionReadinessGate {
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

export function aiGovernanceRuntimeGate(snapshot: AiGovernanceReadinessSnapshot): ProductionReadinessGate {
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

export function summarize(gates: readonly ProductionReadinessGate[]) {
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

export function migrationGate(evidence: MigrationEvidence): ProductionReadinessGate {
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

export function graphileQueueGate(queue: { readonly available: boolean; readonly pending_jobs: number | null }): ProductionReadinessGate {
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

export function browserPoolHaGate(botPool: Awaited<ReturnType<typeof readBrowserBotPool>>): ProductionReadinessGate {
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

export function browserLeaseGate(expiredOpen: number): ProductionReadinessGate {
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

export function staleRunGate(count: number, oldestUpdatedAt: string | null): ProductionReadinessGate {
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

export function auditVerifierGate(evidence: AuditVerifierEvidence): ProductionReadinessGate {
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

export function gate(
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

export async function readMigrationEvidence(client: PoolClient): Promise<MigrationEvidence> {
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

export async function readAuditVerifierEvidence(client: PoolClient, tenantId: string): Promise<AuditVerifierEvidence> {
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
