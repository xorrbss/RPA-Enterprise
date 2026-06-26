/**
 * Integration test for POST /v1/runs/{run_id}/rerun.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-run-rerun.int.ts
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueueInput, RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import { createPool, withTenantTx } from "../src/db/pool";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_run_rerun_int";
const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const SCENARIO_A = "11000000-0000-4000-8000-000000000001";
const SVER_A = "11000000-0000-4000-8000-000000000002";
const RUN_FAILED = "11000000-0000-4000-8000-000000000003";
const RUN_RUNNING = "11000000-0000-4000-8000-000000000004";
const SCENARIO_B = "22000000-0000-4000-8000-000000000001";
const SVER_B = "22000000-0000-4000-8000-000000000002";
const RUN_B = "22000000-0000-4000-8000-000000000003";
const CORR_A = "33000000-0000-4000-8000-000000000001";
const CORR_B = "33000000-0000-4000-8000-000000000002";
const SECRET = new TextEncoder().encode("run-rerun-int-secret-do-not-use-in-prod-0123456789");

const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return { kind: "available", snapshot: { sourceRef: "secret://staging/registry" as SecretRef, commands: [] } };
  },
};

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

function mint(roles: string[], tenant = TENANT_A, sub = "operator-a"): Promise<string> {
  return new SignJWT({ sub, tenant_id: tenant, roles })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(SECRET);
}

async function seedTenant(pool: ReturnType<typeof createPool>, tenant: string, scenarioId: string, versionId: string): Promise<void> {
  await withTenantTx(pool, tenant, async (client) => {
    await client.query(
      `INSERT INTO gateway_policies (id, tenant_id, model, capabilities, budget, is_default)
       VALUES ($1::uuid, $2::uuid, 'gpt-4o-mini', '{"jsonMode":true}'::jsonb, '{"maxInputTokens":1000}'::jsonb, true)`,
      [randomUUID(), tenant],
    );
    await client.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1::uuid, $2::uuid, 'rerun scenario')`, [
      scenarioId,
      tenant,
    ]);
    await client.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'prod', $4::jsonb)`,
      [
        versionId,
        tenant,
        scenarioId,
        JSON.stringify({
          target: {
            site_profile_id: "site-profile-a",
            browser_identity_id: "browser-identity-a",
            network_policy_id: "network-policy-a",
          },
          nodes: [],
        }),
      ],
    );
  });
}

async function auditReasonCount(pool: ReturnType<typeof createPool>, reason: string): Promise<number> {
  return withTenantTx(pool, TENANT_A, async (client) => {
    const row = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'run.rerun' AND reason = $1`,
      [reason],
    );
    return row.rows[0]?.n ?? 0;
  });
}

async function rerunRows(pool: ReturnType<typeof createPool>): Promise<Array<{ source_run_id: string; child_run_id: string; mode: string; params: unknown }>> {
  return withTenantTx(pool, TENANT_A, async (client) => {
    const rows = await client.query<{ source_run_id: string; child_run_id: string; mode: string; params: unknown }>(
      `SELECT source_run_id::text, child_run_id::text, mode, params
         FROM run_reruns
        WHERE tenant_id = $1::uuid
        ORDER BY created_at ASC`,
      [TENANT_A],
    );
    return rows.rows;
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const enqueued: RunEnqueueInput[] = [];
  const enqueuer: RunEnqueuer = {
    async enqueueRunClaim(_client, input) {
      enqueued.push(input);
    },
    async enqueueRunAbort() {},
    async enqueueSinkDeliver() {},
  };
  const app = buildServer({
    pool,
    auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
    rbac: new RoleMatrixRbacMiddleware(),
    idempotency: new PgControlPlaneIdempotencyStore(pool),
    enqueuer,
    signedCommandRegistry,
  });
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
    await app.ready();

    await seedTenant(pool, TENANT_A, SCENARIO_A, SVER_A);
    await seedTenant(pool, TENANT_B, SCENARIO_B, SVER_B);
    await withTenantTx(pool, TENANT_A, async (client) => {
      await client.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, params, as_of, model, correlation_id, failure_reason)
         VALUES
           ($1::uuid, $2::uuid, $3::uuid, 'failed_system', '{"invoice_id":"A-1"}'::jsonb, '2026-06-25T01:02:03Z', 'gpt-4o-mini', $4::uuid, '{"code":"RUN_LOOP_FAILED","message":"navigation failed"}'::jsonb),
           ($5::uuid, $2::uuid, $3::uuid, 'running', '{"invoice_id":"A-2"}'::jsonb, '2026-06-25T01:02:03Z', 'gpt-4o-mini', $6::uuid, NULL)`,
        [RUN_FAILED, TENANT_A, SVER_A, CORR_A, RUN_RUNNING, CORR_B],
      );
    });
    await withTenantTx(pool, TENANT_B, async (client) => {
      await client.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, params, as_of, model, correlation_id, failure_reason)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'failed_system', '{}'::jsonb, now(), 'gpt-4o-mini', $1::uuid, '{"code":"RUN_LOOP_FAILED","message":"b"}'::jsonb)`,
        [RUN_B, TENANT_B, SVER_B],
      );
    });

    const operator = await mint(["operator"]);
    const viewer = await mint(["viewer"]);
    const operatorB = await mint(["operator"], TENANT_B, "operator-b");

    const postRerun = (token: string, runId: string, key: string, body: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: `/v1/runs/${runId}/rerun`,
        headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
        payload: body,
      });

    const same = await postRerun(operator, RUN_FAILED, "rerun-same", { mode: "same_input", reason: "retry after outage" });
    check("same-input rerun -> 201", same.statusCode === 201 && same.json().status === "queued", same.body);
    const sameChild = same.json().run_id;
    const sameRows = await rerunRows(pool);
    check("same-input rerun row links source and child", sameRows.length === 1 && sameRows[0]?.source_run_id === RUN_FAILED && sameRows[0]?.child_run_id === sameChild, JSON.stringify(sameRows));
    check("same-input preserves source params", JSON.stringify(sameRows[0]?.params) === JSON.stringify({ invoice_id: "A-1" }), JSON.stringify(sameRows[0]?.params));
    check("same-input audit appended", (await auditReasonCount(pool, "run_rerun_created")) === 1);
    check("same-input child enqueued", enqueued.some((item) => item.runId === sameChild), JSON.stringify(enqueued));

    const replay = await postRerun(operator, RUN_FAILED, "rerun-same", { mode: "same_input", reason: "retry after outage" });
    check("same idempotency key replays original child", replay.statusCode === 201 && replay.json().run_id === sameChild, replay.body);
    check("idempotency replay does not add rerun row", (await rerunRows(pool)).length === 1);

    const edited = await postRerun(operator, RUN_FAILED, "rerun-edited", {
      mode: "edited_input",
      params: { invoice_id: "A-9", as_of: "2026-06-26T00:00:00Z" },
      reason: "operator corrected invoice",
    });
    check("edited-input rerun -> 201", edited.statusCode === 201 && edited.json().mode === "edited_input", edited.body);
    const rowsAfterEdited = await rerunRows(pool);
    const editedParams = rowsAfterEdited[1]?.params as { invoice_id?: unknown; as_of?: unknown } | undefined;
    check(
      "edited-input stores edited params",
      rowsAfterEdited.length === 2 &&
        editedParams?.invoice_id === "A-9" &&
        editedParams.as_of === "2026-06-26T00:00:00Z",
      JSON.stringify(rowsAfterEdited),
    );

    const badMode = await postRerun(operator, RUN_FAILED, "rerun-bad-mode", { mode: "same_input", params: {} });
    check("same_input with params -> 422", badMode.statusCode === 422 && badMode.json().details?.reason === "same_input_params_not_allowed", badMode.body);

    const notFailed = await postRerun(operator, RUN_RUNNING, "rerun-running", { mode: "same_input" });
    check("running run rerun rejected -> 409", notFailed.statusCode === 409 && notFailed.json().details?.reason === "run_rerun_requires_failed_status", notFailed.body);

    const denied = await postRerun(viewer, RUN_FAILED, "rerun-viewer", { mode: "same_input" });
    check("viewer rerun denied -> 403", denied.statusCode === 403 && denied.json().code === "AUTHZ_FORBIDDEN", denied.body);

    const crossTenant = await postRerun(operatorB, RUN_FAILED, "rerun-cross", { mode: "same_input" });
    check("cross-tenant source hidden -> 404", crossTenant.statusCode === 404 && crossTenant.json().code === "RUN_NOT_FOUND", crossTenant.body);
  } finally {
    await app.close();
    await pool.end();
  }
  if (failures > 0) {
    console.error(`\nFAIL: ${failures} run rerun check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: /v1/runs/{run_id}/rerun integration green");
}

main().catch((err) => {
  console.error("api-run-rerun integration fatal:", err);
  process.exit(1);
});
