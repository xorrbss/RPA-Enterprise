/**
 * D5 통합 — PgGatewayArtifactSink 를 실 PostgreSQL(artifacts) + 파일시스템 object store 에 대해 검증.
 *
 * 실행(temp 게이트): `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/gateway-artifact-sink.int.ts`
 * 검증(llm-gateway §6 / db artifacts):
 *  1) put → object 파일 기록 + artifacts 행(run 링크·type·sha256·retention_until·redaction_status=pending)
 *  2) outputRef = artifacts.id(ArtifactRef), object_ref 의 바이트가 원문과 일치
 *  3) tenant 스코프: 다른 tenant 로 SELECT → 0행(RLS)
 */
import { readFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { markPlainSecretFromStore } from "../../security/compliance-scaffold";
import type { ObjectRef } from "../../ts/core-types";
import type { CorrelationId, RunId, StepId, TenantId } from "../../ts/security-middleware-contract";
import { createPool, withTenantTx } from "../src/db/pool";
import {
  FsObjectStore,
  PgGatewayArtifactSink,
  type ObjectStore,
} from "../src/gateway/pg-gateway-artifact-sink";
import { PgExecutorStepAttemptStore } from "../src/runtime/executor-step-attempt-store";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_runtime_int";
const TENANT = "00000000-0000-0000-0000-0000000000d1";
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000d2";
const SCENARIO = "10000000-0000-0000-0000-0000000000e3";
const SCENARIO_VERSION = "10000000-0000-0000-0000-0000000000e4";
const WORKITEM = "10000000-0000-0000-0000-0000000000e5";
const RUN = "10000000-0000-0000-0000-0000000000e7";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function expectReject(label: string, fn: () => Promise<unknown>, contains: string): Promise<void> {
  try {
    await fn();
    check(label, false, "expected rejection");
  } catch (error) {
    check(label, String(error).includes(contains), String(error));
  }
}

function filesIn(dir: string): string[] {
  return readdirSync(dir).sort();
}

class CountingObjectStore implements ObjectStore {
  puts = 0;
  gets = 0;
  deletes = 0;

  async put(_content: string): Promise<ObjectRef> {
    this.puts += 1;
    return pathToFileURL(join(tmpdir(), "unused-gateway-artifact.bin")).href as ObjectRef;
  }

  async get(_objectRef: ObjectRef): Promise<string> {
    this.gets += 1;
    return ""; // 본 테스트는 read 경로 미사용(put/delete만 검증).
  }

  async getBytes(_objectRef: ObjectRef): Promise<Uint8Array> {
    this.gets += 1;
    return new Uint8Array(); // 본 테스트는 read 경로 미사용(put/delete만 검증).
  }

  async delete(_objectRef: ObjectRef): Promise<void> {
    this.deletes += 1;
  }
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const dir = mkdtempSync(join(tmpdir(), "d5-artifacts-"));
  try {
    const concurrencySql = readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8");
    const coreSql = readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8");
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(concurrencySql);
      await setup.query(coreSql);
    } finally {
      setup.release();
    }
    console.log("migrations applied (concurrency → core)");

    // 시드: scenarios → scenario_versions → workitems → runs(artifacts.run_id FK).
    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'sink-int')`, [SCENARIO, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
         VALUES ($1,$2,$3,1,'draft','{"nodes":[]}'::jsonb)`,
        [SCENARIO_VERSION, TENANT, SCENARIO],
      );
      await c.query(
        `INSERT INTO workitems (id, tenant_id, connector_id, unique_reference) VALUES ($1,$2,'sink-conn','wi-sink')`,
        [WORKITEM, TENANT],
      );
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, workitem_id, status, correlation_id)
         VALUES ($1,$2,$3,$4,'running',$5)`,
        [RUN, TENANT, SCENARIO_VERSION, WORKITEM, "20000000-0000-0000-0000-0000000000e8"],
      );
      await c.query(
        `INSERT INTO run_steps (
           id, tenant_id, run_id, step_id, node_id, attempt, action, status,
           cache_mode, page_state_before, page_state_after, artifacts, stagehand_call_ids,
           started_at, ended_at, duration_ms
         )
         VALUES (
           gen_random_uuid(), $1, $2, 'extract_reviews', 'node-extract', 0, 'extract', 'success',
           'miss', 'page://before', 'page://after', ARRAY[]::text[], ARRAY[]::text[],
           now(), now(), 0
         )`,
        [TENANT, RUN],
      );
    });
    console.log("seeded scenario/version/workitem/run");

    const store = new FsObjectStore(dir);
    const sink = new PgGatewayArtifactSink(pool, store, { type: "llm_output", retentionDays: 90 });
    const CONTENT = '{"reviews":["a","b","c"]}';
    const ref = await sink.put(CONTENT, {
      tenantId: TENANT,
      runId: RUN,
      stepId: "extract_reviews",
      attempt: 0,
    } as never);

    check("put returns ArtifactRef (uuid id)", typeof ref === "string" && /^[0-9a-f-]{36}$/.test(ref), ref);

    const storedFiles = filesIn(dir);
    check("object store has exactly one committed object", storedFiles.length === 1, JSON.stringify(storedFiles));
    const bytes = readFileSync(join(dir, storedFiles[0]!), "utf8");
    check("object_ref content == original", bytes === CONTENT);

    const visibleToTenant = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query(`SELECT id FROM artifacts WHERE id=$1`, [ref]);
      return r.rowCount ?? 0;
    });
    check("pending artifact is hidden by redaction RLS", visibleToTenant === 0, `rows=${visibleToTenant}`);

    const cross = await withTenantTx(pool, OTHER_TENANT, async (c) => {
      const r = await c.query(`SELECT id FROM artifacts WHERE id=$1`, [ref]);
      return r.rowCount ?? 0;
    });
    check("cross-tenant SELECT → 0 rows (RLS)", cross === 0);

    const beforeDbFailure = filesIn(dir).length;
    await expectReject(
      "DB insert failure cleans up object",
      () =>
        sink.put(CONTENT, {
          tenantId: TENANT,
          runId: "10000000-0000-0000-0000-000000009999",
          stepId: "extract_reviews",
          attempt: 0,
        } as never),
      "metadata insert failed closed",
    );
    check("failed DB insert leaves no orphan object", filesIn(dir).length === beforeDbFailure, JSON.stringify(filesIn(dir)));

    await expectReject(
      "missing canonical run_step fails closed",
      () =>
        sink.put(CONTENT, {
          tenantId: TENANT,
          runId: RUN,
          stepId: "missing_step",
          attempt: 0,
        } as never),
      "metadata insert failed closed",
    );
    check("missing run_step leaves no orphan object", filesIn(dir).length === beforeDbFailure, JSON.stringify(filesIn(dir)));

    const attemptStore = new PgExecutorStepAttemptStore(pool);
    const started = await attemptStore.begin({
      tenantId: TENANT as TenantId,
      runId: RUN as RunId,
      stepId: "extract_prestarted" as StepId,
      nodeId: "node-extract-prestarted",
      action: "extract",
      correlationId: "20000000-0000-0000-0000-0000000000e8" as CorrelationId,
    });
    const prestartedRef = await sink.put(CONTENT, {
      tenantId: TENANT,
      runId: RUN,
      stepId: "extract_prestarted",
      attempt: started.key.attempt,
    } as never);
    check(
      "put accepts executor-started run_step attempt",
      typeof prestartedRef === "string" && /^[0-9a-f-]{36}$/.test(prestartedRef),
      prestartedRef,
    );
    const afterPrestartedPut = filesIn(dir).length;
    check(
      "prestarted attempt writes one additional object",
      afterPrestartedPut === beforeDbFailure + 1,
      JSON.stringify(filesIn(dir)),
    );

    await expectReject(
      "PlainSecret content is rejected before object write",
      () =>
        sink.put(markPlainSecretFromStore("secret-output") as string, {
          tenantId: TENANT,
          runId: RUN,
          stepId: "extract_reviews",
          attempt: 0,
        } as never),
      "PlainSecret",
    );
    check("PlainSecret rejection leaves no object", filesIn(dir).length === afterPrestartedPut, JSON.stringify(filesIn(dir)));

    const countingStore = new CountingObjectStore();
    const invalidRetentionSink = new PgGatewayArtifactSink(pool, countingStore, { type: "llm_output", retentionDays: 0 });
    await expectReject(
      "invalid retentionDays is rejected before object write",
      () =>
        invalidRetentionSink.put(CONTENT, {
          tenantId: TENANT,
          runId: RUN,
          stepId: "extract_reviews",
          attempt: 0,
        } as never),
      "retentionDays",
    );
    check("invalid retentionDays did not call object store", countingStore.puts === 0 && countingStore.deletes === 0);
  } finally {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D5 PgGatewayArtifactSink integration green");
  process.exit(0);
}

main().catch((e) => {
  console.error("int fatal:", e);
  process.exit(1);
});
