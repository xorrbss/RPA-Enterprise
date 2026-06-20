/**
 * Integration test for PgLlmCallIdempotencyStore.
 *
 * Run:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/llm-call-idempotency-store.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ArtifactRef } from "../../ts/core-types";
import type { LLMRequest, LLMResponse } from "../../ts/security-middleware-contract";
import { createPool, withTenantTx } from "../src/db/pool";
import { PgLlmCallIdempotencyStore } from "../src/gateway/pg-llm-call-idempotency-store";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_llm_call_idem_int";
const TENANT = "00000000-0000-0000-0000-00000000aa11";
const SCENARIO = "10000000-0000-0000-0000-00000000aa11";
const SCENARIO_VERSION = "11000000-0000-0000-0000-00000000aa11";
const RUN = "12000000-0000-0000-0000-00000000aa11";

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
    model: "codex",
    promptTemplateVersion: "dom-executor@1",
    messages: [{ role: "user", content: "observe page" }],
    metadata: { tenantId: TENANT, runId: RUN, stepId: "observe-page", attempt: 0, primitive: "observe", correlationId: RUN },
    budget: { maxInputTokens: 10000, maxOutputTokens: 1000, maxCost: 1 },
    idempotencyKey: "idem-observe-page",
    requestHash: "sha256:observe-page",
    ...over,
  } as unknown as LLMRequest;
}

async function seed(pool: Pool): Promise<void> {
  await withTenantTx(pool, TENANT, async (client) => {
    await client.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1::uuid, $2::uuid, 'llm idem')`, [SCENARIO, TENANT]);
    await client.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'draft', '{"nodes":[]}'::jsonb)`,
      [SCENARIO_VERSION, TENANT, SCENARIO],
    );
    await client.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, as_of, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'running', $1::uuid, 1, '2026-06-18T00:00:00Z', '2026-06-18T00:00:00Z')`,
      [RUN, TENANT, SCENARIO_VERSION],
    );
    await client.query(
      `INSERT INTO run_steps (id, tenant_id, run_id, step_id, node_id, attempt, action, status, started_at, created_at)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'observe-page', 'observe-page', 0, 'observe', 'started',
               '2026-06-18T00:00:01Z', '2026-06-18T00:00:01Z')`,
      [TENANT, RUN],
    );
  });
}

async function stagehandRow(pool: Pool, callId: string): Promise<{ stream_status: string | null; output_ref: string | null }> {
  return withTenantTx(pool, TENANT, async (client) => {
    const rows = await client.query<{ stream_status: string | null; output_ref: string | null }>(
      `SELECT stream_status, output_ref
         FROM stagehand_calls
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [TENANT, callId],
    );
    const row = rows.rows[0];
    if (row === undefined) throw new Error(`stagehand row ${callId} not found`);
    return row;
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

    await seed(pool);
    const store = new PgLlmCallIdempotencyStore(pool);
    const reserved = await store.reserve(makeReq());
    check("reserve: creates stagehand call row", reserved.kind === "reserved" && /^[0-9a-f-]{36}$/.test(reserved.callId), JSON.stringify(reserved));
    if (reserved.kind !== "reserved") throw new Error("reserve did not return reserved");

    const open = await stagehandRow(pool, reserved.callId);
    check("reserve: row starts open", open.stream_status === "open" && open.output_ref === null, JSON.stringify(open));

    const response: LLMResponse = {
      outputRef: "13000000-0000-0000-0000-00000000aa11" as ArtifactRef,
      usage: { inputTokens: 10, outputTokens: 5, cost: 0.0123 },
      finishReason: "stop",
      // structured output(act ActionPlan/extract 결과) — replay 가 이를 보존해야 함(#5 비대칭 회귀 가드).
      parsedJson: { operation: "fill", selector: "#q", value: "x" },
      stagehandCallId: reserved.callId,
    };
    await store.complete(reserved.callId, response);
    const done = await stagehandRow(pool, reserved.callId);
    check("complete: row done with output ref", done.stream_status === "done" && done.output_ref === response.outputRef, JSON.stringify(done));

    const replay = await store.reserve(makeReq());
    check(
      "reserve: same request replays completed response",
      replay.kind === "replay" && replay.response.outputRef === response.outputRef && replay.response.stagehandCallId === reserved.callId,
      JSON.stringify(replay),
    );
    // jsonb 는 키 순서를 보존하지 않으므로 필드별 비교(순서 무관).
    const replayedParsed = replay.kind === "replay" ? (replay.response.parsedJson as Record<string, unknown> | undefined) : undefined;
    check(
      "reserve: replay preserves parsedJson (structured output, #5)",
      replayedParsed !== undefined &&
        replayedParsed.operation === "fill" &&
        replayedParsed.selector === "#q" &&
        replayedParsed.value === "x",
      JSON.stringify(replayedParsed),
    );

    const blocked = await store.reserve(makeReq({ requestHash: "sha256:different" } as Partial<LLMRequest>));
    check("reserve: same key different hash blocks", blocked.kind === "blocked" && blocked.reason === "request_hash_mismatch", JSON.stringify(blocked));

    const failedReq = makeReq({ idempotencyKey: "idem-observe-failed", requestHash: "sha256:observe-failed" } as Partial<LLMRequest>);
    const failedReservation = await store.reserve(failedReq);
    if (failedReservation.kind !== "reserved") throw new Error("failed request reserve did not return reserved");
    await store.fail(failedReservation.callId, "RATE_LIMIT");
    const rerun = await store.reserve(failedReq);
    check("reserve: failed row can be reserved again", rerun.kind === "reserved" && rerun.callId === failedReservation.callId, JSON.stringify(rerun));

    if (failures > 0) {
      console.error(`\nFAIL: ${failures} check(s) failed`);
      process.exit(1);
    }
    console.log("\nPASS: PgLlmCallIdempotencyStore durable stagehand_calls idempotency");
    process.exit(0);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
