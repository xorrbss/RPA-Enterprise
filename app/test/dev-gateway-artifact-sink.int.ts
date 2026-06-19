/**
 * Dev 통합 — dev:serve run-loop용 visible artifact sink.
 *
 * dev run-loop는 단계 트레이스를 기록하더라도, LLM 출력 자체는 run-level artifact로 저장되어야 콘솔에서 결과를
 * 즉시 확인할 수 있다. 이 테스트는 put → artifacts SELECT 가 step FK 없이 not_required로 보이는지 검증한다.
 *
 * 실행(temp 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/dev-gateway-artifact-sink.int.ts
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { markPlainSecretFromStore } from "../../security/compliance-scaffold";
import type { ObjectRef } from "../../ts/core-types";
import { createPool, withTenantTx } from "../src/db/pool";
import { FsObjectStore, type ObjectStore } from "../src/gateway/pg-gateway-artifact-sink";
import { DevVisibleGatewayArtifactSink } from "../dev/dev-gateway-artifact-sink";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_dev_gateway_artifact_sink_int";
const TENANT = "00000000-0000-0000-0000-0000000000d1";
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000d2";
const SCENARIO = "10000000-0000-0000-0000-0000000000e3";
const SCENARIO_VERSION = "10000000-0000-0000-0000-0000000000e4";
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

class CountingObjectStore implements ObjectStore {
  puts = 0;
  deletes = 0;

  async put(_content: string): Promise<ObjectRef> {
    this.puts += 1;
    return "file:///tmp/dev-visible-unused.bin" as ObjectRef;
  }

  async get(_objectRef: ObjectRef): Promise<string | null> {
    return null;
  }

  async getBytes(_objectRef: ObjectRef): Promise<Uint8Array | null> {
    return null;
  }

  async delete(_objectRef: ObjectRef): Promise<void> {
    this.deletes += 1;
  }
}

async function currentRoleBypassesRls(pool: ReturnType<typeof createPool>): Promise<boolean> {
  const result = await pool.query<{ bypasses_rls: boolean }>(
    `SELECT rolsuper OR rolbypassrls AS bypasses_rls FROM pg_roles WHERE rolname = current_user`,
  );
  return result.rows[0]?.bypasses_rls === true;
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const dir = mkdtempSync(join(tmpdir(), "dev-visible-artifacts-"));
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

    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'dev-visible-sink-int')`, [SCENARIO, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
         VALUES ($1,$2,$3,1,'draft','{"nodes":[]}'::jsonb)`,
        [SCENARIO_VERSION, TENANT, SCENARIO],
      );
      await c.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id)
         VALUES ($1,$2,$3,'completed',$4)`,
        [RUN, TENANT, SCENARIO_VERSION, "20000000-0000-0000-0000-0000000000e8"],
      );
    });

    const store = new FsObjectStore(dir);
    const sink = new DevVisibleGatewayArtifactSink(pool, store, { type: "llm_output", retentionDays: 90 });
    const content = '{"records":[{"title":"공지사항 제목 1"}]}';
    const ref = await sink.put(content, {
      tenantId: TENANT,
      runId: RUN,
      stepId: "collect.0",
      attempt: 0,
    } as never);

    const row = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{
        id: string;
        run_id: string;
        step_id: string | null;
        attempt: number | null;
        type: string;
        redaction_status: string;
        object_ref: string;
      }>(
        `SELECT id::text, run_id::text, step_id, attempt, type, redaction_status, object_ref
           FROM artifacts WHERE id=$1::uuid`,
        [ref],
      );
      return r.rows[0] ?? null;
    });

    check("put returns visible artifact row", row !== null, String(ref));
    check("artifact is linked to run", row?.run_id === RUN, JSON.stringify(row));
    check("artifact is immediately readable by RLS", row?.redaction_status === "not_required", JSON.stringify(row));
    check("dev artifact remains run-level while steps can retain returned refs", row?.step_id === null && row?.attempt === null, JSON.stringify(row));
    check("object content matches original", row !== null && (await store.get(row.object_ref as ObjectRef)) === content);

    if (await currentRoleBypassesRls(pool)) {
      console.log("  SKIP  cross-tenant SELECT remains hidden — current DB role bypasses RLS");
    } else {
      const cross = await withTenantTx(pool, OTHER_TENANT, async (c) => {
        const r = await c.query(`SELECT id FROM artifacts WHERE id=$1::uuid`, [ref]);
        return r.rowCount ?? 0;
      });
      check("cross-tenant SELECT remains hidden", cross === 0, `rows=${cross}`);
    }

    const counting = new CountingObjectStore();
    const badSink = new DevVisibleGatewayArtifactSink(pool, counting, { type: "llm_output", retentionDays: 90 });
    await expectReject(
      "DB insert failure cleans up object",
      () =>
        badSink.put(content, {
          tenantId: TENANT,
          runId: "10000000-0000-0000-0000-000000009999",
          stepId: "collect.0",
          attempt: 0,
        } as never),
      "metadata insert failed closed",
    );
    check("failed DB insert deletes object", counting.puts === 1 && counting.deletes === 1, JSON.stringify(counting));

    const secret = markPlainSecretFromStore("super-secret-output");
    await expectReject(
      "PlainSecret content is rejected before object write",
      () => sink.put(secret as string, { tenantId: TENANT, runId: RUN, stepId: "collect.0", attempt: 0 } as never),
      "PlainSecret",
    );

    if (failures > 0) {
      console.error(`\nFAIL: ${failures} checks failed`);
      process.exit(1);
    }
    console.log("\nPASS: dev visible gateway artifact sink integration green");
  } finally {
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    } catch {
      /* ignore cleanup errors */
    }
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
