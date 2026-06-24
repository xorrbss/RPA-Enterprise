/**
 * Integration test for /v1/run-triggers.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-run-triggers.int.ts
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
const SCHEMA = "rpa_run_triggers_int";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const SCENARIO_A = "41000000-0000-4000-8000-0000000000a1";
const SVER_A = "41000000-0000-4000-8000-0000000000a2";
const SCENARIO_B = "41000000-0000-4000-8000-0000000000b1";
const SVER_B = "41000000-0000-4000-8000-0000000000b2";
const TRIGGER_A = "42000000-0000-4000-8000-0000000000a1";
const TRIGGER_B = "42000000-0000-4000-8000-0000000000b1";
const FIRE_NEW = "43000000-0000-4000-8000-0000000000a1";
const FIRE_OLD = "43000000-0000-4000-8000-0000000000a2";
const RUN_A = "44000000-0000-4000-8000-0000000000a1";
const CORR_NEW = "45000000-0000-4000-8000-0000000000a1";
const CORR_OLD = "45000000-0000-4000-8000-0000000000a2";

const SECRET = new TextEncoder().encode("run-triggers-int-secret-do-not-use-in-prod-0123456789");
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

function mint(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m").sign(SECRET);
}

type Pool = ReturnType<typeof createPool>;

async function seedScenario(pool: Pool, tenant: string, scenario: string, sver: string): Promise<void> {
  await withTenantTx(pool, tenant, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'trigger-int')`, [scenario, tenant]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'draft',$4::jsonb)`,
      [
        sver,
        tenant,
        scenario,
        JSON.stringify({
          nodes: [],
          target: {
            site_profile_id: "00000000-0000-4000-8000-0000000000f1",
            browser_identity_id: "00000000-0000-4000-8000-0000000000f2",
            network_policy_id: "00000000-0000-4000-8000-0000000000f3",
          },
        }),
      ],
    );
  });
}

async function seedTriggerAndFires(pool: Pool): Promise<void> {
  await withTenantTx(pool, TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO run_triggers
         (id, tenant_id, scenario_version_id, status, cron_expression, timezone, params,
          catchup_policy, max_concurrent_runs, next_fire_at, created_by, created_at, updated_at)
       VALUES
         ($1,$2,$3,'enabled','0 9 * * *','Asia/Seoul',$4::jsonb,
          'skip_missed',1,'2026-06-24T00:00:00Z','seed-op',
          '2026-06-23T10:00:00Z','2026-06-23T10:00:00Z')`,
      [TRIGGER_A, TENANT_A, SVER_A, JSON.stringify({ source: "seed" })],
    );
    await c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, as_of)
       VALUES ($1,$2,$3,'queued',$4,1,'2026-06-23T00:00:00Z')`,
      [RUN_A, TENANT_A, SVER_A, CORR_NEW],
    );
    await c.query(
      `INSERT INTO run_trigger_fires
         (id, tenant_id, trigger_id, fire_key, status, scheduled_for, run_id, failure_reason, correlation_id, created_at)
       VALUES
         ($1,$2,$3,'2026-06-23T09:00:00Z','queued','2026-06-23T09:00:00Z',$4,NULL,$5,'2026-06-23T09:00:01Z'),
         ($6,$2,$3,'2026-06-22T09:00:00Z','failed','2026-06-22T09:00:00Z',NULL,$7::jsonb,$8,'2026-06-22T09:00:01Z')`,
      [
        FIRE_NEW,
        TENANT_A,
        TRIGGER_A,
        RUN_A,
        CORR_NEW,
        FIRE_OLD,
        JSON.stringify({ code: "SCHEDULER_ERROR" }),
        CORR_OLD,
      ],
    );
  });
  await withTenantTx(pool, TENANT_B, (c) =>
    c.query(
      `INSERT INTO run_triggers
         (id, tenant_id, scenario_version_id, status, cron_expression, timezone, params, created_by)
       VALUES ($1,$2,$3,'enabled','0 8 * * *','Asia/Seoul','{}'::jsonb,'seed-op-b')`,
      [TRIGGER_B, TENANT_B, SVER_B],
    ),
  );
}

async function triggerCount(pool: Pool, tenant: string, scenarioVersionId: string): Promise<number> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM run_triggers WHERE scenario_version_id=$1::uuid`,
      [scenarioVersionId],
    );
    return r.rows[0]?.n ?? 0;
  });
}

async function idempotencyCount(pool: Pool, tenant: string, endpoint: string, key: string): Promise<number> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM control_plane_idempotency_keys
        WHERE endpoint=$1 AND idempotency_key=$2`,
      [endpoint, key],
    );
    return r.rows[0]?.n ?? 0;
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
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
    console.log("migrations applied (concurrency -> core)");

    await seedScenario(pool, TENANT_A, SCENARIO_A, SVER_A);
    await seedScenario(pool, TENANT_B, SCENARIO_B, SVER_B);
    await seedTriggerAndFires(pool);
    console.log("seeded run triggers across tenants");

    const noopEnqueuer: RunEnqueuer = {
      async enqueueRunClaim() {},
      async enqueueRunAbort() {},
      async enqueueSinkDeliver() {},
    };
    const app = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer: noopEnqueuer,
      signedCommandRegistry,
    });
    await app.ready();
    try {
      const operator = await mint({ sub: "operator-a", tenant_id: TENANT_A, roles: ["operator"] });
      const viewer = await mint({ sub: "viewer-a", tenant_id: TENANT_A, roles: ["viewer"] });
      const operatorB = await mint({ sub: "operator-b", tenant_id: TENANT_B, roles: ["operator"] });

      const createTrigger = (token: string, key?: string, payload?: unknown) =>
        app.inject({
          method: "POST",
          url: "/v1/run-triggers",
          headers: { authorization: `Bearer ${token}`, ...(key !== undefined ? { "idempotency-key": key } : {}) },
          payload: payload as object | undefined,
        });
      const command = (method: "POST" | "PATCH", url: string, token: string, key: string, payload?: unknown) =>
        app.inject({
          method,
          url,
          headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
          payload: payload as object | undefined,
        });

      const listed = await app.inject({
        method: "GET",
        url: `/v1/run-triggers?status=enabled&scenario_version_id=${SVER_A}&limit=1`,
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("viewer list enabled triggers -> 200", listed.statusCode === 200, listed.body);
      check("list includes seeded trigger", listed.json().items?.[0]?.trigger_id === TRIGGER_A, listed.body);

      const created = await createTrigger(operator, "trigger-create-1", {
        scenario_version_id: SVER_A,
        cron_expression: "30 8 * * 1",
        timezone: "Asia/Seoul",
        params: { report: "weekly" },
      });
      check("operator create trigger -> 201", created.statusCode === 201, created.body);
      const createdBody = created.json();
      const createdId = String(createdBody.trigger_id);
      check("created trigger defaults enabled/skip_missed/max_concurrent=1", createdBody.status === "enabled" && createdBody.catchup_policy === "skip_missed" && createdBody.max_concurrent_runs === 1, created.body);
      check("created trigger calculates default next_fire_at", typeof createdBody.next_fire_at === "string" && createdBody.next_fire_at.length > 0, created.body);
      check("created trigger records principal", createdBody.created_by === "operator-a", created.body);
      check("created trigger stores params", createdBody.params?.report === "weekly", created.body);

      const replay = await createTrigger(operator, "trigger-create-1", {
        scenario_version_id: SVER_A,
        cron_expression: "30 8 * * 1",
        timezone: "Asia/Seoul",
        params: { report: "weekly" },
      });
      check("create replay returns same trigger", replay.statusCode === 201 && replay.json().trigger_id === createdId, replay.body);
      check("create replay does not duplicate rows", (await triggerCount(pool, TENANT_A, SVER_A)) === 2);

      const noKey = await createTrigger(operator, undefined, {
        scenario_version_id: SVER_A,
        cron_expression: "0 9 * * *",
        timezone: "Asia/Seoul",
      });
      check("missing Idempotency-Key -> 422", noKey.statusCode === 422 && noKey.json().code === "IR_SCHEMA_INVALID", noKey.body);

      const invalidCron = await createTrigger(operator, "trigger-create-invalid-cron", {
        scenario_version_id: SVER_A,
        cron_expression: "0 9 1 * 1",
        timezone: "Asia/Seoul",
      });
      check("ambiguous cron day fields -> 422", invalidCron.statusCode === 422 && invalidCron.json().details?.reason === "invalid_cron_expression", invalidCron.body);

      const impossibleCron = await createTrigger(operator, "trigger-create-impossible-cron", {
        scenario_version_id: SVER_A,
        cron_expression: "0 0 30 2 *",
        timezone: "Asia/Seoul",
      });
      check(
        "impossible cron date -> 422",
        impossibleCron.statusCode === 422 &&
          impossibleCron.json().details?.reason === "invalid_cron_expression" &&
          impossibleCron.json().details?.detail === "impossible_day_of_month",
        impossibleCron.body,
      );

      const nullNextFire = await createTrigger(operator, "trigger-create-null-next-fire", {
        scenario_version_id: SVER_A,
        cron_expression: "0 9 * * *",
        timezone: "Asia/Seoul",
        next_fire_at: null,
      });
      check(
        "enabled cron trigger rejects null next_fire_at -> 422",
        nullNextFire.statusCode === 422 && nullNextFire.json().details?.reason === "cron_trigger_requires_next_fire_at",
        nullNextFire.body,
      );

      const cronWithWebhookSecret = await createTrigger(operator, "trigger-create-cron-secret", {
        scenario_version_id: SVER_A,
        cron_expression: "0 9 * * *",
        timezone: "Asia/Seoul",
        webhook_secret_ref: "secret://webhook/cron-must-not-store",
      });
      check(
        "cron trigger forbids webhook_secret_ref -> 422",
        cronWithWebhookSecret.statusCode === 422 &&
          cronWithWebhookSecret.json().details?.reason === "cron_trigger_forbids_webhook_secret_ref",
        cronWithWebhookSecret.body,
      );
      check(
        "cron webhook_secret_ref rejection did not reserve idempotency",
        (await idempotencyCount(pool, TENANT_A, "createRunTrigger", "trigger-create-cron-secret")) === 0,
      );

      const fileArrivalTrigger = await createTrigger(operator, "trigger-create-file-arrival", {
        trigger_type: "file_arrival",
        scenario_version_id: SVER_A,
        cron_expression: "0 9 * * *",
        timezone: "Asia/Seoul",
      });
      check("file-arrival trigger type rejected -> 422", fileArrivalTrigger.statusCode === 422 && fileArrivalTrigger.json().details?.reason === "invalid_trigger_type", fileArrivalTrigger.body);
      check("file-arrival trigger rejection did not reserve idempotency", (await idempotencyCount(pool, TENANT_A, "createRunTrigger", "trigger-create-file-arrival")) === 0);

      const queueTrigger = await createTrigger(operator, "trigger-create-queue", {
        trigger_type: "queue",
        scenario_version_id: SVER_A,
        cron_expression: "0 9 * * *",
        timezone: "Asia/Seoul",
      });
      check("queue trigger type rejected -> 422", queueTrigger.statusCode === 422 && queueTrigger.json().details?.reason === "invalid_trigger_type", queueTrigger.body);
      check("queue trigger rejection did not reserve idempotency", (await idempotencyCount(pool, TENANT_A, "createRunTrigger", "trigger-create-queue")) === 0);

      const viewerDenied = await createTrigger(viewer, "viewer-create-denied", {
        scenario_version_id: SVER_A,
        cron_expression: "0 9 * * *",
        timezone: "Asia/Seoul",
      });
      check("viewer create denied -> 403", viewerDenied.statusCode === 403 && viewerDenied.json().code === "AUTHZ_FORBIDDEN", viewerDenied.body);
      check("viewer denied request did not reserve idempotency", (await idempotencyCount(pool, TENANT_A, "createRunTrigger", "viewer-create-denied")) === 0);

      const getCreated = await app.inject({
        method: "GET",
        url: `/v1/run-triggers/${createdId}`,
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("viewer get created trigger -> 200", getCreated.statusCode === 200 && getCreated.json().trigger_id === createdId, getCreated.body);

      const updated = await command("PATCH", `/v1/run-triggers/${createdId}`, operator, "trigger-update-1", {
        cron_expression: "45 7 * * *",
        catchup_policy: "fire_once",
        max_concurrent_runs: 2,
        next_fire_at: "2026-06-24T22:45:00Z",
      });
      check("operator update trigger -> 200", updated.statusCode === 200, updated.body);
      check("update persists schedule fields", updated.json().cron_expression === "45 7 * * *" && updated.json().catchup_policy === "fire_once" && updated.json().max_concurrent_runs === 2 && updated.json().next_fire_at === "2026-06-24T22:45:00.000Z", updated.body);

      const nullNextFireUpdate = await command("PATCH", `/v1/run-triggers/${createdId}`, operator, "trigger-update-null-next-fire", {
        next_fire_at: null,
      });
      check(
        "enabled cron update rejects null next_fire_at -> 422",
        nullNextFireUpdate.statusCode === 422 && nullNextFireUpdate.json().details?.reason === "cron_trigger_requires_next_fire_at",
        nullNextFireUpdate.body,
      );

      const paused = await command("POST", `/v1/run-triggers/${createdId}/pause`, operator, "trigger-pause-1");
      check("operator pause trigger -> 200 paused", paused.statusCode === 200 && paused.json().status === "paused", paused.body);
      const pauseReplay = await command("POST", `/v1/run-triggers/${createdId}/pause`, operator, "trigger-pause-1");
      check("pause replay returns paused", pauseReplay.statusCode === 200 && pauseReplay.json().status === "paused", pauseReplay.body);
      const resumed = await command("POST", `/v1/run-triggers/${createdId}/resume`, operator, "trigger-resume-1");
      check("operator resume trigger -> 200 enabled", resumed.statusCode === 200 && resumed.json().status === "enabled", resumed.body);

      const viewerPause = await command("POST", `/v1/run-triggers/${createdId}/pause`, viewer, "viewer-pause-denied");
      check("viewer pause denied -> 403", viewerPause.statusCode === 403 && viewerPause.json().code === "AUTHZ_FORBIDDEN", viewerPause.body);

      const firesPage1 = await app.inject({
        method: "GET",
        url: `/v1/run-triggers/${TRIGGER_A}/fires?limit=1`,
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("viewer list fires -> 200", firesPage1.statusCode === 200, firesPage1.body);
      check("fires sorted by scheduled_for desc", firesPage1.json().items?.[0]?.fire_id === FIRE_NEW, firesPage1.body);
      check("fires page exposes cursor", typeof firesPage1.json().next_cursor === "string", firesPage1.body);
      const firesPage2 = await app.inject({
        method: "GET",
        url: `/v1/run-triggers/${TRIGGER_A}/fires?limit=1&cursor=${encodeURIComponent(String(firesPage1.json().next_cursor))}`,
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("fires cursor page returns older failed fire", firesPage2.statusCode === 200 && firesPage2.json().items?.[0]?.fire_id === FIRE_OLD && firesPage2.json().items?.[0]?.failure_reason?.code === "SCHEDULER_ERROR", firesPage2.body);

      const crossGet = await app.inject({
        method: "GET",
        url: `/v1/run-triggers/${TRIGGER_A}`,
        headers: { authorization: `Bearer ${operatorB}` },
      });
      check("cross-tenant trigger get -> 404", crossGet.statusCode === 404 && crossGet.json().code === "RESOURCE_NOT_FOUND", crossGet.body);
      const crossFires = await app.inject({
        method: "GET",
        url: `/v1/run-triggers/${TRIGGER_A}/fires`,
        headers: { authorization: `Bearer ${operatorB}` },
      });
      check("cross-tenant fires -> 404", crossFires.statusCode === 404 && crossFires.json().code === "RESOURCE_NOT_FOUND", crossFires.body);
      const listB = await app.inject({
        method: "GET",
        url: "/v1/run-triggers",
        headers: { authorization: `Bearer ${operatorB}` },
      });
      check("tenant B list only sees own trigger", listB.statusCode === 200 && listB.json().items?.length === 1 && listB.json().items?.[0]?.trigger_id === TRIGGER_B, listB.body);
    } finally {
      await app.close();
    }
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: run trigger API integration green");
}

main().catch((err) => {
  console.error("FAIL: api-run-triggers integration threw:", err);
  process.exit(1);
});
