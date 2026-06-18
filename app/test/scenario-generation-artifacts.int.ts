/**
 * Integration test for generation-scoped artifact storage.
 *
 * 실행:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/scenario-generation-artifacts.int.ts
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ObjectRef } from "../../ts/core-types";
import type { RunId, TenantId } from "../../ts/security-middleware-contract";
import { createPool, withTenantTx } from "../src/db/pool";
import { PgScenarioGenerationArtifactSink } from "../src/api/scenario-generation-artifacts";
import { FsObjectStore } from "../src/gateway/pg-gateway-artifact-sink";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_generation_artifacts_int";
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

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const artifactDir = mkdtempSync(join(tmpdir(), "rpa-generation-artifact-sink-"));
  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
    } finally {
      setup.release();
    }

    const store = new FsObjectStore(artifactDir);
    const directSink = new PgScenarioGenerationArtifactSink(pool, store, { retentionDays: 90 });
    let missingGenerationFailed = false;
    try {
      await directSink.put("planner output before generation row exists", {
        tenantId: TENANT as TenantId,
        runId: GENERATION as RunId,
        attempt: 0,
      });
    } catch {
      missingGenerationFailed = true;
    }
    check("direct generation artifact sink fails before generation row exists", missingGenerationFailed);

    await withTenantTx(pool, TENANT, async (client) => {
      await client.query(
        `INSERT INTO scenario_generations
           (id, tenant_id, mode, status, prompt_hash, planner, model, draft_ir, validation_report,
            evidence_policy, blockers, created_by)
         VALUES ($1::uuid, $2::uuid, 'save', 'saved', $3, 'llm_v1', 'planner-model', $4::jsonb, $5::jsonb,
                 $6::jsonb, $7::jsonb, 'operator-a')`,
        [
          GENERATION,
          TENANT,
          createHash("sha256").update("generation artifact prompt").digest("hex"),
          JSON.stringify({ meta: { name: "generation-artifact", version: 1 }, start: "done", nodes: { done: { terminal: "success" } } }),
          JSON.stringify({ ok: true }),
          JSON.stringify({ screenshot: "failure", video: "never" }),
          JSON.stringify([]),
        ],
      );
    });

    const sink = new PgScenarioGenerationArtifactSink(pool, store, { retentionDays: 90 });
    const content = "planner output with email ada@example.com";
    const artifactRef = await sink.put(content, {
      tenantId: TENANT as TenantId,
      runId: GENERATION as RunId,
      attempt: 0,
    });

    const visible = await withTenantTx(pool, TENANT, async (client) =>
      client.query(`SELECT id FROM artifacts WHERE id=$1::uuid`, [artifactRef]),
    );
    check("pending generation artifact is hidden by normal artifact RLS", visible.rowCount === 0, JSON.stringify(visible.rows));

    const admin = createPool({
      host: process.env.PGHOST,
      port: process.env.PGPORT === undefined ? undefined : Number(process.env.PGPORT),
      database: process.env.PGDATABASE,
      user: "postgres",
      password: process.env.PGADMIN_PASSWORD,
      options: `-c search_path=${SCHEMA},public`,
    });
    try {
      const rows = await admin.query<{
        generation_id: string | null;
        run_id: string | null;
        step_id: string | null;
        attempt: number | null;
        type: string;
        media_type: string | null;
        byte_size: string | null;
        redaction_status: string;
        object_ref: string;
      }>(
        `SELECT generation_id::text, run_id::text, step_id, attempt, type, media_type,
                byte_size::text, redaction_status, object_ref
           FROM artifacts
          WHERE id=$1::uuid`,
        [artifactRef],
      );
      const row = rows.rows[0];
      check(
        "generation artifact metadata links to generation only",
        row?.generation_id === GENERATION &&
          row.run_id === null &&
          row.step_id === null &&
          row.attempt === null &&
          row.type === "scenario_generation_llm_output" &&
          row.redaction_status === "pending",
        JSON.stringify(row),
      );
      check("generation artifact records text media metadata", row?.media_type === "text/plain; charset=utf-8" && row.byte_size === String(Buffer.byteLength(content, "utf8")), JSON.stringify(row));
      const stored = row === undefined ? null : await store.get(row.object_ref as ObjectRef);
      check("generation artifact object bytes are stored", stored === content, String(stored));
    } finally {
      await admin.end();
    }

    if (failures > 0) {
      console.error(`\nFAIL: scenario-generation-artifacts.int (${failures})`);
      process.exit(1);
    }
    console.log("\nPASS: scenario-generation-artifacts.int");
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
