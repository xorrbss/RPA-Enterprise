/**
 * 통합 — POST /v1/scenarios/{id}/promote-from-run (PbD 승격 ③, slice1+2 결합). 실 PostgreSQL.
 *
 * 실행: node scripts/db-temp-postgres-gate.mjs -- npx tsx app/test/scenario-promote-from-run.int.ts
 * 검증: 성공 run 의 click ActionPlan → 새 draft 버전 IR 의 act.args.click_selector 베이킹; 멱등 replay; 미완료 run·
 *       click plan 0 거부; RBAC scenario.promote.
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
const SCHEMA = "rpa_promote_from_run_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const SCEN = "70000000-0000-0000-0000-0000000000a3";
const SV1 = "70000000-0000-0000-0000-0000000000a4";
const SCEN2 = "70000000-0000-0000-0000-0000000000c3";
const SV2 = "70000000-0000-0000-0000-0000000000c4";
const RUN_OK = "71000000-0000-0000-0000-0000000000a1";
const RUN_RUNNING = "71000000-0000-0000-0000-0000000000a2";
const RUN_NOPLAN = "71000000-0000-0000-0000-0000000000a3";
const SCEN_FILL = "70000000-0000-0000-0000-0000000000d3";
const SV_FILL = "70000000-0000-0000-0000-0000000000d4";
const RUN_FILL = "71000000-0000-0000-0000-0000000000d1";
const SCEN_SELECT = "70000000-0000-0000-0000-0000000000e3";
const SV_SELECT = "70000000-0000-0000-0000-0000000000e4";
const RUN_SELECT = "71000000-0000-0000-0000-0000000000e1";

const SECRET = new TextEncoder().encode("promote-from-run-int-secret-do-not-use-in-prod-0123456789");
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
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function mint(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m").sign(SECRET);
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type Pool = ReturnType<typeof createPool>;

const SOURCE_IR = {
  meta: { name: "promo-src", version: 1 },
  start: "n1",
  nodes: {
    n1: { what: [{ action: "act", instruction: "click the submit button" }], next: "done", side_effect: { kind: "read_only" } },
    done: { terminal: "success" },
  },
};

// slice 2b: 값 출처(value_ref)를 가진 fill 노드 — 성공 run 의 fill ActionPlan 셀렉터가 act.args.fill_selector 로 베이킹돼야.
const SOURCE_IR_FILL = {
  meta: { name: "promo-fill", version: 1 },
  start: "f1",
  params_schema: { type: "object", properties: { reason: { type: "string" } } },
  nodes: {
    f1: { what: [{ action: "act", instruction: "사유를 입력", args: { value_ref: "reason" } }], next: "done", side_effect: { kind: "read_only" } },
    done: { terminal: "success" },
  },
};

// slice 2c: select 노드 — 성공 run 의 select ActionPlan(selector+value)이 select_selector+select_value 로 베이킹돼야.
const SOURCE_IR_SELECT = {
  meta: { name: "promo-select", version: 1 },
  start: "g1",
  nodes: {
    g1: { what: [{ action: "act", instruction: "연도를 선택" }], next: "done", side_effect: { kind: "read_only" } },
    done: { terminal: "success" },
  },
};

async function seedScenario(pool: Pool, scen: string, sver: string, name: string): Promise<void> {
  await withTenantTx(pool, TENANT, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,$3)`, [scen, TENANT, name]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1,$2,$3,1,'draft',$4::jsonb)`,
      [sver, TENANT, scen, JSON.stringify(SOURCE_IR)],
    );
  });
}
async function seedRun(pool: Pool, run: string, sver: string, status: string): Promise<void> {
  await withTenantTx(pool, TENANT, (c) =>
    c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id, attempts, as_of, created_at)
       VALUES ($1,$2,$3,$4,$1,1,'2026-06-15T00:00:00Z','2026-06-15T00:00:00Z')`,
      [run, TENANT, sver, status],
    ),
  );
}
async function seedActStep(pool: Pool, run: string, stepId: string, nodeId: string, action: string, status: string, plan: unknown, streamStatus: string): Promise<void> {
  await withTenantTx(pool, TENANT, async (c) => {
    await c.query(
      `INSERT INTO run_steps (id, run_id, tenant_id, step_id, node_id, attempt, action, status, cache_mode, created_at)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,0,$5,$6,'miss','2026-06-15T00:00:01Z')`,
      [run, TENANT, stepId, nodeId, action, status],
    );
    if (plan !== undefined) {
      await c.query(
        `INSERT INTO stagehand_calls (id, tenant_id, run_id, step_id, attempt, idempotency_key, request_hash, model,
                                      transport, stream_status, parsed_json, created_at)
         VALUES (gen_random_uuid(),$1,$2,$3,0,$4,'rh','gpt-4o-mini','sse',$5,$6::jsonb,'2026-06-15T00:00:01Z')`,
        [TENANT, run, stepId, `${run}:${stepId}:0`, streamStatus, JSON.stringify(plan)],
      );
    }
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

    await seedScenario(pool, SCEN, SV1, "promo-src");
    await seedRun(pool, RUN_OK, SV1, "completed");
    await seedActStep(pool, RUN_OK, "s1", "n1", "act", "success", { operation: "click", selector: "#submit" }, "done");
    await seedRun(pool, RUN_RUNNING, SV1, "running");
    await seedActStep(pool, RUN_RUNNING, "s1", "n1", "act", "success", { operation: "click", selector: "#submit" }, "done");
    await seedRun(pool, RUN_NOPLAN, SV1, "completed");
    await seedActStep(pool, RUN_NOPLAN, "s1", "n1", "observe", "success", undefined, "done"); // act 아님 → plan 0
    await seedScenario(pool, SCEN2, SV2, "other");
    // slice 2b fill 승격: 값 출처(value_ref) fill 노드 시나리오 + 성공 run 의 fill ActionPlan.
    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,$3)`, [SCEN_FILL, TENANT, "promo-fill"]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir) VALUES ($1,$2,$3,1,'draft',$4::jsonb)`,
        [SV_FILL, TENANT, SCEN_FILL, JSON.stringify(SOURCE_IR_FILL)],
      );
    });
    await seedRun(pool, RUN_FILL, SV_FILL, "completed");
    await seedActStep(pool, RUN_FILL, "s1", "f1", "act", "success", { operation: "fill", selector: "textarea#reason", valueRef: "reason" }, "done");
    // slice 2c select 승격: select 노드 시나리오 + 성공 run 의 select ActionPlan.
    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,$3)`, [SCEN_SELECT, TENANT, "promo-select"]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir) VALUES ($1,$2,$3,1,'draft',$4::jsonb)`,
        [SV_SELECT, TENANT, SCEN_SELECT, JSON.stringify(SOURCE_IR_SELECT)],
      );
    });
    await seedRun(pool, RUN_SELECT, SV_SELECT, "completed");
    await seedActStep(pool, RUN_SELECT, "s1", "g1", "act", "success", { operation: "select", selector: "select#year", value: "2026" }, "done");

    const noopEnqueuer: RunEnqueuer = { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} };
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
      const admin = await mint({ sub: "ad", tenant_id: TENANT, roles: ["admin"] });
      const post = (scen: string, body: Record<string, unknown>, key: string) =>
        app.inject({ method: "POST", url: `/v1/scenarios/${scen}/promote-from-run`, headers: { authorization: `Bearer ${admin}`, "idempotency-key": key }, payload: body });

      // 1) 해피패스: 성공 run → 새 draft 버전, click_selector 베이킹.
      const ok = await post(SCEN, { run_id: RUN_OK }, "promote-ok-1");
      check("promote-from-run → 201", ok.statusCode === 201, ok.body);
      const okBody = ok.json();
      check("new version = 2 draft", okBody.version === 2 && okBody.promotion_status === "draft", ok.body);
      check("promoted_node_ids = [n1]", Array.isArray(okBody.promoted_node_ids) && okBody.promoted_node_ids.length === 1 && okBody.promoted_node_ids[0] === "n1", ok.body);
      const newVer = await withTenantTx(pool, TENANT, (c) =>
        c.query<{ ir: unknown }>(`SELECT ir FROM scenario_versions WHERE tenant_id=$1::uuid AND scenario_id=$2::uuid AND version=2`, [TENANT, SCEN]),
      );
      const newIr = newVer.rows[0]?.ir;
      const n1 = isRecord(newIr) && isRecord((newIr.nodes as Record<string, unknown>)?.n1) ? ((newIr.nodes as Record<string, Record<string, unknown>>).n1) : {};
      const n1what = Array.isArray(n1.what) ? (n1.what as Array<Record<string, unknown>>) : [];
      const n1args = isRecord(n1what[0]?.args) ? (n1what[0].args as Record<string, unknown>) : {};
      check("new version IR n1.act has deterministic click_selector", n1args.click_selector === "#submit", JSON.stringify(n1what));

      // 2) 멱등 replay: 같은 키 → 같은 응답(재승격 안 함).
      const replay = await post(SCEN, { run_id: RUN_OK }, "promote-ok-1");
      check("idempotent replay → same 201 version 2", replay.statusCode === 201 && replay.json().version === 2, replay.body);
      const count = await withTenantTx(pool, TENANT, (c) =>
        c.query<{ n: string }>(`SELECT count(*)::text AS n FROM scenario_versions WHERE tenant_id=$1::uuid AND scenario_id=$2::uuid`, [TENANT, SCEN]),
      );
      check("replay does not create a 3rd version", count.rows[0]?.n === "2", JSON.stringify(count.rows));

      // 3) 미완료 run → 거부(loud).
      const running = await post(SCEN, { run_id: RUN_RUNNING }, "promote-running-1");
      check("running run → 422 run_not_completed", running.statusCode === 422 && running.json().code === "IR_SCHEMA_INVALID", running.body);

      // 4) plan 0(observe만) → no_plans_to_promote.
      const noplan = await post(SCEN, { run_id: RUN_NOPLAN }, "promote-noplan-1");
      check("no plans → 422 (no_plans_to_promote)", noplan.statusCode === 422 && noplan.json().code === "IR_SCHEMA_INVALID", noplan.body);

      // 4b) fill 승격(slice 2b): 값 출처 보유 fill 노드 → act.args.fill_selector 베이킹 + value_ref 보존.
      const fillRes = await post(SCEN_FILL, { run_id: RUN_FILL }, "promote-fill-1");
      check("fill promote-from-run → 201", fillRes.statusCode === 201, fillRes.body);
      check("fill promoted_node_ids = [f1]", fillRes.json().promoted_node_ids?.[0] === "f1" && fillRes.json().promoted_node_ids?.length === 1, fillRes.body);
      const fillVer = await withTenantTx(pool, TENANT, (c) =>
        c.query<{ ir: unknown }>(`SELECT ir FROM scenario_versions WHERE tenant_id=$1::uuid AND scenario_id=$2::uuid AND version=2`, [TENANT, SCEN_FILL]),
      );
      const fillIr = fillVer.rows[0]?.ir;
      const f1 = isRecord(fillIr) && isRecord((fillIr.nodes as Record<string, unknown>)?.f1) ? ((fillIr.nodes as Record<string, Record<string, unknown>>).f1) : {};
      const f1what = Array.isArray(f1.what) ? (f1.what as Array<Record<string, unknown>>) : [];
      const f1args = isRecord(f1what[0]?.args) ? (f1what[0].args as Record<string, unknown>) : {};
      check("fill new version IR f1.act has deterministic fill_selector + preserved value_ref", f1args.fill_selector === "textarea#reason" && f1args.value_ref === "reason", JSON.stringify(f1what));

      // 4c) select 승격(slice 2c): select 노드 → act.args.select_selector + select_value 베이킹.
      const selRes = await post(SCEN_SELECT, { run_id: RUN_SELECT }, "promote-select-1");
      check("select promote-from-run → 201", selRes.statusCode === 201, selRes.body);
      check("select promoted_node_ids = [g1]", selRes.json().promoted_node_ids?.[0] === "g1" && selRes.json().promoted_node_ids?.length === 1, selRes.body);
      const selVer = await withTenantTx(pool, TENANT, (c) =>
        c.query<{ ir: unknown }>(`SELECT ir FROM scenario_versions WHERE tenant_id=$1::uuid AND scenario_id=$2::uuid AND version=2`, [TENANT, SCEN_SELECT]),
      );
      const selIr = selVer.rows[0]?.ir;
      const g1 = isRecord(selIr) && isRecord((selIr.nodes as Record<string, unknown>)?.g1) ? ((selIr.nodes as Record<string, Record<string, unknown>>).g1) : {};
      const g1what = Array.isArray(g1.what) ? (g1.what as Array<Record<string, unknown>>) : [];
      const g1args = isRecord(g1what[0]?.args) ? (g1what[0].args as Record<string, unknown>) : {};
      check("select new version IR g1.act has deterministic select_selector + select_value", g1args.select_selector === "select#year" && g1args.select_value === "2026", JSON.stringify(g1what));

      // 5) run 이 다른 시나리오 소속 → run_not_for_scenario.
      const wrongScenario = await post(SCEN2, { run_id: RUN_OK }, "promote-wrong-1");
      check("run not for scenario → 422 run_not_for_scenario", wrongScenario.statusCode === 422 && wrongScenario.json().code === "IR_SCHEMA_INVALID", wrongScenario.body);
    } finally {
      await app.close();
    }

    if (failures > 0) {
      console.error(`\nFAIL: scenario-promote-from-run.int (${failures})`);
      process.exit(1);
    }
    console.log("\nPASS: scenario-promote-from-run.int");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
