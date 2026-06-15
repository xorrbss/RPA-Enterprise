import type { ExecutorPlugin, IRActionType, RedactedString, RunContext, StepResult } from "../../../ts/core-types";
import { ERROR_CATALOG, type ErrorCode } from "../../../ts/error-catalog";
import type {
  ExecutorInvocationArtifactMetadata,
  ExecutorInvocationRecorder,
  ExecutorStepAttemptStore,
} from "../../../ts/runtime-contract";
import type { CorrelationId, RunId, StepId, TenantId } from "../../../ts/security-middleware-contract";
import { pageStateRef } from "../executor/page-state-resolver";
import type {
  ExecutorTerminalOutcomeCompletionInput,
  ExecutorTerminalOutcomeCompletionResult,
  PgExecutorCompletionCoordinator,
} from "./executor-completion-coordinator";

export interface ExecutorArtifactMetadataResolver {
  metadataFor(input: {
    result: StepResult;
    tenantId: TenantId;
    runId: RunId;
    stepId: StepId;
    attempt: number;
  }): Promise<readonly ExecutorInvocationArtifactMetadata[]>;
}

export type ExecutorStepCompletionMode =
  | { readonly kind: "record_only" }
  | {
      readonly kind: "terminal_outcome";
      readonly finalization?: ExecutorTerminalOutcomeCompletionInput["finalization"];
    };

export interface ExecutorStepOrchestratorInput {
  readonly tenantId: TenantId;
  readonly runId: RunId;
  readonly stepId: StepId;
  readonly nodeId: string;
  readonly actionType: IRActionType;
  readonly action: unknown;
  readonly correlationId: CorrelationId;
  readonly context: RunContext;
  readonly executor: ExecutorPlugin;
  readonly completion: ExecutorStepCompletionMode;
}

export type ExecutorStepOrchestratorResult =
  | {
      readonly kind: "recorded";
      readonly runStepId: string;
      readonly emittedEvents: readonly string[];
    }
  | ({ readonly kind: "terminal_outcome" } & ExecutorTerminalOutcomeCompletionResult);

export class PgExecutorStepOrchestrator {
  constructor(
    private readonly attemptStore: ExecutorStepAttemptStore,
    private readonly invocationRecorder: ExecutorInvocationRecorder,
    private readonly completionCoordinator: PgExecutorCompletionCoordinator,
    private readonly artifactResolver: ExecutorArtifactMetadataResolver = new EmptyArtifactMetadataResolver(),
  ) {}

  async execute(input: ExecutorStepOrchestratorInput): Promise<ExecutorStepOrchestratorResult> {
    const started = await this.attemptStore.begin({
      tenantId: input.tenantId,
      runId: input.runId,
      stepId: input.stepId,
      nodeId: input.nodeId,
      action: input.actionType,
      correlationId: input.correlationId,
    });

    const startedAt = new Date().toISOString();
    const context: RunContext = {
      ...input.context,
      tenantId: input.tenantId,
      runId: input.runId,
      nodeId: input.nodeId,
      attempt: started.key.attempt,
    };
    const result = await input.executor
      .execute(input.stepId, input.action, context)
      .catch((error: unknown) => failureStepResult(input, context, startedAt, error));
    const artifacts = await this.artifactResolver.metadataFor({
      result,
      tenantId: input.tenantId,
      runId: input.runId,
      stepId: input.stepId,
      attempt: started.key.attempt,
    });

    const recordInput = {
      key: started.key,
      nodeId: input.nodeId,
      correlationId: input.correlationId,
      result,
      artifacts,
    };

    if (input.completion.kind === "record_only") {
      const record = await this.invocationRecorder.record(recordInput);
      return {
        kind: "recorded",
        runStepId: record.runStepId,
        emittedEvents: record.emittedEvents,
      };
    }

    const completed = await this.completionCoordinator.completeTerminalOutcome({
      ...recordInput,
      finalization: input.completion.finalization,
    });
    return { kind: "terminal_outcome", ...completed };
  }
}

class EmptyArtifactMetadataResolver implements ExecutorArtifactMetadataResolver {
  async metadataFor(input: { result: StepResult }): Promise<readonly ExecutorInvocationArtifactMetadata[]> {
    if (input.result.artifacts.length > 0) {
      throw new Error("executor orchestration requires artifact metadata for StepResult.artifacts");
    }
    return [];
  }
}

function failureStepResult(
  input: ExecutorStepOrchestratorInput,
  context: RunContext,
  startedAt: string,
  error: unknown,
): StepResult {
  const code = catalogCodeFromError(error);
  const catalogClass = ERROR_CATALOG[code].exceptionClass;
  const exceptionClass = catalogClass === "business" || catalogClass === "challenge" || catalogClass === "security"
    ? catalogClass
    : "system";
  const status =
    exceptionClass === "business"
      ? "failed_business"
      : exceptionClass === "challenge"
        ? "failed_challenge"
        : exceptionClass === "security"
          ? "failed_security"
          : "failed_system";
  const endedAt = new Date().toISOString();
  return {
    stepId: input.stepId,
    action: input.actionType,
    status,
    pageStateBefore: pageStateRef(context.pageState),
    pageStateAfter: pageStateRef(context.pageState),
    artifacts: [],
    cache: { mode: "bypass" },
    exception: {
      class: exceptionClass,
      code,
      message: `executor plugin failed: ${code}` as RedactedString,
    },
    timings: {
      startedAt,
      endedAt,
      durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
    },
  };
}

function catalogCodeFromError(error: unknown): ErrorCode {
  const candidate = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (typeof candidate === "string" && Object.prototype.hasOwnProperty.call(ERROR_CATALOG, candidate)) {
    return candidate as ErrorCode;
  }
  return "CONTROL_PLANE_INTERNAL_ERROR";
}
