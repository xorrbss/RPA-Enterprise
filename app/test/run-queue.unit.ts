import type { PoolClient } from "pg";

import { PgGraphileRunEnqueuer } from "../src/api/run-queue";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail !== undefined ? ` -- ${detail}` : ""}`);
  }
}

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const CORRELATION = "20000000-0000-4000-8000-000000000001";
const ARTIFACT = "60000000-0000-4000-8000-000000000001";
const GENERATION = "80000000-0000-4000-8000-000000000001";

const calls: Array<{ readonly sql: string; readonly params: readonly unknown[] }> = [];
const client = {
  async query(sql: string, params?: readonly unknown[]) {
    calls.push({ sql, params: params ?? [] });
    return { rows: [], rowCount: 0 };
  },
} as unknown as PoolClient;

const enqueuer = new PgGraphileRunEnqueuer();
await enqueuer.enqueueArtifactRedaction(client, {
  tenantId: TENANT,
  correlationId: CORRELATION,
  artifactId: ARTIFACT,
  generationId: GENERATION,
});
const scopedPayload = JSON.parse(String(calls[0]?.params[1])) as Record<string, unknown>;
check("artifact redaction enqueue uses runtime task", calls[0]?.params[0] === "process_runtime_job");
check(
  "artifact redaction enqueue preserves scoped artifact and generation ids",
  scopedPayload.kind === "artifact_redaction" &&
    scopedPayload.tenantId === TENANT &&
    scopedPayload.correlationId === CORRELATION &&
    scopedPayload.artifactId === ARTIFACT &&
    scopedPayload.generationId === GENERATION &&
    scopedPayload.runId === undefined,
  JSON.stringify(scopedPayload),
);

await enqueuer.enqueueArtifactRedaction(client, {
  tenantId: TENANT,
  correlationId: CORRELATION,
});
const sweepPayload = JSON.parse(String(calls[1]?.params[1])) as Record<string, unknown>;
check(
  "artifact redaction maintenance enqueue remains unscoped",
  sweepPayload.kind === "artifact_redaction" &&
    sweepPayload.tenantId === TENANT &&
    sweepPayload.correlationId === CORRELATION &&
    sweepPayload.artifactId === undefined &&
    sweepPayload.generationId === undefined &&
    sweepPayload.runId === undefined,
  JSON.stringify(sweepPayload),
);

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS: run-queue scoped artifact redaction unit green");
