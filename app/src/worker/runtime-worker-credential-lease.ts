import type pg from "pg";

import type { RuntimeJobResult } from "../../../ts/runtime-contract";
import { deriveAssetRefs } from "../runtime/asset-refs";

export const DEFAULT_CREDENTIAL_LEASE_TTL_MS = 15 * 60 * 1000;

export interface CredentialLeaseAcquireInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly scenarioVersionId: string;
  readonly siteProfileId: string;
  readonly ttlMs?: number;
}

export async function acquireCredentialLeasesForRun(
  client: pg.PoolClient,
  input: CredentialLeaseAcquireInput,
): Promise<RuntimeJobResult | { kind: "acquired" }> {
  const ttlMs = input.ttlMs ?? DEFAULT_CREDENTIAL_LEASE_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new Error(`RuntimeWorker: credential lease ttlMs must be a positive integer, got ${ttlMs}`);
  }

  const credentialRefs = await loadScenarioCredentialRefs(client, input);
  if (credentialRefs.length === 0) return { kind: "acquired" };

  for (const credentialRef of credentialRefs) {
    const policy = await client.query<{ max_concurrency: number; status: string | null }>(
      `SELECT max_concurrency, status
         FROM credential_concurrency_policies
        WHERE tenant_id = $1::uuid
          AND credential_ref = $2
          AND site_profile_id = $3::uuid`,
      [input.tenantId, credentialRef, input.siteProfileId],
    );
    const policyRow = policy.rows[0];
    if (policyRow?.status !== undefined && policyRow.status !== null && policyRow.status !== "active") {
      await releaseCredentialLeasesForRun(client, input);
      return { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" };
    }
    const maxConcurrency = policyRow?.max_concurrency ?? 1;
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error(`RuntimeWorker: invalid credential max_concurrency ${maxConcurrency}`);
    }

    await client.query(
      `UPDATE credential_leases
          SET status = 'expired'
        WHERE tenant_id = $1::uuid
          AND credential_ref = $2
          AND site_profile_id = $3::uuid
          AND status = 'active'
          AND locked_until < now()`,
      [input.tenantId, credentialRef, input.siteProfileId],
    );

    let acquired = false;
    for (let slotNo = 0; slotNo < maxConcurrency; slotNo += 1) {
      const lease = await client.query<{ slot_no: number }>(
        `INSERT INTO credential_leases
           (tenant_id, credential_ref, site_profile_id, slot_no, run_id, status, locked_until)
         VALUES
           ($1::uuid, $2, $3::uuid, $4::int, $5::uuid, 'active',
            now() + ($6::int * interval '1 millisecond'))
         ON CONFLICT (tenant_id, credential_ref, site_profile_id, slot_no)
         DO UPDATE
            SET run_id = EXCLUDED.run_id,
                workitem_id = NULL,
                status = 'active',
                locked_until = EXCLUDED.locked_until,
                acquired_at = now()
          WHERE credential_leases.status IN ('released','expired')
             OR credential_leases.locked_until < now()
             OR credential_leases.run_id = EXCLUDED.run_id
         RETURNING slot_no`,
        [input.tenantId, credentialRef, input.siteProfileId, slotNo, input.runId, ttlMs],
      );
      if (lease.rows[0] !== undefined) {
        acquired = true;
        break;
      }
    }

    if (!acquired) {
      await releaseCredentialLeasesForRun(client, input);
      return {
        kind: "deferred",
        code: "SESSION_LOCKED",
        retryAfterMs: await retryAfterMsForCredential(client, input, credentialRef),
      };
    }
  }

  return { kind: "acquired" };
}

export async function releaseCredentialLeasesForRun(
  client: pg.PoolClient,
  input: { readonly tenantId: string; readonly runId: string },
): Promise<void> {
  await client.query(
    `UPDATE credential_leases
        SET status = 'released',
            locked_until = LEAST(locked_until, now())
      WHERE tenant_id = $1::uuid
        AND run_id = $2::uuid
        AND status = 'active'`,
    [input.tenantId, input.runId],
  );
}

async function loadScenarioCredentialRefs(
  client: pg.PoolClient,
  input: Pick<CredentialLeaseAcquireInput, "tenantId" | "scenarioVersionId">,
): Promise<readonly string[]> {
  const row = await client.query<{ ir: unknown }>(
    `SELECT ir
       FROM scenario_versions
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid`,
    [input.tenantId, input.scenarioVersionId],
  );
  const ir = row.rows[0]?.ir;
  if (ir === undefined) {
    throw new Error("RuntimeWorker: credential lease scenario_version row not found in tenant scope");
  }
  const refs = deriveAssetRefs(ir);
  return [...new Set(Object.values(refs).filter((ref) => ref.length > 0).map((ref) => String(ref)))].sort();
}

async function retryAfterMsForCredential(
  client: pg.PoolClient,
  input: Pick<CredentialLeaseAcquireInput, "tenantId" | "siteProfileId">,
  credentialRef: string,
): Promise<number> {
  const wait = await client.query<{ retry_after_ms: number | null }>(
    `SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (MIN(locked_until) - now())) * 1000))::int AS retry_after_ms
       FROM credential_leases
      WHERE tenant_id = $1::uuid
        AND credential_ref = $2
        AND site_profile_id = $3::uuid
        AND status = 'active'
        AND locked_until >= now()`,
    [input.tenantId, credentialRef, input.siteProfileId],
  );
  return wait.rows[0]?.retry_after_ms ?? 1_000;
}
