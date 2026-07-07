import type pg from "pg";

import { insertAuditVerificationRun } from "../runtime/audit-verification-runs";
import { verifyAuditChainInTenantTx } from "../runtime/audit-record-hash";
import { withTenantTx } from "../db/pool";
import { errText, workerLog } from "../observability/log";
import type { RuntimeJobResult, RuntimeWorkerJob } from "../../../ts/runtime-contract";
import { requireString } from "./runtime-worker-parse";

const AUDIT_VERIFIER_ACTOR = { subjectId: "system:maintenance", roles: ["system", "audit_verifier"] };

export async function handleAuditVerifierJob(pool: pg.Pool, job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
  const tenantId = requireString(job.tenantId, "audit_verifier.tenantId");
  const correlationId = requireString(job.correlationId, "audit_verifier.correlationId");
  const startedAt = new Date();

  try {
    await withTenantTx(pool, tenantId, async (client) => {
      const result = await verifyAuditChainInTenantTx(client, tenantId);
      await insertAuditVerificationRun(client, {
        tenantId,
        result,
        startedAt,
        completedAt: new Date(),
        correlationId,
        triggeredBy: AUDIT_VERIFIER_ACTOR,
        triggerKind: "maintenance",
        legalHold: false,
      });
    });
  } catch (err) {
    const completedAt = new Date();
    workerLog("error", {
      at: "audit_verifier",
      msg: "audit verifier job failed; recording failed verifier evidence",
      tenant_id: tenantId,
      correlation_id: correlationId,
      error: errText(err),
    });
    await withTenantTx(pool, tenantId, async (client) => {
      await insertAuditVerificationRun(client, {
        tenantId,
        status: "failed",
        startedAt,
        completedAt,
        correlationId,
        triggeredBy: AUDIT_VERIFIER_ACTOR,
        triggerKind: "maintenance",
        legalHold: false,
      });
    });
  }

  return { kind: "completed", emittedEvents: [] };
}
