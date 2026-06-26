/**
 * Integration test for POST /v1/runs/{run_id}/resume.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-run-resume.int.ts
 */
import { readFileSync } from "node:fs";
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
const SCHEMA = "rpa_run_resume_int";
const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const SCENARIO_A = "14000000-0000-4000-8000-000000000001";
const SVER_A = "14000000-0000-4000-8000-000000000002";
const RUN_SUSPENDED = "14000000-0000-4000-8000-000000000003";
const RUN_RESUME_REQUESTED = "14000000-0000-4000-8000-000000000004";
const RUN_RUNNING = "14000000-0000-4000-8000-000000000005";
const RUN_UNRESOLVED = "14000000-0000-4000-8000-000000000006";
const TASK_UNRESOLVED = "14000000-0000-4000-8000-000000000007";
const SCENARIO_B = "24000000-0000-4000-8000-000000000001";
const SVER_B = "24000000-0000-4000-8000-000000000002";
const RUN_B = "24000000-0000-4000-8000-000000000003";
const SECRET = new TextEncoder().encode("run-resume-int-secret-do-not-use-in-prod-0123456789");

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
    await client.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1::uuid, $2::uuid, 'resume scenario')`, [
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

async function runStatus(pool: ReturnType<typeof createPool>, runId: string): Promise<string | null> {
  return withTenantTx(pool, TENANT_A, async (client) => {
    const result = await client.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1::uuid`, [runId]);
    return result.rows[0]?.status ?? null;
  });
}

async function auditReasonCount(pool: ReturnType<typeof createPool>, reason: string): Promise<number> {
  return withTenantTx(pool, TENANT_A, async (client) => {
    const row = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'run.resume' AND reason = $1`,
      [reason],
    );
    return row.rows[0]?.n ?? 0;
  });
}

async function outboxCount(pool: ReturnType<typeof createPool>, runId: string, eventType: string): Promise<number> {
  return withTenantTx(pool, TENANT_A, async (client) => {
    const row = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events_outbox WHERE run_id = $1::uuid AND event_type = $2`,
      [runId, eventType],
    );
    return row.rows[0]?.n ?? 0;
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const resumeEnqueued: RunEnqueueInput[] = [];
  const enqueuer: RunEnqueuer = {
    async enqueueRunClaim() {},
    async enqueueRunAbort() {},
    async enqueueRunResume(_client, input) {
      resumeEnqueued.push(input);
    },
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
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, params, as_of, correlation_id)
         VALUES
           ($1::uuid, $2::uuid, $3::uuid, 'suspended', '{}'::jsonb, '2026-06-25T01:02:03Z', $1::uuid),
           ($4::uuid, $2::uuid, $3::uuid, 'resume_requested', '{}'::jsonb, '2026-06-25T01:02:03Z', $4::uuid),
           ($5::uuid, $2::uuid, $3::uuid, 'running', '{}'::jsonb, '2026-06-25T01:02:03Z', $5::uuid),
           ($6::uuid, $2::uuid, $3::uuid, 'suspended', '{}'::jsonb, '2026-06-25T01:02:03Z', $6::uuid)`,
        [RUN_SUSPENDED, TENANT_A, SVER_A, RUN_RESUME_REQUESTED, RUN_RUNNING, RUN_UNRESOLVED],
      );
      await client.query(
        `INSERT INTO human_tasks (id, tenant_id, run_id, kind, state, payload)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'exception', 'open', '{}'::jsonb)`,
        [TASK_UNRESOLVED, TENANT_A, RUN_UNRESOLVED],
      );
    });
    await withTenantTx(pool, TENANT_B, async (client) => {
      await client.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, params, as_of, correlation_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'suspended', '{}'::jsonb, now(), $1::uuid)`,
        [RUN_B, TENANT_B, SVER_B],
      );
    });

    const operator = await mint(["operator"]);
    const viewer = await mint(["viewer"]);
    const operatorB = await mint(["operator"], TENANT_B, "operator-b");

    const postResume = (token: string, runId: string, key: string, body: Record<string, unknown> = {}) =>
      app.inject({
        method: "POST",
        url: `/v1/runs/${runId}/resume`,
        headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
        payload: body,
      });

    const resumed = await postResume(operator, RUN_SUSPENDED, "resume-suspended", { reason: "operator repair" });
    check("suspended resume -> 202", resumed.statusCode === 202 && resumed.json().status === "resume_requested", resumed.body);
    check("run status persisted resume_requested", (await runStatus(pool, RUN_SUSPENDED)) === "resume_requested");
    check("resume enqueued", resumeEnqueued.length === 1 && resumeEnqueued[0]?.runId === RUN_SUSPENDED, JSON.stringify(resumeEnqueued));
    check("run.resume_requested event emitted", (await outboxCount(pool, RUN_SUSPENDED, "run.resume_requested")) === 1);
    check("run.resume audit appended", (await auditReasonCount(pool, "run_resume_requested")) === 1);

    const replay = await postResume(operator, RUN_SUSPENDED, "resume-suspended", { reason: "operator repair" });
    check("same idempotency key replays", replay.statusCode === 202 && replay.json().previous_status === "suspended", replay.body);
    check("replay does not enqueue again", resumeEnqueued.length === 1, JSON.stringify(resumeEnqueued));

    const reenqueued = await postResume(operator, RUN_RESUME_REQUESTED, "resume-reenqueue", { reason: "lost job repair" });
    check("resume_requested resume re-enqueues -> 202", reenqueued.statusCode === 202 && reenqueued.json().previous_status === "resume_requested", reenqueued.body);
    check("resume_requested re-enqueue recorded", resumeEnqueued.length === 2 && resumeEnqueued[1]?.runId === RUN_RESUME_REQUESTED, JSON.stringify(resumeEnqueued));
    check("run.resume reenqueue audit appended", (await auditReasonCount(pool, "run_resume_reenqueued")) === 1);

    const unresolved = await postResume(operator, RUN_UNRESOLVED, "resume-unresolved", { reason: "skip review" });
    check("unresolved human task blocks resume -> 409", unresolved.statusCode === 409 && unresolved.json().details?.reason === "human_task_unresolved", unresolved.body);
    check("unresolved run remains suspended", (await runStatus(pool, RUN_UNRESOLVED)) === "suspended");

    const running = await postResume(operator, RUN_RUNNING, "resume-running");
    check("running resume rejected -> 409", running.statusCode === 409 && running.json().details?.reason === "run_resume_requires_suspended_or_resume_requested", running.body);

    const denied = await postResume(viewer, RUN_RESUME_REQUESTED, "resume-viewer");
    check("viewer resume denied -> 403", denied.statusCode === 403 && denied.json().code === "AUTHZ_FORBIDDEN", denied.body);

    const crossTenant = await postResume(operatorB, RUN_SUSPENDED, "resume-cross");
    check("cross-tenant run hidden -> 404", crossTenant.statusCode === 404 && crossTenant.json().code === "RUN_NOT_FOUND", crossTenant.body);
  } finally {
    await app.close();
    await pool.end();
  }
  if (failures > 0) {
    console.error(`\nFAIL: ${failures} run resume check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: /v1/runs/{run_id}/resume integration green");
}

main().catch((err) => {
  console.error("api-run-resume integration fatal:", err);
  process.exit(1);
});
