import type pg from "pg";

import type {
  EventId,
  ExecutorInvocationRecordInput,
  ExecutorInvocationRecordResult,
  RuntimeWorkerJob,
} from "../../../ts/runtime-contract";
import type { SideEffectCmd, WorkitemState } from "../../../ts/state-machine-types";
import { withTenantTx } from "../db/pool";
import { applyRunTransition } from "./run-transition";
import { applyWorkitemTransition } from "./workitem-transition";
import { recordExecutorInvocationInTx } from "./executor-invocation-recorder";

export interface RuntimeJobEnqueuePort {
  enqueueRuntimeJob(client: pg.PoolClient, job: RuntimeWorkerJob): Promise<void>;
}

export interface ExecutorTerminalSuccessEvidence {
  readonly flowTerminalReached: true;
  readonly artifactFlushComplete: true;
  readonly outputFinalized: true;
  readonly usageFlushed: true;
  readonly sinkPolicyMet: true;
  readonly enqueueArtifactLifecycleJobs: true;
}

const TERMINAL_SUCCESS_EVIDENCE_KEYS = [
  "flowTerminalReached",
  "artifactFlushComplete",
  "outputFinalized",
  "usageFlushed",
  "sinkPolicyMet",
  "enqueueArtifactLifecycleJobs",
] as const satisfies ReadonlyArray<keyof ExecutorTerminalSuccessEvidence>;

const TERMINAL_SUCCESS_EVIDENCE_KEY_SET: ReadonlySet<string> = new Set(TERMINAL_SUCCESS_EVIDENCE_KEYS);

export interface ExecutorTerminalSuccessCompletionInput extends ExecutorInvocationRecordInput {
  readonly finalization: ExecutorTerminalSuccessEvidence;
}

export interface ExecutorTerminalSuccessCompletionResult {
  readonly record: ExecutorInvocationRecordResult;
  readonly emittedEvents: readonly EventId[];
  readonly enqueuedRuntimeJobs: readonly RuntimeWorkerJob[];
  readonly satisfiedSideEffects: readonly SideEffectCmd[];
}

export interface ExecutorTerminalBusinessFailureCompletionInput extends ExecutorInvocationRecordInput {}

export interface ExecutorTerminalBusinessFailureCompletionResult {
  readonly record: ExecutorInvocationRecordResult;
  readonly emittedEvents: readonly EventId[];
  readonly enqueuedRuntimeJobs: readonly RuntimeWorkerJob[];
}

export class PgExecutorCompletionRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PgExecutorCompletionRequiredError";
  }
}

export class PgExecutorCompletionCoordinator {
  constructor(
    private readonly pool: pg.Pool,
    private readonly runtimeJobEnqueuer?: RuntimeJobEnqueuePort,
  ) {}

  async completeTerminalSuccess(
    input: ExecutorTerminalSuccessCompletionInput,
  ): Promise<ExecutorTerminalSuccessCompletionResult> {
    if (input.result.status !== "success") {
      throw new PgExecutorCompletionRequiredError(
        `executor completion supports only success terminal steps; got ${input.result.status}`,
      );
    }
    assertTerminalSuccessEvidence(input.finalization);

    return withTenantTx(this.pool, input.key.tenantId, async (client) => {
      const record = await recordExecutorInvocationInTx(client, input);
      const run = await client.query<{ status: string; workitem_id: string | null; correlation_id: string }>(
        `SELECT status, workitem_id::text, correlation_id::text
           FROM runs
          WHERE tenant_id=$1::uuid AND id=$2::uuid
          FOR UPDATE`,
        [input.key.tenantId, input.key.runId],
      );
      const runRow = run.rows[0];
      if (runRow === undefined) {
        throw new PgExecutorCompletionRequiredError("executor completion run not found in tenant scope");
      }
      if (runRow.status !== "running") {
        throw new PgExecutorCompletionRequiredError(
          `executor completion requires run status running; got ${runRow.status}`,
        );
      }

      const r7 = await applyRunTransition(client, {
        tenantId: input.key.tenantId,
        runId: input.key.runId,
        fromStatus: "running",
        event: { type: "last_node_success" },
        guard: { flowTerminalReached: true },
        correlationId: input.correlationId,
        eventIdempotencyKey: `${input.key.runId}:${input.key.stepId}:${input.key.attempt}:terminal-success`,
        occurredAt: new Date(input.result.timings.endedAt),
      });
      if (!r7.applied) {
        throw new PgExecutorCompletionRequiredError(
          `executor completion R7 CAS conflict; observed=${r7.observed ?? "null"}`,
        );
      }

      const r21 = await applyRunTransition(client, {
        tenantId: input.key.tenantId,
        runId: input.key.runId,
        fromStatus: "completing",
        event: { type: "finalize_ok" },
        guard: { finalizeOk: true },
        correlationId: input.correlationId,
        eventIdempotencyKey: `${input.key.runId}:${input.key.stepId}:${input.key.attempt}:terminal-finalize`,
        occurredAt: new Date(input.result.timings.endedAt),
      });
      if (!r21.applied) {
        throw new PgExecutorCompletionRequiredError(
          `executor completion R21 CAS conflict; observed=${r21.observed ?? "null"}`,
        );
      }

      const satisfiedSideEffects = assertSatisfiedFinalizationSideEffects([...r7.pending, ...r21.pending]);
      const workitemEvents: EventId[] = [];
      if (runRow.workitem_id !== null) {
        const workitem = await client.query<{ status: WorkitemState }>(
          `SELECT status
             FROM workitems
            WHERE tenant_id=$1::uuid AND id=$2::uuid
            FOR UPDATE`,
          [input.key.tenantId, runRow.workitem_id],
        );
        const workitemStatus = workitem.rows[0]?.status;
        if (workitemStatus !== "processing") {
          throw new PgExecutorCompletionRequiredError(
            `executor completion requires linked workitem status processing; got ${workitemStatus ?? "missing"}`,
          );
        }
        const w2 = await applyWorkitemTransition(client, {
          tenantId: input.key.tenantId,
          workitemId: runRow.workitem_id,
          fromStatus: "processing",
          event: { type: "run_succeeded" },
          guard: { sinkPolicyMet: true },
          correlationId: input.correlationId,
          runId: input.key.runId,
          eventIdempotencyKey: `${input.key.runId}:${input.key.stepId}:${input.key.attempt}:workitem-success`,
          occurredAt: new Date(input.result.timings.endedAt),
        });
        if (!w2.applied) {
          throw new PgExecutorCompletionRequiredError(
            `executor completion W2 CAS conflict; observed=${w2.observed ?? "null"}`,
          );
        }
        if (w2.pending.length > 0) {
          throw new PgExecutorCompletionRequiredError("executor completion W2 produced unsupported pending side effects");
        }
        workitemEvents.push(...w2.emitted.map((event) => event.eventId as EventId));
      }
      const enqueuedRuntimeJobs = await enqueueArtifactLifecycleJobs(client, {
        tenantId: input.key.tenantId,
        runId: input.key.runId,
        correlationId: input.correlationId,
        artifactCount: input.artifacts.length,
        enqueuer: this.runtimeJobEnqueuer,
      });

      return {
        record,
        emittedEvents: [
          ...record.emittedEvents,
          ...r7.emitted.map((event) => event.eventId as EventId),
          ...r21.emitted.map((event) => event.eventId as EventId),
          ...workitemEvents,
        ],
        enqueuedRuntimeJobs,
        satisfiedSideEffects,
      };
    });
  }

  async completeTerminalBusinessFailure(
    input: ExecutorTerminalBusinessFailureCompletionInput,
  ): Promise<ExecutorTerminalBusinessFailureCompletionResult> {
    if (input.result.status !== "failed_business") {
      throw new PgExecutorCompletionRequiredError(
        `executor business failure completion requires failed_business StepResult; got ${input.result.status}`,
      );
    }
    if (input.result.exception?.class !== "business") {
      throw new PgExecutorCompletionRequiredError("executor business failure completion requires exception.class=business");
    }

    return withTenantTx(this.pool, input.key.tenantId, async (client) => {
      const record = await recordExecutorInvocationInTx(client, input);
      const run = await client.query<{ status: string; workitem_id: string | null; correlation_id: string }>(
        `SELECT status, workitem_id::text, correlation_id::text
           FROM runs
          WHERE tenant_id=$1::uuid AND id=$2::uuid
          FOR UPDATE`,
        [input.key.tenantId, input.key.runId],
      );
      const runRow = run.rows[0];
      if (runRow === undefined) {
        throw new PgExecutorCompletionRequiredError("executor business failure run not found in tenant scope");
      }
      if (runRow.status !== "running") {
        throw new PgExecutorCompletionRequiredError(
          `executor business failure requires run status running; got ${runRow.status}`,
        );
      }

      const r9 = await applyRunTransition(client, {
        tenantId: input.key.tenantId,
        runId: input.key.runId,
        fromStatus: "running",
        event: { type: "business_exception" },
        guard: { exceptionClass: "business" },
        correlationId: input.correlationId,
        eventIdempotencyKey: `${input.key.runId}:${input.key.stepId}:${input.key.attempt}:terminal-business-failure`,
        occurredAt: new Date(input.result.timings.endedAt),
      });
      if (!r9.applied) {
        throw new PgExecutorCompletionRequiredError(
          `executor business failure R9 CAS conflict; observed=${r9.observed ?? "null"}`,
        );
      }
      if (r9.pending.length > 0) {
        throw new PgExecutorCompletionRequiredError("executor business failure R9 produced unsupported pending side effects");
      }

      if (runRow.workitem_id !== null) {
        const workitem = await client.query<{ status: WorkitemState }>(
          `SELECT status
             FROM workitems
            WHERE tenant_id=$1::uuid AND id=$2::uuid
            FOR UPDATE`,
          [input.key.tenantId, runRow.workitem_id],
        );
        const workitemStatus = workitem.rows[0]?.status;
        if (workitemStatus !== "processing") {
          throw new PgExecutorCompletionRequiredError(
            `executor business failure requires linked workitem status processing; got ${workitemStatus ?? "missing"}`,
          );
        }
        const w3 = await applyWorkitemTransition(client, {
          tenantId: input.key.tenantId,
          workitemId: runRow.workitem_id,
          fromStatus: "processing",
          event: { type: "business_exception" },
          guard: {},
          correlationId: input.correlationId,
          runId: input.key.runId,
          eventIdempotencyKey: `${input.key.runId}:${input.key.stepId}:${input.key.attempt}:workitem-business-failure`,
          occurredAt: new Date(input.result.timings.endedAt),
        });
        if (!w3.applied) {
          throw new PgExecutorCompletionRequiredError(
            `executor business failure W3 CAS conflict; observed=${w3.observed ?? "null"}`,
          );
        }
        if (w3.pending.length > 0) {
          throw new PgExecutorCompletionRequiredError("executor business failure W3 produced unsupported pending side effects");
        }
      }

      const enqueuedRuntimeJobs = await enqueueArtifactLifecycleJobs(client, {
        tenantId: input.key.tenantId,
        runId: input.key.runId,
        correlationId: input.correlationId,
        artifactCount: input.artifacts.length,
        enqueuer: this.runtimeJobEnqueuer,
      });

      return {
        record,
        emittedEvents: [...record.emittedEvents, ...r9.emitted.map((event) => event.eventId as EventId)],
        enqueuedRuntimeJobs,
      };
    });
  }
}

function assertTerminalSuccessEvidence(evidence: ExecutorTerminalSuccessEvidence): void {
  const record = evidence as unknown as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !TERMINAL_SUCCESS_EVIDENCE_KEY_SET.has(key));
  if (unknownKeys.length > 0) {
    throw new PgExecutorCompletionRequiredError(
      `executor completion received unknown finalization evidence key: ${unknownKeys.join(",")}`,
    );
  }
  for (const key of TERMINAL_SUCCESS_EVIDENCE_KEYS) {
    if (record[key] !== true) {
      throw new PgExecutorCompletionRequiredError(`executor completion requires finalization evidence: ${key}`);
    }
  }
}

function assertSatisfiedFinalizationSideEffects(sideEffects: readonly SideEffectCmd[]): readonly SideEffectCmd[] {
  const allowed = new Set(["finalizeOutputs", "flushArtifacts", "usageFlush"]);
  for (const sideEffect of sideEffects) {
    if (!allowed.has(sideEffect.kind)) {
      throw new PgExecutorCompletionRequiredError(
        `executor completion produced unsupported pending side effect ${sideEffect.kind}`,
      );
    }
  }
  if (!sideEffects.some((sideEffect) => sideEffect.kind === "finalizeOutputs")) {
    throw new PgExecutorCompletionRequiredError("executor completion missing finalizeOutputs side effect evidence");
  }
  return sideEffects;
}

async function enqueueArtifactLifecycleJobs(
  client: pg.PoolClient,
  input: {
    tenantId: string;
    runId: string;
    correlationId: string;
    artifactCount: number;
    enqueuer: RuntimeJobEnqueuePort | undefined;
  },
): Promise<RuntimeWorkerJob[]> {
  if (input.artifactCount === 0) return [];
  if (input.enqueuer === undefined) {
    throw new PgExecutorCompletionRequiredError(
      "executor completion with artifacts requires a RuntimeJobEnqueuePort for lifecycle jobs",
    );
  }
  const jobs: RuntimeWorkerJob[] = [
    {
      kind: "artifact_redaction",
      tenantId: input.tenantId as RuntimeWorkerJob["tenantId"],
      runId: input.runId as RuntimeWorkerJob["runId"],
      correlationId: input.correlationId as RuntimeWorkerJob["correlationId"],
    },
    {
      kind: "artifact_retention",
      tenantId: input.tenantId as RuntimeWorkerJob["tenantId"],
      correlationId: input.correlationId as RuntimeWorkerJob["correlationId"],
    },
  ];
  for (const job of jobs) {
    await input.enqueuer.enqueueRuntimeJob(client, job);
  }
  return jobs;
}
