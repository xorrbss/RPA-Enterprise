/**
 * Gap2 통합 테스트 — POST /v1/runs 의 model 해소·동결(runs.model)을 실 PostgreSQL로 검증.
 *
 * 실행: temp PG15 게이트 위 test:int 체인(node scripts/db-temp-postgres-gate.mjs -- npm --prefix app run test:runs-model).
 * 검증(server.ts model 해소 분기 + 결정성): 0정책→NULL · 단일정책 자동해소 · 명시 존재→동결 · 명시 부재→404
 *   RESOURCE_NOT_FOUND · 다정책+미지정+default없음→422 model_required · is_default 해소 · 멱등 replay 동결.
 * 다중 테넌트(서로 다른 정책 구성)로 RLS 격리도 암묵 검증(단일정책 테넌트가 타테넌트 정책을 보지 않아야 자동해소).
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { createPool, withTenantTx } from "../src/db/pool";
import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_runs_model_int";
const SECRET = new TextEncoder().encode("gap2-int-test-secret-do-not-use-in-prod-0123456789");

// 테넌트별 고정 정책 구성: T0=0정책, T1=단일(codex), T2=다정책(no default), TD=다정책(d2=default).
const T0 = "00000000-0000-0000-0000-0000000000a0";
const T1 = "00000000-0000-0000-0000-0000000000a1";
const T2 = "00000000-0000-0000-0000-0000000000a2";
const TD = "00000000-0000-0000-0000-0000000000a3";
const SV0 = "10000000-0000-0000-0000-0000000000a0";
const SV1 = "10000000-0000-0000-0000-0000000000a1";
const SV2 = "10000000-0000-0000-0000-0000000000a2";
const SVD = "10000000-0000-0000-0000-0000000000a3";

const CAPS = { domReasoning: true, vision: false, jsonMode: true, toolCall: false, sse: true, maxContextTokens: 8000 };
const BUDGET = { maxInputTokens: 1000, maxOutputTokens: 1000, maxCost: 10 };

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function mint(tenant: string): Promise<string> {
  return new SignJWT({ sub: randomUUID(), tenant_id: tenant, roles: ["operator"] })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(SECRET);
}

const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return { kind: "available", snapshot: { sourceRef: "secret://test/registry" as never, commands: [] } };
  },
};

async function seedScenario(pool: ReturnType<typeof createPool>, tenant: string, sver: string): Promise<void> {
  const scenario = randomUUID();
  await withTenantTx(pool, tenant, async (c) => {
    await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1::uuid,$2::uuid,'gap2')`, [scenario, tenant]);
    await c.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1::uuid,$2::uuid,$3::uuid,1,'draft','{"nodes":[],"target":{"site_profile_id":"00000000-0000-4000-8000-0000000000a1","browser_identity_id":"00000000-0000-4000-8000-0000000000a2","network_policy_id":"00000000-0000-4000-8000-0000000000a3"}}'::jsonb)`,
      [sver, tenant, scenario],
    );
  });
}

async function seedPolicy(pool: ReturnType<typeof createPool>, tenant: string, model: string, isDefault = false): Promise<void> {
  await withTenantTx(pool, tenant, async (c) => {
    await c.query(
      `INSERT INTO gateway_policies (id, tenant_id, model, version, capabilities, budget, is_default)
       VALUES ($1::uuid,$2::uuid,$3,1,$4::jsonb,$5::jsonb,$6)`,
      [randomUUID(), tenant, model, JSON.stringify(CAPS), JSON.stringify(BUDGET), isDefault],
    );
  });
}

async function runModel(pool: ReturnType<typeof createPool>, tenant: string, runId: string): Promise<string | null> {
  return withTenantTx(pool, tenant, async (c) => {
    const r = await c.query<{ model: string | null }>(`SELECT model FROM runs WHERE id = $1::uuid`, [runId]);
    return r.rows[0]?.model ?? null;
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
    console.log("migrations applied (concurrency → core)");

    await seedScenario(pool, T0, SV0);
    await seedScenario(pool, T1, SV1);
    await seedScenario(pool, T2, SV2);
    await seedScenario(pool, TD, SVD);
    // T0=0정책. T1=단일 codex. T2=다정책(m1,m2, default 없음). TD=다정책(d1,d2; d2=default).
    await seedPolicy(pool, T1, "codex");
    await seedPolicy(pool, T2, "m1");
    await seedPolicy(pool, T2, "m2");
    await seedPolicy(pool, TD, "d1");
    await seedPolicy(pool, TD, "d2", true);
    console.log("seeded scenarios + gateway_policies per tenant");

    const enqueuer: RunEnqueuer = { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} };
    const app = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer,
      signedCommandRegistry,
    });
    await app.ready();
    try {
      const create = (tenant: string, token: string, sver: string, idemKey: string, extra: Record<string, unknown> = {}) =>
        app.inject({
          method: "POST",
          url: "/v1/runs",
          headers: { authorization: `Bearer ${token}`, "idempotency-key": idemKey },
          payload: { scenario_version_id: sver, params: {}, ...extra },
        });

      const tok0 = await mint(T0);
      const tok1 = await mint(T1);
      const tok2 = await mint(T2);
      const tokD = await mint(TD);

      // (a) 0정책 + 미지정 → 201, runs.model IS NULL(utility-only run 허용).
      const r0 = await create(T0, tok0, SV0, "m-0policy");
      const r0model = r0.statusCode === 201 ? await runModel(pool, T0, r0.json().run_id) : "n/a";
      check("0정책 + 미지정 → 201 + runs.model NULL", r0.statusCode === 201 && r0model === null, `${r0.statusCode} model=${String(r0model)}`);

      // (b) 단일정책 + 미지정 → 201, runs.model='codex'(자동해소). RLS: 타테넌트 정책 미관측이어야 단일로 해소됨.
      const r1 = await create(T1, tok1, SV1, "m-single");
      const r1model = r1.statusCode === 201 ? await runModel(pool, T1, r1.json().run_id) : "n/a";
      check("단일정책 + 미지정 → 201 + runs.model='codex' (자동해소·RLS 격리)", r1.statusCode === 201 && r1model === "codex", `${r1.statusCode} model=${String(r1model)}`);

      // (c) 명시 model 존재 → 201, 동결.
      const r1e = await create(T2, tok2, SV2, "m-explicit", { model: "m1" });
      const r1emodel = r1e.statusCode === 201 ? await runModel(pool, T2, r1e.json().run_id) : "n/a";
      check("명시 model 존재 → 201 + runs.model='m1' 동결", r1e.statusCode === 201 && r1emodel === "m1", `${r1e.statusCode} model=${String(r1emodel)}`);

      // (d) 명시 model 부재 → 404 RESOURCE_NOT_FOUND(model_policy_not_found).
      const r1g = await create(T1, tok1, SV1, "m-ghost", { model: "ghost" });
      check("명시 부재 model → 404 RESOURCE_NOT_FOUND", r1g.statusCode === 404 && r1g.json().code === "RESOURCE_NOT_FOUND", `${r1g.statusCode} ${r1g.body}`);

      // (e) 다정책 + 미지정 + default없음 → 422 IR_SCHEMA_INVALID(model_required) — 임의선택 금지(조용한 false 금지).
      const r2 = await create(T2, tok2, SV2, "m-ambiguous");
      check("다정책+미지정+default없음 → 422 model_required", r2.statusCode === 422 && r2.json().code === "IR_SCHEMA_INVALID", `${r2.statusCode} ${r2.body}`);

      // (f) is_default 존재 → 미지정 run이 default(d2)로 해소.
      const rd = await create(TD, tokD, SVD, "m-default");
      const rdmodel = rd.statusCode === 201 ? await runModel(pool, TD, rd.json().run_id) : "n/a";
      check("다정책+is_default → 201 + runs.model='d2'(기본 해소)", rd.statusCode === 201 && rdmodel === "d2", `${rd.statusCode} model=${String(rdmodel)}`);

      // (g) 멱등 replay: 동일 키 재제출 → 부작용 재실행 없이 최초 응답·runs.model 동결 불변.
      const r1replay = await create(T1, tok1, SV1, "m-single");
      const sameRun = r1.json().run_id === r1replay.json().run_id;
      const r1replayModel = await runModel(pool, T1, r1replay.json().run_id);
      check("replay 동일 키 → 동일 run_id + runs.model='codex' 동결(결정성)", r1replay.statusCode === 201 && sameRun && r1replayModel === "codex", `${r1replay.statusCode} same=${sameRun} model=${String(r1replayModel)}`);
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
  console.log("\nPASS: Gap2 POST /v1/runs model 해소·동결(runs.model) — 0정책/단일/명시/부재/다정책/기본/replay");
  process.exit(0);
}

main().catch((e) => {
  console.error("api-runs-model int fatal:", e);
  process.exit(1);
});
