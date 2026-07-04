// maintenance-scheduler.ts 에서 추출 — 스위퍼별 대상 테넌트 발견(discovery) 리졸버(동작 무변경).
// 구성 목록(MAINTENANCE_TENANT_IDS)이 있으면 그대로/그 안에서 due 검사, 없으면 BYPASSRLS 발견(감사 필수).
import type { PoolClient } from "pg";

import { withTenantTx, type PgPool } from "../db/pool";
import { ARTIFACT_REDACTION_FAIL_THRESHOLD } from "./runtime-worker-artifact-lifecycle";
import { assertLifecycleBypassUse } from "./runtime-worker-lifecycle-audit";

export const AUDIT_VERIFIER_INTERVAL_MS = 60 * 60 * 1000;

interface LifecycleTenantDiscoveryOptions {
  readonly lifecycleBypassPool?: PgPool;
}

/**
 * O4: purge 대상 테넌트 — 만기 approved 또는 재개할 purging 원장 보유 테넌트만.
 * 구성 목록이 있으면 그 안에서 due 검사(app role, RLS 스코프), 없으면 BYPASSRLS 발견(감사 필수).
 */
export async function resolveDueOffboardingPurgeTenantIds(
  pool: PgPool,
  configuredTenantIds: readonly string[],
  now: Date,
  options: LifecycleTenantDiscoveryOptions = {},
): Promise<readonly string[]> {
  if (configuredTenantIds.length > 0) {
    const due: string[] = [];
    for (const tenantId of configuredTenantIds) {
      const isDue = await withTenantTx(pool, tenantId, async (client) => {
        const res = await client.query(
          `SELECT 1 FROM tenant_offboarding_requests
            WHERE status = 'purging' OR (status = 'approved' AND purge_after <= $1::timestamptz)
            LIMIT 1`,
          [now.toISOString()],
        );
        return res.rows.length > 0;
      });
      if (isDue) due.push(tenantId);
    }
    return due;
  }
  const lifecycleBypassPool = requireLifecycleBypassPool(
    options.lifecycleBypassPool,
    "resolveDueOffboardingPurgeTenantIds",
  );
  const client = await lifecycleBypassPool.connect();
  try {
    await assertLifecycleBypassUse(
      client as PoolClient,
      "scheduler_infra_worker_registry",
      "maintenance.offboarding_purge_tenant_discovery",
    );
    const res = await client.query<{ tenant_id: string }>(
      `SELECT DISTINCT tenant_id::text AS tenant_id
         FROM tenant_offboarding_requests
        WHERE status = 'purging' OR (status = 'approved' AND purge_after <= $1::timestamptz)
        ORDER BY tenant_id`,
      [now.toISOString()],
    );
    return res.rows.map((row) => row.tenant_id);
  } finally {
    client.release();
  }
}

export async function resolveAuditVerifierTenantIds(
  configuredTenantIds: readonly string[],
  now: Date,
  options: LifecycleTenantDiscoveryOptions = {},
): Promise<readonly string[]> {
  if (configuredTenantIds.length > 0) return configuredTenantIds;
  const lifecycleBypassPool = requireLifecycleBypassPool(
    options.lifecycleBypassPool,
    "resolveAuditVerifierTenantIds",
  );
  const client = await lifecycleBypassPool.connect();
  try {
    await assertLifecycleBypassUse(
      client as PoolClient,
      "scheduler_infra_worker_registry",
      "maintenance.audit_verifier_tenant_discovery",
    );
    const res = await client.query<{ tenant_id: string }>(
      `WITH audit_tenants AS (
         SELECT tenant_id
           FROM audit_log
          WHERE deleted_at IS NULL
          GROUP BY tenant_id
       ),
       latest_runs AS (
         SELECT DISTINCT ON (tenant_id) tenant_id, completed_at
           FROM audit_verifier_runs
          WHERE deleted_at IS NULL
          ORDER BY tenant_id, completed_at DESC, id DESC
       )
       SELECT audit_tenants.tenant_id::text AS tenant_id
         FROM audit_tenants
         LEFT JOIN latest_runs USING (tenant_id)
        WHERE latest_runs.completed_at IS NULL
           OR latest_runs.completed_at <= $1::timestamptz - ($2::bigint * interval '1 millisecond')
        ORDER BY audit_tenants.tenant_id`,
      [now.toISOString(), AUDIT_VERIFIER_INTERVAL_MS],
    );
    return res.rows.map((row) => row.tenant_id);
  } finally {
    client.release();
  }
}

export async function resolveMaintenanceTenantIds(
  _pool: PgPool,
  configuredTenantIds: readonly string[],
  now: Date,
  options: LifecycleTenantDiscoveryOptions = {},
): Promise<readonly string[]> {
  if (configuredTenantIds.length > 0) return configuredTenantIds;
  const lifecycleBypassPool = requireLifecycleBypassPool(
    options.lifecycleBypassPool,
    "resolveMaintenanceTenantIds",
  );
  const client = await lifecycleBypassPool.connect();
  try {
    await assertLifecycleBypassUse(
      client as PoolClient,
      "scheduler_infra_worker_registry",
      "maintenance.tenant_discovery",
    );
    const res = await client.query<{ tenant_id: string }>(
      `WITH due_tenants AS (
         SELECT tenant_id
           FROM browser_leases
          WHERE state IN ('reserved','active')
            AND expires_at < $1::timestamptz
         UNION
         SELECT tenant_id
           FROM credential_leases
          WHERE status = 'active'
            AND locked_until < $1::timestamptz
         UNION
         SELECT tenant_id
           FROM human_tasks
          WHERE state IN ('open','assigned','in_progress','escalated')
            AND expires_at IS NOT NULL
            AND expires_at <= $1::timestamptz
         UNION
         SELECT tenant_id
           FROM workitems
          WHERE status = 'processing'
            AND checkout_paused_at IS NULL
            AND checkout_expires_at IS NOT NULL
            AND checkout_expires_at < $1::timestamptz
         UNION
          SELECT tenant_id
            FROM artifacts
           WHERE redaction_status = 'pending'
             AND redaction_attempts < $2::int
             AND deleted_at IS NULL
             AND quarantine = false
             AND legal_hold = false
             AND (lifecycle_claim_id IS NULL OR lifecycle_claim_expires_at <= $1::timestamptz)
          UNION
          SELECT tenant_id
            FROM ops_alert_notification_routes
           WHERE enabled = true
             AND deleted_at IS NULL
        )
       SELECT DISTINCT tenant_id::text AS tenant_id
         FROM due_tenants
        ORDER BY tenant_id`,
      [now.toISOString(), ARTIFACT_REDACTION_FAIL_THRESHOLD],
    );
    return res.rows.map((row) => row.tenant_id);
  } finally {
    client.release();
  }
}

export async function resolveDailyLifecycleTenantIds(
  configuredTenantIds: readonly string[],
  now: Date,
  options: LifecycleTenantDiscoveryOptions = {},
): Promise<readonly string[]> {
  if (configuredTenantIds.length > 0) return configuredTenantIds;
  const lifecycleBypassPool = requireLifecycleBypassPool(
    options.lifecycleBypassPool,
    "resolveDailyLifecycleTenantIds",
  );
  const client = await lifecycleBypassPool.connect();
  try {
    await assertLifecycleBypassUse(
      client as PoolClient,
      "artifact_integrity_checker",
      "artifact_lifecycle.daily_tenant_discovery",
    );
    const res = await client.query<{ tenant_id: string }>(
      `WITH due_tenants AS (
         SELECT tenant_id
           FROM artifacts
          WHERE deleted_at IS NULL
            AND legal_hold = false
            AND quarantine = false
            AND retention_until IS NOT NULL
            AND retention_until <= $1::timestamptz
         UNION
         SELECT tenant_id
           FROM artifacts
          WHERE deleted_at IS NULL
            AND quarantine = false
            AND redaction_status IN ('redacted','not_required')
            AND sha256 IS NOT NULL
       )
       SELECT DISTINCT tenant_id::text AS tenant_id
         FROM due_tenants
        ORDER BY tenant_id`,
      [now.toISOString()],
    );
    return res.rows.map((row) => row.tenant_id);
  } finally {
    client.release();
  }
}

export async function resolveRunTriggerTenantIds(
  _pool: PgPool,
  configuredTenantIds: readonly string[],
  now: Date,
  options: LifecycleTenantDiscoveryOptions = {},
): Promise<readonly string[]> {
  if (configuredTenantIds.length > 0) return configuredTenantIds;
  const lifecycleBypassPool = requireLifecycleBypassPool(
    options.lifecycleBypassPool,
    "resolveRunTriggerTenantIds",
  );
  const client = await lifecycleBypassPool.connect();
  try {
    await assertLifecycleBypassUse(
      client as PoolClient,
      "scheduler_infra_worker_registry",
      "maintenance.run_trigger_tenant_discovery",
    );
    const res = await client.query<{ tenant_id: string }>(
      `SELECT DISTINCT tenant_id::text AS tenant_id
         FROM run_triggers
        WHERE status = 'enabled'
          AND trigger_type = 'cron'
          AND next_fire_at IS NOT NULL
          AND next_fire_at <= $1::timestamptz
        ORDER BY tenant_id`,
      [now.toISOString()],
    );
    return res.rows.map((row) => row.tenant_id);
  } finally {
    client.release();
  }
}

function requireLifecycleBypassPool(pool: PgPool | undefined, caller: string): PgPool {
  if (pool !== undefined) return pool;
  throw new Error(
    `${caller} requires a dedicated BYPASSRLS lifecycle pool when MAINTENANCE_TENANT_IDS is empty`,
  );
}
