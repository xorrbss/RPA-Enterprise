import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import { readBrowserBotPool } from "../runtime/bot-pool-read";
import { readAiGovernanceReadiness } from "./ai-governance-enforcement";
import { runIdempotentCommand } from "./command";
import { parseLimit } from "./list-query";
import { readOpsHealth } from "./ops-health";
import { readLatestOpsNotificationDelivery } from "./ops-alerts-deliveries";
import {
  insertProductionReadinessEvidence,
  readLatestOwnerEvidence,
  readProductionReadinessEvidence,
} from "./production-readiness-evidence";
import { parseEvidenceRequest, parseEvidenceTypeQuery } from "./production-readiness-evidence-validation";
import {
  aiGovernanceRuntimeGate,
  auditVerifierGate,
  authSsoReadinessGate,
  browserLeaseGate,
  browserPoolHaGate,
  graphileQueueGate,
  migrationGate,
  readAuditVerifierEvidence,
  readMigrationEvidence,
  staleRunGate,
  summarize,
  type ProductionReadinessGate,
} from "./production-readiness-gates";
import {
  externalAlertDeliveryGate,
  managedBackupRestoreDrillGate,
  observabilityTelemetryWiringGate,
  sloOncallSignoffGate,
  supportTrainingCompletionGate,
} from "./production-readiness-owner-gates";
import { requirePrincipal, type ApiServerDeps, type AuthReadinessConfig } from "./server-shared";

export type { ProductionReadinessStatus, ProductionReadinessGateStatus } from "./production-readiness-gates";
export type {
  ProductionReadinessEvidenceType,
  ProductionReadinessEvidenceStatus,
} from "./production-readiness-evidence";

export interface ProductionReadinessConfig {
  readonly authReadiness?: AuthReadinessConfig;
  readonly aiGovernanceConfiguredModels?: readonly string[];
  readonly aiGovernanceConfiguredPromptVersions?: readonly string[];
}

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
