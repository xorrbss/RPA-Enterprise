import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { PgGraphileRunEnqueuer } from "../api/run-queue";
import type { PgPool } from "../db/pool";
import type { RuntimeWorkerJob } from "../../../ts/runtime-contract";
import type { CorrelationId, TenantId } from "../../../ts/security-middleware-contract";
import { processDueRunTriggers } from "./run-trigger-scheduler";
import { ARTIFACT_REDACTION_FAIL_THRESHOLD } from "./runtime-worker-artifact-lifecycle";
import { assertLifecycleBypassUse } from "./runtime-worker-lifecycle-audit";
import { runOpsNotificationFire } from "./ops-notification-fire";
import type { OpsAlertRoute } from "../api/ops-alert-routes";

export const MAINTENANCE_POLL_INTERVAL_MS = 5_000;
export const AUDIT_VERIFIER_INTERVAL_MS = 60 * 60 * 1000;
export const RETENTION_SWEEPER_HOUR_KST = 2;

type Timer = ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;

export interface MaintenanceScheduler {
  stop(): void;
}

export interface MaintenanceSchedulerOptions {
  readonly tenantIds: readonly string[];
  readonly lifecycleBypassPool?: PgPool;
  readonly pollIntervalMs?: number;
  readonly auditVerifierIntervalMs?: number;
  readonly retentionHourKst?: number;
  readonly enqueuer?: PgGraphileRunEnqueuer;
  readonly correlationId?: () => string;
  readonly now?: () => Date;
  readonly runTriggerBatchLimit?: number;
  readonly onError?: (err: unknown) => void;
  /** S4a: 무인 운영 알림 자동 발화 라우팅 규칙(env OPS_ALERT_ROUTES). 빈 값이면 자동 발화 없음. */
  readonly opsAlertRoutes?: readonly OpsAlertRoute[];
}

export function buildMaintenancePollJobs(
  tenantIds: readonly string[],
  correlationId: () => string = randomUUID,
): RuntimeWorkerJob[] {
  return tenantIds.flatMap((tenantId) => [
    { kind: "lease_sweeper", tenantId: tenantId as TenantId },
    {
      kind: "human_task_timeout_sweeper",
      tenantId: tenantId as TenantId,
      correlationId: correlationId() as CorrelationId,
    },
    {
      kind: "workitem_checkout_sweeper",
      tenantId: tenantId as TenantId,
      correlationId: correlationId() as CorrelationId,
    },
    {
      // 결재 fan-out 자동 트리거(②) — auto_fan_out 수집 시나리오 완료 run 을 검토 인박스로 자동 fan-out(멱등).
      kind: "approval_fan_out_sweeper",
      tenantId: tenantId as TenantId,
      correlationId: correlationId() as CorrelationId,
    },
    {
      kind: "artifact_redaction",
      tenantId: tenantId as TenantId,
      correlationId: correlationId() as CorrelationId,
    },
  ]);
}

export function buildAuditVerifierJobs(
  tenantIds: readonly string[],
  correlationId: () => string = randomUUID,
): RuntimeWorkerJob[] {
  return tenantIds.map((tenantId) => ({
    kind: "audit_verifier",
    tenantId: tenantId as TenantId,
    correlationId: correlationId() as CorrelationId,
  }));
}

export function buildRetentionSweeperJobs(
  tenantIds: readonly string[],
  correlationId: () => string = randomUUID,
): RuntimeWorkerJob[] {
  return tenantIds.map((tenantId) => ({
    kind: "artifact_retention",
    tenantId: tenantId as TenantId,
    correlationId: correlationId() as CorrelationId,
  }));
}

// impl-contracts §B artifact_integrity_checker(일배치): sha256 ↔ object 대조 → 불일치 quarantine. retention 과 같은 일 cadence.
export function buildIntegritySweeperJobs(
  tenantIds: readonly string[],
  correlationId: () => string = randomUUID,
): RuntimeWorkerJob[] {
  return tenantIds.map((tenantId) => ({
    kind: "artifact_integrity",
    tenantId: tenantId as TenantId,
    correlationId: correlationId() as CorrelationId,
  }));
}

// impl-contracts §B artifact_orphan_sweeper(일배치): 참조 없는 object 회수. **전역**(전 테넌트) 단일 job —
// object-store 는 테넌트 분할이 아니므로 per-tenant fanout 이 아니라 1회 전역 스캔(BYPASSRLS)으로 처리한다.
export function buildOrphanSweeperJob(correlationId: () => string = randomUUID): RuntimeWorkerJob {
  return { kind: "artifact_orphan", correlationId: correlationId() as CorrelationId };
}

// 일배치 묶음(retention + integrity per-tenant + orphan 전역 1건). 동일 cadence·idempotent.
export function buildDailySweeperJobs(
  tenantIds: readonly string[],
  correlationId: () => string = randomUUID,
): RuntimeWorkerJob[] {
  return [
    ...buildRetentionSweeperJobs(tenantIds, correlationId),
    ...buildIntegritySweeperJobs(tenantIds, correlationId),
    buildOrphanSweeperJob(correlationId),
  ];
}

export function millisecondsUntilNextKstHour(now: Date, hourKst: number): number {
  if (!Number.isInteger(hourKst) || hourKst < 0 || hourKst > 23) {
    throw new Error(`retentionHourKst must be an integer hour 0..23, got ${hourKst}`);
  }
  const kstOffsetMs = 9 * 60 * 60 * 1000;
  const kstNow = new Date(now.getTime() + kstOffsetMs);
  let nextUtcMs =
    Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate(), hourKst, 0, 0, 0) -
    kstOffsetMs;
  if (nextUtcMs <= now.getTime()) {
    nextUtcMs += 24 * 60 * 60 * 1000;
  }
  return nextUtcMs - now.getTime();
}

export function startMaintenanceScheduler(
  pool: PgPool,
  options: MaintenanceSchedulerOptions,
): MaintenanceScheduler | undefined {
  const enqueuer = options.enqueuer ?? new PgGraphileRunEnqueuer();
  const correlationId = options.correlationId ?? randomUUID;
  const pollIntervalMs = options.pollIntervalMs ?? MAINTENANCE_POLL_INTERVAL_MS;
  const auditVerifierIntervalMs = options.auditVerifierIntervalMs ?? AUDIT_VERIFIER_INTERVAL_MS;
  const retentionHourKst = options.retentionHourKst ?? RETENTION_SWEEPER_HOUR_KST;
  const now = options.now ?? (() => new Date());
  const onError = options.onError ?? ((err) => console.error(JSON.stringify({ at: "maintenance_scheduler", error: String(err) })));
  const timers: Timer[] = [];
  let stopped = false;
  let pollInFlight = false;
  let auditVerifierInFlight = false;
  let retentionInFlight = false;

  const opsAlertRoutes = options.opsAlertRoutes ?? [];
  // 휴면 경고는 poll 마다(5s) 반복하지 않고 한 번만 — 라우트가 설정됐는데 발화 대상 테넌트가 없어 조용히 안 나가는 상태.
  let warnedOpsFireDormant = false;
  const onOpsFireWarn = (message: string): void => {
    if (warnedOpsFireDormant) return;
    warnedOpsFireDormant = true;
    console.error(JSON.stringify({ at: "maintenance_scheduler", warn: message }));
  };

  const poll = (): void => {
    if (stopped || pollInFlight) return;
    pollInFlight = true;
    void runMaintenancePoll(pool, {
      tenantIds: options.tenantIds,
      enqueuer,
      correlationId,
      now,
      lifecycleBypassPool: options.lifecycleBypassPool,
      runTriggerBatchLimit: options.runTriggerBatchLimit,
      opsAlertRoutes,
      onOpsFireWarn,
    })
      .catch(onError)
      .finally(() => {
        pollInFlight = false;
      });
  };

  const auditVerifier = (): void => {
    if (stopped || auditVerifierInFlight) return;
    auditVerifierInFlight = true;
    void runAuditVerifier(pool, {
      tenantIds: options.tenantIds,
      enqueuer,
      correlationId,
      now,
      lifecycleBypassPool: options.lifecycleBypassPool,
    })
      .catch(onError)
      .finally(() => {
        auditVerifierInFlight = false;
      });
  };

  const scheduleRetention = (): void => {
    if (stopped) return;
    const timer = setTimeout(() => {
      if (stopped || retentionInFlight) {
        scheduleRetention();
        return;
      }
      retentionInFlight = true;
      runDailySweeper(pool, {
        tenantIds: options.tenantIds,
        lifecycleBypassPool: options.lifecycleBypassPool,
        enqueuer,
        correlationId,
        now,
      })
        .catch(onError)
        .finally(() => {
          retentionInFlight = false;
          scheduleRetention();
        });
    }, millisecondsUntilNextKstHour(now(), retentionHourKst));
    unrefTimer(timer);
    timers.push(timer);
  };

  poll();
  const pollTimer = setInterval(poll, pollIntervalMs);
  unrefTimer(pollTimer);
  timers.push(pollTimer);
  auditVerifier();
  const auditVerifierTimer = setInterval(auditVerifier, auditVerifierIntervalMs);
  unrefTimer(auditVerifierTimer);
  timers.push(auditVerifierTimer);
  scheduleRetention();

  return {
    stop() {
      stopped = true;
      for (const timer of timers) clearTimer(timer);
      timers.length = 0;
    },
  };
}

async function enqueueBatch(pool: PgPool, enqueuer: PgGraphileRunEnqueuer, jobs: readonly RuntimeWorkerJob[]): Promise<void> {
  if (jobs.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const job of jobs) {
      await enqueuer.enqueueRuntimeJob(client as PoolClient, job);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

interface MaintenancePollInput {
  readonly tenantIds: readonly string[];
  readonly lifecycleBypassPool?: PgPool;
  readonly enqueuer: PgGraphileRunEnqueuer;
  readonly correlationId: () => string;
  readonly now: () => Date;
  readonly runTriggerBatchLimit?: number;
  readonly opsAlertRoutes?: readonly OpsAlertRoute[];
  readonly onOpsFireWarn?: (message: string) => void;
}

async function runMaintenancePoll(pool: PgPool, input: MaintenancePollInput): Promise<void> {
  const maintenanceTenantIds = await resolveMaintenanceTenantIds(pool, input.tenantIds, input.now(), {
    lifecycleBypassPool: input.lifecycleBypassPool,
  });
  if (maintenanceTenantIds.length > 0) {
    await enqueueBatch(pool, input.enqueuer, buildMaintenancePollJobs(maintenanceTenantIds, input.correlationId));
  }
  // S4a/S4b: 무인 운영 알림 자동 발화 — 계산 알림을 라우트에 매칭해 발송 잡을 인큐(멱등). 스위퍼와 같은 테넌트 집합.
  // env 라우트가 비어도 항상 호출한다: 테넌트 저장형 라우트(ops_alert_notification_routes)는 fireForTenant 안에서
  // 테넌트별로 읽히므로, env 게이트를 두면 저장형 라우트만 있는 테넌트가 조용히 발화되지 않는다(무발화 함정).
  await runOpsNotificationFire(pool, {
    tenantIds: maintenanceTenantIds,
    routes: input.opsAlertRoutes ?? [],
    enqueuer: input.enqueuer,
    correlationId: input.correlationId,
    ...(input.onOpsFireWarn !== undefined ? { onWarn: input.onOpsFireWarn } : {}),
  });
  const triggerTenantIds = await resolveRunTriggerTenantIds(pool, input.tenantIds, input.now(), {
    lifecycleBypassPool: input.lifecycleBypassPool,
  });
  if (triggerTenantIds.length === 0) return;
  await processDueRunTriggers(pool, {
    tenantIds: triggerTenantIds,
    enqueuer: input.enqueuer,
    correlationId: input.correlationId,
    now: input.now,
    ...(input.runTriggerBatchLimit !== undefined ? { batchLimit: input.runTriggerBatchLimit } : {}),
  });
}

interface LifecycleTenantDiscoveryOptions {
  readonly lifecycleBypassPool?: PgPool;
}

interface DailySweeperInput {
  readonly tenantIds: readonly string[];
  readonly lifecycleBypassPool?: PgPool;
  readonly enqueuer: PgGraphileRunEnqueuer;
  readonly correlationId: () => string;
  readonly now: () => Date;
}

interface AuditVerifierInput {
  readonly tenantIds: readonly string[];
  readonly lifecycleBypassPool?: PgPool;
  readonly enqueuer: PgGraphileRunEnqueuer;
  readonly correlationId: () => string;
  readonly now: () => Date;
}

export async function runAuditVerifier(pool: PgPool, input: AuditVerifierInput): Promise<void> {
  const tenantIds = await resolveAuditVerifierTenantIds(input.tenantIds, input.now(), {
    lifecycleBypassPool: input.lifecycleBypassPool,
  });
  await enqueueBatch(pool, input.enqueuer, buildAuditVerifierJobs(tenantIds, input.correlationId));
}

export async function runDailySweeper(pool: PgPool, input: DailySweeperInput): Promise<void> {
  let tenantIds: readonly string[] = [];
  let discoveryError: unknown;
  try {
    tenantIds = await resolveDailyLifecycleTenantIds(input.tenantIds, input.now(), {
      lifecycleBypassPool: input.lifecycleBypassPool,
    });
  } catch (err) {
    discoveryError = err;
  }

  await enqueueBatch(pool, input.enqueuer, [
    ...buildRetentionSweeperJobs(tenantIds, input.correlationId),
    ...buildIntegritySweeperJobs(tenantIds, input.correlationId),
    buildOrphanSweeperJob(input.correlationId),
  ]);

  if (discoveryError !== undefined) throw discoveryError;
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

function unrefTimer(timer: Timer): void {
  const maybe = timer as { unref?: () => void };
  if (typeof maybe.unref === "function") maybe.unref();
}

function clearTimer(timer: Timer): void {
  clearTimeout(timer);
}
