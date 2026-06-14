/**
 * D4.4 통합 테스트 — 시나리오 저장/검증 + §10 컴파일 파이프라인(ajv→IREL→V1–V11)을 실 PostgreSQL로 검증.
 *
 * 실행: temp PG15 게이트 위에서 test:int 체인.
 * 검증(d4-prompt §5.4 게이트): 유효 IR 저장(201) OK + 무효 IR 거부(422) + validate dry-run(ValidationReport)
 *   + RBAC(create=operator+, read/validate=전 역할).  promote(승격)는 후속 증분.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { createPool, withTenantTx } from "../src/db/pool";
import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_scenarios_int";
const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const SECRET = new TextEncoder().encode("d44-int-test-secret-do-not-use-in-prod-0123456789");

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

interface ScenarioIrFixture {
  meta: { name: string; version: number };
  start: string;
  nodes: Record<string, { terminal: "success"; next?: string }>;
}

// 유효 IR: meta+start+nodes(흐름키 1개). 무효(ajv): 흐름키 2개. 무효(graph): start가 없는 노드 참조(V2).
const validIr = (name: string): ScenarioIrFixture => ({ meta: { name, version: 1 }, start: "n1", nodes: { n1: { terminal: "success" } } });
const ajvInvalidIr = { meta: { name: "ajv-bad", version: 1 }, start: "n1", nodes: { n1: { terminal: "success", next: "n2" } } };
const graphInvalidIr = (name: string): ScenarioIrFixture => ({ meta: { name, version: 1 }, start: "missing", nodes: { n1: { terminal: "success" } } });

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

    const enqueuer: RunEnqueuer = { async enqueueRunClaim() {} };
    const app = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer,
    });
    await app.ready();
    try {
      const operator = await mint({ sub: "op", tenant_id: TENANT_A, roles: ["operator"] });
      const viewer = await mint({ sub: "vw", tenant_id: TENANT_A, roles: ["viewer"] });

      // 1) operator 유효 IR 저장 → 201 + ETag=version.
      const created = await app.inject({
        method: "POST", url: "/v1/scenarios",
        headers: { authorization: `Bearer ${operator}` },
        payload: validIr("scenario-a"),
      });
      check("create valid IR → 201", created.statusCode === 201, created.body);
      const createdBody = created.json();
      check("create version=1", createdBody.version === 1, JSON.stringify(createdBody));
      check("create promotion_status=draft", createdBody.promotion_status === "draft", JSON.stringify(createdBody));
      check("create ETag=1", created.headers.etag === "1", String(created.headers.etag));
      const scenarioId = createdBody.scenario_id;

      // 2) GET 상세 → 200 + version + ETag. compiled_ast 캐시 확인(DB).
      const got = await app.inject({ method: "GET", url: `/v1/scenarios/${scenarioId}`, headers: { authorization: `Bearer ${viewer}` } });
      check("get scenario (viewer read) → 200", got.statusCode === 200, got.body);
      check("get version=1 + ETag", got.json().version === 1 && got.headers.etag === "1", got.body);
      await withTenantTx(pool, TENANT_A, async (c) => {
        const r = await c.query<{ compiled_ast: string | null }>(`SELECT compiled_ast FROM scenario_versions WHERE scenario_id=$1::uuid`, [scenarioId]);
        check("compiled_ast cached (non-null)", typeof r.rows[0]?.compiled_ast === "string" && r.rows[0].compiled_ast.length > 0, JSON.stringify(r.rows[0]));
      });

      // 3) validate dry-run: 유효 IR → 200 {valid:true}, 그래프 무효 → 200 {valid:false, errors}.
      const valOk = await app.inject({ method: "POST", url: `/v1/scenarios/${scenarioId}/validate`, headers: { authorization: `Bearer ${viewer}` }, payload: validIr("ignored") });
      check("validate valid → 200 valid:true", valOk.statusCode === 200 && valOk.json().valid === true, valOk.body);
      const valGraph = await app.inject({ method: "POST", url: `/v1/scenarios/${scenarioId}/validate`, headers: { authorization: `Bearer ${operator}` }, payload: graphInvalidIr("ignored") });
      check("validate graph-invalid → 200 valid:false + errors", valGraph.statusCode === 200 && valGraph.json().valid === false && valGraph.json().report.errors.length > 0, valGraph.body);

      // 4) 무효 IR 저장 거부(422): ajv 위반(흐름키 2개) + 그래프 위반(start 미존재).
      const ajvBad = await app.inject({ method: "POST", url: "/v1/scenarios", headers: { authorization: `Bearer ${operator}` }, payload: ajvInvalidIr });
      check("create ajv-invalid → 422", ajvBad.statusCode === 422, ajvBad.body);
      check("ajv-invalid → IR_SCHEMA_INVALID", ajvBad.json().code === "IR_SCHEMA_INVALID", ajvBad.body);
      const graphBad = await app.inject({ method: "POST", url: "/v1/scenarios", headers: { authorization: `Bearer ${operator}` }, payload: graphInvalidIr("scenario-graphbad") });
      check("create graph-invalid → 422", graphBad.statusCode === 422, graphBad.body);
      check("graph-invalid → IR_SCHEMA_INVALID", graphBad.json().code === "IR_SCHEMA_INVALID", graphBad.body);

      // 5) RBAC: viewer는 scenario.create 미허용 → 403(파이프라인 이전 인가 차단).
      const viewerCreate = await app.inject({ method: "POST", url: "/v1/scenarios", headers: { authorization: `Bearer ${viewer}` }, payload: validIr("viewer-blocked") });
      check("viewer create → 403", viewerCreate.statusCode === 403, viewerCreate.body);
      check("viewer create → AUTHZ_FORBIDDEN", viewerCreate.json().code === "AUTHZ_FORBIDDEN", viewerCreate.body);

      // 6) 미존재 scenario → 404 RESOURCE_NOT_FOUND.
      const absent = await app.inject({ method: "GET", url: "/v1/scenarios/10000000-0000-0000-0000-0000000000ff", headers: { authorization: `Bearer ${operator}` } });
      check("absent scenario → 404", absent.statusCode === 404, absent.body);
      check("absent → RESOURCE_NOT_FOUND", absent.json().code === "RESOURCE_NOT_FOUND", absent.body);
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
  console.log("\nPASS: D4.4 scenario save/validate + compile pipeline integration green");
}

main().catch((err) => {
  console.error("FAIL: scenarios integration threw:", err);
  process.exit(1);
});
