/**
 * Integration test for signed webhook run triggers.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-webhook-triggers.int.ts
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueueInput, RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import { webhookSigningPayload } from "../src/api/webhook-trigger-auth";
import { createPool, withTenantTx } from "../src/db/pool";
import type { PlainSecret, SecretRef, SecretStore } from "../../ts/core-types";
import type { SecretStoreBoundary, SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_webhook_triggers_int";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const SCENARIO_A = "61000000-0000-4000-8000-0000000000a1";
const SVER_A = "61000000-0000-4000-8000-0000000000a2";
const SCENARIO_B = "61000000-0000-4000-8000-0000000000b1";
const SVER_B = "61000000-0000-4000-8000-0000000000b2";
const WEBHOOK_SECRET_REF = "secret://tenant-a/run-trigger/webhook" as SecretRef;
const WEBHOOK_SECRET = "signed-webhook-trigger-secret" as PlainSecret;
const JWT_SECRET = new TextEncoder().encode("webhook-triggers-int-secret-do-not-use-in-prod-0123456789");

const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return { kind: "available", snapshot: { sourceRef: "secret://staging/registry" as SecretRef, commands: [] } };
  },
};

const webhookSecretStore: SecretStore = {
  async resolve(ref) {
    if (ref !== WEBHOOK_SECRET_REF) throw new Error(`unexpected secret ref: ${ref}`);
    return WEBHOOK_SECRET;
  },
};

const webhookBoundaryCalls: Array<{ ref: string; purpose: string; identity: unknown; tenantId: string }> = [];
let failWebhookBoundary = false;
const webhookSecretBoundary: SecretStoreBoundary = {
  store: webhookSecretStore,
  async authorize(request) {
    return { kind: "allow", ref: request.ref };
  },
  async resolveAuthorized(request) {
    webhookBoundaryCalls.push({
      ref: String(request.ref),
      purpose: request.purpose,
      identity: request.principal.claims.runtime_identity,
      tenantId: request.principal.tenantId,
    });
    if (failWebhookBoundary) throw new Error("security audit unavailable");
    return webhookSecretStore.resolve(request.ref);
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
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m").sign(JWT_SECRET);
}

type Pool = ReturnType<typeof createPool>;

async function seedScenario(pool: Pool, tenant: string, scenario: string, sver: string): Promise<void> {
  await withTenantTx(pool, tenant, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'webhook-trigger-int')`, [scenario, tenant]);
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

async function fireCount(pool: Pool, tenant: string, triggerId: string, fireKey: string): Promise<number> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM run_trigger_fires
        WHERE trigger_id=$1::uuid
          AND fire_key=$2`,
      [triggerId, fireKey],
    );
    return r.rows[0]?.n ?? 0;
  });
}

async function runParams(pool: Pool, tenant: string, runId: string): Promise<Record<string, unknown> | null> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ params: Record<string, unknown> }>(
      `SELECT params
         FROM runs
        WHERE id=$1::uuid`,
      [runId],
    );
    return r.rows[0]?.params ?? null;
  });
}

function signedHeaders(eventId: string, payload: Record<string, unknown>, timestamp = String(Math.floor(Date.now() / 1000))): Record<string, string> {
  const signature = createHmac("sha256", WEBHOOK_SECRET)
    .update(webhookSigningPayload(timestamp, eventId, payload))
    .digest("hex");
  return {
    "x-rpa-webhook-event-id": eventId,
    "x-rpa-webhook-timestamp": timestamp,
    "x-rpa-webhook-signature": `sha256=${signature}`,
  };
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
    console.log("seeded scenarios");

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
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(JWT_SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer,
      signedCommandRegistry,
      webhookSecretBoundary,
    });
    await app.ready();
    try {
      const operator = await mint({ sub: "operator-a", tenant_id: TENANT_A, roles: ["operator"] });
      const viewer = await mint({ sub: "viewer-a", tenant_id: TENANT_A, roles: ["viewer"] });

      const created = await app.inject({
        method: "POST",
        url: "/v1/run-triggers",
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "webhook-trigger-create" },
        payload: {
          trigger_type: "webhook",
          scenario_version_id: SVER_A,
          webhook_secret_ref: WEBHOOK_SECRET_REF,
          params: { source: "crm" },
          max_concurrent_runs: 1,
        },
      });
      check("operator creates webhook trigger -> 201", created.statusCode === 201, created.body);
      const triggerId = String(created.json().trigger_id);
      check("webhook trigger has no cron schedule", created.json().trigger_type === "webhook" && created.json().cron_expression === null && created.json().next_fire_at === null, created.body);
      check("operator response keeps webhook SecretRef editable", created.json().webhook_secret_ref === WEBHOOK_SECRET_REF && created.json().webhook_secret_configured === true, created.body);

      const viewerGet = await app.inject({
        method: "GET",
        url: `/v1/run-triggers/${triggerId}`,
        headers: { authorization: `Bearer ${viewer}` },
      });
      check(
        "viewer sees webhook secret configured without raw ref",
        viewerGet.statusCode === 200 &&
          viewerGet.json().webhook_secret_ref === null &&
          viewerGet.json().webhook_secret_configured === true,
        viewerGet.body,
      );

      const invalidCreate = await app.inject({
        method: "POST",
        url: "/v1/run-triggers",
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "webhook-trigger-invalid" },
        payload: {
          trigger_type: "webhook",
          scenario_version_id: SVER_A,
          webhook_secret_ref: WEBHOOK_SECRET_REF,
          cron_expression: "0 9 * * *",
        },
      });
      check("webhook trigger rejects cron fields -> 422", invalidCreate.statusCode === 422 && invalidCreate.json().details?.reason === "webhook_trigger_forbids_cron_fields", invalidCreate.body);

      const payload = { action: "created", record_id: "case-1" };
      failWebhookBoundary = true;
      const auditFail = await app.inject({
        method: "POST",
        url: `/v1/webhooks/run-triggers/${TENANT_A}/${triggerId}`,
        headers: signedHeaders("evt-audit-fail", payload),
        payload,
      });
      failWebhookBoundary = false;
      check("webhook secret audit boundary failure is fail-closed -> 500", auditFail.statusCode === 500, auditFail.body);
      check("audit boundary failure creates no fire ledger", (await fireCount(pool, TENANT_A, triggerId, "webhook:evt-audit-fail")) === 0);

      const accepted = await app.inject({
        method: "POST",
        url: `/v1/webhooks/run-triggers/${TENANT_A}/${triggerId}`,
        headers: signedHeaders("evt-1", payload),
        payload,
      });
      check("signed webhook queues run without JWT -> 202", accepted.statusCode === 202 && accepted.json().status === "queued", accepted.body);
      check(
        "webhook secret resolved through audited boundary",
        webhookBoundaryCalls.some((call) => call.ref === WEBHOOK_SECRET_REF && call.purpose === "connector" && call.identity === "api" && call.tenantId === TENANT_A),
        JSON.stringify(webhookBoundaryCalls),
      );
      check("webhook response includes run id", typeof accepted.json().run_id === "string", accepted.body);
      check("run_claim enqueued once", enqueued.length === 1 && enqueued[0]?.runId === accepted.json().run_id, JSON.stringify(enqueued));
      const params = await runParams(pool, TENANT_A, accepted.json().run_id);
      check("run params include trigger params and webhook payload", params?.source === "crm" && (params?.webhook as Record<string, unknown> | undefined)?.event_id === "evt-1", JSON.stringify(params));

      const replay = await app.inject({
        method: "POST",
        url: `/v1/webhooks/run-triggers/${TENANT_A}/${triggerId}`,
        headers: signedHeaders("evt-1", payload),
        payload,
      });
      check("same event id replays existing fire", replay.statusCode === 202 && replay.json().duplicate === true && replay.json().run_id === accepted.json().run_id, replay.body);
      check("replay does not enqueue another run", enqueued.length === 1, JSON.stringify(enqueued));

      const badPayload = { action: "created", record_id: "case-bad" };
      const badSignature = await app.inject({
        method: "POST",
        url: `/v1/webhooks/run-triggers/${TENANT_A}/${triggerId}`,
        headers: { ...signedHeaders("evt-bad", badPayload), "x-rpa-webhook-signature": "sha256=0000000000000000000000000000000000000000000000000000000000000000" },
        payload: badPayload,
      });
      check("bad webhook signature -> 401", badSignature.statusCode === 401 && badSignature.json().code === "UNAUTHENTICATED", badSignature.body);
      check("bad signature creates no fire ledger", (await fireCount(pool, TENANT_A, triggerId, "webhook:evt-bad")) === 0);

      const concurrentPayload = { action: "created", record_id: "case-2" };
      const concurrent = await app.inject({
        method: "POST",
        url: `/v1/webhooks/run-triggers/${TENANT_A}/${triggerId}`,
        headers: signedHeaders("evt-2", concurrentPayload),
        payload: concurrentPayload,
      });
      check("max concurrency skips second active webhook fire", concurrent.statusCode === 202 && concurrent.json().status === "skipped" && concurrent.json().failure_reason?.code === "MAX_CONCURRENCY_REACHED", concurrent.body);
      check("skipped fire does not enqueue run", enqueued.length === 1, JSON.stringify(enqueued));

      const paused = await app.inject({
        method: "POST",
        url: `/v1/run-triggers/${triggerId}/pause`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": "pause-webhook-trigger" },
      });
      check("operator pauses webhook trigger -> 200", paused.statusCode === 200 && paused.json().status === "paused", paused.body);
      const pausedPayload = { action: "created", record_id: "case-paused" };
      const boundaryCallsBeforePausedFire = webhookBoundaryCalls.length;
      const pausedFire = await app.inject({
        method: "POST",
        url: `/v1/webhooks/run-triggers/${TENANT_A}/${triggerId}`,
        headers: signedHeaders("evt-paused", pausedPayload),
        payload: pausedPayload,
      });
      check("paused webhook trigger rejects signed fire -> 422", pausedFire.statusCode === 422 && pausedFire.json().details?.reason === "webhook_trigger_not_enabled", pausedFire.body);
      check("paused webhook trigger does not resolve webhook secret", webhookBoundaryCalls.length === boundaryCallsBeforePausedFire, JSON.stringify(webhookBoundaryCalls));

      const crossTenant = await app.inject({
        method: "POST",
        url: `/v1/webhooks/run-triggers/${TENANT_B}/${triggerId}`,
        headers: signedHeaders("evt-cross", { record_id: "case-cross" }),
        payload: { record_id: "case-cross" },
      });
      check("cross-tenant webhook path hides trigger -> 404", crossTenant.statusCode === 404 && crossTenant.json().code === "RESOURCE_NOT_FOUND", crossTenant.body);

      const stalePayload = { action: "created", record_id: "case-stale" };
      const stale = await app.inject({
        method: "POST",
        url: `/v1/webhooks/run-triggers/${TENANT_A}/${triggerId}`,
        headers: signedHeaders("evt-stale", stalePayload, "1000000000"),
        payload: stalePayload,
      });
      check("stale webhook timestamp -> 401", stale.statusCode === 401 && stale.json().code === "UNAUTHENTICATED", stale.body);
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
  console.log("\nPASS: webhook trigger API integration green");
}

main().catch((err) => {
  console.error("FAIL: api-webhook-triggers integration threw:", err);
  process.exit(1);
});
