/**
 * D3 통합 — PgActionPlanCache 를 실 PostgreSQL(action_plan_cache) 에 대해 검증.
 *
 * 실행(temp 게이트): `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app run test:int`
 * 검증(impl-bundle §D / db DDL):
 *  1) miss → undefined, put(active) → get 재생, ON CONFLICT 재put → success_count+1
 *  2) markSuspect: active→suspect(재생 차단)→stale, 미존재 family 는 suspect 1회 기록
 *  3) tenant 스코프: 다른 tenant 로 get → undefined(RLS/WHERE tenant_id)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createPool, withTenantTx } from "../src/db/pool";
import { PgActionPlanCache } from "../src/executor/pg-action-plan-cache";
import type { ActionPlan, ActionPlanCacheKey } from "../src/executor/action-plan-cache";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_runtime_int";
const TENANT = "00000000-0000-0000-0000-0000000000b1";
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000b2";
const SCENARIO = "10000000-0000-0000-0000-0000000000c3";
const SCENARIO_VERSION = "10000000-0000-0000-0000-0000000000c4";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const baseKey: ActionPlanCacheKey = {
  tenantId: TENANT,
  scenarioVersionId: SCENARIO_VERSION,
  stepId: "observe_reviews",
  urlPattern: "https://x/p/:id",
  domStructuralHash: "h1",
  model: "codex",
  promptTemplateVersion: "v1",
  browserIdentityVersion: 1,
};
const PLAN: ActionPlan = { operation: "click", selector: "#next" };

async function statusOf(pool: ReturnType<typeof createPool>, key: ActionPlanCacheKey): Promise<{ status?: string; success?: number }> {
  return withTenantTx(pool, key.tenantId, async (c) => {
    const r = await c.query<{ status: string; success_count: number }>(
      `SELECT status, success_count FROM action_plan_cache
        WHERE tenant_id=$1 AND scenario_version_id=$2 AND step_id=$3 AND url_pattern=$4
          AND dom_structural_hash=$5 AND model=$6 AND prompt_template_version=$7 AND browser_identity_version=$8`,
      [key.tenantId, key.scenarioVersionId, key.stepId, key.urlPattern, key.domStructuralHash, key.model, key.promptTemplateVersion, key.browserIdentityVersion],
    );
    return { status: r.rows[0]?.status, success: r.rows[0]?.success_count };
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  try {
    const concurrencySql = readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8");
    const coreSql = readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8");
    const setup = await pool.connect();
    try {
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(concurrencySql);
      await setup.query(coreSql);
    } finally {
      setup.release();
    }
    console.log("migrations applied (concurrency → core)");

    // 시드: scenarios → scenario_versions(FK 대상).
    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'apc-int')`, [SCENARIO, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
         VALUES ($1,$2,$3,1,'draft','{"nodes":[]}'::jsonb)`,
        [SCENARIO_VERSION, TENANT, SCENARIO],
      );
    });
    console.log("seeded scenario/version");

    const cache = new PgActionPlanCache(pool);

    // 1) miss → undefined
    check("get miss → undefined", (await cache.get(baseKey)) === undefined);

    // 2) put(active) → get 재생
    await cache.put(baseKey, PLAN);
    const got = await cache.get(baseKey);
    check("put → get replays plan", JSON.stringify(got) === JSON.stringify(PLAN), JSON.stringify(got));
    check("put → status=active, success_count=1", (await statusOf(pool, baseKey)).status === "active" && (await statusOf(pool, baseKey)).success === 1);

    // 3) ON CONFLICT 재put → success_count+1
    await cache.put(baseKey, { operation: "fill", selector: "#q", value: "x" });
    const s = await statusOf(pool, baseKey);
    check("re-put → ON CONFLICT success_count=2", s.success === 2);
    check("re-put → plan updated (fill)", (await cache.get(baseKey))?.operation === "fill");

    // 4) markSuspect: active→suspect(재생 차단)
    await cache.markSuspect(baseKey);
    check("markSuspect → status=suspect", (await statusOf(pool, baseKey)).status === "suspect");
    check("suspect → get undefined (재생 차단)", (await cache.get(baseKey)) === undefined);

    // 5) markSuspect again: suspect→stale
    await cache.markSuspect(baseKey);
    check("markSuspect again → status=stale", (await statusOf(pool, baseKey)).status === "stale");

    // 6) 미존재 family → markSuspect = suspect 1회 기록
    const newKey: ActionPlanCacheKey = { ...baseKey, domStructuralHash: "h2" };
    await cache.markSuspect(newKey);
    check("markSuspect on new family → inserts suspect", (await statusOf(pool, newKey)).status === "suspect");
    check("new suspect family → get undefined", (await cache.get(newKey)) === undefined);

    // 7) tenant 스코프: 다른 tenant 로 get → undefined
    check("cross-tenant get → undefined", (await cache.get({ ...baseKey, tenantId: OTHER_TENANT })) === undefined);
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D3 PgActionPlanCache integration green");
  process.exit(0);
}

main().catch((e) => {
  console.error("int fatal:", e);
  process.exit(1);
});
