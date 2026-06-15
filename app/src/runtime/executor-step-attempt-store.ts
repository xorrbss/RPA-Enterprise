import { randomUUID } from "node:crypto";

import type pg from "pg";

import type { IRActionType } from "../../../ts/core-types";
import type {
  EventId,
  ExecutorStepAttemptStartInput,
  ExecutorStepAttemptStartResult,
  ExecutorStepAttemptStore,
  StepExecutionKey,
} from "../../../ts/runtime-contract";
import { withTenantTx } from "../db/pool";
import { EVENTS_OUTBOX_RETENTION_POLICY, emitOutboxEvent } from "./outbox";

const FINAL_RUN_STATUSES = new Set(["completed", "cancelled", "failed_business", "failed_system"]);

export class PgExecutorStepAttemptRequiredError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(cause instanceof Error ? `${message}: ${cause.message}` : message);
    this.name = "PgExecutorStepAttemptRequiredError";
  }
}

export class PgExecutorStepAttemptStore implements ExecutorStepAttemptStore {
  constructor(private readonly pool: pg.Pool) {}

  async begin(input: ExecutorStepAttemptStartInput): Promise<ExecutorStepAttemptStartResult> {
    try {
      const normalized = validateStartInput(input);
      return await withTenantTx(this.pool, normalized.tenantId, (client) =>
        beginExecutorStepAttemptInTx(client, input),
      );
    } catch (error) {
      if (error instanceof PgExecutorStepAttemptRequiredError) throw error;
      throw new PgExecutorStepAttemptRequiredError("executor step attempt begin failed closed", error);
    }
  }
}

export async function beginExecutorStepAttemptInTx(
  client: pg.PoolClient,
  input: ExecutorStepAttemptStartInput,
): Promise<ExecutorStepAttemptStartResult> {
  const normalized = validateStartInput(input);
  await requireExecutableRun(client, normalized.tenantId, normalized.runId);
  const attempt = await nextAttempt(client, normalized.tenantId, normalized.runId, normalized.stepId);
  const runStepId = randomUUID();
  await client.query(
    `INSERT INTO run_steps (
       id, tenant_id, run_id, step_id, node_id, attempt, action, status,
       cache_mode, artifacts, stagehand_call_ids, started_at
     )
     VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::int, $7, 'started',
       'bypass', ARRAY[]::text[], ARRAY[]::text[], $8::timestamptz
     )`,
    [
      runStepId,
      normalized.tenantId,
      normalized.runId,
      normalized.stepId,
      normalized.nodeId,
      attempt,
      normalized.action,
      normalized.startedAt,
    ],
  );
  const started = await emitOutboxEvent(client, {
    tenantId: normalized.tenantId,
    eventType: "step.started",
    correlationId: normalized.correlationId,
    runId: normalized.runId,
    stepId: normalized.stepId,
    attempt,
    idempotencyKey: `${normalized.runId}:${normalized.stepId}:${attempt}:step.started`,
    occurredAt: normalized.startedAt,
    retentionPolicy: EVENTS_OUTBOX_RETENTION_POLICY,
  });
  return {
    key: {
      tenantId: normalized.tenantId as StepExecutionKey["tenantId"],
      runId: normalized.runId as StepExecutionKey["runId"],
      stepId: normalized.stepId as StepExecutionKey["stepId"],
      attempt,
    },
    runStepId,
    emittedEvents: [started.eventId as EventId],
  };
}

interface NormalizedStartInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly nodeId: string;
  readonly action: IRActionType;
  readonly correlationId: string;
  readonly startedAt: Date;
}

function validateStartInput(input: ExecutorStepAttemptStartInput): NormalizedStartInput {
  return {
    tenantId: requireString(input.tenantId, "tenantId"),
    runId: requireString(input.runId, "runId"),
    stepId: requireString(input.stepId, "stepId"),
    nodeId: requireString(input.nodeId, "nodeId"),
    action: requireAction(input.action),
    correlationId: requireString(input.correlationId, "correlationId"),
    startedAt: input.startedAt === undefined ? new Date() : parseIsoDate(input.startedAt, "startedAt"),
  };
}

async function requireExecutableRun(client: pg.PoolClient, tenantId: string, runId: string): Promise<void> {
  const run = await client.query<{ status: string }>(
    `SELECT status
       FROM runs
      WHERE tenant_id=$1::uuid AND id=$2::uuid
      FOR UPDATE`,
    [tenantId, runId],
  );
  const status = run.rows[0]?.status;
  if (status === undefined) {
    throw new PgExecutorStepAttemptRequiredError("executor step attempt run not found in tenant scope");
  }
  if (status !== "running") {
    if (FINAL_RUN_STATUSES.has(status)) {
      throw new PgExecutorStepAttemptRequiredError(`executor step attempt cannot start for terminal run status ${status}`);
    }
    throw new PgExecutorStepAttemptRequiredError(`executor step attempt requires run status running; got ${status}`);
  }
}

async function nextAttempt(client: pg.PoolClient, tenantId: string, runId: string, stepId: string): Promise<number> {
  const row = await client.query<{ attempt: number }>(
    `SELECT COALESCE(MAX(attempt), -1) + 1 AS attempt
       FROM run_steps
      WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND step_id=$3`,
    [tenantId, runId, stepId],
  );
  const attempt = row.rows[0]?.attempt;
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new PgExecutorStepAttemptRequiredError("executor step attempt could not allocate attempt");
  }
  return attempt;
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new PgExecutorStepAttemptRequiredError(`executor step attempt ${label} is required`);
}

function requireAction(value: unknown): IRActionType {
  const action = requireString(value, "action");
  switch (action) {
    case "act":
    case "observe":
    case "extract":
    case "navigate":
    case "download":
    case "upload":
    case "api_call":
    case "file":
    case "human_task":
    case "shell":
      return action;
    default:
      throw new PgExecutorStepAttemptRequiredError(`executor step attempt unsupported action ${action}`);
  }
}

function parseIsoDate(value: unknown, label: string): Date {
  const text = requireString(value, label);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new PgExecutorStepAttemptRequiredError(`executor step attempt ${label} must be an ISO timestamp`);
  }
  return date;
}
