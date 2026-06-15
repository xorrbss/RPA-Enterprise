/**
 * D3 executor invocation recorder integration.
 *
 * Records StepResult evidence under tenant RLS and proves local pre-execution
 * attempt ownership plus terminal-success completion. This does not run a
 * browser, resolve secrets, or claim staging readiness.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { FakeSecretStore, asSecretRef } from "../../security/compliance-scaffold";
import type {
  ArtifactRef,
  ExecutorPlugin,
  ObjectRef,
  PageState,
  PageStateRef,
  PlainSecret,
  RedactedString,
  RunContext,
  StepResult,
  VerifyResult,
} from "../../ts/core-types";
import type { CorrelationId, RunId, StepId, TenantId } from "../../ts/security-middleware-contract";
import type { ExecutorInvocationArtifactMetadata, IsoDateTime, RuntimeWorkerJob } from "../../ts/runtime-contract";
import { createPool, withTenantTx } from "../src/db/pool";
import {
  PgExecutorCompletionCoordinator,
  type ExecutorTerminalSuccessEvidence,
  type ExecutorSecurityNotificationPort,
  type RuntimeJobEnqueuePort,
} from "../src/runtime/executor-completion-coordinator";
import { PgExecutorInvocationRecorder } from "../src/runtime/executor-invocation-recorder";
import { PgExecutorStepOrchestrator } from "../src/runtime/executor-step-orchestrator";
import { PgExecutorStepAttemptStore } from "../src/runtime/executor-step-attempt-store";
import { EVENTS_OUTBOX_RETENTION_POLICY, emitOutboxEvent } from "../src/runtime/outbox";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_executor_recorder_int";

const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const CORRELATION = "20000000-0000-0000-0000-0000000000e1";
const SCENARIO_A = "30000000-0000-0000-0000-0000000000a1";
const SCENARIO_VERSION_A = "30000000-0000-0000-0000-0000000000a2";
const RUN_A = "30000000-0000-0000-0000-0000000000a3";
const WORKITEM_TERMINAL = "30000000-0000-0000-0000-0000000000a4";
const RUN_TERMINAL = "30000000-0000-0000-0000-0000000000a5";
const RUN_NO_ENQUEUER = "30000000-0000-0000-0000-0000000000a6";
const WORKITEM_NO_ENQUEUER = "30000000-0000-0000-0000-0000000000a7";
const STARTED_STAGEHAND_CALL = "30000000-0000-0000-0000-0000000000a8";
const WORKITEM_BUSINESS = "30000000-0000-0000-0000-0000000000a9";
const RUN_BUSINESS = "30000000-0000-0000-0000-0000000000aa";
const WORKITEM_BUSINESS_NO_ENQUEUER = "30000000-0000-0000-0000-0000000000ab";
const RUN_BUSINESS_NO_ENQUEUER = "30000000-0000-0000-0000-0000000000ac";
const WORKITEM_SYSTEM_RETRY = "30000000-0000-0000-0000-0000000000ad";
const RUN_SYSTEM_RETRY = "30000000-0000-0000-0000-0000000000ae";
const WORKITEM_SYSTEM_ABANDON = "30000000-0000-0000-0000-0000000000af";
const RUN_SYSTEM_ABANDON = "30000000-0000-0000-0000-0000000000b0";
const WORKITEM_SECURITY = "30000000-0000-0000-0000-0000000000b1";
const RUN_SECURITY = "30000000-0000-0000-0000-0000000000b2";
const WORKITEM_CHALLENGE = "30000000-0000-0000-0000-0000000000b4";
const RUN_CHALLENGE = "30000000-0000-0000-0000-0000000000b5";
const WORKITEM_UNCERTAIN = "30000000-0000-0000-0000-0000000000b6";
const RUN_UNCERTAIN = "30000000-0000-0000-0000-0000000000b7";
const RUN_ORCHESTRATED = "30000000-0000-0000-0000-0000000000b8";
const SCENARIO_B = "30000000-0000-0000-0000-0000000000b1";
const SCENARIO_VERSION_B = "30000000-0000-0000-0000-0000000000b2";
const RUN_B = "30000000-0000-0000-0000-0000000000b3";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

async function expectReject(label: string, fn: () => Promise<unknown>, contains: string): Promise<void> {
  try {
    await fn();
    check(label, false, "expected rejection");
  } catch (err) {
    check(label, String(err).includes(contains), String(err));
  }
}

function stepResult(stepId: string, overrides: Partial<StepResult> = {}): StepResult {
  return {
    stepId,
    action: "navigate",
    status: "success",
    output: { ok: true },
    pageStateBefore: "page://before",
    pageStateAfter: "page://after",
    artifacts: [artifactRefFor(stepId)],
    cache: { mode: "bypass" },
    sideEffect: { kind: "read_only", committed: true },
    timings: {
      startedAt: "2026-06-14T00:00:00.000Z",
      endedAt: "2026-06-14T00:00:01.000Z",
      durationMs: 1000,
    },
    ...overrides,
  };
}

function artifactFor(result: StepResult): ExecutorInvocationArtifactMetadata[] {
  return result.artifacts.map((artifactRef) => ({
    artifactRef,
    objectRef: `object://tenant-a/${artifactRef}` as ObjectRef,
    type: "screenshot",
    redactionStatus: "pending",
    retentionUntil: "2026-09-12T00:00:00.000Z" as IsoDateTime,
    sha256: "sha256:executor-recorder-int",
  }));
}

function artifactRefFor(stepId: string): ArtifactRef {
  let acc = 0xabc;
  for (const ch of stepId) acc = (acc * 33 + ch.charCodeAt(0)) >>> 0;
  return `40000000-0000-4000-8000-${acc.toString(16).padStart(12, "0")}` as ArtifactRef;
}

function terminalSuccessEvidence(overrides: Record<string, unknown> = {}): ExecutorTerminalSuccessEvidence {
  return {
    flowTerminalReached: true,
    artifactFlushComplete: true,
    outputFinalized: true,
    usageFlushed: true,
    sinkPolicyMet: true,
    enqueueArtifactLifecycleJobs: true,
    ...overrides,
  } as unknown as ExecutorTerminalSuccessEvidence;
}

async function seedTenant(pool: ReturnType<typeof createPool>, tenantId: string, scenarioId: string, versionId: string, runId: string): Promise<void> {
  await withTenantTx(pool, tenantId, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,$3)`, [
      scenarioId,
      tenantId,
      `executor-recorder-${tenantId}`,
    ]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'draft','{"nodes":[]}'::jsonb)`,
      [versionId, tenantId, scenarioId],
    );
    await c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id)
       VALUES ($1,$2,$3,'running',$4)`,
      [runId, tenantId, versionId, CORRELATION],
    );
  });
}

async function seedTerminalRun(
  pool: ReturnType<typeof createPool>,
  input: { workitemId: string; runId: string; uniqueReference: string; attempts?: number },
): Promise<void> {
  await withTenantTx(pool, TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO workitems (id, tenant_id, connector_id, unique_reference, status, attempts)
       VALUES ($1,$2,'executor-recorder',$3,'processing',$4::int)`,
      [input.workitemId, TENANT_A, input.uniqueReference, input.attempts ?? 0],
    );
    await c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, workitem_id, status, correlation_id)
       VALUES ($1,$2,$3,$4,'running',$5)`,
      [input.runId, TENANT_A, SCENARIO_VERSION_A, input.workitemId, CORRELATION],
    );
  });
}

async function runStepCount(pool: ReturnType<typeof createPool>, tenantId: string, runId: string, stepId: string): Promise<number> {
  return withTenantTx(pool, tenantId, async (c) => {
    const row = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM run_steps WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND step_id=$3`,
      [tenantId, runId, stepId],
    );
    return row.rows[0]?.n ?? -1;
  });
}

async function runStepStatus(
  pool: ReturnType<typeof createPool>,
  tenantId: string,
  runId: string,
  stepId: string,
): Promise<string | undefined> {
  return withTenantTx(pool, tenantId, async (c) => {
    const row = await c.query<{ status: string }>(
      `SELECT status FROM run_steps WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND step_id=$3`,
      [tenantId, runId, stepId],
    );
    return row.rows[0]?.status;
  });
}

async function stepEventCount(
  pool: ReturnType<typeof createPool>,
  tenantId: string,
  runId: string,
  stepId: string,
  eventType = "step.completed",
): Promise<number> {
  return withTenantTx(pool, tenantId, async (c) => {
    const row = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM events_outbox
        WHERE tenant_id=$1::uuid
          AND run_id=$2::uuid
          AND step_id=$3
          AND event_type=$4`,
      [tenantId, runId, stepId, eventType],
    );
    return row.rows[0]?.n ?? -1;
  });
}

function testPageState(): PageState {
  return {
    url: { raw: "https://executor.example/run", canonical: "https://executor.example/run", pattern: "https://executor.example/*" },
    dom: { structuralHash: "executor-test", visibleTextHash: "executor-visible", landmarks: [], frames: [] },
    auth: "authenticated",
    flags: {},
    matchedWhere: [],
  };
}

function testRunContext(runId: string, overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId,
    tenantId: TENANT_A,
    nodeId: "node-orchestrated",
    attempt: 0,
    pageState: testPageState(),
    siteProfileId: "site-orchestrated",
    browserIdentityId: "browser-orchestrated",
    networkPolicyId: "network-orchestrated",
    leaseId: "lease-orchestrated",
    assetRefs: {},
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

async function runAndWorkitemStatus(pool: ReturnType<typeof createPool>, runId: string, workitemId: string): Promise<{
  runStatus?: string;
  workitemStatus?: string;
  workitemAttempts?: number;
}> {
  return withTenantTx(pool, TENANT_A, async (c) => {
    const row = await c.query<{ run_status: string; workitem_status: string; workitem_attempts: number }>(
      `SELECT r.status AS run_status, w.status AS workitem_status, w.attempts AS workitem_attempts
         FROM runs r
         JOIN workitems w ON w.tenant_id = r.tenant_id AND w.id = r.workitem_id
        WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid AND w.id=$3::uuid`,
      [TENANT_A, runId, workitemId],
    );
    return {
      runStatus: row.rows[0]?.run_status,
      workitemStatus: row.rows[0]?.workitem_status,
      workitemAttempts: row.rows[0]?.workitem_attempts,
    };
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
    } finally {
      setup.release();
    }
    console.log("migrations applied (concurrency -> core)");

    await seedTenant(pool, TENANT_A, SCENARIO_A, SCENARIO_VERSION_A, RUN_A);
    await seedTenant(pool, TENANT_B, SCENARIO_B, SCENARIO_VERSION_B, RUN_B);
    await seedTerminalRun(pool, {
      workitemId: WORKITEM_TERMINAL,
      runId: RUN_TERMINAL,
      uniqueReference: "terminal-success",
    });
    await seedTerminalRun(pool, {
      workitemId: WORKITEM_NO_ENQUEUER,
      runId: RUN_NO_ENQUEUER,
      uniqueReference: "terminal-no-enqueuer",
    });
    await seedTerminalRun(pool, {
      workitemId: WORKITEM_BUSINESS,
      runId: RUN_BUSINESS,
      uniqueReference: "terminal-business",
    });
    await seedTerminalRun(pool, {
      workitemId: WORKITEM_BUSINESS_NO_ENQUEUER,
      runId: RUN_BUSINESS_NO_ENQUEUER,
      uniqueReference: "terminal-business-no-enqueuer",
    });
    await seedTerminalRun(pool, {
      workitemId: WORKITEM_SYSTEM_RETRY,
      runId: RUN_SYSTEM_RETRY,
      uniqueReference: "terminal-system-retry",
    });
    await seedTerminalRun(pool, {
      workitemId: WORKITEM_SYSTEM_ABANDON,
      runId: RUN_SYSTEM_ABANDON,
      uniqueReference: "terminal-system-abandon",
      attempts: 1,
    });
    await seedTerminalRun(pool, {
      workitemId: WORKITEM_SECURITY,
      runId: RUN_SECURITY,
      uniqueReference: "terminal-security",
    });
    await seedTerminalRun(pool, {
      workitemId: WORKITEM_CHALLENGE,
      runId: RUN_CHALLENGE,
      uniqueReference: "terminal-challenge",
    });
    await seedTerminalRun(pool, {
      workitemId: WORKITEM_UNCERTAIN,
      runId: RUN_UNCERTAIN,
      uniqueReference: "terminal-uncertain",
    });
    await withTenantTx(pool, TENANT_A, async (c) => {
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id)
         VALUES ($1,$2,$3,'running',$4)`,
        [RUN_ORCHESTRATED, TENANT_A, SCENARIO_VERSION_A, CORRELATION],
      );
    });

    const attemptStore = new PgExecutorStepAttemptStore(pool);
    const recorder = new PgExecutorInvocationRecorder(pool);
    const enqueuedRuntimeJobs: RuntimeWorkerJob[] = [];
    const runtimeJobEnqueuer: RuntimeJobEnqueuePort = {
      async enqueueRuntimeJob(_client, job) {
        enqueuedRuntimeJobs.push(job);
      },
    };
    const securityNotifications: Array<{ runId: string; code: string }> = [];
    const securityNotificationPort: ExecutorSecurityNotificationPort = {
      async notifySecurityException(_client, input) {
        securityNotifications.push({ runId: input.runId, code: input.exception.code });
      },
    };
    const completionCoordinator = new PgExecutorCompletionCoordinator(pool, runtimeJobEnqueuer, {
      workitemMaxAttempts: 2,
      securityNotificationPort,
    });
    const beginStarted = (
      runId: string,
      stepId: string,
      action: StepResult["action"] = "navigate",
      nodeId = `node-${stepId}`,
    ) =>
      attemptStore.begin({
        tenantId: TENANT_A as TenantId,
        runId: runId as RunId,
        stepId: stepId as StepId,
        nodeId,
        action,
        correlationId: CORRELATION as CorrelationId,
        startedAt: "2026-06-14T00:00:00.000Z" as IsoDateTime,
      });

    const started = await attemptStore.begin({
      tenantId: TENANT_A as TenantId,
      runId: RUN_A as RunId,
      stepId: "step-started-finalize" as StepId,
      nodeId: "node-started-finalize",
      action: "observe",
      correlationId: CORRELATION as CorrelationId,
      startedAt: "2026-06-14T00:00:10.000Z" as IsoDateTime,
    });
    check("executor attempt begin returns attempt 0", started.key.attempt === 0, JSON.stringify(started));
    check("executor attempt begin emits step.started", started.emittedEvents.length === 1, JSON.stringify(started));
    check(
      "executor attempt begin persisted step.started",
      (await stepEventCount(pool, TENANT_A, RUN_A, "step-started-finalize", "step.started")) === 1,
    );
    await withTenantTx(pool, TENANT_A, async (c) => {
      const row = await c.query<{ status: string; ended_at: Date | null }>(
        `SELECT status, ended_at
           FROM run_steps
          WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND step_id=$3 AND attempt=0`,
        [TENANT_A, RUN_A, "step-started-finalize"],
      );
      check(
        "executor attempt begin creates nonterminal started row",
        row.rows[0]?.status === "started" && row.rows[0]?.ended_at === null,
        JSON.stringify(row.rows[0]),
      );
      await c.query(
        `INSERT INTO stagehand_calls (
           id, tenant_id, run_id, step_id, attempt, idempotency_key, request_hash, model, stream_status
         )
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::int, $6, $7, $8, 'done')`,
        [
          STARTED_STAGEHAND_CALL,
          TENANT_A,
          RUN_A,
          "step-started-finalize",
          started.key.attempt,
          "stagehand-step-started-finalize",
          "sha256:started-finalize",
          "model-alias-local",
        ],
      );
    });

    const startedFinalResult = stepResult("step-started-finalize", {
      action: "observe",
      artifacts: [],
      stagehandCallIds: [STARTED_STAGEHAND_CALL],
      timings: {
        startedAt: "2026-06-14T00:00:10.000Z",
        endedAt: "2026-06-14T00:00:11.000Z",
        durationMs: 1000,
      },
    });
    const finalizedStarted = await recorder.record({
      key: started.key,
      nodeId: "node-started-finalize",
      correlationId: CORRELATION as CorrelationId,
      result: startedFinalResult,
      artifacts: [],
    });
    check("executor recorder finalizes existing started run_step", finalizedStarted.runStepId === started.runStepId);
    check(
      "executor recorder emits step.completed after step.started",
      (await stepEventCount(pool, TENANT_A, RUN_A, "step-started-finalize", "step.completed")) === 1,
    );
    await withTenantTx(pool, TENANT_A, async (c) => {
      const row = await c.query<{ status: string; action: string; stagehand_call_ids: string[] }>(
        `SELECT status, action, stagehand_call_ids
           FROM run_steps
          WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND step_id=$3 AND attempt=0`,
        [TENANT_A, RUN_A, "step-started-finalize"],
      );
      check(
        "executor recorder persists final status over started row",
        row.rows[0]?.status === "success" &&
          row.rows[0]?.action === "observe" &&
          row.rows[0]?.stagehand_call_ids?.[0] === STARTED_STAGEHAND_CALL,
        JSON.stringify(row.rows[0]),
      );
    });
    const secondStarted = await attemptStore.begin({
      tenantId: TENANT_A as TenantId,
      runId: RUN_A as RunId,
      stepId: "step-started-finalize" as StepId,
      nodeId: "node-started-finalize-retry",
      action: "observe",
      correlationId: CORRELATION as CorrelationId,
      startedAt: "2026-06-14T00:00:12.000Z" as IsoDateTime,
    });
    check("executor attempt begin owns next attempt", secondStarted.key.attempt === 1, JSON.stringify(secondStarted));
    await expectReject(
      "executor attempt begin cross-tenant run fails closed",
      () =>
        attemptStore.begin({
          tenantId: TENANT_B as TenantId,
          runId: RUN_A as RunId,
          stepId: "step-cross-tenant-start" as StepId,
          nodeId: "node-cross-tenant-start",
          action: "act",
          correlationId: CORRELATION as CorrelationId,
        }),
      "run not found",
    );
    await expectReject(
      "executor recorder without local started attempt fails closed",
      () =>
        recorder.record({
          key: { tenantId: TENANT_A as TenantId, runId: RUN_A as RunId, stepId: "step-no-start" as StepId, attempt: 0 },
          nodeId: "node-no-start",
          correlationId: CORRELATION as CorrelationId,
          result: stepResult("step-no-start", { artifacts: [] }),
          artifacts: [],
        }),
      "existing local started attempt",
    );
    check("no-start recorder emits no step.completed", (await stepEventCount(pool, TENANT_A, RUN_A, "step-no-start")) === 0);

    const pluginObservedStartedStatuses: string[] = [];
    const fakePlugin: ExecutorPlugin = {
      capabilities: () => ({ dom: false, vision: false, utility: true }),
      execute: async (stepId, _action, ctx) => {
        pluginObservedStartedStatuses.push(
          (await runStepStatus(pool, TENANT_A, ctx.runId, stepId)) ?? "missing",
        );
        return stepResult(stepId, {
          artifacts: [],
          timings: {
            startedAt: "2026-06-14T00:00:00.000Z",
            endedAt: "2026-06-14T00:00:01.000Z",
            durationMs: 1000,
          },
        });
      },
      verify: async (): Promise<VerifyResult> => ({
        status: "pass",
        confidence: 1,
        failedCriteria: [],
        evidenceRefs: [],
        recommendation: "continue",
      }),
    };
    const orchestrator = new PgExecutorStepOrchestrator(attemptStore, recorder, completionCoordinator);
    const orchestrated = await orchestrator.execute({
      tenantId: TENANT_A as TenantId,
      runId: RUN_ORCHESTRATED as RunId,
      stepId: "step-orchestrated" as StepId,
      nodeId: "node-orchestrated",
      actionType: "navigate",
      action: { type: "navigate", url: "https://executor.example/run" },
      correlationId: CORRELATION as CorrelationId,
      context: testRunContext(RUN_ORCHESTRATED),
      executor: fakePlugin,
      completion: { kind: "record_only" },
    });
    check(
      "executor orchestrator invokes plugin after started attempt commit",
      pluginObservedStartedStatuses[0] === "started" && orchestrated.kind === "recorded",
      JSON.stringify({ pluginObservedStartedStatuses, orchestrated }),
    );
    check(
      "executor orchestrator records plugin result after out-of-tx execute",
      (await runStepStatus(pool, TENANT_A, RUN_ORCHESTRATED, "step-orchestrated")) === "success" &&
        (await stepEventCount(pool, TENANT_A, RUN_ORCHESTRATED, "step-orchestrated")) === 1,
    );

    const terminalResult = stepResult("step-terminal");
    const terminalStarted = await beginStarted(RUN_TERMINAL, "step-terminal", terminalResult.action, "node-terminal");
    const terminal = await completionCoordinator.completeTerminalSuccess({
      key: terminalStarted.key,
      nodeId: "node-terminal",
      correlationId: CORRELATION as CorrelationId,
      result: terminalResult,
      artifacts: artifactFor(terminalResult),
      finalization: terminalSuccessEvidence(),
    });
    check("executor completion returns runStepId", terminal.record.runStepId.length > 0, JSON.stringify(terminal));
    check(
      "executor completion emits step/run/workitem events",
      terminal.emittedEvents.length === 3,
      JSON.stringify(terminal.emittedEvents),
    );
    check(
      "executor completion enqueues lifecycle jobs for artifacts",
      enqueuedRuntimeJobs.length === 2 &&
        enqueuedRuntimeJobs[0]?.kind === "artifact_redaction" &&
        enqueuedRuntimeJobs[1]?.kind === "artifact_retention" &&
        enqueuedRuntimeJobs.every((job) => job.tenantId === TENANT_A && job.correlationId === CORRELATION),
      JSON.stringify(enqueuedRuntimeJobs),
    );
    check(
      "executor completion records satisfied finalization side effects",
      terminal.satisfiedSideEffects.some((sideEffect) => sideEffect.kind === "flushArtifacts") &&
        terminal.satisfiedSideEffects.some((sideEffect) => sideEffect.kind === "usageFlush") &&
        terminal.satisfiedSideEffects.some((sideEffect) => sideEffect.kind === "finalizeOutputs"),
      JSON.stringify(terminal.satisfiedSideEffects),
    );
    const terminalStatus = await runAndWorkitemStatus(pool, RUN_TERMINAL, WORKITEM_TERMINAL);
    check(
      "executor completion maps success to run completed and workitem successful",
      terminalStatus.runStatus === "completed" && terminalStatus.workitemStatus === "successful",
      JSON.stringify(terminalStatus),
    );
    await withTenantTx(pool, TENANT_A, async (c) => {
      const auditRows = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log`);
      check("executor completion does not use security audit_log", auditRows.rows[0]?.n === 0, `n=${auditRows.rows[0]?.n}`);
      const events = await c.query<{ event_type: string }>(
        `SELECT event_type
           FROM events_outbox
          WHERE run_id=$1::uuid
          ORDER BY event_type`,
        [RUN_TERMINAL],
      );
      check(
        "executor completion persisted canonical events",
        JSON.stringify(events.rows.map((row) => row.event_type)) ===
          JSON.stringify(["run.completed", "step.completed", "step.started", "workitem.completed"]),
        JSON.stringify(events.rows),
      );
    });

    const missingFinalizationEvidence = terminalSuccessEvidence();
    delete (missingFinalizationEvidence as unknown as Record<string, unknown>).artifactFlushComplete;
    await expectReject(
      "executor completion rejects missing finalization evidence key",
      () =>
        completionCoordinator.completeTerminalSuccess({
          key: {
            tenantId: TENANT_A as TenantId,
            runId: RUN_A as RunId,
            stepId: "step-missing-finalization" as StepId,
            attempt: 0,
          },
          nodeId: "node-missing-finalization",
          correlationId: CORRELATION as CorrelationId,
          result: stepResult("step-missing-finalization", { artifacts: [] }),
          artifacts: [],
          finalization: missingFinalizationEvidence,
        }),
      "artifactFlushComplete",
    );
    check(
      "executor missing finalization evidence does not persist run_step",
      (await runStepCount(pool, TENANT_A, RUN_A, "step-missing-finalization")) === 0,
    );

    await expectReject(
      "executor completion rejects false finalization evidence value",
      () =>
        completionCoordinator.completeTerminalSuccess({
          key: {
            tenantId: TENANT_A as TenantId,
            runId: RUN_A as RunId,
            stepId: "step-false-finalization" as StepId,
            attempt: 0,
          },
          nodeId: "node-false-finalization",
          correlationId: CORRELATION as CorrelationId,
          result: stepResult("step-false-finalization", { artifacts: [] }),
          artifacts: [],
          finalization: terminalSuccessEvidence({ usageFlushed: false }),
        }),
      "usageFlushed",
    );
    check(
      "executor false finalization evidence does not persist run_step",
      (await runStepCount(pool, TENANT_A, RUN_A, "step-false-finalization")) === 0,
    );

    await expectReject(
      "executor completion rejects unknown finalization evidence key",
      () =>
        completionCoordinator.completeTerminalSuccess({
          key: {
            tenantId: TENANT_A as TenantId,
            runId: RUN_A as RunId,
            stepId: "step-unknown-finalization" as StepId,
            attempt: 0,
          },
          nodeId: "node-unknown-finalization",
          correlationId: CORRELATION as CorrelationId,
          result: stepResult("step-unknown-finalization", { artifacts: [] }),
          artifacts: [],
          finalization: terminalSuccessEvidence({ unexpectedEvidence: true }),
        }),
      "unknown finalization evidence key",
    );
    check(
      "executor unknown finalization evidence does not persist run_step",
      (await runStepCount(pool, TENANT_A, RUN_A, "step-unknown-finalization")) === 0,
    );

    const noEnqueuerCoordinator = new PgExecutorCompletionCoordinator(pool);
    const noEnqueuerResult = stepResult("step-no-enqueuer");
    const noEnqueuerStarted = await beginStarted(RUN_NO_ENQUEUER, "step-no-enqueuer", noEnqueuerResult.action, "node-no-enqueuer");
    await expectReject(
      "executor completion with artifacts requires lifecycle enqueue port",
      () =>
        noEnqueuerCoordinator.completeTerminalSuccess({
          key: noEnqueuerStarted.key,
          nodeId: "node-no-enqueuer",
          correlationId: CORRELATION as CorrelationId,
          result: noEnqueuerResult,
          artifacts: artifactFor(noEnqueuerResult),
          finalization: terminalSuccessEvidence(),
        }),
      "requires a RuntimeJobEnqueuePort",
    );
    check("executor completion enqueue failure preserves started attempt", (await runStepStatus(pool, TENANT_A, RUN_NO_ENQUEUER, "step-no-enqueuer")) === "started");
    check("executor completion enqueue failure emits no step.completed", (await stepEventCount(pool, TENANT_A, RUN_NO_ENQUEUER, "step-no-enqueuer")) === 0);
    const rolledBackStatus = await runAndWorkitemStatus(pool, RUN_NO_ENQUEUER, WORKITEM_NO_ENQUEUER);
    check(
      "executor completion enqueue failure rolls back run/workitem state",
      rolledBackStatus.runStatus === "running" && rolledBackStatus.workitemStatus === "processing",
      JSON.stringify(rolledBackStatus),
    );

    const businessResult = stepResult("step-business", {
      status: "failed_business",
      output: undefined,
      exception: {
        class: "business",
        code: "BUSINESS_RULE_FAILED",
        message: "business rule failed" as RedactedString,
        evidenceRefs: [],
      },
    });
    const businessStarted = await beginStarted(RUN_BUSINESS, "step-business", businessResult.action, "node-business");
    const business = await completionCoordinator.completeTerminalBusinessFailure({
      key: businessStarted.key,
      nodeId: "node-business",
      correlationId: CORRELATION as CorrelationId,
      result: businessResult,
      artifacts: artifactFor(businessResult),
    });
    check("executor business failure returns runStepId", business.record.runStepId.length > 0, JSON.stringify(business));
    check(
      "executor business failure emits step/run events",
      business.emittedEvents.length === 2,
      JSON.stringify(business.emittedEvents),
    );
    check(
      "executor business failure enqueues lifecycle jobs for artifacts",
      enqueuedRuntimeJobs.length === 4 &&
        enqueuedRuntimeJobs[2]?.kind === "artifact_redaction" &&
        enqueuedRuntimeJobs[3]?.kind === "artifact_retention" &&
        enqueuedRuntimeJobs.slice(2).every((job) => job.tenantId === TENANT_A && job.correlationId === CORRELATION),
      JSON.stringify(enqueuedRuntimeJobs),
    );
    const businessStatus = await runAndWorkitemStatus(pool, RUN_BUSINESS, WORKITEM_BUSINESS);
    check(
      "executor business failure maps run/workitem failed_business",
      businessStatus.runStatus === "failed_business" && businessStatus.workitemStatus === "failed_business",
      JSON.stringify(businessStatus),
    );
    await withTenantTx(pool, TENANT_A, async (c) => {
      const events = await c.query<{ event_type: string }>(
        `SELECT event_type
           FROM events_outbox
          WHERE run_id=$1::uuid
          ORDER BY event_type`,
        [RUN_BUSINESS],
      );
      check(
        "executor business failure persisted canonical events",
        JSON.stringify(events.rows.map((row) => row.event_type)) ===
          JSON.stringify(["run.failed_business", "step.completed", "step.started"]),
        JSON.stringify(events.rows),
      );
      const auditRows = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log`);
      check("executor business failure does not use security audit_log", auditRows.rows[0]?.n === 0, `n=${auditRows.rows[0]?.n}`);
    });

    const businessNoEnqueuerCoordinator = new PgExecutorCompletionCoordinator(pool);
    const businessNoEnqueuerResult = stepResult("step-business-no-enqueuer", {
      status: "failed_business",
      exception: {
        class: "business",
        code: "BUSINESS_RULE_FAILED",
        message: "business rule failed" as RedactedString,
      },
    });
    const businessNoEnqueuerStarted = await beginStarted(
      RUN_BUSINESS_NO_ENQUEUER,
      "step-business-no-enqueuer",
      businessNoEnqueuerResult.action,
      "node-business-no-enqueuer",
    );
    await expectReject(
      "executor business failure with artifacts requires lifecycle enqueue port",
      () =>
        businessNoEnqueuerCoordinator.completeTerminalBusinessFailure({
          key: businessNoEnqueuerStarted.key,
          nodeId: "node-business-no-enqueuer",
          correlationId: CORRELATION as CorrelationId,
          result: businessNoEnqueuerResult,
          artifacts: artifactFor(businessNoEnqueuerResult),
        }),
      "requires a RuntimeJobEnqueuePort",
    );
    check(
      "executor business failure enqueue failure preserves started attempt",
      (await runStepStatus(pool, TENANT_A, RUN_BUSINESS_NO_ENQUEUER, "step-business-no-enqueuer")) === "started",
    );
    check(
      "executor business failure enqueue failure emits no step.completed",
      (await stepEventCount(pool, TENANT_A, RUN_BUSINESS_NO_ENQUEUER, "step-business-no-enqueuer")) === 0,
    );
    const businessRollbackStatus = await runAndWorkitemStatus(pool, RUN_BUSINESS_NO_ENQUEUER, WORKITEM_BUSINESS_NO_ENQUEUER);
    check(
      "executor business failure enqueue failure rolls back run/workitem state",
      businessRollbackStatus.runStatus === "running" && businessRollbackStatus.workitemStatus === "processing",
      JSON.stringify(businessRollbackStatus),
    );

    await expectReject(
      "executor business failure requires business exception class",
      () =>
        completionCoordinator.completeTerminalBusinessFailure({
          key: { tenantId: TENANT_A as TenantId, runId: RUN_A as RunId, stepId: "step-business-wrong-class" as StepId, attempt: 0 },
          nodeId: "node-business-wrong-class",
          correlationId: CORRELATION as CorrelationId,
          result: stepResult("step-business-wrong-class", {
            status: "failed_business",
            artifacts: [],
            exception: {
              class: "system",
              code: "SYSTEM_FAILURE",
              message: "system failure" as RedactedString,
            },
          }),
          artifacts: [],
        }),
      "exception.class=business",
    );

    const systemRetryResult = stepResult("step-system-retry", {
      status: "failed_system",
      output: undefined,
      exception: {
        class: "system",
        code: "LLM_BACKEND_UNAVAILABLE",
        message: "backend unavailable" as RedactedString,
      },
    });
    const systemRetryStarted = await beginStarted(
      RUN_SYSTEM_RETRY,
      "step-system-retry",
      systemRetryResult.action,
      "node-system-retry",
    );
    const systemRetry = await completionCoordinator.completeTerminalOutcome({
      key: systemRetryStarted.key,
      nodeId: "node-system-retry",
      correlationId: CORRELATION as CorrelationId,
      result: systemRetryResult,
      artifacts: artifactFor(systemRetryResult),
    });
    check(
      "executor system failure maps R8/W4 retry",
      (await runAndWorkitemStatus(pool, RUN_SYSTEM_RETRY, WORKITEM_SYSTEM_RETRY)).runStatus === "failed_system" &&
        (await runAndWorkitemStatus(pool, RUN_SYSTEM_RETRY, WORKITEM_SYSTEM_RETRY)).workitemStatus === "retry",
    );
    check(
      "executor system failure increments workitem attempts",
      (await runAndWorkitemStatus(pool, RUN_SYSTEM_RETRY, WORKITEM_SYSTEM_RETRY)).workitemAttempts === 1,
    );
    check(
      "executor system failure emits step/run events and lifecycle jobs",
      systemRetry.emittedEvents.length === 2 &&
        systemRetry.enqueuedRuntimeJobs.length === 2 &&
        systemRetry.enqueuedRuntimeJobs[0]?.kind === "artifact_redaction" &&
        systemRetry.enqueuedRuntimeJobs[1]?.kind === "artifact_retention",
      JSON.stringify(systemRetry),
    );

    const systemAbandonResult = stepResult("step-system-abandon", {
      status: "failed_system",
      artifacts: [],
      exception: {
        class: "system",
        code: "BROWSER_CRASH",
        message: "browser crashed" as RedactedString,
      },
    });
    const systemAbandonStarted = await beginStarted(
      RUN_SYSTEM_ABANDON,
      "step-system-abandon",
      systemAbandonResult.action,
      "node-system-abandon",
    );
    const systemAbandon = await completionCoordinator.completeTerminalOutcome({
      key: systemAbandonStarted.key,
      nodeId: "node-system-abandon",
      correlationId: CORRELATION as CorrelationId,
      result: systemAbandonResult,
      artifacts: [],
    });
    const abandonedStatus = await runAndWorkitemStatus(pool, RUN_SYSTEM_ABANDON, WORKITEM_SYSTEM_ABANDON);
    check(
      "executor system failure maps W5 abandoned when max attempts reached",
      abandonedStatus.runStatus === "failed_system" &&
        abandonedStatus.workitemStatus === "abandoned" &&
        abandonedStatus.workitemAttempts === 2,
      JSON.stringify(abandonedStatus),
    );
    await withTenantTx(pool, TENANT_A, async (c) => {
      const dlq = await c.query<{ reason_code: string; n: number }>(
        `SELECT reason_code, count(*)::int AS n
           FROM dead_letter
          WHERE tenant_id=$1::uuid AND run_id=$2::uuid
          GROUP BY reason_code`,
        [TENANT_A, RUN_SYSTEM_ABANDON],
      );
      check(
        "executor system failure creates dead_letter with catalog reason",
        dlq.rows[0]?.reason_code === "BROWSER_CRASH" && dlq.rows[0]?.n === 1,
        JSON.stringify(dlq.rows),
      );
    });
    check(
      "executor system abandoned emits workitem.dead_lettered",
      systemAbandon.emittedEvents.length === 3,
      JSON.stringify(systemAbandon),
    );

    const securityResult = stepResult("step-security", {
      status: "failed_security",
      artifacts: [],
      exception: {
        class: "security",
        code: "DOMAIN_POLICY_VIOLATION",
        message: "domain blocked" as RedactedString,
      },
    });
    const securityStarted = await beginStarted(RUN_SECURITY, "step-security", securityResult.action, "node-security");
    const security = await completionCoordinator.completeTerminalOutcome({
      key: securityStarted.key,
      nodeId: "node-security",
      correlationId: CORRELATION as CorrelationId,
      result: securityResult,
      artifacts: [],
    });
    const securityStatus = await runAndWorkitemStatus(pool, RUN_SECURITY, WORKITEM_SECURITY);
    check(
      "executor security failure maps R10 to aborting without workitem terminal mutation",
      securityStatus.runStatus === "aborting" && securityStatus.workitemStatus === "processing",
      JSON.stringify(securityStatus),
    );
    check(
      "executor security failure enqueues run_abort and notification",
      security.enqueuedRuntimeJobs.length === 1 &&
        security.enqueuedRuntimeJobs[0]?.kind === "run_abort" &&
        securityNotifications.some((item) => item.runId === RUN_SECURITY && item.code === "DOMAIN_POLICY_VIOLATION"),
      JSON.stringify({ jobs: security.enqueuedRuntimeJobs, securityNotifications }),
    );
    await withTenantTx(pool, TENANT_A, async (c) => {
      const row = await c.query<{ abort_source_status: string | null }>(
        `SELECT abort_source_status FROM runs WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [TENANT_A, RUN_SECURITY],
      );
      check("executor security failure persists abort_source_status", row.rows[0]?.abort_source_status === "running");
      const auditRows = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log`);
      check("executor security failure does not use security audit_log", auditRows.rows[0]?.n === 0, `n=${auditRows.rows[0]?.n}`);
    });

    const noNotifyCoordinator = new PgExecutorCompletionCoordinator(pool, runtimeJobEnqueuer);
    await expectReject(
      "executor security failure without notification port fails closed",
      () =>
        noNotifyCoordinator.completeTerminalOutcome({
          key: { tenantId: TENANT_A as TenantId, runId: RUN_A as RunId, stepId: "step-security-no-port" as StepId, attempt: 0 },
          nodeId: "node-security-no-port",
          correlationId: CORRELATION as CorrelationId,
          result: stepResult("step-security-no-port", {
            status: "failed_security",
            artifacts: [],
            exception: {
              class: "security",
              code: "DOMAIN_POLICY_VIOLATION",
              message: "domain blocked" as RedactedString,
            },
          }),
          artifacts: [],
        }),
      "ExecutorSecurityNotificationPort",
    );

    const challengeResult = stepResult("step-challenge", {
      status: "failed_challenge",
      artifacts: [],
      exception: {
        class: "challenge",
        code: "CHALLENGE_UNRESOLVED",
        message: "challenge detected" as RedactedString,
      },
    });
    const challengeStarted = await beginStarted(RUN_CHALLENGE, "step-challenge", challengeResult.action, "node-challenge");
    await expectReject(
      "executor challenge failure requires suspension bookmark port",
      () =>
        completionCoordinator.completeTerminalOutcome({
          key: challengeStarted.key,
          nodeId: "node-challenge",
          correlationId: CORRELATION as CorrelationId,
          result: challengeResult,
          artifacts: [],
        }),
      "ExecutorChallengeSuspensionPort",
    );
    check("executor challenge failure leaves started attempt", (await runStepStatus(pool, TENANT_A, RUN_CHALLENGE, "step-challenge")) === "started");
    check("executor challenge failure leaves run running", (await runAndWorkitemStatus(pool, RUN_CHALLENGE, WORKITEM_CHALLENGE)).runStatus === "running");

    const uncertainResult = stepResult("step-uncertain", {
      status: "uncertain",
      artifacts: [],
      exception: {
        class: "system",
        code: "VERIFY_FAILED",
        message: "verify uncertain" as RedactedString,
      },
    });
    const uncertainStarted = await beginStarted(RUN_UNCERTAIN, "step-uncertain", uncertainResult.action, "node-uncertain");
    await completionCoordinator.completeTerminalOutcome({
      key: uncertainStarted.key,
      nodeId: "node-uncertain",
      correlationId: CORRELATION as CorrelationId,
      result: uncertainResult,
      artifacts: [],
    });
    const uncertainStatus = await runAndWorkitemStatus(pool, RUN_UNCERTAIN, WORKITEM_UNCERTAIN);
    check(
      "executor uncertain outcome maps through explicit system catalog path",
      uncertainStatus.runStatus === "failed_system" && uncertainStatus.workitemStatus === "retry",
      JSON.stringify(uncertainStatus),
    );

    await expectReject(
      "executor skipped outcome is unsupported fail-closed",
      () =>
        completionCoordinator.completeTerminalOutcome({
          key: { tenantId: TENANT_A as TenantId, runId: RUN_A as RunId, stepId: "step-skipped" as StepId, attempt: 0 },
          nodeId: "node-skipped",
          correlationId: CORRELATION as CorrelationId,
          result: stepResult("step-skipped", { status: "skipped", artifacts: [] }),
          artifacts: [],
        }),
      "not terminal-outcome-mappable",
    );

    await expectReject(
      "executor system failure requires catalog code",
      () =>
        completionCoordinator.completeTerminalOutcome({
          key: { tenantId: TENANT_A as TenantId, runId: RUN_A as RunId, stepId: "step-system-unknown-code" as StepId, attempt: 0 },
          nodeId: "node-system-unknown-code",
          correlationId: CORRELATION as CorrelationId,
          result: stepResult("step-system-unknown-code", {
            status: "failed_system",
            artifacts: [],
            exception: {
              class: "system",
              code: "SYSTEM_UNKNOWN",
              message: "unknown system" as RedactedString,
            },
          }),
          artifacts: [],
        }),
      "error-catalog",
    );

    const okResult = stepResult("step-ok");
    const okStarted = await beginStarted(RUN_A, "step-ok", okResult.action, "node-ok");
    const recorded = await recorder.record({
      key: okStarted.key,
      nodeId: "node-ok",
      correlationId: CORRELATION as CorrelationId,
      result: okResult,
      artifacts: artifactFor(okResult),
    });
    check("executor recorder returns runStepId", recorded.runStepId.length > 0, JSON.stringify(recorded));
    check("executor recorder emits step.completed only", recorded.emittedEvents.length === 1, JSON.stringify(recorded));

    await withTenantTx(pool, TENANT_A, async (c) => {
      const row = await c.query<{
        status: string;
        action: string;
        cache_mode: string;
        artifacts: string[];
        side_effect: { kind?: string; committed?: boolean };
      }>(
        `SELECT status, action, cache_mode, artifacts, side_effect
           FROM run_steps
          WHERE run_id=$1::uuid AND step_id='step-ok' AND attempt=0`,
        [RUN_A],
      );
      check("run_steps row persisted", row.rowCount === 1, `rowCount=${row.rowCount}`);
      check("run_steps status/action persisted", row.rows[0]?.status === "success" && row.rows[0]?.action === "navigate", JSON.stringify(row.rows[0]));
      check("run_steps artifact refs persisted", row.rows[0]?.artifacts?.[0] === okResult.artifacts[0], JSON.stringify(row.rows[0]));
      check("run_steps side_effect safe JSON persisted", row.rows[0]?.side_effect?.kind === "read_only", JSON.stringify(row.rows[0]));

      const event = await c.query<{ step_id: string; attempt: number; payload: unknown; retention_set: boolean }>(
        `SELECT step_id, attempt, payload, retention_until IS NOT NULL AS retention_set
           FROM events_outbox
          WHERE run_id=$1::uuid AND step_id='step-ok' AND event_type='step.completed'`,
        [RUN_A],
      );
      check("step.completed canonical ref persisted", event.rows[0]?.step_id === "step-ok" && event.rows[0]?.attempt === 0, JSON.stringify(event.rows[0]));
      check("step.completed payload closed-empty", JSON.stringify(event.rows[0]?.payload) === "{}");
      check("step.completed retention set", event.rows[0]?.retention_set === true, JSON.stringify(event.rows[0]));

      const visibleArtifacts = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM artifacts WHERE run_id=$1::uuid AND step_id='step-ok'`,
        [RUN_A],
      );
      check("pending artifact metadata is hidden by redaction RLS", visibleArtifacts.rows[0]?.n === 0, `n=${visibleArtifacts.rows[0]?.n}`);
    });

    await expectReject(
      "duplicate step attempt fails closed",
      () =>
        recorder.record({
          key: okStarted.key,
          nodeId: "node-ok",
          correlationId: CORRELATION as CorrelationId,
          result: okResult,
          artifacts: artifactFor(okResult),
        }),
      "executor invocation requires an existing local started attempt",
    );
    check("duplicate does not create extra event", (await stepEventCount(pool, TENANT_A, RUN_A, "step-ok")) === 1);

    const stagehandMissing = stepResult("step-stagehand-missing", {
      artifacts: [],
      stagehandCallIds: ["10000000-0000-0000-0000-0000000000ff"],
    });
    const stagehandMissingStarted = await beginStarted(
      RUN_A,
      "step-stagehand-missing",
      stagehandMissing.action,
      "node-stagehand-missing",
    );
    await expectReject(
      "missing stagehand call rolls back run_step",
      () =>
        recorder.record({
          key: stagehandMissingStarted.key,
          nodeId: "node-stagehand-missing",
          correlationId: CORRELATION as CorrelationId,
          result: stagehandMissing,
          artifacts: [],
        }),
      "stagehandCallIds are not durably persisted",
    );
    check("stagehand failure leaves started run_step", (await runStepStatus(pool, TENANT_A, RUN_A, "step-stagehand-missing")) === "started");
    check("stagehand failure leaves no event", (await stepEventCount(pool, TENANT_A, RUN_A, "step-stagehand-missing")) === 0);

    const crossTenant = stepResult("step-cross", { artifacts: [] });
    await expectReject(
      "cross-tenant run ref fails closed",
      () =>
        recorder.record({
          key: { tenantId: TENANT_B as TenantId, runId: RUN_A as RunId, stepId: "step-cross" as StepId, attempt: 0 },
          nodeId: "node-cross",
          correlationId: CORRELATION as CorrelationId,
          result: crossTenant,
          artifacts: [],
        }),
      "run not found",
    );
    check("cross-tenant failure leaves tenant A untouched", (await runStepCount(pool, TENANT_A, RUN_A, "step-cross")) === 0);

    await expectReject(
      "artifact metadata mismatch fails closed",
      () =>
        recorder.record({
          key: { tenantId: TENANT_A as TenantId, runId: RUN_A as RunId, stepId: "step-artifact-missing" as StepId, attempt: 0 },
          nodeId: "node-artifact-missing",
          correlationId: CORRELATION as CorrelationId,
          result: stepResult("step-artifact-missing"),
          artifacts: [],
        }),
      "artifact metadata",
    );
    check("artifact mismatch leaves no run_step", (await runStepCount(pool, TENANT_A, RUN_A, "step-artifact-missing")) === 0);

    await expectReject(
      "step.completed without canonical refs fails closed",
      () =>
        withTenantTx(pool, TENANT_A, (c) =>
          emitOutboxEvent(c, {
            tenantId: TENANT_A,
            eventType: "step.completed",
            correlationId: CORRELATION,
            runId: RUN_A,
            idempotencyKey: "bad-step-completed-no-ref",
            retentionPolicy: EVENTS_OUTBOX_RETENTION_POLICY,
          }),
        ),
      "requires runId, stepId",
    );

    const secretStore = new FakeSecretStore({ "secret://tenant-a/executor-recorder": "do-not-serialize" });
    const secret = await secretStore.resolve(asSecretRef("secret://tenant-a/executor-recorder"));
    const secretResult = stepResult("step-secret", {
      artifacts: [],
      sideEffect: { kind: "read_only", receiptRef: secret as PlainSecret as unknown as ArtifactRef, committed: true },
    });
    await expectReject(
      "PlainSecret in StepResult JSON fails closed",
      () =>
        recorder.record({
          key: { tenantId: TENANT_A as TenantId, runId: RUN_A as RunId, stepId: "step-secret" as StepId, attempt: 0 },
          nodeId: "node-secret",
          correlationId: CORRELATION as CorrelationId,
          result: secretResult,
          artifacts: [],
        }),
      "PlainSecret",
    );
    check("PlainSecret failure leaves no run_step", (await runStepCount(pool, TENANT_A, RUN_A, "step-secret")) === 0);

    const secretPageResult = stepResult("step-secret-page", {
      artifacts: [],
      pageStateBefore: secret as PlainSecret as PageStateRef,
    });
    await expectReject(
      "PlainSecret in page state ref fails closed",
      () =>
        recorder.record({
          key: { tenantId: TENANT_A as TenantId, runId: RUN_A as RunId, stepId: "step-secret-page" as StepId, attempt: 0 },
          nodeId: "node-secret-page",
          correlationId: CORRELATION as CorrelationId,
          result: secretPageResult,
          artifacts: [],
        }),
      "PlainSecret",
    );
    check("PlainSecret page ref failure leaves no run_step", (await runStepCount(pool, TENANT_A, RUN_A, "step-secret-page")) === 0);

    const secretArtifactResult = stepResult("step-secret-artifact", {
      artifacts: [secret as PlainSecret as unknown as ArtifactRef],
    });
    await expectReject(
      "PlainSecret in artifact ref fails closed",
      () =>
        recorder.record({
          key: { tenantId: TENANT_A as TenantId, runId: RUN_A as RunId, stepId: "step-secret-artifact" as StepId, attempt: 0 },
          nodeId: "node-secret-artifact",
          correlationId: CORRELATION as CorrelationId,
          result: secretArtifactResult,
          artifacts: artifactFor(secretArtifactResult),
        }),
      "PlainSecret",
    );
    check("PlainSecret artifact ref failure leaves no run_step", (await runStepCount(pool, TENANT_A, RUN_A, "step-secret-artifact")) === 0);

    const secretObjectRefResult = stepResult("step-secret-object-ref");
    const secretObjectRefMetadata = artifactFor(secretObjectRefResult);
    secretObjectRefMetadata[0] = {
      ...secretObjectRefMetadata[0]!,
      objectRef: secret as PlainSecret as unknown as ObjectRef,
    };
    await expectReject(
      "PlainSecret in artifact object_ref fails closed",
      () =>
        recorder.record({
          key: { tenantId: TENANT_A as TenantId, runId: RUN_A as RunId, stepId: "step-secret-object-ref" as StepId, attempt: 0 },
          nodeId: "node-secret-object-ref",
          correlationId: CORRELATION as CorrelationId,
          result: secretObjectRefResult,
          artifacts: secretObjectRefMetadata,
        }),
      "PlainSecret",
    );
    check("PlainSecret object_ref failure leaves no run_step", (await runStepCount(pool, TENANT_A, RUN_A, "step-secret-object-ref")) === 0);
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D3 executor invocation recorder integration green");
}

main().catch((err) => {
  console.error("FAIL: executor invocation recorder integration threw:", err);
  process.exit(1);
});
