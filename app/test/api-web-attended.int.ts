/**
 * Integration test for /v1/web-attended/run-requests and /v1/run-resume-requests.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-web-attended.int.ts
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
const SCHEMA = "rpa_web_attended_int";
const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const SCENARIO_A = "15000000-0000-4000-8000-000000000001";
const SVER_A = "15000000-0000-4000-8000-000000000002";
const TASK_A = "15000000-0000-4000-8000-000000000003";
const TASK_RUN_A = "15000000-0000-4000-8000-000000000004";
const SCENARIO_B = "25000000-0000-4000-8000-000000000001";
const SVER_B = "25000000-0000-4000-8000-000000000002";
const SECRET = new TextEncoder().encode("web-attended-int-secret-do-not-use-in-prod-0123456789");

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

type Pool = ReturnType<typeof createPool>;

async function seedTenant(pool: Pool, tenant: string, scenarioId: string, versionId: string): Promise<void> {
  await withTenantTx(pool, tenant, async (client) => {
    await client.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1::uuid, $2::uuid, 'web attended scenario')`, [
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

async function runRow(pool: Pool, runId: string): Promise<{ status: string; priority: string; params: unknown } | null> {
  return withTenantTx(pool, TENANT_A, async (client) => {
    const result = await client.query<{ status: string; priority: string; params: unknown }>(
      `SELECT status, priority, params FROM runs WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [TENANT_A, runId],
    );
    return result.rows[0] ?? null;
  });
}

async function webAttendedLedgerCount(pool: Pool, requestId: string): Promise<number> {
  return withTenantTx(pool, TENANT_A, async (client) => {
    const result = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM web_attended_run_requests WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [TENANT_A, requestId],
    );
    return result.rows[0]?.n ?? 0;
  });
}

async function auditReasonCount(pool: Pool, reason: string): Promise<number> {
  return withTenantTx(pool, TENANT_A, async (client) => {
    const result = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'run.create' AND reason = $1`,
      [reason],
    );
    return result.rows[0]?.n ?? 0;
  });
}

function humanTaskPolicyDefaults(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return record.default_timeout_ms === 1_800_000 &&
    record.on_timeout === "fail" &&
    Array.isArray(record.allowed_kinds) &&
    record.allowed_kinds.includes("approval") &&
    record.allowed_kinds.includes("captcha");
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const runClaims: RunEnqueueInput[] = [];
  const enqueuer: RunEnqueuer = {
    async enqueueRunClaim(_client, input) {
      runClaims.push(input);
    },
    async enqueueRunAbort() {},
    async enqueueRunResume() {},
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
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'suspended', '{}'::jsonb, '2026-06-29T00:00:00Z', $1::uuid)`,
        [TASK_RUN_A, TENANT_A, SVER_A],
      );
      await client.query(
        `INSERT INTO human_tasks (id, tenant_id, run_id, kind, state, payload, resolved_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'approval', 'resolved', '{}'::jsonb, '2026-06-29T00:01:00Z')`,
        [TASK_A, TENANT_A, TASK_RUN_A],
      );
    });

    const operator = await mint(["operator"]);
    const viewer = await mint(["viewer"]);
    const operatorB = await mint(["operator"], TENANT_B, "operator-b");
    const createBody = {
      scenario_version_id: SVER_A,
      params: {
        as_of: "2026-06-30T00:00:00.000Z",
        case_id: "ATT-1001",
      },
      priority: "high",
      human_task_id: TASK_A,
      consent: {
        summary: "Finance owner approved Web Attended launch.",
        evidence_ref: "ticket:RPA-ATT-1001",
        input_refs: ["artifact://input/a", "artifact://input/a", "artifact://input/b"],
      },
      metadata: { requested_from: "integration_test" },
      legal_hold: true,
    };

    const created = await app.inject({
      method: "POST",
      url: "/v1/web-attended/run-requests",
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": "web-attended-create-1" },
      payload: createBody,
    });
    check("operator creates Web Attended request -> 201", created.statusCode === 201, created.body);
    const createdBody = created.json() as {
      request_id: string;
      run_id: string | null;
      human_task_id: string | null;
      status: string;
      consent_summary: string;
      consent_evidence_ref: string | null;
      input_refs: readonly string[];
      human_task_policy: unknown;
      metadata: Record<string, unknown>;
      legal_hold: boolean;
    };
    check("request is linked to queued run and human task", createdBody.status === "run_queued" && createdBody.run_id !== null && createdBody.human_task_id === TASK_A, created.body);
    check("input refs are deduped and metadata-only", createdBody.input_refs.length === 2 && createdBody.input_refs[0] === "artifact://input/a", created.body);
    check("Web Attended uses shared human-task policy defaults", humanTaskPolicyDefaults(createdBody.human_task_policy), created.body);
    check("metadata and legal hold are preserved", createdBody.metadata.requested_from === "integration_test" && createdBody.legal_hold === true, created.body);
    check("run claim enqueued", runClaims.length === 1 && runClaims[0]?.runId === createdBody.run_id && runClaims[0]?.priority === "high", JSON.stringify(runClaims));
    const run = createdBody.run_id === null ? null : await runRow(pool, createdBody.run_id);
    check("linked run persisted queued with priority and params", run?.status === "queued" && run.priority === "high", JSON.stringify(run));
    check("run.create audit appended", (await auditReasonCount(pool, "web_attended_run_requested")) === 1);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/web-attended/run-requests",
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": "web-attended-create-1" },
      payload: createBody,
    });
    check("same Web Attended idempotency key replays same request", replay.statusCode === 201 && replay.json().request_id === createdBody.request_id, replay.body);
    check("Web Attended replay does not duplicate ledger", (await webAttendedLedgerCount(pool, createdBody.request_id)) === 1);
    check("Web Attended replay does not enqueue duplicate run", runClaims.length === 1, JSON.stringify(runClaims));

    const listed = await app.inject({
      method: "GET",
      url: "/v1/web-attended/run-requests?status=run_queued&limit=5",
      headers: { authorization: `Bearer ${operator}` },
    });
    check("operator lists Web Attended requests -> 200", listed.statusCode === 200, listed.body);
    check("list returns created request", listed.json().items.length === 1 && listed.json().items[0].request_id === createdBody.request_id, listed.body);

    const resumeList = await app.inject({
      method: "GET",
      url: "/v1/run-resume-requests?limit=5",
      headers: { authorization: `Bearer ${operator}` },
    });
    check("operator lists empty run-resume ledger -> 200", resumeList.statusCode === 200 && resumeList.json().items.length === 0, resumeList.body);

    const viewerCreate = await app.inject({
      method: "POST",
      url: "/v1/web-attended/run-requests",
      headers: { authorization: `Bearer ${viewer}`, "idempotency-key": "web-attended-viewer" },
      payload: createBody,
    });
    check("viewer Web Attended create denied -> 403", viewerCreate.statusCode === 403 && viewerCreate.json().code === "AUTHZ_FORBIDDEN", viewerCreate.body);

    const badMetadata = await app.inject({
      method: "POST",
      url: "/v1/web-attended/run-requests",
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": "web-attended-bad-metadata" },
      payload: { ...createBody, metadata: { access_token: "plain-secret" } },
    });
    check("secret-like metadata rejected -> 422", badMetadata.statusCode === 422 && badMetadata.json().code === "IR_SCHEMA_INVALID", badMetadata.body);

    const crossTenantList = await app.inject({
      method: "GET",
      url: "/v1/web-attended/run-requests",
      headers: { authorization: `Bearer ${operatorB}` },
    });
    check("tenant B cannot see tenant A Web Attended request", crossTenantList.statusCode === 200 && crossTenantList.json().items.length === 0, crossTenantList.body);
  } finally {
    await app.close();
    await pool.end();
  }

  if (failures > 0) {
    console.error(`api-web-attended.int: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("api-web-attended.int: ALL PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
