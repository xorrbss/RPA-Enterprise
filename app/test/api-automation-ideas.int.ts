/**
 * Integration test for /v1/automation-ideas and ROI estimates.
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-automation-ideas.int.ts
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
const SCHEMA = "rpa_automation_ideas_int";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const SCENARIO_A = "51000000-0000-4000-8000-0000000000a1";
const SVER_A = "51000000-0000-4000-8000-0000000000a2";
const SCENARIO_B = "51000000-0000-4000-8000-0000000000b1";
const SVER_B = "51000000-0000-4000-8000-0000000000b2";
const TRIGGER_A = "52000000-0000-4000-8000-0000000000a1";
const TRIGGER_B = "52000000-0000-4000-8000-0000000000b1";

const SECRET = new TextEncoder().encode("automation-ideas-int-secret-do-not-use-in-prod-0123456789");
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

async function seedScenarioAndTrigger(
  pool: Pool,
  tenant: string,
  scenarioId: string,
  scenarioVersionId: string,
  triggerId: string,
): Promise<void> {
  await withTenantTx(pool, tenant, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'coe-int')`, [scenarioId, tenant]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'draft',$4::jsonb)`,
      [
        scenarioVersionId,
        tenant,
        scenarioId,
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
    await c.query(
      `INSERT INTO run_triggers
         (id, tenant_id, scenario_version_id, status, cron_expression, timezone, params, created_by)
       VALUES ($1,$2,$3,'enabled','0 9 * * 1-5','Asia/Seoul','{}'::jsonb,'seed-op')`,
      [triggerId, tenant, scenarioVersionId],
    );
  });
}

async function ideaCount(pool: Pool, tenant: string): Promise<number> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM automation_ideas`);
    return r.rows[0]?.n ?? 0;
  });
}

async function roiCount(pool: Pool, tenant: string): Promise<number> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM roi_estimates`);
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

    await seedScenarioAndTrigger(pool, TENANT_A, SCENARIO_A, SVER_A, TRIGGER_A);
    await seedScenarioAndTrigger(pool, TENANT_B, SCENARIO_B, SVER_B, TRIGGER_B);
    console.log("seeded scenarios and run triggers across tenants");

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
      const approver = await mint({ sub: "approver-a", tenant_id: TENANT_A, roles: ["approver"] });
      const operatorB = await mint({ sub: "operator-b", tenant_id: TENANT_B, roles: ["operator"] });

      const createIdea = (token: string, key?: string, payload?: unknown) =>
        app.inject({
          method: "POST",
          url: "/v1/automation-ideas",
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

      const created = await createIdea(operator, "idea-create-1", {
        title: "Vendor portal payment check",
        description: "Check browser portal payment status and route exceptions to finance ops.",
        business_owner: "finance-ops",
        department: "Finance",
        priority: "high",
        score: 82,
      });
      check("operator create idea -> 201", created.statusCode === 201, created.body);
      const createdBody = created.json();
      const ideaId = String(createdBody.idea_id);
      check("idea defaults intake/manual and records owner", createdBody.stage === "intake" && createdBody.source === "manual" && createdBody.created_by === "operator-a", created.body);
      check("idea score/priority round-trip", createdBody.score === 82 && createdBody.priority === "high", created.body);

      const replay = await createIdea(operator, "idea-create-1", {
        title: "Vendor portal payment check",
        description: "Check browser portal payment status and route exceptions to finance ops.",
        business_owner: "finance-ops",
        department: "Finance",
        priority: "high",
        score: 82,
      });
      check("create replay returns same idea", replay.statusCode === 201 && replay.json().idea_id === ideaId, replay.body);
      check("create replay does not duplicate rows", (await ideaCount(pool, TENANT_A)) === 1);

      const noKey = await createIdea(operator, undefined, {
        title: "No key",
        description: "Missing idempotency key",
        business_owner: "finance-ops",
        department: "Finance",
      });
      check("missing Idempotency-Key -> 422", noKey.statusCode === 422 && noKey.json().code === "IR_SCHEMA_INVALID", noKey.body);

      const viewerDenied = await createIdea(viewer, "viewer-idea-denied", {
        title: "Viewer denied",
        description: "Viewer must not create ideas",
        business_owner: "finance-ops",
        department: "Finance",
      });
      check("viewer create denied -> 403", viewerDenied.statusCode === 403 && viewerDenied.json().code === "AUTHZ_FORBIDDEN", viewerDenied.body);
      check("viewer denied request did not reserve idempotency", (await idempotencyCount(pool, TENANT_A, "createAutomationIdea", "viewer-idea-denied")) === 0);

      const listed = await app.inject({
        method: "GET",
        url: "/v1/automation-ideas?stage=intake&owner=finance-ops&department=Finance&limit=5",
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("viewer list ideas -> 200", listed.statusCode === 200, listed.body);
      check("list returns tenant A idea only", listed.json().items?.length === 1 && listed.json().items[0].idea_id === ideaId, listed.body);

      const tenantBGet = await app.inject({
        method: "GET",
        url: `/v1/automation-ideas/${ideaId}`,
        headers: { authorization: `Bearer ${operatorB}` },
      });
      check("tenant B cannot read tenant A idea -> 404", tenantBGet.statusCode === 404 && tenantBGet.json().code === "RESOURCE_NOT_FOUND", tenantBGet.body);

      const updated = await command("PATCH", `/v1/automation-ideas/${ideaId}`, operator, "idea-update-1", {
        priority: "critical",
        score: 91,
        scenario_id: SCENARIO_A,
        run_trigger_id: TRIGGER_A,
      });
      check("operator update idea links scenario/trigger -> 200", updated.statusCode === 200, updated.body);
      const updatedBody = updated.json();
      check("updated idea link fields round-trip", updatedBody.scenario_id === SCENARIO_A && updatedBody.run_trigger_id === TRIGGER_A && updatedBody.score === 91, updated.body);

      const badLink = await command("PATCH", `/v1/automation-ideas/${ideaId}`, operator, "idea-update-bad-link", {
        run_trigger_id: TRIGGER_B,
      });
      check("cross-tenant run trigger link rejected -> 404", badLink.statusCode === 404 && badLink.json().code === "RESOURCE_NOT_FOUND", badLink.body);

      const transitioned = await command("POST", `/v1/automation-ideas/${ideaId}/transition`, operator, "idea-transition-1", {
        stage: "assess",
      });
      check("transition intake -> assess -> 200", transitioned.statusCode === 200 && transitioned.json().stage === "assess", transitioned.body);

      const operatorApproveDenied = await command("POST", `/v1/automation-ideas/${ideaId}/transition`, operator, "idea-transition-approve-denied", {
        stage: "approved",
      });
      check("operator approve transition denied -> 403", operatorApproveDenied.statusCode === 403 && operatorApproveDenied.json().code === "AUTHZ_FORBIDDEN", operatorApproveDenied.body);
      check("operator denied approve does not reserve idempotency", (await idempotencyCount(pool, TENANT_A, "transitionAutomationIdea", "idea-transition-approve-denied")) === 0);

      const illegalTransition = await command("POST", `/v1/automation-ideas/${ideaId}/transition`, operator, "idea-transition-bad", {
        stage: "operate",
      });
      check("illegal transition assess -> operate -> 422", illegalTransition.statusCode === 422 && illegalTransition.json().code === "IR_SCHEMA_INVALID", illegalTransition.body);

      const approved = await command("POST", `/v1/automation-ideas/${ideaId}/transition`, approver, "idea-transition-approve-1", {
        stage: "approved",
      });
      check("approver transition assess -> approved -> 200", approved.statusCode === 200 && approved.json().stage === "approved", approved.body);

      const roi = await command("POST", `/v1/automation-ideas/${ideaId}/roi-estimate`, operator, "roi-upsert-1", {
        frequency_per_month: 120,
        minutes_per_case: 8,
        exception_rate: 0.1,
        hourly_cost: 40000,
        implementation_effort: 3200000,
        confidence: "medium",
      });
      check("operator upsert ROI -> 200", roi.statusCode === 200, roi.body);
      const roiBody = roi.json();
      check("ROI monthly hours/value/payback calculated", roiBody.monthly_hours_saved === 14.4 && roiBody.estimated_monthly_value === 576000 && Math.abs(roiBody.payback_months - 5.56) < 0.001, roi.body);

      const roiReplay = await command("POST", `/v1/automation-ideas/${ideaId}/roi-estimate`, operator, "roi-upsert-1", {
        frequency_per_month: 120,
        minutes_per_case: 8,
        exception_rate: 0.1,
        hourly_cost: 40000,
        implementation_effort: 3200000,
        confidence: "medium",
      });
      check("ROI replay returns same estimate", roiReplay.statusCode === 200 && roiReplay.json().roi_estimate_id === roiBody.roi_estimate_id, roiReplay.body);
      check("ROI replay does not duplicate rows", (await roiCount(pool, TENANT_A)) === 1);

      const roiOverflow = await command("POST", `/v1/automation-ideas/${ideaId}/roi-estimate`, operator, "roi-overflow-denied", {
        frequency_per_month: 1_000_000,
        minutes_per_case: 600_000,
        exception_rate: 0,
        hourly_cost: 1,
        implementation_effort: 1,
        confidence: "medium",
      });
      check(
        "ROI calculated overflow rejected before DB write -> 422",
        roiOverflow.statusCode === 422 &&
          roiOverflow.json().details?.reason === "roi_metric_out_of_range" &&
          roiOverflow.json().details?.metric === "monthly_hours_saved",
        roiOverflow.body,
      );
      check("ROI overflow did not reserve idempotency", (await idempotencyCount(pool, TENANT_A, "upsertRoiEstimate", "roi-overflow-denied")) === 0);

      const roiGet = await app.inject({
        method: "GET",
        url: `/v1/automation-ideas/${ideaId}/roi-estimate`,
        headers: { authorization: `Bearer ${viewer}` },
      });
      check("viewer get ROI -> 200", roiGet.statusCode === 200 && roiGet.json().automation_idea_id === ideaId, roiGet.body);

      const viewerRoiDenied = await command("POST", `/v1/automation-ideas/${ideaId}/roi-estimate`, viewer, "viewer-roi-denied", {
        frequency_per_month: 1,
        minutes_per_case: 1,
        exception_rate: 0,
        hourly_cost: 1,
        implementation_effort: 1,
      });
      check("viewer upsert ROI denied -> 403", viewerRoiDenied.statusCode === 403 && viewerRoiDenied.json().code === "AUTHZ_FORBIDDEN", viewerRoiDenied.body);
      check("viewer denied ROI request did not reserve idempotency", (await idempotencyCount(pool, TENANT_A, "upsertRoiEstimate", "viewer-roi-denied")) === 0);
    } finally {
      await app.close();
    }
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`api-automation-ideas.int: ${failures} failed`);
    process.exit(1);
  }
  console.log("api-automation-ideas.int: all checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
