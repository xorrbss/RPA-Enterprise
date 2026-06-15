/**
 * Graphile RuntimeWorker task boundary unit tests.
 *
 * The queue adapter must not treat deferred/failed RuntimeJobResult values as a
 * successful Graphile job. Only `completed` may acknowledge the task.
 */
import { assertRuntimeJobCompleted } from "../src/worker/graphile-runner";

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

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS: D2.5 graphile-runner task boundary unit green");
