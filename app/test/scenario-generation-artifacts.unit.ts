/**
 * Unit tests for buffered scenario-generation artifacts.
 *
 * The buffer writes object bytes before the outer generation transaction commits.
 * Until commit is confirmed, those object refs must remain cleanup-eligible.
 */
import type { PoolClient } from "pg";

import type { ObjectRef } from "../../ts/core-types";
import type { RunId, TenantId } from "../../ts/security-middleware-contract";
import { BufferedScenarioGenerationArtifactSink } from "../src/api/scenario-generation-artifacts";
import type { ObjectStore } from "../src/gateway/pg-gateway-artifact-sink";

const TENANT = "00000000-0000-4000-8000-00000000aa11";
const GENERATION = "10000000-0000-4000-8000-00000000aa11";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

class FakeObjectStore implements ObjectStore {
  readonly puts: string[] = [];
  readonly deletes: ObjectRef[] = [];

  async put(content: string): Promise<ObjectRef> {
    this.puts.push(content);
    return `object://artifact-${this.puts.length}` as ObjectRef;
  }

  async get(_objectRef: ObjectRef): Promise<string | null> {
    return null;
  }

  async getBytes(_objectRef: ObjectRef): Promise<Uint8Array | null> {
    return null;
  }

  async delete(objectRef: ObjectRef): Promise<void> {
    this.deletes.push(objectRef);
  }
}

class FakeClient {
  readonly inserts: Array<{ text: string; params?: readonly unknown[] }> = [];

  async query(text: string, params?: readonly unknown[]): Promise<{ rows: [] }> {
    this.inserts.push({ text, params });
    return { rows: [] };
  }
}

async function flushOne(
  sink: BufferedScenarioGenerationArtifactSink,
  client: FakeClient,
  content: string,
): Promise<void> {
  await sink.put(content, {
    tenantId: TENANT as TenantId,
    runId: GENERATION as RunId,
    attempt: 0,
  });
  await sink.flushGenerationArtifacts(client as unknown as PoolClient, { tenantId: TENANT, generationId: GENERATION });
}

async function main(): Promise<void> {
  const rollbackStore = new FakeObjectStore();
  const rollbackSink = new BufferedScenarioGenerationArtifactSink(rollbackStore, { retentionDays: 90 });
  const rollbackClient = new FakeClient();
  await flushOne(rollbackSink, rollbackClient, "planner output before outer commit");
  await rollbackSink.discardGenerationArtifacts(GENERATION);

  check("flush writes object bytes", rollbackStore.puts.length === 1, JSON.stringify(rollbackStore.puts));
  check("flush inserts artifact metadata", rollbackClient.inserts.length === 1 && rollbackClient.inserts[0]?.text.includes("INSERT INTO artifacts") === true);
  check("discard after flush deletes uncommitted object", rollbackStore.deletes.join(",") === "object://artifact-1", JSON.stringify(rollbackStore.deletes));

  const commitStore = new FakeObjectStore();
  const commitSink = new BufferedScenarioGenerationArtifactSink(commitStore, { retentionDays: 90 });
  const commitClient = new FakeClient();
  await flushOne(commitSink, commitClient, "planner output after outer commit");
  await commitSink.commitGenerationArtifacts(GENERATION);
  await commitSink.discardGenerationArtifacts(GENERATION);

  check("commit releases object from rollback cleanup", commitStore.deletes.length === 0, JSON.stringify(commitStore.deletes));

  if (failures > 0) {
    console.error(`\nFAIL: scenario-generation-artifacts.unit (${failures})`);
    process.exit(1);
  }
  console.log("\nPASS: scenario-generation-artifacts.unit");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
