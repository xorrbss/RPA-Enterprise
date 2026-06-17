/**
 * PgBrowserLeasePlanResolver — production `BrowserLeasePlanResolver` (runtime-worker.ts) backed by Postgres.
 *
 * Resolves a run's browser-lease plan from the scenario it runs:
 *   run → scenario_version → ir.target (the scenario-declared {site_profile_id, browser_identity_id,
 *   network_policy_id}; see schema/ir.schema.json `target`).
 *
 * Returns null when the scenario declares no (or a malformed) target → the worker LOUD-THROWS (fail-closed;
 * "조용한 false 금지" — a scenario must declare its target to be driven). The query is tenant-scoped and runs
 * inside the worker's tenant transaction (RLS-enforced); the actual existence/approval/identity-tuple checks
 * happen at lease acquisition (FK + SITE_PROFILE_BLOCKED gate) downstream.
 */
import type { BrowserLeasePlan, BrowserLeasePlanResolver } from "./runtime-worker";

export const pgBrowserLeasePlanResolver: BrowserLeasePlanResolver = async (client, input): Promise<BrowserLeasePlan | null> => {
  const res = await client.query<{ target: unknown }>(
    `SELECT sv.ir -> 'target' AS target
       FROM runs r
       JOIN scenario_versions sv ON sv.id = r.scenario_version_id
      WHERE r.id = $1::uuid AND r.tenant_id = $2::uuid`,
    [input.runId, input.tenantId],
  );
  const target = res.rows[0]?.target;
  if (target === null || target === undefined || typeof target !== "object") return null;
  const t = target as { site_profile_id?: unknown; browser_identity_id?: unknown; network_policy_id?: unknown };
  if (
    typeof t.site_profile_id !== "string" ||
    typeof t.browser_identity_id !== "string" ||
    typeof t.network_policy_id !== "string"
  ) {
    return null;
  }
  return {
    siteProfileId: t.site_profile_id,
    browserIdentityId: t.browser_identity_id,
    networkPolicyId: t.network_policy_id,
  };
};
