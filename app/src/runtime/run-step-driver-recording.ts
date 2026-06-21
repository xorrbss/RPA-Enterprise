// run-step-driver.ts 에서 추출 — 단계 기록(step recording) executor 데코레이터 + 단계 아티팩트 영속(동작 무변경).
// driveScenario 가 recordExecutorSteps 시 래핑하는 ExecutorPlugin. attempt/invocation 영속·hidden artifact ref
// 보존·span. 전부 클래스 전용/클러스터 내부(drive 코어 미사용) — drive 는 StepRecordingExecutor 만 import.
import type { Pool } from "pg";

import type { ArtifactRef, ExecutorPlugin, IRActionType, RunContext, StepResult } from "../../../ts/core-types";
import type { ExecutorInvocationArtifactMetadata, IsoDateTime } from "../../../ts/runtime-contract";
import type { CorrelationId, RunId, StepId, TenantId } from "../../../ts/security-middleware-contract";
import { SPAN, withSpan, spanCommonFromContext } from "../observability/telemetry";
import { withTenantTx } from "../db/pool";
import { executorFailureStepResult } from "./executor-failure-result";
import { PgExecutorStepAttemptStore } from "./executor-step-attempt-store";
import { PgExecutorInvocationRecorder } from "./executor-invocation-recorder";
import { appendVisualEvidenceArtifact, type VisualEvidenceCaptureDeps } from "./visual-evidence";
import type { ClaimedRun } from "./run-step-driver";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXECUTOR_ACTIONS = new Set<string>(["act", "observe", "extract", "navigate", "download", "upload", "api_call", "file", "human_task", "shell"]);

export class StepRecordingExecutor implements ExecutorPlugin {
  private readonly attemptStore: PgExecutorStepAttemptStore;
  private readonly recorder: PgExecutorInvocationRecorder;

  constructor(
    private readonly pool: Pool,
    private readonly inner: ExecutorPlugin,
    private readonly run: ClaimedRun,
    private readonly visualEvidence?: VisualEvidenceCaptureDeps,
  ) {
    this.attemptStore = new PgExecutorStepAttemptStore(pool);
    this.recorder = new PgExecutorInvocationRecorder(pool);
  }

  capabilities(): { dom: boolean; vision: boolean; utility: boolean } {
    return this.inner.capabilities();
  }

  async execute(stepId: string, action: unknown, ctx: RunContext): Promise<StepResult> {
    const actionType = actionTypeFromExecutorAction(action);
    const startedAt = new Date().toISOString();
    const started = await this.attemptStore.begin({
      tenantId: this.run.tenantId as TenantId,
      runId: this.run.runId as RunId,
      stepId: stepId as StepId,
      nodeId: ctx.nodeId,
      action: actionType,
      correlationId: this.run.correlationId as CorrelationId,
      startedAt: startedAt as IsoDateTime,
    });
    const stepCtx: RunContext = {
      ...ctx,
      tenantId: this.run.tenantId,
      runId: this.run.runId,
      nodeId: ctx.nodeId,
      attempt: started.key.attempt,
    };

    let result: StepResult;
    try {
      result = await this.inner.execute(stepId, action, stepCtx);
    } catch (error) {
      result = executorFailureStepResult({ stepId, actionType }, stepCtx, startedAt, error);
    }
    if (this.visualEvidence !== undefined) {
      result = await appendVisualEvidenceArtifact({ action, result, ctx: stepCtx, ...this.visualEvidence });
    }

    const stepArtifacts = await loadPersistedStepArtifactMetadata(this.pool, {
      tenantId: this.run.tenantId,
      runId: this.run.runId,
      stepId,
      attempt: started.key.attempt,
      artifactRefs: result.artifacts,
    });
    const recordResult =
      stepArtifacts.length === result.artifacts.length
        ? result
        : { ...result, artifacts: stepArtifacts.map((artifact) => artifact.artifactRef) };
    await this.recorder.record({
      key: started.key,
      nodeId: ctx.nodeId,
      correlationId: this.run.correlationId as CorrelationId,
      result: recordResult,
      artifacts: stepArtifacts,
    });
    await preserveHiddenPersistedArtifactRefs(this.pool, {
      tenantId: this.run.tenantId,
      runId: this.run.runId,
      stepId,
      attempt: started.key.attempt,
      nodeId: ctx.nodeId,
      action: actionType,
      artifactRefs: result.artifacts,
      recordedArtifactRefs: recordResult.artifacts,
    });
    return result;
  }

  verify(criteria: unknown, ctx: RunContext) {
    return withSpan(SPAN.verifyRun, spanCommonFromContext(ctx), {}, () => this.inner.verify(criteria, ctx));
  }
}

interface HiddenPersistedArtifactRefInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly nodeId: string;
  readonly action: IRActionType;
  readonly artifactRefs: readonly ArtifactRef[];
  readonly recordedArtifactRefs: readonly ArtifactRef[];
}

async function preserveHiddenPersistedArtifactRefs(
  pool: Pool,
  input: HiddenPersistedArtifactRefInput,
): Promise<void> {
  const refs = input.artifactRefs.filter(isUuidArtifactRef);
  if (refs.length === 0) return;
  const uniqueRefs = [...new Set(refs)];
  if (sameRefs(uniqueRefs, input.recordedArtifactRefs)) return;

  await withTenantTx(pool, input.tenantId, async (client) => {
    const updated = await client.query(
      `UPDATE run_steps
          SET artifacts=$1::text[]
        WHERE tenant_id=$2::uuid
          AND run_id=$3::uuid
          AND step_id=$4
          AND attempt=$5::int
          AND node_id=$6
          AND action=$7`,
      [uniqueRefs, input.tenantId, input.runId, input.stepId, input.attempt, input.nodeId, input.action],
    );
    if (updated.rowCount !== 1) {
      throw new Error("driveScenario: failed to preserve hidden persisted artifact refs on run_steps");
    }
  });
}

function isUuidArtifactRef(ref: ArtifactRef): boolean {
  return UUID_RE.test(ref);
}

function sameRefs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

interface PersistedStepArtifactLookup {
  readonly tenantId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly artifactRefs: readonly ArtifactRef[];
}

async function loadPersistedStepArtifactMetadata(
  pool: Pool,
  input: PersistedStepArtifactLookup,
): Promise<readonly ExecutorInvocationArtifactMetadata[]> {
  if (input.artifactRefs.length === 0) return [];
  const uniqueRefs = [...new Set(input.artifactRefs)];
  return withTenantTx(pool, input.tenantId, async (client) => {
    const rows = await client.query<{
      artifact_ref: string;
      object_ref: string;
      type: string;
      media_type: string | null;
      filename: string | null;
      byte_size: string | null;
      duration_ms: number | null;
      redaction_status: string;
      retention_until: Date | string | null;
      sha256: string | null;
      legal_hold: boolean;
      quarantine: boolean;
    }>(
      `SELECT id::text AS artifact_ref, object_ref, type, media_type, filename, byte_size::text,
              duration_ms, redaction_status, retention_until, sha256, legal_hold, quarantine
         FROM artifacts
        WHERE tenant_id=$1::uuid
          AND run_id=$2::uuid
          AND step_id=$3
          AND attempt=$4::int
          AND id::text = ANY($5::text[])
        ORDER BY array_position($5::text[], id::text)`,
      [input.tenantId, input.runId, input.stepId, input.attempt, uniqueRefs],
    );
    return rows.rows.map((row) => ({
      artifactRef: row.artifact_ref as ArtifactRef,
      objectRef: row.object_ref as ExecutorInvocationArtifactMetadata["objectRef"],
      type: row.type,
      ...(row.media_type !== null ? { mediaType: row.media_type } : {}),
      ...(row.filename !== null ? { filename: row.filename } : {}),
      ...(row.byte_size !== null ? { byteSize: Number(row.byte_size) } : {}),
      ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
      redactionStatus: "pending",
      retentionUntil: isoDateTime(row.retention_until, "artifact.retention_until"),
      ...(row.sha256 !== null ? { sha256: row.sha256 } : {}),
      legalHold: row.legal_hold,
      quarantine: row.quarantine,
      metadataStored: true,
    }));
  });
}

function actionTypeFromExecutorAction(action: unknown): IRActionType {
  if (typeof action === "object" && action !== null && "type" in action) {
    const type = (action as { type?: unknown }).type;
    if (typeof type === "string" && EXECUTOR_ACTIONS.has(type)) return type as IRActionType;
  }
  throw new Error("driveScenario: executor action missing supported type before step recording");
}

function isoDateTime(value: Date | string | null, label: string): IsoDateTime {
  if (value instanceof Date) return value.toISOString() as IsoDateTime;
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString() as IsoDateTime;
  }
  throw new Error(`driveScenario: ${label} is required for step artifact metadata`);
}
