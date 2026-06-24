/**
 * Integration test for /v1/ops-alerts.
 *
 * Run with:
 *   npm --prefix app exec tsx -- app/test/api-ops-alerts.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import { createPool, withTenantTx } from "../src/db/pool";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_ops_alerts_int";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const SCEN_A = "8a000000-0000-4000-8000-000000000001";
const SVER_A = "8a000000-0000-4000-8000-000000000002";
const SCEN_B = "8b000000-0000-4000-8000-000000000001";
const SVER_B = "8b000000-0000-4000-8000-000000000002";
const RUN_A = "8a100000-0000-4000-8000-000000000001";
const RUN_FAIL_1 = "8a100000-0000-4000-8000-000000000101";
const RUN_FAIL_2 = "8a100000-0000-4000-8000-000000000102";
const RUN_FAIL_3 = "8a100000-0000-4000-8000-000000000103";
const RUN_SLA_EXTRA = [
  "8a100000-0000-4000-8000-000000000201",
  "8a100000-0000-4000-8000-000000000202",
  "8a100000-0000-4000-8000-000000000203",
  "8a100000-0000-4000-8000-000000000204",
] as const;
const RUN_B = "8b100000-0000-4000-8000-000000000001";
const HT_WARNING = "8a200000-0000-4000-8000-000000000001";
const HT_CRITICAL = "8a200000-0000-4000-8000-000000000002";
const TRIGGER_A = "8a300000-0000-4000-8000-000000000001";
const FIRE_A = "8a310000-0000-4000-8000-000000000001";
const WORKITEM_A = "8a400000-0000-4000-8000-000000000001";
const DLQ_A = "8a410000-0000-4000-8000-000000000001";

const SECRET = new TextEncoder().encode("ops-alerts-int-secret-do-not-use-in-prod-0123456789");

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
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function mint(roles: string[], tenant = TENANT_A, sub = "viewer-a"): Promise<string> {
  return new SignJWT({ sub, tenant_id: tenant, roles })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(SECRET);
}

function isoMinutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

type Pool = ReturnType<typeof createPool>;

async function seedScenario(pool: Pool, tenant: string, scenarioId: string, versionId: string): Promise<void> {
  await withTenantTx(pool, tenant, async (client) => {
    await client.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'ops alerts')`, [scenarioId, tenant]);
    await client.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'prod','{"nodes":[],"target":{"site_profile_id":"00000000-0000-4000-8000-000000000001","browser_identity_id":"00000000-0000-4000-8000-000000000002","network_policy_id":"00000000-0000-4000-8000-000000000003"}}'::jsonb)`,
      [versionId, tenant, scenarioId],
    );
  });
}

async function seedAlerts(pool: Pool): Promise<void> {
  await seedScenario(pool, TENANT_A, SCEN_A, SVER_A);
  await seedScenario(pool, TENANT_B, SCEN_B, SVER_B);

  await withTenantTx(pool, TENANT_A, async (client) => {
    await client.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, created_at, updated_at)
       VALUES ($1,$2,$3,'running',$1,$4::timestamptz,$5::timestamptz)`,
      [RUN_A, TENANT_A, SVER_A, isoMinutesFromNow(-90), isoMinutesFromNow(-5)],
    );
    for (const [index, runId] of RUN_SLA_EXTRA.entries()) {
      await client.query(
        `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, created_at, updated_at)
         VALUES ($1,$2,$3,'running',$1,$4::timestamptz,$5::timestamptz)`,
        [runId, TENANT_A, SVER_A, isoMinutesFromNow(-100 - index), isoMinutesFromNow(-10 - index)],
      );
    }
    await client.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, created_at, updated_at)
       VALUES ($1,$2,$5,'failed_system',$1,$6::timestamptz,$7::timestamptz),
              ($3,$2,$5,'failed_business',$3,$6::timestamptz,$8::timestamptz),
              ($4,$2,$5,'failed_system',$4,$6::timestamptz,$9::timestamptz)`,
      [RUN_FAIL_1, TENANT_A, RUN_FAIL_2, RUN_FAIL_3, SVER_A, isoMinutesFromNow(-12), isoMinutesFromNow(-8), isoMinutesFromNow(-5), isoMinutesFromNow(-2)],
    );
    await client.query(
      `INSERT INTO human_tasks (id, tenant_id, run_id, kind, state, expires_at, assignee)
       VALUES ($1,$2,$3,'validation','open',$4::timestamptz,'reviewer-a'),
              ($5,$2,$3,'approval','in_progress',$6::timestamptz,'approver-a')`,
      [HT_WARNING, TENANT_A, RUN_A, isoMinutesFromNow(10), HT_CRITICAL, isoMinutesFromNow(-6)],
    );
    await client.query(
      `INSERT INTO run_triggers (id, tenant_id, scenario_version_id, cron_expression, timezone, created_by)
       VALUES ($1,$2,$3,'0 9 * * *','Asia/Seoul','operator-a')`,
      [TRIGGER_A, TENANT_A, SVER_A],
    );
    await client.query(
      `INSERT INTO run_trigger_fires (id, tenant_id, trigger_id, fire_key, status, scheduled_for, failure_reason, correlation_id)
       VALUES ($1,$2,$3,'2026-06-23T00:00:00.000Z','failed',$4::timestamptz,'{"code":"CONTROL_PLANE_INTERNAL_ERROR"}'::jsonb,$1)`,
      [FIRE_A, TENANT_A, TRIGGER_A, isoMinutesFromNow(-30)],
    );
    await client.query(
      `INSERT INTO workitems (id, tenant_id, connector_id, unique_reference, status)
       VALUES ($1,$2,'ops-alerts','ops-alerts-ref','failed_system')`,
      [WORKITEM_A, TENANT_A],
    );
    await client.query(
      `INSERT INTO dead_letter (id, tenant_id, workitem_id, reason_code, replayable, created_at)
       VALUES ($1,$2,$3,'WORKITEM_CHECKOUT_CONFLICT',true,$4::timestamptz)`,
      [DLQ_A, TENANT_A, WORKITEM_A, isoMinutesFromNow(-20)],
    );
  });

  await withTenantTx(pool, TENANT_B, async (client) => {
    await client.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, created_at)
       VALUES ($1,$2,$3,'running',$1,$4::timestamptz)`,
      [RUN_B, TENANT_B, SVER_B, isoMinutesFromNow(-10)],
    );
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const app = buildServer({
    pool,
    auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
    rbac: new RoleMatrixRbacMiddleware(),
    idempotency: new PgControlPlaneIdempotencyStore(pool),
    enqueuer: { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} } as RunEnqueuer,
    signedCommandRegistry,
  });
  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
    } finally {
      setup.release();
    }
    await seedAlerts(pool);
    await app.ready();

    const viewer = await mint(["viewer"]);
    const noRole = await mint([]);
    const viewerB = await mint(["viewer"], TENANT_B, "viewer-b");

    const all = await app.inject({ method: "GET", url: "/v1/ops-alerts?limit=20", headers: { authorization: `Bearer ${viewer}` } });
    check("viewer list ops alerts -> 200", all.statusCode === 200, all.body);
    const allBody = all.json() as { items: Array<{ alert_id: string; severity: string; source: string; route: string | null }>; next_cursor: string | null };
    const alertById = new Map(allBody.items.map((item) => [item.alert_id, item]));
    check("all five alert sources are present", ["run_sla", "human_task_sla", "trigger_fire", "failure_spike", "dlq"].every((source) => allBody.items.some((item) => item.source === source)), all.body);
    check("critical alerts sort first", allBody.items[0]?.severity === "critical", all.body);
    check("route hints are console hash routes", allBody.items.some((item) => typeof item.route === "string" && item.route.startsWith("#")), all.body);
    check("run SLA route deep-links to run trace subject", alertById.get(`run_sla:${RUN_A}`)?.route === `#runTrace?run=${RUN_A}`, all.body);
    check("human task SLA route deep-links to task subject", alertById.get(`human_task_sla:${HT_CRITICAL}`)?.route === `#humanTasks?ht=${HT_CRITICAL}`, all.body);
    check("trigger fire route deep-links to trigger subject", alertById.get(`trigger_fire:${FIRE_A}`)?.route === `#automationOps?trigger=${TRIGGER_A}`, all.body);

    const humanOnly = await app.inject({ method: "GET", url: "/v1/ops-alerts?source=human_task_sla&severity=warning", headers: { authorization: `Bearer ${viewer}` } });
    const humanBody = humanOnly.json() as { items: Array<{ source: string; severity: string; alert_id: string; route: string | null }> };
    check("source/severity filter -> 200", humanOnly.statusCode === 200, humanOnly.body);
    check("human warning filter returns only matching alerts", humanBody.items.length === 1 && humanBody.items[0].alert_id === `human_task_sla:${HT_WARNING}`, humanOnly.body);
    check("human warning route targets matching task", humanBody.items[0]?.route === `#humanTasks?ht=${HT_WARNING}`, humanOnly.body);

    const spikeOnly = await app.inject({ method: "GET", url: "/v1/ops-alerts?source=failure_spike&severity=warning", headers: { authorization: `Bearer ${viewer}` } });
    const spikeBody = spikeOnly.json() as { items: Array<{ source: string; severity: string; alert_id: string; subject_type: string; subject_id: string | null; route: string | null }> };
    check("failure spike filter -> 200", spikeOnly.statusCode === 200, spikeOnly.body);
    check("failure spike warning returns aggregate run alert", spikeBody.items.length === 1 && spikeBody.items[0]?.alert_id === "failure_spike:15m" && spikeBody.items[0]?.subject_type === "run" && spikeBody.items[0]?.subject_id === null, spikeOnly.body);
    check("failure spike route opens failed run trace", spikeBody.items[0]?.route === "#runTrace?status=failed_system", spikeOnly.body);

    const runSlaFirst = await app.inject({ method: "GET", url: "/v1/ops-alerts?source=run_sla&limit=2", headers: { authorization: `Bearer ${viewer}` } });
    const runSlaFirstBody = runSlaFirst.json() as { items: Array<{ alert_id: string }>; next_cursor: string | null };
    check("run SLA limited page keeps v1 cursor closed", runSlaFirst.statusCode === 200 && runSlaFirstBody.items.length === 2 && runSlaFirstBody.next_cursor === null, runSlaFirst.body);

    const invalidCursor = await app.inject({ method: "GET", url: "/v1/ops-alerts?cursor=not-a-cursor", headers: { authorization: `Bearer ${viewer}` } });
    check("cursor query remains unsupported -> 422", invalidCursor.statusCode === 422 && invalidCursor.json().code === "IR_SCHEMA_INVALID" && invalidCursor.json().details?.reason === "ops_alert_cursor_not_supported", invalidCursor.body);

    const invalid = await app.inject({ method: "GET", url: "/v1/ops-alerts?source=email", headers: { authorization: `Bearer ${viewer}` } });
    check("invalid source -> 422", invalid.statusCode === 422 && invalid.json().code === "IR_SCHEMA_INVALID", invalid.body);

    const tenantB = await app.inject({ method: "GET", url: "/v1/ops-alerts", headers: { authorization: `Bearer ${viewerB}` } });
    check("tenant B sees no tenant A alerts", tenantB.statusCode === 200 && tenantB.json().items.length === 0, tenantB.body);

    const denied = await app.inject({ method: "GET", url: "/v1/ops-alerts", headers: { authorization: `Bearer ${noRole}` } });
    check("no-role ops alert read denied -> 403", denied.statusCode === 403 && denied.json().code === "AUTHZ_FORBIDDEN", denied.body);
  } finally {
    await app.close();
    await pool.end();
  }
  if (failures > 0) {
    console.error(`FAIL: ${failures} ops alert API check(s) failed`);
    process.exit(1);
  }
  console.log("PASS: ops alert API integration green");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
