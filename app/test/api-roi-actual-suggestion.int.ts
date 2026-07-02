/**
 * Integration test for ROI actual prefill suggestion (read-only run-stats aggregation).
 *
 * 불변: 제안값은 연결된 자동화(scenario_id)의 기간 내 **prod** 실행 통계(전 버전 관통, KST 일 경계)에서만
 * 도출되고, 어떤 행도 쓰지 않는다(roi_actual_evidence 미기록 — 확정은 사람이 POST 로 저장할 때만).
 *
 * Run with:
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-roi-actual-suggestion.int.ts
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
const SCHEMA = "rpa_roi_suggestion_int";
const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const SCENARIO_A = "51000000-0000-4000-8000-000000000001";
const SVER_A_V1 = "51000000-0000-4000-8000-000000000011";
const SVER_A_V2 = "51000000-0000-4000-8000-000000000012";
const IDEA_LINKED = "52000000-0000-4000-8000-000000000001";
const IDEA_UNLINKED = "52000000-0000-4000-8000-000000000002";
const RUN_C1 = "53000000-0000-4000-8000-000000000001"; // completed prod (v1, 06-02)
const RUN_C2 = "53000000-0000-4000-8000-000000000002"; // completed prod (v2, 06-05 — 전 버전 관통)
const RUN_F_BIZ = "53000000-0000-4000-8000-000000000003"; // failed_business prod (06-03)
const RUN_F_SYS = "53000000-0000-4000-8000-000000000004"; // failed_system prod (06-04)
const RUN_RUNNING = "53000000-0000-4000-8000-000000000005"; // running prod (06-06 — total 포함, settled 제외)
const RUN_TEST = "53000000-0000-4000-8000-000000000006"; // completed test (06-06 — 제외)
const RUN_KST_IN = "53000000-0000-4000-8000-000000000007"; // completed prod UTC 05-31T15:00Z = KST 06-01 00:00 (포함)
const RUN_KST_OUT = "53000000-0000-4000-8000-000000000008"; // completed prod UTC 05-31T14:59:59Z = KST 05-31 23:59:59 (제외)
const SECRET = new TextEncoder().encode("roi-actual-suggestion-secret-do-not-use-0123456789abcd");

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

function mint(roles: string[], tenant = TENANT_A, sub = "viewer-a"): Promise<string> {
  return new SignJWT({ sub, tenant_id: tenant, roles })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(SECRET);
}

type Pool = ReturnType<typeof createPool>;

async function seed(pool: Pool): Promise<void> {
  await withTenantTx(pool, TENANT_A, async (client) => {
    await client.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1::uuid, $2::uuid, '증빙 수집 자동화')`, [
      SCENARIO_A,
      TENANT_A,
    ]);
    // scenario 당 prod 1건(uq_scenario_versions_prod) — v1 은 승격 해제된 과거 버전(draft), 현행은 v2.
    // 과거 버전에 남은 run 이 집계에 포함되는 것(전 버전 관통)이 이 테스트의 핵심 단언이다.
    await client.query(
      `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
       VALUES ($1::uuid, $3::uuid, $4::uuid, 1, 'draft', '{"nodes":[]}'::jsonb),
              ($2::uuid, $3::uuid, $4::uuid, 2, 'prod', '{"nodes":[]}'::jsonb)`,
      [SVER_A_V1, SVER_A_V2, TENANT_A, SCENARIO_A],
    );
    await client.query(
      `INSERT INTO automation_ideas
         (id, tenant_id, title, description, business_owner, department, source, stage, scenario_id, created_by)
       VALUES
         ($1::uuid, $2::uuid, '증빙 수집', '증빙 수집 자동화', 'coe owner', 'coe', 'manual', 'operate', $3::uuid, 'operator-a'),
         ($4::uuid, $2::uuid, '미연결 아이디어', '자동화 미연결', 'coe owner', 'coe', 'manual', 'assess', NULL, 'operator-a')`,
      [IDEA_LINKED, TENANT_A, SCENARIO_A, IDEA_UNLINKED],
    );
    await client.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, run_mode, params, failure_reason, correlation_id, created_at, updated_at)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, 'completed', 'prod', '{}'::jsonb, NULL, $1::uuid, '2026-06-02T00:00:00Z', '2026-06-02T00:00:00Z'),
         ($4::uuid, $2::uuid, $5::uuid, 'completed', 'prod', '{}'::jsonb, NULL, $4::uuid, '2026-06-05T00:00:00Z', '2026-06-05T00:00:00Z'),
         ($6::uuid, $2::uuid, $3::uuid, 'failed_business', 'prod', '{}'::jsonb, '{"code":"BUSINESS_RULE","message":"blocked"}'::jsonb, $6::uuid, '2026-06-03T00:00:00Z', '2026-06-03T00:00:00Z'),
         ($7::uuid, $2::uuid, $3::uuid, 'failed_system', 'prod', '{}'::jsonb, '{"code":"SITE_DOWN","message":"offline"}'::jsonb, $7::uuid, '2026-06-04T00:00:00Z', '2026-06-04T00:00:00Z'),
         ($8::uuid, $2::uuid, $3::uuid, 'running', 'prod', '{}'::jsonb, NULL, $8::uuid, '2026-06-06T00:00:00Z', '2026-06-06T00:00:00Z'),
         ($9::uuid, $2::uuid, $3::uuid, 'completed', 'test', '{}'::jsonb, NULL, $9::uuid, '2026-06-06T00:00:00Z', '2026-06-06T00:00:00Z'),
         ($10::uuid, $2::uuid, $3::uuid, 'completed', 'prod', '{}'::jsonb, NULL, $10::uuid, '2026-05-31T15:00:00Z', '2026-05-31T15:00:00Z'),
         ($11::uuid, $2::uuid, $3::uuid, 'completed', 'prod', '{}'::jsonb, NULL, $11::uuid, '2026-05-31T14:59:59Z', '2026-05-31T14:59:59Z')`,
      [RUN_C1, TENANT_A, SVER_A_V1, RUN_C2, SVER_A_V2, RUN_F_BIZ, RUN_F_SYS, RUN_RUNNING, RUN_TEST, RUN_KST_IN, RUN_KST_OUT],
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
      await setup.query(`CREATE SCHEMA ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(`CREATE TABLE tenants (id uuid PRIMARY KEY)`);
      await setup.query(`INSERT INTO tenants (id) VALUES ($1::uuid), ($2::uuid)`, [TENANT_A, TENANT_B]);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
    } finally {
      setup.release();
    }
    await seed(pool);

    const viewer = await mint(["viewer"]);
    const noRole = await mint([]);
    const tenantB = await mint(["admin"], TENANT_B, "admin-b");

    const getSuggestion = (token: string, ideaId: string, query: string) =>
      app.inject({
        method: "GET",
        url: `/v1/automation-ideas/${ideaId}/roi-actuals/suggestion?${query}`,
        headers: { authorization: `Bearer ${token}` },
      });

    // 1) 연결 아이디어 6월 제안 — prod 전용·전 버전 관통·KST 경계 포함/제외.
    const june = await getSuggestion(viewer, IDEA_LINKED, "period_start=2026-06-01&period_end=2026-06-30");
    const body = june.json();
    check("viewer 200 + scenario 연결 투영", june.statusCode === 200 && body.scenario_id === SCENARIO_A, june.body);
    check("total_runs=6 (prod만; KST-in 포함, KST-out/test 제외)", body.total_runs === 6, JSON.stringify(body));
    check("completed_runs=3 / failed_runs=2 (running 은 settled 제외)", body.completed_runs === 3 && body.failed_runs === 2, JSON.stringify(body));
    check("제안 처리 건수 = 완료 3", body.suggested_actual_transaction_count === 3, JSON.stringify(body));
    check("제안 실패율 = 2/5 = 0.4", body.suggested_actual_failure_rate === 0.4, JSON.stringify(body));
    check("run_mode 고정 prod", body.run_mode === "prod", JSON.stringify(body));

    // 2) 전 버전 관통 — v2 실행일(06-05)만 조회해도 잡힌다.
    const v2Only = await getSuggestion(viewer, IDEA_LINKED, "period_start=2026-06-05&period_end=2026-06-05");
    const v2Body = v2Only.json();
    check("scenario 전 버전 관통 (v2 run 포함)", v2Only.statusCode === 200 && v2Body.total_runs === 1 && v2Body.completed_runs === 1, v2Only.body);

    // 3) KST 경계 — 5월 조회에는 KST-out(05-31 23:59:59 KST)만 포함된다.
    const may = await getSuggestion(viewer, IDEA_LINKED, "period_start=2026-05-01&period_end=2026-05-31");
    const mayBody = may.json();
    check("KST 일 경계 (5월엔 boundary-out 1건만)", may.statusCode === 200 && mayBody.total_runs === 1 && mayBody.completed_runs === 1, may.body);

    // 4) 종결 0건 기간 — 0 으로 날조하지 않고 제안 null.
    const noneSettled = await getSuggestion(viewer, IDEA_LINKED, "period_start=2026-06-06&period_end=2026-06-06");
    const noneBody = noneSettled.json();
    check(
      "종결 0건 → 제안 null (running 만 total 반영)",
      noneSettled.statusCode === 200 && noneBody.total_runs === 1 && noneBody.suggested_actual_transaction_count === null && noneBody.suggested_actual_failure_rate === null,
      noneSettled.body,
    );

    // 5) 미연결 아이디어 — 집계 불가를 null 로 정직 표기.
    const unlinked = await getSuggestion(viewer, IDEA_UNLINKED, "period_start=2026-06-01&period_end=2026-06-30");
    const unlinkedBody = unlinked.json();
    check(
      "미연결 → scenario_id/집계/제안 전부 null",
      unlinked.statusCode === 200 && unlinkedBody.scenario_id === null && unlinkedBody.total_runs === null && unlinkedBody.suggested_actual_transaction_count === null,
      unlinked.body,
    );

    // 6) read-only 불변 — 제안 조회는 확정 증거를 만들지 않는다(성과 리포트 승격 없음).
    const evidenceCount = await withTenantTx(pool, TENANT_A, async (client) => {
      const r = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM roi_actual_evidence`);
      return Number(r.rows[0]?.n ?? "-1");
    });
    check("제안 조회 후 roi_actual_evidence 0건 (미기록)", evidenceCount === 0, String(evidenceCount));

    // 7) 경계/검증 — 기간 역전·미래·누락 422, 테넌트 격리 404, 무역할 403.
    const reversed = await getSuggestion(viewer, IDEA_LINKED, "period_start=2026-06-30&period_end=2026-06-01");
    check("기간 역전 → 422", reversed.statusCode === 422, reversed.body);
    const future = await getSuggestion(viewer, IDEA_LINKED, "period_start=2099-01-01&period_end=2099-01-31");
    check("미래 기간 → 422", future.statusCode === 422, future.body);
    const missing = await getSuggestion(viewer, IDEA_LINKED, "period_start=2026-06-01");
    check("period_end 누락 → 422", missing.statusCode === 422, missing.body);
    const crossTenant = await getSuggestion(tenantB, IDEA_LINKED, "period_start=2026-06-01&period_end=2026-06-30");
    check("타 테넌트 → 404 (존재 비노출)", crossTenant.statusCode === 404, crossTenant.body);
    const forbidden = await getSuggestion(noRole, IDEA_LINKED, "period_start=2026-06-01&period_end=2026-06-30");
    check("무역할 → 403", forbidden.statusCode === 403, forbidden.body);

    if (failures > 0) {
      console.error(`FAIL: ${failures} check(s) failed`);
      process.exitCode = 1;
      return;
    }
    console.log("PASS: ROI actual suggestion integration green");
  } finally {
    await app.close();
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
