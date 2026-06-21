/**
 * D3 executor invocation recorder integration.
 *
 * Records StepResult evidence under tenant RLS and proves local pre-execution
 * attempt ownership (PgExecutorStepAttemptStore) plus invocation recording
 * (PgExecutorInvocationRecorder) — the two production primitives used by
 * run-step-driver. This does not run a browser, resolve secrets, or claim
 * staging readiness. (Terminal-run completion is covered by the production
 * driveClaimedRun path in run-step-driver.int / runtime-worker-drive.int.)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { FakeSecretStore, asSecretRef } from "../../security/compliance-scaffold";
import type {
  ArtifactRef,
  ObjectRef,
  PageStateRef,
  PlainSecret,
  StepResult,
} from "../../ts/core-types";
import type { CorrelationId, RunId, StepId, TenantId } from "../../ts/security-middleware-contract";
import type { ExecutorInvocationArtifactMetadata, IsoDateTime } from "../../ts/runtime-contract";
import { createPool, withTenantTx } from "../src/db/pool";
import { PgExecutorInvocationRecorder } from "../src/runtime/executor-invocation-recorder";
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

const STARTED_STAGEHAND_CALL = "30000000-0000-0000-0000-0000000000a8";

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

    const attemptStore = new PgExecutorStepAttemptStore(pool);
    const recorder = new PgExecutorInvocationRecorder(pool);

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
