import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { ApiResponseError } from "../api/errors";
import type { RunEnqueuer } from "../api/run-queue";
import { createRunInTx } from "../api/server-create-run";
import { withTenantTx, type PgPool } from "../db/pool";
import { CronScheduleError, nextCronFireAfter } from "../runtime/run-trigger-schedule";

const DEFAULT_TRIGGER_BATCH_LIMIT = 25;

type CatchupPolicy = "skip_missed" | "fire_once";

interface DueRunTriggerRow {
  id: string;
  scenario_version_id: string;
  params: unknown;
  cron_expression: string;
  timezone: string;
  catchup_policy: CatchupPolicy;
  max_concurrent_runs: number;
  next_fire_at: Date;
}

export interface RunTriggerSchedulerOptions {
  readonly tenantIds: readonly string[];
  readonly enqueuer: RunEnqueuer;
  readonly now?: () => Date;
  readonly batchLimit?: number;
  readonly correlationId?: () => string;
}

export interface RunTriggerFireJobOptions {
  readonly tenantId: string;
  readonly triggerId: string;
  readonly scheduledFor: string;
  readonly enqueuer: RunEnqueuer;
  readonly now?: () => Date;
  readonly correlationId?: () => string;
}

export interface RunTriggerSchedulerStats {
  readonly tenantsScanned: number;
  readonly triggersClaimed: number;
  readonly fireLedgersCreated: number;
  readonly duplicateFires: number;
  readonly runsQueued: number;
  readonly firesSkipped: number;
  readonly firesFailed: number;
}

interface MutableRunTriggerSchedulerStats {
  tenantsScanned: number;
  triggersClaimed: number;
  fireLedgersCreated: number;
  duplicateFires: number;
  runsQueued: number;
  firesSkipped: number;
  firesFailed: number;
}

export async function processDueRunTriggers(
  pool: PgPool,
  options: RunTriggerSchedulerOptions,
): Promise<RunTriggerSchedulerStats> {
  const stats: MutableRunTriggerSchedulerStats = {
    tenantsScanned: 0,
    triggersClaimed: 0,
    fireLedgersCreated: 0,
    duplicateFires: 0,
    runsQueued: 0,
    firesSkipped: 0,
    firesFailed: 0,
  };
  const now = options.now ?? (() => new Date());
  const correlationId = options.correlationId ?? randomUUID;
  const batchLimit = normalizeBatchLimit(options.batchLimit);

  for (const tenantId of options.tenantIds) {
    stats.tenantsScanned += 1;
    await withTenantTx(pool, tenantId, (client) =>
      processTenantDueRunTriggers(client, {
        tenantId,
        enqueuer: options.enqueuer,
        now: now(),
        batchLimit,
        correlationId,
        stats,
      }),
    );
  }

  return stats;
}

export async function processRunTriggerFireJob(
  pool: PgPool,
  options: RunTriggerFireJobOptions,
): Promise<RunTriggerSchedulerStats> {
  const scheduledFor = parseScheduledFor(options.scheduledFor);
  const stats: MutableRunTriggerSchedulerStats = {
    tenantsScanned: 1,
    triggersClaimed: 0,
    fireLedgersCreated: 0,
    duplicateFires: 0,
    runsQueued: 0,
    firesSkipped: 0,
    firesFailed: 0,
  };
  const now = options.now ?? (() => new Date());
  const correlationId = options.correlationId ?? randomUUID;

  await withTenantTx(pool, options.tenantId, async (client) => {
    const trigger = await client.query<DueRunTriggerRow>(
      `SELECT id, scenario_version_id, params, cron_expression, timezone, catchup_policy, max_concurrent_runs, next_fire_at
         FROM run_triggers
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND trigger_type = 'cron'
          AND status = 'enabled'
          AND next_fire_at = $3::timestamptz
        FOR UPDATE`,
      [options.tenantId, options.triggerId, scheduledFor.toISOString()],
    );
    const row = trigger.rows[0];
    if (row === undefined) return;
    stats.triggersClaimed += 1;
    await processOneTriggerFire(client, {
      tenantId: options.tenantId,
      enqueuer: options.enqueuer,
      now: now(),
      batchLimit: 1,
      correlationId,
      stats,
    }, row);
  });

  return stats;
}

interface ProcessTenantInput {
  readonly tenantId: string;
  readonly enqueuer: RunEnqueuer;
  readonly now: Date;
  readonly batchLimit: number;
  readonly correlationId: () => string;
  readonly stats: MutableRunTriggerSchedulerStats;
}

async function processTenantDueRunTriggers(client: PoolClient, input: ProcessTenantInput): Promise<void> {
  const due = await client.query<DueRunTriggerRow>(
    `SELECT id, scenario_version_id, params, cron_expression, timezone, catchup_policy, max_concurrent_runs, next_fire_at
      FROM run_triggers
      WHERE tenant_id = $1::uuid
        AND trigger_type = 'cron'
        AND status = 'enabled'
        AND next_fire_at IS NOT NULL
        AND next_fire_at <= $2::timestamptz
      ORDER BY next_fire_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT $3`,
    [input.tenantId, input.now.toISOString(), input.batchLimit],
  );

  for (const trigger of due.rows) {
    input.stats.triggersClaimed += 1;
    await processOneTriggerFire(client, input, trigger);
  }
}

async function processOneTriggerFire(
  client: PoolClient,
  input: ProcessTenantInput,
  trigger: DueRunTriggerRow,
): Promise<void> {
  const scheduledFor = trigger.next_fire_at;
  const fireKey = scheduledFor.toISOString();
  const fireId = randomUUID();
  const correlationId = input.correlationId();

  const fire = await client.query<{ id: string }>(
    `INSERT INTO run_trigger_fires
       (id, tenant_id, trigger_id, fire_key, status, scheduled_for, correlation_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'queued', $5::timestamptz, $6::uuid)
     ON CONFLICT (tenant_id, trigger_id, fire_key) DO NOTHING
     RETURNING id`,
    [fireId, input.tenantId, trigger.id, fireKey, scheduledFor.toISOString(), correlationId],
  );
  if (fire.rowCount === 0) {
    input.stats.duplicateFires += 1;
    const duplicateNextFireAt = resolveNextFireAt(input, trigger);
    if (duplicateNextFireAt === null) {
      await pauseTriggerForInvalidSchedule(client, trigger);
    } else {
      await advanceTriggerSchedule(client, trigger, duplicateNextFireAt);
    }
    return;
  }
  input.stats.fireLedgersCreated += 1;

  const nextFireAt = resolveNextFireAt(input, trigger);
  if (nextFireAt === null) {
    await markFireFailed(client, fireId, {
      code: "SCHEDULER_INVALID_CRON_EXPRESSION",
      details: { reason: "invalid_cron_expression" },
    });
    await pauseTriggerForInvalidSchedule(client, trigger);
    input.stats.firesFailed += 1;
    return;
  }

  const active = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM run_trigger_fires f
       JOIN runs r ON r.tenant_id = f.tenant_id AND r.id = f.run_id
      WHERE f.tenant_id = $1::uuid
        AND f.trigger_id = $2::uuid
        AND r.status NOT IN ('completed','cancelled','failed_business','failed_system')`,
    [input.tenantId, trigger.id],
  );
  const activeRuns = active.rows[0]?.n ?? 0;
  if (activeRuns >= trigger.max_concurrent_runs) {
    await markFireSkipped(client, fireId, "MAX_CONCURRENCY_REACHED");
    await advanceTriggerSchedule(client, trigger, nextFireAt);
    input.stats.firesSkipped += 1;
    return;
  }

  await client.query("SAVEPOINT run_trigger_create_run");
  try {
    const runId = randomUUID();
    await createRunInTx(client, input.enqueuer, {
      tenantId: input.tenantId,
      scenarioVersionId: trigger.scenario_version_id,
      params: recordOrEmpty(trigger.params),
      asOf: scheduledFor.toISOString(),
      correlationId,
      runId,
    });
    await client.query(`UPDATE run_trigger_fires SET run_id=$1::uuid WHERE id=$2::uuid`, [runId, fireId]);
    await advanceTriggerSchedule(client, trigger, nextFireAt);
    await client.query("RELEASE SAVEPOINT run_trigger_create_run");
    input.stats.runsQueued += 1;
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT run_trigger_create_run");
    await markFireFailed(client, fireId, failureReason(err));
    await advanceTriggerSchedule(client, trigger, nextFireAt);
    await client.query("RELEASE SAVEPOINT run_trigger_create_run");
    input.stats.firesFailed += 1;
  }
}

async function markFireSkipped(client: PoolClient, fireId: string, reason: string): Promise<void> {
  await client.query(
    `UPDATE run_trigger_fires
        SET status='skipped', failure_reason=$2::jsonb
      WHERE id=$1::uuid`,
    [fireId, JSON.stringify({ code: reason })],
  );
}

async function markFireFailed(client: PoolClient, fireId: string, reason: Record<string, unknown>): Promise<void> {
  await client.query(
    `UPDATE run_trigger_fires
        SET status='failed', failure_reason=$2::jsonb
      WHERE id=$1::uuid`,
    [fireId, JSON.stringify(reason)],
  );
}

async function advanceTriggerSchedule(
  client: PoolClient,
  trigger: DueRunTriggerRow,
  nextFireAt: string,
): Promise<void> {
  await client.query(
    `UPDATE run_triggers
        SET next_fire_at = $3::timestamptz, updated_at = now()
      WHERE id=$1::uuid AND next_fire_at=$2::timestamptz`,
    [trigger.id, trigger.next_fire_at.toISOString(), nextFireAt],
  );
}

async function pauseTriggerForInvalidSchedule(client: PoolClient, trigger: DueRunTriggerRow): Promise<void> {
  await client.query(
    `UPDATE run_triggers
        SET status = 'paused', next_fire_at = NULL, updated_at = now()
      WHERE id=$1::uuid AND next_fire_at=$2::timestamptz`,
    [trigger.id, trigger.next_fire_at.toISOString()],
  );
}

function resolveNextFireAt(input: ProcessTenantInput, trigger: DueRunTriggerRow): string | null {
  const base = trigger.catchup_policy === "fire_once" ? trigger.next_fire_at : input.now;
  try {
    return nextCronFireAfter(trigger.cron_expression, trigger.timezone, base).toISOString();
  } catch (err) {
    if (err instanceof CronScheduleError) {
      return null;
    }
    throw err;
  }
}

function failureReason(error: unknown): Record<string, unknown> {
  if (error instanceof ApiResponseError) {
    return {
      code: error.code,
      details: error.details ?? null,
    };
  }
  return {
    code: "CONTROL_PLANE_INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function normalizeBatchLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TRIGGER_BATCH_LIMIT;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`run trigger scheduler batchLimit must be a positive integer, got ${value}`);
  }
  return value;
}

function parseScheduledFor(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`trigger_fire scheduledFor must be an ISO timestamp, got ${value}`);
  }
  return date;
}
