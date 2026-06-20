import type pg from "pg";

import type { ArtifactRef, ClassifiedException } from "../../../ts/core-types";
import { ERROR_CATALOG, type ErrorCode } from "../../../ts/error-catalog";
import type {
  EventId,
  ExecutorInvocationRecordInput,
  ExecutorInvocationRecordResult,
  RuntimeWorkerJob,
} from "../../../ts/runtime-contract";
import type { SideEffectCmd } from "../../../ts/state-machine-types";
import { withTenantTx } from "../db/pool";
import { applyRunTransition } from "./run-transition";
import { settleLinkedWorkitemForRunTerminal } from "./workitem-settlement";
import { recordExecutorInvocationInTx } from "./executor-invocation-recorder";

export interface RuntimeJobEnqueuePort {
  enqueueRuntimeJob(client: pg.PoolClient, job: RuntimeWorkerJob): Promise<void>;
}

export interface ExecutorSecurityNotificationPort {
  notifySecurityException(
    client: pg.PoolClient,
    input: {
      tenantId: string;
      runId: string;
      stepId: string;
      attempt: number;
      correlationId: string;
      exception: ClassifiedException;
    },
  ): Promise<void>;
}

export interface ExecutorChallengeSuspensionPort {
  // challenge(R4) 와 @human_task(R5) 두 suspend 트리거가 공유하는 human_task 생성 포트(human_tasks INSERT + human_task.created
  // emit + suspend bookmark). humanTaskKind 는 pendingSideEffects 의 createHumanTask 에서 온다(하드코딩 금지).
  suspendForChallenge(
    client: pg.PoolClient,
    input: {
      tenantId: string;
      runId: string;
      stepId: string;
      attempt: number;
      correlationId: string;
      exception: ClassifiedException;
      pendingSideEffects: readonly SideEffectCmd[];
      // @human_task(R5) suspend 시 human_tasks 라우팅/타임아웃 정책(reserved-handlers). challenge(R4)는 omit(둘 다 부재).
      assigneeRole?: string;
      onTimeout?: "fail" | "escalate";
      // bookmark reason 마커("challenge"|"human_task"). 미지정 시 "challenge"(기존 동작 보존).
      reason?: string;
    },
  ): Promise<{ readonly emittedEvents: readonly EventId[]; readonly enqueuedRuntimeJobs?: readonly RuntimeWorkerJob[] }>;
}

export interface PgExecutorCompletionCoordinatorOptions {
  readonly workitemMaxAttempts?: number;
  readonly securityNotificationPort?: ExecutorSecurityNotificationPort;
  readonly challengeSuspensionPort?: ExecutorChallengeSuspensionPort;
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

export interface ExecutorTerminalOutcomeCompletionInput extends ExecutorInvocationRecordInput {
  readonly finalization?: ExecutorTerminalSuccessEvidence;
}

export interface ExecutorTerminalOutcomeCompletionResult {
  readonly record: ExecutorInvocationRecordResult;
  readonly emittedEvents: readonly EventId[];
  readonly enqueuedRuntimeJobs: readonly RuntimeWorkerJob[];
  readonly satisfiedSideEffects: readonly SideEffectCmd[];
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
    private readonly options: PgExecutorCompletionCoordinatorOptions = {},
  ) {}

  async completeTerminalOutcome(
    input: ExecutorTerminalOutcomeCompletionInput,
  ): Promise<ExecutorTerminalOutcomeCompletionResult> {
    switch (input.result.status) {
      case "success": {
        if (input.finalization === undefined) {
          throw new PgExecutorCompletionRequiredError("executor success outcome requires terminal finalization evidence");
        }
        const success = await this.completeTerminalSuccess({ ...input, finalization: input.finalization });
        return {
          record: success.record,
          emittedEvents: success.emittedEvents,
          enqueuedRuntimeJobs: success.enqueuedRuntimeJobs,
          satisfiedSideEffects: success.satisfiedSideEffects,
        };
      }
      case "failed_business": {
        const business = await this.completeTerminalBusinessFailure(input);
        return {
          record: business.record,
          emittedEvents: business.emittedEvents,
          enqueuedRuntimeJobs: business.enqueuedRuntimeJobs,
          satisfiedSideEffects: [],
        };
      }
      case "failed_system":
      case "uncertain":
        return this.completeTerminalSystemFailure(input);
      case "failed_security":
        return this.completeTerminalSecurityFailure(input);
      case "failed_challenge":
        return this.completeTerminalChallengeFailure(input);
      case "skipped":
      case "suspended":
        throw new PgExecutorCompletionRequiredError(
          `executor outcome status ${input.result.status} is not terminal-outcome-mappable`,
        );
      default: {
        const exhaustive: never = input.result.status;
        throw new PgExecutorCompletionRequiredError(`executor outcome status ${String(exhaustive)} is unknown`);
      }
    }
  }

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
      const w2 = await settleLinkedWorkitemForRunTerminal(client, runRow.workitem_id, {
        tenantId: input.key.tenantId,
        runId: input.key.runId,
        correlationId: input.correlationId,
        terminal: "success",
        eventIdempotencyKey: `${input.key.runId}:${input.key.stepId}:${input.key.attempt}:workitem-success`,
        occurredAt: new Date(input.result.timings.endedAt),
        maxAttempts: this.workitemMaxAttempts(),
      });
      const workitemEvents: EventId[] = w2.emitted.map((event) => event.eventId as EventId);
      const enqueuedRuntimeJobs = await enqueueArtifactLifecycleJobs(client, {
        tenantId: input.key.tenantId,
        runId: input.key.runId,
        correlationId: input.correlationId,
        artifactRefs: input.artifacts.map((artifact) => artifact.artifactRef),
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

      await settleLinkedWorkitemForRunTerminal(client, runRow.workitem_id, {
        tenantId: input.key.tenantId,
        runId: input.key.runId,
        correlationId: input.correlationId,
        terminal: "business",
        eventIdempotencyKey: `${input.key.runId}:${input.key.stepId}:${input.key.attempt}:workitem-business-failure`,
        occurredAt: new Date(input.result.timings.endedAt),
        maxAttempts: this.workitemMaxAttempts(),
      });

      const enqueuedRuntimeJobs = await enqueueArtifactLifecycleJobs(client, {
        tenantId: input.key.tenantId,
        runId: input.key.runId,
        correlationId: input.correlationId,
        artifactRefs: input.artifacts.map((artifact) => artifact.artifactRef),
        enqueuer: this.runtimeJobEnqueuer,
      });

      return {
        record,
        emittedEvents: [...record.emittedEvents, ...r9.emitted.map((event) => event.eventId as EventId)],
        enqueuedRuntimeJobs,
      };
    });
  }

  private async completeTerminalSystemFailure(
    input: ExecutorTerminalOutcomeCompletionInput,
  ): Promise<ExecutorTerminalOutcomeCompletionResult> {
    const exception = requireCatalogException(input, {
      expectedClass: "system",
      label: input.result.status === "uncertain" ? "executor uncertain outcome" : "executor system failure",
    });

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
        throw new PgExecutorCompletionRequiredError("executor system failure run not found in tenant scope");
      }
      if (runRow.status !== "running") {
        throw new PgExecutorCompletionRequiredError(
          `executor system failure requires run status running; got ${runRow.status}`,
        );
      }

      const r8 = await applyRunTransition(client, {
        tenantId: input.key.tenantId,
        runId: input.key.runId,
        fromStatus: "running",
        event: { type: "unrecoverable_exception" },
        guard: { exceptionClass: "system" },
        correlationId: input.correlationId,
        eventIdempotencyKey: `${input.key.runId}:${input.key.stepId}:${input.key.attempt}:terminal-system-failure`,
        occurredAt: new Date(input.result.timings.endedAt),
      });
      if (!r8.applied) {
        throw new PgExecutorCompletionRequiredError(
          `executor system failure R8 CAS conflict; observed=${r8.observed ?? "null"}`,
        );
      }
      assertOnlyPendingKinds(r8.pending, ["captureFailureScreenshot", "evaluateDeadLetter"], "executor system failure R8");

      const satisfiedSideEffects: SideEffectCmd[] = [...r8.pending];
      const wi = await settleLinkedWorkitemForRunTerminal(client, runRow.workitem_id, {
        tenantId: input.key.tenantId,
        runId: input.key.runId,
        correlationId: input.correlationId,
        terminal: "system",
        eventIdempotencyKey: `${input.key.runId}:${input.key.stepId}:${input.key.attempt}:workitem-system-failure`,
        occurredAt: new Date(input.result.timings.endedAt),
        maxAttempts: this.workitemMaxAttempts(),
        systemReasonCode: exception.code as ErrorCode,
        ...(exception.evidenceRefs?.[0] !== undefined ? { systemEvidenceRef: exception.evidenceRefs[0] } : {}),
      });
      satisfiedSideEffects.push(...wi.satisfiedPending);
      const workitemEvents: EventId[] = wi.emitted.map((event) => event.eventId as EventId);

      const enqueuedRuntimeJobs = await enqueueArtifactLifecycleJobs(client, {
        tenantId: input.key.tenantId,
        runId: input.key.runId,
        correlationId: input.correlationId,
        artifactRefs: input.artifacts.map((artifact) => artifact.artifactRef),
        enqueuer: this.runtimeJobEnqueuer,
      });

      return {
        record,
        emittedEvents: [
          ...record.emittedEvents,
          ...r8.emitted.map((event) => event.eventId as EventId),
          ...workitemEvents,
        ],
        enqueuedRuntimeJobs,
        satisfiedSideEffects,
      };
    });
  }

  private async completeTerminalSecurityFailure(
    input: ExecutorTerminalOutcomeCompletionInput,
  ): Promise<ExecutorTerminalOutcomeCompletionResult> {
    const exception = requireCatalogException(input, {
      expectedClass: "security",
      label: "executor security failure",
    });
    if (this.runtimeJobEnqueuer === undefined) {
      throw new PgExecutorCompletionRequiredError("executor security failure requires a RuntimeJobEnqueuePort for run_abort");
    }
    const enqueuer = this.runtimeJobEnqueuer;
    const notifier = this.options.securityNotificationPort;
    if (notifier === undefined) {
      throw new PgExecutorCompletionRequiredError("executor security failure requires an ExecutorSecurityNotificationPort");
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
        throw new PgExecutorCompletionRequiredError("executor security failure run not found in tenant scope");
      }
      if (runRow.status !== "running") {
        throw new PgExecutorCompletionRequiredError(
          `executor security failure requires run status running; got ${runRow.status}`,
        );
      }

      const r10 = await applyRunTransition(client, {
        tenantId: input.key.tenantId,
        runId: input.key.runId,
        fromStatus: "running",
        event: { type: "security_exception" },
        guard: { exceptionClass: "security" },
        correlationId: input.correlationId,
        eventIdempotencyKey: `${input.key.runId}:${input.key.stepId}:${input.key.attempt}:terminal-security-failure`,
        occurredAt: new Date(input.result.timings.endedAt),
      });
      if (!r10.applied) {
        throw new PgExecutorCompletionRequiredError(
          `executor security failure R10 CAS conflict; observed=${r10.observed ?? "null"}`,
        );
      }
      assertOnlyPendingKinds(r10.pending, ["sseClose", "browserDrain", "notify"], "executor security failure R10");

      const sourceRecorded = await client.query(
        `UPDATE runs
            SET abort_source_status = 'running'
          WHERE tenant_id = $1::uuid
            AND id = $2::uuid
            AND status = 'aborting'`,
        [input.key.tenantId, input.key.runId],
      );
      if (sourceRecorded.rowCount !== 1) {
        throw new PgExecutorCompletionRequiredError("executor security failure could not persist abort_source_status");
      }

      const runAbortJob: RuntimeWorkerJob = {
        kind: "run_abort",
        tenantId: input.key.tenantId as RuntimeWorkerJob["tenantId"],
        runId: input.key.runId as RuntimeWorkerJob["runId"],
        correlationId: input.correlationId as RuntimeWorkerJob["correlationId"],
      };
      await enqueuer.enqueueRuntimeJob(client, runAbortJob);
      await notifier.notifySecurityException(client, {
        tenantId: input.key.tenantId,
        runId: input.key.runId,
        stepId: input.key.stepId,
        attempt: input.key.attempt,
        correlationId: input.correlationId,
        exception,
      });
      const lifecycleJobs = await enqueueArtifactLifecycleJobs(client, {
        tenantId: input.key.tenantId,
        runId: input.key.runId,
        correlationId: input.correlationId,
        artifactRefs: input.artifacts.map((artifact) => artifact.artifactRef),
        enqueuer,
      });

      return {
        record,
        emittedEvents: [...record.emittedEvents, ...r10.emitted.map((event) => event.eventId as EventId)],
        enqueuedRuntimeJobs: [runAbortJob, ...lifecycleJobs],
        satisfiedSideEffects: r10.pending,
      };
    });
  }

  private async completeTerminalChallengeFailure(
    input: ExecutorTerminalOutcomeCompletionInput,
  ): Promise<ExecutorTerminalOutcomeCompletionResult> {
    const exception = requireCatalogException(input, {
      expectedClass: "challenge",
      label: "executor challenge failure",
    });
    const suspensionPort = this.options.challengeSuspensionPort;
    if (suspensionPort === undefined) {
      throw new PgExecutorCompletionRequiredError("executor challenge failure requires an ExecutorChallengeSuspensionPort");
    }

    return withTenantTx(this.pool, input.key.tenantId, async (client) => {
      const record = await recordExecutorInvocationInTx(client, input);
      const run = await client.query<{ status: string }>(
        `SELECT status
           FROM runs
          WHERE tenant_id=$1::uuid AND id=$2::uuid
          FOR UPDATE`,
        [input.key.tenantId, input.key.runId],
      );
      const runStatus = run.rows[0]?.status;
      if (runStatus !== "running") {
        throw new PgExecutorCompletionRequiredError(
          `executor challenge failure requires run status running; got ${runStatus ?? "missing"}`,
        );
      }

      const r4 = await applyRunTransition(client, {
        tenantId: input.key.tenantId,
        runId: input.key.runId,
        fromStatus: "running",
        event: { type: "step.challenge_detected" },
        guard: {},
        correlationId: input.correlationId,
        eventIdempotencyKey: `${input.key.runId}:${input.key.stepId}:${input.key.attempt}:challenge-detected`,
        occurredAt: new Date(input.result.timings.endedAt),
      });
      if (!r4.applied) {
        throw new PgExecutorCompletionRequiredError(
          `executor challenge failure R4 CAS conflict; observed=${r4.observed ?? "null"}`,
        );
      }
      assertOnlyPendingKinds(r4.pending, ["createHumanTask", "startBookmark"], "executor challenge failure R4");
      const suspension = await suspensionPort.suspendForChallenge(client, {
        tenantId: input.key.tenantId,
        runId: input.key.runId,
        stepId: input.key.stepId,
        attempt: input.key.attempt,
        correlationId: input.correlationId,
        exception,
        pendingSideEffects: r4.pending,
      });
      const lifecycleJobs = await enqueueArtifactLifecycleJobs(client, {
        tenantId: input.key.tenantId,
        runId: input.key.runId,
        correlationId: input.correlationId,
        artifactRefs: input.artifacts.map((artifact) => artifact.artifactRef),
        enqueuer: this.runtimeJobEnqueuer,
      });

      return {
        record,
        emittedEvents: [
          ...record.emittedEvents,
          ...r4.emitted.map((event) => event.eventId as EventId),
          ...suspension.emittedEvents,
        ],
        enqueuedRuntimeJobs: [...(suspension.enqueuedRuntimeJobs ?? []), ...lifecycleJobs],
        satisfiedSideEffects: r4.pending,
      };
    });
  }

  private workitemMaxAttempts(): number {
    const maxAttempts = this.options.workitemMaxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
      throw new PgExecutorCompletionRequiredError("executor completion workitemMaxAttempts must be a positive integer");
    }
    return maxAttempts;
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
    artifactRefs: readonly ArtifactRef[];
    enqueuer: RuntimeJobEnqueuePort | undefined;
  },
): Promise<RuntimeWorkerJob[]> {
  const artifactRefs = [...new Set(input.artifactRefs)];
  if (artifactRefs.length === 0) return [];
  if (input.enqueuer === undefined) {
    throw new PgExecutorCompletionRequiredError(
      "executor completion with artifacts requires a RuntimeJobEnqueuePort for lifecycle jobs",
    );
  }
  const jobs: RuntimeWorkerJob[] = [
    ...artifactRefs.map((artifactRef): RuntimeWorkerJob => ({
      kind: "artifact_redaction",
      tenantId: input.tenantId as RuntimeWorkerJob["tenantId"],
      runId: input.runId as RuntimeWorkerJob["runId"],
      artifactId: artifactRef as RuntimeWorkerJob["artifactId"],
      correlationId: input.correlationId as RuntimeWorkerJob["correlationId"],
    })),
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

function requireCatalogException(
  input: ExecutorInvocationRecordInput,
  expectation: { expectedClass: "system" | "security" | "challenge"; label: string },
): ClassifiedException {
  const exception = input.result.exception;
  if (exception === undefined) {
    throw new PgExecutorCompletionRequiredError(`${expectation.label} requires StepResult.exception`);
  }
  if (exception.class !== expectation.expectedClass) {
    throw new PgExecutorCompletionRequiredError(`${expectation.label} requires exception.class=${expectation.expectedClass}`);
  }
  if (!isErrorCode(exception.code)) {
    throw new PgExecutorCompletionRequiredError(`${expectation.label} requires exception.code from error-catalog`);
  }
  const catalogClass = ERROR_CATALOG[exception.code].exceptionClass;
  if (catalogClass !== expectation.expectedClass) {
    throw new PgExecutorCompletionRequiredError(
      `${expectation.label} code ${exception.code} has error-catalog class ${catalogClass}`,
    );
  }
  return exception;
}

function isErrorCode(value: string): value is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_CATALOG, value);
}

function assertOnlyPendingKinds(
  sideEffects: readonly SideEffectCmd[],
  allowedKinds: readonly SideEffectCmd["kind"][],
  label: string,
): void {
  const allowed = new Set<string>(allowedKinds);
  for (const sideEffect of sideEffects) {
    if (!allowed.has(sideEffect.kind)) {
      throw new PgExecutorCompletionRequiredError(`${label} produced unsupported pending side effect ${sideEffect.kind}`);
    }
  }
  for (const kind of allowedKinds) {
    if (!sideEffects.some((sideEffect) => sideEffect.kind === kind)) {
      throw new PgExecutorCompletionRequiredError(`${label} missing pending side effect ${kind}`);
    }
  }
}
