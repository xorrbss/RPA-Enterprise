/**
 * Graphile RuntimeWorker task boundary unit tests.
 *
 * The queue adapter must not treat deferred/failed RuntimeJobResult values as a
 * successful Graphile job. Only `completed` may acknowledge the task.
 */
import { PgGraphileRunEnqueuer } from "../src/api/run-queue";
import {
  assertRuntimeJobCompleted,
  buildTaskList,
  RUNTIME_CONTROL_JOB_TASK,
  RUNTIME_LIFECYCLE_JOB_TASK,
  runtimeJobTaskIdentifier,
} from "../src/worker/graphile-runner";
import type { RuntimeWorkerJob } from "../../ts/runtime-contract";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

function caught(fn: () => void): Error | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

async function caughtAsync(fn: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

const job = { kind: "run_claim", tenantId: "tenant", runId: "run" } as never;

assertRuntimeJobCompleted(job, { kind: "completed", emittedEvents: [] });
check("completed RuntimeJobResult is acknowledged", true);

const deferred = caught(() =>
  assertRuntimeJobCompleted(job, { kind: "deferred", code: "SESSION_LOCKED", retryAfterMs: 250 }),
);
check("deferred RuntimeJobResult throws", deferred?.message.includes("deferred with SESSION_LOCKED") === true, deferred?.message);
check("deferred RuntimeJobResult carries retryAfterMs", deferred?.message.includes("retryAfterMs=250") === true, deferred?.message);

const failed = caught(() =>
  assertRuntimeJobCompleted(job, { kind: "failed", code: "CONTROL_PLANE_INTERNAL_ERROR" }),
);
check("failed RuntimeJobResult throws", failed?.message.includes("failed with CONTROL_PLANE_INTERNAL_ERROR") === true, failed?.message);

check(
  "run_claim routes to control task",
  runtimeJobTaskIdentifier({ kind: "run_claim" } as never) === RUNTIME_CONTROL_JOB_TASK,
);
check(
  "artifact_redaction routes to lifecycle task",
  runtimeJobTaskIdentifier({ kind: "artifact_redaction" } as never) === RUNTIME_LIFECYCLE_JOB_TASK,
);
check(
  "artifact_retention routes to lifecycle task",
  runtimeJobTaskIdentifier({ kind: "artifact_retention" } as never) === RUNTIME_LIFECYCLE_JOB_TASK,
);
check(
  "artifact_integrity routes to lifecycle task (BYPASSRLS quarantine UPDATE)",
  runtimeJobTaskIdentifier({ kind: "artifact_integrity" } as never) === RUNTIME_LIFECYCLE_JOB_TASK,
);

const controlTasks = buildTaskList({} as never);
check(
  "default task list excludes lifecycle worker task",
  controlTasks[RUNTIME_CONTROL_JOB_TASK] !== undefined && controlTasks[RUNTIME_LIFECYCLE_JOB_TASK] === undefined,
);
const lifecycleTasks = buildTaskList({} as never, {}, "artifact_lifecycle");
check(
  "lifecycle task list excludes control worker task",
  lifecycleTasks[RUNTIME_CONTROL_JOB_TASK] === undefined && lifecycleTasks[RUNTIME_LIFECYCLE_JOB_TASK] !== undefined,
);
const refusedLifecycleOnControl = await caughtAsync(() =>
  Promise.resolve(
    controlTasks[RUNTIME_CONTROL_JOB_TASK]!(
      {
        kind: "artifact_redaction",
        tenantId: "tenant",
        correlationId: "corr",
      },
      {} as never,
    ),
  ),
);
check(
  "control task refuses lifecycle payload before worker handle",
  refusedLifecycleOnControl?.message.includes("refused artifact_redaction payload") === true,
  refusedLifecycleOnControl?.message,
);
const refusedControlOnLifecycle = await caughtAsync(() =>
  Promise.resolve(
    lifecycleTasks[RUNTIME_LIFECYCLE_JOB_TASK]!(
      {
        kind: "run_claim",
        tenantId: "tenant",
        runId: "run",
        correlationId: "corr",
      },
      {} as never,
    ),
  ),
);
check(
  "lifecycle task refuses control payload before worker handle",
  refusedControlOnLifecycle?.message.includes("refused run_claim payload") === true,
  refusedControlOnLifecycle?.message,
);

const enqueuedTasks: string[] = [];
const fakeClient = {
  async query(_sql: string, params: readonly unknown[]) {
    enqueuedTasks.push(String(params[0]));
    return { rows: [], rowCount: 0 };
  },
} as never;
const enqueuer = new PgGraphileRunEnqueuer();
await enqueuer.enqueueRuntimeJob(fakeClient, {
  kind: "run_claim",
  tenantId: "tenant" as never,
  runId: "run" as never,
  correlationId: "corr" as never,
} satisfies RuntimeWorkerJob);
await enqueuer.enqueueRuntimeJob(fakeClient, {
  kind: "artifact_redaction",
  tenantId: "tenant" as never,
  correlationId: "corr" as never,
} satisfies RuntimeWorkerJob);
check(
  "PgGraphileRunEnqueuer writes run jobs to control task",
  enqueuedTasks[0] === RUNTIME_CONTROL_JOB_TASK,
  JSON.stringify(enqueuedTasks),
);
check(
  "PgGraphileRunEnqueuer writes lifecycle jobs to lifecycle task",
  enqueuedTasks[1] === RUNTIME_LIFECYCLE_JOB_TASK,
  JSON.stringify(enqueuedTasks),
);

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS: D2.5 graphile-runner task boundary unit green");
