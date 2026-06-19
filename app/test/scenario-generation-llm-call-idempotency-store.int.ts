/**
 * Integration test for PgScenarioGenerationLlmCallIdempotencyStore.
 *
 * Run:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/scenario-generation-llm-call-idempotency-store.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ArtifactRef } from "../../ts/core-types";
import type { LLMRequest, LLMResponse } from "../../ts/security-middleware-contract";
import { PgScenarioGenerationLlmCallIdempotencyStore } from "../src/api/scenario-generation-llm-call-idempotency-store";
import { createPool, withTenantTx } from "../src/db/pool";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_generation_llm_call_idem_int";
const TENANT = "00000000-0000-0000-0000-00000000bb11";
const OTHER_TENANT = "00000000-0000-0000-0000-00000000bb12";
const GENERATION = "10000000-0000-0000-0000-00000000bb11";
const ARTIFACT = "11000000-0000-0000-0000-00000000bb11";
const MISSING_ARTIFACT = "11000000-0000-0000-0000-00000000bb12";
const CORRELATION = "20000000-0000-0000-0000-00000000bb11";

type Pool = ReturnType<typeof createPool>;

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` :: ${detail}` : ""}`);
  }
}

function makeReq(over: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: "codex-planner",
    promptTemplateVersion: "scenario-planner@1",
    messages: [{ role: "user", content: "plan this scenario" }],
    responseFormat: {
      type: "json_schema",
      schemaRef: "scenario-generation/planner-output@1",
      schemaVersion: "1",
      strict: false,
      schema: { type: "object" },
    },
    metadata: {
      tenantId: TENANT,
      runId: GENERATION,
      stepId: "scenario_generation_plan",
      attempt: 0,
      primitive: "extract",
      correlationId: CORRELATION,
    },
    budget: { maxInputTokens: 10000, maxOutputTokens: 1000, maxCost: 1 },
    idempotencyKey: "scenario-generation-plan-idem",
    requestHash: "sha256:scenario-generation-plan",
    ...over,
  } as unknown as LLMRequest;
}

async function seedGenerationAndArtifact(pool: Pool): Promise<void> {
  await withTenantTx(pool, TENANT, async (client) => {
    await client.query(
      `INSERT INTO scenario_generations
         (id, tenant_id, mode, status, prompt_hash, planner, draft_ir, validation_report,
          evidence_policy, blockers, created_by)
       VALUES ($1::uuid, $2::uuid, 'save', 'saved', 'sha256:prompt', 'llm_v1',
               '{"nodes":{}}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 'test')`,
      [GENERATION, TENANT],
    );
    await client.query(
      `INSERT INTO artifacts
         (id, tenant_id, generation_id, type, media_type, byte_size, redaction_status,
          sha256, object_ref, retention_until)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'scenario_generation_llm_output',
               'text/plain; charset=utf-8', 2, 'not_required',
               'sha256:planner-output', 'obj/planner-output', now() + interval '1 day')`,
      [ARTIFACT, TENANT, GENERATION],
    );
  });
}

async function callRow(
  pool: Pool,
  callId: string,
): Promise<{ stream_status: string; output_ref: string | null; parsed_json: unknown; error_code: string | null }> {
  return withTenantTx(pool, TENANT, async (client) => {
    const rows = await client.query<{ stream_status: string; output_ref: string | null; parsed_json: unknown; error_code: string | null }>(
      `SELECT stream_status, output_ref, parsed_json, error_code
         FROM scenario_generation_llm_calls
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [TENANT, callId],
    );
    const row = rows.rows[0];
    if (row === undefined) throw new Error(`scenario generation llm call row ${callId} not found`);
    return row;
  });
}

async function visibleCallCount(pool: Pool, tenantId: string): Promise<number> {
  return withTenantTx(pool, tenantId, async (client) => {
    const rows = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM scenario_generation_llm_calls`);
    return Number(rows.rows[0]?.count ?? "0");
  });
}

async function ageCallUpdatedAt(pool: Pool, callId: string, ageMs: number): Promise<void> {
  await withTenantTx(pool, TENANT, async (client) => {
    await client.query(
      `UPDATE scenario_generation_llm_calls
          SET updated_at = now() - ($3::int * interval '1 millisecond')
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [TENANT, callId, ageMs],
    );
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
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

    await seedGenerationAndArtifact(pool);
    const store = new PgScenarioGenerationLlmCallIdempotencyStore(pool, { retentionDays: 30 });

    const reserved = await store.reserve(makeReq());
    check("reserve: creates generation llm call row", reserved.kind === "reserved" && /^[0-9a-f-]{36}$/.test(reserved.callId), JSON.stringify(reserved));
    if (reserved.kind !== "reserved") throw new Error("reserve did not return reserved");
    check("reserve: duplicate open row reports in-flight", (await store.reserve(makeReq())).kind === "in_flight");

    const staleOpenReq = makeReq({ idempotencyKey: "scenario-generation-plan-stale-open", requestHash: "sha256:stale-open" } as Partial<LLMRequest>);
    const staleOpenStore = new PgScenarioGenerationLlmCallIdempotencyStore(pool, { retentionDays: 30, staleOpenReclaimMs: 1 });
    const staleOpenReservation = await staleOpenStore.reserve(staleOpenReq);
    if (staleOpenReservation.kind !== "reserved") throw new Error("stale open reserve did not return reserved");
    await ageCallUpdatedAt(pool, staleOpenReservation.callId, 10_000);
    const staleOpenRerun = await staleOpenStore.reserve(staleOpenReq);
    check(
      "reserve: stale open row is reclaimed",
      staleOpenRerun.kind === "reserved" && staleOpenRerun.callId === staleOpenReservation.callId,
      JSON.stringify(staleOpenRerun),
    );

    const parsedJson = { draft_ir: { meta: { name: "generated", version: 1 }, nodes: {} }, blockers: [], params: {} };
    const response: LLMResponse = {
      outputRef: ARTIFACT as ArtifactRef,
      usage: { inputTokens: 12, outputTokens: 34, cost: 0.056 },
      finishReason: "stop",
      parsedJson,
      stagehandCallId: reserved.callId,
    };
    await store.complete(reserved.callId, response);
    const done = await callRow(pool, reserved.callId);
    check("complete: row done with parsed JSON", done.stream_status === "done" && done.output_ref === ARTIFACT && isRecord(done.parsed_json), JSON.stringify(done));

    const replay = await store.reserve(makeReq());
    check(
      "reserve: same request replays parsed planner output",
      replay.kind === "replay" &&
        replay.response.outputRef === ARTIFACT &&
        replay.response.stagehandCallId === reserved.callId &&
        isRecord(replay.response.parsedJson),
      JSON.stringify(replay),
    );

    const blocked = await store.reserve(makeReq({ requestHash: "sha256:different" } as Partial<LLMRequest>));
    check("reserve: same key different hash blocks", blocked.kind === "blocked" && blocked.reason === "request_hash_mismatch", JSON.stringify(blocked));

    const failedReq = makeReq({ idempotencyKey: "scenario-generation-plan-failed", requestHash: "sha256:failed" } as Partial<LLMRequest>);
    const failedReservation = await store.reserve(failedReq);
    if (failedReservation.kind !== "reserved") throw new Error("failed request reserve did not return reserved");
    await store.fail(failedReservation.callId, "RATE_LIMIT");
    const failedRow = await callRow(pool, failedReservation.callId);
    check("fail: row records adapter error", failedRow.stream_status === "error" && failedRow.error_code === "RATE_LIMIT", JSON.stringify(failedRow));
    const rerun = await store.reserve(failedReq);
    check("reserve: failed row can be reserved again", rerun.kind === "reserved" && rerun.callId === failedReservation.callId, JSON.stringify(rerun));

    const missingArtifactReq = makeReq({
      idempotencyKey: "scenario-generation-plan-missing-artifact",
      requestHash: "sha256:missing-artifact",
    } as Partial<LLMRequest>);
    const missingArtifactReservation = await store.reserve(missingArtifactReq);
    if (missingArtifactReservation.kind !== "reserved") throw new Error("missing artifact reserve did not return reserved");
    await store.complete(missingArtifactReservation.callId, {
      ...response,
      outputRef: MISSING_ARTIFACT as ArtifactRef,
      stagehandCallId: missingArtifactReservation.callId,
    });
    const rerunMissingArtifact = await store.reserve(missingArtifactReq);
    check(
      "reserve: done row without durable artifact is reopened",
      rerunMissingArtifact.kind === "reserved" && rerunMissingArtifact.callId === missingArtifactReservation.callId,
      JSON.stringify(rerunMissingArtifact),
    );

    check("RLS: same tenant sees generation llm call rows", (await visibleCallCount(pool, TENANT)) >= 3);
    check("RLS: other tenant sees no generation llm call rows", (await visibleCallCount(pool, OTHER_TENANT)) === 0);

    await store.discardGenerationLlmCalls({ tenantId: TENANT, generationId: GENERATION });
    check("discard: removes generation llm call rows", (await visibleCallCount(pool, TENANT)) === 0);

    if (failures > 0) {
      console.error(`\nFAIL: ${failures} check(s) failed`);
      process.exit(1);
    }
    console.log("\nPASS: PgScenarioGenerationLlmCallIdempotencyStore durable generation idempotency");
    process.exit(0);
  } finally {
    await pool.end();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
