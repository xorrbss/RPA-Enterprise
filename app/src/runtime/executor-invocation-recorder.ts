import type pg from "pg";

import { safeSerialize } from "../../../security/compliance-scaffold";
import type { StepResult, StepStatus } from "../../../ts/core-types";
import type {
  EventId,
  ExecutorInvocationArtifactMetadata,
  ExecutorInvocationRecordInput,
  ExecutorInvocationRecordResult,
  ExecutorInvocationRecorder,
} from "../../../ts/runtime-contract";
import { withTenantTx } from "../db/pool";
import { EVENTS_OUTBOX_RETENTION_POLICY, emitOutboxEvent } from "./outbox";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINAL_RECORDED_STATUSES = new Set<StepStatus>([
  "success",
  "failed_business",
  "failed_system",
  "failed_challenge",
  "failed_security",
  "uncertain",
]);

export class PgExecutorInvocationRecordRequiredError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(cause instanceof Error ? `${message}: ${cause.message}` : message);
    this.name = "PgExecutorInvocationRecordRequiredError";
  }
}

export class PgExecutorInvocationRecorder implements ExecutorInvocationRecorder {
  constructor(private readonly pool: pg.Pool) {}

  async record(input: ExecutorInvocationRecordInput): Promise<ExecutorInvocationRecordResult> {
    try {
      const normalized = validateInput(input);
      return await withTenantTx(this.pool, normalized.tenantId, (client) =>
        recordExecutorInvocationInTx(client, input),
      );
    } catch (error) {
      if (error instanceof PgExecutorInvocationRecordRequiredError) throw error;
      throw new PgExecutorInvocationRecordRequiredError("executor invocation record failed closed", error);
    }
  }
}

export async function recordExecutorInvocationInTx(
  client: pg.PoolClient,
  input: ExecutorInvocationRecordInput,
): Promise<ExecutorInvocationRecordResult> {
  const normalized = validateInput(input);
  await requireRun(client, normalized.tenantId, normalized.runId);
  const runStepId = await finalizeStartedRunStepOrThrow(client, normalized);
  await insertArtifactMetadata(client, runStepId, normalized);
  await requireStagehandCalls(client, normalized);
  const completed = await emitOutboxEvent(client, {
    tenantId: normalized.tenantId,
    eventType: "step.completed",
    correlationId: normalized.correlationId,
    runId: normalized.runId,
    stepId: normalized.stepId,
    attempt: normalized.attempt,
    idempotencyKey: `${normalized.runId}:${normalized.stepId}:${normalized.attempt}:step.completed`,
    occurredAt: normalized.endedAt,
    retentionPolicy: EVENTS_OUTBOX_RETENTION_POLICY,
  });
  return { runStepId, emittedEvents: [completed.eventId as EventId] };
}

interface NormalizedRecordInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly nodeId: string;
  readonly correlationId: string;
  readonly result: StepResult;
  readonly artifacts: readonly ExecutorInvocationArtifactMetadata[];
  readonly actionPlanCacheId: string | null;
  readonly sideEffectJson: string | null;
  readonly exceptionJson: string | null;
  readonly startedAt: Date;
  readonly endedAt: Date;
}

function validateInput(input: ExecutorInvocationRecordInput): NormalizedRecordInput {
  const tenantId = requireString(input.key.tenantId, "key.tenantId");
  const runId = requireString(input.key.runId, "key.runId");
  const stepId = requireString(input.key.stepId, "key.stepId");
  const nodeId = requireString(input.nodeId, "nodeId");
  const correlationId = requireString(input.correlationId, "correlationId");
  if (!Number.isInteger(input.key.attempt) || input.key.attempt < 0) {
    throw new PgExecutorInvocationRecordRequiredError("executor invocation attempt must be a non-negative integer");
  }
  if (input.result.stepId !== stepId) {
    throw new PgExecutorInvocationRecordRequiredError("executor invocation result.stepId must match key.stepId");
  }
  if (!FINAL_RECORDED_STATUSES.has(input.result.status)) {
    throw new PgExecutorInvocationRecordRequiredError(`executor invocation status '${input.result.status}' is not final-recordable`);
  }
  if (!Number.isInteger(input.result.timings.durationMs) || input.result.timings.durationMs < 0) {
    throw new PgExecutorInvocationRecordRequiredError("executor invocation durationMs must be a non-negative integer");
  }

  const startedAt = parseIsoDate(input.result.timings.startedAt, "result.timings.startedAt");
  const endedAt = parseIsoDate(input.result.timings.endedAt, "result.timings.endedAt");
  const actionPlanCacheId = input.result.cache.actionPlanCacheId ?? null;
  if (actionPlanCacheId !== null && !UUID_RE.test(actionPlanCacheId)) {
    throw new PgExecutorInvocationRecordRequiredError("executor invocation actionPlanCacheId must be a UUID when present");
  }

  assertNoPlainSecret(input.result.pageStateBefore, "result.pageStateBefore");
  assertNoPlainSecret(input.result.pageStateAfter, "result.pageStateAfter");
  assertNoPlainSecret(input.result.artifacts, "result.artifacts");
  assertNoPlainSecret(input.result.stagehandCallIds ?? [], "result.stagehandCallIds");
  assertNoPlainSecret(actionPlanCacheId, "result.cache.actionPlanCacheId");
  validateArtifactMetadata(input.result.artifacts, input.artifacts);
  validateStagehandRefs(input.result.stagehandCallIds ?? []);

  return {
    tenantId,
    runId,
    stepId,
    attempt: input.key.attempt,
    nodeId,
    correlationId,
    result: input.result,
    artifacts: input.artifacts,
    actionPlanCacheId,
    sideEffectJson: input.result.sideEffect === undefined ? null : safeSerialize(input.result.sideEffect),
    exceptionJson: input.result.exception === undefined ? null : safeSerialize(input.result.exception),
    startedAt,
    endedAt,
  };
}

async function requireRun(client: pg.PoolClient, tenantId: string, runId: string): Promise<void> {
  const run = await client.query(`SELECT 1 FROM runs WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`, [
    tenantId,
    runId,
  ]);
  if (run.rowCount !== 1) {
    throw new PgExecutorInvocationRecordRequiredError("executor invocation run not found in tenant scope");
  }
}

async function finalizeStartedRunStepOrThrow(
  client: pg.PoolClient,
  input: NormalizedRecordInput,
): Promise<string> {
  const finalized = await finalizeStartedRunStep(client, input);
  if (finalized !== undefined) return finalized;
  throw new PgExecutorInvocationRecordRequiredError(
    "executor invocation requires an existing local started attempt before producer writes",
  );
}

async function finalizeStartedRunStep(
  client: pg.PoolClient,
  input: NormalizedRecordInput,
): Promise<string | undefined> {
  const updated = await client.query<{ id: string }>(
    `UPDATE run_steps
        SET status = $1,
            cache_mode = $2,
            action_plan_cache_id = $3::uuid,
            page_state_before = $4,
            page_state_after = $5,
            artifacts = $6::text[],
            stagehand_call_ids = $7::text[],
            side_effect = $8::jsonb,
            exception = $9::jsonb,
            started_at = $10::timestamptz,
            ended_at = $11::timestamptz,
            duration_ms = $12::int
      WHERE tenant_id=$13::uuid
        AND run_id=$14::uuid
        AND step_id=$15
        AND node_id=$16
        AND attempt=$17::int
        AND action=$18
        AND status='started'
      RETURNING id::text`,
    [
      input.result.status,
      input.result.cache.mode,
      input.actionPlanCacheId,
      input.result.pageStateBefore,
      input.result.pageStateAfter,
      input.result.artifacts,
      input.result.stagehandCallIds ?? [],
      input.sideEffectJson,
      input.exceptionJson,
      input.startedAt,
      input.endedAt,
      input.result.timings.durationMs,
      input.tenantId,
      input.runId,
      input.stepId,
      input.nodeId,
      input.attempt,
      input.result.action,
    ],
  );
  return updated.rows[0]?.id;
}

async function insertArtifactMetadata(
  client: pg.PoolClient,
  _runStepId: string,
  input: NormalizedRecordInput,
): Promise<void> {
  for (const artifact of input.artifacts) {
    await client.query(
      `INSERT INTO artifacts (
         id, tenant_id, run_id, step_id, attempt, type, redaction_status,
         sha256, object_ref, retention_until, legal_hold, quarantine
       )
       VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5::int, $6, 'pending',
         $7, $8, $9::timestamptz, $10::boolean, $11::boolean
       )`,
      [
        inputArtifactId(artifact.artifactRef),
        input.tenantId,
        input.runId,
        input.stepId,
        input.attempt,
        artifact.type,
        artifact.sha256 ?? null,
        artifact.objectRef,
        artifact.retentionUntil,
        artifact.legalHold ?? false,
        artifact.quarantine ?? false,
      ],
    );
  }
}

async function requireStagehandCalls(client: pg.PoolClient, input: NormalizedRecordInput): Promise<void> {
  const ids = input.result.stagehandCallIds ?? [];
  if (ids.length === 0) return;
  const rows = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM stagehand_calls
      WHERE tenant_id=$1::uuid
        AND run_id=$2::uuid
        AND step_id=$3
        AND attempt=$4::int
        AND id::text = ANY($5::text[])`,
    [input.tenantId, input.runId, input.stepId, input.attempt, ids],
  );
  if ((rows.rows[0]?.n ?? 0) !== ids.length) {
    throw new PgExecutorInvocationRecordRequiredError("executor invocation stagehandCallIds are not durably persisted");
  }
}

function validateArtifactMetadata(
  artifactRefs: readonly string[],
  artifacts: readonly ExecutorInvocationArtifactMetadata[],
): void {
  const expected = new Set<string>(artifactRefs);
  const actual = new Set<string>(artifacts.map((artifact) => artifact.artifactRef));
  if (expected.size !== artifactRefs.length) {
    throw new PgExecutorInvocationRecordRequiredError("executor invocation artifact refs must be unique");
  }
  if (actual.size !== artifacts.length || expected.size !== actual.size) {
    throw new PgExecutorInvocationRecordRequiredError("executor invocation artifact metadata must exactly match StepResult.artifacts");
  }
  for (const ref of expected) {
    if (!actual.has(ref)) {
      throw new PgExecutorInvocationRecordRequiredError("executor invocation artifact metadata missing StepResult artifact ref");
    }
  }
  for (const artifact of artifacts) {
    requireString(artifact.artifactRef, "artifact.artifactRef");
    requireString(artifact.objectRef, "artifact.objectRef");
    requireString(artifact.type, "artifact.type");
    assertNoPlainSecret(artifact.sha256 ?? null, "artifact.sha256");
    parseIsoDate(artifact.retentionUntil, "artifact.retentionUntil");
    if (artifact.redactionStatus !== "pending") {
      throw new PgExecutorInvocationRecordRequiredError("executor invocation recorder may only create pending artifact metadata");
    }
  }
}

function inputArtifactId(ref: string): string {
  const artifactId = requireString(ref, "artifact.artifactRef");
  if (!UUID_RE.test(artifactId)) {
    throw new PgExecutorInvocationRecordRequiredError("executor invocation artifactRef must be an artifacts.id UUID");
  }
  return artifactId;
}

function validateStagehandRefs(ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) {
    throw new PgExecutorInvocationRecordRequiredError("executor invocation stagehandCallIds must be unique");
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    assertNoPlainSecret(value, label);
    return value;
  }
  throw new PgExecutorInvocationRecordRequiredError(`executor invocation ${label} is required`);
}

function parseIsoDate(value: unknown, label: string): Date {
  const text = requireString(value, label);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new PgExecutorInvocationRecordRequiredError(`executor invocation ${label} must be an ISO timestamp`);
  }
  return date;
}

function assertNoPlainSecret(value: unknown, label: string): void {
  try {
    safeSerialize(value);
  } catch (cause) {
    throw new PgExecutorInvocationRecordRequiredError(
      `executor invocation ${label} must not contain PlainSecret`,
      cause,
    );
  }
}
