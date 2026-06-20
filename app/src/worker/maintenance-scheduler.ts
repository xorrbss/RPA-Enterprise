import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { PgGraphileRunEnqueuer } from "../api/run-queue";
import type { PgPool } from "../db/pool";
import type { RuntimeWorkerJob } from "../../../ts/runtime-contract";
import type { CorrelationId, TenantId } from "../../../ts/security-middleware-contract";

export const MAINTENANCE_POLL_INTERVAL_MS = 5_000;
export const RETENTION_SWEEPER_HOUR_KST = 2;

type Timer = ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;

export interface MaintenanceScheduler {
  stop(): void;
}

export interface MaintenanceSchedulerOptions {
  readonly tenantIds: readonly string[];
  readonly pollIntervalMs?: number;
  readonly retentionHourKst?: number;
  readonly enqueuer?: PgGraphileRunEnqueuer;
  readonly correlationId?: () => string;
  readonly now?: () => Date;
  readonly onError?: (err: unknown) => void;
}

export function buildMaintenancePollJobs(
  tenantIds: readonly string[],
  correlationId: () => string = randomUUID,
): RuntimeWorkerJob[] {
  return tenantIds.flatMap((tenantId) => [
    { kind: "lease_sweeper", tenantId: tenantId as TenantId },
    {
      kind: "workitem_checkout_sweeper",
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
  if (options.tenantIds.length === 0) return undefined;

  const enqueuer = options.enqueuer ?? new PgGraphileRunEnqueuer();
  const correlationId = options.correlationId ?? randomUUID;
  const pollIntervalMs = options.pollIntervalMs ?? MAINTENANCE_POLL_INTERVAL_MS;
  const retentionHourKst = options.retentionHourKst ?? RETENTION_SWEEPER_HOUR_KST;
  const now = options.now ?? (() => new Date());
  const onError = options.onError ?? ((err) => console.error(JSON.stringify({ at: "maintenance_scheduler", error: String(err) })));
  const timers: Timer[] = [];
  let stopped = false;
  let pollInFlight = false;
  let retentionInFlight = false;

  const poll = (): void => {
    if (stopped || pollInFlight) return;
    pollInFlight = true;
    void enqueueBatch(pool, enqueuer, buildMaintenancePollJobs(options.tenantIds, correlationId))
      .catch(onError)
      .finally(() => {
        pollInFlight = false;
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
      enqueueBatch(pool, enqueuer, buildRetentionSweeperJobs(options.tenantIds, correlationId))
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

function unrefTimer(timer: Timer): void {
  const maybe = timer as { unref?: () => void };
  if (typeof maybe.unref === "function") maybe.unref();
}

function clearTimer(timer: Timer): void {
  clearTimeout(timer);
}
