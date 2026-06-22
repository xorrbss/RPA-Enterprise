/**
 * 통합 — loadRunActionPlans (PbD 승격 ② DB read). 실 PostgreSQL.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npx tsx app/test/scenario-promotion-store.int.ts
 * 검증: 성공 act step ⋈ done stagehand 의 parsed_json→ActionPlan(node_id 키); 비-act(observe)·비-success·비-done·
 *       비-act-plan(extract json) 제외; RLS cross-tenant 격리.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadRunActionPlans } from "../src/api/scenario-promotion-store";
import { createPool, withTenantTx } from "../src/db/pool";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_promotion_store_int";
const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const SCEN_A = "70000000-0000-0000-0000-0000000000a3";
const SVER_A = "70000000-0000-0000-0000-0000000000a4";
const RUN_A = "71000000-0000-0000-0000-0000000000a1";
const SCEN_B = "70000000-0000-0000-0000-0000000000b3";
const SVER_B = "70000000-0000-0000-0000-0000000000b4";
const RUN_B = "71000000-0000-0000-0000-0000000000b1";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

type Pool = ReturnType<typeof createPool>;

async function seedRun(pool: Pool, tenant: string, scen: string, sver: string, run: string): Promise<void> {
  await withTenantTx(pool, tenant, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'promo')`, [scen, tenant]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'draft','{"nodes":[]}'::jsonb)`,
      [sver, tenant, scen],
    );
    await c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, as_of, created_at)
       VALUES ($1,$2,$3,'completed',$1,1,'2026-06-15T00:00:00Z','2026-06-15T00:00:00Z')`,
      [run, tenant, sver],
    );
  });
}

async function seedStep(pool: Pool, tenant: string, run: string, stepId: string, nodeId: string, action: string, status: string): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO run_steps (id, run_id, tenant_id, step_id, node_id, attempt, action, status, cache_mode, created_at)
       VALUES (gen_random_uuid(), $1,$2,$3,$4,0,$5,$6,'miss','2026-06-15T00:00:01Z')`,
      [run, tenant, stepId, nodeId, action, status],
    ),
  );
}

async function seedStagehand(pool: Pool, tenant: string, run: string, stepId: string, parsedJson: unknown, streamStatus: string, createdAt: string): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO stagehand_calls (id, tenant_id, run_id, step_id, attempt, idempotency_key, request_hash, model,
                                    transport, stream_status, parsed_json, created_at)
       VALUES (gen_random_uuid(), $1,$2,$3,0,$4,'rh','gpt-4o-mini','sse',$5,$6::jsonb,$7::timestamptz)`,
      [tenant, run, stepId, `${run}:${stepId}:0`, streamStatus, JSON.stringify(parsedJson), createdAt],
    ),
  );
}

// attempt 변동 시드(loop 재해소: 같은 step_id·다른 attempt) — distinct step_id 모호성 판정 검증용.
async function seedStepAttempt(pool: Pool, tenant: string, run: string, stepId: string, nodeId: string, action: string, status: string, attempt: number, createdAt: string): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO run_steps (id, run_id, tenant_id, step_id, node_id, attempt, action, status, cache_mode, created_at)
       VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7,'miss',$8::timestamptz)`,
      [run, tenant, stepId, nodeId, attempt, action, status, createdAt],
    ),
  );
}

async function seedStagehandAttempt(pool: Pool, tenant: string, run: string, stepId: string, parsedJson: unknown, streamStatus: string, attempt: number, createdAt: string): Promise<void> {
  await withTenantTx(pool, tenant, (c) =>
    c.query(
      `INSERT INTO stagehand_calls (id, tenant_id, run_id, step_id, attempt, idempotency_key, request_hash, model,
                                    transport, stream_status, parsed_json, created_at)
       VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,'rh','gpt-4o-mini','sse',$6,$7::jsonb,$8::timestamptz)`,
      [tenant, run, stepId, attempt, `${run}:${stepId}:${attempt}`, streamStatus, JSON.stringify(parsedJson), createdAt],
    ),
  );
}

// cache-hit step: stagehand_call 없이 action_plan_cache(plan_ref)+run_steps(cache_mode='hit', action_plan_cache_id) 시드.
//   lastSuccessAt = 캐시 put/덮어쓰기 시각, stepCreatedAt = run 이 그 step 을 기록한 시각. CHP-01 가드는
//   lastSuccessAt > stepCreatedAt(run 실행 후 cross-run 재해소로 덮어써짐)이면 plan 을 제외한다. 기본값은 정당 hit
//   (put 이 step 전) — put 시각 ≤ step 기록 시각.
async function seedHitStep(
  pool: Pool, tenant: string, run: string, sver: string, stepId: string, nodeId: string,
  cacheId: string, planRef: unknown, status: string,
  lastSuccessAt = "2026-06-15T00:00:05Z", stepCreatedAt = "2026-06-15T00:00:06Z",
): Promise<void> {
  await withTenantTx(pool, tenant, async (c) => {
    await c.query(
      `INSERT INTO action_plan_cache (id, tenant_id, scenario_version_id, step_id, url_pattern, dom_structural_hash,
          model, prompt_template_version, browser_identity_version, plan_ref, status, last_success_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,'u-'||$4,'h-'||$4,'codex','v1',1,$5,$6,$7::timestamptz)`,
      [cacheId, tenant, sver, stepId, JSON.stringify(planRef), status, lastSuccessAt],
    );
    await c.query(
      `INSERT INTO run_steps (id, run_id, tenant_id, step_id, node_id, attempt, action, status, cache_mode, action_plan_cache_id, created_at)
       VALUES (gen_random_uuid(), $1,$2,$3,$4,0,'act','success','hit',$5::uuid,$6::timestamptz)`,
      [run, tenant, stepId, nodeId, cacheId, stepCreatedAt],
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

    await seedRun(pool, TENANT_A, SCEN_A, SVER_A, RUN_A);
    // n1: act success + done click → 포함
    await seedStep(pool, TENANT_A, RUN_A, "s1", "n1", "act", "success");
    await seedStagehand(pool, TENANT_A, RUN_A, "s1", { operation: "click", selector: "#submit" }, "done", "2026-06-15T00:00:01Z");
    // n2: act success + done fill → 포함(fill plan)
    await seedStep(pool, TENANT_A, RUN_A, "s2", "n2", "act", "success");
    await seedStagehand(pool, TENANT_A, RUN_A, "s2", { operation: "fill", selector: "#name", value: "v" }, "done", "2026-06-15T00:00:02Z");
    // n3: observe success + done extract-json → 제외(action != act)
    await seedStep(pool, TENANT_A, RUN_A, "s3", "n3", "observe", "success");
    await seedStagehand(pool, TENANT_A, RUN_A, "s3", { summary: "ok", rows: [] }, "done", "2026-06-15T00:00:03Z");
    // n4: act failed_system + done click → 제외(status != success)
    await seedStep(pool, TENANT_A, RUN_A, "s4", "n4", "act", "failed_system");
    await seedStagehand(pool, TENANT_A, RUN_A, "s4", { operation: "click", selector: "#bad" }, "done", "2026-06-15T00:00:04Z");
    // n5: act success + error stagehand → 제외(stream_status != done)
    await seedStep(pool, TENANT_A, RUN_A, "s5", "n5", "act", "success");
    await seedStagehand(pool, TENANT_A, RUN_A, "s5", { operation: "click", selector: "#err" }, "error", "2026-06-15T00:00:05Z");
    // n6: cache-hit step(stagehand 없음) → active 한 action_plan_cache.plan_ref 에서 복구(PR-2).
    await seedHitStep(pool, TENANT_A, RUN_A, SVER_A, "s6", "n6", "50000000-0000-4000-8000-000000000061", { operation: "click", selector: "#cached" }, "active");
    // n7: cache-hit step 인데 캐시 entry 가 stale(드리프트) → 복구 제외(active-only — 알려진-나쁜 셀렉터 베이킹 금지).
    await seedHitStep(pool, TENANT_A, RUN_A, SVER_A, "s7", "n7", "50000000-0000-4000-8000-000000000071", { operation: "click", selector: "#stale" }, "stale");
    // n8: 다중-act 노드 — 한 노드(n8)에 act 스텝 둘(s8.0 fill 아이디·s8.1 fill 비번, distinct step_id). plan→act 귀속
    //   모호 → plans 에서 제외 + ambiguousNodeIds 에 보고(조용한 오귀속 금지; 자격증명 fill 셀렉터 오필드 차단).
    await seedStep(pool, TENANT_A, RUN_A, "s8.0", "n8", "act", "success");
    await seedStagehand(pool, TENANT_A, RUN_A, "s8.0", { operation: "fill", selector: "#user", value: "u" }, "done", "2026-06-15T00:00:07Z");
    await seedStep(pool, TENANT_A, RUN_A, "s8.1", "n8", "act", "success");
    await seedStagehand(pool, TENANT_A, RUN_A, "s8.1", { operation: "fill", selector: "#pw", value: "p" }, "done", "2026-06-15T00:00:08Z");
    // n9: loop 재해소 — 같은 step_id(s9)·다른 attempt 다중 행. distinct step_id 가 1 개라 모호하지 않다(last-write-wins).
    await seedStepAttempt(pool, TENANT_A, RUN_A, "s9", "n9", "act", "success", 0, "2026-06-15T00:00:09Z");
    await seedStagehandAttempt(pool, TENANT_A, RUN_A, "s9", { operation: "click", selector: "#iter0" }, "done", 0, "2026-06-15T00:00:09Z");
    await seedStepAttempt(pool, TENANT_A, RUN_A, "s9", "n9", "act", "success", 1, "2026-06-15T00:00:10Z");
    await seedStagehandAttempt(pool, TENANT_A, RUN_A, "s9", { operation: "click", selector: "#iter1" }, "done", 1, "2026-06-15T00:00:10Z");
    // n10: cache-hit step 인데 캐시가 run 의 step 실행(stepCreatedAt 00:11) 후 cross-run 재해소로 덮어써짐
    //   (lastSuccessAt 00:30 > stepCreatedAt 00:11) → 현재 plan_ref 는 run 이 실행한 셀렉터가 아님(CHP-01) → 제외.
    await seedHitStep(
      pool, TENANT_A, RUN_A, SVER_A, "s10", "n10", "50000000-0000-4000-8000-000000000101",
      { operation: "click", selector: "#overwritten" }, "active", "2026-06-15T00:00:30Z", "2026-06-15T00:00:11Z",
    );

    // cross-tenant: tenant B act success + done → A 조회 시 비가시
    await seedRun(pool, TENANT_B, SCEN_B, SVER_B, RUN_B);
    await seedStep(pool, TENANT_B, RUN_B, "sb", "nb", "act", "success");
    await seedStagehand(pool, TENANT_B, RUN_B, "sb", { operation: "click", selector: "#b" }, "done", "2026-06-15T00:00:01Z");

    const { plans, ambiguousNodeIds } = await withTenantTx(pool, TENANT_A, (c) => loadRunActionPlans(c, RUN_A));
    // n9(loop 재해소)는 distinct step_id 1 개라 모호 아님 → 포함. n8(다중-act)은 제외.
    check("loads act+success plans from stagehand(miss), active cache(hit), loop(n9)", Object.keys(plans).sort().join(",") === "n1,n2,n6,n9", JSON.stringify(plans));
    check("n1 click selector", plans.n1?.operation === "click" && plans.n1.selector === "#submit", JSON.stringify(plans.n1));
    check("n2 fill selector", plans.n2?.operation === "fill" && plans.n2.selector === "#name", JSON.stringify(plans.n2));
    check("observe(n3) excluded", plans.n3 === undefined);
    check("failed act(n4) excluded", plans.n4 === undefined);
    check("non-done stagehand(n5) excluded", plans.n5 === undefined);
    check("cache-hit(n6) recovered from active action_plan_cache.plan_ref", plans.n6?.operation === "click" && plans.n6.selector === "#cached", JSON.stringify(plans.n6));
    check("cache-hit with stale cache entry(n7) excluded (active-only)", plans.n7 === undefined, JSON.stringify(plans.n7));
    // 다중-act 노드(n8): plans 제외 + ambiguousNodeIds 보고(조용한 오귀속 방지). 손수 IR 로만 도달하지만 plan→act 귀속 불가.
    check("multi-act node(n8) excluded from plans", plans.n8 === undefined, JSON.stringify(plans.n8));
    check("multi-act node(n8) reported in ambiguousNodeIds", ambiguousNodeIds.includes("n8"), JSON.stringify(ambiguousNodeIds));
    // loop 재해소(n9): 같은 step_id 다중 attempt 는 distinct step_id 1 개 → 모호 아님, last-write-wins(attempt 1, #iter1).
    check("loop node(n9) not ambiguous, last-write-wins", plans.n9?.operation === "click" && plans.n9.selector === "#iter1" && !ambiguousNodeIds.includes("n9"), JSON.stringify({ n9: plans.n9, ambiguousNodeIds }));
    // CHP-01 (n10): run 실행 후 캐시가 cross-run 재해소로 덮어써진 hit plan 은 제외(run 이 실행 안 한 셀렉터 베이킹 금지).
    check("cache-hit overwritten after run(n10) excluded (last_success_at > step.created_at)", plans.n10 === undefined, JSON.stringify(plans.n10));

    const crossA = await withTenantTx(pool, TENANT_A, (c) => loadRunActionPlans(c, RUN_B));
    check("cross-tenant run → empty (RLS)", Object.keys(crossA.plans).length === 0, JSON.stringify(crossA));
    const ownB = await withTenantTx(pool, TENANT_B, (c) => loadRunActionPlans(c, RUN_B));
    check("tenant B sees own run plan", ownB.plans.nb?.operation === "click" && ownB.plans.nb.selector === "#b", JSON.stringify(ownB));

    if (failures > 0) {
      console.error(`\nFAIL: scenario-promotion-store.int (${failures})`);
      process.exit(1);
    }
    console.log("\nPASS: scenario-promotion-store.int");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
